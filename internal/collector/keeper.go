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

	// Keeper is reachable. Check the local session state from
	// system.zookeeper_connection (CH 22+). Only columns that actually exist are
	// used: is_expired signals this replica has LOST its Keeper session — the
	// moment that happens the replica's ReplicatedMergeTree tables flip to
	// read-only and stop replicating, which is the single most important Keeper
	// failure to page on. (The previous query read outstanding_requests /
	// avg_latency / max_latency, none of which exist in this table, so it
	// errored every poll and no Keeper-side alert could ever fire.)
	connSQL := `
		SELECT
			count() AS connected_nodes,
			sum(is_expired) AS expired_sessions,
			min(session_uptime_elapsed_seconds) AS min_session_uptime_s
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
	expired := getFloat(row, "expired_sessions")
	minSessionUptime := getFloat(row, "min_session_uptime_s")

	result.AddMetric(client.Name(), "keeper.connected_nodes", connectedNodes, nil)
	result.AddMetric(client.Name(), "keeper.expired_sessions", expired, nil)
	result.AddMetric(client.Name(), "keeper.min_session_uptime_s", minSessionUptime, nil)

	if expired > 0 {
		result.AddAlert(client.Name(), SeverityCritical, "system",
			"Keeper session expired — replicas going read-only",
			fmt.Sprintf("%.0f Keeper/ZooKeeper session(s) have expired on this node. "+
				"When a replica loses its Keeper session its ReplicatedMergeTree tables "+
				"become read-only and stop accepting inserts until the session recovers.\n\n%s",
				expired, keeperConnectionPlaybook),
			fmt.Sprintf("%s:keeper:session_expired", client.Name()))
	}

	result.Duration = time.Since(start)
	return result, nil
}
