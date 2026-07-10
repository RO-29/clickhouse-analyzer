package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// RestartCollector detects ClickHouse service restarts by comparing the
// current uptime() against the most recent `system.uptime_seconds` value we
// previously wrote to our own ch_analyzer.metrics table. When uptime
// regresses, the CH process restarted (clean or crash-recovered).
//
// Emits:
//   - one alert per restart, with a unique dedup_key per start epoch so
//     subsequent restarts do NOT dedup with the previous one
//   - `system.restart_detected` metric (= 1 on detection) for charting
//
// Detection requires a prior observation — the very first cycle against a
// fresh node records a baseline only and fires no alert. This is
// intentional: we monitor forward, not reconstruct history.
//
// The check reads from our own ch_analyzer.metrics table (SystemCollector
// writes `system.uptime_seconds` every cycle), which is persisted on the
// same CH node — so detection survives ch-analyzer process restarts.
type RestartCollector struct {
	// Database is the ch_analyzer schema name. Defaults to "ch_analyzer".
	Database string
	Logger   *slog.Logger
}

func (c *RestartCollector) Name() string { return "restart" }

func (c *RestartCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *RestartCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	result := &CollectResult{}

	db := c.Database
	if db == "" {
		db = "ch_analyzer"
	}

	curUptime, err := c.currentUptime(ctx, client)
	if err != nil {
		return nil, fmt.Errorf("restart: uptime: %w", err)
	}

	prevUptime, prevOK := c.previousUptime(ctx, client, db)
	if !prevOK {
		// First observation against this node — record baseline via the
		// SystemCollector's uptime metric (written elsewhere this cycle).
		// Nothing to compare yet.
		return result, nil
	}

	// curUptime >= prevUptime → process still running (or ticked forward).
	// Tolerate a one-second drift from clock jitter / rounding before
	// declaring a restart.
	if curUptime+1 >= prevUptime {
		return result, nil
	}

	// Restart detected. Wall-clock start time from the CH-reported uptime.
	startTime := time.Now().Add(-time.Duration(curUptime) * time.Second)
	startEpoch := startTime.Unix()

	crashed, crashSummary := c.detectCrash(ctx, client, startTime)

	sev := SeverityWarn
	title := "ClickHouse restarted"
	if crashed {
		sev = SeverityCritical
		title = "ClickHouse crashed and restarted"
	}

	msg := fmt.Sprintf(
		"ClickHouse restarted at %s (prior uptime %s → current uptime %s).\n\n%s%s",
		startTime.Format(time.RFC3339),
		formatUptime(prevUptime),
		formatUptime(curUptime),
		crashSummary,
		restartInvestigationPlaybook(startEpoch),
	)

	// Unique per restart event — distinct start epoch = distinct alert row,
	// so the alerter never merges two different restarts into one history
	// entry and the Detail-page "N restarts in 7d" chip is accurate.
	dedup := fmt.Sprintf("%s:system:restart:%d", client.Name(), startEpoch)

	result.AddAlert(client.Name(), sev, "system", title, msg, dedup)
	result.AddMetric(client.Name(), "system.restart_detected", 1, nil)

	c.logger().Warn("clickhouse restart detected",
		slog.String("instance", client.Name()),
		slog.Float64("prev_uptime_s", prevUptime),
		slog.Float64("cur_uptime_s", curUptime),
		slog.String("started_at", startTime.Format(time.RFC3339)),
		slog.Bool("crashed", crashed),
	)

	return result, nil
}

// currentUptime returns the CH server's current uptime in seconds.
func (c *RestartCollector) currentUptime(ctx context.Context, client *chclient.Client) (float64, error) {
	qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := client.QuerySingleValue(qctx, "SELECT uptime()")
	if err != nil {
		return 0, err
	}
	return toFloat64(raw)
}

// previousUptime returns the most recent `system.uptime_seconds` value we
// previously wrote to this instance's ch_analyzer.metrics table. Returns
// (_, false) when no prior observation exists (first-ever poll).
func (c *RestartCollector) previousUptime(ctx context.Context, client *chclient.Client, db string) (float64, bool) {
	qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	sql := fmt.Sprintf(
		`SELECT value FROM %s.metrics
		  WHERE name = 'system.uptime_seconds'
		  ORDER BY ts DESC LIMIT 1`, db)
	raw, err := client.QuerySingleValue(qctx, sql)
	if err != nil {
		c.logger().Debug("restart: previous uptime query failed",
			slog.String("instance", client.Name()), slog.String("err", err.Error()))
		return 0, false
	}
	if raw == "" {
		return 0, false
	}
	v, err := toFloat64(raw)
	if err != nil {
		return 0, false
	}
	return v, true
}

// detectCrash looks at system.crash_log for entries near the restart boundary.
// Returns (true, summary) if crash_log has rows within 10 minutes of the new
// start time. The summary is a compact block that gets embedded in the alert
// message so operators see the crash signal inline instead of having to run
// the playbook first.
func (c *RestartCollector) detectCrash(ctx context.Context, client *chclient.Client, startTime time.Time) (bool, string) {
	qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	// system.crash_log exposes the stack as trace_full (Array(String)); there is
	// no trace_str column. Concatenate a slice of frames for an inline summary.
	// (The old trace_str reference errored, so detectCrash always returned "no
	// crash" and genuine crashes were downgraded to a clean-restart WARN.)
	sql := fmt.Sprintf(`
		SELECT event_time, signal, thread_id, query_id,
			substring(arrayStringConcat(arraySlice(trace_full, 1, 8), ' ← '), 1, 200) AS trace
		FROM system.crash_log
		WHERE event_time >= toDateTime(%d) - INTERVAL 10 MINUTE
		  AND event_time <= toDateTime(%d) + INTERVAL 1 MINUTE
		ORDER BY event_time DESC LIMIT 3`,
		startTime.Unix(), startTime.Unix())

	rows, err := client.Query(qctx, sql)
	if err != nil {
		// Table may not exist on older CH / restricted users. Treat as "no
		// crash evidence" rather than blocking the restart alert.
		return false, ""
	}
	if len(rows) == 0 {
		return false, ""
	}

	var b strings.Builder
	b.WriteString("*Crash signal detected:*\n```\n")
	for _, row := range rows {
		fmt.Fprintf(&b, "%s | signal=%s | thread=%s | query=%s\n  %s\n",
			getString(row, "event_time"),
			getString(row, "signal"),
			getString(row, "thread_id"),
			getString(row, "query_id"),
			getString(row, "trace"),
		)
	}
	b.WriteString("```\n\n")
	return true, b.String()
}

// restartInvestigationPlaybook is embedded in every restart alert so the
// operator can correlate the restart with the 10 minutes of CH activity
// that preceded it. The queries intentionally bound event_time < start_time
// so results describe the pre-restart state, not post-restart re-traffic.
//
// system.query_log is persisted (MergeTree), so pre-restart events survive
// the restart — the same is not true of system.processes or system.metrics
// histories, which is why those aren't in the playbook.
func restartInvestigationPlaybook(startEpoch int64) string {
	return fmt.Sprintf("*Investigate — what happened in the 10 min before restart:*\n```\n"+
		"-- Last 20 exceptions before the restart\n"+
		"SELECT event_time, exception_code, substring(exception,1,200) AS err,\n"+
		"  substring(query,1,200) AS q\n"+
		"FROM system.query_log\n"+
		"WHERE type = 'ExceptionWhileProcessing'\n"+
		"  AND event_time >= toDateTime(%d) - INTERVAL 10 MINUTE\n"+
		"  AND event_time <  toDateTime(%d)\n"+
		"ORDER BY event_time DESC LIMIT 20;\n\n"+
		"-- Out-of-memory events (codes 241, 243)\n"+
		"SELECT event_time, formatReadableSize(memory_usage) AS mem,\n"+
		"  substring(query,1,200) AS q\n"+
		"FROM system.query_log\n"+
		"WHERE exception_code IN (241, 243)\n"+
		"  AND event_time >= toDateTime(%d) - INTERVAL 10 MINUTE\n"+
		"  AND event_time <  toDateTime(%d)\n"+
		"ORDER BY event_time DESC LIMIT 20;\n\n"+
		"-- Heaviest queries right before the restart\n"+
		"SELECT event_time, query_duration_ms AS ms,\n"+
		"  formatReadableSize(memory_usage) AS mem,\n"+
		"  formatReadableSize(read_bytes) AS read_b,\n"+
		"  substring(query,1,250) AS q\n"+
		"FROM system.query_log\n"+
		"WHERE event_time >= toDateTime(%d) - INTERVAL 10 MINUTE\n"+
		"  AND event_time <  toDateTime(%d)\n"+
		"  AND type IN ('QueryFinish','ExceptionWhileProcessing')\n"+
		"ORDER BY memory_usage DESC LIMIT 10;\n\n"+
		"-- Crash log (populated on SIGSEGV/abort — silent on clean restart)\n"+
		"SELECT event_time, signal, thread_id, query_id, trace_full\n"+
		"FROM system.crash_log\n"+
		"WHERE event_time >= toDateTime(%d) - INTERVAL 10 MINUTE\n"+
		"ORDER BY event_time DESC LIMIT 10\n```",
		startEpoch, startEpoch,
		startEpoch, startEpoch,
		startEpoch, startEpoch,
		startEpoch,
	)
}

// formatUptime renders seconds as "Nd Hh Mm" / "Hh Mm" / "Mm Ss".
func formatUptime(sec float64) string {
	s := int64(sec)
	if s < 0 {
		s = 0
	}
	d := s / 86400
	h := (s % 86400) / 3600
	m := (s % 3600) / 60
	ss := s % 60
	switch {
	case d > 0:
		return fmt.Sprintf("%dd %dh %dm", d, h, m)
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm %ds", m, ss)
	default:
		return fmt.Sprintf("%ds", ss)
	}
}
