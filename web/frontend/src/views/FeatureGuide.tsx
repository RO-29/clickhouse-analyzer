import { HelpCircle } from 'lucide-react'
import { useStore, type View } from '../hooks/useStore'

type Link = { to: View; label: string }

type Section = {
  title: string
  blurb: string
  links?: Link[]
  bullets: (string | { text: string; links?: Link[] })[]
}

const WHATS_NEW: Section[] = [
  {
    title: "What's new",
    blurb: 'Recent shipping highlights — most visible changes from the last few weeks.',
    bullets: [
      'Alert counts reconciled across Overview, Alerts, and Instance pages. Server-side stale filter (?stale_hours) honors your ch-stale-hours setting.',
      'Reconcile loop is the single writer to the alerts table. A partial collector failure no longer auto-resolves alerts on that instance.',
      'Query Log tab in Explore — free-form browse of every query in range with search, offset paging, and table filtering.',
      'Connections tab shows who is talking to CH right now (IP, interface, user agent) plus per-client forensics + session_log events.',
      'Tables tab in Explore + CPU/load columns in Query Patterns, Samples, and Live Queries.',
      'query_samples retention bumped 30d → 365d so long-range forensics work.',
      'Playbook SQL in alerts audited end-to-end — windows and filters now match the triggering condition.',
      'Memory chart now shows Host Total as a 4th line, plain-English labels (CH RSS / OS Available / CH Tracked / Host Total), and per-series hover tooltips. Empty or all-zero series auto-hide on managed CH builds.',
      'Restart detection: when uptime() regresses, a "ClickHouse restarted" (or "crashed") alert fires with embedded playbook SQL for the 10 min before the restart (exceptions, OOMs, heaviest queries, system.crash_log). Detail page shows a "N restarts in 7d" chip.',
      'Ingest backpressure alerts: DelayedInserts (CH sleeping inserts), PendingAsyncInsert (queued for flush), RejectedInserts (TOO_MANY_PARTS). Three separate alerts so you see which mode triggered.',
      'Parts/partitions ceilings: cluster-wide active parts (default 30k), per-table partition count (1.2k), max parts in any single partition (1k). Alerts include the worst offenders inline plus an OPTIMIZE hint.',
      'Merges-stalled detector: alert when active merges drop below 30 *while* the cluster has >1k active parts — the prelude to a TooManyParts incident. Quiet clusters stay silent.',
      'DDL migrations removed from Go — schema.sql is the single source of truth.',
    ],
  },
]

const FEATURE_MAP: Section[] = [
  {
    title: 'Monitoring & triage',
    blurb: 'Health at a glance and drill-down into a single instance.',
    links: [
      { to: 'overview', label: 'Overview' },
      { to: 'detail', label: 'Instance Detail' },
      { to: 'compare', label: 'Compare' },
    ],
    bullets: [
      'Overview: per-node cards with health score, active alerts (fresh-filtered), key metrics, and maintenance indicator.',
      'Detail: active + stale alerts, 24h alert events strip, in-range alert table, metrics, disks, MVs, replication, cache stats, and analyze button.',
      'Compare: pick N instances, diff metrics side-by-side, per-element AI analysis.',
    ],
  },
  {
    title: 'Alerts',
    blurb: 'Firing / stale / resolved with dedup, snooze, ack, inhibition, escalation.',
    links: [
      { to: 'alerts', label: 'Alerts' },
      { to: 'history', label: 'Alert History' },
      { to: 'thresholds', label: 'Thresholds' },
      { to: 'maintenance', label: 'Maintenance' },
    ],
    bullets: [
      'Alerts page: stat cards (firing / stale / resolved / snoozed) read from the unfiltered set so numbers match the counter row.',
      'Snoozed alerts stay in the Firing list with a "Snoozed until…" badge — the count on the card matches the list.',
      'History view: full audit trail with filters, grouping, and time-range replay.',
      'Thresholds editor: per-category warn/critical overrides, live-editable.',
      'Maintenance windows: suppress alerts for a specific instance or all nodes.',
    ],
  },
  {
    title: 'Query forensics',
    blurb: 'Everything you need to chase a slow/broken query.',
    links: [
      { to: 'explore', label: 'Explore' },
      { to: 'scanner', label: 'Table Scanner' },
      { to: 'advisor', label: 'Advisor' },
    ],
    bullets: [
      'Explore → Query Patterns / Samples / Live Queries: normalized hash, avg/total CPU ms, tables touched.',
      'Explore → Query Log: free-form search over 365 days of sampled queries with offset paging and table filter.',
      'Explore → Tables: per-table query load and CPU share (derived from query_samples).',
      'Explore → Connections: live client list + historical connection count + per-client query trace.',
      'Table Scanner: full modal with AI-backed insights per table.',
      'Advisor: anti-pattern detection, compression / TTL / projection recommendations.',
    ],
  },
  {
    title: 'Analysis & assistants',
    blurb: 'AI-driven triage and a chat analyzer with tool-use.',
    links: [
      { to: 'analyzer', label: 'AI Analyzer' },
      { to: 'runcheck', label: 'Run Checks' },
    ],
    bullets: [
      'AI Analyzer: agentic chat against a live instance with tools for metrics, query logs, schema, and alerts.',
      'Run Checks: on-demand diagnostics + force-poll (immediately runs a collection + reconcile cycle).',
      'Per-element AI buttons on the Compare view.',
    ],
  },
  {
    title: 'Ops & platform',
    blurb: 'Everything behind the scenes.',
    links: [
      { to: 'cost', label: 'Cost Explorer' },
      { to: 'terminal', label: 'Terminal' },
      { to: 'logs', label: 'App Logs' },
      { to: 'chlogs', label: 'CH Logs' },
      { to: 'audit', label: 'Audit Log' },
    ],
    bullets: [
      'Cost Explorer: per-instance / per-table spend estimate driven by AltinityConfig + actual usage.',
      'Terminal: run arbitrary SQL with abort, history, and CodeMirror SQL editor.',
      'App Logs / CH Logs: stream the right log source without leaving the UI.',
      'Audit Log: who changed what (ack, snooze, resolve, maintenance, thresholds).',
    ],
  },
  {
    title: 'Integrations',
    blurb: 'Set up once, they keep working.',
    bullets: [
      'Slack: per-instance grouping, pinned dashboard, slash commands, interactive snooze/ack buttons.',
      'PagerDuty + generic webhook for alert fire / resolve.',
      'Prometheus exporter for all collected metrics.',
      'Inhibition, escalation, and circuit breaker for flaky instances.',
    ],
  },
]

const KEYS: [string, string][] = [
  ['?', 'Open this feature guide'],
  ['Cmd/Ctrl + K', 'Command palette'],
  ['j / k', 'Navigate rows in tables'],
  ['Enter', 'Select focused row'],
  ['Esc', 'Close modal / panel'],
]

export default function FeatureGuide() {
  const { setView } = useStore()

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <div className="flex items-center gap-2 text-[var(--dim)] text-[11px] uppercase tracking-widest">
          <HelpCircle size={14} />
          Feature guide
        </div>
        <h1 className="text-2xl font-semibold mt-2">ch-analyzer, end to end</h1>
        <p className="text-sm text-[var(--dim)] mt-2 leading-relaxed">
          A map of what this app can do, where it lives in the UI, and what changed recently.
          Click any page link to jump there. Press <kbd className="font-mono text-[10px] px-1.5 py-0.5 bg-[var(--surface)] border border-[var(--border)] rounded">?</kbd> anywhere to come back.
        </p>
      </div>

      {WHATS_NEW.map(section => (
        <SectionBlock key={section.title} section={section} onNav={setView} accent />
      ))}

      {FEATURE_MAP.map(section => (
        <SectionBlock key={section.title} section={section} onNav={setView} />
      ))}

      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-5">
        <h2 className="text-sm font-semibold mb-1">Keyboard shortcuts</h2>
        <p className="text-xs text-[var(--dim)] mb-4">Work anywhere in the app.</p>
        <div className="divide-y divide-[var(--border)]">
          {KEYS.map(([k, desc]) => (
            <div key={k} className="flex items-center justify-between py-2 text-xs">
              <span className="text-[var(--dim)]">{desc}</span>
              <kbd className="font-mono text-[10px] px-2 py-0.5 bg-[var(--surface)] border border-[var(--border)] rounded">{k}</kbd>
            </div>
          ))}
        </div>
      </div>

      <div className="text-[11px] text-[var(--dim)] text-center pt-4 pb-8">
        Missing a feature? Open an issue at github.com/RO-29/ch-analyzer/issues.
      </div>
    </div>
  )
}

function SectionBlock({ section, onNav, accent }: { section: Section; onNav: (v: View) => void; accent?: boolean }) {
  return (
    <div className={`bg-[var(--card)] border rounded-lg p-5 ${accent ? 'border-[var(--accent)]/30' : 'border-[var(--border)]'}`}>
      <h2 className="text-sm font-semibold">{section.title}</h2>
      <p className="text-xs text-[var(--dim)] mt-1 mb-3">{section.blurb}</p>
      {section.links && section.links.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {section.links.map(l => (
            <button
              key={l.to}
              onClick={() => onNav(l.to)}
              className="text-[10px] uppercase tracking-wide px-2 py-1 rounded border border-[var(--border)] text-[var(--dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]/50 transition-colors"
            >
              {l.label} →
            </button>
          ))}
        </div>
      )}
      <ul className="space-y-1.5 text-xs leading-relaxed text-[var(--text)]">
        {section.bullets.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-[var(--dim)] shrink-0">•</span>
            <span>{typeof b === 'string' ? b : b.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
