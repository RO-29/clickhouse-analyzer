package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// KeeperCollector monitors ClickHouse Keeper / ZooKeeper connectivity and health.
// Keeper is used by ReplicatedMergeTree and distributed DDL. An unhealthy Keeper
// causes replicas to stop inserting and merging.
//
// Safe on non-replicated deployments — all queries fail gracefully if Keeper is
// not configured.
type KeeperCollector struct {
	Logger *slog.Logger
}

func (c *KeeperCollector) Name() string { return "keeper" }

func (c *KeeperCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *KeeperCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	// Skip entirely when system.zookeeper isn't usable on this instance — it's
	// access-denied on managed Keeper (ClickHouse Cloud) and absent on
	// non-replicated deployments. The capability layer probes this once and
	// caches it, so we avoid a guaranteed-to-fail query every poll.
	if !client.Caps(ctx).Has(chclient.FeatureZookeeper) {
		result.Duration = time.Since(start)
		return result, nil
	}

	// Probe ZK/Keeper reachability with a short timeout.
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	probeSQL := `SELECT count() AS cnt FROM system.zookeeper WHERE path = '/'`
	_, probeErr := client.Query(probeCtx, probeSQL)
	if probeErr != nil {
		errStr := probeErr.Error()

		// Not configured / disabled — skip silently.
		if strings.Contains(errStr, "UNKNOWN_TABLE") ||
			strings.Contains(errStr, "NO_ZOOKEEPER") ||
			strings.Contains(errStr, "not configured") ||
			strings.Contains(errStr, "Coordination is disabled") ||
			strings.Contains(errStr, "ZooKeeper is not configured") {
			result.Duration = time.Since(start)
			return result, nil
		}

		// No grant on system.zookeeper — skip silently. On ClickHouse Cloud /
		// managed services Keeper is not operator-visible and SELECT ON
		// system.zookeeper is intentionally withheld; there is nothing to probe.
		// Replication health is covered by the replication collector, which uses
		// system.replicas / system.replication_queue instead.
		if strings.Contains(errStr, "ACCESS_DENIED") ||
			strings.Contains(errStr, "Not enough privileges") ||
			strings.Contains(errStr, "Code: 497") {
			result.Duration = time.Since(start)
			return result, nil
		}

		// Connection failure — alert.
		if strings.Contains(errStr, "ALL_CONNECTION_TRIES_FAILED") ||
			strings.Contains(errStr, "CANNOT_CONNECT") ||
			strings.Contains(errStr, "Cannot connect") ||
			strings.Contains(errStr, "context deadline exceeded") ||
			strings.Contains(errStr, "Connection refused") {
			result.AddAlert(client.Name(), SeverityCritical, "system",
				"ClickHouse Keeper / ZooKeeper unreachable",
				fmt.Sprintf("Cannot connect to ClickHouse Keeper or ZooKeeper. "+
					"ReplicatedMergeTree tables will stop accepting inserts and merges.\n\n"+
					"Error: %s\n\n%s",
					errStr, keeperConnectionPlaybook),
				fmt.Sprintf("%s:keeper:unreachable", client.Name()))
			result.Duration = time.Since(start)
			return result, nil
		}

		c.logger().Warn("keeper: probe failed", slog.String("error", errStr))
		result.Duration = time.Since(start)
		return result, nil
	}

	// Keeper is reachable. Check connection stats (system.zookeeper_connection — CH 22+).
	connSQL := `
		SELECT
			count() AS connected_nodes,
			sum(outstanding_requests) AS total_outstanding,
			max(avg_latency) AS max_avg_latency_ms,
			max(max_latency) AS max_latency_ms
		FROM system.zookeeper_connection`

	connRows, err := client.Query(ctx, connSQL)
	if err != nil {
		// system.zookeeper_connection not available on all versions — fine.
		result.Duration = time.Since(start)
		return result, nil
	}

	if len(connRows) == 0 {
		result.Duration = time.Since(start)
		return result, nil
	}

	row := connRows[0]
	connectedNodes := getFloat(row, "connected_nodes")
	outstanding := getFloat(row, "total_outstanding")
	maxAvgLatency := getFloat(row, "max_avg_latency_ms")
	maxLatency := getFloat(row, "max_latency_ms")

	result.AddMetric(client.Name(), "keeper.connected_nodes", connectedNodes, nil)
	result.AddMetric(client.Name(), "keeper.outstanding_requests", outstanding, nil)
	result.AddMetric(client.Name(), "keeper.max_avg_latency_ms", maxAvgLatency, nil)

	if outstanding > 500 {
		result.AddAlert(client.Name(), SeverityCritical, "system",
			fmt.Sprintf("Keeper overloaded: %.0f outstanding requests", outstanding),
			fmt.Sprintf("ClickHouse Keeper has %.0f outstanding requests queued. "+
				"This level of backlog delays distributed operations and may cause timeouts.\n\n%s",
				outstanding, keeperConnectionPlaybook),
			fmt.Sprintf("%s:keeper:outstanding_requests", client.Name()))
	} else if outstanding > 100 {
		result.AddAlert(client.Name(), SeverityWarn, "system",
			fmt.Sprintf("Keeper backlog: %.0f outstanding requests", outstanding),
			fmt.Sprintf("ClickHouse Keeper has %.0f outstanding requests — monitor for growth.\n\n%s",
				outstanding, keeperConnectionPlaybook),
			fmt.Sprintf("%s:keeper:outstanding_requests", client.Name()))
	}

	if maxAvgLatency > 500 {
		result.AddAlert(client.Name(), SeverityWarn, "system",
			fmt.Sprintf("Keeper high latency: avg %.0fms, max %.0fms", maxAvgLatency, maxLatency),
			fmt.Sprintf("ClickHouse Keeper average latency is %.0fms (max: %.0fms). "+
				"High latency slows down distributed operations and inserts.\n\n%s",
				maxAvgLatency, maxLatency, keeperConnectionPlaybook),
			fmt.Sprintf("%s:keeper:latency", client.Name()))
	}

	result.Duration = time.Since(start)
	return result, nil
}
