#!/usr/bin/env bash
#
# compat-test.sh — version-compatibility harness for ch-analyzer.
#
# For each ClickHouse OSS version it spins up a throwaway clickhouse-server
# container, applies schema.sql, and runs `ch-analyzer --compat-check` against it.
# compat-check detects capabilities and runs every collector once; it exits
# non-zero if any collector hard-errors (collectors must degrade gracefully on
# missing tables/columns, so a real error is a compatibility gap).
#
# It also snapshots the detected capability set per version into
# test/compat/golden/<version>.json so capability drift is reviewable in diffs.
#
# Usage:
#   scripts/compat-test.sh                 # default version matrix
#   scripts/compat-test.sh 24.8 25.3       # specific versions
#   UPDATE_GOLDEN=1 scripts/compat-test.sh # refresh golden snapshots
#
# Requires: docker, and a built ./bin/ch-analyzer (run `make build` first).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Supported OSS floor is 23.x. Cloud (25.3+) is covered by a live smoke test, not
# here, since Cloud can't run in a container.
DEFAULT_VERSIONS=(23.3 23.8 24.3 24.8 25.3 latest)
VERSIONS=("$@")
if [ ${#VERSIONS[@]} -eq 0 ]; then
  VERSIONS=("${DEFAULT_VERSIONS[@]}")
fi

BIN="$REPO_ROOT/bin/ch-analyzer"
if [ ! -x "$BIN" ]; then
  echo "ERROR: $BIN not found. Run 'make build' first." >&2
  exit 1
fi

GOLDEN_DIR="$REPO_ROOT/test/compat/golden"
REPORT_DIR="$(mktemp -d)"
mkdir -p "$GOLDEN_DIR"

CH_PORT=18123
CONTAINER=ch-analyzer-compat
FAILED=()

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_ready() {
  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:${CH_PORT}/ping" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "ERROR: ClickHouse did not become ready" >&2
  return 1
}

for V in "${VERSIONS[@]}"; do
  echo "═══════════════════════════════════════════════════════════════════"
  echo "  ClickHouse ${V}"
  echo "═══════════════════════════════════════════════════════════════════"
  cleanup
  docker run -d --name "$CONTAINER" \
    -e CLICKHOUSE_SKIP_USER_SETUP=1 \
    -p "${CH_PORT}:8123" \
    "clickhouse/clickhouse-server:${V}" >/dev/null

  if ! wait_ready; then FAILED+=("$V (startup)"); continue; fi

  # Apply schema (creates DB + tables + idempotent migrations). ClickHouse HTTP
  # runs one statement per request, so split on ';'. Each statement in schema.sql
  # is preceded by comment lines — strip those before sending, or the whole
  # statement would look like a comment and be skipped.
  python3 - "$REPO_ROOT/schema.sql" "$CH_PORT" <<'PY'
import sys, urllib.request, urllib.error
sql = open(sys.argv[1]).read()
url = f"http://localhost:{sys.argv[2]}/"

def run(stmt):
    try:
        urllib.request.urlopen(url, data=stmt.encode())
        return None
    except urllib.error.HTTPError as e:
        return f"{e.code} {e.read().decode('utf-8','replace')[:160]}"
    except Exception as e:
        return str(e)[:160]

def clean(stmt):
    lines = stmt.splitlines()
    while lines and (not lines[0].strip() or lines[0].strip().startswith('--')):
        lines.pop(0)
    return "\n".join(lines).strip()

if err := run("CREATE DATABASE IF NOT EXISTS ch_analyzer"):
    print(f"  CREATE DATABASE warning: {err}")
applied = errors = 0
for raw in sql.split(';'):
    s = clean(raw)
    if not s:
        continue
    err = run(s)
    if err:
        errors += 1
        print(f"  schema stmt warning: {err}")
    else:
        applied += 1
print(f"  schema: {applied} statement(s) applied, {errors} warning(s)")
PY

  CFG="${REPORT_DIR}/config-${V}.yaml"
  cat > "$CFG" <<YAML
instances:
  - name: "compat-${V}"
    host: "localhost"
    port: ${CH_PORT}
    username: "default"
    password: ""
    secure: false
    mode: "oss"
storage:
  database: "ch_analyzer"
web:
  enabled: false
YAML

  REPORT="${REPORT_DIR}/report-${V}.json"
  if "$BIN" --config "$CFG" --compat-check > "$REPORT" 2>"${REPORT_DIR}/log-${V}.txt"; then
    echo "  ✅ no collector hard-errors"
  else
    echo "  ❌ collector hard-errors (see below)"
    FAILED+=("$V")
  fi
  # Show the per-collector failures, if any.
  python3 - "$REPORT" <<'PY' || true
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    print("  (no JSON report produced)"); sys.exit()
for inst in data:
    caps = inst.get("capabilities", {})
    print(f"  version={caps.get('version',{}).get('Raw')} edition={caps.get('edition')} replicas={caps.get('replicas')}")
    for c in inst.get("collectors", []):
        if not c.get("ok"):
            print(f"    ✗ {c['name']}: {c.get('error','')[:160]}")
PY

  # Snapshot capabilities to golden (feature availability only — stable across runs).
  SNAP="${GOLDEN_DIR}/${V}.json"
  python3 - "$REPORT" "$SNAP" "${UPDATE_GOLDEN:-0}" <<'PY'
import json, sys, os
report, snap_path, update = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(open(report))
except Exception:
    sys.exit()
if not data:
    sys.exit()
caps = data[0].get("capabilities", {})
snap = {
    "edition": caps.get("edition"),
    "features": {k: v.get("available") for k, v in sorted((caps.get("features") or {}).items())},
}
new = json.dumps(snap, indent=2, sort_keys=True)
if update == "1" or not os.path.exists(snap_path):
    open(snap_path, "w").write(new + "\n")
    print(f"  📸 golden snapshot written: {snap_path}")
else:
    old = open(snap_path).read().strip()
    if old != new.strip():
        print(f"  ⚠️  capability drift vs golden ({snap_path}) — re-run with UPDATE_GOLDEN=1 to accept")
PY

  # Full per-feature e2e report (capabilities + collectors + web endpoints).
  # Same script runs in CI so both surface identical per-feature pass/fail.
  CH_PORT="$CH_PORT" WEB_PORT=18080 "$REPO_ROOT/scripts/feature-check.sh" "$V" || FAILED+=("$V (features)")

done

cleanup
echo "═══════════════════════════════════════════════════════════════════"
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "  ✅ compat-test passed for: ${VERSIONS[*]}"
  exit 0
else
  echo "  ❌ compat-test FAILED for: ${FAILED[*]}"
  exit 1
fi
