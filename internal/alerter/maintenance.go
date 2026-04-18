package alerter

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"
)

// MaintenanceWindow defines a period during which all alerts for an instance
// are suppressed.
type MaintenanceWindow struct {
	ID        string `json:"id"`
	Instance  string `json:"instance"`    // "*" = all instances
	Reason    string `json:"reason"`
	StartTime int64  `json:"start_time"`  // unix epoch seconds
	EndTime   int64  `json:"end_time"`    // unix epoch seconds
	CreatedBy string `json:"created_by"`
}

// MaintenanceStore holds active maintenance windows in memory and optionally
// persists them to a JSON file so they survive process restarts.
type MaintenanceStore struct {
	mu       sync.RWMutex
	windows  map[string]*MaintenanceWindow // id -> window
	filePath string                        // empty = no persistence
}

// NewMaintenanceStore creates an empty MaintenanceStore.
func NewMaintenanceStore() *MaintenanceStore {
	return &MaintenanceStore{
		windows: make(map[string]*MaintenanceWindow),
	}
}

// SetPersistPath enables file-based persistence. Existing windows are loaded
// from the file immediately (ignoring already-expired ones).
// Call once at startup before any other operations.
func (ms *MaintenanceStore) SetPersistPath(path string) {
	ms.mu.Lock()
	ms.filePath = path
	ms.mu.Unlock()
	ms.loadFromFile()
}

// Add creates a new maintenance window starting now and lasting duration.
// Returns the newly created window.
func (ms *MaintenanceStore) Add(instance, reason, createdBy string, duration time.Duration) *MaintenanceWindow {
	now := time.Now().UTC()
	id := fmt.Sprintf("%d", now.UnixNano())
	w := &MaintenanceWindow{
		ID:        id,
		Instance:  instance,
		Reason:    reason,
		StartTime: now.Unix(),
		EndTime:   now.Add(duration).Unix(),
		CreatedBy: createdBy,
	}
	ms.mu.Lock()
	ms.windows[id] = w
	ms.mu.Unlock()
	ms.saveToFile()
	return w
}

// Update modifies an existing maintenance window by ID.
// Only non-zero/non-empty fields are applied.
// Returns false if no window with the given ID exists.
func (ms *MaintenanceStore) Update(id string, instance, reason string, endsAt time.Time) bool {
	ms.mu.Lock()
	w, ok := ms.windows[id]
	if !ok {
		ms.mu.Unlock()
		return false
	}
	if instance != "" {
		w.Instance = instance
	}
	if reason != "" {
		w.Reason = reason
	}
	if !endsAt.IsZero() {
		w.EndTime = endsAt.UTC().Unix()
	}
	ms.mu.Unlock()
	ms.saveToFile()
	return true
}

// Delete removes a maintenance window by ID. Returns true if the window existed.
func (ms *MaintenanceStore) Delete(id string) bool {
	ms.mu.Lock()
	_, ok := ms.windows[id]
	if ok {
		delete(ms.windows, id)
	}
	ms.mu.Unlock()
	if ok {
		ms.saveToFile()
	}
	return ok
}

// List returns all active (not yet expired) windows.
func (ms *MaintenanceStore) List() []*MaintenanceWindow {
	now := time.Now().UTC()
	ms.mu.RLock()
	defer ms.mu.RUnlock()

	var out []*MaintenanceWindow
	for _, w := range ms.windows {
		if w.EndTime > now.Unix() {
			cp := *w
			out = append(out, &cp)
		}
	}
	return out
}

// GetActiveWindow returns the first active window for the instance (or wildcard "*").
// Returns nil if the instance is not in maintenance.
func (ms *MaintenanceStore) GetActiveWindow(instance string) *MaintenanceWindow {
	now := time.Now().UTC()
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	for _, w := range ms.windows {
		if w.EndTime > now.Unix() && (w.Instance == "*" || w.Instance == instance) {
			cp := *w
			return &cp
		}
	}
	return nil
}

// IsInMaintenance returns true if the instance is currently in maintenance.
// Automatically removes expired windows during the check.
func (ms *MaintenanceStore) IsInMaintenance(instance string) bool {
	now := time.Now().UTC()
	ms.mu.Lock()
	defer ms.mu.Unlock()

	var expired []string
	for id, w := range ms.windows {
		if w.EndTime <= now.Unix() {
			expired = append(expired, id)
		}
	}
	for _, id := range expired {
		delete(ms.windows, id)
	}

	for _, w := range ms.windows {
		if w.EndTime > now.Unix() && (w.Instance == "*" || w.Instance == instance) {
			return true
		}
	}
	return false
}

// ── File persistence ──────────────────────────────────────────────────────────

func (ms *MaintenanceStore) saveToFile() {
	ms.mu.RLock()
	path := ms.filePath
	windows := make([]*MaintenanceWindow, 0, len(ms.windows))
	for _, w := range ms.windows {
		cp := *w
		windows = append(windows, &cp)
	}
	ms.mu.RUnlock()

	if path == "" {
		return
	}

	data, err := json.MarshalIndent(windows, "", "  ")
	if err != nil {
		slog.Warn("maintenance: failed to marshal windows", "error", err)
		return
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		slog.Warn("maintenance: failed to write persist file", "path", path, "error", err)
	}
}

func (ms *MaintenanceStore) loadFromFile() {
	ms.mu.RLock()
	path := ms.filePath
	ms.mu.RUnlock()

	if path == "" {
		return
	}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return // first run, no file yet
	}
	if err != nil {
		slog.Warn("maintenance: failed to read persist file", "path", path, "error", err)
		return
	}

	var windows []*MaintenanceWindow
	if err := json.Unmarshal(data, &windows); err != nil {
		slog.Warn("maintenance: failed to parse persist file", "path", path, "error", err)
		return
	}

	nowSec := time.Now().UTC().Unix()
	loaded := 0
	ms.mu.Lock()
	for _, w := range windows {
		if w.EndTime > nowSec { // skip already-expired windows
			ms.windows[w.ID] = w
			loaded++
		}
	}
	ms.mu.Unlock()

	if loaded > 0 {
		slog.Info("maintenance: reloaded windows from file", "path", path, "count", loaded)
	}
}
