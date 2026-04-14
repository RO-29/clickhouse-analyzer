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
	URL    string
	Secret string // optional: sent as X-Webhook-Secret header
	client *http.Client
}

// NewWebhookNotifier creates a WebhookNotifier for the given URL and optional secret.
func NewWebhookNotifier(url, secret string) *WebhookNotifier {
	return &WebhookNotifier{
		URL:    url,
		Secret: secret,
		client: &http.Client{Timeout: 10 * time.Second},
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
// Errors are logged but not propagated to callers.
func (w *WebhookNotifier) Send(payload WebhookPayload) error {
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
