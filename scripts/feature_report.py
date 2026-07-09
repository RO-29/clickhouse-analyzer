#!/usr/bin/env python3
"""
feature_report.py — per-feature e2e report for ch-analyzer.

Merges two signals into one human-readable report so every individual feature
either passes or fails visibly:

  1. compat-check JSON  (capabilities detection + every collector run once)
  2. live web API probe (boots the real server, hits each read-only /api
     endpoint, asserts HTTP 200 and a non-error JSON body)

Collector checks catch backend/version gaps; endpoint checks catch the web
layer the collectors never touch (the tabs users actually see). Exits non-zero
if any collector hard-errors or any endpoint returns 5xx / an error body, so it
gates CI the same way locally and on GitHub.

Usage:
  feature_report.py --compat-json report.json --base-url http://localhost:18080 \
      --instance compat --out report.md
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request


# Read-only, instance-scoped endpoints. {n} → instance name. These mirror the UI
# tabs; from/to default to the last 1h server-side when omitted. POST / AI /
# auth / mutating endpoints are intentionally excluded — this is a shape+health
# probe, not a functional test of write paths.
INSTANCE_ENDPOINTS = [
    # A few endpoints require a query param; supply a sane value so they get
    # exercised for real instead of returning a 400 "required param" warn.
    "metrics?name=MemoryTracking", "alerts", "queries", "connections",
    "connections/history", "connections/sessions", "tables", "disks", "mvs",
    "s3-stats", "s3-latency-by-table", "replication", "table-memory",
    "cache-stats", "health-check", "capabilities", "query-patterns",
    "query-patterns-v2", "query-pattern-timeline?hash=0", "query-samples",
    "query-pattern-overview", "query-users", "query-tables",
    "history/failures", "history/merges", "history/mvs", "history/inserts",
    "history/s3", "history/async-metrics?metrics=MemoryTracking",
    "history/disk-io", "health-trend", "cost",
    "advisor/compression", "advisor/query-regression", "advisor/new-patterns",
    "advisor/unused-tables", "advisor/schema", "advisor/cardinality",
    "advisor/storage-policy", "advisor/query-antipatterns",
    "advisor/table-antipatterns",
]

GLOBAL_ENDPOINTS = [
    "/health", "/api/instances", "/api/overview", "/api/alerts/active",
    "/api/alerts/history", "/api/cost",
]


def probe(url, timeout=30):
    """GET url → (status:int, is_error_body:bool, note:str)."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(200_000)
            status = resp.getcode()
    except urllib.error.HTTPError as e:
        return e.code, True, e.read().decode("utf-8", "replace")[:160]
    except Exception as e:  # noqa: BLE001 — connection refused, timeout, etc.
        return 0, True, str(e)[:160]
    # A 200 can still carry an error object; flag it.
    text = body.decode("utf-8", "replace").strip()
    if text.startswith("{") and '"error"' in text[:200]:
        try:
            obj = json.loads(text)
            if isinstance(obj, dict) and obj.get("error"):
                return status, True, str(obj["error"])[:160]
        except Exception:  # noqa: BLE001
            pass
    return status, False, ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--compat-json", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--instance", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default="")
    args = ap.parse_args()

    with open(args.compat_json) as f:
        report = json.load(f)
    inst = report[0] if report else {}
    caps = inst.get("capabilities", {}) or {}
    collectors = inst.get("collectors", []) or []

    base = args.base_url.rstrip("/")
    inst_prefix = f"{base}/api/instances/{args.instance}/"

    endpoint_results = []
    for ep in GLOBAL_ENDPOINTS:
        url = base + ep
        status, err, note = probe(url)
        endpoint_results.append((ep, status, err, note))
    for ep in INSTANCE_ENDPOINTS:
        status, err, note = probe(inst_prefix + ep)
        endpoint_results.append((f"instances/{{n}}/{ep}", status, err, note))

    # ---- classify --------------------------------------------------------
    # fail = connection refused (0), server error (5xx), or a 2xx/3xx carrying an
    # error body. A 4xx is a *warn*: it means the endpoint is reachable but the
    # probe didn't supply a required param (e.g. metrics needs ?name=…) — that's
    # a prober limitation, not a compatibility gap.
    def is_fail(status, err):
        return status == 0 or status >= 500 or (bool(err) and status < 400)

    collector_fail = [c for c in collectors if not c.get("ok")]
    endpoint_fail = [r for r in endpoint_results if is_fail(r[1], r[2])]
    endpoint_warn = [r for r in endpoint_results if 400 <= r[1] < 500]

    feats = caps.get("features", {}) or {}
    ver = (caps.get("version") or {}).get("Raw") or (caps.get("version") or {}).get("raw") or "?"

    # ---- markdown --------------------------------------------------------
    L = []
    title = args.label or ver
    L.append(f"## ClickHouse {title} — feature report")
    L.append("")
    L.append(f"- **version**: `{ver}`  **edition**: `{caps.get('edition','?')}`  "
             f"**replicas**: `{caps.get('replicas','?')}`  **cluster**: `{caps.get('cluster','?')}`")
    L.append(f"- **collectors**: {len(collectors)-len(collector_fail)}/{len(collectors)} ok"
             f"  ·  **endpoints**: {len(endpoint_results)-len(endpoint_fail)-len(endpoint_warn)}/{len(endpoint_results)} ok"
             f"  ·  **failures**: {len(collector_fail)+len(endpoint_fail)}")
    L.append("")

    L.append("### Capabilities")
    L.append("| feature | available | reason |")
    L.append("|---|---|---|")
    for k in sorted(feats):
        v = feats[k]
        mark = "✅" if v.get("available") else "⚠️"
        L.append(f"| `{k}` | {mark} | {v.get('reason','')} |")
    L.append("")

    L.append("### Collectors")
    L.append("| collector | status | error |")
    L.append("|---|---|---|")
    for c in collectors:
        mark = "✅" if c.get("ok") else "❌"
        L.append(f"| `{c.get('name')}` | {mark} | {(c.get('error') or '')[:200]} |")
    L.append("")

    L.append("### Web endpoints")
    L.append("| endpoint | HTTP | status | note |")
    L.append("|---|---|---|---|")
    for ep, status, err, note in endpoint_results:
        if is_fail(status, err):
            mark = "❌"
        elif 400 <= status < 500:
            mark = "⚠️"
        else:
            mark = "✅"
        L.append(f"| `{ep}` | {status or '—'} | {mark} | {note} |")
    L.append("")

    with open(args.out, "w") as f:
        f.write("\n".join(L) + "\n")

    # ---- console summary + exit code ------------------------------------
    print(f"  feature-report: collectors {len(collectors)-len(collector_fail)}/{len(collectors)} ok, "
          f"endpoints {len(endpoint_results)-len(endpoint_fail)-len(endpoint_warn)}/{len(endpoint_results)} ok "
          f"({len(endpoint_warn)} warn)")
    for c in collector_fail:
        print(f"    ❌ collector {c.get('name')}: {(c.get('error') or '')[:160]}")
    for ep, status, err, note in endpoint_fail:
        print(f"    ❌ endpoint {ep}: HTTP {status} {note}")
    print(f"  report written: {args.out}")

    return 1 if (collector_fail or endpoint_fail) else 0


if __name__ == "__main__":
    sys.exit(main())
