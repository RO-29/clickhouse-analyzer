package web

import (
	"math"
	"net/http"
)

// AnomalyContext is returned by GET /api/instances/{name}/anomaly-context?metric=...
// It provides statistical context for a metric from the in-memory ring buffer.
type AnomalyContext struct {
	Metric    string    `json:"metric"`
	Values    []float64 `json:"values"`    // ring buffer history (up to 30 points)
	Mean      float64   `json:"mean"`
	StdDev    float64   `json:"std_dev"`
	Current   float64   `json:"current"`   // last value in ring buffer
	ZScore    float64   `json:"z_score"`   // (current - mean) / stddev, 0 if stddev==0
	Threshold float64   `json:"threshold"` // mean + 2*stddev (default multiplier)
}

// GET /api/instances/{name}/anomaly-context?metric=MemoryResident
func (s *Server) handleAnomalyContext(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	metric := r.URL.Query().Get("metric")
	if metric == "" {
		writeErr(w, http.StatusBadRequest, "metric is required")
		return
	}
	if s.analyzer == nil {
		writeErr(w, http.StatusServiceUnavailable, "analyzer not available")
		return
	}
	values := s.analyzer.GetMetricHistory(instance, metric)
	if len(values) == 0 {
		writeJSON(w, http.StatusOK, AnomalyContext{Metric: metric})
		return
	}

	// Compute mean.
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	m := sum / float64(len(values))

	// Compute stddev (sample).
	var sd float64
	if len(values) >= 2 {
		sumSq := 0.0
		for _, v := range values {
			d := v - m
			sumSq += d * d
		}
		sd = math.Sqrt(sumSq / float64(len(values)-1))
	}

	current := values[len(values)-1]
	zScore := 0.0
	if sd != 0 {
		zScore = (current - m) / sd
	}

	ctx := AnomalyContext{
		Metric:    metric,
		Values:    values,
		Mean:      m,
		StdDev:    sd,
		Current:   current,
		ZScore:    zScore,
		Threshold: m + 2*sd,
	}
	writeJSON(w, http.StatusOK, ctx)
}
