// Package slackapp implements Slack Socket Mode integration for ch-analyzer:
// a pinned dashboard message with interactive buttons, and slash commands.
package slackapp

import (
	"context"
	"encoding/json"
	golog "log"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/alerter"
	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
	"github.com/slack-go/slack"
	"github.com/slack-go/slack/socketmode"
)

// slackState is the subset of runtime state that is persisted to disk so that
// a process restart does not lose track of existing Slack message timestamps.
// Losing pinnedTS causes a new pinned dashboard on every restart.
// Losing instanceTS causes escalation notices to post as new messages instead
// of thread replies.
type slackState struct {
	PinnedTS   string            `json:"pinned_ts,omitempty"`
	InstanceTS map[string]string `json:"instance_ts,omitempty"`
}

// App manages the Slack Socket Mode connection, the pinned dashboard message,
// slash commands (/ch ...), and interactive button/modal responses.
type App struct {
	client     *slack.Client
	socket     *socketmode.Client
	cfg        config.SlackConfig
	webAddr    string // e.g. ":8080" — used for local analyze API calls
	alertMgr    *alerter.AlertManager
	maintStore  *alerter.MaintenanceStore
	snoozeStore *alerter.SnoozeStore
	ackStore    *alerter.AckStore
	chMgr       *chclient.Manager

	pinnedTS string
	pinnedMu sync.Mutex

	// debounce prevents stampede when many alerts fire at once
	pendingRefresh chan struct{}

	// actionDebounce prevents button-spam duplicate actions
	actionDebounce sync.Map // key: "userID:actionID:instance", value: time.Time

	// stateFile is the path to the JSON state file for restart persistence.
	// Empty string disables file persistence.
	stateFile string

	logger *slog.Logger
}

// New creates a SlackApp. Call Run to start the Socket Mode event loop.
func New(cfg config.SlackConfig, webAddr string, alertMgr *alerter.AlertManager, maintStore *alerter.MaintenanceStore, snoozeStore *alerter.SnoozeStore, ackStore *alerter.AckStore, chMgr *chclient.Manager) *App {
	client := slack.New(
		cfg.BotToken,
		slack.OptionAppLevelToken(cfg.AppToken),
	)
	stdLogger := golog.New(os.Stderr, "socketmode: ", golog.LstdFlags|golog.Lshortfile)
	// Socket Mode debug logging is very noisy; enable only when explicitly asked
	// via CH_ANALYZER_SLACK_DEBUG rather than flooding production stderr.
	smOpts := []socketmode.Option{socketmode.OptionLog(stdLogger)}
	if os.Getenv("CH_ANALYZER_SLACK_DEBUG") != "" {
		smOpts = append(smOpts, socketmode.OptionDebug(true))
	}
	socket := socketmode.New(client, smOpts...)

	app := &App{
		client:         client,
		socket:         socket,
		cfg:            cfg,
		webAddr:        webAddr,
		alertMgr:       alertMgr,
		maintStore:     maintStore,
		snoozeStore:    snoozeStore,
		ackStore:       ackStore,
		chMgr:          chMgr,
		pendingRefresh: make(chan struct{}, 1),
		stateFile:      cfg.StateFile,
		logger:         slog.Default().With(slog.String("component", "slack-app")),
	}

	if cfg.SigningSecret == "" {
		app.logger.Warn("slack signing_secret is not configured; " +
			"VerifyMiddleware (verify.go) is available for HTTP webhook endpoints " +
			"but will pass all requests through without signature verification — " +
			"set slack.signing_secret in your config if you add HTTP-based endpoints")
	}

	return app
}

// Run starts the Socket Mode WebSocket connection and event loop.
// It registers itself as the alertMgr state-change callback, then blocks until ctx is done.
// If the connection drops (network hiccup, Slack restart, etc.) it reconnects with
// exponential backoff up to 5 minutes between attempts.
func (a *App) Run(ctx context.Context) {
	// Restore pinnedTS and instanceTS from the last run so we don't spawn duplicate
	// pinned messages or lose escalation thread context after a restart.
	a.loadState()

	a.alertMgr.SetOnStateChange(a.scheduleRefresh)
	go a.refreshLoop(ctx)

	// Event consumer goroutine — must be running before RunContext so socket.Events
	// is always drained. Each event dispatched in its own goroutine so the consumer
	// never blocks and the WebSocket ping/pong cycle is never starved.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case evt, ok := <-a.socket.Events:
				if !ok {
					return
				}
				go a.dispatch(ctx, evt)
			}
		}
	}()

	// Post initial pinned dashboard asynchronously.
	go a.UpdatePinned()

	// Reconnect loop with exponential backoff.
	backoff := 5 * time.Second
	const maxBackoff = 5 * time.Minute
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		if attempt > 0 {
			a.logger.Info("slack socket mode reconnecting", "attempt", attempt, "backoff", backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff*2 > maxBackoff {
				backoff = maxBackoff
			} else {
				backoff *= 2
			}
		}
		attempt++
		a.logger.Info("slack socket mode connecting")
		if err := a.socket.RunContext(ctx); err != nil {
			if ctx.Err() != nil {
				return // clean shutdown
			}
			a.logger.Error("slack socket mode disconnected", "error", err, "attempt", attempt)
		} else {
			backoff = 5 * time.Second // reset on clean exit
		}
	}
}

// UpdatePinned rebuilds and posts or updates the pinned dashboard message.
// Safe to call concurrently — protected by pinnedMu.
func (a *App) UpdatePinned() {
	a.postOrUpdatePinned()
}

// scheduleRefresh is called by alertMgr.onStateChange; buffers into pendingRefresh.
func (a *App) scheduleRefresh() {
	select {
	case a.pendingRefresh <- struct{}{}:
	default: // already pending
	}
}

// refreshLoop drains pendingRefresh so rapid alert storms coalesce into one refresh.
func (a *App) refreshLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.pendingRefresh:
			a.UpdatePinned()
		}
	}
}

// dispatch routes a socketmode event to the appropriate handler.
// Called in a goroutine per event — must not share mutable state without locking.
func (a *App) dispatch(ctx context.Context, evt socketmode.Event) {
	switch evt.Type {
	case socketmode.EventTypeConnecting:
		a.logger.Info("socket mode: connecting to Slack")
	case socketmode.EventTypeConnected:
		a.logger.Info("socket mode: connected to Slack")
	case socketmode.EventTypeConnectionError:
		a.logger.Error("socket mode: connection error", "data", evt.Data)
	case socketmode.EventTypeIncomingError:
		a.logger.Warn("socket mode: incoming error", "data", evt.Data)

	case socketmode.EventTypeSlashCommand:
		cmd, ok := evt.Data.(slack.SlashCommand)
		if !ok {
			a.socket.Ack(*evt.Request)
			return
		}
		a.socket.Ack(*evt.Request)
		a.handleSlashCommand(ctx, cmd)

	case socketmode.EventTypeInteractive:
		payload, ok := evt.Data.(slack.InteractionCallback)
		if !ok {
			a.socket.Ack(*evt.Request)
			return
		}
		switch payload.Type {
		case slack.InteractionTypeBlockActions:
			a.socket.Ack(*evt.Request)
			a.handleBlockAction(ctx, payload)
		case slack.InteractionTypeViewSubmission:
			a.socket.Ack(*evt.Request)
			a.handleModalSubmit(ctx, payload)
		default:
			a.socket.Ack(*evt.Request)
		}

	default:
		if evt.Request != nil {
			a.socket.Ack(*evt.Request)
		}
	}
}

// postEphemeral sends a message visible only to the given user.
// Falls back to the configured channel if channelID is empty (modal submissions
// don't carry a channel ID).
func (a *App) postEphemeral(channelID, userID, text string) {
	if channelID == "" {
		channelID = a.cfg.ChannelID
	}
	if _, err := a.client.PostEphemeral(channelID, userID,
		slack.MsgOptionText(text, false),
	); err != nil {
		a.logger.Warn("failed to post ephemeral", "error", err)
	}
}

// postMessage sends a public message to a channel with optional thread_ts.
func (a *App) postMessage(channelID, threadTS string, opts ...slack.MsgOption) (string, error) {
	if threadTS != "" {
		opts = append(opts, slack.MsgOptionTS(threadTS))
	}
	opts = append(opts, slack.MsgOptionDisableLinkUnfurl())
	_, ts, err := a.client.PostMessage(channelID, opts...)
	return ts, err
}

// updateMessage updates an existing message by timestamp.
func (a *App) updateMessage(channelID, ts string, opts ...slack.MsgOption) {
	opts = append(opts, slack.MsgOptionDisableLinkUnfurl())
	if _, _, _, err := a.client.UpdateMessage(channelID, ts, opts...); err != nil {
		a.logger.Warn("failed to update message", "ts", ts, "error", err)
	}
}

// openModal opens a modal using the trigger ID from a slash command or button click.
// If channelID and userID are provided and the open fails, an ephemeral error is sent to the user.
func (a *App) openModal(triggerID string, view slack.ModalViewRequest, channelID, userID string) {
	if _, err := a.client.OpenView(triggerID, view); err != nil {
		a.logger.Warn("failed to open modal", "error", err)
		if channelID != "" && userID != "" {
			a.postEphemeral(channelID, userID, "❌ Could not open the form. Please try again or visit the dashboard.")
		}
	}
}

// instanceNames returns all configured instance names.
func (a *App) instanceNames() []string {
	var names []string
	_ = a.chMgr.ForEach(func(name string, _ *chclient.Client) error {
		names = append(names, name)
		return nil
	})
	return names
}

// ---------------------------------------------------------------------------
// State persistence — survives process restarts
// ---------------------------------------------------------------------------

// loadState reads pinnedTS and instanceTS from the state file (if configured).
// Errors are logged and silently ignored — a missing file is expected on first run.
func (a *App) loadState() {
	if a.stateFile == "" {
		return
	}
	data, err := os.ReadFile(a.stateFile)
	if os.IsNotExist(err) {
		return // first run — no state yet
	}
	if err != nil {
		a.logger.Warn("slack state: failed to read state file", "path", a.stateFile, "error", err)
		return
	}
	var s slackState
	if err := json.Unmarshal(data, &s); err != nil {
		a.logger.Warn("slack state: failed to parse state file", "path", a.stateFile, "error", err)
		return
	}

	a.pinnedMu.Lock()
	if s.PinnedTS != "" {
		a.pinnedTS = s.PinnedTS
	}
	a.pinnedMu.Unlock()

	if len(s.InstanceTS) > 0 {
		a.alertMgr.LoadInstanceTSMap(s.InstanceTS)
	}

	a.logger.Info("slack state: loaded from file",
		"path", a.stateFile,
		"pinned_ts", s.PinnedTS,
		"instance_ts_count", len(s.InstanceTS),
	)
}

// saveState atomically writes pinnedTS and instanceTS to the state file.
// A write failure is logged but never fatal — we lose restart-persistence, not functionality.
func (a *App) saveState() {
	if a.stateFile == "" {
		return
	}

	a.pinnedMu.Lock()
	pinnedTS := a.pinnedTS
	a.pinnedMu.Unlock()

	s := slackState{
		PinnedTS:   pinnedTS,
		InstanceTS: a.alertMgr.GetInstanceTSMap(),
	}
	data, err := json.Marshal(s)
	if err != nil {
		a.logger.Warn("slack state: failed to marshal state", "error", err)
		return
	}

	// Atomic write: write to a temp file then rename so readers never see partial data.
	tmp := a.stateFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		a.logger.Warn("slack state: failed to write temp state file", "path", tmp, "error", err)
		return
	}
	if err := os.Rename(tmp, a.stateFile); err != nil {
		a.logger.Warn("slack state: failed to rename state file", "path", a.stateFile, "error", err)
		_ = os.Remove(tmp)
	}
}
