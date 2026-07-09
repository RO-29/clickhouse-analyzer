package web

import (
	"context"
	"net/http"
	"time"
)

// handleCapabilities reports the detected version, edition, and per-feature
// availability for one instance. The frontend uses it to render a compatibility
// panel and to show "not supported on this version/edition" states instead of
// empty or errored tabs.
//
// GET /api/instances/{name}/capabilities
func (s *Server) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	caps := client.Caps(ctx)
	writeJSON(w, http.StatusOK, caps)
}
