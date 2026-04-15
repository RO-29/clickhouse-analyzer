package web

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"log/slog"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type tableScanResult struct {
	Tables       []tableScanEntry `json:"tables"`
	ScannedAt    string           `json:"scanned_at"`
	TimeFrom     string           `json:"time_from"`
	TimeTo       string           `json:"time_to"`
	Warnings     []string         `json:"warnings,omitempty"`
	ActivityRows int              `json:"activity_rows"` // qlog rows matched
}

type tableScanEntry struct {
	Database      string             `json:"database"`
	Table         string             `json:"table"`
	Engine        string             `json:"engine"`
	StoragePolicy string             `json:"storage_policy"`
	SortingKey    string             `json:"sorting_key"`
	PrimaryKey    string             `json:"primary_key"`
	PartitionKey  string             `json:"partition_key"`
	SamplingKey   string             `json:"sampling_key"`
	TotalRows     uint64             `json:"total_rows"`
	TotalBytes    uint64             `json:"total_bytes"`
	PartsCount    uint64             `json:"parts_count"`
	CreateQuery   string             `json:"create_query"`
	DiskUsage     []diskUsageEntry   `json:"disk_usage"`
	QueryActivity tableQueryActivity `json:"query_activity"`
	SchemaIssues  []string           `json:"schema_issues,omitempty"`
}

type diskUsageEntry struct {
	DiskName     string `json:"disk_name"`
	DiskType     string `json:"disk_type"` // local | s3 | hdfs etc.
	Bytes        uint64 `json:"bytes"`
	Parts        uint64 `json:"parts"`
	ReadableSize string `json:"readable_size"`
}

// tableQueryPattern holds one slow-query fingerprint (first 120 chars of query text).
type tableQueryPattern struct {
	QueryPrefix string  `json:"query_prefix"`
	ExecCount   int64   `json:"exec_count"`
	AvgMs       float64 `json:"avg_ms"`
	MaxMs       float64 `json:"max_ms"`
}

// tableSlowStats is a summary of SELECT latency for a table in the time window.
type tableSlowStats struct {
	AvgMs     float64 `json:"avg_ms"`
	MaxMs     float64 `json:"max_ms"`
	P95Ms     float64 `json:"p95_ms"`
	SlowCount int64   `json:"slow_count"` // SELECTs taking >= 1 second
}

type tableQueryActivity struct {
	SelectCount int64               `json:"select_count"`
	InsertCount int64               `json:"insert_count"`
	LastSelect  string              `json:"last_select,omitempty"`
	LastInsert  string              `json:"last_insert,omitempty"`
	IsActive    bool                `json:"is_active"`
	SlowStats   *tableSlowStats     `json:"slow_stats,omitempty"`
	TopPatterns []tableQueryPattern `json:"top_patterns,omitempty"`
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

func (s *Server) handleTableScan(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found: "+instance)
		return
	}

	// Parse time window from query params (unix seconds), default last 7 days.
	now := time.Now().UTC()
	fromTime := now.Add(-7 * 24 * time.Hour)
	toTime := now

	if v := r.URL.Query().Get("from"); v != "" {
		if t := parseUnixSec(v); !t.IsZero() {
			fromTime = t
		}
	}
	if v := r.URL.Query().Get("to"); v != "" {
		if t := parseUnixSec(v); !t.IsZero() {
			toTime = t
		}
	}

	fromStr := fromTime.Format("2006-01-02 15:04:05")
	toStr := toTime.Format("2006-01-02 15:04:05")

	ctx := r.Context()

	// selectCond is the query_log condition for SELECT-like queries.
	selectCond := `(upper(left(ltrim(query), 6)) = 'SELECT' OR upper(left(ltrim(query), 4)) = 'WITH')`

	// ── Run four queries in parallel ─────────────────────────────────────────
	var (
		tableRows   []map[string]interface{}
		diskRows    []map[string]interface{}
		qlogRows    []map[string]interface{}
		patternRows []map[string]interface{}
		tableErr    error
		diskErr     error
		qlogErr     error
		patternErr  error
		wg          sync.WaitGroup
	)

	wg.Add(4)

	// 1. Table schema + meta from system.tables
	go func() {
		defer wg.Done()
		tableRows, tableErr = client.Query(ctx, `
SELECT
  database,
  name AS table,
  engine,
  storage_policy,
  sorting_key,
  primary_key,
  partition_key,
  sampling_key,
  total_rows,
  total_bytes,
  parts,
  create_table_query
FROM system.tables
WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA', '_temporary_and_external_tables')
  AND engine NOT IN ('View', 'MaterializedView', 'Dictionary', 'Distributed', 'Null', 'Buffer')
ORDER BY database, name
`)
	}()

	// 2. Disk usage per table per disk from system.parts
	go func() {
		defer wg.Done()
		diskRows, diskErr = client.Query(ctx, `
SELECT
  database,
  table,
  disk_name,
  count() AS parts,
  sum(bytes_on_disk) AS bytes,
  formatReadableSize(sum(bytes_on_disk)) AS readable_size
FROM system.parts
WHERE active = 1
  AND database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA', '_temporary_and_external_tables')
GROUP BY database, table, disk_name
ORDER BY database, table, bytes DESC
`)
	}()

	// 3. Query activity + slow stats from query_log.
	// ARRAY JOIN unnests the per-query tables[] array so each row is one table.
	// Also computes avg/max/p95 SELECT duration and slow-query count.
	go func() {
		defer wg.Done()
		qlogRows, qlogErr = client.Query(ctx, fmt.Sprintf(`
SELECT
  if(position(t, '.') > 0,
     substring(t, 1, position(t, '.') - 1),
     '') AS db,
  if(position(t, '.') > 0,
     substring(t, position(t, '.') + 1),
     t) AS tbl,
  countIf(`+selectCond+`) AS select_count,
  countIf(upper(left(ltrim(query), 6)) = 'INSERT') AS insert_count,
  maxIf(event_time, `+selectCond+`) AS last_select,
  maxIf(event_time, upper(left(ltrim(query), 6)) = 'INSERT') AS last_insert,
  toFloat64(avgIf(query_duration_ms, `+selectCond+`)) AS avg_select_ms,
  toFloat64(maxIf(query_duration_ms, `+selectCond+`)) AS max_select_ms,
  toFloat64(quantileIf(0.95)(query_duration_ms, `+selectCond+`)) AS p95_select_ms,
  countIf(`+selectCond+` AND query_duration_ms >= 1000) AS slow_select_count
FROM system.query_log
ARRAY JOIN tables AS t
WHERE type = 'QueryFinish'
  AND is_initial_query = 1
  AND length(tables) > 0
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY db, tbl
HAVING db NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA', '_temporary_and_external_tables', '')
  AND tbl != ''
`, fromStr, toStr))
	}()

	// 4. Top query patterns per table: group SELECT queries by first 120 chars,
	// return up to 1000 rows (capped at 5 per table in Go).
	go func() {
		defer wg.Done()
		patternRows, patternErr = client.Query(ctx, fmt.Sprintf(`
SELECT
  if(position(t, '.') > 0,
     substring(t, 1, position(t, '.') - 1),
     '') AS db,
  if(position(t, '.') > 0,
     substring(t, position(t, '.') + 1),
     t) AS tbl,
  left(ltrim(query), 120) AS query_prefix,
  count() AS exec_count,
  toFloat64(round(avg(query_duration_ms))) AS avg_ms,
  toFloat64(round(max(query_duration_ms))) AS max_ms
FROM system.query_log
ARRAY JOIN tables AS t
WHERE type = 'QueryFinish'
  AND is_initial_query = 1
  AND length(tables) > 0
  AND `+selectCond+`
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY db, tbl, query_prefix
HAVING db NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA', '_temporary_and_external_tables', '')
  AND tbl != ''
  AND exec_count >= 2
ORDER BY avg_ms DESC
LIMIT 1000
`, fromStr, toStr))
	}()

	wg.Wait()

	if tableErr != nil {
		slog.Warn("table-scan: system.tables query failed", "err", tableErr)
		writeErr(w, http.StatusInternalServerError, "failed to query system.tables: "+tableErr.Error())
		return
	}
	var warnings []string
	if diskErr != nil {
		slog.Warn("table-scan: disk query failed", "err", diskErr)
		warnings = append(warnings, "disk query failed: "+diskErr.Error())
	}
	if qlogErr != nil {
		slog.Warn("table-scan: query_log query failed", "err", qlogErr)
		warnings = append(warnings, "activity query failed: "+qlogErr.Error())
	}
	if patternErr != nil {
		slog.Warn("table-scan: patterns query failed", "err", patternErr)
		// Non-fatal — patterns section will just be empty.
	}

	// ── Fetch disk types from system.disks ────────────────────────────────────
	diskTypeMap := map[string]string{} // disk_name → type
	if dtRows, err := client.Query(ctx, `SELECT name, type FROM system.disks`); err == nil {
		for _, row := range dtRows {
			name := strVal(row["name"])
			typ := strVal(row["type"])
			if name != "" {
				diskTypeMap[name] = typ
			}
		}
	}

	// ── Index disk rows by database.table ─────────────────────────────────────
	type diskKey struct{ db, tbl string }
	diskByTable := map[diskKey][]diskUsageEntry{}
	for _, row := range diskRows {
		db := strVal(row["database"])
		tbl := strVal(row["table"])
		dn := strVal(row["disk_name"])
		key := diskKey{db, tbl}
		diskByTable[key] = append(diskByTable[key], diskUsageEntry{
			DiskName:     dn,
			DiskType:     diskTypeMap[dn],
			Bytes:        uint64Val(row["bytes"]),
			Parts:        uint64Val(row["parts"]),
			ReadableSize: strVal(row["readable_size"]),
		})
	}

	// ── Index query activity by database.table ───────────────────────────────
	type actKey struct{ db, tbl string }
	type actVal struct {
		selectCount int64
		insertCount int64
		lastSelect  string
		lastInsert  string
		avgMs       float64
		maxMs       float64
		p95Ms       float64
		slowCount   int64
	}
	actMap := map[actKey]actVal{}
	for _, row := range qlogRows {
		db := strVal(row["db"])
		tbl := strVal(row["tbl"])
		actMap[actKey{db, tbl}] = actVal{
			selectCount: int64Val(row["select_count"]),
			insertCount: int64Val(row["insert_count"]),
			lastSelect:  strVal(row["last_select"]),
			lastInsert:  strVal(row["last_insert"]),
			avgMs:       float64Val(row["avg_select_ms"]),
			maxMs:       float64Val(row["max_select_ms"]),
			p95Ms:       float64Val(row["p95_select_ms"]),
			slowCount:   int64Val(row["slow_select_count"]),
		}
	}

	// ── Index patterns by database.table (top 5 per table by avg_ms DESC) ────
	type patternKey struct{ db, tbl string }
	patternsByTable := map[patternKey][]tableQueryPattern{}
	for _, row := range patternRows {
		db := strVal(row["db"])
		tbl := strVal(row["tbl"])
		key := patternKey{db, tbl}
		patternsByTable[key] = append(patternsByTable[key], tableQueryPattern{
			QueryPrefix: strVal(row["query_prefix"]),
			ExecCount:   int64Val(row["exec_count"]),
			AvgMs:       float64Val(row["avg_ms"]),
			MaxMs:       float64Val(row["max_ms"]),
		})
	}
	for key, patterns := range patternsByTable {
		sort.Slice(patterns, func(i, j int) bool {
			return patterns[i].AvgMs > patterns[j].AvgMs
		})
		if len(patterns) > 5 {
			patterns = patterns[:5]
		}
		patternsByTable[key] = patterns
	}

	// ── Assemble results ──────────────────────────────────────────────────────
	entries := make([]tableScanEntry, 0, len(tableRows))
	for _, row := range tableRows {
		db := strVal(row["database"])
		tbl := strVal(row["table"])
		engine := strVal(row["engine"])
		partitionKey := strVal(row["partition_key"])
		sortingKey := strVal(row["sorting_key"])
		partsCount := uint64Val(row["parts"])
		totalRows := uint64Val(row["total_rows"])

		av := actMap[actKey{db, tbl}]

		// Slow stats are set only when the table had SELECT queries with timing data.
		var slowStats *tableSlowStats
		if av.selectCount > 0 && av.avgMs > 0 {
			slowStats = &tableSlowStats{
				AvgMs:     av.avgMs,
				MaxMs:     av.maxMs,
				P95Ms:     av.p95Ms,
				SlowCount: av.slowCount,
			}
		}

		activity := tableQueryActivity{
			SelectCount: av.selectCount,
			InsertCount: av.insertCount,
			LastSelect:  av.lastSelect,
			LastInsert:  av.lastInsert,
			IsActive:    av.selectCount+av.insertCount > 0,
			SlowStats:   slowStats,
			TopPatterns: patternsByTable[patternKey{db, tbl}],
		}

		// ── Schema issue detection ────────────────────────────────────────────
		var issues []string
		isMT := strings.Contains(engine, "MergeTree")
		if isMT && partitionKey == "" {
			issues = append(issues, "no_partition_key")
		}
		if isMT && sortingKey == "" {
			issues = append(issues, "no_sort_key")
		}
		if partsCount > 1000 {
			issues = append(issues, fmt.Sprintf("high_parts_%d", partsCount))
		}
		// Table has data and is being read but has received no inserts in the window.
		if isMT && totalRows > 0 && av.insertCount == 0 && av.selectCount > 0 {
			issues = append(issues, "no_recent_inserts")
		}

		entries = append(entries, tableScanEntry{
			Database:      db,
			Table:         tbl,
			Engine:        engine,
			StoragePolicy: strVal(row["storage_policy"]),
			SortingKey:    sortingKey,
			PrimaryKey:    strVal(row["primary_key"]),
			PartitionKey:  partitionKey,
			SamplingKey:   strVal(row["sampling_key"]),
			TotalRows:     totalRows,
			TotalBytes:    uint64Val(row["total_bytes"]),
			PartsCount:    partsCount,
			CreateQuery:   strVal(row["create_table_query"]),
			DiskUsage:     diskByTable[diskKey{db, tbl}],
			QueryActivity: activity,
			SchemaIssues:  issues,
		})
	}

	// Sort by total_bytes desc by default.
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].TotalBytes > entries[j].TotalBytes
	})

	result := tableScanResult{
		Tables:       entries,
		ScannedAt:    now.Format(time.RFC3339),
		TimeFrom:     fromStr,
		TimeTo:       toStr,
		Warnings:     warnings,
		ActivityRows: len(qlogRows),
	}

	writeJSON(w, http.StatusOK, result)
}

// handleTableScanDebug runs diagnostic queries so you can see what the
// query_log tables/databases columns actually look like on this instance.
// GET /api/instances/{name}/table-scan-debug
func (s *Server) handleTableScanDebug(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found: "+instance)
		return
	}
	ctx := r.Context()

	type debugResult struct {
		SampleRows []map[string]interface{} `json:"sample_rows"`
		SampleErr  string                   `json:"sample_err,omitempty"`
		AggRows    []map[string]interface{} `json:"agg_rows"`
		AggErr     string                   `json:"agg_err,omitempty"`
	}

	out := debugResult{}

	// Raw sample: show what tables/databases columns look like
	sampleRows, sampleErr := client.Query(ctx, `
SELECT
  tables,
  databases,
  left(query, 80) AS query_head,
  type,
  event_time
FROM system.query_log
WHERE type = 'QueryFinish'
  AND is_initial_query = 1
  AND length(tables) > 0
ORDER BY event_time DESC
LIMIT 10
`)
	if sampleErr != nil {
		out.SampleErr = sampleErr.Error()
	} else {
		out.SampleRows = sampleRows
	}

	// Aggregated: show what the fixed query returns
	aggRows, aggErr := client.Query(ctx, `
SELECT
  if(position(t, '.') > 0, substring(t, 1, position(t, '.') - 1), '') AS db,
  if(position(t, '.') > 0, substring(t, position(t, '.') + 1), t) AS tbl,
  countIf(upper(left(ltrim(query), 6)) = 'SELECT' OR upper(left(ltrim(query), 4)) = 'WITH') AS select_count,
  countIf(upper(left(ltrim(query), 6)) = 'INSERT') AS insert_count
FROM system.query_log
ARRAY JOIN tables AS t
WHERE type = 'QueryFinish'
  AND is_initial_query = 1
  AND length(tables) > 0
  AND event_time > now() - 86400
GROUP BY db, tbl
HAVING db NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA', '_temporary_and_external_tables', '')
  AND tbl != ''
ORDER BY (select_count + insert_count) DESC
LIMIT 20
`)
	if aggErr != nil {
		out.AggErr = aggErr.Error()
	} else {
		out.AggRows = aggRows
	}

	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func parseUnixSec(s string) time.Time {
	var sec int64
	if _, err := fmt.Sscanf(s, "%d", &sec); err != nil || sec <= 0 {
		return time.Time{}
	}
	return time.Unix(sec, 0).UTC()
}

func strVal(v interface{}) string {
	if v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case []byte:
		return string(t)
	default:
		return fmt.Sprintf("%v", v)
	}
}

func uint64Val(v interface{}) uint64 {
	if v == nil {
		return 0
	}
	switch t := v.(type) {
	case uint64:
		return t
	case int64:
		if t < 0 {
			return 0
		}
		return uint64(t)
	case float64:
		if t < 0 {
			return 0
		}
		return uint64(t)
	case int:
		if t < 0 {
			return 0
		}
		return uint64(t)
	}
	return 0
}

func int64Val(v interface{}) int64 {
	if v == nil {
		return 0
	}
	switch t := v.(type) {
	case int64:
		return t
	case uint64:
		return int64(t)
	case float64:
		return int64(t)
	case int:
		return int64(t)
	}
	return 0
}

func float64Val(v interface{}) float64 {
	if v == nil {
		return 0
	}
	switch t := v.(type) {
	case float64:
		return t
	case float32:
		return float64(t)
	case int64:
		return float64(t)
	case uint64:
		return float64(t)
	case int:
		return float64(t)
	}
	return 0
}
