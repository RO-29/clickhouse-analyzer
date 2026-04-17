package web

import (
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// TimelineSeries is all points for one instance.
type TimelineSeries struct {
	Instance string          `json:"instance"`
	Color    string          `json:"color"`
	Points   []DataPointJSON `json:"points"`
}

// DataPointJSON is a JSON-serialisable timestamp-value pair.
type DataPointJSON struct {
	TS    int64   `json:"ts"`
	Value float64 `json:"value"`
}

// TimelineResponse is the multi-instance response for the metrics-timeline endpoint.
type TimelineResponse struct {
	Metric string           `json:"metric"`
	Series []TimelineSeries `json:"series"`
}

var timelinePalette = []string{
	"#3b82f6", "#22c55e", "#f59e0b", "#ef4444",
	"#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
}

// handleCompareMetricsTimeline fans out to all instances and returns a
// per-instance time-series for a single metric.
//
// GET /api/compare/metrics-timeline?metric=MemoryResident&from=<epoch>&to=<epoch>&points=60
func (s *Server) handleCompareMetricsTimeline(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	metric := q.Get("metric")
	if metric == "" {
		writeErr(w, http.StatusBadRequest, "metric param required")
		return
	}

	// from / to — default to last hour
	fromEpoch := parseInt64(q.Get("from"))
	toEpoch := parseInt64(q.Get("to"))
	if fromEpoch == 0 {
		fromEpoch = time.Now().Add(-1 * time.Hour).Unix()
	}
	if toEpoch == 0 {
		toEpoch = time.Now().Unix()
	}
	fromTime := time.Unix(fromEpoch, 0)
	toTime := time.Unix(toEpoch, 0)

	// points — default 60
	points := 60
	if ps := q.Get("points"); ps != "" {
		if n, err := strconv.Atoi(ps); err == nil && n > 0 {
			points = n
		}
	}

	instances := s.manager.Names()

	type result struct {
		instance string
		pts      []DataPointJSON
		err      error
	}

	ch := make(chan result, len(instances))
	var wg sync.WaitGroup

	for _, inst := range instances {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			dp, err := s.store.QueryMetricsSeries(name, metric, fromTime, toTime, points)
			if err != nil {
				slog.Warn("metrics-timeline: query failed", "instance", name, "metric", metric, "err", err)
				ch <- result{instance: name, err: err}
				return
			}
			pts := make([]DataPointJSON, 0, len(dp))
			for _, p := range dp {
				pts = append(pts, DataPointJSON{
					TS:    p.Timestamp.Unix(),
					Value: p.Value,
				})
			}
			ch <- result{instance: name, pts: pts}
		}(inst)
	}

	wg.Wait()
	close(ch)

	// Collect and order by original instances slice so colors are stable.
	byName := make(map[string][]DataPointJSON, len(instances))
	for r := range ch {
		if r.err == nil {
			byName[r.instance] = r.pts
		}
	}

	series := make([]TimelineSeries, 0, len(instances))
	for i, name := range instances {
		pts, ok := byName[name]
		if !ok {
			pts = []DataPointJSON{}
		}
		series = append(series, TimelineSeries{
			Instance: name,
			Color:    timelinePalette[i%len(timelinePalette)],
			Points:   pts,
		})
	}

	writeJSON(w, http.StatusOK, TimelineResponse{
		Metric: metric,
		Series: series,
	})
}
