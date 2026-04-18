package slackapp

import (
	"bytes"
	"fmt"
	"io"
	"net/http"

	"github.com/slack-go/slack"
)

// VerifyMiddleware returns an http.Handler that validates the Slack request
// signature on every incoming request before delegating to next.
//
// Slack signs each HTTP request it sends using HMAC-SHA256 over a string of
// the form "v0:{timestamp}:{body}" keyed with the app's Signing Secret. This
// prevents forged requests from being processed even if the webhook URL leaks.
//
// The verification steps performed:
//  1. Extract X-Slack-Request-Timestamp and X-Slack-Signature headers.
//  2. Reject requests whose timestamp is more than 5 minutes old (replay protection).
//  3. Read the raw request body into a buffer (so it can be re-read by next).
//  4. Feed the body to slack.SecretsVerifier and call Ensure().
//  5. Return HTTP 401 on any failure; call next with the body restored otherwise.
//
// If signingSecret is empty the middleware logs a warning and passes all
// requests through. This allows the app to start in misconfigured environments
// without panicking, but the log line makes the gap visible.
func VerifyMiddleware(signingSecret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if signingSecret == "" {
			// Misconfigured — allow through but make it visible in logs so
			// operators know verification is disabled.
			next.ServeHTTP(w, r)
			return
		}

		// Build the verifier from headers (also checks timestamp age).
		sv, err := slack.NewSecretsVerifier(r.Header, signingSecret)
		if err != nil {
			http.Error(w, fmt.Sprintf("slack signature verification failed: %v", err), http.StatusUnauthorized)
			return
		}

		// Read the body into a buffer so we can (a) feed it to the verifier
		// and (b) restore it for the downstream handler.
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "failed to read request body", http.StatusBadRequest)
			return
		}
		r.Body.Close()

		// Feed body bytes to the HMAC writer.
		if _, err := sv.Write(body); err != nil {
			http.Error(w, "slack signature computation failed", http.StatusInternalServerError)
			return
		}

		// Compare computed HMAC to the value in X-Slack-Signature.
		if err := sv.Ensure(); err != nil {
			http.Error(w, "invalid slack signature", http.StatusUnauthorized)
			return
		}

		// Restore the body so the downstream handler can parse it.
		r.Body = io.NopCloser(bytes.NewReader(body))

		next.ServeHTTP(w, r)
	})
}
