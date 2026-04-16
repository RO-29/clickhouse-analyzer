package web

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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

// POST /api/auth/callback — complete the OAuth flow by feeding the callback URL
// back to the claude process.
//
// Two cases:
//
//  1. localhost URL (http://localhost:PORT/callback?code=…): the user's browser
//     tried to redirect there but got "connection refused" because PORT is on the
//     server, not the user's machine. We proxy the GET from the server side.
//
//  2. platform.claude.com URL (https://platform.claude.com/oauth/code/callback?code=…):
//     Claude's newer auth flow redirects the browser here. The page tries to relay
//     the code back to the local claude process; on a remote server that relay fails.
//     We write the full URL to the claude process's stdin so it can complete the
//     token exchange itself (the claude CLI reads the callback URL from stdin when
//     running headlessly).
func (s *Server) handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.URL) == "" {
		writeErr(w, http.StatusBadRequest, "missing url")
		return
	}
	callbackURL := strings.TrimSpace(req.URL)
	parsed, err := url.Parse(callbackURL)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid url: "+err.Error())
		return
	}

	host := parsed.Hostname()
	switch {
	case host == "localhost" || host == "127.0.0.1":
		// Proxy the GET request directly to the local claude auth server.
		resp, err := http.Get(callbackURL) //nolint:noctx
		if err != nil {
			writeErr(w, http.StatusBadGateway, "callback forward failed: "+err.Error()+
				" — make sure the login flow is still running")
			return
		}
		defer resp.Body.Close()
		slog.Info("auth callback forwarded to localhost", "status", resp.StatusCode)
		writeJSON(w, http.StatusOK, map[string]string{"status": "forwarded", "http_status": fmt.Sprint(resp.StatusCode)})

	case host == "platform.claude.com":
		// Write the full callback URL to the claude process's stdin.
		// The claude CLI reads the callback URL from stdin when running headlessly
		// (no real browser). This lets it complete the PKCE token exchange.
		s.authStdinMu.Lock()
		stdin := s.authStdin
		s.authStdinMu.Unlock()
		if stdin == nil {
			writeErr(w, http.StatusConflict, "no active login session — open the re-auth modal and start the flow first")
			return
		}
		if _, err := fmt.Fprintln(stdin, callbackURL); err != nil {
			writeErr(w, http.StatusInternalServerError, "failed to send callback to claude: "+err.Error())
			return
		}
		slog.Info("auth callback written to stdin", "host", host)
		writeJSON(w, http.StatusOK, map[string]string{"status": "sent_to_stdin"})

	default:
		writeErr(w, http.StatusBadRequest, "url must be a localhost or platform.claude.com callback URL")
	}
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
	// Also store it so handleAuthCallback can feed the OAuth callback URL back.
	stdin, _ := cmd.StdinPipe()
	s.authStdinMu.Lock()
	s.authStdin = stdin
	s.authStdinMu.Unlock()
	defer func() {
		stdin.Close()
		s.authStdinMu.Lock()
		s.authStdin = nil
		s.authStdinMu.Unlock()
	}()

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
		// Claude sometimes prints "If the browser didn't open, visit: https://..."
		// so we check each whitespace-delimited token for a URL, not just line prefix.
		var extractedURL string
		if strings.HasPrefix(line, "https://") || strings.HasPrefix(line, "http://") {
			extractedURL = line
		} else {
			for _, tok := range strings.Fields(line) {
				if strings.HasPrefix(tok, "https://") || strings.HasPrefix(tok, "http://") {
					extractedURL = tok
					break
				}
			}
		}
		if extractedURL != "" {
			select {
			case <-urlSent:
			default:
				close(urlSent)
			}
			sendEvent("url", jsonStr(extractedURL))
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
