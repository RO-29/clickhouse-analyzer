package web

import (
	"net/http"
	"strings"
)

// notifyChannelStatus is the per-channel status object returned by
// GET /api/notify/status.
type notifyChannelStatus struct {
	Configured bool   `json:"configured"`
	Channel    string `json:"channel,omitempty"`   // Slack channel name/ID
	HasToken   bool   `json:"has_token,omitempty"` // Slack: bot token present
	URL        string `json:"url,omitempty"`       // Webhook URL (masked)
}

// handleNotifyStatus handles GET /api/notify/status.
// Returns which notification channels are configured without leaking secrets.
func (s *Server) handleNotifyStatus(w http.ResponseWriter, r *http.Request) {
	slack := s.cfg.Slack
	notify := s.cfg.Notify

	// Slack status.
	slackStatus := notifyChannelStatus{
		Configured: slack.BotToken != "" && slack.ChannelID != "",
		HasToken:   slack.BotToken != "",
	}
	if slack.ChannelID != "" {
		slackStatus.Channel = slack.ChannelID
	}

	// PagerDuty status — only report configured if routing key is set.
	pdStatus := notifyChannelStatus{
		Configured: notify.PagerDuty.Enabled && notify.PagerDuty.RoutingKey != "",
	}

	// Webhook status — mask the URL to avoid leaking internal endpoints.
	webhookURL := ""
	if notify.Webhook.URL != "" {
		webhookURL = maskURL(notify.Webhook.URL)
	}
	webhookStatus := notifyChannelStatus{
		Configured: notify.Webhook.Enabled && notify.Webhook.URL != "",
		URL:        webhookURL,
	}

	// Email is not yet implemented.
	emailStatus := notifyChannelStatus{
		Configured: false,
	}

	type response struct {
		Slack     notifyChannelStatus `json:"slack"`
		PagerDuty notifyChannelStatus `json:"pagerduty"`
		Webhook   notifyChannelStatus `json:"webhook"`
		Email     notifyChannelStatus `json:"email"`
	}

	writeJSON(w, http.StatusOK, response{
		Slack:     slackStatus,
		PagerDuty: pdStatus,
		Webhook:   webhookStatus,
		Email:     emailStatus,
	})
}

// maskURL returns a URL with only the scheme and host visible, e.g.
// "https://hooks.slack.com/services/***" to avoid leaking path tokens.
func maskURL(rawURL string) string {
	// Find the third "/" (after scheme "https://host/...").
	schemeEnd := strings.Index(rawURL, "://")
	if schemeEnd < 0 {
		return "***"
	}
	hostStart := schemeEnd + 3
	pathStart := strings.Index(rawURL[hostStart:], "/")
	if pathStart < 0 {
		// No path, just return scheme+host.
		return rawURL
	}
	return rawURL[:hostStart+pathStart] + "/***"
}
