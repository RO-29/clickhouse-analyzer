// Package alerter provides alert management with deduplication, severity
// routing, and Slack integration for the ch-analyzer monitoring tool.
package alerter

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
	"github.com/slack-go/slack"
)

// DigestMessage holds the data needed to render a daily or weekly summary
// message in Slack.
type DigestMessage struct {
	Period       string            // "daily" or "weekly"
	HealthScores map[string]int   // instance -> score (0-100)
	TopIssues    []string
	Stats        map[string]string // key metrics
	DashboardURL string
}

// SlackNotifier sends alert messages to a Slack channel using the Block Kit API.
// It supports updating messages in-place via Slack's chat.update API.
type SlackNotifier struct {
	client    *slack.Client
	channelID string
	logger    *slog.Logger
}

// NewSlackNotifier creates a SlackNotifier that posts to the given channel.
func NewSlackNotifier(botToken, channelID string) *SlackNotifier {
	return &SlackNotifier{
		client:    slack.New(botToken),
		channelID: channelID,
		logger: slog.Default().With(
			slog.String("component", "slack-notifier"),
		),
	}
}

// UpdateOrPostAlert updates an existing message if slackTS is set, or posts a new one.
// Returns the message timestamp for future updates.
func (s *SlackNotifier) UpdateOrPostAlert(alert collector.Alert, slackTS string, resolved bool, fireCount ...int) (string, error) {
	color := severityColor(alert.Severity)
	emoji := severityEmoji(alert.Severity)
	statusLine := ""

	count := 0
	if len(fireCount) > 0 {
		count = fireCount[0]
	}

	if resolved {
		color = colorGreen
		emoji = ":white_check_mark:"
		statusLine = "\n\n*Status:* :white_check_mark: RESOLVED"
		if count > 1 {
			statusLine += fmt.Sprintf(" (fired %d times)", count)
		}
	} else {
		statusLine = "\n\n*Status:* :rotating_light: FIRING"
		if count > 1 {
			statusLine += fmt.Sprintf(" (iteration #%d)", count)
		}
	}

	headerText := fmt.Sprintf("%s *%s*", emoji, escapeMarkdown(alert.Title))
	fields := []*slack.TextBlockObject{
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Instance:*\n%s", alert.Instance), false, false),
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Severity:*\n%s", strings.ToUpper(string(alert.Severity))), false, false),
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Category:*\n%s", alert.Category), false, false),
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Time:*\n%s", alert.Timestamp.Format(time.RFC822)), false, false),
	}

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerText+statusLine, false, false),
			nil, nil,
		),
		slack.NewSectionBlock(nil, fields, nil),
	}

	if alert.Message != "" {
		blocks = append(blocks,
			slack.NewDividerBlock(),
			slack.NewSectionBlock(
				slack.NewTextBlockObject(slack.MarkdownType, alert.Message, false, false),
				nil, nil,
			),
		)
	}

	blocks = append(blocks, slack.NewContextBlock("",
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("dedup: `%s` | updated: %s", alert.DedupKey, time.Now().Format(time.RFC822)), false, false),
	))

	attachment := slack.Attachment{
		Color:  color,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	fallbackText := fmt.Sprintf("%s %s — %s", emoji, alert.Title, alert.Instance)

	if slackTS != "" {
		// Update existing message.
		_, _, _, err := s.client.UpdateMessage(
			s.channelID,
			slackTS,
			slack.MsgOptionAttachments(attachment),
			slack.MsgOptionText(fallbackText, false),
		)
		if err != nil {
			s.logger.Error("failed to update slack message, posting new",
				slog.String("ts", slackTS),
				slog.String("error", err.Error()),
			)
			// Fall through to post new message.
		} else {
			s.logger.Debug("slack message updated", slog.String("ts", slackTS))
			return slackTS, nil
		}
	}

	// Post new message.
	_, ts, err := s.client.PostMessage(s.channelID,
		slack.MsgOptionAttachments(attachment),
		slack.MsgOptionText(fallbackText, false),
		slack.MsgOptionDisableLinkUnfurl(),
	)
	if err != nil {
		return "", fmt.Errorf("slack post: %w", err)
	}
	s.logger.Debug("slack message posted", slog.String("ts", ts))
	return ts, nil
}

// SendAlert posts a single critical alert with rich Block Kit formatting and a
// red sidebar.
func (s *SlackNotifier) SendAlert(alert collector.Alert) error {
	color := severityColor(alert.Severity)
	emoji := severityEmoji(alert.Severity)

	headerText := fmt.Sprintf("%s *%s*", emoji, escapeMarkdown(alert.Title))
	fields := []*slack.TextBlockObject{
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Instance:*\n%s", alert.Instance), false, false),
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Severity:*\n%s", strings.ToUpper(string(alert.Severity))), false, false),
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Category:*\n%s", alert.Category), false, false),
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Time:*\n%s", alert.Timestamp.Format(time.RFC822)), false, false),
	}

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerText, false, false),
			nil, nil,
		),
		slack.NewSectionBlock(nil, fields, nil),
	}

	if alert.Message != "" {
		blocks = append(blocks,
			slack.NewDividerBlock(),
			slack.NewSectionBlock(
				slack.NewTextBlockObject(slack.MarkdownType, alert.Message, false, false),
				nil, nil,
			),
		)
	}

	blocks = append(blocks, slack.NewContextBlock("",
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("dedup: `%s`", alert.DedupKey), false, false),
	))

	attachment := slack.Attachment{
		Color:  color,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	return s.postMessage(
		slack.MsgOptionAttachments(attachment),
		slack.MsgOptionText(fmt.Sprintf("%s %s — %s", emoji, alert.Title, alert.Instance), false),
	)
}

// SendOrUpdateBatch posts or updates a single Slack message with all warn alerts.
// Returns the message timestamp for future updates.
func (s *SlackNotifier) SendOrUpdateBatch(alerts []collector.Alert, slackTS string) (string, error) {
	if len(alerts) == 0 {
		return slackTS, nil
	}

	// Group alerts by instance for cleaner display.
	byInstance := make(map[string][]collector.Alert)
	for _, a := range alerts {
		byInstance[a.Instance] = append(byInstance[a.Instance], a)
	}

	headerText := fmt.Sprintf(":warning: *%d Warning Alerts* across %d instances", len(alerts), len(byInstance))

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerText, false, false),
			nil, nil,
		),
		slack.NewDividerBlock(),
	}

	i := 0
	for instance, instanceAlerts := range byInstance {
		var lines []string
		for _, a := range instanceAlerts {
			msg := a.Message
			if len(msg) > 200 {
				msg = msg[:200] + "..."
			}
			lines = append(lines, fmt.Sprintf("  %d. *%s* [%s]\n      %s",
				i+1, escapeMarkdown(a.Title), a.Category, msg))
			i++
		}

		blocks = append(blocks, slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("*%s* (%d alerts):\n%s", instance, len(instanceAlerts), strings.Join(lines, "\n")),
				false, false),
			nil, nil,
		))
	}

	blocks = append(blocks, slack.NewContextBlock("",
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("Updated at %s", time.Now().Format(time.RFC822)), false, false),
	))

	attachment := slack.Attachment{
		Color:  colorOrange,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	fallbackText := fmt.Sprintf(":warning: %d warning alerts", len(alerts))

	if slackTS != "" {
		_, _, _, err := s.client.UpdateMessage(s.channelID, slackTS,
			slack.MsgOptionAttachments(attachment),
			slack.MsgOptionText(fallbackText, false),
		)
		if err == nil {
			s.logger.Debug("warn batch updated in-place", slog.String("ts", slackTS))
			return slackTS, nil
		}
		s.logger.Warn("failed to update batch, posting new", slog.String("error", err.Error()))
	}

	_, ts, err := s.client.PostMessage(s.channelID,
		slack.MsgOptionAttachments(attachment),
		slack.MsgOptionText(fallbackText, false),
		slack.MsgOptionDisableLinkUnfurl(),
	)
	if err != nil {
		return "", fmt.Errorf("slack post batch: %w", err)
	}
	return ts, nil
}

// SendAlertBatch posts multiple warn-level alerts as a single Slack message.
// Deprecated: use SendOrUpdateBatch for in-place updates.
func (s *SlackNotifier) SendAlertBatch(alerts []collector.Alert) error {
	if len(alerts) == 0 {
		return nil
	}

	headerText := fmt.Sprintf(":warning: *%d Warning Alerts*", len(alerts))

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerText, false, false),
			nil, nil,
		),
		slack.NewDividerBlock(),
	}

	for i, alert := range alerts {
		line := fmt.Sprintf("*%d.* *%s* — `%s` [%s]\n%s",
			i+1,
			escapeMarkdown(alert.Title),
			alert.Instance,
			alert.Category,
			alert.Message,
		)
		blocks = append(blocks, slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, line, false, false),
			nil, nil,
		))

		// Slack limits blocks per message; split at a reasonable boundary.
		if i > 0 && i%15 == 0 {
			blocks = append(blocks, slack.NewDividerBlock())
		}
	}

	ts := time.Now().Format(time.RFC822)
	blocks = append(blocks, slack.NewContextBlock("",
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("Batched at %s", ts), false, false),
	))

	attachment := slack.Attachment{
		Color:  colorOrange,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	return s.postMessage(
		slack.MsgOptionAttachments(attachment),
		slack.MsgOptionText(fmt.Sprintf(":warning: %d warning alerts", len(alerts)), false),
	)
}

// SendResolution posts a green "all clear" message indicating a previously
// firing alert has resolved.
func (s *SlackNotifier) SendResolution(dedupKey, title, instance string, duration time.Duration) error {
	headerText := fmt.Sprintf(":white_check_mark: *Resolved: %s*", escapeMarkdown(title))

	fields := []*slack.TextBlockObject{
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Instance:*\n%s", instance), false, false),
		slack.NewTextBlockObject(slack.MarkdownType, fmt.Sprintf("*Duration:*\n%s", formatDuration(duration)), false, false),
	}

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerText, false, false),
			nil, nil,
		),
		slack.NewSectionBlock(nil, fields, nil),
		slack.NewContextBlock("",
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("dedup: `%s` | resolved at %s", dedupKey, time.Now().Format(time.RFC822)),
				false, false),
		),
	}

	attachment := slack.Attachment{
		Color:  colorGreen,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	return s.postMessage(
		slack.MsgOptionAttachments(attachment),
		slack.MsgOptionText(fmt.Sprintf(":white_check_mark: Resolved: %s — %s (lasted %s)", title, instance, formatDuration(duration)), false),
	)
}

// SendDigest posts a daily or weekly summary with health scores, top issues,
// and key stats.
func (s *SlackNotifier) SendDigest(digest DigestMessage) error {
	periodTitle := capitalizeFirst(digest.Period)
	headerText := fmt.Sprintf(":bar_chart: *%s ClickHouse Health Digest*", periodTitle)

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerText, false, false),
			nil, nil,
		),
		slack.NewDividerBlock(),
	}

	// Health scores per instance.
	if len(digest.HealthScores) > 0 {
		var sb strings.Builder
		sb.WriteString("*Health Scores:*\n")
		for instance, score := range digest.HealthScores {
			icon := ":large_green_circle:"
			if score < 70 {
				icon = ":red_circle:"
			} else if score < 90 {
				icon = ":large_yellow_circle:"
			}
			sb.WriteString(fmt.Sprintf("%s  `%s`: *%d/100*\n", icon, instance, score))
		}
		blocks = append(blocks, slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, sb.String(), false, false),
			nil, nil,
		))
	}

	// Top issues.
	if len(digest.TopIssues) > 0 {
		var sb strings.Builder
		sb.WriteString("*Top Issues:*\n")
		for i, issue := range digest.TopIssues {
			sb.WriteString(fmt.Sprintf("%d. %s\n", i+1, issue))
		}
		blocks = append(blocks,
			slack.NewDividerBlock(),
			slack.NewSectionBlock(
				slack.NewTextBlockObject(slack.MarkdownType, sb.String(), false, false),
				nil, nil,
			),
		)
	}

	// Key stats.
	if len(digest.Stats) > 0 {
		var fields []*slack.TextBlockObject
		for k, v := range digest.Stats {
			fields = append(fields,
				slack.NewTextBlockObject(slack.MarkdownType,
					fmt.Sprintf("*%s:*\n%s", k, v), false, false),
			)
		}
		blocks = append(blocks,
			slack.NewDividerBlock(),
			slack.NewSectionBlock(nil, fields, nil),
		)
	}

	// Dashboard link.
	if digest.DashboardURL != "" {
		blocks = append(blocks,
			slack.NewDividerBlock(),
			slack.NewSectionBlock(
				slack.NewTextBlockObject(slack.MarkdownType,
					fmt.Sprintf(":chart_with_upwards_trend: <%s|Open Dashboard>", digest.DashboardURL),
					false, false),
				nil, nil,
			),
		)
	}

	blocks = append(blocks, slack.NewContextBlock("",
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("Generated %s", time.Now().Format(time.RFC1123)), false, false),
	))

	attachment := slack.Attachment{
		Color:  colorBlue,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	return s.postMessage(
		slack.MsgOptionAttachments(attachment),
		slack.MsgOptionText(fmt.Sprintf("%s ClickHouse Health Digest", periodTitle), false),
	)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const (
	colorRed    = "#E01E5A"
	colorOrange = "#ECB22E"
	colorGreen  = "#2EB67D"
	colorBlue   = "#36C5F0"
)

// postMessage wraps the Slack API call with logging and basic rate-limit
// handling.
func (s *SlackNotifier) postMessage(opts ...slack.MsgOption) error {
	opts = append(opts, slack.MsgOptionDisableLinkUnfurl())

	_, _, err := s.client.PostMessage(s.channelID, opts...)
	if err != nil {
		// Handle Slack rate limiting.
		if rlErr, ok := err.(*slack.RateLimitedError); ok {
			s.logger.Warn("slack rate limited, message dropped",
				slog.Duration("retry_after", rlErr.RetryAfter),
			)
			return fmt.Errorf("slack rate limited (retry after %s): %w", rlErr.RetryAfter, err)
		}
		s.logger.Error("failed to post slack message",
			slog.String("channel", s.channelID),
			slog.String("error", err.Error()),
		)
		return fmt.Errorf("slack post message: %w", err)
	}

	s.logger.Debug("slack message sent", slog.String("channel", s.channelID))
	return nil
}

func severityColor(sev collector.Severity) string {
	switch sev {
	case collector.SeverityCritical:
		return colorRed
	case collector.SeverityWarn:
		return colorOrange
	case collector.SeverityInfo:
		return colorBlue
	default:
		return colorBlue
	}
}

func severityEmoji(sev collector.Severity) string {
	switch sev {
	case collector.SeverityCritical:
		return ":rotating_light:"
	case collector.SeverityWarn:
		return ":warning:"
	case collector.SeverityInfo:
		return ":information_source:"
	default:
		return ":information_source:"
	}
}

// escapeMarkdown does a minimal escape of characters that could break Slack
// mrkdwn rendering.
func escapeMarkdown(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

// capitalizeFirst upper-cases the first rune of s (avoids deprecated
// strings.Title).
func capitalizeFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// formatDuration returns a human-friendly representation of a duration,
// e.g. "2h 15m" instead of "2h15m0s".
func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return d.Round(time.Second).String()
	}
	hours := int(d.Hours())
	minutes := int(d.Minutes()) % 60
	if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, minutes)
	}
	return fmt.Sprintf("%dm", minutes)
}
