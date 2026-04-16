package slackapp

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
	"github.com/slack-go/slack"
)

// handleSlashCommand routes /ch subcommands.
func (a *App) handleSlashCommand(ctx context.Context, cmd slack.SlashCommand) {
	parts := strings.Fields(strings.TrimSpace(cmd.Text))
	sub := ""
	if len(parts) > 0 {
		sub = strings.ToLower(parts[0])
	}
	args := parts[1:]

	switch sub {
	case "status", "":
		a.cmdStatus(cmd)
	case "alerts":
		instance := ""
		if len(args) > 0 {
			instance = args[0]
		}
		a.cmdAlerts(cmd, instance)
	case "snooze":
		a.cmdSnooze(ctx, cmd, args)
	case "maintenance", "maint":
		instance := ""
		if len(args) > 0 {
			instance = args[0]
		}
		a.cmdMaintenance(ctx, cmd, instance)
	case "analyze", "ai":
		instance := ""
		if len(args) > 0 {
			instance = args[0]
		}
		a.cmdAnalyze(ctx, cmd, instance)
	case "refresh":
		a.cmdRefresh(cmd)
	case "help":
		a.cmdHelp(cmd)
	default:
		a.postEphemeral(cmd.ChannelID, cmd.UserID,
			fmt.Sprintf("Unknown subcommand `%s`. Try `/ch help`.", sub))
	}
}

// cmdStatus posts an ephemeral summary of all instances.
func (a *App) cmdStatus(cmd slack.SlashCommand) {
	instances := a.instanceNames()
	if len(instances) == 0 {
		a.postEphemeral(cmd.ChannelID, cmd.UserID, "No instances configured.")
		return
	}
	sort.Strings(instances)

	var lines []string
	for _, inst := range instances {
		alerts := a.alertMgr.GetActiveAlertsForInstance(inst)
		var crit, warn int
		for _, al := range alerts {
			switch al.Alert.Severity {
			case collector.SeverityCritical:
				crit++
			case collector.SeverityWarn:
				warn++
			}
		}
		emoji, status := instanceStatus(crit, warn)
		if a.maintStore != nil && a.maintStore.GetActiveWindow(inst) != nil {
			emoji = "🔧"
			status = "In Maintenance"
		}
		lines = append(lines, fmt.Sprintf("%s  `%s`  —  %s", emoji, inst, status))
	}

	a.postEphemeral(cmd.ChannelID, cmd.UserID,
		"*CH Monitor — Instance Status*\n\n"+strings.Join(lines, "\n"))
}

// cmdAlerts lists active alerts for one instance (or all if instance=="").
func (a *App) cmdAlerts(cmd slack.SlashCommand, instance string) {
	instances := a.instanceNames()
	if instance != "" {
		if !contains(instances, instance) {
			a.postEphemeral(cmd.ChannelID, cmd.UserID,
				fmt.Sprintf("Unknown instance `%s`. Use `/ch status` to see all.", instance))
			return
		}
		instances = []string{instance}
	}

	var lines []string
	for _, inst := range instances {
		alerts := a.alertMgr.GetActiveAlertsForInstance(inst)
		if len(alerts) == 0 {
			if instance != "" {
				lines = append(lines, fmt.Sprintf("🟢  `%s`  —  No active alerts.", inst))
			}
			continue
		}
		lines = append(lines, fmt.Sprintf("*%s* (%d alert(s))", inst, len(alerts)))
		for _, al := range alerts {
			sev := "⚠️"
			if al.Alert.Severity == collector.SeverityCritical {
				sev = "🚨"
			}
			age := formatDur(time.Since(al.FirstSeen))
			lines = append(lines, fmt.Sprintf("  %s  %s  `%s`", sev, al.Alert.Title, age))
		}
	}

	if len(lines) == 0 {
		a.postEphemeral(cmd.ChannelID, cmd.UserID, "🟢  No active alerts.")
		return
	}
	a.postEphemeral(cmd.ChannelID, cmd.UserID,
		"*Active Alerts*\n\n"+strings.Join(lines, "\n"))
}

// cmdSnooze handles `/ch snooze <instance> <1h|4h|8h>`.
// Without args, opens a modal to pick instance + duration.
func (a *App) cmdSnooze(ctx context.Context, cmd slack.SlashCommand, args []string) {
	if len(args) < 2 {
		// Open picker modal.
		a.openModal(cmd.TriggerID, a.buildSnoozeModal("", a.instanceNames()))
		return
	}

	instance := args[0]
	durationStr := args[1]

	hours, err := parseSnoozeDuration(durationStr)
	if err != nil {
		a.postEphemeral(cmd.ChannelID, cmd.UserID,
			fmt.Sprintf("Invalid duration `%s`. Use `1h`, `4h`, `8h`, or `24h`.", durationStr))
		return
	}

	if err := a.doSnooze(instance, hours, cmd.UserName); err != nil {
		a.postEphemeral(cmd.ChannelID, cmd.UserID,
			fmt.Sprintf("Failed to snooze `%s`: %v", instance, err))
		return
	}

	a.postEphemeral(cmd.ChannelID, cmd.UserID,
		fmt.Sprintf("🔇  Snoozed `%s` for %dh. Use `/ch maintenance` to cancel.", instance, hours))
	go a.UpdatePinned()
}

// cmdMaintenance opens a maintenance modal pre-filled with the given instance.
func (a *App) cmdMaintenance(ctx context.Context, cmd slack.SlashCommand, instance string) {
	a.openModal(cmd.TriggerID, a.buildMaintenanceModal(instance, a.instanceNames()))
}

// cmdAnalyze triggers AI analysis for an instance and posts the result in the channel.
func (a *App) cmdAnalyze(ctx context.Context, cmd slack.SlashCommand, instance string) {
	instances := a.instanceNames()
	if instance == "" && len(instances) > 0 {
		instance = instances[0]
	}
	if instance == "" || !contains(instances, instance) {
		a.postEphemeral(cmd.ChannelID, cmd.UserID,
			fmt.Sprintf("Instance `%s` not found. Usage: `/ch analyze <instance>`.", instance))
		return
	}

	// Post a placeholder, then fill in async.
	ts, err := a.postMessage(cmd.ChannelID, "",
		slack.MsgOptionText(fmt.Sprintf("🔄  Analyzing `%s`…", instance), false),
	)
	if err != nil {
		a.postEphemeral(cmd.ChannelID, cmd.UserID, "Failed to post analysis placeholder.")
		return
	}

	go a.runAnalysis(ctx, cmd.ChannelID, ts, instance)
}

// cmdRefresh forces an immediate pinned dashboard update.
func (a *App) cmdRefresh(cmd slack.SlashCommand) {
	a.UpdatePinned()
	a.postEphemeral(cmd.ChannelID, cmd.UserID, "✅  Dashboard refreshed.")
}

// cmdHelp posts the command reference as an ephemeral message.
func (a *App) cmdHelp(cmd slack.SlashCommand) {
	help := strings.Join([]string{
		"*CH Monitor — Slash Commands*",
		"",
		"`/ch status`  —  All instances + health at a glance",
		"`/ch alerts [instance]`  —  List active alerts (all or one instance)",
		"`/ch snooze <instance> <1h|4h|8h|24h>`  —  Snooze alerts for an instance",
		"`/ch maintenance <instance>`  —  Open maintenance window dialog",
		"`/ch analyze <instance>`  —  Run AI analysis and post result",
		"`/ch refresh`  —  Force-refresh the pinned dashboard",
		"`/ch help`  —  Show this message",
		"",
		"_Tip: click the buttons on the pinned dashboard for quick actions._",
	}, "\n")
	a.postEphemeral(cmd.ChannelID, cmd.UserID, help)
}

// doSnooze creates a maintenance window for the given instance for `hours` hours.
func (a *App) doSnooze(instance string, hours int, createdBy string) error {
	if a.maintStore == nil {
		return fmt.Errorf("maintenance store not available")
	}
	instances := a.instanceNames()
	if !contains(instances, instance) {
		return fmt.Errorf("unknown instance")
	}
	a.maintStore.Add(instance,
		fmt.Sprintf("Snoozed via Slack by @%s", createdBy),
		createdBy,
		time.Duration(hours)*time.Hour,
	)
	return nil
}

// parseSnoozeDuration parses "1h", "4h", "8h", "24h" into hours.
func parseSnoozeDuration(s string) (int, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimSuffix(s, "h")
	h, err := strconv.Atoi(s)
	if err != nil || h <= 0 || h > 168 {
		return 0, fmt.Errorf("invalid duration")
	}
	return h, nil
}

func contains(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}
