package collector

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/config"
	"github.com/rohitjain/ch-analyzer/internal/testsupport/fakech"
)

// These tests drive each fixed collector through a known ClickHouse state via a
// fake CH server and assert exactly which alerts fire, with which values. They
// are the "does the alert fire on the real condition" half of the harness; the
// SQL-contract test is the "the query is valid against real CH" half.

func rows(rs ...map[string]any) []map[string]any { return rs }

func alertsMatching(res *CollectResult, dedupSubstr string) []Alert {
	var out []Alert
	for _, a := range res.Alerts {
		if strings.Contains(a.DedupKey, dedupSubstr) {
			out = append(out, a)
		}
	}
	return out
}

func metricValue(res *CollectResult, name string) (float64, bool) {
	for _, m := range res.Metrics {
		if m.Name == name {
			return m.Value, true
		}
	}
	return 0, false
}

// --- background_pool: fires only with the corrected metric names -------------

func TestBackgroundPool_MergesPoolSaturation(t *testing.T) {
	srv := fakech.New(t)
	srv.On("system.metrics", rows(
		map[string]any{"metric": "BackgroundMergesAndMutationsPoolTask", "value": 19},
		map[string]any{"metric": "BackgroundMergesAndMutationsPoolSize", "value": 20},
		map[string]any{"metric": "BackgroundFetchesPoolTask", "value": 0},
		map[string]any{"metric": "BackgroundFetchesPoolSize", "value": 8},
	))

	c := &BackgroundPoolCollector{}
	res, err := c.Collect(context.Background(), srv.Client("prod"))
	if err != nil {
		t.Fatal(err)
	}

	got := alertsMatching(res, "bg_pool:merges_mutations")
	if len(got) != 1 {
		t.Fatalf("want 1 merges_mutations alert, got %d (%+v)", len(got), res.Alerts)
	}
	if got[0].Severity != SeverityCritical {
		t.Errorf("want critical, got %s", got[0].Severity)
	}
	if v, ok := metricValue(res, "system.bg_pool.merges_mutations_used_pct"); !ok || v != 95 {
		t.Errorf("want used_pct=95, got %v (ok=%v)", v, ok)
	}
}

// --- async_inserts: FlushError is the real data-loss enum value --------------

func TestAsyncInserts_FlushErrorsFire(t *testing.T) {
	srv := fakech.New(t)
	srv.On("asynchronous_insert_log", rows(
		map[string]any{"total": 100, "errors": 8, "flushed": 92},
	))
	srv.On("system.asynchronous_inserts", rows(
		map[string]any{"queue_depth": 0},
	))

	c := &AsyncInsertsCollector{}
	res, err := c.Collect(context.Background(), srv.Client("prod"))
	if err != nil {
		t.Fatal(err)
	}
	got := alertsMatching(res, "async_inserts:flush_errors")
	if len(got) != 1 || got[0].Severity != SeverityCritical {
		t.Fatalf("want 1 critical flush-error alert, got %+v", res.Alerts)
	}
}

// --- system CPU: normalized metrics drive busy% (OSS path used to be dead) ---

func TestSystemCPU_NormalizedMetricsBusyPercent(t *testing.T) {
	srv := fakech.New(t)
	srv.On("asynchronous_metrics", rows(
		map[string]any{"metric": "OSUserTimeNormalized", "value": 0.90},
		map[string]any{"metric": "OSSystemTimeNormalized", "value": 0.05},
		map[string]any{"metric": "OSIdleTimeNormalized", "value": 0.05},
	))
	srv.OnScalar("uptime()", 3600)

	c := &SystemCollector{
		CPUThresholds: config.CPUThresholds{WarnPercent: 80, CriticalPercent: 95},
	}
	res, err := c.Collect(context.Background(), srv.Client("prod"))
	if err != nil {
		t.Fatal(err)
	}

	v, ok := metricValue(res, "system.cpu.busy_percent")
	if !ok || v < 94 || v > 96 {
		t.Fatalf("want busy_percent ~95, got %v (ok=%v)", v, ok)
	}
	if len(alertsMatching(res, ":cpu:busy")) != 1 {
		t.Fatalf("want 1 CPU alert, got %+v", res.Alerts)
	}
}

// --- inserts: RejectedInserts alerts on the DELTA, not the lifetime counter --

func TestInserts_RejectedInsertsDelta(t *testing.T) {
	current := 100.0
	srv := fakech.New(t)
	srv.OnDynamic("RejectedInserts", func() fakech.Response {
		return fakech.Response{Data: rows(map[string]any{"v": current})}
	})

	c := &InsertCollector{
		Thresholds:      config.InsertsThresholds{RejectedInsertsRateWarn: 1.0},
		PollingInterval: time.Minute,
	}
	client := srv.Client("prod")

	// Poll 1: baseline only — a lifetime counter of 100 must NOT alert.
	res1, _ := c.Collect(context.Background(), client)
	if n := len(alertsMatching(res1, ":inserts:rejected")); n != 0 {
		t.Fatalf("poll 1 (baseline) should not alert, got %d", n)
	}

	// Poll 2: 5 new rejections this interval → alert.
	current = 105
	res2, _ := c.Collect(context.Background(), client)
	if n := len(alertsMatching(res2, ":inserts:rejected")); n != 1 {
		t.Fatalf("poll 2 (delta=5) should alert once, got %d", n)
	}
	if d, _ := metricValue(res2, "inserts.rejected.delta"); d != 5 {
		t.Errorf("want delta metric 5, got %v", d)
	}

	// Poll 3: counter unchanged → no new rejections → no alert (this is the bug
	// the old code had: it fired forever once the counter was non-zero).
	res3, _ := c.Collect(context.Background(), client)
	if n := len(alertsMatching(res3, ":inserts:rejected")); n != 0 {
		t.Fatalf("poll 3 (delta=0) should not alert, got %d", n)
	}
}

// --- parts_age: emits data, never alerts (old-parts != merge pressure) -------

func TestPartsAge_MetricOnlyNoAlerts(t *testing.T) {
	srv := fakech.New(t)
	srv.On("system.parts", rows(
		map[string]any{
			"database": "app", "table": "events",
			"part_count": 40, "oldest_part_hours": 800,
			"total_rows": 1e9, "total_bytes": 5e10,
		},
	))
	c := &PartsAgeCollector{}
	res, err := c.Collect(context.Background(), srv.Client("prod"))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Alerts) != 0 {
		t.Fatalf("parts_age must not emit alerts, got %+v", res.Alerts)
	}
	if v, ok := metricValue(res, "parts.oldest_hours"); !ok || v != 800 {
		t.Errorf("want parts.oldest_hours=800, got %v (ok=%v)", v, ok)
	}
}

// --- schema_drift: per-instance baselines don't clobber each other -----------

func TestSchemaDrift_PerInstanceIsolation(t *testing.T) {
	schemaA := rows(map[string]any{
		"database": "app", "table": "t", "columns": []any{"id:UInt64", "a:String"},
	})
	schemaB := rows(map[string]any{
		"database": "app", "table": "t", "columns": []any{"id:UInt64", "b:Int32", "c:Float64"},
	})
	srvA := fakech.New(t)
	srvA.On("system.columns", schemaA)
	srvB := fakech.New(t)
	srvB.On("system.columns", schemaB)

	c := &SchemaDriftCollector{}
	clientA := srvA.Client("nodeA")
	clientB := srvB.Client("nodeB")

	// Baselines for two nodes with legitimately different schemas.
	if _, err := c.Collect(context.Background(), clientA); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Collect(context.Background(), clientB); err != nil {
		t.Fatal(err)
	}

	// nodeA polled again, schema UNCHANGED. With the old shared-map keying,
	// nodeB's poll would have overwritten the baseline and this would falsely
	// report "schema changed".
	resA, err := c.Collect(context.Background(), clientA)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(alertsMatching(resA, "schema_drift")); n != 0 {
		t.Fatalf("nodeA unchanged schema must not alert, got %d (%+v)", n, resA.Alerts)
	}
}
