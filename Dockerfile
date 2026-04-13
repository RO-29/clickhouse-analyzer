# Stage 1: Build React frontend
FROM node:22-alpine AS frontend
WORKDIR /app/web/frontend
COPY web/frontend/package.json web/frontend/package-lock.json ./
RUN npm ci
COPY web/frontend/ .
# Vite builds to ../../internal/web/static/ = /app/internal/web/static/
RUN npm run build

# Stage 2: Build Go binary (with embedded frontend)
FROM golang:1.23-alpine AS builder
RUN apk add --no-cache git
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Overwrite static dir with built React assets
COPY --from=frontend /app/internal/web/static/ ./internal/web/static/
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-s -w -X main.version=$(git describe --tags --always 2>/dev/null || echo docker) -X main.buildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -o /ch-analyzer ./cmd/ch-analyzer

# Stage 3: Final image
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /ch-analyzer /usr/local/bin/ch-analyzer
EXPOSE 8080 9090
ENTRYPOINT ["ch-analyzer"]
CMD ["-config", "/etc/ch-analyzer/config.yaml"]
