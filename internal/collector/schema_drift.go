package collector

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// SchemaDriftCollector detects schema changes (columns added, dropped, or type
// changed) between polls by maintaining an in-memory fingerprint map.
type SchemaDriftCollector struct {
	Logger      *slog.Logger
	mu          sync.Mutex
	lastColumns map[string][]string // "db.table" -> sorted column list ("name:type")
	initialized bool
}

func (c *SchemaDriftCollector) Name() string { return "schema_drift" }

func (c *SchemaDriftCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *SchemaDriftCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	sql := `
		SELECT database, table,
			groupArray(name || ':' || type) AS columns
		FROM system.columns
		WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
		GROUP BY database, table
		ORDER BY database, table`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
			result.Duration = time.Since(start)
			return result, nil
		}
		c.logger().Warn("failed to query system.columns for schema drift", slog.String("error", err.Error()))
		result.Duration = time.Since(start)
		return result, nil
	}

	// Build current snapshot.
	current := make(map[string][]string, len(rows))
	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		key := db + "." + table

		// columns is a ClickHouse Array returned as []interface{}.
		rawCols := row["columns"]
		var cols []string
		switch v := rawCols.(type) {
		case []interface{}:
			for _, item := range v {
				cols = append(cols, toString(item))
			}
		case string:
			// Fallback: comma-separated string representation.
			cols = strings.Split(strings.Trim(v, "[]"), ",")
		}
		sort.Strings(cols)
		current[key] = cols
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// First poll: just store fingerprints, emit no alerts.
	if !c.initialized {
		c.lastColumns = current
		c.initialized = true
		result.AddMetric(client.Name(), "tables.schema_changes_detected", 0, nil)
		result.Duration = time.Since(start)
		return result, nil
	}

	// Compare current snapshot against previous.
	changesDetected := 0
	for key, curCols := range current {
		prevCols, existed := c.lastColumns[key]
		if !existed {
			// New table — not a schema change on an existing table, skip.
			continue
		}

		curHash := hashColumns(curCols)
		prevHash := hashColumns(prevCols)
		if curHash == prevHash {
			continue
		}

		// Schema changed — compute a human-readable diff.
		changesDetected++
		added, removed := diffColumns(prevCols, curCols)

		var diffParts []string
		if len(added) > 0 {
			diffParts = append(diffParts, fmt.Sprintf("added: %s", strings.Join(added, ", ")))
		}
		if len(removed) > 0 {
			diffParts = append(diffParts, fmt.Sprintf("removed: %s", strings.Join(removed, ", ")))
		}
		if len(diffParts) == 0 {
			diffParts = []string{"column type changed"}
		}

		parts := strings.SplitN(key, ".", 2)
		db, table := parts[0], parts[1]
		_ = db
		_ = table

		result.AddAlert(client.Name(), SeverityWarn, "tables",
			fmt.Sprintf("Schema changed: %s — columns modified since last check", key),
			fmt.Sprintf("Schema changed: `%s` — %s.\n\n"+
				"*Investigate:*\n```\nSELECT name, type FROM system.columns\n"+
				"WHERE database = '%s' AND table = '%s'\nORDER BY position\n```",
				key, strings.Join(diffParts, "; "), parts[0], parts[1]),
			fmt.Sprintf("%s:schema_drift:%s", client.Name(), key))
	}

	result.AddMetric(client.Name(), "tables.schema_changes_detected", float64(changesDetected), nil)

	// Update the stored snapshot.
	c.lastColumns = current

	result.Duration = time.Since(start)
	return result, nil
}

// hashColumns returns a SHA-256 hex string of the sorted column list.
func hashColumns(cols []string) string {
	h := sha256.New()
	for _, c := range cols {
		h.Write([]byte(c))
		h.Write([]byte("\n"))
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

// diffColumns returns the set difference: columns in b but not a (added),
// and columns in a but not b (removed).
func diffColumns(prev, cur []string) (added, removed []string) {
	prevSet := make(map[string]bool, len(prev))
	for _, c := range prev {
		prevSet[c] = true
	}
	curSet := make(map[string]bool, len(cur))
	for _, c := range cur {
		curSet[c] = true
	}
	for _, c := range cur {
		if !prevSet[c] {
			added = append(added, c)
		}
	}
	for _, c := range prev {
		if !curSet[c] {
			removed = append(removed, c)
		}
	}
	return added, removed
}
