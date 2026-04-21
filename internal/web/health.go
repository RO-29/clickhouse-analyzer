package web

import (
	"net/http"
	"time"
)

// HealthResponse is returned by GET /health.
type HealthResponse struct {
	Status     string           `json:"status"` // "ok" or "degraded"
	Version    string           `json:"version"`
	Uptime     string           `json:"uptime"`
	LastPollAt *time.Time       `json:"last_poll_at,omitempty"`
	Instances  []InstanceHealth `json:"instances"`
}

// InstanceHealth summarises one ClickHouse instance.
type InstanceHealth struct {
	Name         string     `json:"name"`
	Status       string     `json:"status"` // "ok", "degraded", "unreachable"
	LastPollAt   *time.Time `json:"last_poll_at,omitempty"`
	ActiveAlerts int        `json:"active_alerts"`
}

// handleHealth handles GET /health.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := HealthResponse{
		Status:    "ok",
		Version:   s.version,
		Uptime:    time.Since(s.startTime).Round(time.Second).String(),
		Instances: []InstanceHealth{},
	}

	if s.lastPollFn != nil {
		if t := s.lastPollFn(); !t.IsZero() {
			resp.LastPollAt = &t
		}
	}

	names := s.manager.Names()
	for _, name := range names {
		health := InstanceHealth{
			Name:   name,
			Status: "ok",
		}

		// Count active alerts to determine status.
		alerts, err := s.store.GetActiveAlerts(name)
		if err == nil {
			health.ActiveAlerts = len(alerts)
			for _, a := range alerts {
				if a.Severity == "critical" {
					health.Status = "unreachable"
					break
				}
				if a.Severity == "warn" && health.Status == "ok" {
					health.Status = "degraded"
				}
			}
		}

		resp.Instances = append(resp.Instances, health)
	}

	writeJSON(w, http.StatusOK, resp)
}
