package slackapp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/slack-go/slack"
)

// ---------------------------------------------------------------------------
// Block action handler (button clicks on the pinned dashboard)
// ---------------------------------------------------------------------------

func (a *App) handleBlockAction(ctx context.Context, payload slack.InteractionCallback) {
	if len(payload.ActionCallback.BlockActions) == 0 {
		return
	}
	action := payload.ActionCallback.BlockActions[0]
	instance := action.Value // buttons carry the instance name as Value
	userID := payload.User.ID
	userName := payload.User.Name
	channelID := payload.Channel.ID

	// Debounce: ignore rapid re-clicks of the same button by the same user.
	debounceKey := userID + ":" + action.ActionID + ":" + instance
	if last, ok := a.actionDebounce.Load(debounceKey); ok {
		if time.Since(last.(time.Time)) < 3*time.Second {
			return // ignore rapid re-click
		}
	}
	a.actionDebounce.Store(debounceKey, time.Now())

	if instance != "" {
		known := false
		for _, n := range a.chMgr.Names() {
			if n == instance {
				known = true
				break
			}
		}
		if !known {
			a.postEphemeral(channelID, payload.User.ID, fmt.Sprintf("❌ Instance `%s` is no longer configured.", instance))
			return
		}
	}

	switch action.ActionID {
	case "ch_snooze_1h":
		a.handleSnoozeAction(channelID, userID, userName, instance, 1)
	case "ch_snooze_4h":
		a.handleSnoozeAction(channelID, userID, userName, instance, 4)
	case "ch_snooze_8h":
		a.handleSnoozeAction(channelID, userID, userName, instance, 8)
	case "ch_analyze":
		a.handleAnalyzeAction(ctx, channelID, instance)
	case "ch_maintenance_open":
		a.openModal(payload.TriggerID, a.buildMaintenanceModal(instance, a.instanceNames()), channelID, userID)
	case "ch_refresh":
		a.UpdatePinned()
		a.postEphemeral(channelID, userID, "✅  Dashboard refreshed.")
	default:
		a.logger.Warn("unrecognized slack action", "action_id", action.ActionID, "value", action.Value)
	}
}

func (a *App) handleSnoozeAction(channelID, userID, userName, instance string, hours int) {
	if err := a.doSnooze(instance, hours, userName); err != nil {
		a.postEphemeral(channelID, userID,
			fmt.Sprintf("❌  Failed to snooze `%s`: %v", instance, err))
		return
	}
	a.postEphemeral(channelID, userID,
		fmt.Sprintf("🔇  Snoozed `%s` for %dh. Alerts suppressed until %s.",
			instance, hours,
			time.Now().Add(time.Duration(hours)*time.Hour).UTC().Format("15:04 UTC"),
		))
	go a.UpdatePinned()
}

func (a *App) handleAnalyzeAction(ctx context.Context, channelID, instance string) {
	// Post placeholder in the channel, then fill async.
	ts, err := a.postMessage(channelID, "",
		slack.MsgOptionText(fmt.Sprintf("🔄  Analyzing `%s`…", instance), false),
	)
	if err != nil {
		if strings.Contains(err.Error(), "missing_scope") {
			a.logger.Error("slack bot token missing 'chat:write' scope — re-install app with chat:write scope to enable channel messages", "error", err)
		} else {
			a.logger.Warn("failed to post analysis placeholder", "error", err)
		}
		return
	}
	go a.runAnalysis(ctx, channelID, ts, instance)
}

// ---------------------------------------------------------------------------
// Modal submit handler
// ---------------------------------------------------------------------------

func (a *App) handleModalSubmit(ctx context.Context, payload slack.InteractionCallback) {
	switch payload.View.CallbackID {
	case "ch_maintenance_modal":
		a.submitMaintenance(payload)
	case "ch_snooze_modal":
		a.submitSnooze(payload)
	}
}

// ---------------------------------------------------------------------------
// Maintenance modal
// ---------------------------------------------------------------------------

func (a *App) buildMaintenanceModal(preselectedInstance string, instances []string) slack.ModalViewRequest {
	// Instance select options.
	var opts []*slack.OptionBlockObject
	for _, inst := range instances {
		opts = append(opts, slack.NewOptionBlockObject(inst,
			slack.NewTextBlockObject(slack.PlainTextType, inst, false, false), nil))
	}

	// Duration options.
	durations := []struct{ value, label string }{
		{"30", "30 minutes"},
		{"60", "1 hour"},
		{"120", "2 hours"},
		{"240", "4 hours"},
		{"480", "8 hours"},
		{"1440", "24 hours"},
	}
	var durOpts []*slack.OptionBlockObject
	for _, d := range durations {
		durOpts = append(durOpts, slack.NewOptionBlockObject(d.value,
			slack.NewTextBlockObject(slack.PlainTextType, d.label, false, false), nil))
	}

	var initialOption *slack.OptionBlockObject
	if preselectedInstance != "" {
		initialOption = slack.NewOptionBlockObject(preselectedInstance,
			slack.NewTextBlockObject(slack.PlainTextType, preselectedInstance, false, false), nil)
	}

	instanceSelect := slack.NewOptionsSelectBlockElement(
		slack.OptTypeStatic,
		slack.NewTextBlockObject(slack.PlainTextType, "Choose instance…", false, false),
		"instance",
		opts...,
	)
	if initialOption != nil {
		instanceSelect.InitialOption = initialOption
	}

	durationSelect := slack.NewOptionsSelectBlockElement(
		slack.OptTypeStatic,
		slack.NewTextBlockObject(slack.PlainTextType, "Duration…", false, false),
		"duration",
		durOpts...,
	)
	durationSelect.InitialOption = durOpts[1] // default: 1 hour

	return slack.ModalViewRequest{
		Type:            slack.VTModal,
		CallbackID:      "ch_maintenance_modal",
		Title:           slack.NewTextBlockObject(slack.PlainTextType, "Maintenance Window", false, false),
		Submit:          slack.NewTextBlockObject(slack.PlainTextType, "Start Maintenance", false, false),
		Close:           slack.NewTextBlockObject(slack.PlainTextType, "Cancel", false, false),
		Blocks: slack.Blocks{BlockSet: []slack.Block{
			slack.NewSectionBlock(
				slack.NewTextBlockObject(slack.MarkdownType, "Suppress all alerts for an instance during planned maintenance.", false, false),
				nil, nil,
			),
			slack.NewInputBlock("block_instance",
				slack.NewTextBlockObject(slack.PlainTextType, "Instance", false, false),
				nil,
				instanceSelect,
			),
			slack.NewInputBlock("block_duration",
				slack.NewTextBlockObject(slack.PlainTextType, "Duration", false, false),
				nil,
				durationSelect,
			),
			slack.NewInputBlock("block_reason",
				slack.NewTextBlockObject(slack.PlainTextType, "Reason", false, false),
				slack.NewTextBlockObject(slack.PlainTextType, "Optional — e.g. planned upgrade, schema migration", false, false),
				slack.NewPlainTextInputBlockElement(
					slack.NewTextBlockObject(slack.PlainTextType, "Reason…", false, false),
					"reason",
				),
			),
		}},
	}
}

func (a *App) submitMaintenance(payload slack.InteractionCallback) {
	vals := payload.View.State.Values
	// Modal submissions don't carry payload.Channel.ID — use configured channel.
	channelID := a.cfg.ChannelID

	instance := ""
	if v, ok := vals["block_instance"]["instance"]; ok && v.SelectedOption.Value != "" {
		instance = v.SelectedOption.Value
	}
	durationStr := "60"
	if v, ok := vals["block_duration"]["duration"]; ok && v.SelectedOption.Value != "" {
		durationStr = v.SelectedOption.Value
	}
	reason := ""
	if v, ok := vals["block_reason"]["reason"]; ok {
		reason = strings.TrimSpace(v.Value)
	}

	if instance == "" {
		a.postEphemeral(channelID, payload.User.ID, "❌  No instance selected.")
		return
	}

	var mins int
	fmt.Sscanf(durationStr, "%d", &mins)
	if mins <= 0 {
		mins = 60
	}

	if reason == "" {
		reason = fmt.Sprintf("Maintenance via Slack by @%s", payload.User.Name)
	}

	if a.maintStore == nil {
		a.postEphemeral(channelID, payload.User.ID, "❌  Maintenance store unavailable.")
		return
	}

	win := a.maintStore.Add(instance, reason, payload.User.Name, time.Duration(mins)*time.Minute)

	a.postEphemeral(channelID, payload.User.ID,
		fmt.Sprintf("🔧  Maintenance window started for `%s` until %s.\nReason: %s",
			instance,
			time.Unix(win.EndTime, 0).UTC().Format("15:04 UTC"),
			reason,
		))
	go a.UpdatePinned()
}

// ---------------------------------------------------------------------------
// Snooze modal (used by /ch snooze without args)
// ---------------------------------------------------------------------------

func (a *App) buildSnoozeModal(preselectedInstance string, instances []string) slack.ModalViewRequest {
	var opts []*slack.OptionBlockObject
	for _, inst := range instances {
		opts = append(opts, slack.NewOptionBlockObject(inst,
			slack.NewTextBlockObject(slack.PlainTextType, inst, false, false), nil))
	}

	durOpts := []*slack.OptionBlockObject{
		slack.NewOptionBlockObject("1", slack.NewTextBlockObject(slack.PlainTextType, "1 hour", false, false), nil),
		slack.NewOptionBlockObject("4", slack.NewTextBlockObject(slack.PlainTextType, "4 hours", false, false), nil),
		slack.NewOptionBlockObject("8", slack.NewTextBlockObject(slack.PlainTextType, "8 hours", false, false), nil),
		slack.NewOptionBlockObject("24", slack.NewTextBlockObject(slack.PlainTextType, "24 hours", false, false), nil),
	}

	instanceSelect := slack.NewOptionsSelectBlockElement(
		slack.OptTypeStatic,
		slack.NewTextBlockObject(slack.PlainTextType, "Choose instance…", false, false),
		"instance",
		opts...,
	)
	if preselectedInstance != "" {
		instanceSelect.InitialOption = slack.NewOptionBlockObject(preselectedInstance,
			slack.NewTextBlockObject(slack.PlainTextType, preselectedInstance, false, false), nil)
	}

	durationSelect := slack.NewOptionsSelectBlockElement(
		slack.OptTypeStatic,
		slack.NewTextBlockObject(slack.PlainTextType, "Duration…", false, false),
		"duration",
		durOpts...,
	)
	durationSelect.InitialOption = durOpts[0]

	return slack.ModalViewRequest{
		Type:       slack.VTModal,
		CallbackID: "ch_snooze_modal",
		Title:      slack.NewTextBlockObject(slack.PlainTextType, "Snooze Alerts", false, false),
		Submit:     slack.NewTextBlockObject(slack.PlainTextType, "Snooze", false, false),
		Close:      slack.NewTextBlockObject(slack.PlainTextType, "Cancel", false, false),
		Blocks: slack.Blocks{BlockSet: []slack.Block{
			slack.NewInputBlock("block_instance",
				slack.NewTextBlockObject(slack.PlainTextType, "Instance", false, false),
				nil,
				instanceSelect,
			),
			slack.NewInputBlock("block_duration",
				slack.NewTextBlockObject(slack.PlainTextType, "Duration", false, false),
				nil,
				durationSelect,
			),
		}},
	}
}

func (a *App) submitSnooze(payload slack.InteractionCallback) {
	vals := payload.View.State.Values
	// Modal submissions don't carry payload.Channel.ID — use configured channel.
	channelID := a.cfg.ChannelID

	instance := ""
	if v, ok := vals["block_instance"]["instance"]; ok {
		if v.SelectedOption.Value == "" {
			// alert was resolved between button click and submit
			// respond to Slack with a message that the alert is no longer active
			a.postEphemeral(channelID, payload.User.ID, "❌  No instance selected (the alert may no longer be active).")
			return
		}
		instance = v.SelectedOption.Value
	}
	hours := 1
	if v, ok := vals["block_duration"]["duration"]; ok {
		if v.SelectedOption.Value != "" {
			fmt.Sscanf(v.SelectedOption.Value, "%d", &hours)
		}
	}

	if instance == "" {
		a.postEphemeral(channelID, payload.User.ID, "❌  No instance selected.")
		return
	}
	if err := a.doSnooze(instance, hours, payload.User.Name); err != nil {
		a.postEphemeral(channelID, payload.User.ID,
			fmt.Sprintf("❌  Failed to snooze `%s`: %v", instance, err))
		return
	}
	a.postEphemeral(channelID, payload.User.ID,
		fmt.Sprintf("🔇  Snoozed `%s` for %dh.", instance, hours))
	go a.UpdatePinned()
}

// ---------------------------------------------------------------------------
// AI analysis — streams SSE from the local analyze API, posts result to Slack
// ---------------------------------------------------------------------------

func (a *App) runAnalysis(ctx context.Context, channelID, msgTS, instance string) {
	defer func() {
		if r := recover(); r != nil {
			a.logger.Error("analysis panic", "error", r)
		}
	}()

	listenAddr := a.webAddr
	if strings.HasPrefix(listenAddr, ":") {
		listenAddr = "localhost" + listenAddr
	}
	url := fmt.Sprintf("http://%s/api/instances/%s/analyze", listenAddr, instance)

	body, _ := json.Marshal(map[string]interface{}{
		"time_window_mins": 60,
		"mode":             "full",
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		a.updateAnalysisMessage(channelID, msgTS, instance, "❌  Failed to create analysis request.")
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		a.updateAnalysisMessage(channelID, msgTS, instance, "❌  Failed to reach analysis API.")
		return
	}
	defer resp.Body.Close()

	// Collect SSE text chunks. The analyze endpoint sends:
	//   event: chunk\ndata: "json-encoded string"\n\n
	// Only "chunk" events carry text; "status"/"debug"/"stderr" are skipped.
	var result strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	var currentEvent string
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			currentEvent = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: ") && currentEvent == "chunk":
			raw := strings.TrimPrefix(line, "data: ")
			var text string
			if err := json.Unmarshal([]byte(raw), &text); err == nil {
				result.WriteString(text)
			}
		case line == "":
			currentEvent = ""
		}
	}

	text := strings.TrimSpace(result.String())
	if text == "" {
		text = "_Analysis returned no output._"
	}
	// Truncate to Slack's 3000-char block limit.
	if len(text) > 2900 {
		suffix := "\n\n_[truncated]_"
		if a.cfg.DashboardURL != "" {
			suffix = fmt.Sprintf("\n\n_[truncated — <%s|view full result>]_", a.cfg.DashboardURL)
		}
		text = text[:2900] + suffix
	}

	a.updateAnalysisMessage(channelID, msgTS, instance, text)
}

func (a *App) updateAnalysisMessage(channelID, msgTS, instance, text string) {
	header := fmt.Sprintf("*🤖  AI Analysis — `%s`*\n\n", instance)
	if a.cfg.DashboardURL != "" {
		header += fmt.Sprintf("_<%s|View in Dashboard>_\n\n", a.cfg.DashboardURL)
	}

	a.updateMessage(channelID, msgTS,
		slack.MsgOptionText(header+text, false),
	)
}
