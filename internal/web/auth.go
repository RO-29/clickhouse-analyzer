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
// Streams output as SSE so the browser can display the login URL the user
// must open. Uses BROWSER=echo so the CLI prints the URL instead of
// trying to launch a GUI browser (which doesn't exist on a headless server).
func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	bin, err := claudeBinary()
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "Claude CLI not found: "+err.Error())
		return
	}
	home := findClaudeHome()
	if home == "" {
		// Default service state directory.
		home = "/var/lib/ch-analyzer"
		_ = os.MkdirAll(home, 0o755)
	}

	// Set up SSE.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
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

	// 3-minute window — user needs to open the URL and complete the flow.
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, "auth", "login")
	env := os.Environ()
	env = setEnv(env, "HOME", home)
	// BROWSER=echo: makes xdg-open/open print the URL to stdout instead of
	// launching a GUI browser — this is the headless-server trick.
	env = setEnv(env, "BROWSER", "echo")
	// Clear display variables so no GUI can launch.
	env = setEnv(env, "DISPLAY", "")
	env = setEnv(env, "WAYLAND_DISPLAY", "")
	cmd.Env = env

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

	<-stdoutDone
	if err := cmd.Wait(); err != nil {
		slog.Warn("auth login: process exited with error", "err", err)
	} else {
		slog.Info("auth login: completed successfully")
		sendEvent("done", `{"success":true}`)
	}
}
