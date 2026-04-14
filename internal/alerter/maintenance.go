package alerter

import (
	"fmt"
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

// MaintenanceStore holds active maintenance windows in memory.
type MaintenanceStore struct {
	mu      sync.RWMutex
	windows map[string]*MaintenanceWindow // id -> window
}

// NewMaintenanceStore creates an empty MaintenanceStore.
func NewMaintenanceStore() *MaintenanceStore {
	return &MaintenanceStore{
		windows: make(map[string]*MaintenanceWindow),
	}
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
	return w
}

// Delete removes a maintenance window by ID. Returns true if the window existed.
func (ms *MaintenanceStore) Delete(id string) bool {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	_, ok := ms.windows[id]
	if ok {
		delete(ms.windows, id)
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

// IsInMaintenance returns true if the instance is currently in maintenance.
// Automatically removes expired windows during the check.
func (ms *MaintenanceStore) IsInMaintenance(instance string) bool {
	now := time.Now()
	ms.mu.Lock()
	defer ms.mu.Unlock()

	// Collect expired IDs and remove them.
	var expired []string
	for id, w := range ms.windows {
		if !w.EndsAt.After(now) {
			expired = append(expired, id)
		}
	}
	for _, id := range expired {
		delete(ms.windows, id)
	}

	// Check if the instance (or wildcard) is still in maintenance.
	for _, w := range ms.windows {
		if w.EndsAt.After(now) && (w.Instance == "*" || w.Instance == instance) {
			return true
		}
	}
	return false
}
