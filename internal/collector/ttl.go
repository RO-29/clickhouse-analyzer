package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// TTLCollector detects stuck TTL mutations and tables where TTL processing has
// fallen behind. ClickHouse processes TTL lazily — if mutations pile up or no
// merge occurs, expired data lingers on disk longer than expected.
type TTLCollector struct {
	Logger *slog.Logger

	warnedMu sync.Mutex
	warned   map[string]bool // instances already warned about stale-TTL check failure
}

func (c *TTLCollector) Name() string { return "ttl" }

func (c *TTLCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *TTLCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	// --- Stuck TTL / MODIFY mutations ---
	mutSQL := `
		SELECT database, table,
			count() AS pending,
			min(create_time) AS oldest_create
		FROM system.mutations
		WHERE NOT is_done
		  AND (command LIKE '%TTL%' OR command LIKE '%MODIFY%')
		  AND create_time < now() - INTERVAL 1 HOUR
		GROUP BY database, table
		ORDER BY oldest_create ASC
		LIMIT 20`

	mutRows, err := client.Query(ctx, mutSQL)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
			result.Duration = time.Since(start)
			return result, nil
		}
		c.logger().Warn("ttl: failed to query system.mutations", slog.String("error", err.Error()))
	}

	for _, row := range mutRows {
		db := getString(row, "database")
		tbl := getString(row, "table")
		pending := getFloat(row, "pending")
		oldestStr := getString(row, "oldest_create")

		var stuckHours float64
		if t, parseErr := time.Parse("2006-01-02 15:04:05", oldestStr); parseErr == nil {
			stuckHours = time.Since(t).Hours()
		}

		dedupKey := fmt.Sprintf("%s:ttl:stuck_mutation:%s.%s", client.Name(), db, tbl)
		result.AddMetric(client.Name(), "ttl.stuck_mutations", pending,
			map[string]string{"database": db, "table": tbl})

		if stuckHours > 8 {
			result.AddAlert(client.Name(), SeverityCritical, "tables",
				fmt.Sprintf("TTL mutation stuck >%.0fh on %s.%s", stuckHours, db, tbl),
				fmt.Sprintf("Table `%s.%s` has %.0f stuck TTL/MODIFY mutation(s) not completed in %.1f hours. "+
					"Expired data is not being purged; disk usage will grow.\n\n"+
					"*Investigate:*\n```\nSELECT * FROM system.mutations\nWHERE database='%s' AND table='%s' AND NOT is_done\n```",
					db, tbl, pending, stuckHours, db, tbl),
				dedupKey)
		} else if stuckHours > 2 {
			result.AddAlert(client.Name(), SeverityWarn, "tables",
				fmt.Sprintf("TTL mutation delayed %.0fh on %s.%s", stuckHours, db, tbl),
				fmt.Sprintf("Table `%s.%s` has %.0f pending TTL/MODIFY mutation(s) running for %.1f hours. "+
					"Monitor — stuck mutations prevent TTL expiry.\n\n"+
					"*Investigate:*\n```\nSELECT * FROM system.mutations\nWHERE database='%s' AND table='%s' AND NOT is_done\n```",
					db, tbl, pending, stuckHours, db, tbl),
				dedupKey)
		}
	}

	// --- Tables with TTL configured but suspiciously old parts ---
	// Indicates TTL cleanup has not fired in a long time.
	ttlTableSQL := `
		SELECT t.database, t.name AS table,
			count(p.name) AS part_count,
			max(dateDiff('day', p.modification_time, now())) AS oldest_part_days
		FROM system.tables t
		JOIN system.parts p ON t.database = p.database AND t.name = p.table
		WHERE t.create_table_query LIKE '%TTL%'
		  AND p.active = 1
		  AND t.database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
		GROUP BY t.database, t.name
		HAVING part_count > 5 AND oldest_part_days > 14
		ORDER BY oldest_part_days DESC
		LIMIT 10`

	ttlRows, err2 := client.Query(ctx, ttlTableSQL)
	if err2 != nil {
		// Log a warning once per instance per process lifetime so operators are
		// aware without spamming logs on every poll cycle.
		c.warnedMu.Lock()
		if c.warned == nil {
			c.warned = make(map[string]bool)
		}
		alreadyWarned := c.warned[client.Name()]
		if !alreadyWarned {
			c.warned[client.Name()] = true
		}
		c.warnedMu.Unlock()
		if !alreadyWarned {
			c.logger().Warn("ttl: stale-TTL check failed",
				slog.String("instance", client.Name()),
				slog.String("error", err2.Error()))
		}
		result.Duration = time.Since(start)
		return result, nil
	}

	for _, row := range ttlRows {
		db := getString(row, "database")
		tbl := getString(row, "table")
		partCount := getFloat(row, "part_count")
		oldestDays := getFloat(row, "oldest_part_days")

		dedupKey := fmt.Sprintf("%s:ttl:stale_ttl_table:%s.%s", client.Name(), db, tbl)
		result.AddMetric(client.Name(), "ttl.stale_table_days", oldestDays,
			map[string]string{"database": db, "table": tbl})

		if oldestDays > 30 {
			result.AddAlert(client.Name(), SeverityWarn, "tables",
				fmt.Sprintf("TTL may not be running on %s.%s (oldest part %.0fd)", db, tbl, oldestDays),
				fmt.Sprintf("Table `%s.%s` has TTL configured but %.0f active parts — oldest is %.0f days old. "+
					"Expected TTL to have expired some by now.\n\n"+
					"*Check:*\n```\nSELECT ttl_expression FROM system.tables\nWHERE database='%s' AND name='%s'\n\n"+
					"SELECT count(), min(modification_time), max(modification_time)\nFROM system.parts\n"+
					"WHERE database='%s' AND table='%s' AND active=1\n```",
					db, tbl, partCount, oldestDays, db, tbl, db, tbl),
				dedupKey)
		}
	}

	result.Duration = time.Since(start)
	return result, nil
}
