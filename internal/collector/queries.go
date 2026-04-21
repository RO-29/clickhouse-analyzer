package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
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
	c.collectTimeouts(ctx, client, result)
	c.collectZombieQueries(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

// collectRunningQueries examines system.processes for active queries, flags
// long runners (WARN >30s, CRIT >60s), and detects query storms.
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
		  AND is_initial_query = 1
		ORDER BY elapsed DESC`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.processes", slog.String("error", err.Error()))
		// Emit the count via a simpler fallback so the metric always appears.
		if cnt, ferr := client.QuerySingleValue(ctx, "SELECT count() FROM system.processes WHERE is_initial_query = 1"); ferr == nil {
			if n, perr := strconv.ParseFloat(strings.TrimSpace(cnt), 64); perr == nil {
				result.AddMetric(client.Name(), "queries.running_count", n, nil)
			}
		}
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

	// Two-tier thresholds: warn at 30s, critical at 60s
	critThreshold := c.Thresholds.LongRunningThreshold.Duration.Seconds()
	warnThreshold := c.Thresholds.LongRunningWarnThreshold.Duration.Seconds()
	if warnThreshold <= 0 {
		warnThreshold = 30
	}
	if critThreshold <= warnThreshold {
		critThreshold = warnThreshold * 2
	}

	userCounts := make(map[string]int)
	var critRunners []string
	var warnRunners []string
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

		line := fmt.Sprintf("  - `%s` user=%s elapsed=%.0fs mem=%s: %s",
			queryID, user, elapsed, humanBytes(memUsage), query)

		if elapsed >= critThreshold {
			critRunners = append(critRunners, line)
		} else if elapsed >= warnThreshold {
			warnRunners = append(warnRunners, line)
		}

		if readRows > 1_000_000_000 {
			fullScans = append(fullScans, fmt.Sprintf("  - `%s` reading %.0fM rows (%.1f GB), user=%s",
				queryID, readRows/1e6, readBytes/(1024*1024*1024), user))
		}

		userCounts[user]++
	}

	// Critical long-running queries (>60s by default)
	if len(critRunners) > 0 {
		msg := fmt.Sprintf("*%d queries* running longer than %.0fs:\n%s\n\n%s",
			len(critRunners), critThreshold,
			strings.Join(critRunners, "\n"),
			processesPlaybook(true))
		result.AddAlert(client.Name(), SeverityCritical, "queries",
			fmt.Sprintf("Long-running queries (critical): %d", len(critRunners)),
			msg,
			fmt.Sprintf("%s:queries:long_running_crit", client.Name()))
	}

	// Warning long-running queries (>30s but <60s)
	if len(warnRunners) > 0 {
		msg := fmt.Sprintf("*%d queries* running longer than %.0fs:\n%s\n\n%s",
			len(warnRunners), warnThreshold,
			strings.Join(warnRunners, "\n"),
			processesPlaybook(false))
		result.AddAlert(client.Name(), SeverityWarn, "queries",
			fmt.Sprintf("Long-running queries (warn): %d", len(warnRunners)),
			msg,
			fmt.Sprintf("%s:queries:long_running_warn", client.Name()))
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
	sql := fmt.Sprintf(`
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
		  AND %s
		  AND exception_code NOT IN (159, 160, 394)  -- exclude timeouts (handled separately)
		ORDER BY event_time DESC
		LIMIT 50`,
		EventTimeCond(ctx, "event_time", "now() - INTERVAL 5 MINUTE"))

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
		msg := fmt.Sprintf("*%d failed queries* in last 5 minutes:\n%s\n\n%s",
			len(rows), strings.Join(exLines, "\n"),
			queryExceptionPlaybook("", "INTERVAL 5 MINUTE"))
		result.AddAlert(client.Name(), severity, "queries",
			fmt.Sprintf("Query failures: %d in 5m", len(rows)),
			msg,
			fmt.Sprintf("%s:queries:failures_5m", client.Name()))
	}
}

// collectTimeouts detects TIMEOUT_EXCEEDED (159), TOO_SLOW (160), and
// QUERY_WAS_CANCELLED (394) exceptions from system.query_log in the last 5m.
func (c *QueryCollector) collectTimeouts(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := fmt.Sprintf(`
		SELECT
			exception_code,
			count() AS cnt,
			any(query) AS sample_query,
			any(user) AS user,
			any(exception) AS sample_exception
		FROM system.query_log
		WHERE type = 'ExceptionWhileProcessing'
		  AND %s
		  AND exception_code IN (159, 160, 394)
		GROUP BY exception_code
		ORDER BY cnt DESC`,
		EventTimeCond(ctx, "event_time", "now() - INTERVAL 5 MINUTE"))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query timeouts from query_log", slog.String("error", err.Error()))
		return
	}

	if len(rows) == 0 {
		return
	}

	codeNames := map[int64]string{
		159: "TIMEOUT_EXCEEDED",
		160: "TOO_SLOW",
		394: "QUERY_WAS_CANCELLED",
	}

	var lines []string
	totalCount := 0
	hasCrit := false

	for _, row := range rows {
		code := int64(getFloat(row, "exception_code"))
		cnt := int(getFloat(row, "cnt"))
		user := getString(row, "user")
		sample := getString(row, "sample_query")
		name := codeNames[code]
		if name == "" {
			name = fmt.Sprintf("code_%d", code)
		}
		lines = append(lines, fmt.Sprintf("  - %s (%d): %dx user=%s sample: %s", name, code, cnt, user, sample))
		totalCount += cnt
		if cnt > 5 {
			hasCrit = true
		}

		result.AddMetric(client.Name(), "queries.timeouts_5m", float64(cnt), map[string]string{
			"exception_code": fmt.Sprintf("%d", code),
			"name":           name,
		})
	}

	sev := SeverityWarn
	if hasCrit {
		sev = SeverityCritical
	}

	msg := fmt.Sprintf("*%d query timeouts/cancellations* in last 5 minutes:\n%s\n\n%s",
		totalCount, strings.Join(lines, "\n"),
		queryExceptionPlaybook(" AND exception_code IN (159,160,394)", "INTERVAL 1 HOUR"))

	result.AddAlert(client.Name(), sev, "queries",
		fmt.Sprintf("Query timeouts: %d in 5m", totalCount),
		msg,
		fmt.Sprintf("%s:queries:timeouts_5m", client.Name()))
}

// collectZombieQueries detects long-running HTTP-interface queries where the
// client has likely disconnected but the server is still executing the query.
// These appear in system.processes with http_user_agent set and high elapsed time.
func (c *QueryCollector) collectZombieQueries(ctx context.Context, client *chclient.Client, result *CollectResult) {
	// HTTP queries running > 10 minutes are likely orphaned: client disconnected
	// but server keeps the query alive. ClickHouse doesn't auto-cancel these unless
	// cancel_http_readonly_queries_on_client_close is enabled.
	sql := `
		SELECT
			query_id,
			user,
			http_user_agent,
			elapsed,
			query,
			memory_usage,
			read_rows
		FROM system.processes
		WHERE http_user_agent != ''
		  AND elapsed > 600
		  AND is_cancelled = 0
		ORDER BY elapsed DESC
		LIMIT 20`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query zombie queries", slog.String("error", err.Error()))
		return
	}

	if len(rows) == 0 {
		return
	}

	var lines []string
	for _, row := range rows {
		queryID := getString(row, "query_id")
		user := getString(row, "user")
		agent := getString(row, "http_user_agent")
		elapsed := getFloat(row, "elapsed")
		mem := getFloat(row, "memory_usage")
		query := getString(row, "query")
		if len(agent) > 40 {
			agent = agent[:40]
		}
		lines = append(lines, fmt.Sprintf("  - `%s` user=%s elapsed=%.0fs mem=%s agent=%s: %s",
			queryID, user, elapsed, humanBytes(mem), agent, query))
	}

	result.AddMetric(client.Name(), "queries.zombie_count", float64(len(rows)), nil)

	msg := fmt.Sprintf("*%d possible zombie queries* (HTTP client disconnected, server still running >10m):\n%s\n\n"+
		"*To fix:* Enable `cancel_http_readonly_queries_on_client_close = 1` in server config\n"+
		"*Kill manually:*\n```\nKILL QUERY WHERE query_id IN ('%s')\n```\n\n"+
		"*To prevent:* Set `max_execution_time` in user profiles or query settings",
		len(rows), strings.Join(lines, "\n"),
		strings.Join(extractQueryIDs(rows), "','"))

	sev := SeverityWarn
	if len(rows) >= 3 {
		sev = SeverityCritical
	}

	result.AddAlert(client.Name(), sev, "queries",
		fmt.Sprintf("Zombie queries: %d orphaned HTTP queries", len(rows)),
		msg,
		fmt.Sprintf("%s:queries:zombie", client.Name()))
}

// extractQueryIDs pulls the query_id strings from a rows slice.
func extractQueryIDs(rows []map[string]interface{}) []string {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		if id := getString(row, "query_id"); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

// collectRepeatedPatterns detects repeated identical query patterns via
// normalised_query_hash from system.query_log.
func (c *QueryCollector) collectRepeatedPatterns(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := fmt.Sprintf(`
		SELECT
			normalized_query_hash,
			any(query) AS sample_query,
			count() AS cnt,
			sum(read_rows) AS total_read_rows,
			avg(query_duration_ms) AS avg_duration_ms,
			any(user) AS user
		FROM system.query_log
		WHERE type = 'QueryFinish'
		  AND %s
		GROUP BY normalized_query_hash
		HAVING cnt > 50
		ORDER BY cnt DESC
		LIMIT 20`,
		EventTimeCond(ctx, "event_time", "now() - INTERVAL 5 MINUTE"))

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
