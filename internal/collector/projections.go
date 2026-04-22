package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// ProjectionCollector monitors system.projections for unbuilt or broken
// projections across user tables.
type ProjectionCollector struct {
	Logger *slog.Logger
}

func (c *ProjectionCollector) Name() string { return "projections" }

func (c *ProjectionCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *ProjectionCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	c.collectProjectionsList(ctx, client, result)
	c.collectMissingProjectionParts(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

// collectProjectionsList fetches the list of defined projections.
func (c *ProjectionCollector) collectProjectionsList(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT database, table, name
		FROM system.projections
		WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
		LIMIT 100`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") ||
			strings.Contains(err.Error(), "UNKNOWN_IDENTIFIER") {
			return
		}
		c.logger().Warn("failed to query system.projections", slog.String("error", err.Error()))
		return
	}

	result.AddMetric(client.Name(), "tables.projections.total", float64(len(rows)), nil)
}

// collectMissingProjectionParts checks for parts that are missing their
// projection data — i.e., the projection was added after data was ingested.
func (c *ProjectionCollector) collectMissingProjectionParts(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT p.database, p.table, proj.name AS projection_name,
			countIf(NOT has(p.projections, proj.name)) AS missing_parts,
			count() AS total_parts
		FROM system.parts p
		CROSS JOIN (
			SELECT DISTINCT database, table, name FROM system.projections
			WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
		) proj
		WHERE p.database = proj.database AND p.table = proj.table
		  AND p.active = 1
		GROUP BY p.database, p.table, proj.name
		HAVING missing_parts > 0`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
			return
		}
		c.logger().Warn("failed to query missing projection parts", slog.String("error", err.Error()))
		return
	}

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		projName := getString(row, "projection_name")
		missingParts := getFloat(row, "missing_parts")
		totalParts := getFloat(row, "total_parts")

		labels := map[string]string{
			"database":   db,
			"table":      table,
			"projection": projName,
		}
		result.AddMetric(client.Name(), "tables.projections.missing_parts", missingParts, labels)

		result.AddAlert(client.Name(), SeverityWarn, "tables",
			fmt.Sprintf("Projection %s on %s.%s: %.0f parts missing projection data", projName, db, table, missingParts),
			fmt.Sprintf("Projection `%s` on `%s.%s` has %.0f / %.0f active parts missing projection data. "+
				"Queries using this projection may fall back to full table scans.\n\n"+
				"*Investigate:*\n```\n-- Which active parts are missing the projection\n"+
				"SELECT name, rows, formatReadableSize(bytes_on_disk) AS size,\n"+
				"  modification_time\n"+
				"FROM system.parts\n"+
				"WHERE database = '%s' AND table = '%s' AND active\n"+
				"  AND name NOT IN (\n"+
				"    SELECT name FROM system.projection_parts\n"+
				"    WHERE database = '%s' AND table = '%s' AND projection_name = '%s'\n"+
				"      AND active\n"+
				"  )\n"+
				"ORDER BY modification_time DESC\n```\n"+
				"*Fix (rebuilds projection data for all parts):*\n```\nALTER TABLE %s.%s MATERIALIZE PROJECTION %s\n```",
				projName, db, table, missingParts, totalParts,
				db, table, db, table, projName,
				db, table, projName),
			fmt.Sprintf("%s:projections:%s.%s:%s", client.Name(), db, table, projName))
	}
}
