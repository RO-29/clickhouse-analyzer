package web

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// runCheckRequest is the POST body for /api/run-check.
type runCheckRequest struct {
	Collectors []string `json:"collectors"`
	Instances  []string `json:"instances"`
}

// runCheckResultItem holds the outcome of one (instance, collector) pair.
type runCheckResultItem struct {
	Instance    string              `json:"instance"`
	Collector   string              `json:"collector"`
	DisplayName string              `json:"display_name"`
	DurationMs  int64               `json:"duration_ms"`
	Alerts      []runCheckAlert     `json:"alerts"`
	Metrics     []runCheckMetric    `json:"metrics"`
	Error       string              `json:"error"`
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
	var req runCheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body: "+err.Error())
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
			result := runCheckResultItem{
				Instance:    wi.instanceName,
				Collector:   wi.collectorName,
				DisplayName: meta.DisplayName,
				Alerts:      []runCheckAlert{},
				Metrics:     []runCheckMetric{},
			}

			client := s.manager.Get(wi.instanceName)

			coll, _ := collector.BuildCollector(wi.collectorName)

			ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
			defer cancel()

			start := time.Now()
			cr, err := coll.Collect(ctx, client)
			result.DurationMs = time.Since(start).Milliseconds()

			if err != nil {
				result.Error = err.Error()
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
