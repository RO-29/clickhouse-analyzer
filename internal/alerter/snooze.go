package alerter

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"
)

// SnoozeEntry represents a snoozed alert rule.
type SnoozeEntry struct {
	ID        string    `json:"id"`
	DedupKey  string    `json:"dedup_key"`  // e.g. "prod:queries:HighQueryDuration"
	Instance  string    `json:"instance"`
	Reason    string    `json:"reason"`
	SnoozedBy string    `json:"snoozed_by"`
	SnoozedAt time.Time `json:"snoozed_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// SnoozeStore holds active snoozes in memory and optionally persists them to a
// JSON file so they survive process restarts.
type SnoozeStore struct {
	mu       sync.RWMutex
	snoozes  map[string]*SnoozeEntry // id -> entry
	filePath string                  // empty = no persistence
}

// NewSnoozeStore creates an empty SnoozeStore. persistPath is the file path
// used to save/restore snoozes across restarts (pass "" to disable persistence).
func NewSnoozeStore(persistPath string) *SnoozeStore {
	ss := &SnoozeStore{
		snoozes:  make(map[string]*SnoozeEntry),
		filePath: persistPath,
	}
	if persistPath != "" {
		ss.loadFromFile()
	}
	return ss
}

// Add creates a new snooze for the given dedupKey starting now and lasting dur.
// Returns the newly created entry.
func (ss *SnoozeStore) Add(dedupKey, instance, reason, snoozedBy string, dur time.Duration) *SnoozeEntry {
	now := time.Now()
	id := fmt.Sprintf("%d", now.UnixNano())
	e := &SnoozeEntry{
		ID:        id,
		DedupKey:  dedupKey,
		Instance:  instance,
		Reason:    reason,
		SnoozedBy: snoozedBy,
		SnoozedAt: now,
		ExpiresAt: now.Add(dur),
	}
	ss.mu.Lock()
	ss.snoozes[id] = e
	ss.mu.Unlock()
	ss.saveToFile()
	return e
}

// IsSnoozed returns true if there is an active (non-expired) snooze for the
// given dedupKey. Expired entries are pruned as a side effect.
func (ss *SnoozeStore) IsSnoozed(dedupKey string) bool {
	now := time.Now()
	ss.mu.Lock()
	defer ss.mu.Unlock()

	// Prune expired entries while we hold the lock.
	var expired []string
	for id, e := range ss.snoozes {
		if !e.ExpiresAt.After(now) {
			expired = append(expired, id)
		}
	}
	for _, id := range expired {
		delete(ss.snoozes, id)
	}

	for _, e := range ss.snoozes {
		if e.DedupKey == dedupKey && e.ExpiresAt.After(now) {
			return true
		}
	}
	return false
}

// List returns all active (not yet expired) snooze entries.
func (ss *SnoozeStore) List() []*SnoozeEntry {
	now := time.Now()
	ss.mu.RLock()
	defer ss.mu.RUnlock()

	var out []*SnoozeEntry
	for _, e := range ss.snoozes {
		if e.ExpiresAt.After(now) {
			cp := *e
			out = append(out, &cp)
		}
	}
	return out
}

// Delete removes a snooze by ID. Returns true if the entry existed.
func (ss *SnoozeStore) Delete(id string) bool {
	ss.mu.Lock()
	_, ok := ss.snoozes[id]
	if ok {
		delete(ss.snoozes, id)
	}
	ss.mu.Unlock()
	if ok {
		ss.Prune()
		ss.saveToFile()
	}
	return ok
}

// Prune removes all expired snooze entries from the store.
func (ss *SnoozeStore) Prune() {
	now := time.Now()
	ss.mu.Lock()
	defer ss.mu.Unlock()

	for id, e := range ss.snoozes {
		if !e.ExpiresAt.After(now) {
			delete(ss.snoozes, id)
		}
	}
}

// ── File persistence ──────────────────────────────────────────────────────────

func (ss *SnoozeStore) saveToFile() {
	ss.mu.RLock()
	path := ss.filePath
	entries := make([]*SnoozeEntry, 0, len(ss.snoozes))
	for _, e := range ss.snoozes {
		cp := *e
		entries = append(entries, &cp)
	}
	ss.mu.RUnlock()

	if path == "" {
		return
	}

	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		slog.Warn("snooze: failed to marshal entries", "error", err)
		return
	}
	if err := atomicWriteFile(path, data, 0644); err != nil {
		slog.Warn("snooze: failed to write persist file", "path", path, "error", err)
	}
}

// atomicWriteFile writes data to path atomically using a temp file + rename.
// This prevents partial writes from corrupting the persist file on crash.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (ss *SnoozeStore) loadFromFile() {
	ss.mu.RLock()
	path := ss.filePath
	ss.mu.RUnlock()

	if path == "" {
		return
	}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return // first run, no file yet
	}
	if err != nil {
		slog.Warn("snooze: failed to read persist file", "path", path, "error", err)
		return
	}

	var entries []*SnoozeEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		slog.Warn("snooze: failed to parse persist file", "path", path, "error", err)
		return
	}

	now := time.Now()
	loaded := 0
	ss.mu.Lock()
	for _, e := range entries {
		if e.ExpiresAt.After(now) { // skip already-expired snoozes
			ss.snoozes[e.ID] = e
			loaded++
		}
	}
	ss.mu.Unlock()

	if loaded > 0 {
		slog.Info("snooze: reloaded entries from file", "path", path, "count", loaded)
	}
}
