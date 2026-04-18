package alerter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

const pdEventsURL = "https://events.pagerduty.com/v2/enqueue"

// PagerDutyNotifier sends events to the PagerDuty Events API v2.
type PagerDutyNotifier struct {
	RoutingKey  string // integration key
	client      *http.Client
	rateLimiter *RateLimiter
}

// NewPagerDutyNotifier creates a PagerDutyNotifier with the given routing key.
// A per-key rate limiter with a 5-minute minimum gap is installed to prevent
// alert storms from triggering repeated PD calls for the same dedup key.
func NewPagerDutyNotifier(routingKey string) *PagerDutyNotifier {
	return &PagerDutyNotifier{
		RoutingKey:  routingKey,
		client:      &http.Client{Timeout: 10 * time.Second},
		rateLimiter: NewRateLimiter(5 * time.Minute),
	}
}

// pdPayload is the full request body for the PD Events API v2.
type pdPayload struct {
	RoutingKey  string        `json:"routing_key"`
	EventAction string        `json:"event_action"`
	DedupKey    string        `json:"dedup_key"`
	Payload     pdEventDetail `json:"payload,omitempty"`
}

type pdEventDetail struct {
	Summary       string            `json:"summary"`
	Source        string            `json:"source"`
	Severity      string            `json:"severity"`
	Timestamp     string            `json:"timestamp"`
	CustomDetails map[string]string `json:"custom_details,omitempty"`
}

// mapSeverity converts collector.Severity to PagerDuty severity string.
func mapSeverity(s collector.Severity) string {
	switch s {
	case collector.SeverityCritical:
		return "critical"
	case collector.SeverityWarn:
		return "warning"
	default:
		return "info"
	}
}

// TriggerAlert sends a TRIGGER event for a new/ongoing alert.
// dedupKey is used as the dedup_key for PD's own dedup logic.
// Only sends for non-info alerts. Calls are rate-limited to once per 5 minutes
// per dedupKey to prevent alert storms.
func (p *PagerDutyNotifier) TriggerAlert(alert collector.Alert, dedupKey string) error {
	if alert.Severity == collector.SeverityInfo {
		return nil
	}
	if !p.rateLimiter.Allow(dedupKey) {
		slog.Debug("pagerduty: rate limited, skipping trigger",
			slog.String("dedup_key", dedupKey),
		)
		return nil
	}

	payload := pdPayload{
		RoutingKey:  p.RoutingKey,
		EventAction: "trigger",
		DedupKey:    dedupKey,
		Payload: pdEventDetail{
			Summary:   alert.Title,
			Source:    alert.Instance,
			Severity:  mapSeverity(alert.Severity),
			Timestamp: alert.Timestamp.UTC().Format(time.RFC3339),
			CustomDetails: map[string]string{
				"message":  alert.Message,
				"category": alert.Category,
			},
		},
	}

	return p.send(payload)
}

// ResolveAlert sends a RESOLVE event for the given dedup key.
func (p *PagerDutyNotifier) ResolveAlert(dedupKey string) error {
	payload := pdPayload{
		RoutingKey:  p.RoutingKey,
		EventAction: "resolve",
		DedupKey:    dedupKey,
	}
	return p.send(payload)
}

// send marshals payload and POSTs it to the PD Events API.
func (p *PagerDutyNotifier) send(payload pdPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("pagerduty: marshal payload: %w", err)
	}

	resp, err := p.client.Post(pdEventsURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("pagerduty: http post: %w", err)
	}
	defer func() {
		io.Copy(io.Discard, resp.Body) //nolint:errcheck
		resp.Body.Close()
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("pagerduty: unexpected status %d", resp.StatusCode)
	}
	return nil
}
