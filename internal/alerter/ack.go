package alerter

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"
)

// AckEntry records a single alert acknowledgment.
// An ACK keeps the alert firing but suppresses notifications and
// surfaces an "acked" indicator in the UI.
type AckEntry struct {
	ID       string    `json:"id"`
	DedupKey string    `json:"dedup_key"`
	Instance string    `json:"instance"`
	Reason   string    `json:"reason"`
	AckedBy  string    `json:"acked_by"`
	AckedAt  time.Time `json:"acked_at"`
}

// AckStore holds acknowledged alerts in memory and optionally persists
// them to a JSON file so acknowledgments survive process restarts.
type AckStore struct {
	mu          sync.RWMutex
	entries     map[string]*AckEntry // id -> entry
	byDedupKey  map[string]*AckEntry // dedupKey -> entry (latest ack wins)
	persistPath string
}

// NewAckStore creates an AckStore that persists to persistPath.
// Existing entries are loaded immediately from the file if it exists.
func NewAckStore(persistPath string) *AckStore {
	as := &AckStore{
		entries:     make(map[string]*AckEntry),
		byDedupKey:  make(map[string]*AckEntry),
		persistPath: persistPath,
	}
	as.load()
	return as
}

// Add creates a new acknowledgment entry and persists it.
func (as *AckStore) Add(dedupKey, instance, reason, ackedBy string) *AckEntry {
	now := time.Now()
	id := fmt.Sprintf("%d", now.UnixNano())
	e := &AckEntry{
		ID:       id,
		DedupKey: dedupKey,
		Instance: instance,
		Reason:   reason,
		AckedBy:  ackedBy,
		AckedAt:  now,
	}
	as.mu.Lock()
	as.entries[id] = e
	as.byDedupKey[dedupKey] = e
	as.mu.Unlock()
	as.save()
	return e
}

// IsAcked reports whether the alert identified by dedupKey has been acknowledged.
// This is the hot path — uses RLock for minimal contention.
func (as *AckStore) IsAcked(dedupKey string) bool {
	as.mu.RLock()
	_, ok := as.byDedupKey[dedupKey]
	as.mu.RUnlock()
	return ok
}

// GetAck returns the AckEntry for the given dedupKey, or nil if not acked.
func (as *AckStore) GetAck(dedupKey string) *AckEntry {
	as.mu.RLock()
	e := as.byDedupKey[dedupKey]
	as.mu.RUnlock()
	if e == nil {
		return nil
	}
	cp := *e
	return &cp
}

// List returns a snapshot of all current acknowledgments.
func (as *AckStore) List() []*AckEntry {
	as.mu.RLock()
	defer as.mu.RUnlock()
	out := make([]*AckEntry, 0, len(as.entries))
	for _, e := range as.entries {
		cp := *e
		out = append(out, &cp)
	}
	return out
}

// Delete removes an acknowledgment by its ID. Returns true if the entry existed.
func (as *AckStore) Delete(id string) bool {
	as.mu.Lock()
	e, ok := as.entries[id]
	if ok {
		delete(as.entries, id)
		// Only remove from byDedupKey if this was the latest ack for that key.
		if cur := as.byDedupKey[e.DedupKey]; cur != nil && cur.ID == id {
			delete(as.byDedupKey, e.DedupKey)
		}
	}
	as.mu.Unlock()
	if ok {
		as.save()
	}
	return ok
}

// ClearForDedupKey removes all acknowledgments for the given dedupKey.
// Called when an alert resolves so the next firing starts fresh.
func (as *AckStore) ClearForDedupKey(dedupKey string) {
	as.mu.Lock()
	// Collect IDs to delete.
	var toDelete []string
	for id, e := range as.entries {
		if e.DedupKey == dedupKey {
			toDelete = append(toDelete, id)
		}
	}
	for _, id := range toDelete {
		delete(as.entries, id)
	}
	delete(as.byDedupKey, dedupKey)
	as.mu.Unlock()
	if len(toDelete) > 0 {
		as.save()
	}
}

// ── File persistence ──────────────────────────────────────────────────────────

func (as *AckStore) save() {
	as.mu.RLock()
	path := as.persistPath
	entries := make([]*AckEntry, 0, len(as.entries))
	for _, e := range as.entries {
		cp := *e
		entries = append(entries, &cp)
	}
	as.mu.RUnlock()

	if path == "" {
		return
	}

	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		slog.Warn("ackstore: failed to marshal entries", "error", err)
		return
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		slog.Warn("ackstore: failed to write persist file", "path", path, "error", err)
	}
}

func (as *AckStore) load() {
	path := as.persistPath
	if path == "" {
		return
	}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return // first run, no file yet
	}
	if err != nil {
		slog.Warn("ackstore: failed to read persist file", "path", path, "error", err)
		return
	}

	var entries []*AckEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		slog.Warn("ackstore: failed to parse persist file", "path", path, "error", err)
		return
	}

	as.mu.Lock()
	for _, e := range entries {
		as.entries[e.ID] = e
		// Last write wins for byDedupKey; entries are stored newest-first by
		// convention from save(), but we always overwrite so the latest entry
		// for each dedupKey is what remains.
		as.byDedupKey[e.DedupKey] = e
	}
	as.mu.Unlock()

	if len(entries) > 0 {
		slog.Info("ackstore: loaded entries from file", "path", path, "count", len(entries))
	}
}
