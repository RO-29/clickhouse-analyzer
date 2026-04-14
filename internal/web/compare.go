package web

import (
	"context"
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

// handleCompareTables returns table metadata across all instances, merged by
// database.table with row-drift percentages and missing-node annotations.
func (s *Server) handleCompareTables(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	instances := s.manager.Names()

	type tableInfo struct {
		Rows       float64 `json:"rows"`
		Bytes      float64 `json:"bytes"`
		Size       string  `json:"size"`
		Parts      float64 `json:"parts"`
		PKBytes    float64 `json:"pk_bytes"`
		MarksBytes float64 `json:"marks_bytes"`
	}

	// Per-instance results collected in parallel.
	type instanceData struct {
		tables map[string]tableInfo // key: "database.table"
		engine map[string]string    // key: "database.table" -> engine
	}

	var mu sync.Mutex
	perInstance := make(map[string]*instanceData, len(instances))

	errs := s.manager.ForEachParallel(ctx, func(ctx context.Context, name string, client *chclient.Client) error {
		// Query 1: table metadata.
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

		// Query 2: parts + primary key memory.
		partsRows, err := client.Query(ctx, `
			SELECT database, ` + "`table`" + ` as table_name,
				count() as parts,
				sum(primary_key_bytes_in_memory) as pk_bytes,
				sum(marks_bytes) as marks_bytes_total,
				sum(marks) as mark_count
			FROM system.parts WHERE active
			GROUP BY database, table_name
		`)
		if err != nil {
			return fmt.Errorf("query parts: %w", err)
		}

		data := &instanceData{
			tables: make(map[string]tableInfo),
			engine: make(map[string]string),
		}

		for _, row := range tableRows {
			db := toString(row["database"])
			tbl := toString(row["table_name"])
			key := db + "." + tbl
			data.tables[key] = tableInfo{
				Rows:  toFloat64(row["total_rows"]),
				Bytes: toFloat64(row["total_bytes"]),
				Size:  toString(row["size_readable"]),
			}
			data.engine[key] = toString(row["engine"])
		}

		// Merge parts data.
		for _, row := range partsRows {
			db := toString(row["database"])
			tbl := toString(row["table_name"])
			key := db + "." + tbl
			if ti, ok := data.tables[key]; ok {
				ti.Parts = toFloat64(row["parts"])
				ti.PKBytes = toFloat64(row["pk_bytes"])
				ti.MarksBytes = toFloat64(row["marks_bytes_total"])
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

	// Collect all unique table keys and engines.
	allKeys := make(map[string]string) // key -> engine
	for _, data := range perInstance {
		for key, eng := range data.engine {
			allKeys[key] = eng
		}
	}

	// Sort keys for deterministic output.
	sortedKeys := make([]string, 0, len(allKeys))
	for k := range allKeys {
		sortedKeys = append(sortedKeys, k)
	}
	sort.Strings(sortedKeys)

	type nodeInfo struct {
		Rows       float64 `json:"rows"`
		Bytes      float64 `json:"bytes"`
		Size       string  `json:"size"`
		Parts      float64 `json:"parts"`
		PKBytes    float64 `json:"pk_bytes"`
		MarksBytes float64 `json:"marks_bytes"`
	}

	type tableEntry struct {
		Database       string              `json:"database"`
		Table          string              `json:"table"`
		Engine         string              `json:"engine"`
		Nodes          map[string]nodeInfo `json:"nodes"`
		MaxRowDiffPct  float64             `json:"max_row_diff_pct"`
		MissingOn      []string            `json:"missing_on,omitempty"`
	}

	tables := make([]tableEntry, 0, len(sortedKeys))
	for _, key := range sortedKeys {
		parts := strings.SplitN(key, ".", 2)
		if len(parts) != 2 {
			continue
		}
		db, tbl := parts[0], parts[1]

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
			entry.Nodes[inst] = nodeInfo{
				Rows:       ti.Rows,
				Bytes:      ti.Bytes,
				Size:       ti.Size,
				Parts:      ti.Parts,
				PKBytes:    ti.PKBytes,
				MarksBytes: ti.MarksBytes,
			}
			if first {
				maxRows = ti.Rows
				minRows = ti.Rows
				first = false
			} else {
				if ti.Rows > maxRows {
					maxRows = ti.Rows
				}
				if ti.Rows < minRows {
					minRows = ti.Rows
				}
			}
		}

		if maxRows > 0 {
			entry.MaxRowDiffPct = math.Round((maxRows-minRows)/maxRows*1000) / 10
		}
		if len(missingOn) > 0 {
			entry.MissingOn = missingOn
		}

		tables = append(tables, entry)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"tables":    tables,
		"instances": instances,
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
