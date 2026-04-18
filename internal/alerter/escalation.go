package alerter

import "time"

// EscalationConfig controls when escalation notices are sent.
type EscalationConfig struct {
	// Enabled controls whether escalation notices are sent at all. Default: true.
	Enabled bool
	// NoticeAfter is how long an alert must be continuously firing before
	// an escalation notice is sent. Default: 30 minutes.
	NoticeAfter time.Duration
	// RepeatEvery is how often to repeat the escalation notice. Default: 30 minutes.
	RepeatEvery time.Duration
}

// DefaultEscalationConfig returns sensible defaults.
func DefaultEscalationConfig() EscalationConfig {
	return EscalationConfig{
		Enabled:     true,
		NoticeAfter: 30 * time.Minute,
		RepeatEvery: 30 * time.Minute,
	}
}
