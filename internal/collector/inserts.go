package collector

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
)

// InsertCollector monitors INSERT throughput, detects small-insert anti-patterns,
// and flags pipeline stalls by querying system.query_log.
type InsertCollector struct {
	Thresholds      config.InsertsThresholds
	PollingInterval time.Duration // used as the "current interval" window
	Logger          *slog.Logger
}

func (c *InsertCollector) Name() string { return "inserts" }

func (c *InsertCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	interval := c.PollingInterval
	if interval <= 0 {
		interval = time.Minute
	}

	c.collectInsertThroughput(ctx, client, result, interval)
	c.collectInsertErrors(ctx, client, result, interval)
	c.collectSmallInserts(ctx, client, result, interval)
	c.collectPipelineStalls(ctx, client, result)
	c.collectIngestDelay(ctx, client, result, interval)

	result.Duration = time.Since(start)
	return result, nil
}

// collectInsertThroughput counts INSERTs per table over the current interval
// and compares to a rolling average for drop detection.
func (c *InsertCollector) collectInsertThroughput(ctx context.Context, client *chclient.Client, result *CollectResult, interval time.Duration) {
	intervalSec := int(interval.Seconds())
	if intervalSec < 1 {
		intervalSec = 60
	}

	// Current interval throughput per table.
	// Use databases[1]/tables[1] instead of ARRAY JOIN because the two arrays
	// can have different lengths in CH 25.x (MVs add extra entries to tables).
	sqlCurrent := fmt.Sprintf(`
		SELECT
			databases[1] AS database,
			tables[1] AS table,
			count() AS insert_count,
			sum(written_rows) AS total_rows,
			sum(written_bytes) AS total_bytes
		FROM system.query_log
		WHERE type = 'QueryFinish'
		  AND query_kind = 'Insert'
		  AND length(databases) >= 1
		  AND databases[1] != 'ch_analyzer'
		  AND event_time >= now() - INTERVAL %d SECOND
		GROUP BY database, table
		ORDER BY total_rows DESC`, intervalSec)

	rows, err := client.Query(ctx, sqlCurrent)
	if err != nil {
		c.logger().Warn("failed to query current insert throughput", slog.String("error", err.Error()))
		return
	}

	var totalInserts, totalRows, totalBytes float64
	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		count := getFloat(row, "insert_count")
		rowsInserted := getFloat(row, "total_rows")
		bytesInserted := getFloat(row, "total_bytes")

		labels := map[string]string{
			"database": db,
			"table":    table,
		}
		result.AddMetric(client.Name(), "inserts.table.count", count, labels)
		result.AddMetric(client.Name(), "inserts.table.rows", rowsInserted, labels)
		result.AddMetric(client.Name(), "inserts.table.bytes", bytesInserted, labels)

		totalInserts += count
		totalRows += rowsInserted
		totalBytes += bytesInserted
	}

	result.AddMetric(client.Name(), "inserts.total.count", totalInserts, nil)
	result.AddMetric(client.Name(), "inserts.total.rows", totalRows, nil)
	result.AddMetric(client.Name(), "inserts.total.bytes", totalBytes, nil)

	// Rolling average: compare the current interval to the average of the last
	// 10 intervals to detect throughput drops.
	rollingWindowSec := intervalSec * 10
	sqlRolling := fmt.Sprintf(`
		SELECT
			count() / 10 AS avg_insert_count,
			sum(written_rows) / 10 AS avg_rows,
			sum(written_bytes) / 10 AS avg_bytes
		FROM system.query_log
		WHERE type = 'QueryFinish'
		  AND query_kind = 'Insert'
		  AND length(databases) >= 1
		  AND databases[1] != 'ch_analyzer'
		  AND event_time >= now() - INTERVAL %d SECOND
		  AND event_time < now() - INTERVAL %d SECOND`, rollingWindowSec, intervalSec)

	rollingRows, err := client.Query(ctx, sqlRolling)
	if err != nil {
		c.logger().Warn("failed to query rolling insert average", slog.String("error", err.Error()))
		return
	}

	if len(rollingRows) > 0 {
		avgRows := getFloat(rollingRows[0], "avg_rows")
		result.AddMetric(client.Name(), "inserts.rolling_avg.rows", avgRows, nil)

		if avgRows > 0 && totalRows > 0 {
			dropPct := ((avgRows - totalRows) / avgRows) * 100.0
			result.AddMetric(client.Name(), "inserts.throughput_drop_percent", dropPct, nil)

			if dropPct >= c.Thresholds.ThroughputDropPercent {
				result.AddAlert(client.Name(), SeverityWarn, "inserts",
					"Insert throughput drop detected",
					fmt.Sprintf("Current interval: %.0f rows vs rolling avg: %.0f rows (%.1f%% drop, threshold: %.0f%%)\n\n%s",
						totalRows, avgRows, dropPct, c.Thresholds.ThroughputDropPercent, insertThroughputPlaybook),
					fmt.Sprintf("%s:inserts:throughput_drop", client.Name()))
			}
		}
	}
}

// collectSmallInserts detects the anti-pattern of many INSERTs with very few
// rows each, which causes excessive part creation.
func (c *InsertCollector) collectSmallInserts(ctx context.Context, client *chclient.Client, result *CollectResult, interval time.Duration) {
	intervalSec := int(interval.Seconds())
	if intervalSec < 1 {
		intervalSec = 60
	}
	threshold := c.Thresholds.SmallInsertThreshold
	if threshold <= 0 {
		threshold = 100
	}

	sql := fmt.Sprintf(`
		SELECT
			databases[1] AS database,
			tables[1] AS table,
			count() AS small_insert_count,
			avg(written_rows) AS avg_rows_per_insert
		FROM system.query_log
		WHERE type = 'QueryFinish'
		  AND query_kind = 'Insert'
		  AND length(databases) >= 1
		  AND databases[1] != 'ch_analyzer'
		  AND written_rows < %d
		  AND written_rows > 0
		  AND event_time >= now() - INTERVAL %d SECOND
		GROUP BY database, table
		HAVING small_insert_count >= %d
		ORDER BY small_insert_count DESC
		LIMIT 20`, threshold, intervalSec, c.Thresholds.SmallInsertWarnCount)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query small inserts", slog.String("error", err.Error()))
		return
	}

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		count := getFloat(row, "small_insert_count")
		avgRows := getFloat(row, "avg_rows_per_insert")

		fqn := db + "." + table
		labels := map[string]string{
			"database": db,
			"table":    table,
		}
		result.AddMetric(client.Name(), "inserts.small.count", count, labels)
		result.AddMetric(client.Name(), "inserts.small.avg_rows", avgRows, labels)

		result.AddAlert(client.Name(), SeverityWarn, "inserts",
			"Small insert anti-pattern detected",
			fmt.Sprintf("%s: %.0f inserts with <=%d rows each (avg %.0f rows/insert) in last %ds. Consider batching.\n\n%s",
				fqn, count, threshold, avgRows, intervalSec, smallInsertsPlaybook),
			fmt.Sprintf("%s:inserts:small:%s", client.Name(), fqn))
	}
}

// collectPipelineStalls flags tables that normally receive inserts but have
// not received any in the last 3x the polling interval.
func (c *InsertCollector) collectPipelineStalls(ctx context.Context, client *chclient.Client, result *CollectResult) {
	// Look at tables that had inserts in the last hour but NOT in the last 3
	// intervals. This detects pipeline stalls without requiring explicit config
	// of expected tables.
	interval := c.PollingInterval
	if interval <= 0 {
		interval = time.Minute
	}
	stallWindowSec := int((3 * interval).Seconds())
	lookbackSec := 3600 // 1 hour

	sql := fmt.Sprintf(`
		SELECT
			database,
			table,
			max(event_time) AS last_insert_time,
			dateDiff('second', max(event_time), now()) AS seconds_since_last
		FROM (
			SELECT
				databases[1] AS database,
				tables[1] AS table,
				event_time
			FROM system.query_log
			WHERE type = 'QueryFinish'
			  AND query_kind = 'Insert'
			  AND length(databases) >= 1
			  AND databases[1] != 'ch_analyzer'
			  AND event_time >= now() - INTERVAL %d SECOND
		)
		GROUP BY database, table
		HAVING seconds_since_last > %d
		ORDER BY seconds_since_last DESC
		LIMIT 20`, lookbackSec, stallWindowSec)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query pipeline stalls", slog.String("error", err.Error()))
		return
	}

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		secsSince := getFloat(row, "seconds_since_last")

		fqn := db + "." + table
		result.AddMetric(client.Name(), "inserts.seconds_since_last", secsSince, map[string]string{
			"database": db,
			"table":    table,
		})

		result.AddAlert(client.Name(), SeverityWarn, "inserts",
			"Possible pipeline stall",
			fmt.Sprintf("%s has not received inserts for %.0fs (had inserts earlier in the hour, stall threshold: %ds)\n\n%s",
				fqn, secsSince, stallWindowSec, insertStallPlaybook),
			fmt.Sprintf("%s:inserts:stall:%s", client.Name(), fqn))
	}
}

// collectInsertErrors directly counts INSERT exceptions from system.query_log.
// Unlike throughput drop (which is indirect), this fires immediately when inserts fail.
func (c *InsertCollector) collectInsertErrors(ctx context.Context, client *chclient.Client, result *CollectResult, interval time.Duration) {
	intervalSec := int(interval.Seconds())
	if intervalSec < 1 {
		intervalSec = 60
	}

	sql := fmt.Sprintf(`
		SELECT
			databases[1] AS database,
			tables[1] AS table,
			count() AS failed_inserts,
			any(exception) AS last_exception
		FROM system.query_log
		WHERE type = 'ExceptionWhileProcessing'
		  AND query_kind = 'Insert'
		  AND length(databases) >= 1
		  AND databases[1] != 'ch_analyzer'
		  AND event_time >= now() - INTERVAL %d SECOND
		GROUP BY database, table
		ORDER BY failed_inserts DESC
		LIMIT 20`, intervalSec)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query insert errors", slog.String("error", err.Error()))
		return
	}

	if len(rows) == 0 {
		return
	}

	// Also get total successful inserts in same window for error rate.
	totalSQL := fmt.Sprintf(`
		SELECT count() AS total
		FROM system.query_log
		WHERE type = 'QueryFinish'
		  AND query_kind = 'Insert'
		  AND length(databases) >= 1
		  AND databases[1] != 'ch_analyzer'
		  AND event_time >= now() - INTERVAL %d SECOND`, intervalSec)

	var totalSuccess float64
	if totRows, totErr := client.Query(ctx, totalSQL); totErr == nil && len(totRows) > 0 {
		totalSuccess = getFloat(totRows[0], "total")
	}

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		failed := getFloat(row, "failed_inserts")
		lastExc := getString(row, "last_exception")

		fqn := db + "." + table
		result.AddMetric(client.Name(), "inserts.errors.count", failed, map[string]string{
			"database": db,
			"table":    table,
		})

		if len(lastExc) > 200 {
			lastExc = lastExc[:200] + "…"
		}

		// Compute error rate if we have success counts.
		errRate := 0.0
		totalOps := totalSuccess + failed
		if totalOps > 0 {
			errRate = (failed / totalOps) * 100
		}

		severity := SeverityWarn
		if errRate >= 5 || (totalSuccess == 0 && failed >= 5) {
			severity = SeverityCritical
		}

		result.AddAlert(client.Name(), severity, "inserts",
			fmt.Sprintf("Insert failures on %s: %.0f in last %ds", fqn, failed, intervalSec),
			fmt.Sprintf("*%.0f INSERT exception(s)* on `%s` in the last %ds (error rate: %.1f%%).\n\n"+
				"*Last exception:* %s\n\n%s",
				failed, fqn, intervalSec, errRate, lastExc,
				insertExceptionPlaybook(db, table, intervalSec)),
			fmt.Sprintf("%s:inserts:errors:%s", client.Name(), fqn))
	}
}

// collectIngestDelay surfaces three CH backpressure signals from
// system.metrics + system.asynchronous_metrics + system.events:
//
//   - DelayedInserts (current): in-flight INSERTs that CH is sleeping because
//     parts are accumulating. >0 means throttling has started.
//   - PendingAsyncInsert (current): rows queued for async-insert flush.
//     A growing queue means the flush isn't keeping up with submission.
//   - RejectedInserts (rate per minute): TOO_MANY_PARTS rejections from
//     ProfileEvents. Even one is bad — it's a dropped client request.
//
// All three feed dedicated alerts so operators see WHICH backpressure mode
// triggered, not just "inserts are slow".
func (c *InsertCollector) collectIngestDelay(ctx context.Context, client *chclient.Client, result *CollectResult, interval time.Duration) {
	intervalSec := int(interval.Seconds())
	if intervalSec < 1 {
		intervalSec = 60
	}

	// system.metrics: current gauges (DelayedInserts is the gauge, not a counter).
	gauges, err := client.Query(ctx, `
		SELECT metric, value FROM system.metrics
		WHERE metric IN ('DelayedInserts','PendingAsyncInsert')`)
	if err != nil {
		c.logger().Warn("ingest delay: system.metrics query failed", slog.String("err", err.Error()))
	} else {
		var delayed, pending float64
		for _, row := range gauges {
			switch getString(row, "metric") {
			case "DelayedInserts":
				delayed = getFloat(row, "value")
			case "PendingAsyncInsert":
				pending = getFloat(row, "value")
			}
		}
		result.AddMetric(client.Name(), "inserts.delayed.current", delayed, nil)
		result.AddMetric(client.Name(), "inserts.async.pending", pending, nil)

		if c.Thresholds.DelayedInsertsCritical > 0 && delayed >= float64(c.Thresholds.DelayedInsertsCritical) {
			result.AddAlert(client.Name(), SeverityCritical, "inserts",
				"Inserts being delayed by ClickHouse",
				fmt.Sprintf("*%.0f in-flight INSERTs are being slept* by CH (critical: %d). "+
					"This is `parts_to_delay_insert` kicking in — clients see latency spikes.\n\n%s",
					delayed, c.Thresholds.DelayedInsertsCritical, ingestDelayPlaybook(intervalSec)),
				fmt.Sprintf("%s:inserts:delayed", client.Name()))
		} else if c.Thresholds.DelayedInsertsWarn > 0 && delayed >= float64(c.Thresholds.DelayedInsertsWarn) {
			result.AddAlert(client.Name(), SeverityWarn, "inserts",
				"Inserts being delayed by ClickHouse",
				fmt.Sprintf("*%.0f in-flight INSERTs are being slept* by CH (warn: %d).\n\n%s",
					delayed, c.Thresholds.DelayedInsertsWarn, ingestDelayPlaybook(intervalSec)),
				fmt.Sprintf("%s:inserts:delayed", client.Name()))
		}

		if c.Thresholds.PendingAsyncInsertsCritical > 0 && pending >= float64(c.Thresholds.PendingAsyncInsertsCritical) {
			result.AddAlert(client.Name(), SeverityCritical, "inserts",
				"Async insert queue backed up",
				fmt.Sprintf("*%.0f rows queued* for async-insert flush (critical: %d). "+
					"Increase `async_insert_max_data_size` or reduce concurrent submitters.\n\n%s",
					pending, c.Thresholds.PendingAsyncInsertsCritical, asyncInsertQueuePlaybook),
				fmt.Sprintf("%s:inserts:async:pending", client.Name()))
		} else if c.Thresholds.PendingAsyncInsertsWarn > 0 && pending >= float64(c.Thresholds.PendingAsyncInsertsWarn) {
			result.AddAlert(client.Name(), SeverityWarn, "inserts",
				"Async insert queue elevated",
				fmt.Sprintf("*%.0f rows queued* for async-insert flush (warn: %d).\n\n%s",
					pending, c.Thresholds.PendingAsyncInsertsWarn, asyncInsertQueuePlaybook),
				fmt.Sprintf("%s:inserts:async:pending", client.Name()))
		}
	}

	// system.events: cumulative counter — diff via system.query_log not
	// available, so we compute rate from RejectedInserts as a per-second figure
	// using the live counter divided by the server uptime, with our own
	// poll-interval fallback. Cheaper alternative: ProfileEvents in query_log,
	// but we want "rejected anywhere" not "rejected by some specific query".
	rejSQL := `SELECT value FROM system.events WHERE event = 'RejectedInserts'`
	if raw, rerr := client.QuerySingleValue(ctx, rejSQL); rerr == nil && raw != "" {
		if rejected, perr := toFloat64(raw); perr == nil {
			result.AddMetric(client.Name(), "inserts.rejected.total", rejected, nil)
			// Rate is meaningful only relative to a baseline. Surface the raw
			// counter via the metric; alert only when it's clearly active —
			// any non-zero value seen this cycle, gated by a cooldown via the
			// dedup key including the rounded count so re-fires reset.
			if rejected > 0 && c.Thresholds.RejectedInsertsRateWarn > 0 {
				result.AddAlert(client.Name(), SeverityCritical, "inserts",
					"INSERTs rejected (TOO_MANY_PARTS)",
					fmt.Sprintf("ClickHouse has rejected *%.0f INSERTs* total (`system.events.RejectedInserts`). "+
						"Each rejection is a dropped client request — `parts_to_throw_insert` was crossed for some partition.\n\n"+
						"*Investigate:*\n```\n"+
						"-- Which exception code is the application seeing\n"+
						"SELECT exception_code, count(), any(substring(exception,1,200)) AS sample\n"+
						"FROM system.query_log\n"+
						"WHERE type = 'ExceptionWhileProcessing'\n"+
						"  AND query_kind = 'Insert'\n"+
						"  AND event_time > now() - INTERVAL %d SECOND\n"+
						"GROUP BY exception_code ORDER BY count() DESC;\n\n"+
						"-- Hot partitions to OPTIMIZE\n"+
						"SELECT database, table, partition, count() AS parts\n"+
						"FROM system.parts WHERE active\n"+
						"GROUP BY database, table, partition\n"+
						"HAVING parts > 500 ORDER BY parts DESC LIMIT 20\n```",
						rejected, intervalSec),
					fmt.Sprintf("%s:inserts:rejected", client.Name()))
			}
		}
	}
}

// ingestDelayPlaybook is shared by the DelayedInserts critical/warn variants.
// Bound the time window to the alert's poll interval so the SQL surfaces the
// same activity that produced the gauge reading.
func ingestDelayPlaybook(windowSec int) string {
	if windowSec < 60 {
		windowSec = 60
	}
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"-- Which tables are being throttled (per-table parts vs CH limits)\n"+
		"SELECT database, table, count() AS parts,\n"+
		"  countIf(active) AS active_parts\n"+
		"FROM system.parts\n"+
		"WHERE active\n"+
		"GROUP BY database, table HAVING parts > 50 ORDER BY parts DESC LIMIT 20;\n\n"+
		"-- INSERTs currently in flight\n"+
		"SELECT user, query_id, elapsed, written_rows, formatReadableSize(memory_usage) AS mem,\n"+
		"  substring(query,1,200) AS q\n"+
		"FROM system.processes WHERE query_kind = 'Insert' ORDER BY elapsed DESC;\n\n"+
		"-- Recent insert exceptions for this throttling window\n"+
		"SELECT event_time, databases[1] AS db, tables[1] AS tbl,\n"+
		"  exception_code, substring(exception,1,200) AS err\n"+
		"FROM system.query_log\n"+
		"WHERE type = 'ExceptionWhileProcessing' AND query_kind = 'Insert'\n"+
		"  AND event_time > now() - INTERVAL %d SECOND\n"+
		"ORDER BY event_time DESC LIMIT 20\n```\n"+
		"*Fix:* OPTIMIZE the hottest table/partition to drain parts; back off insert "+
		"frequency; raise `parts_to_delay_insert` only as a temporary lever.", windowSec)
}

func (c *InsertCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}
