package collector

import (
	"context"
	"log/slog"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// ConnectionsCollector samples per-interface connection counts from
// system.metrics every poll cycle. The Connections tab surfaces the live
// numbers directly from the same table, but operators also want a
// historical view ("did we get a connection spike around 9pm?") — that's
// what this collector provides, by writing the counts as time-series
// metrics the dashboard can chart.
//
// Emitted metrics (all per-instance, no labels):
//
//	connections.tcp
//	connections.http
//	connections.mysql
//	connections.postgresql
//	connections.interserver
//	connections.total       (sum of the five, for a single-line overview)
type ConnectionsCollector struct {
	Logger *slog.Logger
}

func (c *ConnectionsCollector) Name() string { return "connections" }

func (c *ConnectionsCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *ConnectionsCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	// Single query for all five interface counts — cheaper than five round
	// trips, and system.metrics is a tiny in-memory table.
	sql := `SELECT metric, value FROM system.metrics
		WHERE metric IN (
			'TCPConnection', 'HTTPConnection', 'MySQLConnection',
			'PostgreSQLConnection', 'InterserverConnection'
		)`
	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.metrics for connections",
			slog.String("error", err.Error()))
		result.Duration = time.Since(start)
		return result, nil
	}

	// Map ClickHouse metric names → our stable metric-name suffix. Kept
	// lowercase so the UI labels stay consistent with the cards.
	nameMap := map[string]string{
		"TCPConnection":         "connections.tcp",
		"HTTPConnection":        "connections.http",
		"MySQLConnection":       "connections.mysql",
		"PostgreSQLConnection":  "connections.postgresql",
		"InterserverConnection": "connections.interserver",
	}

	var total float64
	seen := make(map[string]bool, len(nameMap))
	for _, row := range rows {
		metric := getString(row, "metric")
		value := getFloat(row, "value")
		out, ok := nameMap[metric]
		if !ok {
			continue
		}
		result.AddMetric(client.Name(), out, value, nil)
		total += value
		seen[out] = true
	}
	// Emit zeros for missing interfaces so charts don't drop to undefined.
	for _, out := range nameMap {
		if !seen[out] {
			result.AddMetric(client.Name(), out, 0, nil)
		}
	}
	result.AddMetric(client.Name(), "connections.total", total, nil)

	result.Duration = time.Since(start)
	return result, nil
}
