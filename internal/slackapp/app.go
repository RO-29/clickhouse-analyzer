// Package slackapp implements Slack Socket Mode integration for ch-analyzer:
// a pinned dashboard message with interactive buttons, and slash commands.
package slackapp

import (
	"context"
	golog "log"
	"log/slog"
	"os"
	"sync"

	"github.com/rohitjain/ch-analyzer/internal/alerter"
	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
	"github.com/slack-go/slack"
	"github.com/slack-go/slack/socketmode"
)

// App manages the Slack Socket Mode connection, the pinned dashboard message,
// slash commands (/ch ...), and interactive button/modal responses.
type App struct {
	client     *slack.Client
	socket     *socketmode.Client
	cfg        config.SlackConfig
	webAddr    string // e.g. ":8080" — used for local analyze API calls
	alertMgr   *alerter.AlertManager
	maintStore *alerter.MaintenanceStore
	chMgr      *chclient.Manager

	pinnedTS string
	pinnedMu sync.Mutex

	// debounce prevents stampede when many alerts fire at once
	pendingRefresh chan struct{}

	logger *slog.Logger
}

// New creates a SlackApp. Call Run to start the Socket Mode event loop.
func New(cfg config.SlackConfig, webAddr string, alertMgr *alerter.AlertManager, maintStore *alerter.MaintenanceStore, chMgr *chclient.Manager) *App {
	client := slack.New(
		cfg.BotToken,
		slack.OptionAppLevelToken(cfg.AppToken),
	)
	stdLogger := golog.New(os.Stderr, "socketmode: ", golog.LstdFlags|golog.Lshortfile)
	socket := socketmode.New(client,
		socketmode.OptionDebug(true),
		socketmode.OptionLog(stdLogger),
	)

	app := &App{
		client:         client,
		socket:         socket,
		cfg:            cfg,
		webAddr:        webAddr,
		alertMgr:       alertMgr,
		maintStore:     maintStore,
		chMgr:          chMgr,
		pendingRefresh: make(chan struct{}, 1),
		logger:         slog.Default().With(slog.String("component", "slack-app")),
	}

	if cfg.SigningSecret == "" {
		app.logger.Warn("slack signing_secret is not configured; " +
			"HTTP-based Slack endpoints will not verify request signatures — " +
			"set slack.signing_secret in your config to enable verification")
	}

	return app
}

// Run starts the Socket Mode WebSocket connection and event loop.
// It registers itself as the alertMgr state-change callback, then blocks until ctx is done.
func (a *App) Run(ctx context.Context) {
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

	// RunContext blocks here until ctx is cancelled. It manages the WebSocket
	// connection, reconnecting automatically on disconnect.
	a.logger.Info("socket mode connecting to Slack WebSocket")
	if err := a.socket.RunContext(ctx); err != nil && ctx.Err() == nil {
		a.logger.Error("socket mode RunContext failed", "error", err)
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
func (a *App) openModal(triggerID string, view slack.ModalViewRequest) {
	if _, err := a.client.OpenView(triggerID, view); err != nil {
		a.logger.Warn("failed to open modal", "error", err)
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
