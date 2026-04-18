package alerter

import (
	"sync"
	"time"
)

// RateLimiter enforces a minimum gap between sends for the same key.
// It is safe for concurrent use.
type RateLimiter struct {
	mu       sync.Mutex
	lastSent map[string]time.Time
	minGap   time.Duration // minimum time between sends for same key
}

// NewRateLimiter creates a RateLimiter with the given minimum gap between
// allowed sends for any single key.
func NewRateLimiter(minGap time.Duration) *RateLimiter {
	return &RateLimiter{
		lastSent: make(map[string]time.Time),
		minGap:   minGap,
	}
}

// Allow returns true if the key can send now and records the send time.
// Returns false if the key was sent within the last minGap duration.
func (r *RateLimiter) Allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if last, ok := r.lastSent[key]; ok && time.Since(last) < r.minGap {
		return false
	}
	r.lastSent[key] = time.Now()
	return true
}
