package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// SlowQueryFingerprintCollector detects query storms — the same query pattern
// executing at unusually high frequency. Complements QueryLatencyCollector (which
// tracks overall P95) by surfacing individual pattern regressions.
type SlowQueryFingerprintCollector struct {
	Logger *slog.Logger
}

func (c *SlowQueryFingerprintCollector) Name() string { return "slow_query_fingerprint" }

func (c *SlowQueryFingerprintCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *SlowQueryFingerprintCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	// normalized_query_hash groups syntactically equivalent queries (different params, same structure).
	// Available in CH 21.1+. Falls back gracefully if column missing.
	sql := fmt.Sprintf(`
		SELECT
			normalized_query_hash,
			any(query) AS sample_query,
			count() AS exec_count,
			avg(query_duration_ms) AS avg_ms,
			max(query_duration_ms) AS max_ms,
			sum(read_rows) AS total_read_rows,
			any(user) AS user
		FROM system.query_log
		WHERE type = 'QueryFinish'
		  AND %s
		  AND query_kind NOT IN ('Insert', 'Set', 'Create', 'Drop', 'Alter', 'Show', 'System')
		GROUP BY normalized_query_hash
		HAVING exec_count > 20
		    OR (exec_count > 5 AND avg_ms > 10000)
		ORDER BY exec_count DESC
		LIMIT 10`,
		EventTimeCond(ctx, "event_time", "now() - INTERVAL 5 MINUTE"))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") ||
			strings.Contains(err.Error(), "UNKNOWN_COLUMN") ||
			strings.Contains(err.Error(), "normalized_query_hash") {
			// Older CH version without normalized_query_hash — skip silently.
			result.Duration = time.Since(start)
			return result, nil
		}
		c.logger().Warn("slow_query_fingerprint: failed to query query_log", slog.String("error", err.Error()))
		result.Duration = time.Since(start)
		return result, nil
	}

	for _, row := range rows {
		hash := getString(row, "normalized_query_hash")
		sample := getString(row, "sample_query")
		execCount := getFloat(row, "exec_count")
		avgMs := getFloat(row, "avg_ms")
		maxMs := getFloat(row, "max_ms")
		user := getString(row, "user")

		displayQuery := sample

		dedupKey := fmt.Sprintf("%s:slow_query_fingerprint:storm:%s", client.Name(), hash)

		result.AddMetric(client.Name(), "queries.pattern_exec_count_5m", execCount,
			map[string]string{"hash": hash, "user": user})

		if execCount > 200 || (execCount > 50 && avgMs > 5000) {
			result.AddAlert(client.Name(), SeverityCritical, "queries",
				fmt.Sprintf("Query storm: %.0f executions/5min, avg %.0fms", execCount, avgMs),
				fmt.Sprintf("Single query pattern executed *%.0f times* in 5 minutes (avg %.0fms, max %.0fms, user: %s).\n\n"+
					"*Sample query:*\n```\n%s\n```\n\n%s",
					execCount, avgMs, maxMs, user, displayQuery, slowQueryByHashPlaybook(hash)),
				dedupKey)
		} else if execCount > 50 || (execCount > 10 && avgMs > 30000) {
			result.AddAlert(client.Name(), SeverityWarn, "queries",
				fmt.Sprintf("High-frequency pattern: %.0f exec/5min, avg %.0fms", execCount, avgMs),
				fmt.Sprintf("Query pattern executed %.0f times in 5 min (avg %.0fms, max %.0fms, user: %s).\n\n"+
					"*Sample query:*\n```\n%s\n```\n\n%s",
					execCount, avgMs, maxMs, user, displayQuery, slowQueryByHashPlaybook(hash)),
				dedupKey)
		}
	}

	result.Duration = time.Since(start)
	return result, nil
}
