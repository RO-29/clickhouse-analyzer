package web

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Query History Ring Buffer
// ---------------------------------------------------------------------------

// QueryHistoryEntry records a single query executed via the terminal.
type QueryHistoryEntry struct {
	Instance  string    `json:"instance"`
	Query     string    `json:"query"`
	RowCount  int       `json:"row_count"`
	ElapsedMs int64     `json:"elapsed_ms"`
	Error     string    `json:"error,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

// QueryHistory is a concurrency-safe ring buffer for query history entries.
type QueryHistory struct {
	mu      sync.RWMutex
	entries []QueryHistoryEntry
	size    int
	pos     int
	count   int
}

// NewQueryHistory creates a ring buffer that holds the last size entries.
func NewQueryHistory(size int) *QueryHistory {
	return &QueryHistory{
		entries: make([]QueryHistoryEntry, size),
		size:    size,
	}
}

// Add appends an entry to the ring buffer.
func (qh *QueryHistory) Add(entry QueryHistoryEntry) {
	qh.mu.Lock()
	qh.entries[qh.pos] = entry
	qh.pos = (qh.pos + 1) % qh.size
	if qh.count < qh.size {
		qh.count++
	}
	qh.mu.Unlock()
}

// Entries returns all stored entries in reverse chronological order (newest first).
func (qh *QueryHistory) Entries() []QueryHistoryEntry {
	qh.mu.RLock()
	defer qh.mu.RUnlock()

	if qh.count == 0 {
		return nil
	}

	// Build chronological order first.
	var chrono []QueryHistoryEntry
	if qh.count < qh.size {
		chrono = make([]QueryHistoryEntry, qh.count)
		copy(chrono, qh.entries[:qh.count])
	} else {
		chrono = make([]QueryHistoryEntry, qh.size)
		copy(chrono, qh.entries[qh.pos:])
		copy(chrono[qh.size-qh.pos:], qh.entries[:qh.pos])
	}

	// Reverse for newest-first.
	for i, j := 0, len(chrono)-1; i < j; i, j = i+1, j-1 {
		chrono[i], chrono[j] = chrono[j], chrono[i]
	}
	return chrono
}

// ---------------------------------------------------------------------------
// SQL Safety
// ---------------------------------------------------------------------------

// allowedFirstKeywords are the only statement types permitted via the terminal.
var allowedFirstKeywords = map[string]bool{
	"SELECT":   true,
	"SHOW":     true,
	"DESCRIBE": true,
	"DESC":     true,
	"EXPLAIN":  true,
	"EXISTS":   true,
	"WITH":     true,
}

// reLineComment matches SQL line comments (-- ...).
var reLineComment = regexp.MustCompile(`--[^\n]*`)

// reBlockComment matches SQL block comments (/* ... */).
var reBlockComment = regexp.MustCompile(`/\*[\s\S]*?\*/`)

// extractFirstKeyword strips comments and whitespace then returns the
// uppercased first keyword of the SQL statement.
func extractFirstKeyword(sql string) string {
	// Strip block comments.
	cleaned := reBlockComment.ReplaceAllString(sql, " ")
	// Strip line comments.
	cleaned = reLineComment.ReplaceAllString(cleaned, " ")
	// Trim whitespace.
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return ""
	}
	// Extract first word.
	end := strings.IndexAny(cleaned, " \t\n\r(;")
	if end == -1 {
		return strings.ToUpper(cleaned)
	}
	return strings.ToUpper(cleaned[:end])
}

// isReadOnlyQuery validates that the SQL statement starts with an allowed
// read-only keyword after stripping comments.
func isReadOnlyQuery(sql string) bool {
	keyword := extractFirstKeyword(sql)
	return allowedFirstKeywords[keyword]
}

// splitStatements splits a SQL string into individual statements on semicolons,
// correctly handling single-quoted string literals and -- line comments.
func splitStatements(query string) []string {
	var stmts []string
	var cur strings.Builder
	inStr := false
	inLineComment := false

	for i := 0; i < len(query); i++ {
		ch := query[i]

		if inLineComment {
			cur.WriteByte(ch)
			if ch == '\n' {
				inLineComment = false
			}
			continue
		}

		if inStr {
			cur.WriteByte(ch)
			if ch == '\'' {
				// handle escaped '' inside strings
				if i+1 < len(query) && query[i+1] == '\'' {
					cur.WriteByte(query[i+1])
					i++
				} else {
					inStr = false
				}
			}
			continue
		}

		// Detect line comment start
		if ch == '-' && i+1 < len(query) && query[i+1] == '-' {
			inLineComment = true
			cur.WriteByte(ch)
			continue
		}

		if ch == '\'' {
			inStr = true
			cur.WriteByte(ch)
			continue
		}

		if ch == ';' {
			if stmt := strings.TrimSpace(cur.String()); stmt != "" {
				stmts = append(stmts, stmt)
			}
			cur.Reset()
			continue
		}

		cur.WriteByte(ch)
	}

	if stmt := strings.TrimSpace(cur.String()); stmt != "" {
		stmts = append(stmts, stmt)
	}
	return stmts
}

// ---------------------------------------------------------------------------
// 1. POST /api/query — Execute a read-only SQL query
// ---------------------------------------------------------------------------

type queryRequest struct {
	Instance string `json:"instance"`
	Query    string `json:"query"`
	Limit    int    `json:"limit"`
}

// statementResult holds the result of one statement in a multi-statement batch.
type statementResult struct {
	SQL       string                   `json:"sql"`
	Columns   []string                 `json:"columns"`
	Types     []string                 `json:"types"`
	Rows      []map[string]interface{} `json:"rows"`
	RowCount  int                      `json:"row_count"`
	ElapsedMs int64                    `json:"elapsed_ms"`
}

type queryResponse struct {
	// Primary result — last statement (backward compat)
	Columns       []string                 `json:"columns"`
	Types         []string                 `json:"types"`
	Rows          []map[string]interface{} `json:"rows"`
	RowCount      int                      `json:"row_count"`
	ElapsedMs     int64                    `json:"elapsed_ms"`
	Instance      string                   `json:"instance"`
	StatementsRun int                      `json:"statements_run,omitempty"`
	// All results when multiple statements were run
	Results       []statementResult        `json:"results,omitempty"`
}

func (s *Server) handleQueryExecute(w http.ResponseWriter, r *http.Request) {
	limitBody(w, r)
	var req queryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate required fields.
	req.Query = strings.TrimSpace(req.Query)
	if req.Query == "" {
		writeErr(w, http.StatusBadRequest, "query is required")
		return
	}
	if req.Instance == "" {
		writeErr(w, http.StatusBadRequest, "instance is required")
		return
	}
	if req.Limit <= 0 || req.Limit > 10000 {
		req.Limit = 1000
	}

	// Split into individual statements (supports multi-statement input)
	stmts := splitStatements(req.Query)
	if len(stmts) == 0 {
		writeErr(w, http.StatusBadRequest, "no statements found")
		return
	}

	// Security: validate all statements are read-only before executing any.
	for _, stmt := range stmts {
		if !isReadOnlyQuery(stmt) {
			keyword := extractFirstKeyword(stmt)
			writeErr(w, http.StatusForbidden, fmt.Sprintf("query type %q is not allowed; only SELECT, SHOW, DESCRIBE, EXPLAIN, EXISTS, WITH are permitted", keyword))
			s.recordQueryHistory(req.Instance, req.Query, 0, 0, "forbidden: query type not allowed")
			return
		}
	}

	// Get client for instance.
	client := s.manager.Get(req.Instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found: "+req.Instance)
		return
	}

	// Execute with timeout and CH settings for safety.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	settings := map[string]string{
		"max_execution_time":   "30",
		"max_result_rows":      fmt.Sprintf("%d", req.Limit),
		"result_overflow_mode": "break",
	}

	var (
		allResults   []statementResult
		totalElapsed int64
	)

	for i, stmt := range stmts {
		start := time.Now()
		result, err := client.QueryWithSettings(ctx, stmt, settings)
		elapsedMs := time.Since(start).Milliseconds()
		totalElapsed += elapsedMs

		logQuery := stmt
		if len(logQuery) > 200 {
			logQuery = logQuery[:200] + "..."
		}

		if err != nil {
			slog.Warn("terminal query failed",
				"instance", req.Instance,
				"stmt", i+1,
				"query", logQuery,
				"elapsed_ms", elapsedMs,
				"err", err,
			)
			s.recordQueryHistory(req.Instance, stmt, 0, elapsedMs, err.Error())
			errMsg := "query execution failed"
			if len(stmts) > 1 {
				errMsg = fmt.Sprintf("statement %d/%d failed", i+1, len(stmts))
			}
			writeErr(w, http.StatusInternalServerError, errMsg)
			return
		}

		slog.Info("terminal query executed",
			"instance", req.Instance,
			"stmt", i+1,
			"query", logQuery,
			"elapsed_ms", elapsedMs,
			"rows", result.Rows,
		)

		columns := make([]string, len(result.Meta))
		types := make([]string, len(result.Meta))
		for j, m := range result.Meta {
			columns[j] = m.Name
			types[j] = m.Type
		}

		allResults = append(allResults, statementResult{
			SQL:       stmt,
			Columns:   columns,
			Types:     types,
			Rows:      result.Data,
			RowCount:  result.Rows,
			ElapsedMs: elapsedMs,
		})

		s.recordQueryHistory(req.Instance, stmt, result.Rows, elapsedMs, "")
	}

	// Build response: last result fields for backward compat, all results in Results.
	last := allResults[len(allResults)-1]
	writeJSON(w, http.StatusOK, queryResponse{
		Columns:       last.Columns,
		Types:         last.Types,
		Rows:          last.Rows,
		RowCount:      last.RowCount,
		ElapsedMs:     totalElapsed,
		Instance:      req.Instance,
		StatementsRun: len(stmts),
		Results:       allResults,
	})
}

// recordQueryHistory adds a query to the history ring buffer if it exists.
func (s *Server) recordQueryHistory(instance, query string, rowCount int, elapsedMs int64, errMsg string) {
	if s.queryHistory == nil {
		return
	}
	s.queryHistory.Add(QueryHistoryEntry{
		Instance:  instance,
		Query:     query,
		RowCount:  rowCount,
		ElapsedMs: elapsedMs,
		Error:     errMsg,
		Timestamp: time.Now(),
	})
}

// ---------------------------------------------------------------------------
// 2. GET /api/query/history — Recent terminal queries
// ---------------------------------------------------------------------------

func (s *Server) handleQueryHistory(w http.ResponseWriter, r *http.Request) {
	if s.queryHistory == nil {
		writeJSON(w, http.StatusOK, []QueryHistoryEntry{})
		return
	}
	writeJSON(w, http.StatusOK, s.queryHistory.Entries())
}

// ---------------------------------------------------------------------------
// 3. GET /api/instances/{name}/alerts-at — Time-travel alerts
// ---------------------------------------------------------------------------

func (s *Server) handleAlertsAt(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	var checks []healthCheckResult

	// --- Long-running queries ---
	rows, err := client.Query(ctx, fmt.Sprintf(
		`SELECT count() as cnt, max(query_duration_ms)/1000 as max_sec
		 FROM system.query_log
		 WHERE type='QueryFinish' AND query_duration_ms > 60000
		   AND event_time >= '%s' AND event_time <= '%s'`, fromTime, toTime))
	if err == nil && len(rows) > 0 {
		cnt := toFloat64(rows[0]["cnt"])
		maxSec := toFloat64(rows[0]["max_sec"])
		status := "ok"
		if cnt > 50 {
			status = "critical"
		} else if cnt > 10 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "long_running_historical",
			Category:  "queries",
			Name:      "Long-Running Queries (>60s)",
			Status:    status,
			Value:     fmt.Sprintf("%.0f queries", cnt),
			Threshold: "10/50",
			Detail:    fmt.Sprintf("%.0f queries exceeded 60s, max duration: %.1fs", cnt, maxSec),
		})
	}

	// --- Failed queries ---
	rows, err = client.Query(ctx, fmt.Sprintf(
		`SELECT count() as cnt FROM system.query_log
		 WHERE type='ExceptionWhileProcessing'
		   AND event_time >= '%s' AND event_time <= '%s'`, fromTime, toTime))
	if err == nil && len(rows) > 0 {
		cnt := toFloat64(rows[0]["cnt"])
		status := "ok"
		if cnt > 500 {
			status = "critical"
		} else if cnt > 100 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "failed_queries_historical",
			Category:  "queries",
			Name:      "Failed Queries",
			Status:    status,
			Value:     fmt.Sprintf("%.0f", cnt),
			Threshold: "100/500",
			Detail:    fmt.Sprintf("Queries with exceptions in time range: %.0f", cnt),
		})
	}

	// --- Query storms ---
	rows, err = client.Query(ctx, fmt.Sprintf(
		`SELECT user, count() as cnt FROM system.query_log
		 WHERE type IN ('QueryFinish','ExceptionWhileProcessing')
		   AND event_time >= '%s' AND event_time <= '%s'
		 GROUP BY user HAVING cnt > 1000`, fromTime, toTime))
	if err == nil {
		status := "ok"
		detail := "No users with >1000 queries in range"
		if len(rows) > 0 {
			status = "warn"
			var parts []string
			for _, row := range rows {
				parts = append(parts, fmt.Sprintf("%v: %.0f", row["user"], toFloat64(row["cnt"])))
			}
			detail = fmt.Sprintf("Users with >1000 queries: %s", strings.Join(parts, ", "))
			for _, row := range rows {
				if toFloat64(row["cnt"]) > 10000 {
					status = "critical"
					break
				}
			}
		}
		checks = append(checks, healthCheckResult{
			ID:        "query_storms_historical",
			Category:  "queries",
			Name:      "Query Storms",
			Status:    status,
			Value:     fmt.Sprintf("%d users >1000", len(rows)),
			Threshold: "1000/10000 per user",
			Detail:    detail,
		})
	}

	// --- Small inserts ---
	rows, err = client.Query(ctx, fmt.Sprintf(
		`SELECT count() as cnt FROM system.query_log
		 WHERE type='QueryFinish' AND query_kind='Insert'
		   AND written_rows < 100 AND written_rows > 0
		   AND event_time >= '%s' AND event_time <= '%s'`, fromTime, toTime))
	if err == nil && len(rows) > 0 {
		cnt := toFloat64(rows[0]["cnt"])
		status := "ok"
		if cnt > 5000 {
			status = "critical"
		} else if cnt > 1000 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "small_inserts_historical",
			Category:  "inserts",
			Name:      "Small Inserts (<100 rows)",
			Status:    status,
			Value:     fmt.Sprintf("%.0f", cnt),
			Threshold: "1000/5000",
			Detail:    fmt.Sprintf("INSERT statements with <100 rows in time range: %.0f", cnt),
		})
	}

	// --- S3 latency ---
	rows, err = client.Query(ctx, fmt.Sprintf(
		`SELECT avg(ProfileEvents['S3ReadMicroseconds']/nullIf(ProfileEvents['S3ReadRequestsCount'],0))/1000 as avg_ms
		 FROM system.query_log
		 WHERE type='QueryFinish' AND ProfileEvents['S3ReadRequestsCount'] > 0
		   AND event_time >= '%s' AND event_time <= '%s'`, fromTime, toTime))
	if err == nil && len(rows) > 0 {
		avgMs := toFloat64(rows[0]["avg_ms"])
		status := "ok"
		if avgMs > 200 {
			status = "critical"
		} else if avgMs > 100 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "s3_latency_historical",
			Category:  "s3",
			Name:      "S3 Read Latency (avg)",
			Status:    status,
			Value:     fmt.Sprintf("%.1fms", avgMs),
			Threshold: "100ms/200ms",
			Detail:    fmt.Sprintf("Average S3 read latency per request in time range: %.1fms", avgMs),
		})
	}

	// --- Merge rate (from part_log) ---
	rows, err = client.Query(ctx, fmt.Sprintf(
		`SELECT countIf(event_type='MergeParts') as merges,
		        countIf(event_type='NewPart') as new_parts,
		        countIf(event_type='MovePart') as moves
		 FROM system.part_log
		 WHERE event_time >= '%s' AND event_time <= '%s'`, fromTime, toTime))
	if err == nil && len(rows) > 0 {
		merges := toFloat64(rows[0]["merges"])
		newParts := toFloat64(rows[0]["new_parts"])
		moves := toFloat64(rows[0]["moves"])
		status := "ok"
		if newParts > 0 && merges/newParts < 0.1 {
			status = "warn"
		}
		if merges > 10000 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "merge_rate_historical",
			Category:  "storage",
			Name:      "Merge Activity",
			Status:    status,
			Value:     fmt.Sprintf("%.0f merges", merges),
			Threshold: "ratio-based",
			Detail:    fmt.Sprintf("Merges: %.0f, New parts: %.0f, Moves: %.0f", merges, newParts, moves),
		})
	}

	// --- MV failures (from query_views_log) ---
	rows, err = client.Query(ctx, fmt.Sprintf(
		`SELECT count() as cnt FROM system.query_views_log
		 WHERE status != 'QueryFinish'
		   AND event_time >= '%s' AND event_time <= '%s'`, fromTime, toTime))
	if err == nil && len(rows) > 0 {
		cnt := toFloat64(rows[0]["cnt"])
		status := "ok"
		if cnt > 100 {
			status = "critical"
		} else if cnt > 10 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "mv_failures_historical",
			Category:  "mvs",
			Name:      "Materialized View Failures",
			Status:    status,
			Value:     fmt.Sprintf("%.0f", cnt),
			Threshold: "10/100",
			Detail:    fmt.Sprintf("MV execution failures in time range: %.0f", cnt),
		})
	}

	writeJSON(w, http.StatusOK, checks)
}

// ---------------------------------------------------------------------------
// 4. GET /api/instances/{name}/s3-stats — S3 storage and latency stats
// ---------------------------------------------------------------------------

func (s *Server) handleS3Stats(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	type s3StatsResponse struct {
		VolumeByTable     []map[string]interface{} `json:"volume_by_table"`
		LatencyByQuery    []map[string]interface{} `json:"latency_by_query"`
		LatencyByTable    []map[string]interface{} `json:"latency_by_table"`
		// S3-type disk names CH knows about, for transparency in the UI.
		S3Disks           []string                 `json:"s3_disks"`
		// CH-tracked remote storage size from system.remote_data_paths.
		// This is the authoritative "what CH thinks it has on remote disks"
		// number. Diverges from the actual S3 bucket size when orphaned
		// objects exist (deleted parts not yet GC'd by the storage policy,
		// other tenants in the same bucket prefix, etc.).
		RemoteTrackedBytes float64 `json:"remote_tracked_bytes"`
		RemoteTrackedCount int     `json:"remote_tracked_count"`
		// Inactive parts on S3 disks — count separately so the UI can show
		// "live" vs "tracked but inactive" without conflating them.
		InactiveBytes      float64 `json:"inactive_bytes"`
		// Detached parts on S3 disks (system.detached_parts). DETACH PARTITION
		// is a frequent source of orphans — the data stays in S3 forever until
		// you `DROP DETACHED PARTITION` or remove it manually.
		DetachedCount      int     `json:"detached_count"`
		DetachedBytes      float64 `json:"detached_bytes"`
		// Recent part-log REMOVAL events on S3 disks. If lots of parts have
		// been removed recently but the bucket still has them, the storage
		// policy isn't propagating deletes (zero-copy retention, lifecycle
		// disabled, etc.).
		RecentRemovals     []map[string]interface{} `json:"recent_removals"`
		// Recently DROPped tables that lived on S3 — a classic orphan source.
		// Exposed from system.dropped_tables (CH 22.3+) when available.
		DroppedTables      []map[string]interface{} `json:"dropped_tables"`
	}

	var resp s3StatsResponse
	resp.VolumeByTable = []map[string]interface{}{}
	resp.LatencyByQuery = []map[string]interface{}{}
	resp.LatencyByTable = []map[string]interface{}{}
	resp.S3Disks = []string{}

	// Discover S3-type disks via system.disks instead of a brittle
	// `disk_name LIKE '%s3%'`. CH 23.7+ exposes `object_storage_type`;
	// older versions only have `type`. Match either signal.
	s3DiskFilter := "" // SQL fragment scoping further queries to S3 disks
	disksSQL := `
		SELECT name, type,
		  multiIf(
		    has(['s3','S3','ObjectStorage','object_storage'], type), 1,
		    0
		  ) AS is_s3_type
		FROM system.disks`
	if dRows, err := client.Query(ctx, disksSQL); err == nil {
		for _, row := range dRows {
			if float64Val(row["is_s3_type"]) > 0 || strings.Contains(strings.ToLower(strVal(row["name"])), "s3") {
				resp.S3Disks = append(resp.S3Disks, strVal(row["name"]))
			}
		}
	}

	if len(resp.S3Disks) > 0 {
		quoted := make([]string, 0, len(resp.S3Disks))
		for _, n := range resp.S3Disks {
			quoted = append(quoted, "'"+sqlSafeStr(n)+"'")
		}
		s3DiskFilter = " disk_name IN (" + strings.Join(quoted, ", ") + ")"
	} else {
		// Fall back to the legacy LIKE match if disk-type detection failed.
		s3DiskFilter = " disk_name LIKE '%s3%'"
	}

	// S3 data volume by table — active parts only (the headline number).
	volSQL := `
		SELECT database, table, disk_name, count() as parts,
			sum(bytes_on_disk) as bytes, formatReadableSize(sum(bytes_on_disk)) as size
		FROM system.parts WHERE active AND` + s3DiskFilter + `
		GROUP BY database, table, disk_name ORDER BY bytes DESC LIMIT 30`
	if rows, err := client.Query(ctx, volSQL); err != nil {
		slog.Warn("s3 stats: volume query failed", "instance", instance, "err", err)
	} else {
		resp.VolumeByTable = rows
	}

	// Inactive parts size — within `old_parts_lifetime` they still exist on
	// disk and in S3. The UI should surface this so the "Total" number
	// reconciles with what CH itself reports across active+inactive.
	inactSQL := `SELECT sum(bytes_on_disk) AS bytes FROM system.parts WHERE active = 0 AND` + s3DiskFilter
	if iRows, err := client.Query(ctx, inactSQL); err == nil && len(iRows) > 0 {
		resp.InactiveBytes = float64Val(iRows[0]["bytes"])
	}

	// system.remote_data_paths: the authoritative list of objects CH's
	// storage layer believes it owns on remote disks. Comparing this sum to
	// the actual S3 bucket size reveals orphans. Available CH 22.6+; missing
	// on older versions, in which case we silently skip.
	remoteSQL := `
		SELECT count() AS cnt, sum(size) AS bytes
		FROM system.remote_data_paths`
	if len(resp.S3Disks) > 0 {
		quoted := make([]string, 0, len(resp.S3Disks))
		for _, n := range resp.S3Disks {
			quoted = append(quoted, "'"+sqlSafeStr(n)+"'")
		}
		remoteSQL += " WHERE disk_name IN (" + strings.Join(quoted, ", ") + ")"
	}
	if rRows, err := client.Query(ctx, remoteSQL); err == nil && len(rRows) > 0 {
		resp.RemoteTrackedCount = int(float64Val(rRows[0]["cnt"]))
		resp.RemoteTrackedBytes = float64Val(rRows[0]["bytes"])
	}

	// Detached parts on S3 disks. system.detached_parts has `disk` (CH 22+)
	// and `bytes_on_disk` (some versions). Some clusters lack the bytes column,
	// so query count separately and tolerate failure on the bytes column.
	detSQL := `SELECT count() AS cnt FROM system.detached_parts WHERE 1=1`
	if len(resp.S3Disks) > 0 {
		quoted := make([]string, 0, len(resp.S3Disks))
		for _, n := range resp.S3Disks {
			quoted = append(quoted, "'"+sqlSafeStr(n)+"'")
		}
		detSQL += " AND disk IN (" + strings.Join(quoted, ", ") + ")"
	}
	if dRows, err := client.Query(ctx, detSQL); err == nil && len(dRows) > 0 {
		resp.DetachedCount = int(float64Val(dRows[0]["cnt"]))
	}
	// Try to fetch bytes_on_disk too; not all CH versions expose it on
	// system.detached_parts. Failure here is silent.
	if resp.DetachedCount > 0 {
		detBytesSQL := strings.Replace(detSQL, "count() AS cnt", "sum(bytes_on_disk) AS bytes", 1)
		if dRows, err := client.Query(ctx, detBytesSQL); err == nil && len(dRows) > 0 {
			resp.DetachedBytes = float64Val(dRows[0]["bytes"])
		}
	}

	// Recent part removals on S3 disks. Useful to confirm CH is actively
	// dropping parts (which should propagate to S3 via the storage policy).
	// system.part_log: event_type=2 is RemovePart in CH; check by string for
	// portability.
	if len(resp.S3Disks) > 0 {
		quoted := make([]string, 0, len(resp.S3Disks))
		for _, n := range resp.S3Disks {
			quoted = append(quoted, "'"+sqlSafeStr(n)+"'")
		}
		remSQL := `
			SELECT toDate(event_time) AS day, count() AS removals,
			       formatReadableSize(sum(bytes)) AS bytes_readable, sum(bytes) AS bytes
			FROM system.part_log
			WHERE event_type = 'RemovePart'
			  AND disk_name IN (` + strings.Join(quoted, ", ") + `)
			  AND event_date >= today() - 14
			GROUP BY day ORDER BY day DESC LIMIT 14`
		if rows, err := client.Query(ctx, remSQL); err == nil {
			resp.RecentRemovals = rows
		}
	}
	if resp.RecentRemovals == nil {
		resp.RecentRemovals = []map[string]interface{}{}
	}

	// Tables marked for deletion but data may still be on disk.
	// system.dropped_tables exists CH 22.3+; query failures are silent so
	// older versions just don't see this row.
	dropSQL := `
		SELECT database, table, engine, metadata_dropped_path,
		       table_dropped_time
		FROM system.dropped_tables ORDER BY table_dropped_time DESC LIMIT 20`
	if rows, err := client.Query(ctx, dropSQL); err == nil {
		resp.DroppedTables = rows
	}
	if resp.DroppedTables == nil {
		resp.DroppedTables = []map[string]interface{}{}
	}

	// S3 latency by normalized query hash (last 1h).
	if rows, err := client.Query(ctx, `
		SELECT normalized_query_hash, count() as cnt,
			avg(ProfileEvents['S3ReadMicroseconds']/nullIf(ProfileEvents['S3ReadRequestsCount'],0))/1000 as avg_latency_ms,
			max(ProfileEvents['S3ReadMicroseconds']/nullIf(ProfileEvents['S3ReadRequestsCount'],0))/1000 as max_latency_ms,
			sum(ProfileEvents['S3ReadRequestsCount']) as total_s3_requests,
			any(user) as user,
			substring(any(query),1,500) as sample_query
		FROM system.query_log
		WHERE type='QueryFinish' AND ProfileEvents['S3ReadRequestsCount'] > 0
		  AND event_time >= now() - INTERVAL 1 HOUR
		GROUP BY normalized_query_hash
		ORDER BY avg_latency_ms DESC LIMIT 20`); err != nil {
		slog.Warn("s3 stats: latency by query failed", "instance", instance, "err", err)
	} else {
		resp.LatencyByQuery = rows
	}

	// S3 latency by table.
	if rows, err := client.Query(ctx, `
		SELECT tables[1] as table_name, count() as queries,
			avg(ProfileEvents['S3ReadMicroseconds']/nullIf(ProfileEvents['S3ReadRequestsCount'],0))/1000 as avg_latency_ms,
			sum(ProfileEvents['S3ReadRequestsCount']) as total_requests
		FROM system.query_log
		WHERE type='QueryFinish' AND ProfileEvents['S3ReadRequestsCount'] > 0
		  AND length(tables) >= 1 AND event_time >= now() - INTERVAL 1 HOUR
		GROUP BY table_name ORDER BY avg_latency_ms DESC LIMIT 20`); err != nil {
		slog.Warn("s3 stats: latency by table failed", "instance", instance, "err", err)
	} else {
		resp.LatencyByTable = rows
	}

	writeJSON(w, http.StatusOK, resp)
}
