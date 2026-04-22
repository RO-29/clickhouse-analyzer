package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// FreshnessCollector detects tables that stopped receiving inserts unexpectedly.
// It finds tables that received inserts in the last 24h but have had NO new
// inserts in the last 20 minutes — tables that should be getting data but stopped.
type FreshnessCollector struct {
	Logger *slog.Logger
}

func (c *FreshnessCollector) Name() string { return "freshness" }

func (c *FreshnessCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

// queryFreshness runs the freshness query. modern=true uses databases[1]/tables[1] (CH 22+);
// modern=false falls back to the scalar database/table columns (pre-22).
func (c *FreshnessCollector) queryFreshness(ctx context.Context, client *chclient.Client, modern bool) ([]map[string]interface{}, error) {
	var sql string
	if modern {
		sql = `
			SELECT databases[1] AS database, tables[1] AS table,
				max(event_time) AS last_insert,
				count() AS inserts_24h
			FROM system.query_log
			WHERE type = 'QueryFinish'
			  AND query_kind = 'Insert'
			  AND event_time > now() - INTERVAL 24 HOUR
			  AND length(databases) > 0
			  AND databases[1] NOT IN ('system','information_schema','INFORMATION_SCHEMA')
			GROUP BY databases[1], tables[1]
			HAVING inserts_24h > 5
			   AND last_insert < now() - INTERVAL 20 MINUTE
			ORDER BY last_insert ASC
			LIMIT 20`
	} else {
		sql = `
			SELECT database, table,
				max(event_time) AS last_insert,
				countIf(event_time > now() - INTERVAL 24 HOUR) AS inserts_24h
			FROM system.query_log
			WHERE type = 'QueryFinish'
			  AND query_kind = 'Insert'
			  AND event_time > now() - INTERVAL 24 HOUR
			  AND database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
			GROUP BY database, table
			HAVING inserts_24h > 5
			   AND last_insert < now() - INTERVAL 20 MINUTE
			ORDER BY last_insert ASC
			LIMIT 20`
	}
	return client.Query(ctx, sql)
}

func (c *FreshnessCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	// CH 22+ uses databases[]/tables[] arrays. Older builds have scalar database/table columns.
	// Try modern schema first.
	rows, err := c.queryFreshness(ctx, client, true)
	if err != nil {
		rows, err = c.queryFreshness(ctx, client, false)
		if err != nil {
			if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
				result.Duration = time.Since(start)
				return result, nil
			}
			c.logger().Warn("failed to query insert freshness", slog.String("error", err.Error()))
			result.Duration = time.Since(start)
			return result, nil
		}
	}

	if len(rows) == 0 {
		result.Duration = time.Since(start)
		return result, nil
	}

	type staleTable struct {
		db          string
		table       string
		minutesAgo  float64
		inserts24h  float64
		lastInsert  string
	}

	var staleTables []staleTable
	now := time.Now()

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		inserts24h := getFloat(row, "inserts_24h")
		lastInsertStr := getString(row, "last_insert")

		// Parse last_insert time to compute minutes since last insert.
		// ClickHouse returns DateTime as "2006-01-02 15:04:05".
		var minutesAgo float64
		if t, parseErr := time.Parse("2006-01-02 15:04:05", lastInsertStr); parseErr == nil {
			minutesAgo = now.Sub(t).Minutes()
		} else {
			minutesAgo = 20 // safe fallback: threshold is 20 min
		}

		labels := map[string]string{
			"database": db,
			"table":    table,
		}
		result.AddMetric(client.Name(), "tables.freshness.minutes_since_insert", minutesAgo, labels)

		staleTables = append(staleTables, staleTable{
			db:         db,
			table:      table,
			minutesAgo: minutesAgo,
			inserts24h: inserts24h,
			lastInsert: lastInsertStr,
		})
	}

	// If more than 3 tables are stale, emit a single summary alert.
	if len(staleTables) > 3 {
		var lines []string
		for _, st := range staleTables {
			lines = append(lines, fmt.Sprintf("  - %s.%s — no inserts for %.0f min (%.0f inserts in last 24h)",
				st.db, st.table, st.minutesAgo, st.inserts24h))
		}
		// Playbook mirrors the collector's modern-schema query (array-form
		// databases[]/tables[], type=QueryFinish, 24h window, HAVING gap>20m)
		// so counts tie out with what the alert flagged.
		msg := fmt.Sprintf("*%d tables* have stopped receiving inserts (last 20+ min gap, active in last 24h):\n%s\n\n"+
			"*Investigate:*\n```\nSELECT databases[1] AS database, tables[1] AS table,\n"+
			"  max(event_time) AS last_insert,\n"+
			"  count() AS inserts_24h\n"+
			"FROM system.query_log\n"+
			"WHERE type = 'QueryFinish'\n"+
			"  AND query_kind = 'Insert'\n"+
			"  AND event_time > now() - INTERVAL 24 HOUR\n"+
			"  AND length(databases) > 0\n"+
			"  AND databases[1] NOT IN ('system','information_schema','INFORMATION_SCHEMA')\n"+
			"GROUP BY database, table\n"+
			"HAVING inserts_24h > 5\n"+
			"   AND last_insert < now() - INTERVAL 20 MINUTE\n"+
			"ORDER BY last_insert ASC\n```",
			len(staleTables), strings.Join(lines, "\n"))
		result.AddAlert(client.Name(), SeverityWarn, "tables",
			fmt.Sprintf("Insert gap detected: %d tables stale", len(staleTables)),
			msg,
			fmt.Sprintf("%s:freshness:multiple_tables_stale", client.Name()))
	} else {
		// Individual alert per stale table. Playbook mirrors the alert's
		// query (array-form databases[]/tables[], type=QueryFinish, 24h window)
		// and additionally shows the per-hour distribution so operators can
		// see WHEN the inserts stopped rather than just that they stopped.
		for _, st := range staleTables {
			investigateSQL := fmt.Sprintf(
				"-- Confirm last insert time\n"+
					"SELECT max(event_time) AS last_insert\n"+
					"FROM system.query_log\n"+
					"WHERE type = 'QueryFinish'\n"+
					"  AND query_kind = 'Insert'\n"+
					"  AND databases[1] = '%s'\n"+
					"  AND tables[1] = '%s'\n"+
					"  AND event_time > now() - INTERVAL 24 HOUR;\n\n"+
					"-- Hourly insert distribution — shows when the pipeline went quiet\n"+
					"SELECT toStartOfHour(event_time) AS hour,\n"+
					"  count() AS inserts,\n"+
					"  sum(written_rows) AS rows\n"+
					"FROM system.query_log\n"+
					"WHERE type = 'QueryFinish'\n"+
					"  AND query_kind = 'Insert'\n"+
					"  AND databases[1] = '%s'\n"+
					"  AND tables[1] = '%s'\n"+
					"  AND event_time > now() - INTERVAL 24 HOUR\n"+
					"GROUP BY hour ORDER BY hour",
				st.db, st.table, st.db, st.table)
			msg := fmt.Sprintf("Insert gap detected: %s.%s — no inserts for %.0f minutes (had %.0f in last 24h).\n\n"+
				"*Investigate:*\n```\n%s\n```",
				st.db, st.table, st.minutesAgo, st.inserts24h, investigateSQL)
			result.AddAlert(client.Name(), SeverityWarn, "tables",
				fmt.Sprintf("Insert gap detected: %s.%s — no inserts for %.0f minutes (had %.0f in last 24h)",
					st.db, st.table, st.minutesAgo, st.inserts24h),
				msg,
				fmt.Sprintf("%s:freshness:%s.%s", client.Name(), st.db, st.table))
		}
	}

	result.Duration = time.Since(start)
	return result, nil
}
