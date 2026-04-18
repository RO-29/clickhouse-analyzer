package web

import (
	"context"
	"crypto/md5"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// ---------------------------------------------------------------------------
// Compare Tables
// ---------------------------------------------------------------------------

// cmpDiskSlice is one disk's contribution to a table's storage.
type cmpDiskSlice struct {
	Disk  string  `json:"disk"`
	Type  string  `json:"type"`  // "local", "s3", "hdfs", …
	Bytes float64 `json:"bytes"`
	Parts int     `json:"parts"`
}

// cmpPartsDetail holds per-table part health metrics.
type cmpPartsDetail struct {
	OldestH      float64 `json:"oldest_h"`
	AvgBytes     float64 `json:"avg_bytes"`
	WideParts    int     `json:"wide_parts"`
	CompactParts int     `json:"compact_parts"`
}

// cmpQueryStats holds query-log performance data for a table on one instance.
type cmpQueryStats struct {
	SelectCount int64   `json:"select_count"`
	AvgMs       float64 `json:"avg_ms"`
	MaxMs       float64 `json:"max_ms"`
	P95Ms       float64 `json:"p95_ms"`
}

// cmpTableRaw is the internal accumulation struct per instance per table.
type cmpTableRaw struct {
	Rows           float64
	Bytes          float64
	Size           string
	Parts          float64
	PKBytes        float64
	MarksBytes     float64
	OldestHours    float64
	AvgPartBytes   float64
	WideParts      int
	CompactParts   int
	PartitionCount int64
}

// cmpInstanceData holds everything collected from one instance.
type cmpInstanceData struct {
	tables    map[string]cmpTableRaw       // key: "db.table"
	engine    map[string]string
	diskDist  map[string][]cmpDiskSlice    // key: "db.table"
	columns   map[string]map[string]string // key: "db.table" -> col name -> type
	tblStruct map[string][2]string         // key: "db.table" -> [partitionKey, sortingKey]
}

// handleCompareTables returns table metadata across all instances, merged by
// database.table with row-drift percentages, DDL criticality, disk
// distribution, and parts health.
func (s *Server) handleCompareTables(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()

	instances := s.manager.Names()

	var mu sync.Mutex
	perInstance := make(map[string]*cmpInstanceData, len(instances))

	errs := s.manager.ForEachParallel(ctx, func(ctx context.Context, name string, client *chclient.Client) error {
		// ── Q1: table metadata ────────────────────────────────────────
		tableRows, err := client.Query(ctx, `
			SELECT database, name as table_name, engine,
				COALESCE(total_rows, 0) as total_rows,
				COALESCE(total_bytes, 0) as total_bytes,
				formatReadableSize(COALESCE(total_bytes, 0)) as size_readable
			FROM system.tables
			WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer')
				AND engine NOT IN ('Dictionary','LiveView','WindowView')
				AND (COALESCE(total_bytes, 0) > 0 OR engine IN ('MaterializedView','View'))
			ORDER BY database, name
		`)
		if err != nil {
			return fmt.Errorf("query tables: %w", err)
		}

		// ── Q2: extended parts query (with age + format type + partition count) ─
		partsRows, err := client.Query(ctx, `
			SELECT database, `+"`table`"+` as table_name,
				count() as parts,
				sum(primary_key_bytes_in_memory) as pk_bytes,
				sum(marks_bytes) as marks_bytes_total,
				toUInt64(dateDiff('hour', min(modification_time), now())) as oldest_h,
				round(avg(bytes_on_disk)) as avg_part_bytes,
				countIf(part_type = 'Wide') as wide_parts,
				countIf(part_type = 'Compact') as compact_parts,
				count(DISTINCT partition) as partition_count
			FROM system.parts WHERE active
			GROUP BY database, table_name
		`)
		if err != nil {
			// part_type not available on older CH — fallback without format breakdown
			partsRows, _ = client.Query(ctx, `
				SELECT database, `+"`table`"+` as table_name,
					count() as parts,
					sum(primary_key_bytes_in_memory) as pk_bytes,
					sum(marks_bytes) as marks_bytes_total,
					toUInt64(dateDiff('hour', min(modification_time), now())) as oldest_h,
					round(avg(bytes_on_disk)) as avg_part_bytes,
					0 as wide_parts,
					0 as compact_parts,
					count(DISTINCT partition) as partition_count
				FROM system.parts WHERE active
				GROUP BY database, table_name
			`)
		}

		// ── Q3: disk type lookup ──────────────────────────────────────
		diskTypeMap := make(map[string]string) // disk name -> type
		if diskTypeRows, e := client.Query(ctx, `SELECT name, type FROM system.disks`); e == nil {
			for _, row := range diskTypeRows {
				diskTypeMap[toString(row["name"])] = toString(row["type"])
			}
		}

		// ── Q4: disk distribution per table ──────────────────────────
		diskDistMap := make(map[string][]cmpDiskSlice)
		diskDistRows, e := client.Query(ctx, `
			SELECT database, `+"`table`"+`,
				disk_name,
				sum(bytes_on_disk) AS bytes,
				count() AS parts_cnt
			FROM system.parts
			WHERE active
			GROUP BY database, `+"`table`"+`, disk_name
			ORDER BY bytes DESC
		`)
		if e == nil {
			for _, row := range diskDistRows {
				key := toString(row["database"]) + "." + toString(row["table"])
				diskName := toString(row["disk_name"])
				diskDistMap[key] = append(diskDistMap[key], cmpDiskSlice{
					Disk:  diskName,
					Type:  diskTypeMap[diskName],
					Bytes: toFloat64(row["bytes"]),
					Parts: int(toFloat64(row["parts_cnt"])),
				})
			}
		}

		// ── Q5: column types for DDL diff ────────────────────────────
		colMap := make(map[string]map[string]string) // "db.table" -> col -> type
		colRows, e := client.Query(ctx, `
			SELECT database, `+"`table`"+`, name, type
			FROM system.columns
			WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer')
			ORDER BY database, `+"`table`"+`, position
		`)
		if e == nil {
			for _, row := range colRows {
				key := toString(row["database"]) + "." + toString(row["table"])
				if colMap[key] == nil {
					colMap[key] = make(map[string]string)
				}
				colMap[key][toString(row["name"])] = toString(row["type"])
			}
		}

		// ── Q6: partition + sort keys for DDL diff ───────────────────
		tblStructMap := make(map[string][2]string) // "db.table" -> [partKey, sortKey]
		structRows, e := client.Query(ctx, `
			SELECT database, name AS tbl, partition_key, sorting_key
			FROM system.tables
			WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer')
				AND engine NOT IN ('Dictionary','LiveView','WindowView')
		`)
		if e == nil {
			for _, row := range structRows {
				key := toString(row["database"]) + "." + toString(row["tbl"])
				tblStructMap[key] = [2]string{
					toString(row["partition_key"]),
					toString(row["sorting_key"]),
				}
			}
		}

		// ── assemble ─────────────────────────────────────────────────
		data := &cmpInstanceData{
			tables:    make(map[string]cmpTableRaw),
			engine:    make(map[string]string),
			diskDist:  diskDistMap,
			columns:   colMap,
			tblStruct: tblStructMap,
		}

		for _, row := range tableRows {
			key := toString(row["database"]) + "." + toString(row["table_name"])
			data.tables[key] = cmpTableRaw{
				Rows:  toFloat64(row["total_rows"]),
				Bytes: toFloat64(row["total_bytes"]),
				Size:  toString(row["size_readable"]),
			}
			data.engine[key] = toString(row["engine"])
		}

		for _, row := range partsRows {
			key := toString(row["database"]) + "." + toString(row["table_name"])
			if ti, ok := data.tables[key]; ok {
				ti.Parts = toFloat64(row["parts"])
				ti.PKBytes = toFloat64(row["pk_bytes"])
				ti.MarksBytes = toFloat64(row["marks_bytes_total"])
				ti.OldestHours = toFloat64(row["oldest_h"])
				ti.AvgPartBytes = toFloat64(row["avg_part_bytes"])
				ti.WideParts = int(toFloat64(row["wide_parts"]))
				ti.CompactParts = int(toFloat64(row["compact_parts"]))
				ti.PartitionCount = int64(toFloat64(row["partition_count"]))
				data.tables[key] = ti
			}
		}

		mu.Lock()
		perInstance[name] = data
		mu.Unlock()
		return nil
	})

	if len(errs) > 0 {
		for name, err := range errs {
			slog.Error("compare tables: instance error", "instance", name, "err", err)
		}
	}

	// ── collect all unique table keys ─────────────────────────────────
	allKeys := make(map[string]string) // key -> engine
	for _, data := range perInstance {
		for key, eng := range data.engine {
			allKeys[key] = eng
		}
	}

	sortedKeys := make([]string, 0, len(allKeys))
	for k := range allKeys {
		sortedKeys = append(sortedKeys, k)
	}
	sort.Strings(sortedKeys)

	// ── output types ─────────────────────────────────────────────────
	type nodeInfo struct {
		Rows           float64         `json:"rows"`
		Bytes          float64         `json:"bytes"`
		Size           string          `json:"size"`
		Parts          float64         `json:"parts"`
		PKBytes        float64         `json:"pk_bytes"`
		MarksBytes     float64         `json:"marks_bytes"`
		DiskDist       []cmpDiskSlice  `json:"disk_dist,omitempty"`
		PartsDetail    *cmpPartsDetail `json:"parts_detail,omitempty"`
		S3Pct          float64         `json:"s3_pct"`
		QueryStats     *cmpQueryStats  `json:"query_stats,omitempty"`
		PartitionCount int64           `json:"partition_count"`
		// DDL fields — exposed so the frontend can recompute diff for only the
		// selected nodes (the pre-computed DDLCriticality covers all instances).
		PartitionKey string `json:"partition_key,omitempty"`
		SortingKey   string `json:"sorting_key,omitempty"`
		ColHash      string `json:"col_hash,omitempty"` // 8-hex-char MD5 of sorted col:type pairs
	}

	type tableEntry struct {
		Database           string              `json:"database"`
		Table              string              `json:"table"`
		Engine             string              `json:"engine"`
		Nodes              map[string]nodeInfo `json:"nodes"`
		MaxRowDiffPct      float64             `json:"max_row_diff_pct"`
		TotalBytes         float64             `json:"total_bytes"`         // sum across all instances
		MissingOn          []string            `json:"missing_on,omitempty"`
		DDLCriticality     string              `json:"ddl_criticality,omitempty"`
		DDLChanges         []string            `json:"ddl_changes,omitempty"`
		DiskDiscrepancy    bool                `json:"disk_discrepancy,omitempty"` // S3% differs >20% across nodes
		DiskDiscDetails    string              `json:"disk_disc_details,omitempty"`
	}

	tables := make([]tableEntry, 0, len(sortedKeys))
	for _, key := range sortedKeys {
		keyParts := strings.SplitN(key, ".", 2)
		if len(keyParts) != 2 {
			continue
		}
		db, tbl := keyParts[0], keyParts[1]

		entry := tableEntry{
			Database: db,
			Table:    tbl,
			Engine:   allKeys[key],
			Nodes:    make(map[string]nodeInfo),
		}

		var maxRows, minRows float64
		first := true
		var missingOn []string

		for _, inst := range instances {
			data, ok := perInstance[inst]
			if !ok {
				missingOn = append(missingOn, inst)
				continue
			}
			ti, ok := data.tables[key]
			if !ok {
				missingOn = append(missingOn, inst)
				continue
			}

			// Compute S3% for this node's table.
			var s3Pct float64
			if dd := data.diskDist[key]; len(dd) > 0 {
				var totalB, s3B float64
				for _, d := range dd {
					totalB += d.Bytes
					if isCmpS3Type(d.Type) {
						s3B += d.Bytes
					}
				}
				if totalB > 0 {
					s3Pct = s3B / totalB * 100
				}
			}

			sk := data.tblStruct[key]
			ni := nodeInfo{
				Rows:           ti.Rows,
				Bytes:          ti.Bytes,
				Size:           ti.Size,
				Parts:          ti.Parts,
				PKBytes:        ti.PKBytes,
				MarksBytes:     ti.MarksBytes,
				DiskDist:       data.diskDist[key],
				S3Pct:          s3Pct,
				PartitionCount: ti.PartitionCount,
				PartitionKey:   sk[0],
				SortingKey:     sk[1],
				ColHash:        cmpColHash(data.columns[key]),
			}
			if ti.Parts > 0 {
				ni.PartsDetail = &cmpPartsDetail{
					OldestH:      ti.OldestHours,
					AvgBytes:     ti.AvgPartBytes,
					WideParts:    ti.WideParts,
					CompactParts: ti.CompactParts,
				}
			}

			entry.Nodes[inst] = ni

			if first {
				maxRows, minRows = ti.Rows, ti.Rows
				first = false
			} else {
				if ti.Rows > maxRows { maxRows = ti.Rows }
				if ti.Rows < minRows { minRows = ti.Rows }
			}
		}

		if maxRows > 0 {
			entry.MaxRowDiffPct = math.Round((maxRows-minRows)/maxRows*1000) / 10
		}
		if len(missingOn) > 0 {
			entry.MissingOn = missingOn
		}

		// ── DDL criticality ──────────────────────────────────────────
		entry.DDLCriticality, entry.DDLChanges = compareDDL(instances, perInstance, key)

		// ── Cumulative size ───────────────────────────────────────────
		for _, ni := range entry.Nodes {
			entry.TotalBytes += ni.Bytes
		}

		// ── Disk discrepancy ──────────────────────────────────────────
		// Flag when S3% differs by >20 percentage points across nodes that
		// have disk data — e.g. 90% S3 on one node vs 10% on another.
		var minS3, maxS3 float64
		s3First := true
		var diskDetails []string
		for inst, ni := range entry.Nodes {
			if len(ni.DiskDist) == 0 {
				continue
			}
			if s3First {
				minS3, maxS3 = ni.S3Pct, ni.S3Pct
				s3First = false
			} else {
				if ni.S3Pct < minS3 {
					minS3 = ni.S3Pct
				}
				if ni.S3Pct > maxS3 {
					maxS3 = ni.S3Pct
				}
			}
			diskDetails = append(diskDetails, fmt.Sprintf("%s: %.0f%% S3", inst, ni.S3Pct))
		}
		if !s3First && maxS3-minS3 > 20 {
			entry.DiskDiscrepancy = true
			sort.Strings(diskDetails)
			entry.DiskDiscDetails = strings.Join(diskDetails, " vs ")
		}

		tables = append(tables, entry)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"tables":    tables,
		"instances": instances,
	})
}

// cmpColHash returns an 8-char hex fingerprint of a table's column schema.
// Columns with the same set of col:type pairs produce the same hash.
func cmpColHash(cols map[string]string) string {
	if len(cols) == 0 {
		return ""
	}
	names := make([]string, 0, len(cols))
	for col := range cols {
		names = append(names, col)
	}
	sort.Strings(names)
	var sb strings.Builder
	for _, col := range names {
		sb.WriteString(col)
		sb.WriteByte(':')
		sb.WriteString(cols[col])
		sb.WriteByte(';')
	}
	sum := md5.Sum([]byte(sb.String()))
	return fmt.Sprintf("%x", sum[:4])
}

// compareDDL returns a criticality level ("critical"|"high"|"") and a list of
// human-readable change descriptions for a given table key across instances.
//
//   - critical: PARTITION BY or ORDER BY differ (replication breaks)
//   - high:     column missing on some nodes, or column type differs
func compareDDL(
	instances []string,
	perInstance map[string]*cmpInstanceData,
	key string,
) (string, []string) {
	type snapshot struct {
		inst         string
		partitionKey string
		sortingKey   string
		cols         map[string]string // col name -> type
	}

	var present []snapshot
	for _, inst := range instances {
		d, ok := perInstance[inst]
		if !ok {
			continue
		}
		if _, has := d.tables[key]; !has {
			continue
		}
		sk := d.tblStruct[key]
		present = append(present, snapshot{
			inst:         inst,
			partitionKey: sk[0],
			sortingKey:   sk[1],
			cols:         d.columns[key],
		})
	}

	if len(present) < 2 {
		return "", nil
	}

	var changes []string
	crit := ""

	ref := present[0]

	// ── structural keys ───────────────────────────────────────────────
	for _, other := range present[1:] {
		if other.partitionKey != ref.partitionKey {
			pk1 := ref.partitionKey
			if pk1 == "" { pk1 = "(none)" }
			pk2 := other.partitionKey
			if pk2 == "" { pk2 = "(none)" }
			changes = append(changes, "PARTITION BY: "+pk1+" vs "+pk2)
			crit = "critical"
		}
		if other.sortingKey != ref.sortingKey {
			sk1 := ref.sortingKey
			if sk1 == "" { sk1 = "(none)" }
			sk2 := other.sortingKey
			if sk2 == "" { sk2 = "(none)" }
			changes = append(changes, "ORDER BY: "+sk1+" vs "+sk2)
			if crit == "" { crit = "critical" }
		}
	}

	// ── column differences ────────────────────────────────────────────
	// Only compare if column data was successfully fetched (non-empty on ref).
	if len(ref.cols) == 0 {
		return crit, changes
	}

	allCols := make(map[string]struct{})
	for _, p := range present {
		for col := range p.cols {
			allCols[col] = struct{}{}
		}
	}

	colNames := make([]string, 0, len(allCols))
	for col := range allCols {
		colNames = append(colNames, col)
	}
	sort.Strings(colNames)

	for _, col := range colNames {
		if len(changes) >= 8 { // cap list length
			changes = append(changes, fmt.Sprintf("… and more"))
			break
		}
		types := make(map[string]bool) // distinct types seen
		missing := false
		for _, p := range present {
			if t, ok := p.cols[col]; ok {
				types[t] = true
			} else {
				missing = true
			}
		}
		if missing || len(types) > 1 {
			if missing {
				changes = append(changes, fmt.Sprintf("col %s missing on some nodes", col))
			} else {
				var ts []string
				for t := range types {
					ts = append(ts, t)
				}
				sort.Strings(ts)
				changes = append(changes, fmt.Sprintf("col %s: %s", col, strings.Join(ts, " vs ")))
			}
			if crit != "critical" {
				crit = "high"
			}
		}
	}

	return crit, changes
}

// isCmpS3Type returns true for disk types that represent object/cloud storage.
func isCmpS3Type(t string) bool {
	l := strings.ToLower(t)
	return l == "s3" || l == "s3_plain" || l == "s3_plain_rewritable" ||
		strings.Contains(l, "object") || strings.Contains(l, "azure") || l == "hdfs"
}

// ---------------------------------------------------------------------------
// Compare Query Stats (on-demand — heavy qlog scan, not part of auto-load)
// ---------------------------------------------------------------------------

// GET /api/compare/query-stats — runs the qlog scan per instance and returns
// SELECT latency stats per table. Called only when the user explicitly requests
// it, because the ARRAY JOIN scan is expensive.
func (s *Server) handleCompareQueryStats(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	instances := s.manager.Names()

	const qlogSel = `(upper(left(ltrim(query), 6)) = 'SELECT' OR upper(left(ltrim(query), 4)) = 'WITH')`

	var mu sync.Mutex
	// result: instance -> "db.table" -> stats
	result := make(map[string]map[string]cmpQueryStats, len(instances))

	errs := s.manager.ForEachParallel(ctx, func(ctx context.Context, name string, client *chclient.Client) error {
		rows, err := client.Query(ctx, `
			SELECT
			  if(position(t, '.') > 0,
			     substring(t, 1, position(t, '.') - 1), '') AS db,
			  if(position(t, '.') > 0,
			     substring(t, position(t, '.') + 1), t) AS tbl,
			  countIf(`+qlogSel+`) AS select_count,
			  toFloat64(avgIf(query_duration_ms, `+qlogSel+`)) AS avg_ms,
			  toFloat64(maxIf(query_duration_ms, `+qlogSel+`)) AS max_ms,
			  toFloat64(quantileIf(0.95)(query_duration_ms, `+qlogSel+`)) AS p95_ms
			FROM system.query_log
			ARRAY JOIN tables AS t
			WHERE type = 'QueryFinish'
			  AND is_initial_query = 1
			  AND length(tables) > 0
			  AND event_time > now() - 7 * 86400
			GROUP BY db, tbl
			HAVING db NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA',
			                  '_temporary_and_external_tables', '')
			  AND tbl != ''
		`)
		if err != nil {
			return fmt.Errorf("query_log: %w", err)
		}

		m := make(map[string]cmpQueryStats, len(rows))
		for _, row := range rows {
			db := toString(row["db"])
			tbl := toString(row["tbl"])
			m[db+"."+tbl] = cmpQueryStats{
				SelectCount: int64(toFloat64(row["select_count"])),
				AvgMs:       toFloat64(row["avg_ms"]),
				MaxMs:       toFloat64(row["max_ms"]),
				P95Ms:       toFloat64(row["p95_ms"]),
			}
		}

		mu.Lock()
		result[name] = m
		mu.Unlock()
		return nil
	})

	if len(errs) > 0 {
		for name, err := range errs {
			slog.Warn("compare query-stats: instance error", "instance", name, "err", err)
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"instances": instances,
		"stats":     result, // map[instance]map["db.table"]cmpQueryStats
	})
}

// ---------------------------------------------------------------------------
// Compare Settings
// ---------------------------------------------------------------------------

var importantSettings = map[string]bool{
	"max_memory_usage":                    true,
	"max_bytes_before_external_group_by":  true,
	"max_bytes_before_external_sort":      true,
	"max_threads":                         true,
	"max_memory_usage_for_user":           true,
	"max_concurrent_queries":              true,
	"background_pool_size":                true,
	"background_schedule_pool_size":       true,
	"parallel_view_processing":            true,
	"log_queries":                         true,
	"max_partitions_per_insert_block":     true,
	"parts_to_delay_insert":              true,
	"parts_to_throw_insert":              true,
}

// handleCompareSettings returns changed settings across all instances, flagging
// differences and important settings.
func (s *Server) handleCompareSettings(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	instances := s.manager.Names()

	// Per-instance: setting name -> value.
	var mu sync.Mutex
	perInstance := make(map[string]map[string]string, len(instances))

	errs := s.manager.ForEachParallel(ctx, func(ctx context.Context, name string, client *chclient.Client) error {
		rows, err := client.Query(ctx, `
			SELECT name, value FROM system.settings WHERE changed ORDER BY name
		`)
		if err != nil {
			return fmt.Errorf("query settings: %w", err)
		}

		settings := make(map[string]string, len(rows))
		for _, row := range rows {
			settings[toString(row["name"])] = toString(row["value"])
		}

		mu.Lock()
		perInstance[name] = settings
		mu.Unlock()
		return nil
	})

	if len(errs) > 0 {
		for name, err := range errs {
			slog.Error("compare settings: instance error", "instance", name, "err", err)
		}
	}

	// Collect all unique setting names.
	allNames := make(map[string]struct{})
	for _, settings := range perInstance {
		for name := range settings {
			allNames[name] = struct{}{}
		}
	}

	sortedNames := make([]string, 0, len(allNames))
	for name := range allNames {
		sortedNames = append(sortedNames, name)
	}
	sort.Strings(sortedNames)

	type settingEntry struct {
		Name      string            `json:"name"`
		Values    map[string]string `json:"values"`
		Differs   bool              `json:"differs"`
		Important bool              `json:"important"`
	}

	settings := make([]settingEntry, 0, len(sortedNames))
	for _, name := range sortedNames {
		entry := settingEntry{
			Name:      name,
			Values:    make(map[string]string),
			Important: importantSettings[name],
		}

		var firstVal string
		firstSet := false
		for _, inst := range instances {
			if s, ok := perInstance[inst]; ok {
				if v, ok := s[name]; ok {
					entry.Values[inst] = v
					if !firstSet {
						firstVal = v
						firstSet = true
					} else if v != firstVal {
						entry.Differs = true
					}
				}
			}
		}

		settings = append(settings, entry)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"settings":  settings,
		"instances": instances,
	})
}

// ---------------------------------------------------------------------------
// Compare Metrics
// ---------------------------------------------------------------------------

// handleCompareMetrics returns key system and async metrics across all instances.
func (s *Server) handleCompareMetrics(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	instances := s.manager.Names()

	// Per-instance: metric name -> value.
	var mu sync.Mutex
	perInstance := make(map[string]map[string]float64, len(instances))

	errs := s.manager.ForEachParallel(ctx, func(ctx context.Context, name string, client *chclient.Client) error {
		asyncRows, err := client.Query(ctx, `
			SELECT metric, value FROM system.asynchronous_metrics
			WHERE metric IN ('MemoryResident','OSMemoryTotal','OSMemoryAvailable','LoadAverage1','LoadAverage5','LoadAverage15','CGroupMaxCPU','CGroupMemoryUsed')
		`)
		if err != nil {
			return fmt.Errorf("query async metrics: %w", err)
		}

		syncRows, err := client.Query(ctx, `
			SELECT metric, value FROM system.metrics
			WHERE metric IN ('Query','Merge','PartMutation','MemoryTracking','MarkCacheBytes','MarkCacheFiles')
		`)
		if err != nil {
			return fmt.Errorf("query metrics: %w", err)
		}

		metrics := make(map[string]float64)
		for _, row := range asyncRows {
			metrics[toString(row["metric"])] = toFloat64(row["value"])
		}
		for _, row := range syncRows {
			metrics[toString(row["metric"])] = toFloat64(row["value"])
		}

		mu.Lock()
		perInstance[name] = metrics
		mu.Unlock()
		return nil
	})

	if len(errs) > 0 {
		for name, err := range errs {
			slog.Error("compare metrics: instance error", "instance", name, "err", err)
		}
	}

	// Collect all unique metric names.
	allMetrics := make(map[string]struct{})
	for _, metrics := range perInstance {
		for name := range metrics {
			allMetrics[name] = struct{}{}
		}
	}

	sortedMetrics := make([]string, 0, len(allMetrics))
	for name := range allMetrics {
		sortedMetrics = append(sortedMetrics, name)
	}
	sort.Strings(sortedMetrics)

	bytesMetrics := map[string]bool{
		"MemoryResident":    true,
		"OSMemoryTotal":     true,
		"OSMemoryAvailable": true,
		"CGroupMemoryUsed":  true,
		"MemoryTracking":    true,
		"MarkCacheBytes":    true,
	}

	type metricEntry struct {
		Name   string             `json:"name"`
		Values map[string]float64 `json:"values"`
		Unit   string             `json:"unit"`
	}

	metrics := make([]metricEntry, 0, len(sortedMetrics))
	for _, name := range sortedMetrics {
		entry := metricEntry{
			Name:   name,
			Values: make(map[string]float64),
			Unit:   "number",
		}
		if bytesMetrics[name] {
			entry.Unit = "bytes"
		}

		for _, inst := range instances {
			if m, ok := perInstance[inst]; ok {
				if v, ok := m[name]; ok {
					entry.Values[inst] = v
				}
			}
		}

		metrics = append(metrics, entry)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"metrics":   metrics,
		"instances": instances,
	})
}

// ---------------------------------------------------------------------------
// Table Memory (single instance)
// ---------------------------------------------------------------------------

// handleTableMemory returns per-table memory usage (primary key, marks, disk)
// for a single instance.
func (s *Server) handleTableMemory(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	rows, err := client.Query(ctx, "SELECT database, `table` as table_name, "+
		"formatReadableSize(sum(primary_key_bytes_in_memory)) as pk_readable, "+
		"sum(primary_key_bytes_in_memory) as pk_bytes, "+
		"formatReadableSize(sum(marks_bytes)) as marks_readable, "+
		"sum(marks_bytes) as marks_bytes_total, "+
		"sum(marks) as mark_count, "+
		"count() as parts, "+
		"sum(rows) as total_rows, "+
		"formatReadableSize(sum(bytes_on_disk)) as disk_size "+
		"FROM system.parts WHERE active "+
		"GROUP BY database, table_name "+
		"ORDER BY sum(primary_key_bytes_in_memory) DESC")
	if err != nil {
		slog.Error("query table memory", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query table memory")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// Cache Stats (single instance)
// ---------------------------------------------------------------------------

// handleCacheStats returns cache and primary key memory statistics for a single
// instance, merging system.metrics and system.asynchronous_metrics.
func (s *Server) handleCacheStats(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	syncRows, err := client.Query(ctx, `
		SELECT metric, value FROM system.metrics
		WHERE metric IN ('MarkCacheBytes','MarkCacheFiles','FilesystemCacheSize','FilesystemCacheSizeLimit','FilesystemCacheElements')
	`)
	if err != nil {
		slog.Error("query cache metrics", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query cache metrics")
		return
	}

	asyncRows, err := client.Query(ctx, `
		SELECT metric, value FROM system.asynchronous_metrics
		WHERE metric IN ('TotalPrimaryKeyBytesInMemory','TotalPrimaryKeyBytesInMemoryAllocated','TotalIndexGranularityBytesInMemory')
	`)
	if err != nil {
		slog.Error("query async cache metrics", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query async cache metrics")
		return
	}

	// Merge into a flat map.
	all := make(map[string]float64)
	for _, row := range syncRows {
		all[toString(row["metric"])] = toFloat64(row["value"])
	}
	for _, row := range asyncRows {
		all[toString(row["metric"])] = toFloat64(row["value"])
	}

	result := map[string]interface{}{
		"mark_cache_bytes":        all["MarkCacheBytes"],
		"mark_cache_files":        all["MarkCacheFiles"],
		"filesystem_cache_bytes":  all["FilesystemCacheSize"],
		"filesystem_cache_limit":  all["FilesystemCacheSizeLimit"],
		"filesystem_cache_elements": all["FilesystemCacheElements"],
		"primary_key_bytes":       all["TotalPrimaryKeyBytesInMemory"],
		"index_granularity_bytes": all["TotalIndexGranularityBytesInMemory"],
	}

	writeJSON(w, http.StatusOK, result)
}

// ---------------------------------------------------------------------------
// Compare Query Patterns
// ---------------------------------------------------------------------------

// handleCompareQueryPatterns fetches the top query patterns from each instance
// in parallel and merges them by normalized_query_hash so the UI can show
// side-by-side execution statistics across nodes.
func (s *Server) handleCompareQueryPatterns(w http.ResponseWriter, r *http.Request) {
	fromParam := r.URL.Query().Get("from")
	toParam := r.URL.Query().Get("to")
	now := time.Now()
	var fromTime, toTime string
	if fromParam == "" {
		fromTime = now.Add(-1 * time.Hour).Format("2006-01-02 15:04:05")
	} else {
		t := time.Unix(parseInt64(fromParam), 0)
		fromTime = t.Format("2006-01-02 15:04:05")
	}
	if toParam == "" {
		toTime = now.Format("2006-01-02 15:04:05")
	} else {
		t := time.Unix(parseInt64(toParam), 0)
		toTime = t.Format("2006-01-02 15:04:05")
	}

	type patternRow struct {
		Hash        string  `json:"hash"`
		Label       string  `json:"label"`
		Kind        string  `json:"kind"`
		Cnt         float64 `json:"cnt"`
		TotalMs     float64 `json:"total_ms"`
		AvgMs       float64 `json:"avg_ms"`
		MaxMs       float64 `json:"max_ms"`
		P95Ms       float64 `json:"p95_ms"`
		AvgReadRows float64 `json:"avg_read_rows"`
		Failures    float64 `json:"failures"`
		User        string  `json:"user"`
	}

	type instanceResult struct {
		Instance string       `json:"instance"`
		Patterns []patternRow `json:"patterns"`
		Error    string       `json:"error,omitempty"`
	}

	names := s.manager.Names()
	results := make([]instanceResult, len(names))

	reqCtx := r.Context()
	var wg sync.WaitGroup
	for i, name := range names {
		wg.Add(1)
		go func(idx int, instName string) {
			defer wg.Done()
			results[idx] = instanceResult{Instance: instName}

			client := s.manager.Get(instName)
			if client == nil {
				results[idx].Error = "not found"
				return
			}

			ctx, cancel := context.WithTimeout(reqCtx, 15*time.Second)
			defer cancel()

			sql := fmt.Sprintf(`SELECT
				normalized_query_hash AS hash,
				any(substring(query_text, 1, 100)) AS label,
				any(query_kind) AS kind,
				count() AS cnt,
				sum(query_duration_ms) AS total_ms,
				avg(query_duration_ms) AS avg_ms,
				max(query_duration_ms) AS max_ms,
				quantile(0.95)(query_duration_ms) AS p95_ms,
				avg(read_rows) AS avg_read_rows,
				countIf(is_exception = 1) AS failures,
				any(user) AS user
			FROM ch_analyzer.query_samples
			WHERE event_time >= '%s' AND event_time <= '%s'
			GROUP BY hash
			ORDER BY total_ms DESC
			LIMIT 30`, fromTime, toTime)

			rows, err := client.Query(ctx, sql)
			if err != nil || len(rows) == 0 {
				// Fallback to system.query_log.
				sql = fmt.Sprintf(`SELECT
					normalized_query_hash AS hash,
					any(substring(query, 1, 100)) AS label,
					any(query_kind) AS kind,
					count() AS cnt,
					sum(query_duration_ms) AS total_ms,
					avg(query_duration_ms) AS avg_ms,
					max(query_duration_ms) AS max_ms,
					quantile(0.95)(query_duration_ms) AS p95_ms,
					avg(read_rows) AS avg_read_rows,
					countIf(type = 'ExceptionWhileProcessing') AS failures,
					any(user) AS user
				FROM system.query_log
				WHERE event_time >= '%s' AND event_time <= '%s'
				  AND is_initial_query = 1
				  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
				GROUP BY hash
				ORDER BY total_ms DESC
				LIMIT 30`, fromTime, toTime)
				rows, err = client.Query(ctx, sql)
				if err != nil {
					results[idx].Error = err.Error()
					return
				}
			}

			patterns := make([]patternRow, 0, len(rows))
			for _, row := range rows {
				patterns = append(patterns, patternRow{
					Hash:        toString(row["hash"]),
					Label:       toString(row["label"]),
					Kind:        toString(row["kind"]),
					Cnt:         toFloat64(row["cnt"]),
					TotalMs:     toFloat64(row["total_ms"]),
					AvgMs:       toFloat64(row["avg_ms"]),
					MaxMs:       toFloat64(row["max_ms"]),
					P95Ms:       toFloat64(row["p95_ms"]),
					AvgReadRows: toFloat64(row["avg_read_rows"]),
					Failures:    toFloat64(row["failures"]),
					User:        toString(row["user"]),
				})
			}
			results[idx].Patterns = patterns
		}(i, name)
	}
	wg.Wait()

	writeJSON(w, http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// Value conversion helpers
// ---------------------------------------------------------------------------

// toString extracts a string from an interface{} value returned by ClickHouse
// JSON results. Handles string, json.Number, and nil.
func toString(v interface{}) string {
	if v == nil {
		return ""
	}
	switch val := v.(type) {
	case string:
		return val
	default:
		return fmt.Sprintf("%v", val)
	}
}
