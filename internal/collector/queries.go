package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
)

// QueryCollector monitors currently running queries and recent failures from
// system.processes and system.query_log.
type QueryCollector struct {
	Thresholds config.QueriesThresholds
	Logger     *slog.Logger
}

func (c *QueryCollector) Name() string { return "queries" }

func (c *QueryCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	c.collectRunningQueries(ctx, client, result)
	c.collectFailedQueries(ctx, client, result)
	c.collectRepeatedPatterns(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

// collectRunningQueries examines system.processes for active queries, flags
// long runners, and detects query storms.
func (c *QueryCollector) collectRunningQueries(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			query_id,
			user AS initial_user,
			client_name,
			http_user_agent,
			elapsed,
			query,
			memory_usage,
			read_rows,
			read_bytes
		FROM system.processes
		WHERE is_cancelled = 0
		ORDER BY elapsed DESC`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.processes", slog.String("error", err.Error()))
		return
	}

	result.AddMetric(client.Name(), "queries.running_count", float64(len(rows)), nil)

	// --- Concurrent query alerts ---
	if len(rows) >= c.Thresholds.MaxConcurrent {
		result.AddAlert(client.Name(), SeverityCritical, "queries",
			"Maximum concurrent queries reached",
			fmt.Sprintf("%d queries running (limit: %d)", len(rows), c.Thresholds.MaxConcurrent),
			fmt.Sprintf("%s:queries:max_concurrent", client.Name()))
	} else if len(rows) >= c.Thresholds.WarnConcurrent {
		result.AddAlert(client.Name(), SeverityWarn, "queries",
			"High concurrent query count",
			fmt.Sprintf("%d queries running (warn threshold: %d)", len(rows), c.Thresholds.WarnConcurrent),
			fmt.Sprintf("%s:queries:warn_concurrent", client.Name()))
	}

	// --- Collect per-query metrics and group alerts ---
	threshold := c.Thresholds.LongRunningThreshold.Duration.Seconds()
	userCounts := make(map[string]int)
	var longRunners []string
	var fullScans []string

	for _, row := range rows {
		elapsed := getFloat(row, "elapsed")
		queryID := getString(row, "query_id")
		user := getString(row, "initial_user")
		query := getString(row, "query")
		memUsage := getFloat(row, "memory_usage")
		readRows := getFloat(row, "read_rows")
		readBytes := getFloat(row, "read_bytes")

		labels := map[string]string{
			"query_id": queryID,
			"user":     user,
		}
		result.AddMetric(client.Name(), "queries.running.elapsed", elapsed, labels)
		result.AddMetric(client.Name(), "queries.running.memory_usage", memUsage, labels)
		result.AddMetric(client.Name(), "queries.running.read_rows", readRows, labels)
		result.AddMetric(client.Name(), "queries.running.read_bytes", readBytes, labels)

		if elapsed >= threshold {
			truncQuery := query
			if len(truncQuery) > 120 {
				truncQuery = truncQuery[:120] + "..."
			}
			longRunners = append(longRunners, fmt.Sprintf("  - `%s` user=%s elapsed=%.0fs mem=%s: %s",
				queryID, user, elapsed, humanBytes(memUsage), truncQuery))
		}

		if readRows > 1_000_000_000 {
			fullScans = append(fullScans, fmt.Sprintf("  - `%s` reading %.0fM rows (%.1f GB), user=%s",
				queryID, readRows/1e6, readBytes/(1024*1024*1024), user))
		}

		userCounts[user]++
	}

	// Single grouped alert for long-running queries.
	if len(longRunners) > 0 {
		sev := SeverityWarn
		if len(longRunners) > 5 {
			sev = SeverityCritical
		}
		msg := fmt.Sprintf("*%d queries* running longer than %.0fs:\n%s\n\n"+
			"*Investigate:*\n```\nSELECT query_id, user, elapsed, formatReadableSize(memory_usage) as mem,\n"+
			"  read_rows, substring(query,1,100) as q\n"+
			"FROM system.processes ORDER BY elapsed DESC\n```\n"+
			"*Kill a query:*\n```\nKILL QUERY WHERE query_id = '<id>'\n```",
			len(longRunners), threshold,
			strings.Join(longRunners, "\n"))
		result.AddAlert(client.Name(), sev, "queries",
			fmt.Sprintf("Long-running queries: %d", len(longRunners)),
			msg,
			fmt.Sprintf("%s:queries:long_running", client.Name()))
	}

	// Single grouped alert for full table scans.
	if len(fullScans) > 0 {
		msg := fmt.Sprintf("*%d queries* doing full table scans (>1B rows):\n%s",
			len(fullScans), strings.Join(fullScans, "\n"))
		result.AddAlert(client.Name(), SeverityWarn, "queries",
			fmt.Sprintf("Full table scans: %d queries", len(fullScans)),
			msg,
			fmt.Sprintf("%s:queries:full_scans", client.Name()))
	}

	// Single grouped alert for query storms.
	stormThreshold := c.Thresholds.WarnConcurrent / 2
	if stormThreshold < 5 {
		stormThreshold = 5
	}
	var storms []string
	for user, count := range userCounts {
		if count >= stormThreshold {
			storms = append(storms, fmt.Sprintf("  - user `%s`: %d queries", user, count))
		}
	}
	if len(storms) > 0 {
		msg := fmt.Sprintf("*Query storm detected* (threshold: %d per user):\n%s\n\n"+
			"*Investigate:*\n```\nSELECT user, count() as cnt FROM system.processes\n"+
			"GROUP BY user ORDER BY cnt DESC\n```",
			stormThreshold, strings.Join(storms, "\n"))
		result.AddAlert(client.Name(), SeverityWarn, "queries",
			"Query storm detected",
			msg,
			fmt.Sprintf("%s:queries:storm", client.Name()))
	}
}

// collectFailedQueries checks system.query_log for recent exceptions.
func (c *QueryCollector) collectFailedQueries(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			query_id,
			user,
			client_name,
			http_user_agent,
			exception_code,
			exception,
			query,
			event_time
		FROM system.query_log
		WHERE type = 'ExceptionWhileProcessing'
		  AND event_time >= now() - INTERVAL 5 MINUTE
		ORDER BY event_time DESC
		LIMIT 50`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query query_log for failures", slog.String("error", err.Error()))
		return
	}

	result.AddMetric(client.Name(), "queries.failed_5m", float64(len(rows)), nil)

	if len(rows) > 0 {
		severity := SeverityWarn
		if len(rows) > 20 {
			severity = SeverityCritical
		}
		exCounts := make(map[string]int)
		for _, row := range rows {
			code := getString(row, "exception_code")
			exCounts[code]++
		}
		var exLines []string
		for code, cnt := range exCounts {
			exLines = append(exLines, fmt.Sprintf("  - Error code %s: %d failures", code, cnt))
		}
		msg := fmt.Sprintf("*%d failed queries* in last 5 minutes:\n%s\n\n"+
			"*Investigate:*\n```\nSELECT exception_code, count() as cnt, any(exception) as sample\n"+
			"FROM system.query_log\n"+
			"WHERE type='ExceptionWhileProcessing' AND event_time >= now() - INTERVAL 5 MINUTE\n"+
			"GROUP BY exception_code ORDER BY cnt DESC\n```",
			len(rows), strings.Join(exLines, "\n"))
		result.AddAlert(client.Name(), severity, "queries",
			fmt.Sprintf("Query failures: %d in 5m", len(rows)),
			msg,
			fmt.Sprintf("%s:queries:failures_5m", client.Name()))
	}
}

// collectRepeatedPatterns detects repeated identical query patterns via
// normalised_query_hash from system.query_log.
func (c *QueryCollector) collectRepeatedPatterns(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			normalized_query_hash,
			any(query) AS sample_query,
			count() AS cnt,
			sum(read_rows) AS total_read_rows,
			avg(query_duration_ms) AS avg_duration_ms,
			any(user) AS user
		FROM system.query_log
		WHERE type = 'QueryFinish'
		  AND event_time >= now() - INTERVAL 5 MINUTE
		GROUP BY normalized_query_hash
		HAVING cnt > 50
		ORDER BY cnt DESC
		LIMIT 20`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query repeated patterns", slog.String("error", err.Error()))
		return
	}

	if len(rows) > 0 {
		var lines []string
		for _, row := range rows {
			cnt := getFloat(row, "cnt")
			hash := getString(row, "normalized_query_hash")
			sample := getString(row, "sample_query")
			avgDur := getFloat(row, "avg_duration_ms")
			user := getString(row, "user")

			if len(sample) > 100 {
				sample = sample[:100] + "..."
			}

			result.AddMetric(client.Name(), "queries.repeated_pattern.count", cnt, map[string]string{
				"hash": hash,
				"user": user,
			})

			lines = append(lines, fmt.Sprintf("  - %.0fx avg=%.0fms user=%s: `%s`", cnt, avgDur, user, sample))
		}

		msg := fmt.Sprintf("*%d repeated query patterns* (>50x in 5m):\n%s\n\n"+
			"*Consider:* caching results, materialized views, or query dedup",
			len(rows), strings.Join(lines, "\n"))
		result.AddAlert(client.Name(), SeverityInfo, "queries",
			fmt.Sprintf("Repeated query patterns: %d", len(rows)),
			msg,
			fmt.Sprintf("%s:queries:repeated_patterns", client.Name()))
	}
}

func (c *QueryCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}
