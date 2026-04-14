// Package alerter provides alert management with deduplication, severity
// routing, and Slack integration for the ch-analyzer monitoring tool.
package alerter

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
	"github.com/slack-go/slack"
)

// DigestMessage holds the data needed to render a daily or weekly summary.
type DigestMessage struct {
	Period       string
	HealthScores map[string]int
	TopIssues    []string
	Stats        map[string]string
	DashboardURL string
}

// SlackNotifier sends alert messages to a Slack channel using the Block Kit API.
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

// ---------------------------------------------------------------------------
// Instance alert message — one per instance, updated in-place
// ---------------------------------------------------------------------------

// UpdateOrPostInstanceMessage builds a rich grouped Slack message for all
// active alerts on the given instance, then updates or posts it.
func (s *SlackNotifier) UpdateOrPostInstanceMessage(instance string, slackTS string, alerts []*ActiveAlert) (string, error) {
	if len(alerts) == 0 {
		return slackTS, nil
	}

	var critCount, warnCount int
	var categories []string
	catSeen := map[string]bool{}
	for _, a := range alerts {
		switch a.Alert.Severity {
		case collector.SeverityCritical:
			critCount++
		case collector.SeverityWarn:
			warnCount++
		}
		cat := a.Alert.Category
		if !catSeen[cat] {
			catSeen[cat] = true
			categories = append(categories, cat)
		}
	}
	sort.Strings(categories)

	// Sidebar color and top-level status indicators.
	color := colorOrange
	statusEmoji := "🟠"
	severityLabel := "WARNING"
	if critCount > 0 {
		color = colorRed
		statusEmoji = "🔴"
		severityLabel = "CRITICAL"
	}

	// How long has this instance been firing?
	oldestAlert := alerts[0]
	for _, a := range alerts {
		if a.FirstSeen.Before(oldestAlert.FirstSeen) {
			oldestAlert = a
		}
	}
	firingSince := oldestAlert.FirstSeen.UTC().Format("15:04 UTC")
	firingDur := formatDuration(time.Since(oldestAlert.FirstSeen).Round(time.Minute))

	// ── Header ──────────────────────────────────────────────────────────────
	// Bold instance name + status — the most important thing to see at a glance.
	var countParts []string
	if critCount > 0 {
		countParts = append(countParts, fmt.Sprintf("*%d critical*", critCount))
	}
	if warnCount > 0 {
		countParts = append(countParts, fmt.Sprintf("*%d warning*", warnCount))
	}

	headerMd := fmt.Sprintf("%s  *%s*  ·  %s",
		statusEmoji,
		escapeMarkdown(instance),
		strings.Join(countParts, "  ·  "),
	)

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerMd, false, false),
			nil, nil,
		),
	}

	// ── Metadata fields (2-column) ───────────────────────────────────────────
	catEmojis := make([]string, 0, len(categories))
	for _, c := range categories {
		catEmojis = append(catEmojis, categoryEmoji(c)+" "+c)
	}
	fields := []*slack.TextBlockObject{
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("*Severity*\n%s  %s", statusEmoji, severityLabel), false, false),
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("*Firing Since*\n🕐  %s  (%s)", firingSince, firingDur), false, false),
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("*Alert Count*\n🔔  %d total", critCount+warnCount), false, false),
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("*Categories*\n%s", strings.Join(catEmojis, "  ·  ")), false, false),
	}
	blocks = append(blocks,
		slack.NewSectionBlock(nil, fields, nil),
		slack.NewDividerBlock(),
	)

	// ── Critical alerts ──────────────────────────────────────────────────────
	if critCount > 0 {
		var lines []string
		for _, a := range alerts {
			if a.Alert.Severity != collector.SeverityCritical {
				continue
			}
			lines = append(lines, formatAlertLine(a))
		}
		blocks = append(blocks, slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("🚨  *Critical  —  %d alert(s)*\n\n%s", critCount, strings.Join(lines, "\n")),
				false, false),
			nil, nil,
		))
	}

	// ── Warn alerts ──────────────────────────────────────────────────────────
	if warnCount > 0 {
		var lines []string
		for _, a := range alerts {
			if a.Alert.Severity != collector.SeverityWarn {
				continue
			}
			lines = append(lines, formatAlertLine(a))
		}
		sep := ""
		if critCount > 0 {
			sep = "\n"
		}
		blocks = append(blocks, slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("%s⚠️  *Warning  —  %d alert(s)*\n\n%s", sep, warnCount, strings.Join(lines, "\n")),
				false, false),
			nil, nil,
		))
	}

	// ── Top alert detail (most critical/oldest) ──────────────────────────────
	if alerts[0].Alert.Message != "" {
		msg := stripSlackMarkup(alerts[0].Alert.Message)
		if len(msg) > 600 {
			msg = msg[:600] + "…"
		}
		topTitle := alerts[0].Alert.Title
		blocks = append(blocks,
			slack.NewDividerBlock(),
			slack.NewSectionBlock(
				slack.NewTextBlockObject(slack.MarkdownType,
					fmt.Sprintf("📋  *%s — Details*\n\n%s",
						escapeMarkdown(topTitle), msg),
					false, false),
				nil, nil,
			),
		)
	}

	// ── Footer ───────────────────────────────────────────────────────────────
	blocks = append(blocks, slack.NewContextBlock("",
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("🕐  *Updated* %s  ·  ch-analyzer  ·  `%s`",
				time.Now().UTC().Format("15:04:05 UTC"),
				instance),
			false, false),
	))

	attachment := slack.Attachment{
		Color:  color,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	fallbackText := fmt.Sprintf("[%s] %s — %s", severityLabel, instance, strings.Join(countParts, ", "))
	return s.updateOrPost(slackTS, fallbackText, attachment)
}

// ---------------------------------------------------------------------------
// All-clear message
// ---------------------------------------------------------------------------

func (s *SlackNotifier) PostInstanceAllClear(instance string, slackTS string) (string, error) {
	now := time.Now().UTC()

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("✅  *%s*  ·  All Clear", escapeMarkdown(instance)),
				false, false),
			nil, nil,
		),
		slack.NewContextBlock("",
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("🕐  Resolved at %s  ·  ch-analyzer  ·  `%s`",
					now.Format("15:04:05 UTC"), instance),
				false, false),
		),
	}

	attachment := slack.Attachment{
		Color:  colorGreen,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	return s.updateOrPost(slackTS,
		fmt.Sprintf("[RESOLVED] %s — All Clear", instance),
		attachment)
}

// ---------------------------------------------------------------------------
// Escalation notice
// ---------------------------------------------------------------------------

func (s *SlackNotifier) PostEscalationNotice(instance string, firingMinutes int) error {
	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("🚨  *Escalation* — `%s` has been firing for *%d minutes* with no response.\n"+
					"Please acknowledge or snooze in the ch-analyzer dashboard.",
					escapeMarkdown(instance), firingMinutes),
				false, false),
			nil, nil,
		),
		slack.NewContextBlock("",
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("⏱  Escalated at %s  ·  ch-analyzer", time.Now().UTC().Format("15:04 UTC")),
				false, false),
		),
	}

	attachment := slack.Attachment{
		Color:  colorRed,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	return s.postMessage(
		slack.MsgOptionAttachments(attachment),
		slack.MsgOptionText(fmt.Sprintf("[ESCALATION] %s — firing %dm", instance, firingMinutes), false),
	)
}

// ---------------------------------------------------------------------------
// Daily / weekly digest
// ---------------------------------------------------------------------------

func (s *SlackNotifier) SendDigest(digest DigestMessage) error {
	periodTitle := capitalizeFirst(digest.Period)

	blocks := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("📊  *%s ClickHouse Health Digest*", periodTitle),
				false, false),
			nil, nil,
		),
		slack.NewDividerBlock(),
	}

	// Health scores — use emoji circles + score bar.
	if len(digest.HealthScores) > 0 {
		var lines []string
		// Sort instances for stable output.
		instances := make([]string, 0, len(digest.HealthScores))
		for inst := range digest.HealthScores {
			instances = append(instances, inst)
		}
		sort.Strings(instances)

		for _, inst := range instances {
			score := digest.HealthScores[inst]
			icon := "🟢"
			if score < 70 {
				icon = "🔴"
			} else if score < 90 {
				icon = "🟡"
			}
			bar := scoreBar(score)
			lines = append(lines, fmt.Sprintf("%s  `%-24s`  %s  *%d/100*", icon, inst, bar, score))
		}
		blocks = append(blocks, slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				"*Instance Health Scores*\n\n"+strings.Join(lines, "\n"),
				false, false),
			nil, nil,
		))
	}

	// Top issues.
	if len(digest.TopIssues) > 0 {
		var sb strings.Builder
		for i, issue := range digest.TopIssues {
			sb.WriteString(fmt.Sprintf("%d.  %s\n", i+1, issue))
		}
		blocks = append(blocks,
			slack.NewDividerBlock(),
			slack.NewSectionBlock(
				slack.NewTextBlockObject(slack.MarkdownType,
					"*Top Issues*\n\n"+sb.String(),
					false, false),
				nil, nil,
			),
		)
	}

	// Key stats as fields.
	if len(digest.Stats) > 0 {
		var fields []*slack.TextBlockObject
		keys := make([]string, 0, len(digest.Stats))
		for k := range digest.Stats {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fields = append(fields,
				slack.NewTextBlockObject(slack.MarkdownType,
					fmt.Sprintf("*%s*\n%s", k, digest.Stats[k]), false, false),
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
					fmt.Sprintf("🔗  <%s|Open ch-analyzer Dashboard>", digest.DashboardURL),
					false, false),
				nil, nil,
			),
		)
	}

	blocks = append(blocks, slack.NewContextBlock("",
		slack.NewTextBlockObject(slack.MarkdownType,
			fmt.Sprintf("📅  Generated %s  ·  ch-analyzer", time.Now().UTC().Format("Mon 02 Jan 2006 15:04 UTC")),
			false, false),
	))

	attachment := slack.Attachment{
		Color:  colorBlue,
		Blocks: slack.Blocks{BlockSet: blocks},
	}

	return s.postMessage(
		slack.MsgOptionAttachments(attachment),
		slack.MsgOptionText(fmt.Sprintf("[DIGEST] %s ClickHouse Health", periodTitle), false),
	)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// formatAlertLine renders a single alert as a readable bullet row.
//
//	💾  *Memory limit exceeded*   `15m`  `×8`
func formatAlertLine(a *ActiveAlert) string {
	icon := categoryEmoji(a.Alert.Category)
	dur := time.Since(a.FirstSeen).Round(time.Minute)
	line := fmt.Sprintf("%s  *%s*   `%s`", icon, escapeMarkdown(a.Alert.Title), formatDuration(dur))
	if a.Count > 1 {
		line += fmt.Sprintf("  `×%d`", a.Count)
	}
	return line
}

// categoryEmoji maps an alert category to a descriptive emoji.
func categoryEmoji(category string) string {
	cat := strings.ToLower(category)
	switch {
	case strings.Contains(cat, "memory"):
		return "💾"
	case strings.Contains(cat, "cpu"):
		return "⚡"
	case strings.Contains(cat, "queries"), strings.Contains(cat, "query"):
		return "🔍"
	case strings.Contains(cat, "replication"):
		return "🔁"
	case strings.Contains(cat, "storage"):
		return "💿"
	case strings.Contains(cat, "inserts"), strings.Contains(cat, "insert"):
		return "📥"
	case strings.Contains(cat, "mvs"), strings.Contains(cat, "mv"):
		return "🔄"
	case strings.Contains(cat, "tables"), strings.Contains(cat, "table"):
		return "📊"
	case strings.Contains(cat, "dictionar"):
		return "📚"
	case strings.Contains(cat, "errors"), strings.Contains(cat, "error"):
		return "❌"
	case strings.Contains(cat, "k8s"):
		return "☸️"
	case strings.Contains(cat, "freshness"):
		return "⏰"
	case strings.Contains(cat, "connectivity"):
		return "🔌"
	case strings.Contains(cat, "cache"):
		return "⚡"
	case strings.Contains(cat, "background"), strings.Contains(cat, "pool"):
		return "🏊"
	case strings.Contains(cat, "schema"):
		return "🗂️"
	case strings.Contains(cat, "projection"):
		return "📐"
	default:
		return "🔔"
	}
}

// scoreBar renders a compact 10-char progress bar for a health score 0-100.
// e.g. score=75 → "███████░░░"
func scoreBar(score int) string {
	filled := score / 10
	if filled > 10 {
		filled = 10
	}
	return strings.Repeat("█", filled) + strings.Repeat("░", 10-filled)
}

// stripSlackMarkup removes common Slack mrkdwn that would double-render badly
// when re-inserted inside another block (e.g. nested bold).
func stripSlackMarkup(s string) string {
	// Collapse runs of blank lines to at most one.
	lines := strings.Split(s, "\n")
	var out []string
	blank := 0
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			blank++
			if blank <= 1 {
				out = append(out, "")
			}
		} else {
			blank = 0
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
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

func (s *SlackNotifier) postMessage(opts ...slack.MsgOption) error {
	opts = append(opts, slack.MsgOptionDisableLinkUnfurl())
	_, _, err := s.client.PostMessage(s.channelID, opts...)
	if err != nil {
		if rlErr, ok := err.(*slack.RateLimitedError); ok {
			s.logger.Warn("slack rate limited",
				slog.Duration("retry_after", rlErr.RetryAfter))
			return fmt.Errorf("slack rate limited (retry after %s): %w", rlErr.RetryAfter, err)
		}
		s.logger.Error("failed to post slack message",
			slog.String("channel", s.channelID), slog.String("error", err.Error()))
		return fmt.Errorf("slack post message: %w", err)
	}
	return nil
}

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
