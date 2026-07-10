package web

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rohitjain/ch-analyzer/internal/config"
)

func newAuthTestServer(token string) *Server {
	return &Server{cfg: &config.Config{Security: config.SecurityConfig{APIToken: token}}}
}

func serve(s *Server, req *http.Request) int {
	h := s.authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestAuthMiddleware_DisabledWhenNoToken(t *testing.T) {
	s := newAuthTestServer("")
	if code := serve(s, httptest.NewRequest(http.MethodGet, "/api/instances", nil)); code != http.StatusOK {
		t.Fatalf("no token configured should allow /api, got %d", code)
	}
}

func TestAuthMiddleware_GatesAPI(t *testing.T) {
	s := newAuthTestServer("s3cret")

	cases := []struct {
		name string
		set  func(*http.Request)
		want int
	}{
		{"no credentials", func(*http.Request) {}, http.StatusUnauthorized},
		{"wrong bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer nope") }, http.StatusUnauthorized},
		{"correct bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer s3cret") }, http.StatusOK},
		{"x-api-token", func(r *http.Request) { r.Header.Set("X-API-Token", "s3cret") }, http.StatusOK},
		{"cookie", func(r *http.Request) { r.AddCookie(&http.Cookie{Name: "ch_analyzer_token", Value: "s3cret"}) }, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/instances", nil)
			tc.set(req)
			if code := serve(s, req); code != tc.want {
				t.Errorf("%s: got %d, want %d", tc.name, code, tc.want)
			}
		})
	}
}

func TestAuthMiddleware_ExemptsNonAPIPaths(t *testing.T) {
	s := newAuthTestServer("s3cret")
	// The SPA shell and liveness endpoint must load without a token, or the app
	// can't bootstrap and load balancers can't probe it.
	for _, path := range []string{"/", "/assets/index.js", "/health"} {
		if code := serve(s, httptest.NewRequest(http.MethodGet, path, nil)); code != http.StatusOK {
			t.Errorf("%s should be exempt from auth, got %d", path, code)
		}
	}
}
