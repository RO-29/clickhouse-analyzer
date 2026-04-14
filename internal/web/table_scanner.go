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
	Tables    []tableScanEntry `json:"tables"`
	ScannedAt string           `json:"scanned_at"`
	TimeFrom  string           `json:"time_from"`
	TimeTo    string           `json:"time_to"`
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

	// 3. Query activity from query_log
	go func() {
		defer wg.Done()
		qlogRows, qlogErr = client.Query(ctx, fmt.Sprintf(`
SELECT
  databases[1] AS db,
  tables[1]    AS tbl,
  query_kind,
  count()       AS cnt,
  max(event_time) AS last_seen
FROM system.query_log
WHERE type = 'QueryFinish'
  AND is_initial_query = 1
  AND length(databases) > 0
  AND length(tables) > 0
  AND databases[1] NOT IN ('system', 'information_schema', '')
  AND tables[1] != ''
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY db, tbl, query_kind
`, fromStr, toStr))
	}()

	wg.Wait()

	if tableErr != nil {
		slog.Warn("table-scan: system.tables query failed", "err", tableErr)
		writeErr(w, http.StatusInternalServerError, "failed to query system.tables: "+tableErr.Error())
		return
	}
	if diskErr != nil {
		slog.Warn("table-scan: disk query failed", "err", diskErr)
		// Non-fatal — continue without disk data.
	}
	if qlogErr != nil {
		slog.Warn("table-scan: query_log query failed", "err", qlogErr)
		// Non-fatal — continue without activity data.
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

	// ── Index query activity by database.table.kind ───────────────────────────
	type actKey struct{ db, tbl, kind string }
	actCount := map[actKey]int64{}
	actLast  := map[actKey]string{}
	for _, row := range qlogRows {
		db := strVal(row["db"])
		tbl := strVal(row["tbl"])
		kind := strings.ToUpper(strVal(row["query_kind"]))
		key := actKey{db, tbl, kind}
		actCount[key] = int64Val(row["cnt"])
		actLast[key] = strVal(row["last_seen"])
	}

	// ── Assemble results ──────────────────────────────────────────────────────
	entries := make([]tableScanEntry, 0, len(tableRows))
	for _, row := range tableRows {
		db := strVal(row["database"])
		tbl := strVal(row["table"])
		key := diskKey{db, tbl}

		selectKey := actKey{db, tbl, "SELECT"}
		insertKey := actKey{db, tbl, "INSERT"}

		activity := tableQueryActivity{
			SelectCount: actCount[selectKey],
			InsertCount: actCount[insertKey],
			LastSelect:  actLast[selectKey],
			LastInsert:  actLast[insertKey],
			IsActive:    actCount[selectKey]+actCount[insertKey] > 0,
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
		Tables:    entries,
		ScannedAt: now.Format(time.RFC3339),
		TimeFrom:  fromStr,
		TimeTo:    toStr,
	}

	writeJSON(w, http.StatusOK, result)
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
