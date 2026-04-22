package collector

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
)

// ReplicationCollector monitors ClickHouse replication health via system.replicas.
// It closes the gap between config.ReplicationThresholds (which exist) and actual alerting (which was missing).
type ReplicationCollector struct {
	Thresholds config.ReplicationThresholds
	Logger     *slog.Logger
}

func (c *ReplicationCollector) Name() string { return "replication" }

func (c *ReplicationCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *ReplicationCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	c.collectReplicas(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

func (c *ReplicationCollector) collectReplicas(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			database,
			table,
			replica_name,
			is_leader,
			is_readonly,
			is_session_expired,
			future_parts,
			parts_to_check,
			queue_size,
			inserts_in_queue,
			merges_in_queue,
			log_max_index,
			log_pointer,
			absolute_delay,
			replica_is_active
		FROM system.replicas
		ORDER BY absolute_delay DESC`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		// system.replicas doesn't exist on non-replicated instances — skip quietly
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") || strings.Contains(err.Error(), "system.replicas") {
			return
		}
		c.logger().Warn("failed to query system.replicas", slog.String("error", err.Error()))
		return
	}

	if len(rows) == 0 {
		// No replicated tables on this instance
		return
	}

	lagWarn := c.Thresholds.LagWarn.Duration
	lagCrit := c.Thresholds.LagCritical.Duration
	if lagWarn == 0 {
		lagWarn = 30 * time.Second
	}
	if lagCrit == 0 {
		lagCrit = 5 * time.Minute
	}

	var readonlyTables []string
	var criticalLagTables []string
	var warnLagTables []string
	var inconsistentTables []string
	var largeQueueTables []string

	totalTables := len(rows)
	maxDelay := 0.0

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		fqn := db + "." + table

		isReadonly := getFloat(row, "is_readonly")
		isSessionExpired := getFloat(row, "is_session_expired")
		partsToCheck := getFloat(row, "parts_to_check")
		queueSize := getFloat(row, "queue_size")
		insertsInQueue := getFloat(row, "inserts_in_queue")
		mergesInQueue := getFloat(row, "merges_in_queue")
		absoluteDelay := getFloat(row, "absolute_delay") // seconds
		futureParts := getFloat(row, "future_parts")
		logMaxIndex := getFloat(row, "log_max_index")
		logPointer := getFloat(row, "log_pointer")

		if absoluteDelay > maxDelay {
			maxDelay = absoluteDelay
		}

		// Emit metrics
		labels := map[string]string{"database": db, "table": table}
		result.AddMetric(client.Name(), "replication.absolute_delay_sec", absoluteDelay, labels)
		result.AddMetric(client.Name(), "replication.queue_size", queueSize, labels)
		result.AddMetric(client.Name(), "replication.inserts_in_queue", insertsInQueue, labels)
		result.AddMetric(client.Name(), "replication.merges_in_queue", mergesInQueue, labels)
		result.AddMetric(client.Name(), "replication.parts_to_check", partsToCheck, labels)
		result.AddMetric(client.Name(), "replication.future_parts", futureParts, labels)
		logLag := logMaxIndex - logPointer
		if logLag < 0 {
			logLag = 0
		}
		result.AddMetric(client.Name(), "replication.log_lag", logLag, labels)

		// Detect readonly replica
		if isReadonly != 0 || isSessionExpired != 0 {
			readonlyTables = append(readonlyTables, fqn)
		}

		// Detect replication lag
		delay := time.Duration(absoluteDelay) * time.Second
		if delay >= lagCrit {
			criticalLagTables = append(criticalLagTables, fmt.Sprintf("  - %s: %.0fs lag", fqn, absoluteDelay))
		} else if delay >= lagWarn {
			warnLagTables = append(warnLagTables, fmt.Sprintf("  - %s: %.0fs lag", fqn, absoluteDelay))
		}

		// Detect parts needing consistency check
		if partsToCheck > 5 {
			inconsistentTables = append(inconsistentTables, fmt.Sprintf("  - %s: %.0f parts to check", fqn, partsToCheck))
		}

		// Detect large replication queue (> 1000 operations backed up)
		if queueSize > 1000 {
			largeQueueTables = append(largeQueueTables, fmt.Sprintf("  - %s: %.0f ops queued", fqn, queueSize))
		}
	}

	result.AddMetric(client.Name(), "replication.replicated_tables", float64(totalTables), nil)
	result.AddMetric(client.Name(), "replication.max_delay_sec", maxDelay, nil)

	// --- Alerts ---

	if len(readonlyTables) > 0 {
		sort.Strings(readonlyTables)
		msg := fmt.Sprintf("*%d replicated table(s)* are in readonly mode — replication is broken:\n%s\n\n"+
			"*Investigate:*\n```\nSELECT database, table, is_readonly, is_session_expired, last_exception\n"+
			"FROM system.replicas WHERE is_readonly = 1 OR is_session_expired = 1\n```\n"+
			"*Suggestions:*\n"+
			"- Check ZooKeeper/Keeper connectivity: `SELECT * FROM system.zookeeper WHERE path = '/'`\n"+
			"- Check for ZooKeeper session expiry in ClickHouse logs\n"+
			"- If safe, restart ClickHouse to re-establish ZooKeeper session",
			len(readonlyTables), strings.Join(readonlyTables, "\n"))
		result.AddAlert(client.Name(), SeverityCritical, "replication",
			fmt.Sprintf("Replicas readonly: %d tables", len(readonlyTables)),
			msg,
			fmt.Sprintf("%s:replication:readonly", client.Name()))
	}

	if len(criticalLagTables) > 0 {
		sort.Strings(criticalLagTables)
		msg := fmt.Sprintf("*%d table(s)* have critical replication lag (threshold: %s):\n%s\n\n"+
			"*Investigate:*\n```\nSELECT database, table, absolute_delay, queue_size, last_exception\n"+
			"FROM system.replicas ORDER BY absolute_delay DESC\n```\n"+
			"*Suggestions:*\n"+
			"- Check if the replica is keeping up with inserts (queue growing?)\n"+
			"- Look for failed merges blocking the queue\n"+
			"- Check disk space — full disk blocks replication",
			len(criticalLagTables), lagCrit, strings.Join(criticalLagTables, "\n"))
		result.AddAlert(client.Name(), SeverityCritical, "replication",
			fmt.Sprintf("Critical replication lag: %d tables", len(criticalLagTables)),
			msg,
			fmt.Sprintf("%s:replication:lag:critical", client.Name()))
	} else if len(warnLagTables) > 0 {
		sort.Strings(warnLagTables)
		msg := fmt.Sprintf("*%d table(s)* have elevated replication lag (threshold: %s):\n%s\n\n"+
			"*Investigate:*\n```\nSELECT database, table, absolute_delay, queue_size, last_exception\n"+
			"FROM system.replicas ORDER BY absolute_delay DESC\n```",
			len(warnLagTables), lagWarn, strings.Join(warnLagTables, "\n"))
		result.AddAlert(client.Name(), SeverityWarn, "replication",
			fmt.Sprintf("Elevated replication lag: %d tables", len(warnLagTables)),
			msg,
			fmt.Sprintf("%s:replication:lag:warn", client.Name()))
	}

	if len(inconsistentTables) > 0 {
		sort.Strings(inconsistentTables)
		msg := fmt.Sprintf("*%d table(s)* have parts flagged for consistency check:\n%s\n\n"+
			"*Investigate:*\n```\nSELECT database, table, parts_to_check, last_exception\n"+
			"FROM system.replicas WHERE parts_to_check > 0\n```\n"+
			"*Suggestion:* Run `CHECK TABLE <db>.<table>` to identify corrupt parts",
			len(inconsistentTables), strings.Join(inconsistentTables, "\n"))
		result.AddAlert(client.Name(), SeverityWarn, "replication",
			fmt.Sprintf("Replica consistency check: %d tables", len(inconsistentTables)),
			msg,
			fmt.Sprintf("%s:replication:parts_to_check", client.Name()))
	}

	if len(largeQueueTables) > 0 {
		sort.Strings(largeQueueTables)
		msg := fmt.Sprintf("*%d table(s)* have large replication queues (>1000 ops):\n%s\n\n"+
			"*Investigate:*\n```\nSELECT database, table, queue_size, inserts_in_queue, merges_in_queue\n"+
			"FROM system.replicas ORDER BY queue_size DESC\n```",
			len(largeQueueTables), strings.Join(largeQueueTables, "\n"))
		result.AddAlert(client.Name(), SeverityWarn, "replication",
			fmt.Sprintf("Large replication queue: %d tables", len(largeQueueTables)),
			msg,
			fmt.Sprintf("%s:replication:large_queue", client.Name()))
	}
}
