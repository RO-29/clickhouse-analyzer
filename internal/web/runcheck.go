package web

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// runCheckRequest is the POST body for /api/run-check.
type runCheckRequest struct {
	Collectors []string `json:"collectors"`
	Instances  []string `json:"instances"`
	From       *int64   `json:"from,omitempty"` // unix seconds, optional time range start
	To         *int64   `json:"to,omitempty"`   // unix seconds, optional time range end
}

// runCheckResultItem holds the outcome of one (instance, collector) pair.
type runCheckResultItem struct {
	Instance    string           `json:"instance"`
	Collector   string           `json:"collector"`
	DisplayName string           `json:"display_name"`
	DurationMs  int64            `json:"duration_ms"`
	Alerts      []runCheckAlert  `json:"alerts"`
	Metrics     []runCheckMetric `json:"metrics"`
	Queries     []string         `json:"queries"`
	Error       string           `json:"error"`
}

type runCheckAlert struct {
	Severity string `json:"severity"`
	Category string `json:"category"`
	Title    string `json:"title"`
	Message  string `json:"message"`
}

type runCheckMetric struct {
	Name   string            `json:"name"`
	Value  float64           `json:"value"`
	Labels map[string]string `json:"labels"`
}

// handleGetCollectors handles GET /api/collectors.
func (s *Server) handleGetCollectors(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, collector.AllCollectorMeta())
}

// handleRunCheck handles POST /api/run-check.
func (s *Server) handleRunCheck(w http.ResponseWriter, r *http.Request) {
	limitBody(w, r)
	var req runCheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if len(req.Collectors) == 0 {
		writeErr(w, http.StatusBadRequest, "collectors must not be empty")
		return
	}
	if len(req.Instances) == 0 {
		writeErr(w, http.StatusBadRequest, "instances must not be empty")
		return
	}

	// Validate instances and resolve clients.
	type instanceEntry struct {
		name   string
		client interface{ Name() string }
	}

	// Build display-name lookup for the requested collectors.
	metaByName := make(map[string]collector.CollectorMeta, len(req.Collectors))
	for _, m := range collector.AllCollectorMeta() {
		metaByName[m.Name] = m
	}

	// Validate collectors exist.
	for _, name := range req.Collectors {
		if _, ok := collector.BuildCollector(name); !ok {
			writeErr(w, http.StatusBadRequest, "unknown collector: "+name)
			return
		}
	}

	// Validate instances exist.
	for _, instName := range req.Instances {
		if s.manager.Get(instName) == nil {
			writeErr(w, http.StatusBadRequest, "unknown instance: "+instName)
			return
		}
	}

	// Run all (instance, collector) pairs in parallel.
	type workItem struct {
		instanceName  string
		collectorName string
	}

	var items []workItem
	for _, inst := range req.Instances {
		for _, coll := range req.Collectors {
			items = append(items, workItem{instanceName: inst, collectorName: coll})
		}
	}

	results := make([]runCheckResultItem, len(items))
	var wg sync.WaitGroup

	for i, item := range items {
		wg.Add(1)
		go func(idx int, wi workItem) {
			defer wg.Done()

			meta := metaByName[wi.collectorName]
			queries := meta.Queries
			if queries == nil {
				queries = []string{}
			}
			result := runCheckResultItem{
				Instance:    wi.instanceName,
				Collector:   wi.collectorName,
				DisplayName: meta.DisplayName,
				Alerts:      []runCheckAlert{},
				Metrics:     []runCheckMetric{},
				Queries:     queries,
			}

			client := s.manager.Get(wi.instanceName)

			coll, _ := collector.BuildCollectorFromConfig(wi.collectorName, s.cfg)

			baseCtx := r.Context()
			if req.From != nil && req.To != nil {
				baseCtx = collector.WithTimeRange(baseCtx,
					time.Unix(*req.From, 0),
					time.Unix(*req.To, 0))
			}
			ctx, cancel := context.WithTimeout(baseCtx, 30*time.Second)
			defer cancel()

			start := time.Now()
			cr, err := coll.Collect(ctx, client)
			result.DurationMs = time.Since(start).Milliseconds()

			if err != nil {
				slog.Warn("runcheck: collector failed", "collector", wi.collectorName, "err", err)
				result.Error = "check failed"
				results[idx] = result
				return
			}

			for _, a := range cr.Alerts {
				result.Alerts = append(result.Alerts, runCheckAlert{
					Severity: string(a.Severity),
					Category: a.Category,
					Title:    a.Title,
					Message:  a.Message,
				})
			}
			for _, m := range cr.Metrics {
				labels := m.Labels
				if labels == nil {
					labels = map[string]string{}
				}
				result.Metrics = append(result.Metrics, runCheckMetric{
					Name:   m.Name,
					Value:  m.Value,
					Labels: labels,
				})
			}

			results[idx] = result
		}(i, item)
	}

	wg.Wait()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"results": results,
	})
}

// triggerAlertRequest is the POST body for /api/alerts/trigger.
type triggerAlertRequest struct {
	Instance  string `json:"instance"`
	Severity  string `json:"severity"`
	Category  string `json:"category"`
	Title     string `json:"title"`
	Message   string `json:"message"`
	DedupKey  string `json:"dedup_key"`
}

// handleTriggerAlert handles POST /api/alerts/trigger.
// Writes a single alert directly into the alerts table — equivalent to what the
// background poll would do when it fires the same condition.
func (s *Server) handleTriggerAlert(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeErr(w, http.StatusServiceUnavailable, "store not available")
		return
	}
	limitBody(w, r)
	var req triggerAlertRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Instance == "" || req.Severity == "" || req.Category == "" || req.Title == "" {
		writeErr(w, http.StatusBadRequest, "instance, severity, category and title are required")
		return
	}
	if s.manager.Get(req.Instance) == nil {
		writeErr(w, http.StatusBadRequest, "unknown instance: "+req.Instance)
		return
	}
	dedupKey := req.DedupKey
	if dedupKey == "" {
		dedupKey = req.Instance + ":" + req.Category + ":" + req.Title
	}

	now := time.Now()
	alert := store.Alert{
		Instance:    req.Instance,
		Severity:    req.Severity,
		Category:    req.Category,
		Title:       req.Title,
		Message:     req.Message,
		DedupKey:    dedupKey,
		CreatedAt:   now,
		UpdatedAt:   now,
		FirstSeenAt: now,
		FireCount:   1,
	}
	id, err := s.store.InsertAlert(alert)
	if err != nil {
		slog.Error("trigger alert: insert failed", "err", err)
		writeErr(w, http.StatusInternalServerError, "failed to insert alert: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"id": id, "dedup_key": dedupKey})
}

// handleForcePoll handles POST /api/force-poll.
// Signals the main polling loop to run an immediate collection cycle.
func (s *Server) handleForcePoll(w http.ResponseWriter, r *http.Request) {
	if s.forcePollCh == nil {
		writeErr(w, http.StatusServiceUnavailable, "force poll not configured")
		return
	}
	select {
	case s.forcePollCh <- struct{}{}:
		writeJSON(w, http.StatusOK, map[string]string{"status": "triggered"})
	default:
		// Channel already has a pending poll — that's fine.
		writeJSON(w, http.StatusOK, map[string]string{"status": "already_queued"})
	}
}
