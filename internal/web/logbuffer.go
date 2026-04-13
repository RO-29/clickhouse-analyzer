package web

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"
)

// LogEntry is a single captured log line.
type LogEntry struct {
	Time    time.Time `json:"time"`
	Level   string    `json:"level"`
	Message string    `json:"msg"`
	Attrs   map[string]interface{} `json:"attrs,omitempty"`
}

// LogBuffer captures slog output in a ring buffer for the dashboard.
type LogBuffer struct {
	mu      sync.RWMutex
	entries []LogEntry
	size    int
	pos     int
	count   int
}

// NewLogBuffer creates a buffer that holds the last `size` log entries.
func NewLogBuffer(size int) *LogBuffer {
	return &LogBuffer{
		entries: make([]LogEntry, size),
		size:    size,
	}
}

// Add appends a log entry.
func (lb *LogBuffer) Add(entry LogEntry) {
	lb.mu.Lock()
	lb.entries[lb.pos] = entry
	lb.pos = (lb.pos + 1) % lb.size
	if lb.count < lb.size {
		lb.count++
	}
	lb.mu.Unlock()
}

// Entries returns all captured entries in chronological order.
func (lb *LogBuffer) Entries() []LogEntry {
	lb.mu.RLock()
	defer lb.mu.RUnlock()

	if lb.count < lb.size {
		out := make([]LogEntry, lb.count)
		copy(out, lb.entries[:lb.count])
		return out
	}
	out := make([]LogEntry, lb.size)
	copy(out, lb.entries[lb.pos:])
	copy(out[lb.size-lb.pos:], lb.entries[:lb.pos])
	return out
}

// LogBufferHandler is a slog.Handler that captures logs into a LogBuffer
// while forwarding to another handler.
type LogBufferHandler struct {
	buffer  *LogBuffer
	next    slog.Handler
	attrs   []slog.Attr
	groups  []string
}

// NewLogBufferHandler wraps an existing handler and captures logs.
func NewLogBufferHandler(buffer *LogBuffer, next slog.Handler) *LogBufferHandler {
	return &LogBufferHandler{buffer: buffer, next: next}
}

func (h *LogBufferHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *LogBufferHandler) Handle(ctx context.Context, r slog.Record) error {
	// Capture into buffer.
	entry := LogEntry{
		Time:    r.Time,
		Level:   r.Level.String(),
		Message: r.Message,
		Attrs:   make(map[string]interface{}),
	}

	// Collect pre-set attrs from WithAttrs.
	for _, a := range h.attrs {
		entry.Attrs[a.Key] = a.Value.Any()
	}

	// Collect record attrs.
	r.Attrs(func(a slog.Attr) bool {
		entry.Attrs[a.Key] = a.Value.Any()
		return true
	})

	h.buffer.Add(entry)

	// Forward to the real handler.
	return h.next.Handle(ctx, r)
}

func (h *LogBufferHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	newAttrs := make([]slog.Attr, len(h.attrs)+len(attrs))
	copy(newAttrs, h.attrs)
	copy(newAttrs[len(h.attrs):], attrs)
	return &LogBufferHandler{buffer: h.buffer, next: h.next.WithAttrs(attrs), attrs: newAttrs, groups: h.groups}
}

func (h *LogBufferHandler) WithGroup(name string) slog.Handler {
	newGroups := make([]string, len(h.groups)+1)
	copy(newGroups, h.groups)
	newGroups[len(h.groups)] = name
	return &LogBufferHandler{buffer: h.buffer, next: h.next.WithGroup(name), attrs: h.attrs, groups: newGroups}
}

// MarshalJSON for LogEntry attrs that may contain non-serializable types.
func marshalAttrs(attrs map[string]interface{}) string {
	data, err := json.Marshal(attrs)
	if err != nil {
		return "{}"
	}
	return string(data)
}
