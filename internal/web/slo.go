package web

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// SLOReport summarises uptime and health-score percentiles for a given time window.
type SLOReport struct {
	UptimePct  float64 `json:"uptime_pct"`  // % polls where score > 0 (instance was up and not totally degraded)
	HealthyPct float64 `json:"healthy_pct"` // % polls where score >= 70
	P50Score   float64 `json:"p50_score"`
	P95Score   float64 `json:"p95_score"`
	TotalPolls int     `json:"total_polls"`
	WindowDays int     `json:"window_days"`
}

// GET /api/instances/{name}/slo?window=7
func (s *Server) handleSLO(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	windowDays := parseIntParam(r, "window", 7)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	db := s.store.Database()
	sql := fmt.Sprintf(`SELECT
  count() AS total_polls,
  countIf(score >= 50) AS up_polls,
  countIf(score >= 70) AS healthy_polls,
  quantile(0.5)(score) AS p50,
  quantile(0.95)(score) AS p95
FROM %s.health_snapshots
WHERE instance = '%s' AND ts >= now() - INTERVAL %d DAY`,
		db, escapeSQLString(instance), windowDays)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to query health_snapshots: "+err.Error())
		return
	}

	report := SLOReport{WindowDays: windowDays}

	if len(rows) > 0 {
		row := rows[0]
		total := int(toFloat64(row["total_polls"]))
		report.TotalPolls = total
		if total > 0 {
			report.UptimePct = toFloat64(row["up_polls"]) / float64(total) * 100
			report.HealthyPct = toFloat64(row["healthy_polls"]) / float64(total) * 100
			report.P50Score = toFloat64(row["p50"])
			report.P95Score = toFloat64(row["p95"])
		}
		// When total_polls == 0, values stay 0 and frontend shows "No data yet".
	}

	writeJSON(w, http.StatusOK, report)
}
