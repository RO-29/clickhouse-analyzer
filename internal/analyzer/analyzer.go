package analyzer

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// AnalyzerThresholds controls anomaly and sustained-issue detection.
type AnalyzerThresholds struct {
	AnomalyStdDevMultiplier float64
	SustainedIssueCount     int
}

// HealthScore summarises the health of a single instance.
type HealthScore struct {
	Instance string
	Score    int
	Issues   []string
}

// QueryPattern tracks normalised query statistics.
type QueryPattern struct {
	NormalizedQuery string
	Count           int
	AvgDuration     float64
	MaxDuration     float64
	AvgMemory       float64
	AvgRowsRead     float64
	Failures        int
	LastSeen        time.Time
	Users           []string
}

// AnalysisResult is what Analyze returns each cycle.
type AnalysisResult struct {
	Alerts      []collector.Alert
	Metrics     []collector.Metric
	HealthScore HealthScore
	CrossAlerts []collector.Alert
}

// Analyzer processes collector results, detects anomalies, correlates cross-
// collector signals, and computes health scores.
type Analyzer struct {
	thresholds   AnalyzerThresholds
	history      map[string]*RingBuffer   // "instance:metric" -> recent values
	patterns     map[string]*QueryPattern // "instance:normalised_sql" -> stats
	healthScores map[string]HealthScore
	mu           sync.RWMutex
}

// New creates an Analyzer with the given thresholds.
func New(thresholds AnalyzerThresholds) *Analyzer {
	if thresholds.AnomalyStdDevMultiplier <= 0 {
		thresholds.AnomalyStdDevMultiplier = 2.0
	}
	if thresholds.SustainedIssueCount <= 0 {
		thresholds.SustainedIssueCount = 3
	}
	return &Analyzer{
		thresholds:   thresholds,
		history:      make(map[string]*RingBuffer),
		patterns:     make(map[string]*QueryPattern),
		healthScores: make(map[string]HealthScore),
	}
}

// Analyze processes all collector results for a single instance.
func (a *Analyzer) Analyze(instance string, results []*collector.CollectResult) (*AnalysisResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	ar := &AnalysisResult{}

	// Aggregate metrics and alerts from all collectors.
	metricsByName := make(map[string]float64)
	for _, r := range results {
		if r == nil {
			continue
		}
		ar.Alerts = append(ar.Alerts, r.Alerts...)
		for _, m := range r.Metrics {
			metricsByName[m.Name] = m.Value
		}
	}

	// Update history and detect anomalies.
	a.updateHistory(instance, metricsByName, ar)

	// Cross-collector correlation.
	a.crossCollectorAnalysis(instance, metricsByName, ar)

	// Compute health score.
	hs := a.computeHealthScore(instance, ar.Alerts, ar.CrossAlerts)
	ar.HealthScore = hs
	a.healthScores[instance] = hs

	// Emit health score as a metric.
	ar.Metrics = append(ar.Metrics, collector.Metric{
		Instance:  instance,
		Name:      "health_score",
		Value:     float64(hs.Score),
		Timestamp: time.Now(),
	})

	return ar, nil
}

// GetHealthScore returns the last computed health score for an instance.
func (a *Analyzer) GetHealthScore(instance string) HealthScore {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if hs, ok := a.healthScores[instance]; ok {
		return hs
	}
	return HealthScore{Instance: instance, Score: 100}
}

// GetQueryPatterns returns patterns for an instance sorted by impact.
func (a *Analyzer) GetQueryPatterns(instance string) []QueryPattern {
	a.mu.RLock()
	defer a.mu.RUnlock()

	var result []QueryPattern
	prefix := instance + ":"
	for key, p := range a.patterns {
		if strings.HasPrefix(key, prefix) {
			result = append(result, *p)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		return float64(result[i].Count)*result[i].AvgDuration > float64(result[j].Count)*result[j].AvgDuration
	})
	return result
}

// GetMetricHistory returns recent values for a metric.
func (a *Analyzer) GetMetricHistory(instance, metric string) []float64 {
	a.mu.RLock()
	defer a.mu.RUnlock()
	key := instance + ":" + metric
	if rb, ok := a.history[key]; ok {
		return rb.All()
	}
	return nil
}

func (a *Analyzer) updateHistory(instance string, metrics map[string]float64, ar *AnalysisResult) {
	now := time.Now()
	for name, val := range metrics {
		key := instance + ":" + name
		rb, ok := a.history[key]
		if !ok {
			rb = NewRingBuffer(30)
			a.history[key] = rb
		}
		rb.Add(val)

		// Need at least 10 data points for anomaly detection.
		if rb.Count() < 10 {
			continue
		}

		vals := rb.All()
		m := mean(vals)
		sd := stddev(vals, m)
		if sd == 0 {
			continue
		}

		threshold := m + a.thresholds.AnomalyStdDevMultiplier*sd
		if val > threshold {
			ar.CrossAlerts = append(ar.CrossAlerts, collector.Alert{
				Instance:  instance,
				Severity:  collector.SeverityWarn,
				Category:  "anomaly",
				Title:     "Anomaly detected: " + name,
				Message:   formatAnomaly(name, val, m, sd),
				DedupKey:  instance + ":anomaly:" + name,
				Timestamp: now,
			})
		}

		// Sustained issue: last N values all above mean + 1*stddev.
		if a.checkSustained(vals, m, sd) {
			ar.CrossAlerts = append(ar.CrossAlerts, collector.Alert{
				Instance:  instance,
				Severity:  collector.SeverityWarn,
				Category:  "sustained",
				Title:     "Sustained elevated: " + name,
				Message: formatSustained(name, val, m,
					a.thresholds.SustainedIssueCount),
				DedupKey:  instance + ":sustained:" + name,
				Timestamp: now,
			})
		}
	}
}

func (a *Analyzer) checkSustained(vals []float64, m, sd float64) bool {
	n := a.thresholds.SustainedIssueCount
	if len(vals) < n {
		return false
	}
	threshold := m + sd
	for i := len(vals) - n; i < len(vals); i++ {
		if vals[i] <= threshold {
			return false
		}
	}
	return true
}

func (a *Analyzer) crossCollectorAnalysis(instance string, m map[string]float64, ar *AnalysisResult) {
	now := time.Now()

	memUsedPct := m["system.memory.used_percent"]
	runningQueries := m["system.metrics.Query"]
	activeMerges := m["system.metrics.Merge"]
	totalParts := m["tables.total_parts"]
	s3Latency := m["storage.s3.avg_latency"]
	s3Reads := m["storage.s3.concurrent_reads"]

	// High memory + many queries = OOM risk.
	if memUsedPct > 85 && runningQueries > 20 {
		ar.CrossAlerts = append(ar.CrossAlerts, collector.Alert{
			Instance: instance,
			Severity: collector.SeverityCritical,
			Category: "cross",
			Title:    "OOM risk: high memory with many queries",
			Message: formatf("Memory at %.1f%% with %d running queries. "+
				"Risk of OOM kill.", memUsedPct, int(runningQueries)),
			DedupKey:  instance + ":cross:oom_risk",
			Timestamp: now,
		})
	}

	// High merges + many parts = merges can't keep up.
	if activeMerges > 15 && totalParts > 300 {
		ar.CrossAlerts = append(ar.CrossAlerts, collector.Alert{
			Instance: instance,
			Severity: collector.SeverityCritical,
			Category: "cross",
			Title:    "Merges falling behind",
			Message: formatf("%.0f active merges with %.0f total parts. "+
				"Merges cannot keep up with ingestion.", activeMerges, totalParts),
			DedupKey:  instance + ":cross:merges_behind",
			Timestamp: now,
		})
	}

	// S3 latency + concurrent S3 reads = S3 contention.
	if s3Latency > 5 && s3Reads > 10 {
		ar.CrossAlerts = append(ar.CrossAlerts, collector.Alert{
			Instance: instance,
			Severity: collector.SeverityWarn,
			Category: "cross",
			Title:    "S3 contention detected",
			Message: formatf("S3 avg latency %.1fs with %.0f concurrent reads. "+
				"Queries reading from S3 are experiencing contention.", s3Latency, s3Reads),
			DedupKey:  instance + ":cross:s3_contention",
			Timestamp: now,
		})
	}

	// High merges + high insert rate = system overloaded.
	insertRate := m["inserts.rows_per_sec"]
	if activeMerges > 15 && insertRate > 100 {
		ar.CrossAlerts = append(ar.CrossAlerts, collector.Alert{
			Instance: instance,
			Severity: collector.SeverityWarn,
			Category: "cross",
			Title:    "System overloaded: high merges + inserts",
			Message: formatf("%.0f active merges with %.0f inserts/sec. "+
				"Consider throttling ingestion.", activeMerges, insertRate),
			DedupKey:  instance + ":cross:overloaded",
			Timestamp: now,
		})
	}
}

func (a *Analyzer) computeHealthScore(instance string, alerts, crossAlerts []collector.Alert) HealthScore {
	score := 100

	// Deduplicate by category+severity so per-table/per-query alerts (which embed
	// table names in their title) don't each deduct separately. For example, 10
	// tables with cold parts all share the "tables" category and count as one
	// critical deduction rather than 10.
	type dedupKey struct{ category, severity string }
	seen := make(map[dedupKey]bool)
	issueSet := make(map[string]bool)

	var totalDeduct int
	allAlerts := append(alerts, crossAlerts...)
	for _, alert := range allAlerts {
		if alert.Instance != instance && alert.Instance != "" {
			continue
		}
		issueSet[alert.Title] = true
		k := dedupKey{alert.Category, string(alert.Severity)}
		if seen[k] {
			continue
		}
		seen[k] = true
		switch alert.Severity {
		case collector.SeverityCritical:
			totalDeduct += 15
		case collector.SeverityWarn:
			totalDeduct += 5
		case collector.SeverityInfo:
			totalDeduct += 1
		}
	}

	// Cap total deduction at 60 so even badly degraded instances show > 0.
	// With ~8 possible categories, 8 criticals × 15 = 120 → capped → min score 40.
	if totalDeduct > 60 {
		totalDeduct = 60
	}
	score -= totalDeduct

	if score < 0 {
		score = 0
	}

	issues := make([]string, 0, len(issueSet))
	for issue := range issueSet {
		issues = append(issues, issue)
	}
	sort.Strings(issues)

	return HealthScore{
		Instance: instance,
		Score:    score,
		Issues:   issues,
	}
}

// ---------------------------------------------------------------------------
// Query normalisation
// ---------------------------------------------------------------------------

var (
	reStringLiteral = regexp.MustCompile(`'[^']*'`)
	reNumberLiteral = regexp.MustCompile(`\b\d+\.?\d*\b`)
	reInList        = regexp.MustCompile(`IN\s*\([^)]+\)`)
	reWhitespace    = regexp.MustCompile(`\s+`)
)

// NormalizeQuery replaces literals in SQL with placeholders for grouping.
func NormalizeQuery(sql string) string {
	s := reStringLiteral.ReplaceAllString(sql, "'?'")
	s = reInList.ReplaceAllString(s, "IN (?)")
	s = reNumberLiteral.ReplaceAllString(s, "?")
	s = reWhitespace.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// ---------------------------------------------------------------------------
// RingBuffer
// ---------------------------------------------------------------------------

// RingBuffer is a fixed-size circular buffer of float64 values.
type RingBuffer struct {
	values []float64
	size   int
	pos    int
	count  int
}

// NewRingBuffer creates a ring buffer that holds up to size values.
func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{
		values: make([]float64, size),
		size:   size,
	}
}

// Add appends a value, overwriting the oldest if full.
func (rb *RingBuffer) Add(v float64) {
	rb.values[rb.pos] = v
	rb.pos = (rb.pos + 1) % rb.size
	if rb.count < rb.size {
		rb.count++
	}
}

// All returns all stored values in insertion order.
func (rb *RingBuffer) All() []float64 {
	if rb.count < rb.size {
		return append([]float64(nil), rb.values[:rb.count]...)
	}
	out := make([]float64, rb.size)
	copy(out, rb.values[rb.pos:])
	copy(out[rb.size-rb.pos:], rb.values[:rb.pos])
	return out
}

// Count returns how many values are stored.
func (rb *RingBuffer) Count() int { return rb.count }

// Last returns the most recently added value.
func (rb *RingBuffer) Last() float64 {
	if rb.count == 0 {
		return 0
	}
	idx := (rb.pos - 1 + rb.size) % rb.size
	return rb.values[idx]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func mean(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range vals {
		sum += v
	}
	return sum / float64(len(vals))
}

func stddev(vals []float64, m float64) float64 {
	if len(vals) < 2 {
		return 0
	}
	sum := 0.0
	for _, v := range vals {
		d := v - m
		sum += d * d
	}
	return math.Sqrt(sum / float64(len(vals)-1))
}

func formatAnomaly(name string, val, m, sd float64) string {
	return fmt.Sprintf("%s = %.2f (mean=%.2f, stddev=%.2f, %.1f sigma above mean)",
		name, val, m, sd, (val-m)/sd)
}

func formatSustained(name string, val, m float64, n int) string {
	return fmt.Sprintf("%s has been elevated for %d consecutive checks (current=%.2f, mean=%.2f)",
		name, n, val, m)
}

func formatf(format string, args ...interface{}) string {
	return fmt.Sprintf(format, args...)
}
