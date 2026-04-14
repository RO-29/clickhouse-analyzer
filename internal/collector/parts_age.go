package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// PartsAgeCollector detects tables where active parts have not been merged for an
// unusually long time. Unlike TableCollector (which checks part count), this focuses
// on part age — old unmerged parts indicate merge pressure even when total count
// looks acceptable. Also surfaces as data in the Explore → Parts Age tab.
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
		partCount := getFloat(row, "part_count")
		oldestHours := getFloat(row, "oldest_part_hours")
		totalBytes := getFloat(row, "total_bytes")

		labels := map[string]string{"database": db, "table": tbl}
		result.AddMetric(client.Name(), "parts.oldest_hours", oldestHours, labels)

		dedupKey := fmt.Sprintf("%s:parts_age:cold_parts:%s.%s", client.Name(), db, tbl)
		sizeMB := totalBytes / 1024 / 1024

		if oldestHours > 168 && partCount > 20 { // >7 days + >20 parts
			result.AddAlert(client.Name(), SeverityCritical, "tables",
				fmt.Sprintf("Cold parts on %s.%s: %.0f parts, oldest %.0fd",
					db, tbl, partCount, oldestHours/24),
				fmt.Sprintf("Table `%s.%s` has %.0f active parts; oldest unmerged for %.0f hours (%.0f days). "+
					"Total: %.0f MB. Parts this old indicate merges are disabled or severely behind.\n\n"+
					"*Investigate:*\n```\n-- Running merges\nSELECT count(), max(elapsed) FROM system.merges\nWHERE database='%s' AND table='%s'\n\n"+
					"-- Part age distribution\nSELECT min(modification_time), max(modification_time), count()\nFROM system.parts\n"+
					"WHERE database='%s' AND table='%s' AND active=1\n```",
					db, tbl, partCount, oldestHours, oldestHours/24, sizeMB, db, tbl, db, tbl),
				dedupKey)
		} else if oldestHours > 72 && partCount > 10 { // >3 days + >10 parts
			result.AddAlert(client.Name(), SeverityWarn, "tables",
				fmt.Sprintf("Stale parts on %s.%s: %.0f parts, oldest %.0fd",
					db, tbl, partCount, oldestHours/24),
				fmt.Sprintf("Table `%s.%s` has %.0f active parts with the oldest not merged for %.0f hours. "+
					"%.0f MB. Normal merge should reduce this — monitor for continued growth.\n\n"+
					"*Check:*\n```\nSELECT min(modification_time), max(modification_time), count()\nFROM system.parts\n"+
					"WHERE database='%s' AND table='%s' AND active=1\n```",
					db, tbl, partCount, oldestHours, sizeMB, db, tbl),
				dedupKey)
		}
	}

	result.Duration = time.Since(start)
	return result, nil
}
