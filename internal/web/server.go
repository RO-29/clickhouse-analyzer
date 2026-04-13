// Package web provides an embedded HTTP dashboard and REST API for ch-analyzer.
package web

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"sort"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/analyzer"
	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/store"
)

//go:embed static
var staticFS embed.FS

// Server serves the web dashboard and REST API.
type Server struct {
	store        *store.Store
	analyzer     *analyzer.Analyzer
	manager      *chclient.Manager
	addr         string
	srv          *http.Server
	logs         *LogBuffer
	queryHistory *QueryHistory
}

// New creates a new web Server.
func New(addr string, store *store.Store, analyzer *analyzer.Analyzer, manager *chclient.Manager, logs *LogBuffer) *Server {
	return &Server{
		store:        store,
		analyzer:     analyzer,
		manager:      manager,
		addr:         addr,
		logs:         logs,
		queryHistory: NewQueryHistory(100),
	}
}

// Start begins serving HTTP traffic. It blocks until the server is shut down.
func (s *Server) Start(ctx context.Context) error {
	mux := http.NewServeMux()
	s.registerRoutes(mux)

	s.srv = &http.Server{
		Addr:              s.addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	slog.Info("web server starting", "addr", s.addr)

	errCh := make(chan error, 1)
	go func() {
		if err := s.srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("web server: %w", err)
	case <-ctx.Done():
		return s.Stop(context.Background())
	}
}

// Stop gracefully shuts down the HTTP server.
func (s *Server) Stop(ctx context.Context) error {
	if s.srv == nil {
		return nil
	}
	slog.Info("web server stopping")
	shutdownCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return s.srv.Shutdown(shutdownCtx)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

func (s *Server) registerRoutes(mux *http.ServeMux) {
	// Serve static assets (JS, CSS) from embedded filesystem.
	assetsFS, _ := fs.Sub(staticFS, "static")
	mux.Handle("GET /assets/", http.FileServer(http.FS(assetsFS)))

	// SPA fallback: serve index.html for all non-API paths.
	mux.HandleFunc("GET /", s.handleIndex)

	// API endpoints.
	mux.HandleFunc("GET /api/instances", s.handleInstances)
	mux.HandleFunc("GET /api/instances/{name}/metrics", s.handleMetrics)
	mux.HandleFunc("GET /api/instances/{name}/alerts", s.handleAlerts)
	mux.HandleFunc("GET /api/instances/{name}/queries", s.handleQueries)
	mux.HandleFunc("GET /api/instances/{name}/tables", s.handleTables)
	mux.HandleFunc("GET /api/instances/{name}/disks", s.handleDisks)
	mux.HandleFunc("GET /api/instances/{name}/mvs", s.handleMVs)
	mux.HandleFunc("GET /api/overview", s.handleOverview)
	mux.HandleFunc("GET /api/alerts/active", s.handleActiveAlerts)
	mux.HandleFunc("GET /api/alerts/history", s.handleAlertHistory)
	mux.HandleFunc("POST /api/alerts/resolve-stale", s.handleResolveStale)
	mux.HandleFunc("POST /api/alerts/resolve", s.handleResolveAlert)
	mux.HandleFunc("GET /api/logs", s.handleLogs)
	mux.HandleFunc("GET /api/instances/{name}/ch-logs", s.handleCHLogs)

	// Terminal / query execution endpoints (from terminal.go).
	mux.HandleFunc("POST /api/query", s.handleQueryExecute)
	mux.HandleFunc("GET /api/query/history", s.handleQueryHistory)
	mux.HandleFunc("GET /api/instances/{name}/alerts-at", s.handleAlertsAt)
	mux.HandleFunc("GET /api/instances/{name}/s3-stats", s.handleS3Stats)

	// Compare endpoints (from compare.go).
	mux.HandleFunc("GET /api/compare/tables", s.handleCompareTables)
	mux.HandleFunc("GET /api/compare/settings", s.handleCompareSettings)
	mux.HandleFunc("GET /api/compare/metrics", s.handleCompareMetrics)
	mux.HandleFunc("GET /api/instances/{name}/table-memory", s.handleTableMemory)
	mux.HandleFunc("GET /api/instances/{name}/cache-stats", s.handleCacheStats)

	// Suggestions endpoint (from suggestions.go).
	mux.HandleFunc("GET /api/suggestions/{category}", s.handleSuggestions)

	// AI Analyzer endpoints (from analyze.go).
	mux.HandleFunc("POST /api/instances/{name}/analyze", s.handleAnalyze)
	mux.HandleFunc("GET /api/instances/{name}/analyze/context", s.handleAnalyzeContext)
	mux.HandleFunc("POST /api/instances/{name}/analyze-element", s.handleAnalyzeElement)
	mux.HandleFunc("GET /api/instances/{name}/analyze-element/queries", s.handleAnalyzeElementQueries)

	// Advisor endpoints (from advisor.go).
	mux.HandleFunc("GET /api/instances/{name}/advisor/compression", s.handleAdvisorCompression)
	mux.HandleFunc("GET /api/instances/{name}/advisor/query-regression", s.handleAdvisorQueryRegression)
	mux.HandleFunc("GET /api/instances/{name}/advisor/new-patterns", s.handleAdvisorNewPatterns)
	mux.HandleFunc("GET /api/instances/{name}/advisor/unused-tables", s.handleAdvisorUnusedTables)
	mux.HandleFunc("GET /api/instances/{name}/advisor/schema", s.handleAdvisorSchema)
	mux.HandleFunc("GET /api/instances/{name}/advisor/cardinality", s.handleAdvisorCardinality)
	mux.HandleFunc("GET /api/instances/{name}/advisor/storage-policy", s.handleAdvisorStoragePolicy)
	mux.HandleFunc("GET /api/instances/{name}/table-detail/{db}/{table}", s.handleTableDetail)

	// Historical analysis endpoints (from history.go).
	mux.HandleFunc("GET /api/instances/{name}/health-check", s.handleHealthCheck)
	mux.HandleFunc("GET /api/instances/{name}/query-patterns", s.handleQueryPatterns)
	mux.HandleFunc("GET /api/instances/{name}/query-pattern-timeline", s.handleQueryPatternTimeline)
	mux.HandleFunc("GET /api/instances/{name}/history/failures", s.handleHistoryFailures)
	mux.HandleFunc("GET /api/instances/{name}/history/merges", s.handleHistoryMerges)
	mux.HandleFunc("GET /api/instances/{name}/history/mvs", s.handleHistoryMVs)
	mux.HandleFunc("GET /api/instances/{name}/history/inserts", s.handleHistoryInserts)
	mux.HandleFunc("GET /api/instances/{name}/history/s3", s.handleHistoryS3)
	mux.HandleFunc("GET /api/instances/{name}/history/async-metrics", s.handleHistoryAsyncMetrics)
	mux.HandleFunc("GET /api/instances/{name}/history/disk-io", s.handleHistoryDiskIO)
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	// For SPA: serve index.html for all non-API, non-asset paths.
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}
	data, err := staticFS.ReadFile("static/index.html")
	if err != nil {
		http.Error(w, "dashboard not found", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(data)
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

// GET /api/instances — list all instances with latest health score.
func (s *Server) handleInstances(w http.ResponseWriter, r *http.Request) {
	names := s.manager.Names()
	type instanceInfo struct {
		Name        string  `json:"name"`
		HealthScore float64 `json:"health_score"`
		Status      string  `json:"status"`
	}

	results := make([]instanceInfo, 0, len(names))
	for _, name := range names {
		score := s.getHealthScore(name)
		status := "healthy"
		if score < 50 {
			status = "critical"
		} else if score < 80 {
			status = "warning"
		}
		results = append(results, instanceInfo{
			Name:        name,
			HealthScore: score,
			Status:      status,
		})
	}

	writeJSON(w, http.StatusOK, results)
}

// GET /api/instances/{name}/metrics?name=X&from=T&to=T&points=100
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	if !s.validInstance(instance) {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	metricName := r.URL.Query().Get("name")
	if metricName == "" {
		writeErr(w, http.StatusBadRequest, "query parameter 'name' is required")
		return
	}

	from, to := parseTimeRange(r)
	points := parseIntParam(r, "points", 100)

	data, err := s.store.QueryMetricsSeries(instance, metricName, from, to, points)
	if err != nil {
		slog.Error("query metrics series", "err", err, "instance", instance, "metric", metricName)
		writeErr(w, http.StatusInternalServerError, "failed to query metrics")
		return
	}

	type point struct {
		Timestamp int64   `json:"ts"`
		Value     float64 `json:"value"`
	}
	pts := make([]point, len(data))
	for i, dp := range data {
		pts[i] = point{Timestamp: dp.Timestamp.Unix(), Value: dp.Value}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"instance": instance,
		"metric":   metricName,
		"from":     from.Unix(),
		"to":       to.Unix(),
		"points":   pts,
	})
}

// GET /api/instances/{name}/alerts?status=active|resolved|all&limit=50
func (s *Server) handleAlerts(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	if !s.validInstance(instance) {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	status := r.URL.Query().Get("status")
	if status == "" {
		status = "active"
	}
	limit := parseIntParam(r, "limit", 50)

	var alerts []store.Alert
	var err error

	switch status {
	case "active":
		alerts, err = s.store.GetActiveAlerts(instance)
	case "resolved", "all":
		from := time.Now().Add(-30 * 24 * time.Hour)
		to := time.Now()
		alerts, err = s.store.GetAlertHistory(instance, from, to, limit)
		if status == "resolved" {
			filtered := alerts[:0]
			for _, a := range alerts {
				if a.Resolved {
					filtered = append(filtered, a)
				}
			}
			alerts = filtered
		}
	default:
		writeErr(w, http.StatusBadRequest, "status must be active, resolved, or all")
		return
	}

	if err != nil {
		slog.Error("query alerts", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query alerts")
		return
	}

	writeJSON(w, http.StatusOK, marshalAlerts(alerts))
}

// GET /api/instances/{name}/queries — running queries from ClickHouse.
func (s *Server) handleQueries(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := client.Query(ctx, `
		SELECT
			query_id,
			substring(query, 1, 200) AS query_short,
			user,
			elapsed,
			read_rows,
			formatReadableSize(memory_usage) AS memory,
			formatReadableSize(read_bytes) AS read_size
		FROM system.processes
		WHERE is_initial_query = 1
		ORDER BY elapsed DESC
		LIMIT 50
	`)
	if err != nil {
		slog.Error("query running queries", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query running processes")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// GET /api/instances/{name}/tables — table sizes, parts, health.
func (s *Server) handleTables(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := client.Query(ctx, `
		SELECT
			t.database,
			t.name AS table_name,
			t.engine,
			t.total_rows,
			t.total_bytes,
			formatReadableSize(t.total_bytes) AS size_readable,
			p.part_count
		FROM system.tables t
		LEFT JOIN (
			SELECT database, table, count() AS part_count
			FROM system.parts
			WHERE active
			GROUP BY database, table
		) p ON t.database = p.database AND t.name = p.table
		WHERE t.database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
			AND t.total_bytes > 0
		ORDER BY t.total_bytes DESC
		LIMIT 100
	`)
	if err != nil {
		slog.Error("query tables", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query tables")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// GET /api/instances/{name}/disks — disk usage per disk.
func (s *Server) handleDisks(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := client.Query(ctx, `
		SELECT
			name AS disk_name,
			path,
			free_space,
			total_space,
			formatReadableSize(free_space) AS free_readable,
			formatReadableSize(total_space) AS total_readable,
			round((total_space - free_space) * 100.0 / total_space, 1) AS used_percent
		FROM system.disks
		ORDER BY name
	`)
	if err != nil {
		slog.Error("query disks", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query disks")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// GET /api/instances/{name}/mvs — materialized view status.
func (s *Server) handleMVs(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := client.Query(ctx, `
		SELECT
			database,
			name AS mv_name,
			as_select
		FROM system.tables
		WHERE engine = 'MaterializedView'
		ORDER BY database, name
	`)
	if err != nil {
		slog.Error("query materialized views", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query materialized views")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// GET /api/overview — all instances summary.
func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	names := s.manager.Names()

	type areaStatus struct {
		Area   string `json:"area"`
		Status string `json:"status"`
		Label  string `json:"label"`
	}

	type topAlert struct {
		Severity          string `json:"severity"`
		Category          string `json:"category"`
		Title             string `json:"title"`
		DedupKey          string `json:"dedup_key"`
		PossiblyRecovered bool   `json:"possibly_recovered"`
		CreatedAt         int64  `json:"created_at"`
	}

	type alertCounts struct {
		Crit int `json:"crit"`
		Warn int `json:"warn"`
		Info int `json:"info"`
	}

	type instanceSummary struct {
		Name         string             `json:"name"`
		HealthScore  float64            `json:"health_score"`
		Status       string             `json:"status"`
		ActiveAlerts int                `json:"active_alerts"`
		AlertCounts  alertCounts        `json:"alert_counts"`
		KeyMetrics   map[string]float64 `json:"key_metrics"`
		AreaStatus   []areaStatus       `json:"area_status"`
		TopAlerts    []topAlert         `json:"top_alerts"`
	}

	// Map alert categories to triage areas.
	categoryToArea := map[string]string{
		"memory":       "memory",
		"cpu":          "cpu",
		"queries":      "queries",
		"anomaly":      "queries",
		"sustained":    "queries",
		"storage":      "storage",
		"tables":       "storage",
		"s3":           "s3",
		"inserts":      "pipelines",
		"mvs":          "pipelines",
		"dictionaries": "pipelines",
		"k8s":          "system",
		"cross":        "system",
	}

	areaLabels := map[string]string{
		"memory": "Memory", "cpu": "CPU", "queries": "Queries",
		"storage": "Storage", "s3": "S3", "pipelines": "Pipelines",
	}

	// Severity ordering for worst-wins.
	sevRank := map[string]int{"ok": 0, "info": 1, "warn": 2, "critical": 3}
	worstSev := func(a, b string) string {
		if sevRank[a] >= sevRank[b] {
			return a
		}
		return b
	}

	results := make([]instanceSummary, 0, len(names))
	for _, name := range names {
		score := s.getHealthScore(name)
		status := "healthy"
		if score < 50 {
			status = "critical"
		} else if score < 80 {
			status = "warning"
		}

		activeAlerts, _ := s.store.GetActiveAlerts(name)

		// Separate fresh vs stale alerts (stale = no update in >24h).
		staleThreshold := 24 * time.Hour
		var freshAlerts []store.Alert
		for _, a := range activeAlerts {
			updatedAt := a.UpdatedAt
			if updatedAt.IsZero() {
				updatedAt = a.CreatedAt
			}
			if time.Since(updatedAt) <= staleThreshold {
				freshAlerts = append(freshAlerts, a)
			}
		}

		// metricArea tracks area status from CURRENT METRICS ONLY (no alerts).
		// Used for possibly_recovered detection: if metrics say "ok" but alert
		// is still active, the condition has likely cleared.
		metricArea := map[string]string{
			"memory": "ok", "cpu": "ok", "queries": "ok",
			"storage": "ok", "s3": "ok", "pipelines": "ok",
		}

		// Compute area statuses from BOTH alerts AND metrics (for the area pills).
		areaWorst := map[string]string{
			"memory": "ok", "cpu": "ok", "queries": "ok",
			"storage": "ok", "s3": "ok", "pipelines": "ok",
		}
		for _, a := range freshAlerts {
			area, ok := categoryToArea[a.Category]
			if !ok {
				continue
			}
			if _, exists := areaWorst[area]; !exists {
				continue
			}
			areaWorst[area] = worstSev(areaWorst[area], a.Severity)
		}

		// Also check latest metrics for areas that might not have alerts yet.
		keyMetrics := make(map[string]float64)
		latest, err := s.store.QueryLatestMetrics(name)
		if err == nil {
			for _, m := range latest {
				// Map collector metric names → dashboard display names.
				switch m.Name {
				case "memory_rss", "memory_tracked", "cpu_user", "cpu_system", "insert_rows_per_sec":
					keyMetrics[m.Name] = m.Value
				case "system.memory.used_percent":
					keyMetrics["memory_pct"] = m.Value
				case "system.memory.rss_percent":
					keyMetrics["memory_rss_pct"] = m.Value
				case "system.cpu.busy_percent":
					keyMetrics["cpu_pct"] = m.Value
				case "queries.running_count":
					keyMetrics["running_queries"] = m.Value
				case "tables.merges.active_count":
					keyMetrics["active_merges"] = m.Value
				case "tables.parts.count":
					keyMetrics["total_parts"] += m.Value
				}
				// Metric-based area escalation — applied to BOTH maps.
				var metricSev string
				switch m.Name {
				case "system.memory.used_percent":
					if m.Value > 90 {
						metricSev = "critical"
					} else if m.Value > 80 {
						metricSev = "warn"
					}
					if metricSev != "" {
						areaWorst["memory"] = worstSev(areaWorst["memory"], metricSev)
						metricArea["memory"] = worstSev(metricArea["memory"], metricSev)
					}
				case "system.cpu.busy_percent":
					if m.Value > 95 {
						metricSev = "critical"
					} else if m.Value > 80 {
						metricSev = "warn"
					}
					if metricSev != "" {
						areaWorst["cpu"] = worstSev(areaWorst["cpu"], metricSev)
						metricArea["cpu"] = worstSev(metricArea["cpu"], metricSev)
					}
				case "storage.disk.used_percent":
					if m.Value > 90 {
						metricSev = "critical"
					} else if m.Value > 80 {
						metricSev = "warn"
					}
					if metricSev != "" {
						areaWorst["storage"] = worstSev(areaWorst["storage"], metricSev)
						metricArea["storage"] = worstSev(metricArea["storage"], metricSev)
					}
				}
			}
			// Area escalation from summed total_parts.
			if tp := keyMetrics["total_parts"]; tp > 500 {
				areaWorst["storage"] = worstSev(areaWorst["storage"], "critical")
				metricArea["storage"] = worstSev(metricArea["storage"], "critical")
			} else if tp := keyMetrics["total_parts"]; tp > 300 {
				areaWorst["storage"] = worstSev(areaWorst["storage"], "warn")
				metricArea["storage"] = worstSev(metricArea["storage"], "warn")
			}
		}

		// Build area status list in fixed order.
		areaOrder := []string{"memory", "cpu", "queries", "storage", "s3", "pipelines"}
		areas := make([]areaStatus, 0, len(areaOrder))
		for _, a := range areaOrder {
			areas = append(areas, areaStatus{
				Area:   a,
				Status: areaWorst[a],
				Label:  areaLabels[a],
			})
		}

		// Alert severity breakdown counts.
		counts := alertCounts{}
		for _, a := range freshAlerts {
			switch a.Severity {
			case "critical":
				counts.Crit++
			case "warn":
				counts.Warn++
			default:
				counts.Info++
			}
		}

		// Top alerts: fresh only, sorted by severity (critical first), top 3.
		// possibly_recovered = metric-only area is "ok" but alert is still active.
		// We deliberately use metricArea (not areaWorst) so an active alert
		// doesn't prevent itself from being marked as recovered.
		sorted := make([]topAlert, 0, len(freshAlerts))
		for _, a := range freshAlerts {
			area := categoryToArea[a.Category]
			metricStatus := metricArea[area] // metric-only, ignores alerts
			possiblyRecovered := (a.Severity == "critical" || a.Severity == "warn") && metricStatus == "ok"
			sorted = append(sorted, topAlert{
				Severity:          a.Severity,
				Category:          a.Category,
				Title:             a.Title,
				DedupKey:          a.DedupKey,
				PossiblyRecovered: possiblyRecovered,
				CreatedAt:         a.CreatedAt.Unix(),
			})
		}
		sort.Slice(sorted, func(i, j int) bool {
			return sevRank[sorted[i].Severity] > sevRank[sorted[j].Severity]
		})
		if len(sorted) > 3 {
			sorted = sorted[:3]
		}

		results = append(results, instanceSummary{
			Name:         name,
			HealthScore:  score,
			Status:       status,
			ActiveAlerts: len(freshAlerts),
			AlertCounts:  counts,
			KeyMetrics:   keyMetrics,
			AreaStatus:   areas,
			TopAlerts:    sorted,
		})
	}

	writeJSON(w, http.StatusOK, results)
}

// GET /api/alerts/history?limit=200 — all alerts (active+resolved) across all instances.
func (s *Server) handleAlertHistory(w http.ResponseWriter, r *http.Request) {
	names := s.manager.Names()
	limit := parseIntParam(r, "limit", 200)
	from := time.Now().Add(-30 * 24 * time.Hour)
	to := time.Now()

	var all []store.Alert
	for _, name := range names {
		alerts, err := s.store.GetAlertHistory(name, from, to, limit)
		if err != nil {
			slog.Error("query alert history", "err", err, "instance", name)
			continue
		}
		all = append(all, alerts...)
	}

	// Also add active alerts that might not be in history yet.
	for _, name := range names {
		active, _ := s.store.GetActiveAlerts(name)
		for _, a := range active {
			found := false
			for _, h := range all {
				if h.DedupKey == a.DedupKey && !h.Resolved {
					found = true
					break
				}
			}
			if !found {
				all = append(all, a)
			}
		}
	}

	writeJSON(w, http.StatusOK, marshalAlerts(all))
}

// GET /api/alerts/active — all active alerts across all instances.
func (s *Server) handleActiveAlerts(w http.ResponseWriter, r *http.Request) {
	names := s.manager.Names()
	var all []store.Alert
	for _, name := range names {
		alerts, err := s.store.GetActiveAlerts(name)
		if err != nil {
			slog.Error("query active alerts", "err", err, "instance", name)
			continue
		}
		all = append(all, alerts...)
	}

	writeJSON(w, http.StatusOK, marshalAlerts(all))
}

// GET /api/instances/{name}/ch-logs?level=Error&search=foo&limit=200&minutes=60
func (s *Server) handleCHLogs(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	level := r.URL.Query().Get("level")
	search := r.URL.Query().Get("search")
	limit := parseIntParam(r, "limit", 200)
	minutes := parseIntParam(r, "minutes", 60)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	where := fmt.Sprintf("event_time >= now() - INTERVAL %d MINUTE", minutes)
	if level != "" {
		where += fmt.Sprintf(" AND level = '%s'", level)
	}
	if search != "" {
		where += fmt.Sprintf(" AND (message LIKE '%%%s%%' OR logger_name LIKE '%%%s%%')", search, search)
	}

	sql := fmt.Sprintf(`SELECT
			event_time, level, logger_name, message,
			thread_id, query_id
		FROM system.text_log
		WHERE %s
		ORDER BY event_time DESC
		LIMIT %d`, where, limit)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		// system.text_log may not exist on all CH versions
		writeJSON(w, http.StatusOK, []interface{}{})
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// GET /api/logs?level=INFO&search=foo&limit=500
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	if s.logs == nil {
		writeJSON(w, http.StatusOK, []LogEntry{})
		return
	}

	entries := s.logs.Entries()
	level := r.URL.Query().Get("level")
	search := r.URL.Query().Get("search")
	limit := parseIntParam(r, "limit", 500)

	// Filter.
	var filtered []LogEntry
	for i := len(entries) - 1; i >= 0 && len(filtered) < limit; i-- {
		e := entries[i]
		if level != "" && !strings.EqualFold(e.Level, level) {
			continue
		}
		if search != "" {
			match := strings.Contains(strings.ToLower(e.Message), strings.ToLower(search))
			if !match {
				// Also search in attrs.
				for _, v := range e.Attrs {
					if strings.Contains(strings.ToLower(fmt.Sprintf("%v", v)), strings.ToLower(search)) {
						match = true
						break
					}
				}
			}
			if !match {
				continue
			}
		}
		filtered = append(filtered, e)
	}

	writeJSON(w, http.StatusOK, filtered)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (s *Server) validInstance(name string) bool {
	return s.manager.Get(name) != nil
}

// getHealthScore computes a simple health score 0-100 from the latest metrics.
// This is a best-effort heuristic: start at 100 and deduct for problems.
func (s *Server) getHealthScore(instance string) float64 {
	score := 100.0

	alerts, err := s.store.GetActiveAlerts(instance)
	if err == nil {
		// Count unique alert categories, not individual alerts
		critCats := make(map[string]bool)
		warnCats := make(map[string]bool)
		for _, a := range alerts {
			switch a.Severity {
			case "critical":
				critCats[a.Category] = true
			case "warn":
				warnCats[a.Category] = true
			}
		}
		score -= float64(len(critCats)) * 15
		score -= float64(len(warnCats)) * 5
	}

	latest, err := s.store.QueryLatestMetrics(instance)
	if err != nil {
		return max(score, 0)
	}

	for _, m := range latest {
		switch m.Name {
		case "memory_usage_percent":
			if m.Value > 90 {
				score -= 15
			} else if m.Value > 80 {
				score -= 5
			}
		case "cpu_usage_percent":
			if m.Value > 95 {
				score -= 10
			} else if m.Value > 80 {
				score -= 3
			}
		case "disk_usage_percent":
			if m.Value > 90 {
				score -= 15
			} else if m.Value > 80 {
				score -= 5
			}
		case "total_parts":
			if m.Value > 500 {
				score -= 10
			} else if m.Value > 300 {
				score -= 3
			}
		}
	}

	if score < 0 {
		score = 0
	}
	return score
}

func parseTimeRange(r *http.Request) (time.Time, time.Time) {
	now := time.Now()
	to := now
	from := now.Add(-1 * time.Hour)

	if v := r.URL.Query().Get("from"); v != "" {
		if ts, err := strconv.ParseInt(v, 10, 64); err == nil {
			from = time.Unix(ts, 0)
		}
	}
	if v := r.URL.Query().Get("to"); v != "" {
		if ts, err := strconv.ParseInt(v, 10, 64); err == nil {
			to = time.Unix(ts, 0)
		}
	}
	return from, to
}

func parseIntParam(r *http.Request, key string, defaultVal int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return defaultVal
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return defaultVal
	}
	return n
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Error("write json response", "err", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

type alertJSON struct {
	ID         int64   `json:"id"`
	Instance   string  `json:"instance"`
	Severity   string  `json:"severity"`
	Category   string  `json:"category"`
	Title      string  `json:"title"`
	Message    string  `json:"message"`
	Resolved   bool    `json:"resolved"`
	ResolvedAt *int64  `json:"resolved_at,omitempty"`
	CreatedAt  int64   `json:"created_at"`
	UpdatedAt  int64   `json:"updated_at"`
	DedupKey   string  `json:"dedup_key"`
}

func marshalAlerts(alerts []store.Alert) []alertJSON {
	out := make([]alertJSON, len(alerts))
	for i, a := range alerts {
		updatedAt := a.UpdatedAt.Unix()
		if a.UpdatedAt.IsZero() {
			updatedAt = a.CreatedAt.Unix()
		}
		out[i] = alertJSON{
			ID:        a.ID,
			Instance:  a.Instance,
			Severity:  a.Severity,
			Category:  a.Category,
			Title:     a.Title,
			Message:   a.Message,
			Resolved:  a.Resolved,
			CreatedAt: a.CreatedAt.Unix(),
			UpdatedAt: updatedAt,
			DedupKey:  a.DedupKey,
		}
		if a.ResolvedAt != nil {
			ts := a.ResolvedAt.Unix()
			out[i].ResolvedAt = &ts
		}
	}
	return out
}

// POST /api/alerts/resolve — resolve a single alert by dedup_key.
func (s *Server) handleResolveAlert(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DedupKey string `json:"dedup_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.DedupKey == "" {
		writeErr(w, http.StatusBadRequest, "dedup_key required")
		return
	}
	if err := s.store.ResolveAlert(body.DedupKey); err != nil {
		writeErr(w, http.StatusInternalServerError, "resolve failed: "+err.Error())
		return
	}
	slog.Info("alert resolved via API", "dedup_key", body.DedupKey)
	writeJSON(w, http.StatusOK, map[string]string{"status": "resolved"})
}

// POST /api/alerts/resolve-stale?hours=24 — bulk-resolve stale alerts.
func (s *Server) handleResolveStale(w http.ResponseWriter, r *http.Request) {
	hours := parseIntParam(r, "hours", 24)
	if hours < 1 {
		hours = 1
	}
	resolved, err := s.store.BulkResolveStale(hours)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "resolve stale failed: "+err.Error())
		return
	}
	slog.Info("bulk resolved stale alerts", "hours", hours, "count", resolved)
	writeJSON(w, http.StatusOK, map[string]int64{"resolved": resolved})
}

