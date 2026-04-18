package slackapp

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/alerter"
	"github.com/rohitjain/ch-analyzer/internal/collector"
	"github.com/slack-go/slack"
)

// postOrUpdatePinned posts a new pinned dashboard or updates the existing one.
func (a *App) postOrUpdatePinned() {
	blocks := a.buildDashboardBlocks()

	a.pinnedMu.Lock()
	defer a.pinnedMu.Unlock()

	if a.pinnedTS == "" {
		// First post — send, then pin.
		_, ts, err := a.client.PostMessage(a.cfg.ChannelID,
			slack.MsgOptionBlocks(blocks...),
			slack.MsgOptionText("CH Monitor — Live Dashboard", false),
			slack.MsgOptionDisableLinkUnfurl(),
		)
		if err != nil {
			a.logger.Error("failed to post pinned dashboard", "error", err)
			return
		}
		a.pinnedTS = ts
		if err := a.client.AddPin(a.cfg.ChannelID, slack.ItemRef{Channel: a.cfg.ChannelID, Timestamp: ts}); err != nil {
			if strings.Contains(err.Error(), "missing_scope") {
				a.logger.Error("slack bot token missing 'pins:write' scope — re-install app with pins:write scope to enable pinned dashboard", "error", err)
			} else {
				a.logger.Warn("failed to pin dashboard message", "error", err)
			}
		}
		a.logger.Info("pinned dashboard posted", slog.String("ts", ts))
		return
	}

	// Update in-place.
	if _, _, _, err := a.client.UpdateMessage(a.cfg.ChannelID, a.pinnedTS,
		slack.MsgOptionBlocks(blocks...),
		slack.MsgOptionText("CH Monitor — Live Dashboard", false),
		slack.MsgOptionDisableLinkUnfurl(),
	); err != nil {
		a.logger.Warn("pinned message update failed, will repost", "error", err)
		// Message may have been deleted — clear TS so next call reposts.
		a.pinnedTS = ""
	}
}

// buildDashboardBlocks constructs the full Block Kit layout for the pinned message.
func (a *App) buildDashboardBlocks() []slack.Block {
	instances := a.instanceNames()
	sort.Strings(instances)

	blocks := []slack.Block{
		slack.NewHeaderBlock(
			slack.NewTextBlockObject(slack.PlainTextType, "🖥️  CH Monitor — Live Dashboard", false, false),
		),
		slack.NewDividerBlock(),
	}

	if len(instances) == 0 {
		blocks = append(blocks, slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, "_No instances configured._", false, false),
			nil, nil,
		))
	}

	for _, inst := range instances {
		blocks = append(blocks, a.buildInstanceRows(inst)...)
		blocks = append(blocks, slack.NewDividerBlock())
	}

	// Footer with timestamp and refresh button.
	updatedText := fmt.Sprintf("Updated %s", time.Now().UTC().Format("15:04:05 UTC"))
	blocks = append(blocks,
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("_%s_", updatedText), false, false),
			nil,
			slack.NewAccessory(slack.NewButtonBlockElement(
				"ch_refresh", "refresh",
				slack.NewTextBlockObject(slack.PlainTextType, "🔄 Refresh", false, false),
			)),
		),
	)

	return blocks
}

// buildInstanceRows returns the Block Kit rows for one instance:
// a status line and an actions row with buttons.
func (a *App) buildInstanceRows(instance string) []slack.Block {
	alerts := a.alertMgr.GetActiveAlertsForInstance(instance)

	// Count severities.
	var critCount, warnCount int
	for _, al := range alerts {
		switch al.Alert.Severity {
		case collector.SeverityCritical:
			critCount++
		case collector.SeverityWarn:
			warnCount++
		}
	}

	// Status line.
	emoji, statusText := instanceStatus(critCount, warnCount)
	inMaint := a.maintStore != nil && a.maintStore.GetActiveWindow(instance) != nil
	if inMaint {
		emoji = "🔧"
		statusText = "In Maintenance"
	}

	headerText := fmt.Sprintf("%s  *%s*  ·  %s", emoji, escMD(instance), statusText)
	if len(alerts) > 0 {
		oldest := oldestAlert(alerts)
		headerText += fmt.Sprintf("  ·  firing %s", formatDur(time.Since(oldest.FirstSeen)))
	}

	rows := []slack.Block{
		slack.NewSectionBlock(
			slack.NewTextBlockObject(slack.MarkdownType, headerText, false, false),
			nil, nil,
		),
	}

	// Action buttons row — max 5 per actions block.
	var btns []slack.BlockElement

	if len(alerts) > 0 && !inMaint {
		btns = append(btns,
			dangerButton("ch_snooze_1h", instance, "Snooze 1h"),
			dangerButton("ch_snooze_4h", instance, "Snooze 4h"),
			dangerButton("ch_snooze_8h", instance, "Snooze 8h"),
		)
	}

	btns = append(btns, primaryButton("ch_analyze", instance, "Analyze AI"))
	btns = append(btns, defaultButton("ch_maintenance_open", instance, "Maintenance"))

	rows = append(rows, slack.NewActionBlock("actions_"+instance, btns...))

	return rows
}

// instanceStatus returns the status emoji and text for an instance.
func instanceStatus(crit, warn int) (emoji, text string) {
	switch {
	case crit > 0:
		parts := fmt.Sprintf("%d critical", crit)
		if warn > 0 {
			parts += fmt.Sprintf("  ·  %d warning", warn)
		}
		return "🔴", parts
	case warn > 0:
		return "🟡", fmt.Sprintf("%d warning", warn)
	default:
		return "🟢", "Healthy"
	}
}

func oldestAlert(alerts []*alerter.ActiveAlert) *alerter.ActiveAlert {
	oldest := alerts[0]
	for _, a := range alerts[1:] {
		if a.FirstSeen.Before(oldest.FirstSeen) {
			oldest = a
		}
	}
	return oldest
}

func formatDur(d time.Duration) string {
	d = d.Round(time.Minute)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if h > 0 {
		return fmt.Sprintf("%dh %dm", h, m)
	}
	return fmt.Sprintf("%dm", m)
}

func escMD(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

// Button helpers.

func primaryButton(actionID, value, label string) *slack.ButtonBlockElement {
	btn := slack.NewButtonBlockElement(actionID, value,
		slack.NewTextBlockObject(slack.PlainTextType, label, false, false),
	)
	btn.Style = slack.StylePrimary
	return btn
}

func dangerButton(actionID, value, label string) *slack.ButtonBlockElement {
	btn := slack.NewButtonBlockElement(actionID, value,
		slack.NewTextBlockObject(slack.PlainTextType, label, false, false),
	)
	btn.Style = slack.StyleDanger
	return btn
}

func defaultButton(actionID, value, label string) *slack.ButtonBlockElement {
	return slack.NewButtonBlockElement(actionID, value,
		slack.NewTextBlockObject(slack.PlainTextType, label, false, false),
	)
}
