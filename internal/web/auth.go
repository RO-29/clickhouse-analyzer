package web

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
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
		slog.Warn("auth status: claude CLI not found", "err", err)
		writeJSON(w, http.StatusOK, authStatusResp{
			LoggedIn:  false,
			Error:     "Claude CLI not found",
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
//   - A bare OAuth code (or code#state) — we find claude's listening port via
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

	// Find claude's local port and build the callback URL.
	s.authStdinMu.Lock()
	pid := s.authPid
	s.authStdinMu.Unlock()

	if pid == 0 {
		writeErr(w, http.StatusConflict, "no active login session — open the re-auth modal and start the flow first")
		return
	}

	port, err := findListeningPort(pid)
	if err != nil {
		slog.Warn("auth callback: could not find local callback port", "pid", pid, "err", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
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
		slog.Warn("auth callback: proxy forward failed", "url", localURL, "err", err)
		writeErr(w, http.StatusBadGateway, "callback forward failed")
		return
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	slog.Info("auth callback forwarded", "status", resp.StatusCode, "url", localURL,
		"body_preview", truncate(string(body), 300))
	writeJSON(w, http.StatusOK, map[string]string{"status": "forwarded", "http_status": fmt.Sprint(resp.StatusCode)})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// extractCodeState parses code and state from a URL or returns the raw string
// as code if it looks like a bare OAuth code (no slashes).
//
// platform.claude.com encodes the state in the URL fragment:
//   https://platform.claude.com/oauth/code/callback?code=CODE#STATE
// or (when %23 is already encoded in the query):
//   ?code=CODE%23STATE&state=STATE
//
// In both cases the real OAuth code is the part before '#', and the fragment
// is the state (if state isn't already present as a query param).
func extractCodeState(raw string) (code, state string) {
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err == nil {
			code = u.Query().Get("code")
			state = u.Query().Get("state")
			// Fragment contains state when platform uses ?code=CODE#STATE pattern.
			if state == "" && u.Fragment != "" {
				state = u.Fragment
			}
			// If %23 was in the raw URL, url.Parse decodes it to '#' inside
			// the code value.  Strip it and promote to state if not already set.
			if idx := strings.Index(code, "#"); idx != -1 {
				if state == "" {
					state = code[idx+1:]
				}
				code = code[:idx]
			}
			return
		}
	}
	// Bare code — no slashes, no spaces.
	if !strings.Contains(raw, "/") && !strings.Contains(raw, " ") {
		code = raw
		if idx := strings.Index(code, "#"); idx != -1 {
			state = code[idx+1:]
			code = code[:idx]
		}
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
		slog.Warn("auth login: claude CLI not found", "err", err)
		writeErr(w, http.StatusServiceUnavailable, "Claude CLI not found")
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
		slog.Warn("auth login: failed to start process", "err", err)
		sendEvent("error", jsonStr("Failed to start login"))
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
		sendEvent("error", jsonStr("Login process failed. SSH into the server and run: HOME=/var/lib/ch-analyzer claude auth login"))
	} else {
		slog.Info("auth login: completed successfully")
		sendEvent("done", `{"success":true}`)
	}
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

type claudeCredentials struct {
	ClaudeAiOauth struct {
		AccessToken      string   `json:"accessToken"`
		RefreshToken     string   `json:"refreshToken"`
		ExpiresAt        int64    `json:"expiresAt"` // Unix ms
		Scopes           []string `json:"scopes"`
		SubscriptionType string   `json:"subscriptionType"`
		RateLimitTier    string   `json:"rateLimitTier"`
	} `json:"claudeAiOauth"`
}

// POST /api/auth/refresh — silently refresh expired OAuth token.
// Reads .claude/.credentials.json, calls Anthropic's token endpoint with the
// stored refreshToken, and writes the new tokens back to the file.
func (s *Server) handleAuthRefresh(w http.ResponseWriter, r *http.Request) {
	home := findClaudeHome()
	if home == "" {
		home = "/var/lib/ch-analyzer"
	}
	credsPath := filepath.Join(home, ".claude", ".credentials.json")

	raw, err := os.ReadFile(credsPath)
	if err != nil {
		slog.Warn("auth refresh: credentials file not found", "path", credsPath, "err", err)
		writeErr(w, http.StatusNotFound, "credentials not found — please log in first")
		return
	}

	var creds claudeCredentials
	if err := json.Unmarshal(raw, &creds); err != nil {
		slog.Warn("auth refresh: could not parse credentials", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	oauth := creds.ClaudeAiOauth
	if oauth.RefreshToken == "" {
		writeErr(w, http.StatusBadRequest, "no refresh token in credentials file")
		return
	}

	// Check if token is still valid (with 5-min buffer matching claude CLI's KS4=300000).
	nowMs := time.Now().UnixMilli()
	bufferMs := int64(5 * 60 * 1000)
	if oauth.ExpiresAt > nowMs+bufferMs {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"refreshed": false,
			"message":   "token still valid",
			"expires_at": oauth.ExpiresAt,
		})
		return
	}

	slog.Info("auth refresh: token expired, refreshing", "expires_at_ms", oauth.ExpiresAt, "now_ms", nowMs)

	newCreds, err := refreshOAuthToken(oauth.RefreshToken, oauth.Scopes)
	if err != nil {
		slog.Warn("auth refresh: token refresh failed", "err", err)
		writeErr(w, http.StatusBadGateway, "token refresh failed")
		return
	}

	// Preserve subscription/rate fields from old creds if not returned.
	if newCreds.ClaudeAiOauth.SubscriptionType == "" {
		newCreds.ClaudeAiOauth.SubscriptionType = oauth.SubscriptionType
	}
	if newCreds.ClaudeAiOauth.RateLimitTier == "" {
		newCreds.ClaudeAiOauth.RateLimitTier = oauth.RateLimitTier
	}
	if len(newCreds.ClaudeAiOauth.Scopes) == 0 {
		newCreds.ClaudeAiOauth.Scopes = oauth.Scopes
	}

	out, err := json.Marshal(newCreds)
	if err != nil {
		slog.Error("auth refresh: could not marshal credentials", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	if err := os.WriteFile(credsPath, out, 0o600); err != nil {
		slog.Error("auth refresh: could not write credentials", "path", credsPath, "err", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}

	slog.Info("auth refresh: token refreshed successfully", "new_expires_at_ms", newCreds.ClaudeAiOauth.ExpiresAt)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"refreshed":  true,
		"expires_at": newCreds.ClaudeAiOauth.ExpiresAt,
	})
}

// refreshOAuthToken exchanges a refresh token for a new access token via
// Anthropic's OAuth endpoint (same grant as claude CLI's ZS8/IQH functions).
func refreshOAuthToken(refreshToken string, scopes []string) (claudeCredentials, error) {
	type tokenReq struct {
		GrantType    string   `json:"grant_type"`
		RefreshToken string   `json:"refresh_token"`
		Scopes       []string `json:"scopes,omitempty"`
	}
	body, _ := json.Marshal(tokenReq{
		GrantType:    "refresh_token",
		RefreshToken: refreshToken,
		Scopes:       scopes,
	})

	// Try both known Anthropic token endpoints.
	endpoints := []string{
		"https://claude.ai/api/oauth/token",
		"https://claude.com/cai/oauth/token",
	}

	var lastErr error
	for _, endpoint := range endpoints {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Claude-Code/1.0")

		resp, err := http.DefaultClient.Do(req)
		cancel()
		if err != nil {
			lastErr = fmt.Errorf("POST %s: %w", endpoint, err)
			continue
		}

		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		resp.Body.Close()
		slog.Info("auth refresh: token endpoint response", "endpoint", endpoint, "status", resp.StatusCode,
			"body_preview", truncate(string(respBody), 200))

		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("POST %s returned %d: %s", endpoint, resp.StatusCode, truncate(string(respBody), 200))
			continue
		}

		// The response is the new token payload. Parse it into our credentials shape.
		// Claude CLI stores it under claudeAiOauth, so try both wrapped and flat forms.
		var wrapped claudeCredentials
		if err := json.Unmarshal(respBody, &wrapped); err == nil && wrapped.ClaudeAiOauth.AccessToken != "" {
			return wrapped, nil
		}

		// Flat form: {"access_token":"…","refresh_token":"…","expires_in":…}
		var flat struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			ExpiresIn    int64  `json:"expires_in"` // seconds
			ExpiresAt    int64  `json:"expires_at"` // ms (if present)
		}
		if err := json.Unmarshal(respBody, &flat); err == nil && flat.AccessToken != "" {
			var c claudeCredentials
			c.ClaudeAiOauth.AccessToken = flat.AccessToken
			if flat.RefreshToken != "" {
				c.ClaudeAiOauth.RefreshToken = flat.RefreshToken
			} else {
				c.ClaudeAiOauth.RefreshToken = refreshToken // keep existing
			}
			if flat.ExpiresAt > 0 {
				c.ClaudeAiOauth.ExpiresAt = flat.ExpiresAt
			} else if flat.ExpiresIn > 0 {
				c.ClaudeAiOauth.ExpiresAt = time.Now().UnixMilli() + flat.ExpiresIn*1000
			} else {
				c.ClaudeAiOauth.ExpiresAt = time.Now().Add(1*time.Hour).UnixMilli()
			}
			return c, nil
		}

		lastErr = fmt.Errorf("POST %s: could not parse response: %s", endpoint, truncate(string(respBody), 200))
	}
	return claudeCredentials{}, lastErr
}

// POST /api/auth/set-tokens — directly write OAuth tokens to the credentials file.
// Accepts the raw credentials JSON (paste from ~/.claude/.credentials.json on any
// authenticated machine) or a flat {accessToken, refreshToken, expiresAt} object.
func (s *Server) handleAuthSetTokens(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 16384))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "could not read body")
		return
	}

	home := findClaudeHome()
	if home == "" {
		home = "/var/lib/ch-analyzer"
	}
	_ = os.MkdirAll(filepath.Join(home, ".claude"), 0o755)
	credsPath := filepath.Join(home, ".claude", ".credentials.json")

	// Bare token string: sk-ant-oat01-… or sk-ant-ort01-…
	if bare := strings.TrimSpace(string(body)); strings.HasPrefix(bare, "sk-ant-") && !strings.Contains(bare, "{") {
		var c claudeCredentials
		c.ClaudeAiOauth.AccessToken = bare
		c.ClaudeAiOauth.ExpiresAt = time.Now().Add(24 * time.Hour).UnixMilli()
		out, _ := json.Marshal(c)
		if err := os.WriteFile(credsPath, out, 0o600); err != nil {
			slog.Error("auth set-tokens: failed to write credentials", "err", err)
			writeErr(w, http.StatusInternalServerError, "internal server error")
			return
		}
		slog.Info("auth set-tokens: wrote bare access token", "path", credsPath)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	// Try wrapped form first (paste of full .credentials.json).
	var wrapped claudeCredentials
	if err := json.Unmarshal(body, &wrapped); err == nil && wrapped.ClaudeAiOauth.AccessToken != "" {
		if err := os.WriteFile(credsPath, body, 0o600); err != nil {
			slog.Error("auth set-tokens: failed to write credentials", "err", err)
			writeErr(w, http.StatusInternalServerError, "internal server error")
			return
		}
		slog.Info("auth set-tokens: wrote wrapped credentials", "path", credsPath)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	// Flat form: {accessToken, refreshToken, expiresAt (optional)}.
	var flat struct {
		AccessToken      string   `json:"accessToken"`
		RefreshToken     string   `json:"refreshToken"`
		ExpiresAt        int64    `json:"expiresAt"`
		Scopes           []string `json:"scopes"`
		SubscriptionType string   `json:"subscriptionType"`
		RateLimitTier    string   `json:"rateLimitTier"`
	}
	if err := json.Unmarshal(body, &flat); err != nil || flat.AccessToken == "" {
		writeErr(w, http.StatusBadRequest, "expected {accessToken, refreshToken} or full credentials JSON")
		return
	}
	var c claudeCredentials
	c.ClaudeAiOauth.AccessToken = flat.AccessToken
	c.ClaudeAiOauth.RefreshToken = flat.RefreshToken
	if flat.ExpiresAt > 0 {
		c.ClaudeAiOauth.ExpiresAt = flat.ExpiresAt
	} else {
		c.ClaudeAiOauth.ExpiresAt = time.Now().Add(1 * time.Hour).UnixMilli()
	}
	c.ClaudeAiOauth.Scopes = flat.Scopes
	c.ClaudeAiOauth.SubscriptionType = flat.SubscriptionType
	c.ClaudeAiOauth.RateLimitTier = flat.RateLimitTier

	out, _ := json.Marshal(c)
	if err := os.WriteFile(credsPath, out, 0o600); err != nil {
		slog.Error("auth set-tokens: failed to write credentials", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal server error")
		return
	}
	slog.Info("auth set-tokens: wrote flat credentials", "path", credsPath)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
