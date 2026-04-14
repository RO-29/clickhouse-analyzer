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
	ID        string    `json:"id"`
	Instance  string    `json:"instance"`   // "*" = all instances
	Reason    string    `json:"reason"`
	StartedAt time.Time `json:"started_at"`
	EndsAt    time.Time `json:"ends_at"`
	CreatedBy string    `json:"created_by"`
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
	now := time.Now()
	id := fmt.Sprintf("%d", now.UnixNano())
	w := &MaintenanceWindow{
		ID:        id,
		Instance:  instance,
		Reason:    reason,
		StartedAt: now,
		EndsAt:    now.Add(duration),
		CreatedBy: createdBy,
	}
	ms.mu.Lock()
	ms.windows[id] = w
	ms.mu.Unlock()
	ms.saveToFile()
	return w
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
	now := time.Now()
	ms.mu.RLock()
	defer ms.mu.RUnlock()

	var out []*MaintenanceWindow
	for _, w := range ms.windows {
		if w.EndsAt.After(now) {
			cp := *w
			out = append(out, &cp)
		}
	}
	return out
}

// GetActiveWindow returns the first active window for the instance (or wildcard "*").
// Returns nil if the instance is not in maintenance.
func (ms *MaintenanceStore) GetActiveWindow(instance string) *MaintenanceWindow {
	now := time.Now()
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	for _, w := range ms.windows {
		if w.EndsAt.After(now) && (w.Instance == "*" || w.Instance == instance) {
			cp := *w
			return &cp
		}
	}
	return nil
}

// IsInMaintenance returns true if the instance is currently in maintenance.
// Automatically removes expired windows during the check.
func (ms *MaintenanceStore) IsInMaintenance(instance string) bool {
	now := time.Now()
	ms.mu.Lock()
	defer ms.mu.Unlock()

	var expired []string
	for id, w := range ms.windows {
		if !w.EndsAt.After(now) {
			expired = append(expired, id)
		}
	}
	for _, id := range expired {
		delete(ms.windows, id)
	}

	for _, w := range ms.windows {
		if w.EndsAt.After(now) && (w.Instance == "*" || w.Instance == instance) {
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

	now := time.Now()
	loaded := 0
	ms.mu.Lock()
	for _, w := range windows {
		if w.EndsAt.After(now) { // skip already-expired windows
			ms.windows[w.ID] = w
			loaded++
		}
	}
	ms.mu.Unlock()

	if loaded > 0 {
		slog.Info("maintenance: reloaded windows from file", "path", path, "count", loaded)
	}
}
