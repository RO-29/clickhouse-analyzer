package web

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/rohitjain/ch-analyzer/internal/alerter"
)

// handleAckList handles GET /api/alerts/acks.
// Returns all current acknowledgments.
func (s *Server) handleAckList(w http.ResponseWriter, r *http.Request) {
	if s.ackStore == nil {
		writeJSON(w, http.StatusOK, []*alerter.AckEntry{})
		return
	}
	entries := s.ackStore.List()
	if entries == nil {
		entries = []*alerter.AckEntry{}
	}
	writeJSON(w, http.StatusOK, entries)
}

// ackCreateRequest is the POST body for acknowledging an alert.
type ackCreateRequest struct {
	DedupKey string `json:"dedup_key"`
	Instance string `json:"instance"`
	Reason   string `json:"reason"`
	AckedBy  string `json:"acked_by"`
}

// handleAckCreate handles POST /api/alerts/ack.
func (s *Server) handleAckCreate(w http.ResponseWriter, r *http.Request) {
	if s.ackStore == nil {
		writeErr(w, http.StatusServiceUnavailable, "ack store not available")
		return
	}

	var req ackCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.DedupKey == "" {
		writeErr(w, http.StatusBadRequest, "dedup_key is required")
		return
	}

	entry := s.ackStore.Add(req.DedupKey, req.Instance, req.Reason, req.AckedBy)

	// Audit log — best-effort, don't fail the request on error.
	if err := s.store.LogAction(r.Context(), req.Instance, "alert_ack", req.AckedBy, req.DedupKey); err != nil {
		slog.Debug("audit log failed for alert_ack", "err", err)
	}

	writeJSON(w, http.StatusCreated, entry)
}

// handleAckDelete handles DELETE /api/alerts/ack/{id}.
func (s *Server) handleAckDelete(w http.ResponseWriter, r *http.Request) {
	if s.ackStore == nil {
		writeErr(w, http.StatusServiceUnavailable, "ack store not available")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id is required")
		return
	}

	if !s.ackStore.Delete(id) {
		writeErr(w, http.StatusNotFound, "ack entry not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
