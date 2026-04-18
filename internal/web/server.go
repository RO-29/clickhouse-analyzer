// Package web provides an embedded HTTP dashboard and REST API for ch-analyzer.
package web

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"sort"
	"log/slog"
	"net/http"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/alerter"
	"github.com/rohitjain/ch-analyzer/internal/analyzer"
	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
	"github.com/rohitjain/ch-analyzer/internal/store"
)

//go:embed static
var staticFS embed.FS

// Server serves the web dashboard and REST API.
type Server struct {
	cfg           *config.Config
	store         *store.Store
	analyzer      *analyzer.Analyzer
	manager       *chclient.Manager
	addr          string
	configPath    string // path to ch-analyzer.yaml, passed to MCP subprocess
	srv           *http.Server
	logs          *LogBuffer
	queryHistory  *QueryHistory
	maintenance   *alerter.MaintenanceStore
	snoozeStore   *alerter.SnoozeStore
	ackStore      *alerter.AckStore
	startTime     time.Time
	version       string
	forcePollCh   chan struct{} // signals main loop to run an immediate poll
	scheduleStore *ScheduleStore

	// Active auth-login session state.
	authStdinMu sync.Mutex
	authStdin   io.WriteCloser
	authPid     int // PID of the running claude auth login process

	// Threshold override persistence.
	thresholdsMu           sync.RWMutex
	thresholdsOverridePath string
}

// New creates a new web Server.
func New(addr string, cfg *config.Config, store *store.Store, analyzer *analyzer.Analyzer, manager *chclient.Manager, logs *LogBuffer) *Server {
	return &Server{
		cfg:          cfg,
		store:        store,
		analyzer:     analyzer,
		manager:      manager,
		addr:         addr,
		configPath:   os.Getenv("CH_ANALYZER_CONFIG"),
		logs:         logs,
		queryHistory: NewQueryHistory(100),
		startTime:    time.Now(),
	}
}

// SetMaintenanceStore sets the maintenance store for the server.
// Called from main after the alerter is initialised.
func (s *Server) SetMaintenanceStore(ms *alerter.MaintenanceStore) {
	s.maintenance = ms
}

// SetSnoozeStore sets the snooze store for the server.
// Called from main after the snooze store is initialised.
func (s *Server) SetSnoozeStore(ss *alerter.SnoozeStore) {
	s.snoozeStore = ss
}

// SetAckStore sets the acknowledgment store for the server.
// Called from main after the ack store is initialised.
func (s *Server) SetAckStore(as *alerter.AckStore) {
	s.ackStore = as
}

// SetForcePollCh gives the server a channel it can signal to trigger an
// immediate background poll in the main loop.
func (s *Server) SetForcePollCh(ch chan struct{}) {
	s.forcePollCh = ch
}

// SetVersion sets the binary version string shown in /health.
func (s *Server) SetVersion(v string) {
	s.version = v
}

// SetScheduleStore sets the schedule store for the server.
// Called from main after the schedule store is initialised.
func (s *Server) SetScheduleStore(ss *ScheduleStore) {
	s.scheduleStore = ss
}

// SetThresholdsOverridePath sets the path where threshold overrides are persisted.
// Called from main before the server starts.
func (s *Server) SetThresholdsOverridePath(path string) {
	s.thresholdsOverridePath = path
}

// Start begins serving HTTP traffic. It blocks until the server is shut down.
func (s *Server) Start(ctx context.Context) error {
	mux := http.NewServeMux()
	s.registerRoutes(mux)

	s.srv = &http.Server{
		Addr:              s.addr,
		Handler:           recoveryMiddleware(mux),
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
	mux.HandleFunc("GET /api/instances/{name}/s3-latency-by-table", s.handleS3LatencyByTable)
	mux.HandleFunc("GET /api/instances/{name}/replication", s.handleReplication)

	// Compare endpoints (from compare.go).
	mux.HandleFunc("GET /api/compare/tables", s.handleCompareTables)
	mux.HandleFunc("GET /api/compare/query-stats", s.handleCompareQueryStats)
	mux.HandleFunc("GET /api/compare/settings", s.handleCompareSettings)
	mux.HandleFunc("GET /api/compare/metrics", s.handleCompareMetrics)
	mux.HandleFunc("GET /api/compare/metrics-timeline", s.handleCompareMetricsTimeline)
	mux.HandleFunc("GET /api/compare/query-patterns", s.handleCompareQueryPatterns)
	mux.HandleFunc("GET /api/instances/{name}/table-memory", s.handleTableMemory)
	mux.HandleFunc("GET /api/instances/{name}/cache-stats", s.handleCacheStats)

	// Suggestions endpoint (from suggestions.go).
	mux.HandleFunc("GET /api/suggestions/{category}", s.handleSuggestions)

	// AI Analyzer endpoints (from analyze.go).
	mux.HandleFunc("POST /api/instances/{name}/analyze", s.handleAnalyze)
	mux.HandleFunc("GET /api/instances/{name}/analyze/context", s.handleAnalyzeContext)
	mux.HandleFunc("POST /api/instances/{name}/analyze-element", s.handleAnalyzeElement)
	mux.HandleFunc("GET /api/instances/{name}/analyze-element/queries", s.handleAnalyzeElementQueries)

	// Agentic chat endpoint (from chat.go).
	mux.HandleFunc("POST /api/instances/{name}/chat", s.handleChat)

	// Table scanner endpoints (from table_scanner.go).
	mux.HandleFunc("GET /api/instances/{name}/table-scan", s.handleTableScan)
	mux.HandleFunc("GET /api/instances/{name}/table-scan-debug", s.handleTableScanDebug)
	mux.HandleFunc("GET /api/instances/{name}/table-partitions", s.handleTablePartitions)

	// Advisor endpoints (from advisor.go).
	mux.HandleFunc("GET /api/instances/{name}/advisor/compression", s.handleAdvisorCompression)
	mux.HandleFunc("GET /api/instances/{name}/advisor/query-regression", s.handleAdvisorQueryRegression)
	mux.HandleFunc("GET /api/instances/{name}/advisor/new-patterns", s.handleAdvisorNewPatterns)
	mux.HandleFunc("GET /api/instances/{name}/advisor/unused-tables", s.handleAdvisorUnusedTables)
	mux.HandleFunc("GET /api/instances/{name}/advisor/schema", s.handleAdvisorSchema)
	mux.HandleFunc("GET /api/instances/{name}/advisor/cardinality", s.handleAdvisorCardinality)
	mux.HandleFunc("GET /api/instances/{name}/advisor/storage-policy", s.handleAdvisorStoragePolicy)
	mux.HandleFunc("GET /api/instances/{name}/advisor/query-antipatterns", s.handleAdvisorQueryAntiPatterns)
	mux.HandleFunc("GET /api/instances/{name}/advisor/table-antipatterns", s.handleAdvisorTableAntiPatterns)
	mux.HandleFunc("GET /api/instances/{name}/table-detail/{db}/{table}", s.handleTableDetail)

	// Health score trend endpoint (from health_trend.go).
	mux.HandleFunc("GET /api/instances/{name}/health-trend", s.handleHealthTrend)

	// Historical analysis endpoints (from history.go).
	mux.HandleFunc("GET /api/instances/{name}/health-check", s.handleHealthCheck)
	mux.HandleFunc("GET /api/instances/{name}/query-patterns", s.handleQueryPatterns)
	mux.HandleFunc("GET /api/instances/{name}/query-patterns-v2", s.handleQueryPatternsV2)
	mux.HandleFunc("GET /api/instances/{name}/query-pattern-timeline", s.handleQueryPatternTimeline)
	mux.HandleFunc("GET /api/instances/{name}/query-samples", s.handleQuerySamples)
	mux.HandleFunc("GET /api/instances/{name}/query-pattern-overview", s.handleQueryPatternOverview)
	mux.HandleFunc("GET /api/instances/{name}/query-users", s.handleQueryUsers)
	mux.HandleFunc("POST /api/instances/{name}/kill-query", s.handleKillQuery)
	mux.HandleFunc("GET /api/instances/{name}/history/failures", s.handleHistoryFailures)
	mux.HandleFunc("GET /api/instances/{name}/history/merges", s.handleHistoryMerges)
	mux.HandleFunc("GET /api/instances/{name}/history/mvs", s.handleHistoryMVs)
	mux.HandleFunc("GET /api/instances/{name}/history/inserts", s.handleHistoryInserts)
	mux.HandleFunc("GET /api/instances/{name}/history/s3", s.handleHistoryS3)
	mux.HandleFunc("GET /api/instances/{name}/history/async-metrics", s.handleHistoryAsyncMetrics)
	mux.HandleFunc("GET /api/instances/{name}/history/disk-io", s.handleHistoryDiskIO)

	// Cost explorer.
	mux.HandleFunc("GET /api/instances/{name}/cost", s.handleCost)
	mux.HandleFunc("GET /api/cost", s.handleCostOverview)

	// Health and maintenance endpoints.
	mux.HandleFunc("GET /health", s.handleHealth)

	// Claude auth management (check status, start re-login flow).
	mux.HandleFunc("GET /api/auth/status", s.handleAuthStatus)
	mux.HandleFunc("POST /api/auth/login", s.handleAuthLogin)
	mux.HandleFunc("POST /api/auth/callback", s.handleAuthCallback)
	mux.HandleFunc("POST /api/auth/refresh", s.handleAuthRefresh)
	mux.HandleFunc("POST /api/auth/set-tokens", s.handleAuthSetTokens)
	mux.HandleFunc("GET /api/maintenance", s.handleMaintenanceList)
	mux.HandleFunc("POST /api/maintenance", s.handleMaintenanceCreate)
	mux.HandleFunc("PUT /api/maintenance/{id}", s.handleMaintenanceUpdate)
	mux.HandleFunc("DELETE /api/maintenance/{id}", s.handleMaintenanceDelete)
	mux.HandleFunc("GET /api/alerts/snoozes", s.handleSnoozeList)
	mux.HandleFunc("POST /api/alerts/snooze", s.handleSnoozeCreate)
	mux.HandleFunc("DELETE /api/alerts/snooze/{id}", s.handleSnoozeDelete)
	mux.HandleFunc("GET /api/alerts/acks", s.handleAckList)
	mux.HandleFunc("POST /api/alerts/ack", s.handleAckCreate)
	mux.HandleFunc("DELETE /api/alerts/ack/{id}", s.handleAckDelete)

	// Notification channel status.
	mux.HandleFunc("GET /api/notify/status", s.handleNotifyStatus)

	// Collector registry and ad-hoc run endpoints (from runcheck.go).
	mux.HandleFunc("GET /api/collectors", s.handleGetCollectors)
	mux.HandleFunc("POST /api/run-check", s.handleRunCheck)
	mux.HandleFunc("POST /api/force-poll", s.handleForcePoll)

	// Schedule endpoints (from schedule.go).
	mux.HandleFunc("GET /api/schedules", s.handleScheduleList)
	mux.HandleFunc("POST /api/schedules", s.handleScheduleCreate)
	mux.HandleFunc("DELETE /api/schedules/{id}", s.handleScheduleDelete)
	mux.HandleFunc("PUT /api/schedules/{id}/enabled", s.handleScheduleSetEnabled)

	// Alert stats and parts age for Overview / Explore.
	mux.HandleFunc("GET /api/alerts/stats", s.handleAlertStats)
	mux.HandleFunc("GET /api/instances/{name}/parts-age", s.handlePartsAge)

	// Audit log.
	mux.HandleFunc("GET /api/audit", s.handleAuditLog)

	// Anomaly context endpoint (from anomaly_context.go).
	mux.HandleFunc("GET /api/instances/{name}/anomaly-context", s.handleAnomalyContext)

	// SLO / uptime tracking.
	mux.HandleFunc("GET /api/instances/{name}/slo", s.handleSLO)

	// Alert threshold editor.
	mux.HandleFunc("GET /api/thresholds", s.handleGetThresholds)
	mux.HandleFunc("POST /api/thresholds", s.handlePostThresholds)
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
			formatReadableSize(read_bytes) AS read_size,
			query_kind
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

// POST /api/instances/{name}/kill-query — kill a running query by query_id.
func (s *Server) handleKillQuery(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	var body struct {
		QueryID string `json:"query_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.QueryID == "" {
		writeErr(w, http.StatusBadRequest, "query_id required")
		return
	}

	// Sanitise: query IDs are UUIDs (hex + dashes). Reject anything else.
	for _, c := range body.QueryID {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c == '-') {
			writeErr(w, http.StatusBadRequest, "invalid query_id format")
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	sql := fmt.Sprintf("KILL QUERY WHERE query_id = '%s' ASYNC", body.QueryID)
	_, err := client.QuerySingleValue(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "ACCESS_DENIED") || strings.Contains(err.Error(), "privilege") {
			writeErr(w, http.StatusForbidden, "KILL QUERY privilege required")
			return
		}
		slog.Warn("kill query", "err", err, "instance", instance, "query_id", body.QueryID)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "killed", "query_id": body.QueryID})
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
		Name               string             `json:"name"`
		HealthScore        float64            `json:"health_score"`
		Status             string             `json:"status"`
		ActiveAlerts       int                `json:"active_alerts"`
		AlertCounts        alertCounts        `json:"alert_counts"`
		KeyMetrics         map[string]float64 `json:"key_metrics"`
		AreaStatus         []areaStatus       `json:"area_status"`
		TopAlerts          []topAlert         `json:"top_alerts"`
		InMaintenance      bool               `json:"in_maintenance"`
		MaintenanceUntil   string             `json:"maintenance_until,omitempty"`
		MaintenanceReason  string             `json:"maintenance_reason,omitempty"`
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

		summary := instanceSummary{
			Name:         name,
			HealthScore:  score,
			Status:       status,
			ActiveAlerts: len(freshAlerts),
			AlertCounts:  counts,
			KeyMetrics:   keyMetrics,
			AreaStatus:   areas,
			TopAlerts:    sorted,
		}
		if s.maintenance != nil {
			if win := s.maintenance.GetActiveWindow(name); win != nil {
				summary.InMaintenance = true
				summary.MaintenanceUntil = time.Unix(win.EndTime, 0).UTC().Format(time.RFC3339)
				summary.MaintenanceReason = win.Reason
			}
		}
		results = append(results, summary)
	}

	writeJSON(w, http.StatusOK, results)
}

// GET /api/alerts/history — all alerts (active+resolved) with optional filters.
//
// Query params:
//
//	limit    int    max results (default 500)
//	from     int64  unix timestamp start (default: now-30d)
//	to       int64  unix timestamp end   (default: now)
//	instance string filter to one instance
//	severity string filter by severity (critical|warn|info)
//	category string filter by category
func (s *Server) handleAlertHistory(w http.ResponseWriter, r *http.Request) {
	limit := parseIntParam(r, "limit", 500)
	fromUnix := parseInt64Param(r, "from", 0)
	toUnix := parseInt64Param(r, "to", 0)
	instanceFilter := r.URL.Query().Get("instance")
	severityFilter := r.URL.Query().Get("severity")
	categoryFilter := r.URL.Query().Get("category")

	now := time.Now()
	from := now.Add(-30 * 24 * time.Hour)
	to := now
	if fromUnix > 0 {
		from = time.Unix(fromUnix, 0)
	}
	if toUnix > 0 {
		to = time.Unix(toUnix, 0)
	}

	var names []string
	if instanceFilter != "" {
		names = []string{instanceFilter}
	} else {
		names = s.manager.Names()
	}

	var all []store.Alert
	for _, name := range names {
		alerts, err := s.store.GetAlertHistory(name, from, to, limit)
		if err != nil {
			slog.Error("query alert history", "err", err, "instance", name)
			continue
		}
		all = append(all, alerts...)
	}

	// Include active alerts not yet present in history.
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

	// In-memory filtering for severity / category (avoids store layer complexity).
	if severityFilter != "" || categoryFilter != "" {
		filtered := all[:0]
		for _, a := range all {
			if severityFilter != "" && a.Severity != severityFilter {
				continue
			}
			if categoryFilter != "" && a.Category != categoryFilter {
				continue
			}
			filtered = append(filtered, a)
		}
		all = filtered
	}

	// Sort newest first, cap at limit.
	sort.Slice(all, func(i, j int) bool {
		return all[i].CreatedAt.After(all[j].CreatedAt)
	})
	if len(all) > limit {
		all = all[:limit]
	}

	writeJSON(w, http.StatusOK, marshalAlerts(all))
}

// GET /api/alerts/stats?hours=24 — aggregated alert statistics for Overview.
func (s *Server) handleAlertStats(w http.ResponseWriter, r *http.Request) {
	hours := parseIntParam(r, "hours", 24)
	from := time.Now().Add(-time.Duration(hours) * time.Hour)
	to := time.Now()

	names := s.manager.Names()
	var historical []store.Alert
	for _, name := range names {
		alerts, _ := s.store.GetAlertHistory(name, from, to, 2000)
		historical = append(historical, alerts...)
	}
	var active []store.Alert
	for _, name := range names {
		a, _ := s.store.GetActiveAlerts(name)
		active = append(active, a...)
	}

	type catEntry struct {
		Category string `json:"category"`
		Count    int    `json:"count"`
	}
	catCounts := map[string]int{}
	critical, warn, resolved := 0, 0, 0
	var durationSecs []float64

	for _, a := range historical {
		catCounts[a.Category]++
		if a.Severity == "critical" {
			critical++
		} else if a.Severity == "warn" {
			warn++
		}
		if a.Resolved && a.ResolvedAt != nil && !a.CreatedAt.IsZero() {
			d := a.ResolvedAt.Sub(a.CreatedAt).Seconds()
			if d > 0 {
				durationSecs = append(durationSecs, d)
			}
			resolved++
		}
	}

	var avgDurationSecs float64
	if len(durationSecs) > 0 {
		sum := 0.0
		for _, d := range durationSecs {
			sum += d
		}
		avgDurationSecs = sum / float64(len(durationSecs))
	}

	var topCats []catEntry
	for cat, cnt := range catCounts {
		topCats = append(topCats, catEntry{Category: cat, Count: cnt})
	}
	sort.Slice(topCats, func(i, j int) bool { return topCats[i].Count > topCats[j].Count })
	if len(topCats) > 5 {
		topCats = topCats[:5]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"period_hours":      hours,
		"total_fired":       len(historical),
		"currently_firing":  len(active),
		"resolved":          resolved,
		"critical":          critical,
		"warn":              warn,
		"avg_duration_secs": avgDurationSecs,
		"top_categories":    topCats,
	})
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

// GET /api/instances/{name}/parts-age — active parts sorted by age, for the Explore Parts Age tab.
func (s *Server) handlePartsAge(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sql := `
		SELECT
			database, table,
			count() AS part_count,
			max(toUnixTimestamp(now()) - toUnixTimestamp(modification_time)) / 3600 AS oldest_part_hours,
			min(modification_time) AS oldest_modification,
			sum(rows) AS total_rows,
			sum(bytes_on_disk) AS total_bytes
		FROM system.parts
		WHERE active = 1
		  AND database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
		GROUP BY database, table
		HAVING part_count > 1
		ORDER BY oldest_part_hours DESC
		LIMIT 200`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		slog.Error("parts-age query failed", "instance", instance, "err", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	type partsAgeEntry struct {
		Database          string  `json:"database"`
		Table             string  `json:"table"`
		PartCount         float64 `json:"part_count"`
		OldestPartHours   float64 `json:"oldest_part_hours"`
		OldestModification string `json:"oldest_modification"`
		TotalRows         float64 `json:"total_rows"`
		TotalBytes        float64 `json:"total_bytes"`
	}

	out := make([]partsAgeEntry, 0, len(rows))
	for _, row := range rows {
		out = append(out, partsAgeEntry{
			Database:           toString(row["database"]),
			Table:              toString(row["table"]),
			PartCount:          toFloat64(row["part_count"]),
			OldestPartHours:    toFloat64(row["oldest_part_hours"]),
			OldestModification: toString(row["oldest_modification"]),
			TotalRows:          toFloat64(row["total_rows"]),
			TotalBytes:         toFloat64(row["total_bytes"]),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// GET /api/instances/{name}/ch-logs?level=Error,Warning&search=foo&limit=200&minutes=60
// level may be a single value or comma-separated list; omit for all levels.
func (s *Server) handleCHLogs(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	levelParam := r.URL.Query().Get("level")
	search := r.URL.Query().Get("search")
	limit := parseIntParam(r, "limit", 200)
	minutes := parseIntParam(r, "minutes", 60)

	// Use a generous timeout for large time ranges (24h+ can scan millions of rows).
	timeoutSecs := 90
	if minutes > 360 {
		timeoutSecs = 120
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutSecs)*time.Second)
	defer cancel()

	// Partition pruning: toDate() lets CH skip entire date-granule parts.
	daysBack := (minutes + 1439) / 1440 // ceil(minutes/1440)
	where := fmt.Sprintf(
		"toDate(event_time) >= today() - %d AND event_time >= now() - INTERVAL %d MINUTE",
		daysBack, minutes,
	)
	if levelParam != "" {
		levels := strings.Split(levelParam, ",")
		// Build IN clause with quoted, sanitized values (whitelist-only — no injection possible).
		quoted := make([]string, 0, len(levels))
		for _, l := range levels {
			l = strings.TrimSpace(l)
			switch l {
			case "Fatal", "Critical", "Error", "Warning", "Notice", "Information", "Debug", "Trace":
				quoted = append(quoted, "'"+l+"'")
			}
		}
		if len(quoted) == 1 {
			where += " AND level = " + quoted[0]
		} else if len(quoted) > 1 {
			where += " AND level IN (" + strings.Join(quoted, ", ") + ")"
		}
	}
	if search != "" {
		// Escape LIKE special characters to prevent injection.
		safe := strings.NewReplacer("'", "''", "%", "\\%", "_", "\\_", "\\", "\\\\").Replace(search)
		where += fmt.Sprintf(" AND (message ILIKE '%%%s%%' OR logger_name ILIKE '%%%s%%')", safe, safe)
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

// getHealthScore returns the health score for an instance. It delegates to the
// analyzer's pre-computed score so that the API and the Prometheus metric always
// report the same value.
func (s *Server) getHealthScore(instance string) float64 {
	return float64(s.analyzer.GetHealthScore(instance).Score)
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

func parseInt64Param(r *http.Request, key string, defaultVal int64) int64 {
	v := r.URL.Query().Get(key)
	if v == "" {
		return defaultVal
	}
	n, err := strconv.ParseInt(v, 10, 64)
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

// recoveryMiddleware catches panics in HTTP handlers, logs the stack trace,
// and returns a 500 to the client instead of crashing the server.
func recoveryMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("handler panic", "recover", rec, "stack", string(debug.Stack()))
				writeErr(w, http.StatusInternalServerError, "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type alertJSON struct {
	ID         int64  `json:"id"`
	Instance   string `json:"instance"`
	Severity   string `json:"severity"`
	Category   string `json:"category"`
	Title      string `json:"title"`
	Message    string `json:"message"`
	Resolved   bool   `json:"resolved"`
	ResolvedAt *int64 `json:"resolved_at,omitempty"`
	CreatedAt  int64  `json:"created_at"`
	UpdatedAt  int64  `json:"updated_at"`
	DedupKey   string `json:"dedup_key"`
	// DurationS is the alert lifetime in seconds: resolved_at-created_at when
	// resolved, or now-created_at when still firing.
	DurationS int64 `json:"duration_s"`
}

func marshalAlerts(alerts []store.Alert) []alertJSON {
	now := time.Now()
	out := make([]alertJSON, len(alerts))
	for i, a := range alerts {
		updatedAt := a.UpdatedAt.Unix()
		if a.UpdatedAt.IsZero() {
			updatedAt = a.CreatedAt.Unix()
		}
		var durationS int64
		if a.Resolved && a.ResolvedAt != nil {
			durationS = a.ResolvedAt.Unix() - a.CreatedAt.Unix()
		} else if !a.CreatedAt.IsZero() {
			durationS = int64(now.Sub(a.CreatedAt).Seconds())
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
			DurationS: durationS,
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
		slog.Warn("resolve alert failed", "err", err, "dedup_key", body.DedupKey)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	slog.Info("alert resolved via API", "dedup_key", body.DedupKey)

	// Audit log — best-effort, derive instance from dedup_key.
	instance := extractInstanceFromDedupKey(body.DedupKey)
	actor := r.RemoteAddr
	_ = s.store.LogAction(r.Context(), instance, "alert_resolve", actor, body.DedupKey)

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
		slog.Warn("bulk resolve stale failed", "err", err, "hours", hours)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	slog.Info("bulk resolved stale alerts", "hours", hours, "count", resolved)
	details := fmt.Sprintf(`{"resolved":%d,"stale_hours":%d}`, resolved, hours)
	_ = s.store.LogAction(r.Context(), "", "alert_resolve_stale", r.RemoteAddr, details)
	writeJSON(w, http.StatusOK, map[string]int64{"resolved": resolved})
}

// GET /api/instances/{name}/replication — current replication status from system.replicas.
func (s *Server) handleReplication(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	if !s.validInstance(instance) {
		writeErr(w, http.StatusNotFound, "unknown instance")
		return
	}
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusServiceUnavailable, "instance not connected")
		return
	}

	ctx := r.Context()
	sql := `
		SELECT
			database,
			table,
			replica_name,
			is_leader,
			is_readonly,
			is_session_expired,
			future_parts,
			parts_to_check,
			queue_size,
			inserts_in_queue,
			merges_in_queue,
			log_max_index,
			log_pointer,
			absolute_delay,
			replica_is_active,
			last_exception
		FROM system.replicas
		ORDER BY absolute_delay DESC`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		// Non-replicated instances don't have this table
		writeJSON(w, http.StatusOK, []struct{}{})
		return
	}

	type ReplicaRow struct {
		Database        string  `json:"database"`
		Table           string  `json:"table"`
		ReplicaName     string  `json:"replica_name"`
		IsLeader        bool    `json:"is_leader"`
		IsReadonly      bool    `json:"is_readonly"`
		IsSessionExpired bool   `json:"is_session_expired"`
		FutureParts     float64 `json:"future_parts"`
		PartsToCheck    float64 `json:"parts_to_check"`
		QueueSize       float64 `json:"queue_size"`
		InsertsInQueue  float64 `json:"inserts_in_queue"`
		MergesInQueue   float64 `json:"merges_in_queue"`
		LogMaxIndex     float64 `json:"log_max_index"`
		LogPointer      float64 `json:"log_pointer"`
		AbsoluteDelay   float64 `json:"absolute_delay"`
		ReplicaIsActive bool    `json:"replica_is_active"`
		LastException   string  `json:"last_exception"`
	}

	out := make([]ReplicaRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, ReplicaRow{
			Database:         toString(row["database"]),
			Table:            toString(row["table"]),
			ReplicaName:      toString(row["replica_name"]),
			IsLeader:         toFloat64(row["is_leader"]) != 0,
			IsReadonly:       toFloat64(row["is_readonly"]) != 0,
			IsSessionExpired: toFloat64(row["is_session_expired"]) != 0,
			FutureParts:      toFloat64(row["future_parts"]),
			PartsToCheck:     toFloat64(row["parts_to_check"]),
			QueueSize:        toFloat64(row["queue_size"]),
			InsertsInQueue:   toFloat64(row["inserts_in_queue"]),
			MergesInQueue:    toFloat64(row["merges_in_queue"]),
			LogMaxIndex:      toFloat64(row["log_max_index"]),
			LogPointer:       toFloat64(row["log_pointer"]),
			AbsoluteDelay:    toFloat64(row["absolute_delay"]),
			ReplicaIsActive:  toFloat64(row["replica_is_active"]) != 0,
			LastException:    toString(row["last_exception"]),
		})
	}

	writeJSON(w, http.StatusOK, out)
}

