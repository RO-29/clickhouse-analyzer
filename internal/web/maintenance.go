package web

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/alerter"
)

// handleMaintenanceList handles GET /api/maintenance.
// Returns all currently active (non-expired) maintenance windows.
func (s *Server) handleMaintenanceList(w http.ResponseWriter, r *http.Request) {
	if s.maintenance == nil {
		writeJSON(w, http.StatusOK, []*alerter.MaintenanceWindow{})
		return
	}
	windows := s.maintenance.List()
	if windows == nil {
		windows = []*alerter.MaintenanceWindow{}
	}
	writeJSON(w, http.StatusOK, windows)
}

// maintenanceCreateRequest is the POST body for creating a maintenance window.
type maintenanceCreateRequest struct {
	Instance        string `json:"instance"`
	Reason          string `json:"reason"`
	DurationMinutes int    `json:"duration_minutes"`
	CreatedBy       string `json:"created_by"`
}

// handleMaintenanceCreate handles POST /api/maintenance.
func (s *Server) handleMaintenanceCreate(w http.ResponseWriter, r *http.Request) {
	if s.maintenance == nil {
		writeErr(w, http.StatusServiceUnavailable, "maintenance store not available")
		return
	}

	var req maintenanceCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Instance == "" {
		writeErr(w, http.StatusBadRequest, "instance is required")
		return
	}
	if req.DurationMinutes <= 0 {
		writeErr(w, http.StatusBadRequest, "duration_minutes must be positive")
		return
	}

	duration := time.Duration(req.DurationMinutes) * time.Minute
	window := s.maintenance.Add(req.Instance, req.Reason, req.CreatedBy, duration)

	// Audit log — best-effort, don't fail the request on error.
	_ = s.store.LogAction(r.Context(), req.Instance, "maintenance_create", req.CreatedBy, req.Reason)

	writeJSON(w, http.StatusCreated, window)
}

// maintenanceUpdateRequest is the PUT body for editing a maintenance window.
type maintenanceUpdateRequest struct {
	Instance        string `json:"instance"`
	Reason          string `json:"reason"`
	DurationMinutes int    `json:"duration_minutes"` // if > 0, sets EndsAt = now + duration
}

// handleMaintenanceUpdate handles PUT /api/maintenance/{id}.
func (s *Server) handleMaintenanceUpdate(w http.ResponseWriter, r *http.Request) {
	if s.maintenance == nil {
		writeErr(w, http.StatusServiceUnavailable, "maintenance store not available")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id is required")
		return
	}

	var req maintenanceUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var endsAt time.Time
	if req.DurationMinutes > 0 {
		endsAt = time.Now().Add(time.Duration(req.DurationMinutes) * time.Minute)
	}

	if !s.maintenance.Update(id, req.Instance, req.Reason, endsAt) {
		writeErr(w, http.StatusNotFound, "maintenance window not found")
		return
	}

	// Audit log — best-effort.
	if err := s.store.LogAction(r.Context(), req.Instance, "maintenance_update", r.RemoteAddr, id); err != nil {
		slog.Debug("audit log failed for maintenance_update", "err", err)
	}

	// Return the updated window list so the caller can refresh.
	windows := s.maintenance.List()
	if windows == nil {
		windows = []*alerter.MaintenanceWindow{}
	}
	writeJSON(w, http.StatusOK, windows)
}

// handleMaintenanceDelete handles DELETE /api/maintenance/{id}.
func (s *Server) handleMaintenanceDelete(w http.ResponseWriter, r *http.Request) {
	if s.maintenance == nil {
		writeErr(w, http.StatusServiceUnavailable, "maintenance store not available")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id is required")
		return
	}

	if !s.maintenance.Delete(id) {
		writeErr(w, http.StatusNotFound, "maintenance window not found")
		return
	}

	// Audit log — best-effort, don't fail the request on error.
	if err := s.store.LogAction(r.Context(), "", "maintenance_delete", r.RemoteAddr, id); err != nil {
		slog.Debug("audit log failed for maintenance_delete", "err", err)
	}

	w.WriteHeader(http.StatusNoContent)
}
