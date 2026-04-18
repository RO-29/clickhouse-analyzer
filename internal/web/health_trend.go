package web

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/store"
)

// GET /api/instances/{name}/health-trend?from=<epoch>&to=<epoch>
func (s *Server) handleHealthTrend(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")

	from := time.Now().Add(-24 * time.Hour)
	if v := r.URL.Query().Get("from"); v != "" {
		from = time.Unix(parseInt64(v), 0)
	}

	to := time.Now()
	if v := r.URL.Query().Get("to"); v != "" {
		to = time.Unix(parseInt64(v), 0)
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	snapshots, err := s.store.GetHealthTrend(ctx, instance, from, to)
	if err != nil {
		slog.Warn("health trend query failed", "instance", instance, "err", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if snapshots == nil {
		snapshots = []store.HealthSnapshot{}
	}
	writeJSON(w, http.StatusOK, snapshots)
}
