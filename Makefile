BINARY_NAME=ch-analyzer
VERSION=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME=$(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS=-ldflags "-X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME)"

DOCKER_IMAGE=ch-analyzer
DOCKER_TAG=$(VERSION)

.PHONY: build clean install run test lint docker docker-push k8s-deploy frontend \
        compose-up compose-down compose-logs compose-restart compose-ps

# Frontend (React + Tailwind)
frontend:
	cd web/frontend && npm ci && npm run build

# Build Go binary (requires frontend to be built first)
build: frontend
	go build $(LDFLAGS) -o bin/$(BINARY_NAME) ./cmd/ch-analyzer

build-linux: frontend
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/$(BINARY_NAME)-linux-amd64 ./cmd/ch-analyzer

# Build Go only (skip frontend — use when frontend hasn't changed)
build-go:
	go build $(LDFLAGS) -o bin/$(BINARY_NAME) ./cmd/ch-analyzer

build-go-linux:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/$(BINARY_NAME)-linux-amd64 ./cmd/ch-analyzer

build-all: build build-linux

# Dev: run frontend dev server (hot reload) + Go backend
dev:
	@echo "Start two terminals:"
	@echo "  Terminal 1: cd web/frontend && npm run dev"
	@echo "  Terminal 2: make build-go && ./bin/ch-analyzer -config configs/ch-analyzer.yaml"
	@echo ""
	@echo "Frontend at http://localhost:5173 (proxies /api to :8080)"

clean:
	rm -rf bin/ internal/web/static/assets/ web/frontend/node_modules/

install: build
	sudo cp bin/$(BINARY_NAME) /usr/local/bin/
	sudo mkdir -p /etc/ch-analyzer
	@if [ ! -f /etc/ch-analyzer/config.yaml ]; then \
		sudo cp configs/ch-analyzer.yaml /etc/ch-analyzer/config.yaml; \
		echo "Config installed at /etc/ch-analyzer/config.yaml - edit it with your settings"; \
	fi

install-systemd: install
	sudo cp deploy/ch-analyzer.service /etc/systemd/system/
	sudo systemctl daemon-reload
	@echo "Run: sudo systemctl enable --now ch-analyzer"

run: build
	./bin/$(BINARY_NAME) -config configs/ch-analyzer.yaml

test:
	go test ./... -v -race

lint:
	golangci-lint run ./...

tidy:
	go mod tidy

deps:
	go mod download
	cd web/frontend && npm ci

docker:
	docker build -t $(DOCKER_IMAGE):$(DOCKER_TAG) -t $(DOCKER_IMAGE):latest .

docker-push: docker
	docker push $(DOCKER_IMAGE):$(DOCKER_TAG)
	docker push $(DOCKER_IMAGE):latest

k8s-deploy:
	@echo "1. Edit deploy/k8s.yaml — set passwords, slack token, channel ID"
	@echo "2. Run: kubectl apply -f deploy/k8s.yaml"
	@echo "3. Port-forward: kubectl -n ch-analyzer port-forward svc/ch-analyzer 8080:8080"
	kubectl apply -f deploy/k8s.yaml

# ── Docker Compose (full stack: ch-analyzer + Prometheus + Grafana) ──────────
# Prerequisites:
#   cp .env.example .env  &&  fill in ANTHROPIC_API_KEY
#   set prometheus.enabled: true in configs/ch-analyzer.yaml

compose-up:
	@[ -f .env ] || (echo "Missing .env — run: cp .env.example .env" && exit 1)
	docker compose up -d --build
	@echo ""
	@echo "  Dashboard  → http://localhost:8080"
	@echo "  Prometheus → http://localhost:9091"
	@echo "  Grafana    → http://localhost:3000  (admin / \$${GRAFANA_PASSWORD:-admin})"

compose-down:
	docker compose down

compose-restart:
	docker compose restart ch-analyzer

compose-logs:
	docker compose logs -f ch-analyzer

compose-ps:
	docker compose ps
