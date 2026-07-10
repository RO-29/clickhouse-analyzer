package alerter

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// webhookCapture records every WebhookPayload the alerter sends, so tests can
// assert that resolve/escalation side effects actually fire.
type webhookCapture struct {
	mu     sync.Mutex
	events []WebhookPayload
}

func (c *webhookCapture) byEvent(event string) []WebhookPayload {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []WebhookPayload
	for _, e := range c.events {
		if e.Event == event {
			out = append(out, e)
		}
	}
	return out
}

func newWebhookCapture(t *testing.T) (*WebhookNotifier, *webhookCapture) {
	t.Helper()
	cap := &webhookCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p WebhookPayload
		_ = json.NewDecoder(r.Body).Decode(&p)
		cap.mu.Lock()
		cap.events = append(cap.events, p)
		cap.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return NewWebhookNotifier(srv.URL, ""), cap
}

// A warn alert that becomes critical must page — previously the escalation rode
// the existing warn DB row (a "touch") and produced no notification at all.
func TestReconcile_SeverityEscalationNotifies(t *testing.T) {
	fs := newFakeStore()
	wh, cap := newWebhookCapture(t)
	am := newTestAlertManager(fs, WithWebhook(wh))

	base := collector.Alert{
		Instance: "h1", Category: "tables", Title: "parts", DedupKey: "h1:tables:parts",
		Severity: collector.SeverityWarn,
	}
	if err := am.Reconcile(context.Background(), []collector.Alert{base}); err != nil {
		t.Fatal(err)
	}
	crit := base
	crit.Severity = collector.SeverityCritical
	if err := am.Reconcile(context.Background(), []collector.Alert{crit}); err != nil {
		t.Fatal(err)
	}

	firing := cap.byEvent("alert_firing")
	if len(firing) < 2 {
		t.Fatalf("expected a firing event for the warn AND the escalation, got %d", len(firing))
	}
	if last := firing[len(firing)-1]; last.Severity != "critical" {
		t.Errorf("escalation event severity = %q, want critical", last.Severity)
	}
}

// A UI-initiated resolve must fire resolve side effects (webhook, and by the
// same path PagerDuty resolve) — not just close the DB row.
func TestResolveAndNotify_FiresResolveSideEffects(t *testing.T) {
	fs := newFakeStore()
	wh, cap := newWebhookCapture(t)
	am := newTestAlertManager(fs, WithWebhook(wh))

	a := collector.Alert{
		Instance: "h1", Category: "memory", Title: "OOM", DedupKey: "h1:memory:OOM",
		Severity: collector.SeverityCritical,
	}
	if err := am.Reconcile(context.Background(), []collector.Alert{a}); err != nil {
		t.Fatal(err)
	}

	if err := am.ResolveAndNotify("h1:memory:OOM"); err != nil {
		t.Fatal(err)
	}
	if !fs.resolved["h1:memory:OOM"] {
		t.Fatal("alert was not resolved in the store")
	}
	if got := cap.byEvent("alert_resolved"); len(got) != 1 {
		t.Fatalf("expected exactly one alert_resolved webhook, got %d", len(got))
	}
}

// A per-instance snooze (empty dedup key, from `/ch snooze <instance>`) must
// persist the alert to the store (UI stays honest) but suppress notification —
// the behaviour that distinguishes snooze from a maintenance window.
func TestReconcile_InstanceSnoozeSuppressesNotify(t *testing.T) {
	fs := newFakeStore()
	wh, cap := newWebhookCapture(t)
	ss := NewSnoozeStore("")
	ss.Add("", "h1", "snoozed via slack", "me", time.Hour) // instance-level snooze
	am := newTestAlertManager(fs, WithWebhook(wh), WithSnooze(ss))

	a := collector.Alert{
		Instance: "h1", Category: "memory", Title: "OOM", DedupKey: "h1:memory:OOM",
		Severity: collector.SeverityCritical,
	}
	if err := am.Reconcile(context.Background(), []collector.Alert{a}); err != nil {
		t.Fatal(err)
	}

	if len(fs.GetAllActiveAlerts()) != 1 {
		t.Fatal("snoozed alert must still be persisted (visible in UI)")
	}
	if got := cap.byEvent("alert_firing"); len(got) != 0 {
		t.Fatalf("snoozed instance must not notify, got %d firing events", len(got))
	}

	// Cancelling the instance snooze lets it notify again on the next cycle.
	if n := ss.CancelInstance("h1"); n != 1 {
		t.Fatalf("CancelInstance should remove 1 snooze, got %d", n)
	}
	if ss.IsSnoozed("h1:memory:OOM", "h1") {
		t.Fatal("instance should no longer be snoozed after cancel")
	}
}

// The heartbeat stale-sweep must also fire resolve side effects, or ghost alerts
// swept after 24h leave their PagerDuty incidents open forever.
func TestResolveStaleAndNotify_FiresResolveSideEffects(t *testing.T) {
	fs := newFakeStore()
	fs.staleResolveAll = true
	wh, cap := newWebhookCapture(t)
	am := newTestAlertManager(fs, WithWebhook(wh))

	a := collector.Alert{
		Instance: "h1", Category: "storage", Title: "disk", DedupKey: "h1:storage:disk",
		Severity: collector.SeverityCritical,
	}
	if err := am.Reconcile(context.Background(), []collector.Alert{a}); err != nil {
		t.Fatal(err)
	}

	n, err := am.ResolveStaleAndNotify(24 * time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected 1 stale resolution, got %d", n)
	}
	if got := cap.byEvent("alert_resolved"); len(got) != 1 {
		t.Fatalf("stale sweep should fire alert_resolved, got %d", len(got))
	}
}
