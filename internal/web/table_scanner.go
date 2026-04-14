package web

import (
	"fmt"
	"net/http"
	"sort"
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
	Database     string            `json:"database"`
	Table        string            `json:"table"`
	Engine       string            `json:"engine"`
	StoragePolicy string           `json:"storage_policy"`
	SortingKey   string            `json:"sorting_key"`
	PrimaryKey   string            `json:"primary_key"`
	PartitionKey string            `json:"partition_key"`
	SamplingKey  string            `json:"sampling_key"`
	TotalRows    uint64            `json:"total_rows"`
	TotalBytes   uint64            `json:"total_bytes"`
	PartsCount   uint64            `json:"parts_count"`
	CreateQuery  string            `json:"create_query"`
	DiskUsage    []diskUsageEntry  `json:"disk_usage"`
	QueryActivity tableQueryActivity `json:"query_activity"`
}

type diskUsageEntry struct {
	DiskName    string `json:"disk_name"`
	DiskType    string `json:"disk_type"` // local | s3 | hdfs etc.
	Bytes       uint64 `json:"bytes"`
	Parts       uint64 `json:"parts"`
	ReadableSize string `json:"readable_size"`
}

type tableQueryActivity struct {
	SelectCount int64  `json:"select_count"`
	InsertCount int64  `json:"insert_count"`
	LastSelect  string `json:"last_select,omitempty"`
	LastInsert  string `json:"last_insert,omitempty"`
	IsActive    bool   `json:"is_active"`
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

	// ── Run three queries in parallel ────────────────────────────────────────
	var (
		tableRows []map[string]interface{}
		diskRows  []map[string]interface{}
		qlogRows  []map[string]interface{}
		tableErr  error
		diskErr   error
		qlogErr   error
		wg        sync.WaitGroup
	)

	wg.Add(3)

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

	// 3. Query activity from query_log.
	// Use ARRAY JOIN on `tables` to unnest per-table rows, then parse db.table from
	// the qualified name (e.g. "mydb.events"). Avoids query_kind (CH 21.5+) and
	// avoids the databases[1]/tables[1] pairing bug (those arrays don't correspond).
	// ltrim() trims leading whitespace portably; trimBoth() is less available.
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
  countIf(upper(left(ltrim(query), 6)) = 'SELECT' OR upper(left(ltrim(query), 4)) = 'WITH') AS select_count,
  countIf(upper(left(ltrim(query), 6)) = 'INSERT') AS insert_count,
  maxIf(event_time, upper(left(ltrim(query), 6)) = 'SELECT' OR upper(left(ltrim(query), 4)) = 'WITH') AS last_select,
  maxIf(event_time, upper(left(ltrim(query), 6)) = 'INSERT') AS last_insert
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
			DiskName:    dn,
			DiskType:    diskTypeMap[dn],
			Bytes:       uint64Val(row["bytes"]),
			Parts:       uint64Val(row["parts"]),
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
	}
	actMap := map[actKey]actVal{}
	for _, row := range qlogRows {
		db := strVal(row["db"])
		tbl := strVal(row["tbl"])
		key := actKey{db, tbl}
		actMap[key] = actVal{
			selectCount: int64Val(row["select_count"]),
			insertCount: int64Val(row["insert_count"]),
			lastSelect:  strVal(row["last_select"]),
			lastInsert:  strVal(row["last_insert"]),
		}
	}

	// ── Assemble results ──────────────────────────────────────────────────────
	entries := make([]tableScanEntry, 0, len(tableRows))
	for _, row := range tableRows {
		db := strVal(row["database"])
		tbl := strVal(row["table"])
		key := diskKey{db, tbl}

		av := actMap[actKey{db, tbl}]
		activity := tableQueryActivity{
			SelectCount: av.selectCount,
			InsertCount: av.insertCount,
			LastSelect:  av.lastSelect,
			LastInsert:  av.lastInsert,
			IsActive:    av.selectCount+av.insertCount > 0,
		}

		entries = append(entries, tableScanEntry{
			Database:      db,
			Table:         tbl,
			Engine:        strVal(row["engine"]),
			StoragePolicy: strVal(row["storage_policy"]),
			SortingKey:    strVal(row["sorting_key"]),
			PrimaryKey:    strVal(row["primary_key"]),
			PartitionKey:  strVal(row["partition_key"]),
			SamplingKey:   strVal(row["sampling_key"]),
			TotalRows:     uint64Val(row["total_rows"]),
			TotalBytes:    uint64Val(row["total_bytes"]),
			PartsCount:    uint64Val(row["parts"]),
			CreateQuery:   strVal(row["create_table_query"]),
			DiskUsage:     diskByTable[key],
			QueryActivity: activity,
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
		SampleRows  []map[string]interface{} `json:"sample_rows"`
		SampleErr   string                   `json:"sample_err,omitempty"`
		AggRows     []map[string]interface{} `json:"agg_rows"`
		AggErr      string                   `json:"agg_err,omitempty"`
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
