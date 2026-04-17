package web

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/alerter"
)

// handleSnoozeList handles GET /api/alerts/snoozes.
// Returns all currently active (non-expired) snooze entries.
func (s *Server) handleSnoozeList(w http.ResponseWriter, r *http.Request) {
	if s.snoozeStore == nil {
		writeJSON(w, http.StatusOK, []*alerter.SnoozeEntry{})
		return
	}
	entries := s.snoozeStore.List()
	if entries == nil {
		entries = []*alerter.SnoozeEntry{}
	}
	writeJSON(w, http.StatusOK, entries)
}

// snoozeCreateRequest is the POST body for creating a snooze.
type snoozeCreateRequest struct {
	DedupKey        string `json:"dedup_key"`
	Instance        string `json:"instance"`
	Reason          string `json:"reason"`
	SnoozedBy       string `json:"snoozed_by"`
	DurationMinutes int    `json:"duration_minutes"`
}

// handleSnoozeCreate handles POST /api/alerts/snooze.
func (s *Server) handleSnoozeCreate(w http.ResponseWriter, r *http.Request) {
	if s.snoozeStore == nil {
		writeErr(w, http.StatusServiceUnavailable, "snooze store not available")
		return
	}

	var req snoozeCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.DedupKey == "" {
		writeErr(w, http.StatusBadRequest, "dedup_key is required")
		return
	}
	if req.DurationMinutes <= 0 {
		writeErr(w, http.StatusBadRequest, "duration_minutes must be positive")
		return
	}

	duration := time.Duration(req.DurationMinutes) * time.Minute
	entry := s.snoozeStore.Add(req.DedupKey, req.Instance, req.Reason, req.SnoozedBy, duration)

	// Audit log — best-effort, don't fail the request on error.
	_ = s.store.LogAction(r.Context(), req.Instance, "alert_snooze", req.SnoozedBy, req.DedupKey)

	writeJSON(w, http.StatusCreated, entry)
}

// handleSnoozeDelete handles DELETE /api/alerts/snooze/{id}.
func (s *Server) handleSnoozeDelete(w http.ResponseWriter, r *http.Request) {
	if s.snoozeStore == nil {
		writeErr(w, http.StatusServiceUnavailable, "snooze store not available")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id is required")
		return
	}

	if !s.snoozeStore.Delete(id) {
		writeErr(w, http.StatusNotFound, "snooze not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
