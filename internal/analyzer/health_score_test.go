package analyzer

import (
	"testing"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// TestHealthScoreBandsReachable verifies the score maps onto the UI bands
// (critical <50, warning <80, else healthy) and — critically — that the
// "critical" band is reachable. The old implementation floored the score at 50,
// so no instance could ever be shown critical and the SLO uptime metric
// (fraction of polls with score<50) was 0 by construction.
func TestHealthScoreBandsReachable(t *testing.T) {
	a := New(AnalyzerThresholds{})

	crit := func(cat string) collector.Alert {
		return collector.Alert{Instance: "n", Severity: collector.SeverityCritical, Category: cat, Title: "c-" + cat}
	}
	warn := func(cat string) collector.Alert {
		return collector.Alert{Instance: "n", Severity: collector.SeverityWarn, Category: cat, Title: "w-" + cat}
	}

	cases := []struct {
		name      string
		alerts    []collector.Alert
		wantScore int
		band      string
	}{
		{"clean", nil, 100, "healthy"},
		{"one warn", []collector.Alert{warn("tables")}, 92, "healthy"},
		{"one critical", []collector.Alert{crit("storage")}, 70, "warning"},
		{"two critical categories", []collector.Alert{crit("storage"), crit("replication")}, 40, "critical"},
		// Category dedup: many alerts in one category count once.
		{"many-in-one-category", []collector.Alert{crit("tables"), crit("tables"), crit("tables")}, 70, "warning"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hs := a.computeHealthScore("n", tc.alerts, nil)
			if hs.Score != tc.wantScore {
				t.Errorf("score = %d, want %d", hs.Score, tc.wantScore)
			}
			if got := band(hs.Score); got != tc.band {
				t.Errorf("band = %q, want %q (score %d)", got, tc.band, hs.Score)
			}
		})
	}
}

// band mirrors the UI mapping in internal/web/server.go.
func band(score int) string {
	switch {
	case score < 50:
		return "critical"
	case score < 80:
		return "warning"
	default:
		return "healthy"
	}
}
