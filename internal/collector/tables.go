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

	c.collectParts(ctx, client, result)
	c.collectMerges(ctx, client, result)
	c.collectMutations(ctx, client, result)
	c.collectDiskBalance(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

// collectParts queries system.parts for per-table part counts and sizes.
func (c *TableCollector) collectParts(ctx context.Context, client *chclient.Client, result *CollectResult) {
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
		return
	}

	// Aggregate parts across disks per table for threshold checks.
	type tableKey struct{ db, table string }
	tableParts := make(map[tableKey]float64)

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
}

// collectMerges queries system.merges for currently active merge operations.
func (c *TableCollector) collectMerges(ctx context.Context, client *chclient.Client, result *CollectResult) {
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

	if mergeCount >= c.MergesThresholds.MaxActive {
		result.AddAlert(client.Name(), SeverityCritical, "tables",
			"Too many concurrent merges (critical)",
			fmt.Sprintf("%d active merges (max: %d). This can saturate disk I/O.\n\n%s",
				mergeCount, c.MergesThresholds.MaxActive, activeMergesPlaybook),
			fmt.Sprintf("%s:tables:merges:max", client.Name()))
	} else if mergeCount >= c.MergesThresholds.WarnActive {
		result.AddAlert(client.Name(), SeverityWarn, "tables",
			"Elevated merge count",
			fmt.Sprintf("%d active merges (warn: %d)\n\n%s",
				mergeCount, c.MergesThresholds.WarnActive, activeMergesPlaybook),
			fmt.Sprintf("%s:tables:merges:warn", client.Name()))
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

	// Flag significant imbalance (>30% coefficient of variation).
	if coeffOfVar > 30 {
		result.AddAlert(client.Name(), SeverityWarn, "tables",
			"JBOD disk imbalance detected",
			fmt.Sprintf("Data distribution across %d disks has %.1f%% coefficient of variation (mean: %s, stddev: %s)\n\n%s",
				len(diskBytes), coeffOfVar, humanBytes(mean), humanBytes(stddev), disksBalancePlaybook),
			fmt.Sprintf("%s:tables:disk_imbalance", client.Name()))
	}
}

func (c *TableCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}
