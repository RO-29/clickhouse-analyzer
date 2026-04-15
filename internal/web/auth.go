package web

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"log/slog"
)

// ---------------------------------------------------------------------------
// Auth status + login flow
// ---------------------------------------------------------------------------

type authStatusResp struct {
	LoggedIn  bool   `json:"logged_in"`
	Email     string `json:"email,omitempty"`
	Raw       string `json:"raw"`
	Error     string `json:"error,omitempty"`
	CheckedAt string `json:"checked_at"`
}

// GET /api/auth/status — check whether the claude CLI is authenticated.
// Runs `claude auth status` with the service HOME and returns the result.
func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	bin, err := claudeBinary()
	if err != nil {
		writeJSON(w, http.StatusOK, authStatusResp{
			LoggedIn:  false,
			Error:     "Claude CLI not found: " + err.Error(),
			CheckedAt: time.Now().UTC().Format(time.RFC3339),
		})
		return
	}
	home := findClaudeHome()

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, "auth", "status")
	env := os.Environ()
	if home != "" {
		env = setEnv(env, "HOME", home)
	}
	cmd.Env = env

	out, _ := cmd.CombinedOutput()
	raw := strings.TrimSpace(string(out))

	resp := authStatusResp{
		Raw:       raw,
		CheckedAt: time.Now().UTC().Format(time.RFC3339),
	}

	lower := strings.ToLower(raw)
	// Positive: "logged in", "authenticated", email present.
	// Negative: "not logged in", "not authenticated", "no account".
	notAuth := strings.Contains(lower, "not logged in") ||
		strings.Contains(lower, "not authenticated") ||
		strings.Contains(lower, "no account") ||
		strings.Contains(lower, "unauthenticated")
	resp.LoggedIn = !notAuth && raw != ""

	// Try to extract email from the status output.
	for _, line := range strings.Split(raw, "\n") {
		for _, word := range strings.Fields(line) {
			word = strings.Trim(word, "()[].,<>")
			if strings.Contains(word, "@") && strings.Contains(word, ".") {
				resp.Email = word
				break
			}
		}
		if resp.Email != "" {
			break
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// POST /api/auth/login — start the claude.ai OAuth login flow.
//
// Streams output as SSE. The subprocess runs in a background context (not
// tied to r.Context()) so that a transient proxy disconnect or keep-alive
// hiccup doesn't kill the auth process mid-flow.
//
// The BROWSER=/usr/bin/echo trick makes the claude CLI print the OAuth URL
// to stdout instead of trying to open a GUI browser on the headless server.
func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	bin, err := claudeBinary()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "Claude CLI not found: "+err.Error())
		return
	}
	home := findClaudeHome()
	if home == "" {
		home = "/var/lib/ch-analyzer"
		_ = os.MkdirAll(home, 0o755)
	}

	// ── SSE headers ────────────────────────────────────────────────────────
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // nginx: don't buffer SSE
	w.Header().Set("Access-Control-Allow-Origin", "*")
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming not supported")
		return
	}
	sendEvent := func(event, data string) {
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		flusher.Flush()
	}

	// ── Background context — 5 min window, not tied to r.Context() ────────
	// This prevents a proxy timeout or transient browser disconnect from
	// sending SIGKILL to the claude process before the user completes auth.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Cancel if client disconnects AND no URL has been delivered yet.
	// Once the URL is shown the user can complete auth independently, so we
	// keep the process alive even if they close the modal and reopen it.
	urlSent := make(chan struct{})
	go func() {
		select {
		case <-r.Context().Done():
			// Client gone — only kill if no URL sent yet
			select {
			case <-urlSent:
				// URL delivered — let auth complete in background
			default:
				cancel()
			}
		case <-ctx.Done():
		}
	}()

	// ── Build subprocess ────────────────────────────────────────────────────
	cmd := exec.CommandContext(ctx, bin, "auth", "login")
	env := os.Environ()
	env = setEnv(env, "HOME", home)
	// BROWSER=/usr/bin/echo: when claude tries to open the browser, it runs
	// `echo <url>` which prints the URL to its own stdout. That output is
	// captured because exec.Command inherits the subprocess's stdout through
	// the StdoutPipe. Using the full path avoids shell-builtin ambiguity.
	echoPath := "/usr/bin/echo"
	if _, e := os.Stat(echoPath); e != nil {
		echoPath = "echo" // fallback to PATH resolution
	}
	env = setEnv(env, "BROWSER", echoPath)
	env = setEnv(env, "DISPLAY", "")
	env = setEnv(env, "WAYLAND_DISPLAY", "")
	cmd.Env = env

	// Keep stdin open so the process doesn't get SIGPIPE or EOF-triggered exit.
	stdin, _ := cmd.StdinPipe()
	defer stdin.Close()

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		sendEvent("error", jsonStr("Failed to start login: "+err.Error()))
		return
	}
	slog.Info("auth login: started", "home", home, "bin", bin)

	forward := func(line string) {
		line = strings.TrimSpace(line)
		if line == "" {
			return
		}
		// URLs get their own event type for special client rendering.
		if strings.HasPrefix(line, "https://") || strings.HasPrefix(line, "http://") {
			select {
			case <-urlSent:
			default:
				close(urlSent)
			}
			sendEvent("url", jsonStr(line))
		} else {
			sendEvent("output", jsonStr(line))
		}
	}

	stdoutDone := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			forward(scanner.Text())
		}
		close(stdoutDone)
	}()
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			forward(scanner.Text())
		}
	}()

	// ── Heartbeat — keeps SSE connection alive through idle proxies ────────
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				sendEvent("heartbeat", `""`)
			case <-ctx.Done():
				return
			case <-stdoutDone:
				return
			}
		}
	}()

	<-stdoutDone
	if err := cmd.Wait(); err != nil {
		slog.Warn("auth login: process exited with error", "err", err)
		// Send the error to the browser so the user isn't left staring at
		// a spinner. Include the raw error string for diagnostics.
		sendEvent("error", jsonStr("Login process exited: "+err.Error()+
			". SSH into the server and run: HOME=/var/lib/ch-analyzer claude auth login"))
	} else {
		slog.Info("auth login: completed successfully")
		sendEvent("done", `{"success":true}`)
	}
}
