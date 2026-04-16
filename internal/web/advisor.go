package web

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// ---------------------------------------------------------------------------
// 1. Advisor: Compression
// ---------------------------------------------------------------------------

func (s *Server) handleAdvisorCompression(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	rows, err := client.Query(ctx, "SELECT database, "+
		"`table` as table_name, "+
		"formatReadableSize(sum(data_compressed_bytes)) as compressed, "+
		"formatReadableSize(sum(data_uncompressed_bytes)) as uncompressed, "+
		"sum(data_compressed_bytes) as compressed_bytes, "+
		"sum(data_uncompressed_bytes) as uncompressed_bytes, "+
		"round(sum(data_uncompressed_bytes)/nullIf(sum(data_compressed_bytes),0), 2) as ratio, "+
		"count() as column_count "+
		"FROM system.columns "+
		"WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer') "+
		"GROUP BY database, table_name "+
		"HAVING sum(data_compressed_bytes) > 0 "+
		"ORDER BY sum(data_compressed_bytes) DESC")
	if err != nil {
		slog.Error("advisor compression", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query compression data")
		return
	}

	type recommendation struct {
		Text     string `json:"text"`
		Fix      string `json:"fix"`
		Severity string `json:"severity"`
	}

	type tableResult struct {
		Database        string           `json:"database"`
		TableName       string           `json:"table_name"`
		Compressed      string           `json:"compressed"`
		Uncompressed    string           `json:"uncompressed"`
		CompressedBytes float64          `json:"compressed_bytes"`
		UncompressedBytes float64        `json:"uncompressed_bytes"`
		Ratio           float64          `json:"ratio"`
		ColumnCount     float64          `json:"column_count"`
		Recommendations []recommendation `json:"recommendations"`
	}

	results := make([]tableResult, 0, len(rows))
	for _, row := range rows {
		db := toString(row["database"])
		tbl := toString(row["table_name"])
		ratio := toFloat64(row["ratio"])

		tr := tableResult{
			Database:          db,
			TableName:         tbl,
			Compressed:        toString(row["compressed"]),
			Uncompressed:      toString(row["uncompressed"]),
			CompressedBytes:   toFloat64(row["compressed_bytes"]),
			UncompressedBytes: toFloat64(row["uncompressed_bytes"]),
			Ratio:             ratio,
			ColumnCount:       toFloat64(row["column_count"]),
			Recommendations:   []recommendation{},
		}

		if ratio > 0 && ratio < 2.0 {
			severity := "warn"
			if ratio < 1.5 {
				severity = "critical"
			}
			tr.Recommendations = append(tr.Recommendations, recommendation{
				Text:     "Poor compression ratio. Consider ZSTD codec.",
				Fix:      fmt.Sprintf("ALTER TABLE %s.%s MODIFY COLUMN ... CODEC(ZSTD(1))", db, tbl),
				Severity: severity,
			})
		}

		results = append(results, tr)
	}

	writeJSON(w, http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// 2. Advisor: Query Regression
// ---------------------------------------------------------------------------

func (s *Server) handleAdvisorQueryRegression(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	// Current hour stats.
	// hex() ensures normalized_query_hash is returned as a string — avoids float64 precision
	// loss when Go's JSON decoder reads UInt64 values.
	currentRows, err := client.Query(ctx,
		"SELECT hex(normalized_query_hash) as normalized_query_hash, count() as cnt, "+
			"avg(query_duration_ms) as avg_ms, max(query_duration_ms) as max_ms, "+
			"avg(memory_usage) as avg_mem, avg(read_rows) as avg_rows, "+
			"any(query_kind) as kind, any(user) as user, "+
			"substring(any(query), 1, 4000) as sample_query "+
			"FROM system.query_log "+
			"WHERE type = 'QueryFinish' AND event_time >= now() - INTERVAL 1 HOUR "+
			"GROUP BY normalized_query_hash HAVING cnt >= 10")
	if err != nil {
		slog.Error("advisor query regression: current", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query current hour stats")
		return
	}

	// Same hour yesterday.
	yesterdayRows, err := client.Query(ctx,
		"SELECT hex(normalized_query_hash) as normalized_query_hash, avg(query_duration_ms) as avg_ms, count() as cnt "+
			"FROM system.query_log "+
			"WHERE type = 'QueryFinish' "+
			"AND event_time >= now() - INTERVAL 25 HOUR AND event_time <= now() - INTERVAL 24 HOUR "+
			"GROUP BY normalized_query_hash")
	if err != nil {
		slog.Error("advisor query regression: yesterday", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query yesterday stats")
		return
	}

	// Rolling 24h average.
	rolling24hRows, err := client.Query(ctx,
		"SELECT hex(normalized_query_hash) as normalized_query_hash, avg(query_duration_ms) as avg_ms, count() as cnt "+
			"FROM system.query_log "+
			"WHERE type = 'QueryFinish' "+
			"AND event_time >= now() - INTERVAL 24 HOUR AND event_time < now() - INTERVAL 1 HOUR "+
			"GROUP BY normalized_query_hash")
	if err != nil {
		slog.Error("advisor query regression: rolling 24h", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query rolling 24h stats")
		return
	}

	// Index yesterday and rolling averages by hash.
	yesterdayByHash := make(map[string]float64, len(yesterdayRows))
	for _, row := range yesterdayRows {
		hash := toString(row["normalized_query_hash"])
		yesterdayByHash[hash] = toFloat64(row["avg_ms"])
	}

	rolling24hByHash := make(map[string]float64, len(rolling24hRows))
	for _, row := range rolling24hRows {
		hash := toString(row["normalized_query_hash"])
		rolling24hByHash[hash] = toFloat64(row["avg_ms"])
	}

	type regressionResult struct {
		Hash                string  `json:"normalized_query_hash"`
		Count               float64 `json:"cnt"`
		AvgMs               float64 `json:"avg_ms"`
		MaxMs               float64 `json:"max_ms"`
		AvgMem              float64 `json:"avg_mem"`
		AvgRows             float64 `json:"avg_rows"`
		Kind                string  `json:"kind"`
		User                string  `json:"user"`
		SampleQuery         string  `json:"sample_query"`
		YesterdayAvgMs      float64 `json:"yesterday_avg_ms"`
		Rolling24hAvgMs     float64 `json:"rolling_24h_avg_ms"`
		RegressionVsYesterday float64 `json:"regression_vs_yesterday"`
		RegressionVs24h     float64 `json:"regression_vs_24h"`
		Flagged             bool    `json:"flagged"`
	}

	var results []regressionResult
	for _, row := range currentRows {
		hash := toString(row["normalized_query_hash"])
		currentAvg := toFloat64(row["avg_ms"])

		// Strip trailing FORMAT clause added by the ClickHouse client (e.g. " FORMAT JSON").
		sampleQuery := toString(row["sample_query"])
		if i := strings.LastIndex(strings.ToUpper(sampleQuery), " FORMAT "); i > 0 {
			sampleQuery = strings.TrimRight(sampleQuery[:i], " \t\n\r")
		}

		rr := regressionResult{
			Hash:        hash,
			Count:       toFloat64(row["cnt"]),
			AvgMs:       currentAvg,
			MaxMs:       toFloat64(row["max_ms"]),
			AvgMem:      toFloat64(row["avg_mem"]),
			AvgRows:     toFloat64(row["avg_rows"]),
			Kind:        toString(row["kind"]),
			User:        toString(row["user"]),
			SampleQuery: sampleQuery,
		}

		if yAvg, ok := yesterdayByHash[hash]; ok && yAvg > 0 {
			rr.YesterdayAvgMs = yAvg
			rr.RegressionVsYesterday = currentAvg / yAvg
		}

		if rAvg, ok := rolling24hByHash[hash]; ok && rAvg > 0 {
			rr.Rolling24hAvgMs = rAvg
			rr.RegressionVs24h = currentAvg / rAvg
		}

		if rr.RegressionVsYesterday > 2.0 || rr.RegressionVs24h > 2.0 {
			rr.Flagged = true
		}

		// Only include queries that actually regressed.
		if rr.Flagged {
			results = append(results, rr)
		}
	}

	// Sort by worst regression (max of the two ratios) descending.
	sort.Slice(results, func(i, j int) bool {
		maxI := results[i].RegressionVsYesterday
		if results[i].RegressionVs24h > maxI {
			maxI = results[i].RegressionVs24h
		}
		maxJ := results[j].RegressionVsYesterday
		if results[j].RegressionVs24h > maxJ {
			maxJ = results[j].RegressionVs24h
		}
		return maxI > maxJ
	})

	writeJSON(w, http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// 3. Advisor: New Patterns
// ---------------------------------------------------------------------------

func (s *Server) handleAdvisorNewPatterns(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	// Patterns in last 1h with >= 100 occurrences.
	recentRows, err := client.Query(ctx,
		"SELECT normalized_query_hash, count() as cnt, "+
			"avg(query_duration_ms) as avg_ms, any(user) as user, "+
			"substring(any(query), 1, 200) as sample_query "+
			"FROM system.query_log "+
			"WHERE type = 'QueryFinish' AND event_time >= now() - INTERVAL 1 HOUR "+
			"GROUP BY normalized_query_hash HAVING cnt >= 100")
	if err != nil {
		slog.Error("advisor new patterns: recent", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query recent patterns")
		return
	}

	if len(recentRows) == 0 {
		writeJSON(w, http.StatusOK, []interface{}{})
		return
	}

	// Get all hashes seen in previous 24h.
	previousRows, err := client.Query(ctx,
		"SELECT DISTINCT normalized_query_hash "+
			"FROM system.query_log "+
			"WHERE type = 'QueryFinish' "+
			"AND event_time >= now() - INTERVAL 25 HOUR AND event_time < now() - INTERVAL 1 HOUR")
	if err != nil {
		slog.Error("advisor new patterns: previous", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query previous patterns")
		return
	}

	previousHashes := make(map[string]struct{}, len(previousRows))
	for _, row := range previousRows {
		previousHashes[toString(row["normalized_query_hash"])] = struct{}{}
	}

	// Filter to only genuinely new patterns.
	var results []map[string]interface{}
	for _, row := range recentRows {
		hash := toString(row["normalized_query_hash"])
		if _, existed := previousHashes[hash]; !existed {
			results = append(results, row)
		}
	}

	if results == nil {
		results = []map[string]interface{}{}
	}

	writeJSON(w, http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// 4. Advisor: Unused Tables
// ---------------------------------------------------------------------------

func (s *Server) handleAdvisorUnusedTables(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	// All tables.
	allTables, err := client.Query(ctx,
		"SELECT database, name as table_name, engine, "+
			"total_rows, total_bytes, formatReadableSize(total_bytes) as size_readable, "+
			"metadata_modification_time "+
			"FROM system.tables "+
			"WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer') "+
			"AND total_bytes > 0")
	if err != nil {
		slog.Error("advisor unused tables: all tables", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query tables")
		return
	}

	// Tables referenced in queries last 30 days.
	refRows, err := client.Query(ctx,
		"SELECT DISTINCT arrayJoin(tables) as table_ref "+
			"FROM system.query_log "+
			"WHERE event_time >= now() - INTERVAL 30 DAY "+
			"AND type = 'QueryFinish' "+
			"AND length(tables) > 0")
	if err != nil {
		slog.Error("advisor unused tables: referenced tables", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query referenced tables")
		return
	}

	referencedSet := make(map[string]struct{}, len(refRows))
	for _, row := range refRows {
		referencedSet[toString(row["table_ref"])] = struct{}{}
	}

	var results []map[string]interface{}
	for _, row := range allTables {
		db := toString(row["database"])
		tbl := toString(row["table_name"])
		fullName := db + "." + tbl
		if _, used := referencedSet[fullName]; !used {
			results = append(results, row)
		}
	}

	if results == nil {
		results = []map[string]interface{}{}
	}

	writeJSON(w, http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// 5. Advisor: Schema
// ---------------------------------------------------------------------------

func (s *Server) handleAdvisorSchema(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	// MergeTree tables.
	tableRows, err := client.Query(ctx,
		"SELECT database, name as table_name, engine, engine_full, "+
			"partition_key, sorting_key, primary_key, storage_policy "+
			"FROM system.tables "+
			"WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer') "+
			"AND engine LIKE '%MergeTree%'")
	if err != nil {
		slog.Error("advisor schema: tables", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query schema tables")
		return
	}

	// Partition counts.
	partRows, err := client.Query(ctx,
		"SELECT database, `table` as table_name, count(DISTINCT partition_id) as partition_count "+
			"FROM system.parts WHERE active "+
			"GROUP BY database, table_name")
	if err != nil {
		slog.Error("advisor schema: partitions", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query partition counts")
		return
	}

	// Column counts per table.
	colCountRows, err := client.Query(ctx,
		"SELECT database, `table` as table_name, count() as col_count "+
			"FROM system.columns "+
			"WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer') "+
			"GROUP BY database, table_name")
	if err != nil {
		slog.Error("advisor schema: column counts", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query column counts")
		return
	}

	// Table sizes.
	sizeRows, err := client.Query(ctx,
		"SELECT database, name as table_name, total_bytes "+
			"FROM system.tables "+
			"WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer') "+
			"AND engine LIKE '%MergeTree%'")
	if err != nil {
		slog.Error("advisor schema: sizes", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query table sizes")
		return
	}

	// Nullable column counts (only tables with > 5).
	nullableRows, err := client.Query(ctx,
		"SELECT database, `table` as table_name, count() as nullable_count "+
			"FROM system.columns "+
			"WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer') "+
			"AND type LIKE 'Nullable%' "+
			"GROUP BY database, table_name "+
			"HAVING nullable_count > 5")
	if err != nil {
		slog.Error("advisor schema: nullable", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query nullable columns")
		return
	}

	// Build lookup maps.
	type tableKey = string // "db.table"

	partitionCounts := make(map[tableKey]float64, len(partRows))
	for _, row := range partRows {
		key := toString(row["database"]) + "." + toString(row["table_name"])
		partitionCounts[key] = toFloat64(row["partition_count"])
	}

	colCounts := make(map[tableKey]float64, len(colCountRows))
	for _, row := range colCountRows {
		key := toString(row["database"]) + "." + toString(row["table_name"])
		colCounts[key] = toFloat64(row["col_count"])
	}

	tableSizes := make(map[tableKey]float64, len(sizeRows))
	for _, row := range sizeRows {
		key := toString(row["database"]) + "." + toString(row["table_name"])
		tableSizes[key] = toFloat64(row["total_bytes"])
	}

	nullableCounts := make(map[tableKey]float64, len(nullableRows))
	for _, row := range nullableRows {
		key := toString(row["database"]) + "." + toString(row["table_name"])
		nullableCounts[key] = toFloat64(row["nullable_count"])
	}

	type schemaRec struct {
		Text     string `json:"text"`
		Severity string `json:"severity"`
	}

	type schemaResult struct {
		Database       string      `json:"database"`
		TableName      string      `json:"table_name"`
		Engine         string      `json:"engine"`
		EngineFull     string      `json:"engine_full"`
		PartitionKey   string      `json:"partition_key"`
		SortingKey     string      `json:"sorting_key"`
		PrimaryKey     string      `json:"primary_key"`
		StoragePolicy  string      `json:"storage_policy"`
		PartitionCount float64     `json:"partition_count"`
		ColumnCount    float64     `json:"column_count"`
		TotalBytes     float64     `json:"total_bytes"`
		NullableCount  float64     `json:"nullable_count"`
		Recommendations []schemaRec `json:"recommendations"`
	}

	const oneGiB = 1024.0 * 1024 * 1024
	const oneTiB = oneGiB * 1024

	results := make([]schemaResult, 0, len(tableRows))
	for _, row := range tableRows {
		db := toString(row["database"])
		tbl := toString(row["table_name"])
		key := db + "." + tbl
		engineFull := toString(row["engine_full"])

		sr := schemaResult{
			Database:       db,
			TableName:      tbl,
			Engine:         toString(row["engine"]),
			EngineFull:     engineFull,
			PartitionKey:   toString(row["partition_key"]),
			SortingKey:     toString(row["sorting_key"]),
			PrimaryKey:     toString(row["primary_key"]),
			StoragePolicy:  toString(row["storage_policy"]),
			PartitionCount: partitionCounts[key],
			ColumnCount:    colCounts[key],
			TotalBytes:     tableSizes[key],
			NullableCount:  nullableCounts[key],
			Recommendations: []schemaRec{},
		}

		if sr.PartitionCount > 100 {
			sr.Recommendations = append(sr.Recommendations, schemaRec{
				Text:     fmt.Sprintf("Too many partitions (%.0f) — consider coarser partition key", sr.PartitionCount),
				Severity: "warn",
			})
		}

		if sr.ColumnCount > 30 {
			sr.Recommendations = append(sr.Recommendations, schemaRec{
				Text:     fmt.Sprintf("Wide table (%.0f columns) — consider projections for common queries", sr.ColumnCount),
				Severity: "info",
			})
		}

		hasTTL := strings.Contains(strings.ToUpper(engineFull), "TTL")
		if !hasTTL && sr.TotalBytes > oneTiB {
			sr.Recommendations = append(sr.Recommendations, schemaRec{
				Text:     fmt.Sprintf("Large table (%s) without TTL — consider adding data lifecycle", formatBytes(sr.TotalBytes)),
				Severity: "warn",
			})
		}

		if sr.NullableCount > 5 {
			sr.Recommendations = append(sr.Recommendations, schemaRec{
				Text:     fmt.Sprintf("%.0f Nullable columns — Nullable adds overhead, consider defaults instead", sr.NullableCount),
				Severity: "info",
			})
		}

		if len(sr.Recommendations) > 0 {
			results = append(results, sr)
		}
	}

	writeJSON(w, http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// 6. Advisor: Cardinality
// ---------------------------------------------------------------------------

func (s *Server) handleAdvisorCardinality(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	// Find String columns (non-LowCardinality).
	colRows, err := client.Query(ctx,
		"SELECT database, `table` as table_name, name as column_name, type "+
			"FROM system.columns "+
			"WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer') "+
			"AND type = 'String' "+
			"AND default_kind = '' "+
			"ORDER BY database, table_name "+
			"LIMIT 50")
	if err != nil {
		slog.Error("advisor cardinality: columns", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query string columns")
		return
	}

	type cardResult struct {
		Database    string  `json:"database"`
		TableName   string  `json:"table_name"`
		ColumnName  string  `json:"column_name"`
		ColumnType  string  `json:"type"`
		Cardinality float64 `json:"cardinality"`
		Recommend   bool    `json:"recommend_low_cardinality"`
		Error       string  `json:"error,omitempty"`
	}

	results := make([]cardResult, 0, len(colRows))
	for _, row := range colRows {
		db := toString(row["database"])
		tbl := toString(row["table_name"])
		col := toString(row["column_name"])

		cr := cardResult{
			Database:   db,
			TableName:  tbl,
			ColumnName: col,
			ColumnType: toString(row["type"]),
		}

		// Sample 100K rows to estimate distinct count (subquery limits scan, not output).
		sql := fmt.Sprintf("SELECT uniq(`%s`) as card FROM (SELECT `%s` FROM `%s`.`%s` LIMIT 100000)", col, col, db, tbl)
		cardRows, err := client.Query(ctx, sql)
		if err != nil {
			cr.Error = err.Error()
			results = append(results, cr)
			continue
		}

		if len(cardRows) > 0 {
			cr.Cardinality = toFloat64(cardRows[0]["card"])
			// Only recommend if the table has actual data (cardinality > 0)
			// and distinct count is low enough to benefit from LowCardinality.
			if cr.Cardinality > 0 && cr.Cardinality < 10000 {
				cr.Recommend = true
			}
		}

		// Skip columns with no data or high cardinality — not actionable.
		if !cr.Recommend {
			continue
		}
		results = append(results, cr)
	}

	// Sort by cardinality ascending — lowest distinct count = best candidates first.
	sort.Slice(results, func(i, j int) bool {
		return results[i].Cardinality < results[j].Cardinality
	})

	writeJSON(w, http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// 7. Advisor: Storage Policy
// ---------------------------------------------------------------------------

func (s *Server) handleAdvisorStoragePolicy(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	rows, err := client.Query(ctx,
		"SELECT database, name as table_name, engine_full, "+
			"total_bytes, formatReadableSize(total_bytes) as size_readable "+
			"FROM system.tables "+
			"WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema','ch_analyzer') "+
			"AND engine LIKE '%MergeTree%' "+
			"AND total_bytes > 0 "+
			"ORDER BY total_bytes DESC")
	if err != nil {
		slog.Error("advisor storage policy", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query storage policy data")
		return
	}

	type policyRec struct {
		Text     string `json:"text"`
		Severity string `json:"severity"`
	}

	type policyResult struct {
		Database        string      `json:"database"`
		TableName       string      `json:"table_name"`
		EngineFull      string      `json:"engine_full"`
		TotalBytes      float64     `json:"total_bytes"`
		SizeReadable    string      `json:"size_readable"`
		StoragePolicy   string      `json:"storage_policy"`
		HasTTL          bool        `json:"has_ttl"`
		TTLExpression   string      `json:"ttl_expression,omitempty"`
		Recommendations []policyRec `json:"recommendations"`
	}

	const oneGiB = 1024.0 * 1024 * 1024
	const oneTiB = oneGiB * 1024
	const hundredGiB = 100 * oneGiB

	results := make([]policyResult, 0, len(rows))
	for _, row := range rows {
		engineFull := toString(row["engine_full"])
		totalBytes := toFloat64(row["total_bytes"])

		pr := policyResult{
			Database:        toString(row["database"]),
			TableName:       toString(row["table_name"]),
			EngineFull:      engineFull,
			TotalBytes:      totalBytes,
			SizeReadable:    toString(row["size_readable"]),
			Recommendations: []policyRec{},
		}

		// Extract storage policy from engine_full.
		upperEF := strings.ToUpper(engineFull)
		if idx := strings.Index(upperEF, "STORAGE_POLICY"); idx >= 0 {
			// Try to extract the policy value.
			sub := engineFull[idx:]
			// Look for pattern: storage_policy = 'value' or storage_policy = value
			if eqIdx := strings.Index(sub, "="); eqIdx >= 0 {
				val := strings.TrimSpace(sub[eqIdx+1:])
				val = strings.Trim(val, "' ")
				// Take up to next comma or paren.
				for i, c := range val {
					if c == ',' || c == ')' {
						val = val[:i]
						break
					}
				}
				pr.StoragePolicy = strings.TrimSpace(val)
			}
		}

		// Check for TTL.
		if strings.Contains(upperEF, "TTL") {
			pr.HasTTL = true
			if idx := strings.Index(upperEF, "TTL"); idx >= 0 {
				ttlSub := engineFull[idx:]
				// Take up to SETTINGS or end.
				if setIdx := strings.Index(strings.ToUpper(ttlSub), "SETTINGS"); setIdx >= 0 {
					ttlSub = ttlSub[:setIdx]
				}
				pr.TTLExpression = strings.TrimSpace(ttlSub)
			}
		}

		// Recommendations.
		if !pr.HasTTL && totalBytes > oneTiB {
			pr.Recommendations = append(pr.Recommendations, policyRec{
				Text:     fmt.Sprintf("Large table (%s) without TTL — consider adding data lifecycle rules", formatBytes(totalBytes)),
				Severity: "warn",
			})
		}

		isDefaultPolicy := pr.StoragePolicy == "" || pr.StoragePolicy == "default"
		if isDefaultPolicy && totalBytes > hundredGiB {
			pr.Recommendations = append(pr.Recommendations, policyRec{
				Text:     fmt.Sprintf("Large table (%s) on default storage policy — consider tiered storage", formatBytes(totalBytes)),
				Severity: "info",
			})
		}

		if len(pr.Recommendations) > 0 {
			results = append(results, pr)
		}
	}

	writeJSON(w, http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// 8. Table Detail
// ---------------------------------------------------------------------------

func (s *Server) handleTableDetail(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	db := r.PathValue("db")
	table := r.PathValue("table")
	if db == "" || table == "" {
		writeErr(w, http.StatusBadRequest, "database and table path parameters are required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	result := make(map[string]interface{})

	// a) Table metadata.
	metaRows, err := client.Query(ctx,
		"SELECT database, name, engine, engine_full, partition_key, sorting_key, "+
			"primary_key, storage_policy, total_rows, total_bytes, "+
			"formatReadableSize(total_bytes) as size_readable, "+
			"metadata_modification_time "+
			"FROM system.tables WHERE database = '"+db+"' AND name = '"+table+"'")
	if err != nil {
		slog.Error("table detail: metadata", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query table metadata")
		return
	}
	if len(metaRows) == 0 {
		writeErr(w, http.StatusNotFound, "table not found")
		return
	}
	result["metadata"] = metaRows[0]

	// b) Parts per disk.
	partsDiskRows, err := client.Query(ctx,
		"SELECT disk_name, count() as parts, sum(rows) as rows, "+
			"formatReadableSize(sum(bytes_on_disk)) as size, "+
			"sum(bytes_on_disk) as bytes "+
			"FROM system.parts WHERE active AND database = '"+db+"' AND `table` = '"+table+"' "+
			"GROUP BY disk_name")
	if err != nil {
		slog.Error("table detail: parts by disk", "err", err, "instance", instance)
		result["parts_by_disk"] = []interface{}{}
	} else {
		result["parts_by_disk"] = partsDiskRows
	}

	// c) Partition count.
	partCountRows, err := client.Query(ctx,
		"SELECT count(DISTINCT partition_id) as partition_count "+
			"FROM system.parts WHERE active AND database = '"+db+"' AND `table` = '"+table+"'")
	if err != nil {
		slog.Error("table detail: partition count", "err", err, "instance", instance)
		result["partition_count"] = 0
	} else if len(partCountRows) > 0 {
		result["partition_count"] = toFloat64(partCountRows[0]["partition_count"])
	}

	// d) Primary key + marks memory.
	memRows, err := client.Query(ctx,
		"SELECT sum(primary_key_bytes_in_memory) as pk_bytes, "+
			"sum(marks_bytes) as marks_bytes, sum(marks) as mark_count "+
			"FROM system.parts WHERE active AND database = '"+db+"' AND `table` = '"+table+"'")
	if err != nil {
		slog.Error("table detail: memory", "err", err, "instance", instance)
		result["memory"] = map[string]interface{}{}
	} else if len(memRows) > 0 {
		result["memory"] = memRows[0]
	}

	// e) Compression ratio.
	compRows, err := client.Query(ctx,
		"SELECT formatReadableSize(sum(data_compressed_bytes)) as compressed, "+
			"formatReadableSize(sum(data_uncompressed_bytes)) as uncompressed, "+
			"round(sum(data_uncompressed_bytes)/nullIf(sum(data_compressed_bytes),0),2) as ratio "+
			"FROM system.columns WHERE database = '"+db+"' AND `table` = '"+table+"'")
	if err != nil {
		slog.Error("table detail: compression", "err", err, "instance", instance)
		result["compression"] = map[string]interface{}{}
	} else if len(compRows) > 0 {
		result["compression"] = compRows[0]
	}

	// f) Recent merge activity (last 1h).
	mergeRows, err := client.Query(ctx,
		"SELECT event_type, count() as cnt, avg(duration_ms) as avg_ms "+
			"FROM system.part_log "+
			"WHERE database = '"+db+"' AND `table` = '"+table+"' AND event_time >= now() - INTERVAL 1 HOUR "+
			"GROUP BY event_type")
	if err != nil {
		slog.Error("table detail: merge activity", "err", err, "instance", instance)
		result["merge_activity"] = []interface{}{}
	} else {
		result["merge_activity"] = mergeRows
	}

	// g) Recent query patterns hitting this table.
	fullTableRef := db + "." + table
	queryPatRows, err := client.Query(ctx,
		"SELECT normalized_query_hash, count() as cnt, "+
			"avg(query_duration_ms) as avg_ms, any(user) as user, "+
			"substring(any(query),1,200) as sample "+
			"FROM system.query_log "+
			"WHERE type = 'QueryFinish' AND has(tables, '"+fullTableRef+"') "+
			"AND event_time >= now() - INTERVAL 1 HOUR "+
			"GROUP BY normalized_query_hash "+
			"ORDER BY cnt DESC LIMIT 10")
	if err != nil {
		slog.Error("table detail: query patterns", "err", err, "instance", instance)
		result["query_patterns"] = []interface{}{}
	} else {
		result["query_patterns"] = queryPatRows
	}

	// h) Same table on other nodes.
	type nodeTableInfo struct {
		Instance string  `json:"instance"`
		Rows     float64 `json:"rows"`
		Bytes    float64 `json:"bytes"`
		Size     string  `json:"size"`
		Parts    float64 `json:"parts"`
		Error    string  `json:"error,omitempty"`
	}

	var otherNodesMu sync.Mutex
	var otherNodes []nodeTableInfo

	otherCtx, otherCancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer otherCancel()

	s.manager.ForEachParallel(otherCtx, func(ctx context.Context, name string, c *chclient.Client) error {
		if name == instance {
			return nil
		}

		info := nodeTableInfo{Instance: name}

		tblRows, err := c.Query(ctx,
			"SELECT total_rows, total_bytes, formatReadableSize(total_bytes) as size_readable "+
				"FROM system.tables WHERE database = '"+db+"' AND name = '"+table+"'")
		if err != nil {
			info.Error = err.Error()
			otherNodesMu.Lock()
			otherNodes = append(otherNodes, info)
			otherNodesMu.Unlock()
			return nil
		}

		if len(tblRows) > 0 {
			info.Rows = toFloat64(tblRows[0]["total_rows"])
			info.Bytes = toFloat64(tblRows[0]["total_bytes"])
			info.Size = toString(tblRows[0]["size_readable"])
		}

		partsRows, err := c.Query(ctx,
			"SELECT count() as parts FROM system.parts "+
				"WHERE active AND database = '"+db+"' AND `table` = '"+table+"'")
		if err == nil && len(partsRows) > 0 {
			info.Parts = toFloat64(partsRows[0]["parts"])
		}

		otherNodesMu.Lock()
		otherNodes = append(otherNodes, info)
		otherNodesMu.Unlock()
		return nil
	})

	if otherNodes == nil {
		otherNodes = []nodeTableInfo{}
	}
	result["other_nodes"] = otherNodes

	// i) Column list — used by Compare "Diff" tab for schema diffing.
	colListRows, err := client.Query(ctx,
		"SELECT name, type, comment "+
			"FROM system.columns "+
			"WHERE database = '"+db+"' AND `table` = '"+table+"' "+
			"ORDER BY position")
	if err != nil {
		slog.Error("table detail: columns", "err", err, "instance", instance)
		result["columns"] = []interface{}{}
	} else {
		result["columns"] = colListRows
	}

	writeJSON(w, http.StatusOK, result)
}
