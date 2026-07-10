package alerter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// WebhookNotifier posts JSON payloads to a configurable URL.
// Supports Teams, Discord, or any custom webhook endpoint.
type WebhookNotifier struct {
	URL         string
	Secret      string // optional: sent as X-Webhook-Secret header
	client      *http.Client
	rateLimiter *RateLimiter
}

// NewWebhookNotifier creates a WebhookNotifier for the given URL and optional secret.
// A per-key rate limiter with a 5-minute minimum gap is installed to prevent
// alert storms from triggering repeated webhook calls for the same dedup key.
func NewWebhookNotifier(url, secret string) *WebhookNotifier {
	return &WebhookNotifier{
		URL:         url,
		Secret:      secret,
		client:      &http.Client{Timeout: 10 * time.Second},
		rateLimiter: NewRateLimiter(5 * time.Minute),
	}
}

// WebhookPayload is the JSON body sent for every webhook notification.
type WebhookPayload struct {
	Event     string    `json:"event"`     // "alert_firing", "alert_resolved", "all_clear"
	Instance  string    `json:"instance"`
	Severity  string    `json:"severity"`
	Category  string    `json:"category"`
	Title     string    `json:"title"`
	Message   string    `json:"message"`
	DedupKey  string    `json:"dedup_key"`
	FiredAt   time.Time `json:"fired_at"`
	FireCount int       `json:"fire_count"`
}

// Send POSTs payload as JSON to the configured webhook URL.
//
// Only "alert_firing" events are rate-limited (once per 5 minutes), and the
// rate-limit key includes severity so that:
//   - resolve / all_clear events are NEVER suppressed — they are terminal and
//     dropping them would leave downstream systems thinking an alert is still
//     firing; and
//   - a genuine escalation (warn -> critical on the same key) is delivered
//     rather than being swallowed as a "repeat" of the earlier warn.
//
// Errors are logged but not propagated to callers.
func (w *WebhookNotifier) Send(payload WebhookPayload) error {
	if payload.Event == "alert_firing" && payload.DedupKey != "" {
		rlKey := payload.Severity + ":" + payload.DedupKey
		if !w.rateLimiter.Allow(rlKey) {
			slog.Debug("webhook: rate limited, skipping send",
				slog.String("dedup_key", payload.DedupKey),
				slog.String("event", payload.Event),
			)
			return nil
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		slog.Error("webhook: failed to marshal payload", slog.String("error", err.Error()))
		return fmt.Errorf("webhook: marshal: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, w.URL, bytes.NewReader(body))
	if err != nil {
		slog.Error("webhook: failed to create request", slog.String("error", err.Error()))
		return fmt.Errorf("webhook: new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if w.Secret != "" {
		req.Header.Set("X-Webhook-Secret", w.Secret)
	}

	resp, err := w.client.Do(req)
	if err != nil {
		slog.Error("webhook: request failed",
			slog.String("url", w.URL),
			slog.String("error", err.Error()),
		)
		return fmt.Errorf("webhook: http do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		slog.Error("webhook: unexpected status",
			slog.String("url", w.URL),
			slog.Int("status", resp.StatusCode),
		)
		return fmt.Errorf("webhook: unexpected status %d", resp.StatusCode)
	}

	slog.Debug("webhook: payload delivered",
		slog.String("url", w.URL),
		slog.String("event", payload.Event),
		slog.String("instance", payload.Instance),
	)
	return nil
}
