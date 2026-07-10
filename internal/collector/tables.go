package collector

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
)

// TableCollector monitors part counts, merges, mutations, and disk balance
// from system.parts, system.merges, and system.mutations.
type TableCollector struct {
	PartsThresholds     config.PartsThresholds
	MergesThresholds    config.MergesThresholds
	MutationsThresholds config.MutationsThresholds
	Logger              *slog.Logger
}

func (c *TableCollector) Name() string { return "tables" }

func (c *TableCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	clusterParts := c.collectParts(ctx, client, result)
	c.collectPartitionPressure(ctx, client, result)
	c.collectMerges(ctx, client, result, clusterParts)
	c.collectMutations(ctx, client, result)
	c.collectDiskBalance(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

// collectParts queries system.parts for per-table part counts and sizes.
// Returns the total active parts across the cluster so collectMerges can use
// it as a "is there backlog?" signal for the merges-stalled check.
func (c *TableCollector) collectParts(ctx context.Context, client *chclient.Client, result *CollectResult) float64 {
	sql := `
		SELECT
			database,
			table,
			disk_name,
			count() AS part_count,
			sum(rows) AS total_rows,
			sum(bytes_on_disk) AS total_bytes,
			countIf(active) AS active_parts
		FROM system.parts
		WHERE active
		GROUP BY database, table, disk_name
		ORDER BY part_count DESC`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.parts", slog.String("error", err.Error()))
		return 0
	}

	// Aggregate parts across disks per table for threshold checks.
	type tableKey struct{ db, table string }
	tableParts := make(map[tableKey]float64)
	var clusterTotal float64

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		disk := getString(row, "disk_name")
		partCount := getFloat(row, "part_count")
		totalRows := getFloat(row, "total_rows")
		totalBytes := getFloat(row, "total_bytes")
		activeParts := getFloat(row, "active_parts")

		labels := map[string]string{
			"database": db,
			"table":    table,
			"disk":     disk,
		}
		result.AddMetric(client.Name(), "tables.parts.count", partCount, labels)
		result.AddMetric(client.Name(), "tables.parts.rows", totalRows, labels)
		result.AddMetric(client.Name(), "tables.parts.bytes", totalBytes, labels)
		result.AddMetric(client.Name(), "tables.parts.active", activeParts, labels)

		key := tableKey{db, table}
		tableParts[key] += partCount
		clusterTotal += partCount
	}

	// Cluster-wide active parts metric + alert. CH starts throttling at the
	// `parts_to_delay_insert` and outright rejects at `parts_to_throw_insert`
	// system limits — being above MaxClusterParts means we're in the danger
	// zone before either kicks in.
	result.AddMetric(client.Name(), "tables.parts.cluster_total", clusterTotal, nil)
	if c.PartsThresholds.MaxClusterParts > 0 && clusterTotal >= float64(c.PartsThresholds.MaxClusterParts) {
		result.AddAlert(client.Name(), SeverityCritical, "tables",
			"Active parts at cluster ceiling",
			fmt.Sprintf("Instance has *%.0f active parts* across all tables (limit: %d).\n"+
				"CH throttles inserts (DelayedInserts) once parts pile up and rejects them at "+
				"`parts_to_throw_insert` (default 3000 per partition). Reduce the part count by "+
				"raising `merge_max_block_size`, batching larger inserts, or running OPTIMIZE on the worst offenders.\n\n"+
				"*Investigate:*\n```\nSELECT database, table, count() AS parts, sum(rows) AS rows\n"+
				"FROM system.parts WHERE active\n"+
				"GROUP BY database, table ORDER BY parts DESC LIMIT 20\n```",
				clusterTotal, c.PartsThresholds.MaxClusterParts),
			fmt.Sprintf("%s:tables:cluster_parts", client.Name()))
	}

	// Group tables exceeding thresholds into a SINGLE alert per severity per instance.
	var criticalTables, warnTables []string
	for key, count := range tableParts {
		fqn := key.db + "." + key.table
		if count >= float64(c.PartsThresholds.CriticalCount) {
			criticalTables = append(criticalTables, fmt.Sprintf("  - %s: %.0f parts", fqn, count))
		} else if count >= float64(c.PartsThresholds.WarnCount) {
			warnTables = append(warnTables, fmt.Sprintf("  - %s: %.0f parts", fqn, count))
		}
	}

	if len(criticalTables) > 0 {
		sort.Strings(criticalTables)
		msg := fmt.Sprintf("*%d tables* exceed critical threshold (%d parts):\n%s\n\n"+
			"*Investigate:*\n```\nSELECT database, table, count() as parts, sum(rows) as rows\n"+
			"FROM system.parts WHERE active\n"+
			"GROUP BY database, table ORDER BY parts DESC LIMIT 20\n```\n"+
			"*Suggestions:*\n"+
			"- Check if merges are keeping up: `SELECT * FROM system.merges`\n"+
			"- Reduce insert frequency or batch larger\n"+
			"- Run `OPTIMIZE TABLE <name> FINAL` for specific tables",
			len(criticalTables), c.PartsThresholds.CriticalCount,
			strings.Join(criticalTables, "\n"))
		result.AddAlert(client.Name(), SeverityCritical, "tables",
			fmt.Sprintf("Too many parts: %d tables critical", len(criticalTables)),
			msg,
			fmt.Sprintf("%s:tables:parts:critical", client.Name()))
	}

	if len(warnTables) > 0 {
		sort.Strings(warnTables)
		msg := fmt.Sprintf("*%d tables* exceed warn threshold (%d parts):\n%s",
			len(warnTables), c.PartsThresholds.WarnCount,
			strings.Join(warnTables, "\n"))
		result.AddAlert(client.Name(), SeverityWarn, "tables",
			fmt.Sprintf("Elevated parts: %d tables", len(warnTables)),
			msg,
			fmt.Sprintf("%s:tables:parts:warn", client.Name()))
	}

	return clusterTotal
}

// collectPartitionPressure flags tables with too many partitions (metadata
// overhead) or any single partition with too many parts (the immediate
// trigger for `parts_to_throw_insert` rejections).
func (c *TableCollector) collectPartitionPressure(ctx context.Context, client *chclient.Client, result *CollectResult) {
	maxPartitions := c.PartsThresholds.MaxPartitionsPerTable
	maxPartsPerPartition := c.PartsThresholds.MaxPartsPerPartition
	if maxPartitions <= 0 && maxPartsPerPartition <= 0 {
		return
	}

	// One scan, two roll-ups: per-table partition count + per-partition part
	// count. Filtering out system DBs keeps the result small enough to inline
	// the worst offenders in the alert message.
	sql := `
		SELECT
			database,
			table,
			partition,
			count() AS parts_in_partition
		FROM system.parts
		WHERE active
		  AND database NOT IN ('system','information_schema','INFORMATION_SCHEMA','ch_analyzer')
		GROUP BY database, table, partition`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query partition pressure", slog.String("error", err.Error()))
		return
	}

	type partKey struct{ db, table string }
	partitionsPerTable := make(map[partKey]int)
	type partitionRow struct {
		fqn        string
		partition  string
		partsCount float64
	}
	var hottestPartitions []partitionRow

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		partition := getString(row, "partition")
		parts := getFloat(row, "parts_in_partition")

		partitionsPerTable[partKey{db, table}]++
		if maxPartsPerPartition > 0 && parts >= float64(maxPartsPerPartition) {
			hottestPartitions = append(hottestPartitions, partitionRow{
				fqn:        db + "." + table,
				partition:  partition,
				partsCount: parts,
			})
		}
	}

	// Per-table partition-count alert.
	if maxPartitions > 0 {
		var offenders []string
		var maxObserved int
		for k, n := range partitionsPerTable {
			result.AddMetric(client.Name(), "tables.partitions.count", float64(n),
				map[string]string{"database": k.db, "table": k.table})
			if n >= maxPartitions {
				offenders = append(offenders, fmt.Sprintf("  - %s.%s: %d partitions", k.db, k.table, n))
			}
			if n > maxObserved {
				maxObserved = n
			}
		}
		result.AddMetric(client.Name(), "tables.partitions.max", float64(maxObserved), nil)
		if len(offenders) > 0 {
			sort.Strings(offenders)
			result.AddAlert(client.Name(), SeverityWarn, "tables",
				fmt.Sprintf("Over-partitioned tables: %d", len(offenders)),
				fmt.Sprintf("Tables with more than *%d active partitions* — every partition costs metadata, slows merges, and inflates `system.parts` scans:\n%s\n\n"+
					"*Investigate:*\n```\nSELECT database, table, count(DISTINCT partition) AS partitions\n"+
					"FROM system.parts WHERE active\n"+
					"GROUP BY database, table HAVING partitions > %d ORDER BY partitions DESC\n```\n"+
					"*Fix:* widen the PARTITION BY expression (e.g. monthly instead of daily) or drop old partitions.",
					maxPartitions, strings.Join(offenders, "\n"), maxPartitions),
				fmt.Sprintf("%s:tables:partitions:over", client.Name()))
		}
	}

	// Hottest single-partition alert (any partition with too many parts).
	if maxPartsPerPartition > 0 && len(hottestPartitions) > 0 {
		sort.Slice(hottestPartitions, func(i, j int) bool {
			return hottestPartitions[i].partsCount > hottestPartitions[j].partsCount
		})
		// Top 10 in the message; metric records the global max for charting.
		var maxObserved float64
		var lines []string
		for i, p := range hottestPartitions {
			if p.partsCount > maxObserved {
				maxObserved = p.partsCount
			}
			if i < 10 {
				lines = append(lines, fmt.Sprintf("  - %s partition `%s`: %.0f parts",
					p.fqn, p.partition, p.partsCount))
			}
		}
		result.AddMetric(client.Name(), "tables.parts.max_in_partition", maxObserved, nil)
		result.AddAlert(client.Name(), SeverityCritical, "tables",
			fmt.Sprintf("Partition near parts_to_throw_insert (%d offenders)", len(hottestPartitions)),
			fmt.Sprintf("These partitions have *≥%d active parts*. CH's `parts_to_throw_insert` (default 3000) will reject inserts to that partition once crossed:\n%s\n\n"+
				"*Investigate:*\n```\nSELECT database, table, partition, count() AS parts, sum(rows) AS rows\n"+
				"FROM system.parts WHERE active\n"+
				"GROUP BY database, table, partition\n"+
				"HAVING parts >= %d ORDER BY parts DESC LIMIT 50\n```\n"+
				"*Fix:* `OPTIMIZE TABLE <db>.<table> PARTITION '<partition>'` to force-merge, or back off insert frequency.",
				maxPartsPerPartition, strings.Join(lines, "\n"), maxPartsPerPartition),
			fmt.Sprintf("%s:tables:max_parts_per_partition", client.Name()))
	}
}

// collectMerges queries system.merges for currently active merge operations.
// clusterParts is the cluster-wide active part count from collectParts; we use
// it to gate the "merges stalled" alert so a quiet cluster (0 merges, 0 parts)
// doesn't false-fire.
func (c *TableCollector) collectMerges(ctx context.Context, client *chclient.Client, result *CollectResult, clusterParts float64) {
	sql := `
		SELECT
			database,
			table,
			elapsed,
			progress,
			num_parts,
			total_size_bytes_compressed,
			is_mutation
		FROM system.merges
		ORDER BY elapsed DESC`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.merges", slog.String("error", err.Error()))
		// Emit the count via a simpler fallback so the metric always appears.
		if cnt, ferr := client.QuerySingleValue(ctx, "SELECT count() FROM system.merges WHERE is_mutation = 0"); ferr == nil {
			if n, perr := strconv.ParseFloat(strings.TrimSpace(cnt), 64); perr == nil {
				result.AddMetric(client.Name(), "tables.merges.active_count", n, nil)
			}
		}
		return
	}

	mergeCount := 0
	for _, row := range rows {
		isMutation := getFloat(row, "is_mutation")
		if isMutation != 0 {
			continue // skip mutations, counted separately
		}
		mergeCount++

		db := getString(row, "database")
		table := getString(row, "table")
		elapsed := getFloat(row, "elapsed")
		progress := getFloat(row, "progress")

		labels := map[string]string{
			"database": db,
			"table":    table,
		}
		result.AddMetric(client.Name(), "tables.merges.elapsed", elapsed, labels)
		result.AddMetric(client.Name(), "tables.merges.progress", progress*100, labels)
	}

	result.AddMetric(client.Name(), "tables.merges.active_count", float64(mergeCount), nil)

	// A high concurrent-merge count is the system healing itself, not a fault —
	// it only matters if it saturates disk I/O, which this collector can't see.
	// So this is a single warn (was critical at 20 / warn at 10), and it must not
	// contradict the merges-stalled alert below, which fires on the opposite
	// condition (near-zero merges with a part backlog).
	if mergeCount >= c.MergesThresholds.MaxActive {
		result.AddAlert(client.Name(), SeverityWarn, "tables",
			"High concurrent merge activity",
			fmt.Sprintf("%d active merges (threshold: %d). Usually benign — merges are the "+
				"system catching up. Worth a look only if disk I/O is saturated.\n\n%s",
				mergeCount, c.MergesThresholds.MaxActive, activeMergesPlaybook),
			fmt.Sprintf("%s:tables:merges:max", client.Name()))
	}

	// Merges-stalled alert: low merge concurrency *while* parts are piling up.
	// Both conditions must hold so a quiet cluster (0 merges, 0 backlog) stays
	// silent. Crossing this is the prelude to TooManyParts — pool is starved
	// (background_pool_size too low, disk saturated, or deadlocked).
	minActive := c.MergesThresholds.MinActiveWhenBacklog
	backlogFloor := c.MergesThresholds.BacklogPartCount
	if minActive > 0 && backlogFloor > 0 &&
		mergeCount < minActive && clusterParts >= float64(backlogFloor) {
		result.AddAlert(client.Name(), SeverityCritical, "tables",
			"Merges stalled while parts pile up",
			fmt.Sprintf("Active merges: *%d* (expected ≥%d) while cluster has *%.0f active parts* (backlog floor: %d).\n"+
				"The merge pool isn't keeping up — inserts will start hitting DelayedInserts → TooManyParts.\n\n"+
				"*Investigate:*\n```\n"+
				"-- Pool occupancy\n"+
				"SELECT metric, value FROM system.metrics\n"+
				"WHERE metric IN ('BackgroundMergesAndMutationsPoolTask',\n"+
				"  'BackgroundFetchesPoolTask','BackgroundCommonPoolTask');\n\n"+
				"-- What's currently merging\n"+
				"SELECT database, table, elapsed, progress, num_parts, total_size_bytes_compressed\n"+
				"FROM system.merges WHERE is_mutation = 0 ORDER BY elapsed DESC;\n\n"+
				"-- Tables hoarding parts\n"+
				"SELECT database, table, count() AS parts\n"+
				"FROM system.parts WHERE active\n"+
				"GROUP BY database, table HAVING parts > 50 ORDER BY parts DESC LIMIT 20\n```\n"+
				"*Fix:* raise `background_pool_size` / `background_merges_mutations_concurrency_ratio`, check disk saturation, or reduce ingest rate.",
				mergeCount, minActive, clusterParts, backlogFloor),
			fmt.Sprintf("%s:tables:merges:stalled", client.Name()))
	}
}

// collectMutations queries system.mutations for stuck mutations.
func (c *TableCollector) collectMutations(ctx context.Context, client *chclient.Client, result *CollectResult) {
	stuckSec := int(c.MutationsThresholds.StuckThreshold.Duration.Seconds())

	sql := fmt.Sprintf(`
		SELECT
			database,
			table,
			mutation_id,
			command,
			create_time,
			parts_to_do,
			is_done,
			latest_fail_reason
		FROM system.mutations
		WHERE is_done = 0
		  AND create_time < now() - INTERVAL %d SECOND
		ORDER BY create_time ASC`, stuckSec)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.mutations", slog.String("error", err.Error()))
		return
	}

	result.AddMetric(client.Name(), "tables.mutations.stuck_count", float64(len(rows)), nil)

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		mutID := getString(row, "mutation_id")
		partsToDo := getFloat(row, "parts_to_do")
		failReason := getString(row, "latest_fail_reason")

		fqn := db + "." + table
		msg := fmt.Sprintf("Stuck mutation %s on %s: parts_to_do=%.0f",
			mutID, fqn, partsToDo)
		if failReason != "" {
			if len(failReason) > 200 {
				failReason = failReason[:200] + "..."
			}
			msg += fmt.Sprintf(", fail_reason=%s", failReason)
		}
		msg += "\n\n" + stuckMutationsPlaybook

		sev := SeverityWarn
		if failReason != "" {
			sev = SeverityCritical
		}
		result.AddAlert(client.Name(), sev, "tables",
			"Stuck mutation detected",
			msg,
			fmt.Sprintf("%s:tables:mutation:%s:%s", client.Name(), fqn, mutID))
	}
}

// collectDiskBalance detects JBOD disk imbalance by comparing data
// distribution across local disks from system.parts.
func (c *TableCollector) collectDiskBalance(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			disk_name,
			sum(bytes_on_disk) AS total_bytes,
			count() AS part_count
		FROM system.parts
		WHERE active
		GROUP BY disk_name
		ORDER BY disk_name`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query disk balance", slog.String("error", err.Error()))
		return
	}

	if len(rows) < 2 {
		return // no JBOD to balance
	}

	var totalBytes float64
	diskBytes := make(map[string]float64)
	for _, row := range rows {
		disk := getString(row, "disk_name")
		bytes := getFloat(row, "total_bytes")
		diskBytes[disk] = bytes
		totalBytes += bytes

		result.AddMetric(client.Name(), "tables.disk_balance.bytes", bytes, map[string]string{
			"disk": disk,
		})
	}

	if totalBytes == 0 || len(diskBytes) < 2 {
		return
	}

	// Calculate standard deviation of disk utilization percentages.
	mean := totalBytes / float64(len(diskBytes))
	var variance float64
	for _, b := range diskBytes {
		diff := b - mean
		variance += diff * diff
	}
	variance /= float64(len(diskBytes))
	stddev := math.Sqrt(variance)
	coeffOfVar := (stddev / mean) * 100 // coefficient of variation as percent

	result.AddMetric(client.Name(), "tables.disk_balance.coeff_variation", coeffOfVar, nil)

	// Metric only — no alert. This groups by disk_name across ALL disks, which on
	// a tiered storage policy mixes hot (NVMe) and cold (HDD/S3) tiers that are
	// imbalanced *by design*, so the alert fired permanently on every tiered
	// deployment. Real JBOD imbalance is only meaningful among disks that are
	// peers within one volume, which requires storage-policy topology that isn't
	// reliably queryable across versions. The coefficient-of-variation metric is
	// still emitted for anyone who wants to alert on it with knowledge of their
	// own storage policy.
	_ = stddev
}

func (c *TableCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}
