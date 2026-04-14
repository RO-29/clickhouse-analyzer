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

// NewAlertManager creates a ready-to-use AlertManager. Call Start to begin
// background goroutines and Stop to shut them down.
func NewAlertManager(slackNotifier *SlackNotifier, store StoreInterface, opts ...Option) *AlertManager {
	am := &AlertManager{
		slack:              slackNotifier,
		store:              store,
		dedupWindow:        15 * time.Minute,
		heartbeatInterval:  5 * time.Minute,
		resolveCleanChecks: 4,
		activeAlerts:       make(map[string]*ActiveAlert),
		instanceTS:         make(map[string]string),
		dirtyInst:          make(map[string]bool),
		lastInstanceUpdate: make(map[string]time.Time),
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
			am.activeAlerts[key] = &ActiveAlert{
				Alert:     a,
				FirstSeen: now,
				LastSeen:  now,
				Count:     1,
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
			if id, err := am.store.InsertAlert(alert); err != nil {
				am.logger.Error("failed to persist alert",
					slog.String("dedup_key", key), slog.String("error", err.Error()))
			} else {
				am.logger.Debug("alert persisted", slog.Int64("id", id), slog.String("dedup_key", key))
			}
		}
	}

	// Touch all seen alerts in the store to keep updated_at fresh.
	if am.store != nil && len(seen) > 0 {
		keys := make([]string, 0, len(seen))
		for k := range seen {
			keys = append(keys, k)
		}
		if err := am.store.TouchAlerts(keys); err != nil {
			am.logger.Debug("touch alerts failed", slog.String("err", err.Error()))
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
	am.mu.Unlock()
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

			for inst := range instances {
				am.updateInstanceMessage(inst)
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
			if err := am.store.ResolveAlert(key); err != nil {
				am.logger.Error("failed to persist alert resolution",
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
