#!/usr/bin/env bash
#
# feature-check.sh — run the full per-feature e2e report against an already
# running ClickHouse (schema applied). Shared by the local matrix harness
# (scripts/compat-test.sh) and GitHub CI (.github/workflows/compat.yml) so both
# exercise the exact same features and emit an identical report.
#
# It:
#   1. runs `ch-analyzer --compat-check` (capabilities + every collector once),
#   2. boots the real web server and probes every read-only /api endpoint,
#   3. writes a markdown report and exits non-zero on any collector hard-error
#      or 5xx/error-body endpoint.
#
# Inputs (env):
#   CH_HOST    (default localhost)   CH_PORT (default 18123)
#   CH_USER    (default default)     CH_PASSWORD (default empty)
#   WEB_PORT   (default 18080)       REPORT_DIR (default test/compat/reports)
# Args:
#   $1 version label (e.g. "24.8" or "latest"), used in the report title/filename.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$REPO_ROOT/bin/ch-analyzer"
LABEL="${1:-local}"

CH_HOST="${CH_HOST:-localhost}"
CH_PORT="${CH_PORT:-18123}"
CH_USER="${CH_USER:-default}"
CH_PASSWORD="${CH_PASSWORD:-}"
WEB_PORT="${WEB_PORT:-18080}"
REPORT_DIR="${REPORT_DIR:-$REPO_ROOT/test/compat/reports}"
INSTANCE="compat"

mkdir -p "$REPORT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null || true' EXIT

if [ ! -x "$BIN" ]; then
  echo "ERROR: $BIN not found. Run 'make build-go' first." >&2
  exit 2
fi

# Shared instance block (compat-check has web disabled; web run enables it).
cat > "$TMP/base.yaml" <<YAML
instances:
  - name: "$INSTANCE"
    host: "$CH_HOST"
    port: $CH_PORT
    username: "$CH_USER"
    password: "$CH_PASSWORD"
    secure: false
    mode: "oss"
storage:
  database: "ch_analyzer"
YAML

# 1) compat-check → JSON (capabilities + collectors)
cp "$TMP/base.yaml" "$TMP/compat.yaml"
cat >> "$TMP/compat.yaml" <<YAML
web:
  enabled: false
YAML
COMPAT_JSON="$TMP/compat-report.json"
"$BIN" --config "$TMP/compat.yaml" --compat-check > "$COMPAT_JSON" 2>"$TMP/compat.log"
COMPAT_RC=$?

# 2) boot the web server for endpoint probing
cp "$TMP/base.yaml" "$TMP/web.yaml"
cat >> "$TMP/web.yaml" <<YAML
web:
  enabled: true
  listen_addr: "127.0.0.1:$WEB_PORT"
YAML
"$BIN" --config "$TMP/web.yaml" >"$TMP/web.log" 2>&1 &
WEB_PID=$!

# wait for /health (up to ~30s)
ready=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${WEB_PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then echo "  web server exited early; see log:"; tail -5 "$TMP/web.log"; break; fi
  sleep 0.5
done
if [ "$ready" != "1" ]; then
  echo "  ⚠️  web server did not become ready — endpoint probes will be reported as failures" >&2
fi

# Warm up the *_log system tables. On a fresh server they don't exist until
# ClickHouse's first background flush, so endpoints that read query_log/part_log
# 500 with "table doesn't exist" purely because of container age — not a real
# gap. SYSTEM FLUSH LOGS materialises them so the probe reflects true behaviour.
if [ -n "$CH_PASSWORD" ]; then
  curl -s --user "${CH_USER}:${CH_PASSWORD}" "http://${CH_HOST}:${CH_PORT}/" --data "SYSTEM FLUSH LOGS" >/dev/null 2>&1 || true
else
  curl -s "http://${CH_HOST}:${CH_PORT}/" --data "SYSTEM FLUSH LOGS" >/dev/null 2>&1 || true
fi
sleep 2

# 3) probe endpoints + merge → markdown report
REPORT_MD="$REPORT_DIR/${LABEL}.md"
python3 "$REPO_ROOT/scripts/feature_report.py" \
  --compat-json "$COMPAT_JSON" \
  --base-url "http://127.0.0.1:${WEB_PORT}" \
  --instance "$INSTANCE" \
  --out "$REPORT_MD" \
  --label "$LABEL"
REPORT_RC=$?

kill "$WEB_PID" 2>/dev/null || true
WEB_PID=""

if [ "$COMPAT_RC" -ne 0 ] || [ "$REPORT_RC" -ne 0 ]; then
  echo "  ❌ feature-check FAILED for $LABEL (compat_rc=$COMPAT_RC report_rc=$REPORT_RC)"
  exit 1
fi
echo "  ✅ feature-check passed for $LABEL"
exit 0
