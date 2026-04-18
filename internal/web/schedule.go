package web

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"
)

// Schedule defines a recurring run of a single collector against a single instance.
type Schedule struct {
	ID            string    `json:"id"`
	Instance      string    `json:"instance"`
	CollectorName string    `json:"collector_name"`
	IntervalMins  int       `json:"interval_mins"`
	Enabled       bool      `json:"enabled"`
	LastRunAt     time.Time `json:"last_run_at,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

// ScheduleStore holds schedules in memory and persists them to a JSON file.
type ScheduleStore struct {
	mu      sync.RWMutex
	entries []*Schedule
	path    string
}

// NewScheduleStore creates a ScheduleStore backed by the given JSON file path.
func NewScheduleStore(path string) *ScheduleStore {
	ss := &ScheduleStore{path: path}
	ss.load()
	return ss
}

// List returns a copy of all schedules.
func (ss *ScheduleStore) List() []*Schedule {
	ss.mu.RLock()
	defer ss.mu.RUnlock()

	out := make([]*Schedule, len(ss.entries))
	for i, e := range ss.entries {
		cp := *e
		out[i] = &cp
	}
	return out
}

// Add creates a new schedule and persists it.
func (ss *ScheduleStore) Add(instance, collectorName string, intervalMins int) *Schedule {
	now := time.Now()
	s := &Schedule{
		ID:            fmt.Sprintf("%d", now.UnixNano()),
		Instance:      instance,
		CollectorName: collectorName,
		IntervalMins:  intervalMins,
		Enabled:       true,
		CreatedAt:     now,
	}
	ss.mu.Lock()
	ss.entries = append(ss.entries, s)
	ss.mu.Unlock()
	ss.save()
	return s
}

// Delete removes a schedule by ID. Returns true if it existed.
func (ss *ScheduleStore) Delete(id string) bool {
	ss.mu.Lock()
	found := false
	for i, e := range ss.entries {
		if e.ID == id {
			ss.entries = append(ss.entries[:i], ss.entries[i+1:]...)
			found = true
			break
		}
	}
	ss.mu.Unlock()
	if found {
		ss.save()
	}
	return found
}

// SetEnabled enables or disables a schedule. Returns true if found.
func (ss *ScheduleStore) SetEnabled(id string, enabled bool) bool {
	ss.mu.Lock()
	found := false
	for _, e := range ss.entries {
		if e.ID == id {
			e.Enabled = enabled
			found = true
			break
		}
	}
	ss.mu.Unlock()
	if found {
		ss.save()
	}
	return found
}

// UpdateLastRun sets LastRunAt to now for the given schedule ID.
func (ss *ScheduleStore) UpdateLastRun(id string) {
	ss.mu.Lock()
	found := false
	for _, e := range ss.entries {
		if e.ID == id {
			e.LastRunAt = time.Now()
			found = true
			break
		}
	}
	ss.mu.Unlock()
	if found {
		ss.save()
	}
}

// Due returns all enabled schedules whose next run time has arrived.
func (ss *ScheduleStore) Due() []*Schedule {
	now := time.Now()
	ss.mu.RLock()
	defer ss.mu.RUnlock()

	var out []*Schedule
	for _, e := range ss.entries {
		if !e.Enabled {
			continue
		}
		interval := time.Duration(e.IntervalMins) * time.Minute
		var nextRun time.Time
		if e.LastRunAt.IsZero() {
			nextRun = e.CreatedAt.Add(interval)
		} else {
			nextRun = e.LastRunAt.Add(interval)
		}
		if !now.Before(nextRun) {
			cp := *e
			out = append(out, &cp)
		}
	}
	return out
}

// ── persistence ───────────────────────────────────────────────────────────────

func (ss *ScheduleStore) load() {
	if ss.path == "" {
		return
	}

	data, err := os.ReadFile(ss.path)
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		slog.Warn("schedule: failed to read persist file", "path", ss.path, "error", err)
		return
	}

	var entries []*Schedule
	if err := json.Unmarshal(data, &entries); err != nil {
		slog.Warn("schedule: failed to parse persist file", "path", ss.path, "error", err)
		return
	}

	ss.mu.Lock()
	ss.entries = entries
	ss.mu.Unlock()

	slog.Info("schedule: loaded entries from file", "path", ss.path, "count", len(entries))
}

func (ss *ScheduleStore) save() {
	if ss.path == "" {
		return
	}

	ss.mu.RLock()
	entries := make([]*Schedule, len(ss.entries))
	for i, e := range ss.entries {
		cp := *e
		entries[i] = &cp
	}
	ss.mu.RUnlock()

	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		slog.Warn("schedule: failed to marshal entries", "error", err)
		return
	}
	if err := atomicWriteFile(ss.path, data, 0644); err != nil {
		slog.Warn("schedule: failed to write persist file", "path", ss.path, "error", err)
	}
}

// atomicWriteFile writes data to path atomically via a temp file + rename,
// preventing partial writes from corrupting the persist file on crash.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

// handleScheduleList handles GET /api/schedules.
func (s *Server) handleScheduleList(w http.ResponseWriter, r *http.Request) {
	if s.scheduleStore == nil {
		writeJSON(w, http.StatusOK, []*Schedule{})
		return
	}
	entries := s.scheduleStore.List()
	if entries == nil {
		entries = []*Schedule{}
	}
	writeJSON(w, http.StatusOK, entries)
}

// scheduleCreateRequest is the POST body for creating a schedule.
type scheduleCreateRequest struct {
	Instance      string `json:"instance"`
	CollectorName string `json:"collector_name"`
	IntervalMins  int    `json:"interval_mins"`
}

// handleScheduleCreate handles POST /api/schedules.
func (s *Server) handleScheduleCreate(w http.ResponseWriter, r *http.Request) {
	limitBody(w, r)
	if s.scheduleStore == nil {
		writeErr(w, http.StatusServiceUnavailable, "schedule store not available")
		return
	}

	var req scheduleCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Instance == "" {
		writeErr(w, http.StatusBadRequest, "instance is required")
		return
	}
	if req.CollectorName == "" {
		writeErr(w, http.StatusBadRequest, "collector_name is required")
		return
	}
	if req.IntervalMins <= 0 {
		writeErr(w, http.StatusBadRequest, "interval_mins must be positive")
		return
	}

	entry := s.scheduleStore.Add(req.Instance, req.CollectorName, req.IntervalMins)
	details := fmt.Sprintf(`{"id":%q,"collector":%q,"interval_mins":%d}`, entry.ID, req.CollectorName, req.IntervalMins)
	_ = s.store.LogAction(r.Context(), req.Instance, "schedule_create", r.RemoteAddr, details)
	writeJSON(w, http.StatusCreated, entry)
}

// handleScheduleDelete handles DELETE /api/schedules/{id}.
func (s *Server) handleScheduleDelete(w http.ResponseWriter, r *http.Request) {
	if s.scheduleStore == nil {
		writeErr(w, http.StatusServiceUnavailable, "schedule store not available")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id is required")
		return
	}

	if !s.scheduleStore.Delete(id) {
		writeErr(w, http.StatusNotFound, "schedule not found")
		return
	}

	_ = s.store.LogAction(r.Context(), "", "schedule_delete", r.RemoteAddr, fmt.Sprintf(`{"id":%q}`, id))
	w.WriteHeader(http.StatusNoContent)
}

// scheduleSetEnabledRequest is the body for the enabled toggle endpoint.
type scheduleSetEnabledRequest struct {
	Enabled bool `json:"enabled"`
}

// handleScheduleSetEnabled handles PUT /api/schedules/{id}/enabled.
func (s *Server) handleScheduleSetEnabled(w http.ResponseWriter, r *http.Request) {
	limitBody(w, r)
	if s.scheduleStore == nil {
		writeErr(w, http.StatusServiceUnavailable, "schedule store not available")
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id is required")
		return
	}

	var req scheduleSetEnabledRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if !s.scheduleStore.SetEnabled(id, req.Enabled) {
		writeErr(w, http.StatusNotFound, "schedule not found")
		return
	}

	action := "schedule_disable"
	if req.Enabled {
		action = "schedule_enable"
	}
	_ = s.store.LogAction(r.Context(), "", action, r.RemoteAddr, fmt.Sprintf(`{"id":%q,"enabled":%v}`, id, req.Enabled))
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": req.Enabled})
}
