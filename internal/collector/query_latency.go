package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// QueryLatencyCollector detects real-time query P95 latency spikes vs the
// 24-hour baseline. Fires when current P95 is more than 2x the 24h baseline.
type QueryLatencyCollector struct {
	Logger *slog.Logger
}

func (c *QueryLatencyCollector) Name() string { return "query_latency" }

func (c *QueryLatencyCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *QueryLatencyCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	var currentWhere, baselineWhere string
	if tr, ok := TimeRangeFromCtx(ctx); ok {
		// Custom time range: use it as current window; baseline = same window 24h prior.
		currentWhere = fmt.Sprintf(
			"type = 'QueryFinish' AND is_initial_query = 1 AND query_duration_ms > 0"+
				" AND event_time BETWEEN toDateTime(%d) AND toDateTime(%d)",
			tr.From.Unix(), tr.To.Unix())
		baselineWhere = fmt.Sprintf(
			"type = 'QueryFinish' AND is_initial_query = 1 AND query_duration_ms > 0"+
				" AND event_time BETWEEN toDateTime(%d) AND toDateTime(%d)",
			tr.From.Unix()-86400, tr.To.Unix()-86400)
	} else {
		currentWhere = `type = 'QueryFinish' AND is_initial_query = 1
		  AND event_time > now() - INTERVAL 30 MINUTE
		  AND query_duration_ms > 0`
		baselineWhere = `type = 'QueryFinish' AND is_initial_query = 1
		  AND event_time BETWEEN now() - INTERVAL 25 HOUR AND now() - INTERVAL 23 HOUR
		  AND query_duration_ms > 0`
	}

	currentP95, currentCnt, err := c.queryP95(ctx, client, currentWhere)
	if err != nil {
		result.Duration = time.Since(start)
		return result, nil
	}

	baselineP95, baselineCnt, err := c.queryP95(ctx, client, baselineWhere)
	if err != nil {
		result.Duration = time.Since(start)
		return result, nil
	}

	result.AddMetric(client.Name(), "queries.p95_ms_current", currentP95, nil)
	result.AddMetric(client.Name(), "queries.p95_ms_baseline", baselineP95, nil)

	// Suppress alerts on insufficient data or a low-volume baseline.
	if currentCnt < 10 || baselineP95 < 100 {
		result.Duration = time.Since(start)
		return result, nil
	}

	_ = baselineCnt

	dedupKey := fmt.Sprintf("%s:queries:p95_latency_spike", client.Name())
	ratio := currentP95 / baselineP95

	if ratio > 3 {
		result.AddAlert(client.Name(), SeverityCritical, "queries",
			fmt.Sprintf("Query P95 latency spike: %.0fms vs %.0fms baseline (×%.1f)", currentP95, baselineP95, ratio),
			fmt.Sprintf("Query P95 latency spike: %.0fms vs %.0fms baseline (×%.1f). "+
				"Current window: last 30 min (%.0f queries). Baseline: same window yesterday.",
				currentP95, baselineP95, ratio, currentCnt),
			dedupKey)
	} else if ratio > 2 {
		result.AddAlert(client.Name(), SeverityWarn, "queries",
			fmt.Sprintf("Query P95 latency spike: %.0fms vs %.0fms baseline (×%.1f)", currentP95, baselineP95, ratio),
			fmt.Sprintf("Query P95 latency elevated: %.0fms vs %.0fms baseline (×%.1f). "+
				"Current window: last 30 min (%.0f queries). Baseline: same window yesterday.",
				currentP95, baselineP95, ratio, currentCnt),
			dedupKey)
	}

	result.Duration = time.Since(start)
	return result, nil
}

func (c *QueryLatencyCollector) queryP95(ctx context.Context, client *chclient.Client, whereClause string) (p95 float64, cnt float64, err error) {
	sql := fmt.Sprintf(`
		SELECT quantile(0.95)(query_duration_ms) AS p95_ms, count() AS cnt
		FROM system.query_log
		WHERE %s`, whereClause)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
			return 0, 0, nil
		}
		c.logger().Warn("failed to query P95 latency", slog.String("error", err.Error()))
		return 0, 0, err
	}

	if len(rows) == 0 {
		return 0, 0, nil
	}

	p95 = getFloat(rows[0], "p95_ms")
	cnt = getFloat(rows[0], "cnt")
	return p95, cnt, nil
}
