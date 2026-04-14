package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// AsyncInsertsCollector monitors the async insert pipeline.
// Async inserts buffer data in memory before flushing to storage — failures
// here risk data loss. Gracefully no-ops if async inserts are not configured.
type AsyncInsertsCollector struct {
	Logger *slog.Logger
}

func (c *AsyncInsertsCollector) Name() string { return "async_inserts" }

func (c *AsyncInsertsCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *AsyncInsertsCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	// system.asynchronous_insert_log is available in CH 22.4+.
	logSQL := `
		SELECT
			count() AS total,
			countIf(status = 'ExceptionWhileFlushing') AS errors,
			countIf(status = 'Flushed') AS flushed
		FROM system.asynchronous_insert_log
		WHERE event_time > now() - INTERVAL 5 MINUTE`

	logRows, err := client.Query(ctx, logSQL)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") ||
			strings.Contains(err.Error(), "doesn't exist") ||
			strings.Contains(err.Error(), "not exists") {
			// Async inserts not configured or old CH version — skip silently.
			result.Duration = time.Since(start)
			return result, nil
		}
		c.logger().Warn("async_inserts: failed to query asynchronous_insert_log", slog.String("error", err.Error()))
		result.Duration = time.Since(start)
		return result, nil
	}

	if len(logRows) == 0 {
		result.Duration = time.Since(start)
		return result, nil
	}

	row := logRows[0]
	total := getFloat(row, "total")
	errors := getFloat(row, "errors")

	if total == 0 {
		// No async inserts in window — nothing to alert on.
		result.Duration = time.Since(start)
		return result, nil
	}

	result.AddMetric(client.Name(), "async_inserts.total_5m", total, nil)
	result.AddMetric(client.Name(), "async_inserts.errors_5m", errors, nil)

	if errors > 0 {
		errPct := (errors / total) * 100
		dedupKey := fmt.Sprintf("%s:async_inserts:flush_errors", client.Name())
		if errPct > 10 || errors >= 5 {
			result.AddAlert(client.Name(), SeverityCritical, "inserts",
				fmt.Sprintf("Async insert failures: %.0f errors in 5 min (%.1f%%)", errors, errPct),
				fmt.Sprintf("%.0f async insert flush failures in the last 5 minutes (%.1f%% of %.0f total). "+
					"Data in the buffer may be lost if not retried.\n\n"+
					"*Investigate:*\n```\nSELECT query, exception, event_time\nFROM system.asynchronous_insert_log\n"+
					"WHERE status = 'ExceptionWhileFlushing'\n  AND event_time > now() - INTERVAL 5 MINUTE\n"+
					"ORDER BY event_time DESC LIMIT 20\n```",
					errors, errPct, total),
				dedupKey)
		} else {
			result.AddAlert(client.Name(), SeverityWarn, "inserts",
				fmt.Sprintf("Async insert flush errors: %.0f in 5 min", errors),
				fmt.Sprintf("%.0f async insert flush error(s) in the last 5 minutes out of %.0f total.\n\n"+
					"*Investigate:*\n```\nSELECT query, exception, event_time\nFROM system.asynchronous_insert_log\n"+
					"WHERE status = 'ExceptionWhileFlushing'\n  AND event_time > now() - INTERVAL 5 MINUTE\nLIMIT 10\n```",
					errors, total),
				dedupKey)
		}
	}

	// Check pending queue depth (system.asynchronous_insertions — CH 22.4+).
	queueSQL := `SELECT count() AS queue_depth FROM system.asynchronous_insertions`
	qRows, qErr := client.Query(ctx, queueSQL)
	if qErr == nil && len(qRows) > 0 {
		depth := getFloat(qRows[0], "queue_depth")
		result.AddMetric(client.Name(), "async_inserts.queue_depth", depth, nil)
		dedupKey := fmt.Sprintf("%s:async_inserts:queue_depth", client.Name())
		if depth > 100 {
			result.AddAlert(client.Name(), SeverityCritical, "inserts",
				fmt.Sprintf("Async insert queue very deep: %.0f entries", depth),
				fmt.Sprintf("The async insert buffer has %.0f pending entries — flush thread is likely falling behind.\n\n"+
					"*Investigate:*\n```\nSELECT database, table, count() AS cnt\nFROM system.asynchronous_insertions\n"+
					"GROUP BY database, table ORDER BY cnt DESC\n```",
					depth),
				dedupKey)
		} else if depth > 50 {
			result.AddAlert(client.Name(), SeverityWarn, "inserts",
				fmt.Sprintf("Async insert queue growing: %.0f entries", depth),
				fmt.Sprintf("Async insert buffer has %.0f pending entries — monitor for continued growth.", depth),
				dedupKey)
		}
	}

	result.Duration = time.Since(start)
	return result, nil
}
