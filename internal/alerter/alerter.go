package alerter

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// StoreInterface abstracts the persistence layer so the alerter can record and
// query alert state without depending on a concrete store implementation.
type StoreInterface interface {
	// InsertAlert persists a new alert and returns its auto-generated ID.
	InsertAlert(alert collector.Alert) (int64, error)
	// ResolveAlert marks the alert identified by dedupKey as resolved.
	ResolveAlert(dedupKey string) error
	// IsAlertActive reports whether an alert with the given dedupKey is
	// currently in a firing (unresolved) state.
	IsAlertActive(dedupKey string) (bool, error)
	// TouchAlerts bumps updated_at = now() for the given dedup keys so
	// staleness detection stays accurate across restarts.
	TouchAlerts(dedupKeys []string) error
	// UpdateFireCount persists the current fire_count (and first_seen_at) for
	// an alert so that a subsequent restart can restore them via Rehydrate.
	UpdateFireCount(dedupKey string, count int, firstSeenAt time.Time) error
}

// ActiveAlert tracks the lifecycle of a currently-firing alert.
type ActiveAlert struct {
	Alert     collector.Alert
	FirstSeen time.Time
	LastSeen  time.Time
	Count     int
	Notified  bool
	// cleanChecks counts consecutive polling cycles where this alert was NOT
	// present. After resolveCleanChecks clean checks the alert is considered resolved.
	cleanChecks int
}

// AlertManager provides deduplication, severity-based routing, and automatic
// resolution tracking for alerts produced by collectors.
//
// Slack model: ONE message per instance, updated in-place. All active alerts
// for an instance (critical + warn) appear in a single grouped message.
// When all alerts clear the same message flips to "All clear". If alerts
// re-fire the same Slack message is reused — zero extra posts.
type AlertManager struct {
	slack        *SlackNotifier
	store        StoreInterface
	dedupWindow  time.Duration
	activeAlerts map[string]*ActiveAlert // dedupKey -> alert
	instanceTS   map[string]string       // instance -> Slack message TS (one per instance)
	dirtyInst    map[string]bool         // instances needing an immediate Slack refresh
	mu           sync.Mutex

	// lastInstanceUpdate rate-limits Slack API calls per instance.
	lastInstanceUpdate map[string]time.Time

	// infoBatch accumulates info-level alerts for digest-only delivery.
	infoBatch []collector.Alert
	infoMu    sync.Mutex

	// heartbeatInterval controls how often active-instance messages are refreshed
	// even when no state changes (shows "still firing, updated at X").
	heartbeatInterval time.Duration

	// resolveCleanChecks is the number of consecutive clean cycles before an
	// alert is marked resolved. Default: 4 (~4 min with 1-min polling).
	resolveCleanChecks int

	// Inhibition suppresses noisy symptom alerts when a root-cause is firing.
	inhibition *InhibitionMatcher

	// maintenance suppresses all alerts for instances in a maintenance window.
	maintenance *MaintenanceStore

	// snooze suppresses notifications for specific alerts by dedupKey.
	snooze *SnoozeStore

	// ack tracks acknowledged alerts; cleared when an alert resolves.
	ack *AckStore

	// pagerduty sends critical alert events to PagerDuty (optional).
	pagerduty *PagerDutyNotifier

	// webhook sends structured JSON payloads to a generic endpoint (optional).
	webhook *WebhookNotifier

	// instanceFirstFired records when the first Slack alert was sent per instance.
	instanceFirstFired map[string]time.Time

	// lastEscalated records the last time an escalation notice was sent per instance.
	lastEscalated map[string]time.Time

	// escalation controls when escalation notices are sent.
	escalation EscalationConfig

	// onStateChange is called (in a goroutine) after each successful Slack update.
	// Used by SlackApp to refresh the pinned dashboard message.
	onStateChange func()

	cancel context.CancelFunc
	wg     sync.WaitGroup
	logger *slog.Logger
}

// Option configures an AlertManager.
type Option func(*AlertManager)

// WithDedupWindow overrides the default 15-minute deduplication window.
func WithDedupWindow(d time.Duration) Option {
	return func(am *AlertManager) { am.dedupWindow = d }
}

// WithBatchInterval overrides the default 5-minute heartbeat interval.
// (Formerly the warn-batch flush interval — repurposed as heartbeat.)
func WithBatchInterval(d time.Duration) Option {
	return func(am *AlertManager) { am.heartbeatInterval = d }
}

// WithResolveCleanChecks overrides how many consecutive clean polls are needed
// to resolve an alert (default 4).
func WithResolveCleanChecks(n int) Option {
	return func(am *AlertManager) { am.resolveCleanChecks = n }
}

// WithInhibition installs an InhibitionMatcher that suppresses noisy
// symptom alerts when a root-cause alert is already firing.
func WithInhibition(rules []InhibitionRule) Option {
	return func(am *AlertManager) {
		am.inhibition = &InhibitionMatcher{Rules: rules}
	}
}

// WithMaintenance installs a MaintenanceStore. Alerts for instances that are
// in maintenance are silently dropped (not persisted or sent to Slack).
func WithMaintenance(store *MaintenanceStore) Option {
	return func(am *AlertManager) { am.maintenance = store }
}

// WithSnooze installs a SnoozeStore. Alerts whose dedupKey is snoozed are
// still tracked in activeAlerts (for state/resolution) but skip Slack/PD/webhook
// notification for the duration of the snooze.
func WithSnooze(store *SnoozeStore) Option {
	return func(am *AlertManager) { am.snooze = store }
}

// WithAck installs an AckStore. When an alert resolves all acknowledgments for
// its dedupKey are cleared so the next firing starts fresh.
func WithAck(store *AckStore) Option {
	return func(am *AlertManager) { am.ack = store }
}

// WithPagerDuty installs a PagerDutyNotifier for critical alert escalation.
func WithPagerDuty(notifier *PagerDutyNotifier) Option {
	return func(am *AlertManager) { am.pagerduty = notifier }
}

// WithWebhook installs a WebhookNotifier for generic event delivery.
func WithWebhook(notifier *WebhookNotifier) Option {
	return func(am *AlertManager) { am.webhook = notifier }
}

// WithEscalation overrides the default escalation configuration.
func WithEscalation(cfg EscalationConfig) Option {
	return func(am *AlertManager) { am.escalation = cfg }
}

// NewAlertManager creates a ready-to-use AlertManager. Call Start to begin
// background goroutines and Stop to shut them down.
func NewAlertManager(slackNotifier *SlackNotifier, store StoreInterface, opts ...Option) *AlertManager {
	am := &AlertManager{
		slack:              slackNotifier,
		store:              store,
		dedupWindow:        15 * time.Minute,
		heartbeatInterval:  5 * time.Minute,
		resolveCleanChecks: 4,
		escalation:         DefaultEscalationConfig(),
		activeAlerts:       make(map[string]*ActiveAlert),
		instanceTS:         make(map[string]string),
		dirtyInst:          make(map[string]bool),
		lastInstanceUpdate: make(map[string]time.Time),
		instanceFirstFired: make(map[string]time.Time),
		lastEscalated:      make(map[string]time.Time),
		logger: slog.Default().With(
			slog.String("component", "alert-manager"),
		),
	}
	for _, o := range opts {
		o(am)
	}
	return am
}

// Start launches background goroutines for heartbeat refreshes and resolution
// checking. It is safe to call Process before Start.
func (am *AlertManager) Start(ctx context.Context) {
	ctx, am.cancel = context.WithCancel(ctx)

	am.wg.Add(1)
	go am.heartbeatLoop(ctx)

	am.wg.Add(1)
	go am.resolutionLoop(ctx)

	am.logger.Info("alert manager started",
		slog.Duration("dedup_window", am.dedupWindow),
		slog.Duration("heartbeat_interval", am.heartbeatInterval),
		slog.Int("resolve_clean_checks", am.resolveCleanChecks),
	)
}

// Rehydrate loads previously-active alerts from the store back into the
// in-memory tracking map after a restart.
// It restores FirstSeen and Count from the stored values so that "firing since"
// time and escalation timers continue from the original fire time rather than
// from restart time.
func (am *AlertManager) Rehydrate(alerts []collector.Alert) {
	am.mu.Lock()
	defer am.mu.Unlock()
	now := time.Now()
	n := 0
	for _, a := range alerts {
		key := a.DedupKey
		if key == "" {
			key = fmt.Sprintf("%s:%s:%s", a.Instance, a.Category, a.Title)
		}
		if _, exists := am.activeAlerts[key]; !exists {
			// Restore FirstSeen from store if available; fall back to now.
			firstSeen := now
			if !a.FirstSeenAt.IsZero() {
				firstSeen = a.FirstSeenAt
			}
			// Restore Count from store if available; fall back to 1.
			count := 1
			if a.FireCount > 0 {
				count = a.FireCount
			}
			am.activeAlerts[key] = &ActiveAlert{
				Alert:     a,
				FirstSeen: firstSeen,
				LastSeen:  now,
				Count:     count,
			}
			n++
		}
	}
	if n > 0 {
		am.logger.Info("rehydrated active alerts from store", slog.Int("count", n))
	}
}

// Stop gracefully shuts down background goroutines.
func (am *AlertManager) Stop() {
	if am.cancel != nil {
		am.cancel()
	}
	am.wg.Wait()
	am.logger.Info("alert manager stopped")
}

// ---------------------------------------------------------------------------
// Process — main entry point called each polling cycle
// ---------------------------------------------------------------------------

// Process evaluates a set of alerts produced by the current poll cycle. It
// applies deduplication, routes info alerts to the digest batch, and tracks
// which instances need a Slack message refresh.
func (am *AlertManager) Process(alerts []collector.Alert) {
	now := time.Now()
	seen := make(map[string]bool, len(alerts))

	am.mu.Lock()

	for i := range alerts {
		alert := alerts[i]
		key := alert.DedupKey
		if key == "" {
			key = fmt.Sprintf("%s:%s:%s", alert.Instance, alert.Category, alert.Title)
		}
		seen[key] = true

		// Maintenance check: if the instance is in maintenance, skip entirely
		// (no tracking, no persistence, no Slack).
		if am.maintenance != nil && am.maintenance.IsInMaintenance(alert.Instance) {
			am.logger.Debug("alert suppressed (maintenance)",
				slog.String("instance", alert.Instance),
				slog.String("dedup_key", key),
			)
			continue
		}

		active, exists := am.activeAlerts[key]
		if exists {
			// Already tracking — update counters, no Slack update on mere count bumps.
			active.LastSeen = now
			active.Count++
			active.cleanChecks = 0
			active.Alert = alert
			am.logger.Debug("alert deduplicated",
				slog.String("dedup_key", key),
				slog.Int("count", active.Count),
			)
			continue
		}

		// New alert — register it.
		active = &ActiveAlert{
			Alert:     alert,
			FirstSeen: now,
			LastSeen:  now,
			Count:     1,
		}
		am.activeAlerts[key] = active

		// Info alerts only go to the digest batch, not Slack.
		if alert.Severity == collector.SeverityInfo {
			am.mu.Unlock()
			am.enqueueInfo(alert)
			am.mu.Lock()
			continue
		}

		// Inhibition check: track the alert in activeAlerts for resolution
		// detection, but don't mark the instance dirty (no Slack notification).
		if am.inhibition != nil && am.inhibition.IsInhibited(*active, am.activeAlerts) {
			am.logger.Debug("alert inhibited",
				slog.String("dedup_key", key),
				slog.String("instance", alert.Instance),
			)
			continue
		}

		// Snooze check: track the alert but skip Slack/PD/webhook notification.
		if am.snooze != nil && am.snooze.IsSnoozed(key) {
			am.logger.Debug("alert snoozed",
				slog.String("dedup_key", key),
				slog.String("instance", alert.Instance),
			)
			continue
		}

		// Mark instance dirty so Slack gets an immediate update.
		am.dirtyInst[alert.Instance] = true
	}

	// Increment clean checks for unseen alerts.
	for key, active := range am.activeAlerts {
		if !seen[key] {
			active.cleanChecks++
		}
	}

	// Drain dirty instances before releasing the lock.
	dirty := am.drainDirtyInstances()
	am.mu.Unlock()

	// Persist new alerts to store (outside lock).
	for i := range alerts {
		alert := alerts[i]
		key := alert.DedupKey
		if key == "" {
			key = fmt.Sprintf("%s:%s:%s", alert.Instance, alert.Category, alert.Title)
		}
		am.mu.Lock()
		active, ok := am.activeAlerts[key]
		isNew := ok && active.Count == 1
		am.mu.Unlock()

		if isNew && am.store != nil {
			storeCtx, storeCancel := context.WithTimeout(context.Background(), 10*time.Second)
			type insertResult struct {
				id  int64
				err error
			}
			ch := make(chan insertResult, 1)
			go func() {
				id, err := am.store.InsertAlert(alert)
				ch <- insertResult{id, err}
			}()
			select {
			case res := <-ch:
				storeCancel()
				if res.err != nil {
					am.logger.Error("failed to persist alert",
						slog.String("dedup_key", key), slog.String("error", res.err.Error()))
				} else {
					am.logger.Debug("alert persisted", slog.Int64("id", res.id), slog.String("dedup_key", key))
				}
			case <-storeCtx.Done():
				storeCancel()
				am.logger.Error("timeout persisting alert", slog.String("dedup_key", key))
			}
		}
	}

	// Touch all seen alerts in the store to keep updated_at fresh.
	if am.store != nil && len(seen) > 0 {
		keys := make([]string, 0, len(seen))
		for k := range seen {
			keys = append(keys, k)
		}
		touchCtx, touchCancel := context.WithTimeout(context.Background(), 10*time.Second)
		touchCh := make(chan error, 1)
		go func() { touchCh <- am.store.TouchAlerts(keys) }()
		select {
		case err := <-touchCh:
			touchCancel()
			if err != nil {
				am.logger.Debug("touch alerts failed", slog.String("err", err.Error()))
			}
		case <-touchCtx.Done():
			touchCancel()
			am.logger.Debug("touch alerts timed out")
		}
	}

	// Flush dirty instance Slack messages.
	for _, inst := range dirty {
		am.updateInstanceMessage(inst)
	}
}

// ---------------------------------------------------------------------------
// Instance Slack message
// ---------------------------------------------------------------------------

// updateInstanceMessage builds a grouped Slack message for all active alerts
// on the given instance, then posts or updates it in-place.
func (am *AlertManager) updateInstanceMessage(instance string) {
	if am.slack == nil {
		return
	}

	// Rate-limit: don't call Slack API more than once per minute per instance.
	am.mu.Lock()
	if last, ok := am.lastInstanceUpdate[instance]; ok && time.Since(last) < time.Minute {
		am.mu.Unlock()
		return
	}
	am.mu.Unlock()

	// Collect a snapshot of active alerts for this instance.
	am.mu.Lock()
	var instanceAlerts []*ActiveAlert
	for _, active := range am.activeAlerts {
		if active.Alert.Instance == instance && active.Alert.Severity != collector.SeverityInfo {
			cp := *active
			instanceAlerts = append(instanceAlerts, &cp)
		}
	}
	ts := am.instanceTS[instance]
	am.mu.Unlock()

	// Sort: critical first, then warn, then alphabetically by title.
	sort.Slice(instanceAlerts, func(i, j int) bool {
		oi := severityOrder(instanceAlerts[i].Alert.Severity)
		oj := severityOrder(instanceAlerts[j].Alert.Severity)
		if oi != oj {
			return oi < oj
		}
		return instanceAlerts[i].Alert.Title < instanceAlerts[j].Alert.Title
	})

	var newTS string
	var err error

	if len(instanceAlerts) == 0 {
		newTS, err = am.slack.PostInstanceAllClear(instance, ts)
		if err != nil {
			am.logger.Error("failed to post all-clear for instance",
				slog.String("instance", instance), slog.String("error", err.Error()))
			return
		}
		am.logger.Info("instance all-clear posted", slog.String("instance", instance))
	} else {
		newTS, err = am.slack.UpdateOrPostInstanceMessage(instance, ts, instanceAlerts)
		if err != nil {
			am.logger.Error("failed to update instance Slack message",
				slog.String("instance", instance), slog.String("error", err.Error()))
			return
		}
		am.logger.Info("instance Slack message updated",
			slog.String("instance", instance),
			slog.Int("active_alerts", len(instanceAlerts)),
			slog.String("slack_ts", newTS),
		)
	}

	am.mu.Lock()
	if newTS != "" {
		am.instanceTS[instance] = newTS
	}
	am.lastInstanceUpdate[instance] = time.Now()
	// Mark all alerts for this instance as notified.
	for _, active := range am.activeAlerts {
		if active.Alert.Instance == instance {
			active.Notified = true
		}
	}

	if len(instanceAlerts) == 0 {
		// All-clear: reset escalation tracking.
		delete(am.instanceFirstFired, instance)
		delete(am.lastEscalated, instance)
	} else {
		// First time we're posting for this instance — record the time.
		if _, ok := am.instanceFirstFired[instance]; !ok {
			am.instanceFirstFired[instance] = time.Now()
		}
	}
	// Take snapshot of top alert for webhook/pagerduty calls (outside lock).
	var topAlert *ActiveAlert
	if len(instanceAlerts) > 0 {
		cp := *instanceAlerts[0]
		topAlert = &cp
	}
	am.mu.Unlock()

	// Webhook notification for the top alert (or all-clear).
	if am.webhook != nil {
		var wp WebhookPayload
		if topAlert != nil {
			wp = WebhookPayload{
				Event:     "alert_firing",
				Instance:  instance,
				Severity:  string(topAlert.Alert.Severity),
				Category:  topAlert.Alert.Category,
				Title:     topAlert.Alert.Title,
				Message:   topAlert.Alert.Message,
				DedupKey:  topAlert.Alert.DedupKey,
				FiredAt:   topAlert.FirstSeen,
				FireCount: topAlert.Count,
			}
		} else {
			wp = WebhookPayload{
				Event:    "all_clear",
				Instance: instance,
			}
		}
		if err := am.webhook.Send(wp); err != nil {
			am.logger.Warn("webhook send failed",
				slog.String("instance", instance), slog.String("error", err.Error()))
		}
	}

	// PagerDuty: trigger for each critical alert.
	if am.pagerduty != nil && len(instanceAlerts) > 0 {
		for _, a := range instanceAlerts {
			if a.Alert.Severity == collector.SeverityCritical {
				dk := a.Alert.DedupKey
				if dk == "" {
					dk = fmt.Sprintf("%s:%s:%s", a.Alert.Instance, a.Alert.Category, a.Alert.Title)
				}
				if err := am.pagerduty.TriggerAlert(a.Alert, dk); err != nil {
					am.logger.Warn("pagerduty trigger failed",
						slog.String("dedup_key", dk), slog.String("error", err.Error()))
				}
			}
		}
	}

	// Notify SlackApp to refresh the pinned dashboard (non-blocking).
	am.mu.Lock()
	cb := am.onStateChange
	am.mu.Unlock()
	if cb != nil {
		am.wg.Add(1)
		go func() {
			defer am.wg.Done()
			cb()
		}()
	}
}

// persistFireCounts writes the current Count and FirstSeen for every active
// alert back to the store. Called from the heartbeat loop so that a subsequent
// restart can restore these values via Rehydrate.
func (am *AlertManager) persistFireCounts() {
	if am.store == nil {
		return
	}
	am.mu.Lock()
	type entry struct {
		key       string
		count     int
		firstSeen time.Time
	}
	entries := make([]entry, 0, len(am.activeAlerts))
	for key, active := range am.activeAlerts {
		entries = append(entries, entry{key: key, count: active.Count, firstSeen: active.FirstSeen})
	}
	am.mu.Unlock()

	for _, e := range entries {
		e := e
		fcCtx, fcCancel := context.WithTimeout(context.Background(), 10*time.Second)
		fcCh := make(chan error, 1)
		go func() { fcCh <- am.store.UpdateFireCount(e.key, e.count, e.firstSeen) }()
		select {
		case err := <-fcCh:
			fcCancel()
			if err != nil {
				am.logger.Debug("failed to persist fire count",
					slog.String("dedup_key", e.key), slog.String("err", err.Error()))
			}
		case <-fcCtx.Done():
			fcCancel()
			am.logger.Debug("timeout persisting fire count", slog.String("dedup_key", e.key))
		}
	}
}

// drainDirtyInstances returns and clears the current dirty set.
// Caller must hold am.mu.
func (am *AlertManager) drainDirtyInstances() []string {
	if len(am.dirtyInst) == 0 {
		return nil
	}
	out := make([]string, 0, len(am.dirtyInst))
	for inst := range am.dirtyInst {
		out = append(out, inst)
	}
	am.dirtyInst = make(map[string]bool)
	return out
}

func severityOrder(s collector.Severity) int {
	switch s {
	case collector.SeverityCritical:
		return 0
	case collector.SeverityWarn:
		return 1
	default:
		return 2
	}
}

// ---------------------------------------------------------------------------
// Background loops
// ---------------------------------------------------------------------------

// heartbeatLoop refreshes active-instance Slack messages every heartbeatInterval
// so the "Updated:" timestamp stays current even without state changes.
func (am *AlertManager) heartbeatLoop(ctx context.Context) {
	defer am.wg.Done()

	ticker := time.NewTicker(am.heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			am.mu.Lock()
			instances := make(map[string]bool)
			for _, active := range am.activeAlerts {
				if active.Alert.Severity != collector.SeverityInfo {
					instances[active.Alert.Instance] = true
				}
			}
			// Clear last-update timestamps so rate-limit doesn't block heartbeat.
			for inst := range instances {
				delete(am.lastInstanceUpdate, inst)
			}
			am.mu.Unlock()

			// Persist fire counts for all active alerts so restarts can restore them.
			am.persistFireCounts()

			for inst := range instances {
				am.updateInstanceMessage(inst)

				// Escalation check: if the instance has been firing for longer than
				// escalation.NoticeAfter without a response, post an escalation notice
				// at most once per escalation.RepeatEvery.
				if am.escalation.Enabled {
					am.mu.Lock()
					first, hasFired := am.instanceFirstFired[inst]
					last, hasEscalated := am.lastEscalated[inst]
					am.mu.Unlock()

					if hasFired && time.Since(first) > am.escalation.NoticeAfter {
						if !hasEscalated || time.Since(last) > am.escalation.RepeatEvery {
							firingMinutes := int(time.Since(first).Minutes())
							if am.slack != nil {
								_ = am.slack.PostEscalationNotice(inst, firingMinutes)
							}
							am.mu.Lock()
							am.lastEscalated[inst] = time.Now()
							am.mu.Unlock()
						}
					}
				}
			}
		}
	}
}

// resolutionLoop checks for alerts that have been absent for the required
// number of consecutive clean polls and resolves them.
func (am *AlertManager) resolutionLoop(ctx context.Context) {
	defer am.wg.Done()

	ticker := time.NewTicker(am.heartbeatInterval / 2)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			am.checkResolutions()
		}
	}
}

func (am *AlertManager) checkResolutions() {
	now := time.Now()

	am.mu.Lock()
	var resolved []*ActiveAlert
	var resolvedKeys []string

	for key, active := range am.activeAlerts {
		if active.cleanChecks >= am.resolveCleanChecks {
			resolved = append(resolved, active)
			resolvedKeys = append(resolvedKeys, key)
		}
	}

	for _, key := range resolvedKeys {
		delete(am.activeAlerts, key)
	}

	// Collect which instances had resolutions and clear their rate-limit so
	// the all-clear / updated message can go out immediately.
	resolvedInstances := make(map[string]bool)
	for _, active := range resolved {
		resolvedInstances[active.Alert.Instance] = true
	}
	for inst := range resolvedInstances {
		delete(am.lastInstanceUpdate, inst)
	}
	am.mu.Unlock()

	// Persist resolutions outside the lock.
	for i, active := range resolved {
		key := resolvedKeys[i]
		duration := now.Sub(active.FirstSeen)

		if am.store != nil {
			resolveCtx, resolveCancel := context.WithTimeout(context.Background(), 10*time.Second)
			resolveCh := make(chan error, 1)
			go func() { resolveCh <- am.store.ResolveAlert(key) }()
			select {
			case err := <-resolveCh:
				resolveCancel()
				if err != nil {
					am.logger.Error("failed to persist alert resolution",
						slog.String("dedup_key", key), slog.String("error", err.Error()))
				}
			case <-resolveCtx.Done():
				resolveCancel()
				am.logger.Error("timeout resolving alert", slog.String("dedup_key", key))
			}
		}

		// Clear any acknowledgment for this alert so the next firing starts fresh.
		if am.ack != nil {
			am.ack.ClearForDedupKey(key)
		}

		// PagerDuty: resolve the incident.
		if am.pagerduty != nil {
			if err := am.pagerduty.ResolveAlert(key); err != nil {
				am.logger.Warn("pagerduty resolve failed",
					slog.String("dedup_key", key), slog.String("error", err.Error()))
			}
		}

		// Webhook: notify resolution.
		if am.webhook != nil {
			wp := WebhookPayload{
				Event:     "alert_resolved",
				Instance:  active.Alert.Instance,
				Severity:  string(active.Alert.Severity),
				Category:  active.Alert.Category,
				Title:     active.Alert.Title,
				Message:   active.Alert.Message,
				DedupKey:  key,
				FiredAt:   active.FirstSeen,
				FireCount: active.Count,
			}
			if err := am.webhook.Send(wp); err != nil {
				am.logger.Warn("webhook send (resolve) failed",
					slog.String("dedup_key", key), slog.String("error", err.Error()))
			}
		}

		am.logger.Info("alert resolved",
			slog.String("dedup_key", key),
			slog.Duration("duration", duration),
		)
	}

	// Update Slack for each affected instance (shows updated list or all-clear).
	for inst := range resolvedInstances {
		am.updateInstanceMessage(inst)
	}
}

// ---------------------------------------------------------------------------
// Info digest
// ---------------------------------------------------------------------------

func (am *AlertManager) enqueueInfo(alert collector.Alert) {
	am.infoMu.Lock()
	am.infoBatch = append(am.infoBatch, alert)
	am.infoMu.Unlock()
}

// DrainInfoAlerts returns and clears all accumulated info-level alerts.
func (am *AlertManager) DrainInfoAlerts() []collector.Alert {
	am.infoMu.Lock()
	alerts := am.infoBatch
	am.infoBatch = nil
	am.infoMu.Unlock()
	return alerts
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

// ActiveAlertCount returns the number of currently-firing alerts.
func (am *AlertManager) ActiveAlertCount() int {
	am.mu.Lock()
	defer am.mu.Unlock()
	return len(am.activeAlerts)
}

// ActiveAlertCountsForInstance returns a map of severity → count for all
// currently-firing alerts on the given instance. Always returns keys for
// "critical", "warn", and "info" (with zero values when none are firing)
// so Prometheus gauges reset to 0 when alerts clear.
func (am *AlertManager) ActiveAlertCountsForInstance(instance string) map[string]int {
	am.mu.Lock()
	defer am.mu.Unlock()
	counts := map[string]int{"critical": 0, "warn": 0, "info": 0}
	for _, active := range am.activeAlerts {
		if active.Alert.Instance == instance {
			sev := string(active.Alert.Severity)
			counts[sev]++
		}
	}
	return counts
}

// ActiveAlertKeys returns the dedup keys of all currently-firing alerts.
func (am *AlertManager) ActiveAlertKeys() []string {
	am.mu.Lock()
	defer am.mu.Unlock()
	keys := make([]string, 0, len(am.activeAlerts))
	for k := range am.activeAlerts {
		keys = append(keys, k)
	}
	return keys
}

// GetActiveAlert returns a copy of the ActiveAlert for the given dedupKey, or
// nil if no such alert is currently firing.
func (am *AlertManager) GetActiveAlert(dedupKey string) *ActiveAlert {
	am.mu.Lock()
	defer am.mu.Unlock()
	a, ok := am.activeAlerts[dedupKey]
	if !ok {
		return nil
	}
	cp := *a
	return &cp
}

// SetOnStateChange registers a callback invoked after each Slack update.
// Used by SlackApp to refresh the pinned dashboard. Safe to call at any time.
func (am *AlertManager) SetOnStateChange(fn func()) {
	am.mu.Lock()
	am.onStateChange = fn
	am.mu.Unlock()
}

// GetActiveAlertsForInstance returns copies of all currently-firing non-info
// alerts for the given instance, sorted critical-first.
func (am *AlertManager) GetActiveAlertsForInstance(instance string) []*ActiveAlert {
	am.mu.Lock()
	defer am.mu.Unlock()
	var result []*ActiveAlert
	for _, active := range am.activeAlerts {
		if active.Alert.Instance == instance && active.Alert.Severity != collector.SeverityInfo {
			cp := *active
			result = append(result, &cp)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		oi := severityOrder(result[i].Alert.Severity)
		oj := severityOrder(result[j].Alert.Severity)
		if oi != oj {
			return oi < oj
		}
		return result[i].Alert.Title < result[j].Alert.Title
	})
	return result
}
