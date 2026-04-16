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
	"regexp"
	"strconv"
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

// POST /api/auth/callback — complete the OAuth flow by proxying the callback
// to claude's local HTTP server.
//
// Claude starts a local HTTP server on a random port and waits for a GET to
// /callback?code=…&state=… to complete the PKCE exchange. The browser can't
// reach that port on a remote server, so the user pastes the redirect URL here
// and we proxy it from the server side.
//
// Accepts either:
//   - A localhost URL  (http://localhost:PORT/callback?code=…&state=…)
//   - A platform URL  (https://platform.claude.com/oauth/code/callback?code=…&state=…)
//     or a bare OAuth code — in both cases we find claude's listening port via
//     ss/lsof and reconstruct the localhost callback URL ourselves.
func (s *Server) handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.URL) == "" {
		writeErr(w, http.StatusBadRequest, "missing url")
		return
	}
	raw := strings.TrimSpace(req.URL)

	// Extract code + state regardless of whether we got a full URL or bare code.
	code, state := extractCodeState(raw)
	if code == "" {
		writeErr(w, http.StatusBadRequest, "could not find OAuth code in the provided value")
		return
	}

	// If the caller already gave us a localhost URL, proxy it directly.
	if strings.HasPrefix(raw, "http://localhost") || strings.HasPrefix(raw, "http://127.0.0.1") {
		s.proxyLocalCallback(w, raw)
		return
	}

	// For platform.claude.com URLs or bare codes we use two strategies:
	//
	// Strategy A — follow platform redirect.
	// platform.claude.com knows the exact localhost URL (port AND path) from the
	// state parameter. If it issues an HTTP redirect, Go follows it to claude's
	// local server automatically — no guessing needed.
	//
	// Strategy B — port scan fallback.
	// If platform uses a JS redirect (browser-only), we find claude's listening
	// port via ss/lsof and build the localhost URL ourselves.

	// ── Strategy A: follow platform.claude.com redirect ──────────────────────
	if strings.Contains(raw, "platform.claude.com") {
		var localURLHit string
		client := &http.Client{
			Timeout: 12 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				h := req.URL.Hostname()
				if (h == "localhost" || h == "127.0.0.1") && localURLHit == "" {
					localURLHit = req.URL.String()
				}
				if len(via) > 10 {
					return http.ErrUseLastResponse
				}
				return nil
			},
		}
		resp, err := client.Get(raw) //nolint:noctx
		if err == nil {
			resp.Body.Close()
		}
		if localURLHit != "" {
			slog.Info("auth callback: platform redirect followed to localhost", "url", localURLHit)
			// Already proxied by following the redirect — just confirm to client.
			writeJSON(w, http.StatusOK, map[string]string{"status": "forwarded", "via": "platform_redirect"})
			return
		}
		slog.Info("auth callback: platform did not HTTP-redirect to localhost — falling back to port scan")
	}

	// ── Strategy B: find claude's local port and build the URL ───────────────
	s.authStdinMu.Lock()
	pid := s.authPid
	s.authStdinMu.Unlock()

	if pid == 0 {
		writeErr(w, http.StatusConflict, "no active login session — open the re-auth modal and start the flow first")
		return
	}

	port, err := findListeningPort(pid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not find claude's local callback port: "+err.Error())
		return
	}

	localURL := fmt.Sprintf("http://localhost:%d/callback?code=%s&state=%s",
		port, url.QueryEscape(code), url.QueryEscape(state))
	slog.Info("auth callback: proxying to local port", "pid", pid, "port", port, "code_len", len(code))
	s.proxyLocalCallback(w, localURL)
}

func (s *Server) proxyLocalCallback(w http.ResponseWriter, localURL string) {
	resp, err := http.Get(localURL) //nolint:noctx
	if err != nil {
		writeErr(w, http.StatusBadGateway, "callback forward failed: "+err.Error())
		return
	}
	defer resp.Body.Close()
	slog.Info("auth callback forwarded", "status", resp.StatusCode, "url", localURL)
	writeJSON(w, http.StatusOK, map[string]string{"status": "forwarded", "http_status": fmt.Sprint(resp.StatusCode)})
}

// extractCodeState parses code and state from a URL or returns the raw string
// as code if it looks like a bare OAuth code (no slashes).
func extractCodeState(raw string) (code, state string) {
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err == nil {
			code = u.Query().Get("code")
			state = u.Query().Get("state")
			return
		}
	}
	// Bare code — no slashes, no spaces, looks like a token.
	if !strings.Contains(raw, "/") && !strings.Contains(raw, " ") {
		code = raw
	}
	return
}

// findListeningPort returns the TCP port the given process is listening on.
// Tries ss (Linux) then lsof (macOS/Linux).
func findListeningPort(pid int) (int, error) {
	pidStr := strconv.Itoa(pid)

	// ── ss (Linux) ──────────────────────────────────────────────────────────
	if out, err := exec.Command("ss", "-tlnpH").Output(); err == nil {
		needle := fmt.Sprintf("pid=%d,", pid)
		rePort := regexp.MustCompile(`:(\d+)\s`)
		for _, line := range strings.Split(string(out), "\n") {
			if !strings.Contains(line, needle) {
				continue
			}
			if m := rePort.FindStringSubmatch(line); m != nil {
				if p, err := strconv.Atoi(m[1]); err == nil && p > 1024 {
					return p, nil
				}
			}
		}
	}

	// ── lsof (macOS / fallback) ─────────────────────────────────────────────
	if out, err := exec.Command("lsof", "-p", pidStr, "-i", "4TCP", "-n", "-P").Output(); err == nil {
		rePort := regexp.MustCompile(`\*:(\d+)\s+\(LISTEN\)|:(\d+)\s+\(LISTEN\)`)
		for _, line := range strings.Split(string(out), "\n") {
			if m := rePort.FindStringSubmatch(line); m != nil {
				s := m[1]
				if s == "" {
					s = m[2]
				}
				if p, err := strconv.Atoi(s); err == nil && p > 1024 {
					return p, nil
				}
			}
		}
	}

	return 0, fmt.Errorf("ss and lsof found no listening port for pid %d", pid)
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
	s.authPid = 0 // will be set after Start()
	s.authStdinMu.Unlock()
	defer func() {
		stdin.Close()
		s.authStdinMu.Lock()
		s.authStdin = nil
		s.authPid = 0
		s.authStdinMu.Unlock()
	}()

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		sendEvent("error", jsonStr("Failed to start login: "+err.Error()))
		return
	}
	s.authStdinMu.Lock()
	s.authPid = cmd.Process.Pid
	s.authStdinMu.Unlock()
	slog.Info("auth login: started", "home", home, "bin", bin, "pid", cmd.Process.Pid)

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
