package collector

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// PartsAgeCollector surfaces the age of the oldest active part per table as a
// metric for the Explore → Parts Age tab.
//
// It intentionally emits NO alerts. Old active parts are the normal end-state of
// a merged partition: ClickHouse never merges across partitions and stops merging
// a part once it reaches the max merge size, so a large, healthy, historically-
// partitioned table always has parts whose modification_time is days or months
// old. Treating that age as "merge pressure" fired critical on essentially every
// mature table. The real merge-backlog signal — parts accumulating while merges
// are not running — is detected by TableCollector (too-many-parts + merges-stalled)
// against per-table part counts, not part age.
type PartsAgeCollector struct {
	Logger *slog.Logger
}

func (c *PartsAgeCollector) Name() string { return "parts_age" }

func (c *PartsAgeCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *PartsAgeCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	sql := `
		SELECT
			database,
			table,
			count() AS part_count,
			max(toUnixTimestamp(now()) - toUnixTimestamp(modification_time)) / 3600 AS oldest_part_hours,
			sum(rows) AS total_rows,
			sum(bytes_on_disk) AS total_bytes
		FROM system.parts
		WHERE active = 1
		  AND database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
		GROUP BY database, table
		HAVING part_count > 5 AND oldest_part_hours > 48
		ORDER BY oldest_part_hours DESC
		LIMIT 20`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
			result.Duration = time.Since(start)
			return result, nil
		}
		c.logger().Warn("parts_age: failed to query system.parts", slog.String("error", err.Error()))
		result.Duration = time.Since(start)
		return result, nil
	}

	for _, row := range rows {
		db := getString(row, "database")
		tbl := getString(row, "table")
		oldestHours := getFloat(row, "oldest_part_hours")

		labels := map[string]string{"database": db, "table": tbl}
		result.AddMetric(client.Name(), "parts.oldest_hours", oldestHours, labels)
	}

	result.Duration = time.Since(start)
	return result, nil
}
