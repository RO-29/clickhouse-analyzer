package collector

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
)

// StorageCollector monitors disk capacity, S3 storage, and data tiering from
// system.disks, system.parts, and system.query_log.
type StorageCollector struct {
	DiskThresholds config.DiskThresholds
	S3Thresholds   config.S3Thresholds
	Logger         *slog.Logger
}

func (c *StorageCollector) Name() string { return "storage" }

func (c *StorageCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	c.collectDisks(ctx, client, result)
	c.collectDiskDistribution(ctx, client, result)
	c.collectS3Latency(ctx, client, result)
	c.collectTierMovement(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

// collectDisks queries system.disks for free/total space and identifies disk
// types (local vs S3/ObjectStorage).
func (c *StorageCollector) collectDisks(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			name,
			path,
			free_space,
			total_space,
			type,
			keep_free_space
		FROM system.disks`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.disks", slog.String("error", err.Error()))
		return
	}

	for _, row := range rows {
		name := getString(row, "name")
		path := getString(row, "path")
		freeSpace := getFloat(row, "free_space")
		totalSpace := getFloat(row, "total_space")
		diskType := getString(row, "type")

		labels := map[string]string{
			"disk": name,
			"path": path,
			"type": diskType,
		}

		result.AddMetric(client.Name(), "storage.disk.free_space", freeSpace, labels)
		result.AddMetric(client.Name(), "storage.disk.total_space", totalSpace, labels)

		// S3 / ObjectStorage disks report 0 total_space; skip capacity checks.
		if totalSpace <= 0 {
			result.AddMetric(client.Name(), "storage.disk.is_object_storage", 1, labels)
			continue
		}

		usedPct := ((totalSpace - freeSpace) / totalSpace) * 100.0
		result.AddMetric(client.Name(), "storage.disk.used_percent", usedPct, labels)

		if usedPct >= c.DiskThresholds.CriticalPercent {
			result.AddAlert(client.Name(), SeverityCritical, "storage",
				"Disk nearly full (critical)",
				fmt.Sprintf("Disk %s (%s) at %.1f%% capacity (free: %s / total: %s)",
					name, path, usedPct, humanBytes(freeSpace), humanBytes(totalSpace)),
				fmt.Sprintf("%s:storage:disk_full:%s", client.Name(), name))
		} else if usedPct >= c.DiskThresholds.WarnPercent {
			result.AddAlert(client.Name(), SeverityWarn, "storage",
				"Disk approaching capacity",
				fmt.Sprintf("Disk %s (%s) at %.1f%% capacity (free: %s / total: %s)",
					name, path, usedPct, humanBytes(freeSpace), humanBytes(totalSpace)),
				fmt.Sprintf("%s:storage:disk_full:%s", client.Name(), name))
		}

		// Detect broken disks: free_space == 0 and total_space > 0 is suspicious.
		if freeSpace == 0 && totalSpace > 0 {
			result.AddAlert(client.Name(), SeverityCritical, "storage",
				"Disk may be broken or full",
				fmt.Sprintf("Disk %s (%s) reports 0 free bytes with total %s",
					name, path, humanBytes(totalSpace)),
				fmt.Sprintf("%s:storage:disk_broken:%s", client.Name(), name))
		}
	}
}

// collectDiskDistribution shows how data is distributed across disks from
// system.parts grouped by disk_name.
func (c *StorageCollector) collectDiskDistribution(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			disk_name,
			count() AS part_count,
			sum(rows) AS total_rows,
			sum(bytes_on_disk) AS total_bytes
		FROM system.parts
		WHERE active
		GROUP BY disk_name
		ORDER BY total_bytes DESC`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query disk distribution", slog.String("error", err.Error()))
		return
	}

	for _, row := range rows {
		disk := getString(row, "disk_name")
		partCount := getFloat(row, "part_count")
		totalRows := getFloat(row, "total_rows")
		totalBytes := getFloat(row, "total_bytes")

		labels := map[string]string{"disk": disk}
		result.AddMetric(client.Name(), "storage.distribution.part_count", partCount, labels)
		result.AddMetric(client.Name(), "storage.distribution.rows", totalRows, labels)
		result.AddMetric(client.Name(), "storage.distribution.bytes", totalBytes, labels)
	}
}

// collectS3Latency estimates S3 read latency by looking at recent queries that
// read from object-storage disks and comparing elapsed time per rows read.
func (c *StorageCollector) collectS3Latency(ctx context.Context, client *chclient.Client, result *CollectResult) {
	// Query recent finished SELECTs that touched remote (S3) storage.
	// ProfileEvents contains counters like ReadBufferFromS3Microseconds.
	sql := `
		SELECT
			query_id,
			query_duration_ms,
			read_rows,
			read_bytes,
			ProfileEvents['S3ReadMicroseconds'] AS s3_read_us,
			ProfileEvents['S3ReadRequestsCount'] AS s3_read_requests
		FROM system.query_log
		WHERE type = 'QueryFinish'
		  AND event_time >= now() - INTERVAL 5 MINUTE
		  AND ProfileEvents['S3ReadRequestsCount'] > 0
		ORDER BY s3_read_us DESC
		LIMIT 20`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query S3 latency from query_log", slog.String("error", err.Error()))
		return
	}

	// Aggregate S3 latency across all recent queries into a single metric.
	var totalS3Us, totalS3Requests, maxLatencyMs float64
	for _, row := range rows {
		s3ReadUs := getFloat(row, "s3_read_us")
		s3Requests := getFloat(row, "s3_read_requests")
		totalS3Us += s3ReadUs
		totalS3Requests += s3Requests
		if s3Requests > 0 {
			latMs := (s3ReadUs / 1000.0) / s3Requests
			if latMs > maxLatencyMs {
				maxLatencyMs = latMs
			}
		}
	}

	result.AddMetric(client.Name(), "storage.s3.total_requests", totalS3Requests, nil)
	result.AddMetric(client.Name(), "storage.s3.concurrent_reads", float64(len(rows)), nil)

	if totalS3Requests > 0 {
		avgLatencyMs := (totalS3Us / 1000.0) / totalS3Requests
		result.AddMetric(client.Name(), "storage.s3.avg_latency_ms", avgLatencyMs, nil)
		result.AddMetric(client.Name(), "storage.s3.max_latency_ms", maxLatencyMs, nil)

		warnMs := float64(c.S3Thresholds.LatencyWarn.Duration.Milliseconds())
		critMs := float64(c.S3Thresholds.LatencyCritical.Duration.Milliseconds())

		if avgLatencyMs >= critMs {
			result.AddAlert(client.Name(), SeverityCritical, "storage",
				"S3 latency critically high",
				fmt.Sprintf("Avg S3 request latency %.0fms across %.0f requests (max: %.0fms). Threshold: %.0fms.",
					avgLatencyMs, totalS3Requests, maxLatencyMs, critMs),
				fmt.Sprintf("%s:storage:s3_latency", client.Name()))
		} else if avgLatencyMs >= warnMs {
			result.AddAlert(client.Name(), SeverityWarn, "storage",
				"S3 latency elevated",
				fmt.Sprintf("Avg S3 request latency %.0fms across %.0f requests (max: %.0fms). Threshold: %.0fms.",
					avgLatencyMs, totalS3Requests, maxLatencyMs, warnMs),
				fmt.Sprintf("%s:storage:s3_latency", client.Name()))
		}
	}
}

// collectTierMovement tracks data movement between storage tiers by detecting
// parts that have recently appeared on different disks. This uses the
// system.part_log if available.
func (c *StorageCollector) collectTierMovement(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			database,
			table,
			part_name,
			disk_name,
			event_type,
			event_time
		FROM system.part_log
		WHERE event_type = 'MovePart'
		  AND event_time >= now() - INTERVAL 10 MINUTE
		ORDER BY event_time DESC
		LIMIT 100`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		// part_log may not be enabled; this is not an error.
		c.logger().Debug("failed to query system.part_log for tier movement (may be disabled)",
			slog.String("error", err.Error()))
		return
	}

	result.AddMetric(client.Name(), "storage.tier_moves.count_10m", float64(len(rows)), nil)

	if len(rows) > 50 {
		result.AddAlert(client.Name(), SeverityInfo, "storage",
			"High tier movement activity",
			fmt.Sprintf("%d part moves in last 10 minutes", len(rows)),
			fmt.Sprintf("%s:storage:tier_moves", client.Name()))
	}

	// Emit per-table move counts.
	tableMoves := make(map[string]int)
	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		fqn := db + "." + table
		tableMoves[fqn]++
	}
	for fqn, cnt := range tableMoves {
		result.AddMetric(client.Name(), "storage.tier_moves.table_count", float64(cnt), map[string]string{
			"table": fqn,
		})
	}
}

func (c *StorageCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}
