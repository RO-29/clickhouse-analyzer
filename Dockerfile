# ─── Stage 1: React frontend ────────────────────────────────────────────────
FROM node:22-alpine AS frontend
WORKDIR /app/web/frontend
COPY web/frontend/package.json web/frontend/package-lock.json ./
RUN npm ci
COPY web/frontend/ .
# Vite outputs to ../../internal/web/static/ = /app/internal/web/static/
RUN npm run build

# ─── Stage 2: Go binary ─────────────────────────────────────────────────────
FROM golang:1.25-alpine AS builder
RUN apk add --no-cache git
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Overwrite static dir with built React assets
COPY --from=frontend /app/internal/web/static/ ./internal/web/static/
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-s -w \
      -X main.version=$(git describe --tags --always 2>/dev/null || echo docker) \
      -X main.buildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -o /ch-analyzer ./cmd/ch-analyzer

# ─── Stage 3: Final image ───────────────────────────────────────────────────
# Use node:22-alpine as base so Node.js is available for the Claude Code CLI.
# The ch-analyzer binary is statically compiled (CGO_ENABLED=0) and has no
# libc dependencies, so it runs fine on this base.
FROM node:22-alpine

RUN apk add --no-cache ca-certificates tzdata

# Install Claude Code CLI.
# The AI analysis feature (analyze.go) spawns: claude -p "<prompt>"
# This requires the claude binary to be on PATH.
# Auth: set ANTHROPIC_API_KEY env var, or mount a pre-authed
#       ~/.config/claude volume (see docker-compose.yml).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# ch-analyzer binary
COPY --from=builder /ch-analyzer /usr/local/bin/ch-analyzer

EXPOSE 8080 9090
ENTRYPOINT ["ch-analyzer"]
CMD ["-config", "/etc/ch-analyzer/config.yaml"]
