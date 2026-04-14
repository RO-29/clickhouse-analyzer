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
	Period       string           // "daily" or "weekly"
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

// UpdateOrPostInstanceMessage builds a single grouped Slack message containing
// all currently-active alerts for the given instance, then updates the existing
// message (slackTS) in-place or posts a new one. Returns the message timestamp.
//
// All severities (critical + warn) appear in one message, sorted critical-first.
// Color reflects the highest severity present.
func (s *SlackNotifier) UpdateOrPostInstanceMessage(instance string, slackTS string, alerts []*ActiveAlert) (string, error) {
	if len(alerts) == 0 {
		return slackTS, nil
	}

	var critCount, warnCount int
	for _, a := range alerts {
		switch a.Alert.Severity {
		case collector.SeverityCritical:
			critCount++
		case collector.SeverityWarn:
			warnCount++
		}
	}

	color := colorOrange
	emoji := ":warning:"
	if critCount > 0 {
		color = colorRed
		emoji = ":rotating_light:"
	}

	var countParts []string
	if critCount > 0 {
		countParts = append(countParts, fmt.Sprintf("*%d critical*", critCount))
	}
	if warnCount > 0 {
		countParts = append(countParts, fmt.Sprintf("*%d warn*", warnCount))
	}

	headerText := fmt.Sprintf("%s *%s* — %s", emoji, escapeMarkdown(instance), strings.Join(countParts, " · "))

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerText, false, false),
			nil, nil,
		),
		slack.NewDividerBlock(),
	}

	// Critical alerts section.
	if critCount > 0 {
		var lines []string
		for _, a := range alerts {
			if a.Alert.Severity != collector.SeverityCritical {
				continue
			}
			dur := time.Since(a.FirstSeen).Round(time.Minute)
			line := fmt.Sprintf("• *%s* — firing %s", escapeMarkdown(a.Alert.Title), formatDuration(dur))
			if a.Count > 1 {
				line += fmt.Sprintf(" (×%d)", a.Count)
			}
			lines = append(lines, line)
		}
		blocks = append(blocks, slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf(":rotating_light: *Critical (%d)*\n%s", critCount, strings.Join(lines, "\n")),
				false, false),
			nil, nil,
		))
	}

	// Warn alerts section.
	if warnCount > 0 {
		var lines []string
		for _, a := range alerts {
			if a.Alert.Severity != collector.SeverityWarn {
				continue
			}
			dur := time.Since(a.FirstSeen).Round(time.Minute)
			line := fmt.Sprintf("• *%s* — firing %s", escapeMarkdown(a.Alert.Title), formatDuration(dur))
			if a.Count > 1 {
				line += fmt.Sprintf(" (×%d)", a.Count)
			}
			lines = append(lines, line)
		}
		blocks = append(blocks, slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf(":warning: *Warn (%d)*\n%s", warnCount, strings.Join(lines, "\n")),
				false, false),
			nil, nil,
		))
	}

	// Expanded detail for the most-severe single alert (avoids flooding with
	// all messages; gives the on-call engineer the most important context).
	if len(alerts) > 0 && alerts[0].Alert.Message != "" {
		msg := alerts[0].Alert.Message
		if len(msg) > 400 {
			msg = msg[:400] + "…"
		}
		blocks = append(blocks,
			slack.NewDividerBlock(),
			slack.NewSectionBlock(
				slack.NewTextBlockObject(slack.MarkdownType,
					fmt.Sprintf("*Top alert detail:*\n%s", msg), false, false),
				nil, nil,
			),
		)
	}

	blocks = append(blocks, slack.NewContextBlock("",
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("Updated: %s", time.Now().Format("02 Jan 15:04 MST")), false, false),
	))

	attachment := slack.Attachment{
		Color:  color,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	fallbackText := fmt.Sprintf("%s %s — %s", emoji, instance, strings.Join(countParts, ", "))
	return s.updateOrPost(slackTS, fallbackText, attachment)
}

// PostInstanceAllClear updates the instance's existing Slack message to show
// all alerts resolved (green). If no existing message, posts a new one.
func (s *SlackNotifier) PostInstanceAllClear(instance string, slackTS string) (string, error) {
	headerText := fmt.Sprintf(":white_check_mark: *%s* — All clear", escapeMarkdown(instance))

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerText, false, false),
			nil, nil,
		),
		slack.NewContextBlock("",
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("All alerts resolved at %s", time.Now().Format("02 Jan 15:04 MST")),
				false, false),
		),
	}

	attachment := slack.Attachment{
		Color:  colorGreen,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	fallbackText := fmt.Sprintf(":white_check_mark: %s — All clear", instance)
	return s.updateOrPost(slackTS, fallbackText, attachment)
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

// updateOrPost updates an existing Slack message by TS, or posts a new one.
// Returns the (possibly new) message timestamp.
func (s *SlackNotifier) updateOrPost(slackTS, fallbackText string, attachment slack.Attachment) (string, error) {
	if slackTS != "" {
		_, _, _, err := s.client.UpdateMessage(
			s.channelID, slackTS,
			slack.MsgOptionAttachments(attachment),
			slack.MsgOptionText(fallbackText, false),
		)
		if err == nil {
			s.logger.Debug("slack message updated in-place", slog.String("ts", slackTS))
			return slackTS, nil
		}
		s.logger.Warn("failed to update slack message, posting new",
			slog.String("ts", slackTS), slog.String("error", err.Error()))
		// Fall through to post a new message.
	}

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

// postMessage wraps the Slack API call with logging and rate-limit handling.
func (s *SlackNotifier) postMessage(opts ...slack.MsgOption) error {
	opts = append(opts, slack.MsgOptionDisableLinkUnfurl())
	_, _, err := s.client.PostMessage(s.channelID, opts...)
	if err != nil {
		if rlErr, ok := err.(*slack.RateLimitedError); ok {
			s.logger.Warn("slack rate limited, message dropped",
				slog.Duration("retry_after", rlErr.RetryAfter))
			return fmt.Errorf("slack rate limited (retry after %s): %w", rlErr.RetryAfter, err)
		}
		s.logger.Error("failed to post slack message",
			slog.String("channel", s.channelID), slog.String("error", err.Error()))
		return fmt.Errorf("slack post message: %w", err)
	}
	s.logger.Debug("slack message sent", slog.String("channel", s.channelID))
	return nil
}

// escapeMarkdown does a minimal escape of characters that could break Slack mrkdwn.
func escapeMarkdown(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

func capitalizeFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// formatDuration returns a human-friendly representation, e.g. "2h 15m".
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
