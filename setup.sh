#!/bin/bash
set +H
set -e

echo "============================================"
echo "  CH Analyzer Setup"
echo "============================================"
echo ""

# ---------------------------------------------------------------------------
# Configuration — EDIT THESE
# ---------------------------------------------------------------------------
CH_HOSTS=(
""
)
CH_PORT=8443
CH_ADMIN_USER="admin"
CH_ADMIN_PASS='CHANGE_ME'
CH_MONITOR_USER="monitoring"
CH_MONITOR_PASS='CHANGE_ME'

# ---------------------------------------------------------------------------
# Step 1: Create monitoring user + grants on all instances
# ---------------------------------------------------------------------------
echo "[1/3] Creating monitoring user and grants on all instances..."

for HOST in "${CH_HOSTS[@]}"; do
  echo "  -> $HOST"
  clickhouse-client --host "$HOST" --port "$CH_PORT" --secure \
    --user "$CH_ADMIN_USER" --password "$CH_ADMIN_PASS" \
    --multiquery -q "
    CREATE USER IF NOT EXISTS ${CH_MONITOR_USER} IDENTIFIED BY '${CH_MONITOR_PASS}';
    GRANT SELECT ON system.* TO ${CH_MONITOR_USER};
    GRANT SELECT ON *.* TO ${CH_MONITOR_USER};
    GRANT SELECT, INSERT ON ch_analyzer.* TO ${CH_MONITOR_USER};
  " 2>&1 | grep -v "^$" || true
done
echo "  Done."
echo ""

# ---------------------------------------------------------------------------
# Step 2: Create ch_analyzer database and tables on all instances
# ---------------------------------------------------------------------------
echo "[2/3] Creating ch_analyzer database and tables on all instances..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="$SCRIPT_DIR/schema.sql"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "  ERROR: schema.sql not found at $SCHEMA_FILE"
  exit 1
fi

for HOST in "${CH_HOSTS[@]}"; do
  echo "  -> $HOST"
  clickhouse-client --host "$HOST" --port "$CH_PORT" --secure \
    --user "$CH_ADMIN_USER" --password "$CH_ADMIN_PASS" \
    --multiquery < "$SCHEMA_FILE" 2>&1 | grep -v "^$" || true
done
echo "  Done."
echo ""

# ---------------------------------------------------------------------------
# Step 3: Install binary + config + systemd service
# ---------------------------------------------------------------------------
echo "[3/3] Installing ch-analyzer..."

# Binary
if [ -f bin/ch-analyzer-linux-amd64 ]; then
  sudo cp bin/ch-analyzer-linux-amd64 /usr/local/bin/ch-analyzer
  sudo chmod +x /usr/local/bin/ch-analyzer
  echo "  Binary installed at /usr/local/bin/ch-analyzer"
elif [ -f /tmp/ch-analyzer ]; then
  sudo cp /tmp/ch-analyzer /usr/local/bin/ch-analyzer
  sudo chmod +x /usr/local/bin/ch-analyzer
  echo "  Binary installed from /tmp/ch-analyzer"
else
  echo "  ERROR: No binary found. Build with 'make build-linux' first."
  exit 1
fi

# Config
sudo mkdir -p /etc/ch-analyzer
if [ ! -f /etc/ch-analyzer/config.yaml ]; then
  if [ -f configs/my-config.yaml ]; then
    sudo cp configs/my-config.yaml /etc/ch-analyzer/config.yaml
  elif [ -f configs/ch-analyzer.yaml ]; then
    sudo cp configs/ch-analyzer.yaml /etc/ch-analyzer/config.yaml
  fi
  echo "  Config installed at /etc/ch-analyzer/config.yaml"
  echo "  *** EDIT IT: set passwords, slack bot_token, channel_id ***"
else
  echo "  Config already exists at /etc/ch-analyzer/config.yaml (not overwritten)"
fi

# Service user + data dir
sudo useradd -r -s /bin/false ch-analyzer 2>/dev/null || true
sudo mkdir -p /var/lib/ch-analyzer
sudo chown ch-analyzer:ch-analyzer /var/lib/ch-analyzer

# Systemd
sudo cp deploy/ch-analyzer.service /etc/systemd/system/ 2>/dev/null || \
  sudo cp /tmp/ch-analyzer.service /etc/systemd/system/ 2>/dev/null || true
sudo systemctl daemon-reload
echo "  Systemd service installed."

# Clean up old SQLite files
sudo rm -f /var/lib/ch-analyzer/metrics.db*

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Edit config:    sudo vi /etc/ch-analyzer/config.yaml"
echo "  2. Start service:  sudo systemctl enable --now ch-analyzer"
echo "  3. Check logs:     sudo journalctl -u ch-analyzer -f"
echo "  4. Open dashboard: http://$(hostname -I | awk '{print $1}'):8080"
echo ""
