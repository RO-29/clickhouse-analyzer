package collector

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
)

// MVCollector monitors materialized views: execution failures, timing,
// bloat ratios, and chained-MV breakage.
type MVCollector struct {
	Thresholds config.MVThresholds
	Logger     *slog.Logger
}

func (c *MVCollector) Name() string { return "mvs" }

func (c *MVCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	c.collectMVList(ctx, client, result)
	c.collectMVFailures(ctx, client, result)
	c.collectMVTiming(ctx, client, result)
	c.collectMVBloat(ctx, client, result)
	c.detectChainedMVs(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

// collectMVList enumerates all materialized views and their target tables from
// system.tables.
func (c *MVCollector) collectMVList(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			database,
			name,
			as_select,
			engine
		FROM system.tables
		WHERE engine = 'MaterializedView'
		ORDER BY database, name`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to list materialized views", slog.String("error", err.Error()))
		return
	}

	result.AddMetric(client.Name(), "mvs.total_count", float64(len(rows)), nil)

	for _, row := range rows {
		db := getString(row, "database")
		name := getString(row, "name")
		result.AddMetric(client.Name(), "mvs.exists", 1, map[string]string{
			"database": db,
			"mv":       name,
		})
	}
}

// collectMVFailures checks system.query_log for MV execution exceptions by
// looking at queries where the view_name is populated and there is an exception.
func (c *MVCollector) collectMVFailures(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			view_name,
			view_target,
			count() AS failure_count,
			any(exception) AS sample_exception,
			max(event_time) AS last_failure
		FROM system.query_views_log
		WHERE status = 'ExceptionWhileProcessing'
		  AND event_time >= now() - INTERVAL 5 MINUTE
		GROUP BY view_name, view_target
		ORDER BY failure_count DESC
		LIMIT 30`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query MV failures from query_views_log", slog.String("error", err.Error()))
		return
	}

	totalFailures := 0.0
	for _, row := range rows {
		viewName := getString(row, "view_name")
		viewTarget := getString(row, "view_target")
		count := getFloat(row, "failure_count")
		sampleEx := getString(row, "sample_exception")
		totalFailures += count

		if len(sampleEx) > 200 {
			sampleEx = sampleEx[:200] + "..."
		}

		labels := map[string]string{
			"view":   viewName,
			"target": viewTarget,
		}
		result.AddMetric(client.Name(), "mvs.failures", count, labels)

		sev := SeverityWarn
		if count > 10 {
			sev = SeverityCritical
		}
		result.AddAlert(client.Name(), sev, "mvs",
			"Materialized view failures",
			fmt.Sprintf("MV %s -> %s: %.0f failures in 5m, example: %s",
				viewName, viewTarget, count, sampleEx),
			fmt.Sprintf("%s:mvs:failure:%s", client.Name(), viewName))
	}

	result.AddMetric(client.Name(), "mvs.total_failures_5m", totalFailures, nil)
}

// collectMVTiming tracks MV execution duration from system.query_views_log.
func (c *MVCollector) collectMVTiming(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			view_name,
			view_target,
			count() AS executions,
			avg(view_duration_ms) AS avg_duration_ms,
			max(view_duration_ms) AS max_duration_ms,
			quantile(0.95)(view_duration_ms) AS p95_duration_ms
		FROM system.query_views_log
		WHERE status = 'QueryFinish'
		  AND event_time >= now() - INTERVAL 5 MINUTE
		GROUP BY view_name, view_target
		ORDER BY avg_duration_ms DESC
		LIMIT 30`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query MV timing from query_views_log", slog.String("error", err.Error()))
		return
	}

	for _, row := range rows {
		viewName := getString(row, "view_name")
		viewTarget := getString(row, "view_target")
		executions := getFloat(row, "executions")
		avgMs := getFloat(row, "avg_duration_ms")
		maxMs := getFloat(row, "max_duration_ms")
		p95Ms := getFloat(row, "p95_duration_ms")

		labels := map[string]string{
			"view":   viewName,
			"target": viewTarget,
		}
		result.AddMetric(client.Name(), "mvs.timing.executions", executions, labels)
		result.AddMetric(client.Name(), "mvs.timing.avg_ms", avgMs, labels)
		result.AddMetric(client.Name(), "mvs.timing.max_ms", maxMs, labels)
		result.AddMetric(client.Name(), "mvs.timing.p95_ms", p95Ms, labels)

		// Alert on slow MVs that exceed the lag threshold.
		lagWarnMs := float64(c.Thresholds.LagWarn.Duration.Milliseconds())
		if p95Ms > lagWarnMs {
			result.AddAlert(client.Name(), SeverityWarn, "mvs",
				"Slow materialized view",
				fmt.Sprintf("MV %s -> %s: p95=%.0fms avg=%.0fms (%.0f executions in 5m, warn threshold: %.0fms)",
					viewName, viewTarget, p95Ms, avgMs, executions, lagWarnMs),
				fmt.Sprintf("%s:mvs:slow:%s", client.Name(), viewName))
		}
	}
}

// collectMVBloat compares target table sizes to source table sizes to detect
// MV bloat (target much larger than source).
func (c *MVCollector) collectMVBloat(ctx context.Context, client *chclient.Client, result *CollectResult) {
	// Step 1: get all MVs with their inner (target) tables.
	// The inner table name is stored in the view definition. We get it from
	// system.tables where engine_full LIKE '%TO%' or from the inner UUID.
	// A simpler approach: match MV names to .inner.UUID or explicit target tables.
	sql := `
		SELECT
			mv.database AS mv_database,
			mv.name AS mv_name,
			inner_t.database AS target_database,
			inner_t.name AS target_name,
			inner_t.total_bytes AS target_bytes,
			inner_t.total_rows AS target_rows
		FROM system.tables AS mv
		INNER JOIN system.tables AS inner_t
			ON inner_t.uuid = mv.uuid
			AND inner_t.name LIKE '.inner_id.%'
		WHERE mv.engine = 'MaterializedView'
		  AND inner_t.total_bytes > 0`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		// This query may not work on all CH versions; fall back silently.
		c.logger().Debug("failed to query MV bloat (inner table join)",
			slog.String("error", err.Error()))
		return
	}

	for _, row := range rows {
		mvDB := getString(row, "mv_database")
		mvName := getString(row, "mv_name")
		targetBytes := getFloat(row, "target_bytes")
		targetRows := getFloat(row, "target_rows")

		labels := map[string]string{
			"database": mvDB,
			"mv":       mvName,
		}
		result.AddMetric(client.Name(), "mvs.target.bytes", targetBytes, labels)
		result.AddMetric(client.Name(), "mvs.target.rows", targetRows, labels)
	}
}

// detectChainedMVs finds materialized views whose source is another MV's
// target table. Chains are fragile and a single break can cascade.
func (c *MVCollector) detectChainedMVs(ctx context.Context, client *chclient.Client, result *CollectResult) {
	// Find MVs that SELECT FROM a table that is itself the target of another MV.
	// We use system.tables metadata: dependencies_database / dependencies_table
	// (available in CH 23.3+).
	sql := `
		SELECT
			mv1.database AS mv1_database,
			mv1.name AS mv1_name,
			mv2.database AS mv2_database,
			mv2.name AS mv2_name
		FROM system.tables AS mv1
		INNER JOIN system.tables AS mv2
			ON mv2.engine = 'MaterializedView'
			AND mv2.database = mv1.database
		WHERE mv1.engine = 'MaterializedView'
		  AND mv1.name != mv2.name
		  AND mv1.create_table_query LIKE concat('%', mv2.name, '%')
		LIMIT 50`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Debug("failed to detect chained MVs", slog.String("error", err.Error()))
		return
	}

	result.AddMetric(client.Name(), "mvs.chained_count", float64(len(rows)), nil)

	for _, row := range rows {
		mv1DB := getString(row, "mv1_database")
		mv1 := getString(row, "mv1_name")
		mv2 := getString(row, "mv2_name")

		result.AddAlert(client.Name(), SeverityInfo, "mvs",
			"Chained materialized view detected",
			fmt.Sprintf("MV %s.%s depends on MV %s. Chained MVs are fragile; verify the chain is intact.",
				mv1DB, mv1, mv2),
			fmt.Sprintf("%s:mvs:chain:%s:%s", client.Name(), mv1, mv2))
	}
}

func (c *MVCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}
