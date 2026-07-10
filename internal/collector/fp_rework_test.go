package collector

import (
	"context"
	"testing"

	"github.com/rohitjain/ch-analyzer/internal/config"
	"github.com/rohitjain/ch-analyzer/internal/testsupport/fakech"
)

func repeatRows(n int, m map[string]any) []map[string]any {
	out := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, m)
	}
	return out
}

// Query failures need a floor — a single exception in 5m must not page.
func TestQueries_FailuresFloor(t *testing.T) {
	thr := config.QueriesThresholds{FailuresWarnCount: 10, FailuresCriticalCount: 50, MaxConcurrent: 100, WarnConcurrent: 50}

	t.Run("below floor: silent", func(t *testing.T) {
		srv := fakech.New(t)
		srv.On("NOT IN (159, 160, 394)", repeatRows(3, map[string]any{"exception_code": "241", "query": "select 1"}))
		c := &QueryCollector{Thresholds: thr}
		res, _ := c.Collect(context.Background(), srv.Client("prod"))
		if n := len(alertsMatching(res, ":queries:failures_5m")); n != 0 {
			t.Fatalf("3 failures (< floor 10) must not alert, got %d", n)
		}
	})

	t.Run("above floor: warn", func(t *testing.T) {
		srv := fakech.New(t)
		srv.On("NOT IN (159, 160, 394)", repeatRows(12, map[string]any{"exception_code": "241", "query": "select 1"}))
		c := &QueryCollector{Thresholds: thr}
		res, _ := c.Collect(context.Background(), srv.Client("prod"))
		got := alertsMatching(res, ":queries:failures_5m")
		if len(got) != 1 || got[0].Severity != SeverityWarn {
			t.Fatalf("12 failures should warn once, got %+v", got)
		}
	})
}

// Timeouts are usually intended client limits — require a floor too.
func TestQueries_TimeoutsFloor(t *testing.T) {
	thr := config.QueriesThresholds{TimeoutsWarnCount: 10, TimeoutsCriticalCount: 50, MaxConcurrent: 100, WarnConcurrent: 50}

	t.Run("a few timeouts: silent", func(t *testing.T) {
		srv := fakech.New(t)
		srv.On("exception_code IN (159, 160, 394)", []map[string]any{
			{"exception_code": 159, "cnt": 3, "user": "u", "sample_query": "q", "sample_exception": "timeout"},
		})
		c := &QueryCollector{Thresholds: thr}
		res, _ := c.Collect(context.Background(), srv.Client("prod"))
		if n := len(alertsMatching(res, ":queries:timeouts_5m")); n != 0 {
			t.Fatalf("3 timeouts (< floor) must not alert, got %d", n)
		}
	})

	t.Run("spike: critical", func(t *testing.T) {
		srv := fakech.New(t)
		srv.On("exception_code IN (159, 160, 394)", []map[string]any{
			{"exception_code": 159, "cnt": 60, "user": "u", "sample_query": "q", "sample_exception": "timeout"},
		})
		c := &QueryCollector{Thresholds: thr}
		res, _ := c.Collect(context.Background(), srv.Client("prod"))
		got := alertsMatching(res, ":queries:timeouts_5m")
		if len(got) != 1 || got[0].Severity != SeverityCritical {
			t.Fatalf("60 timeouts should be critical, got %+v", got)
		}
	})
}

// system.errors is cumulative-since-restart — alert on new occurrences (delta),
// not the lifetime total, and never on the baseline poll.
func TestErrors_DeltaNotLifetime(t *testing.T) {
	c := &ErrorsCollector{}

	// Poll 1: lifetime counter already at 100 — must be a silent baseline.
	srv1 := fakech.New(t)
	srv1.On("system.errors", []map[string]any{
		{"name": "CORRUPTED_DATA", "cnt": 100, "last_error_time": "2026-07-10 12:00:00", "last_error_message": "bad part"},
	})
	res1, _ := c.Collect(context.Background(), srv1.Client("prod"))
	if n := len(alertsMatching(res1, ":errors:system:")); n != 0 {
		t.Fatalf("baseline poll must not alert on a lifetime total, got %d", n)
	}

	// Poll 2: +6 new serious errors since last poll -> critical.
	srv2 := fakech.New(t)
	srv2.On("system.errors", []map[string]any{
		{"name": "CORRUPTED_DATA", "cnt": 106, "last_error_time": "2026-07-10 12:01:00", "last_error_message": "bad part"},
	})
	res2, _ := c.Collect(context.Background(), srv2.Client("prod"))
	got := alertsMatching(res2, ":errors:system:critical")
	if len(got) != 1 {
		t.Fatalf("delta of 6 serious errors should alert critical, got %+v", res2.Alerts)
	}
}

// A dictionary in NOT_LOADED with no exception (lazy load) must not alert; only
// a real load exception is actionable.
func TestDictionaries_LazyLoadNotAlerted(t *testing.T) {
	srv := fakech.New(t)
	srv.On("system.dictionaries", []map[string]any{
		{"database": "d", "name": "lazy", "status": "NOT_LOADED", "last_exception": "", "element_count": 0},
		{"database": "d", "name": "broken", "status": "FAILED", "last_exception": "connection refused", "element_count": 0},
	})
	c := &DictionaryCollector{Thresholds: config.DictionariesThresholds{ReloadFailThreshold: 3}}
	res, _ := c.Collect(context.Background(), srv.Client("prod"))

	if n := len(alertsMatching(res, ":dictionaries:status:d.lazy")); n != 0 {
		t.Errorf("lazy NOT_LOADED dictionary must not alert, got %d", n)
	}
	got := alertsMatching(res, ":dictionaries:status:d.broken")
	if len(got) != 1 || got[0].Severity != SeverityCritical {
		t.Fatalf("dictionary with load exception should alert critical, got %+v", got)
	}
}
