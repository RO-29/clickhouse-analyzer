package web

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/store"
)

// handleAuditLog handles GET /api/audit.
// Query params: from=<epoch>, to=<epoch>, instance=<>, action=<>, limit=<int>
func (s *Server) handleAuditLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	opts := store.AuditLogQuery{
		Instance: q.Get("instance"),
		Action:   q.Get("action"),
		Limit:    parseIntParam(r, "limit", 200),
	}

	if fromStr := q.Get("from"); fromStr != "" {
		opts.From = time.Unix(parseInt64(fromStr), 0)
	}
	if toStr := q.Get("to"); toStr != "" {
		opts.To = time.Unix(parseInt64(toStr), 0)
	}

	events, err := s.store.GetAuditLog(r.Context(), opts)
	if err != nil {
		slog.Warn("audit log query failed", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if events == nil {
		events = []store.AuditEvent{}
	}
	writeJSON(w, http.StatusOK, events)
}

// extractInstanceFromDedupKey extracts the instance name from a dedup key like
// "single-node-a:category:subcategory". Returns the full key if no colon found.
func extractInstanceFromDedupKey(dedupKey string) string {
	if i := strings.Index(dedupKey, ":"); i > 0 {
		return dedupKey[:i]
	}
	return dedupKey
}
