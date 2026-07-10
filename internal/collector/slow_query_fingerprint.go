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

		// Severity tracks aggregate LOAD (frequency × per-exec cost), not raw
		// frequency. The old thresholds fired *critical* at 200 exec/5min — that's
		// 0.67 QPS of one pattern, i.e. ordinary application traffic. A pattern is
		// only worth paging on if it is both frequent AND non-trivially slow, so
		// the aggregate query-time it burns is real. Purely-frequent, fast patterns
		// are advisory (surfaced by the repeated-patterns info alert), not here.
		switch {
		case execCount >= 100 && avgMs >= 5000:
			result.AddAlert(client.Name(), SeverityCritical, "queries",
				fmt.Sprintf("Heavy repeated query: %.0f×/5min at avg %.1fs", execCount, avgMs/1000),
				fmt.Sprintf("One query pattern ran *%.0f times* in 5 minutes at avg %.0fms (max %.0fms, user: %s) — "+
					"roughly %.0f query-seconds of load from a single pattern.\n\n"+
					"*Sample query:*\n```\n%s\n```\n\n%s",
					execCount, avgMs, maxMs, user, execCount*avgMs/1000, displayQuery, slowQueryByHashPlaybook(hash)),
				dedupKey)
		case execCount >= 50 && avgMs >= 1000:
			result.AddAlert(client.Name(), SeverityWarn, "queries",
				fmt.Sprintf("Frequent slow query: %.0f×/5min at avg %.1fs", execCount, avgMs/1000),
				fmt.Sprintf("Query pattern ran %.0f times in 5 min at avg %.0fms (max %.0fms, user: %s). "+
					"Consider caching or a materialized view.\n\n"+
					"*Sample query:*\n```\n%s\n```\n\n%s",
					execCount, avgMs, maxMs, user, displayQuery, slowQueryByHashPlaybook(hash)),
				dedupKey)
		}
	}

	result.Duration = time.Since(start)
	return result, nil
}
