import { useEffect, useState, useMemo } from 'react'
import { Bell, CheckCircle, Clock, HelpCircle, Search, XCircle } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { AlertDetailPanel } from '../components/AlertDetailPanel'
import type { Alert, AlertStats } from '../types/api'

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const RANGE_OPTIONS = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
]

function fmtDuration(secs: number): string {
  if (secs <= 0) return '—'
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  const h = Math.floor(secs / 3600)
  const m = Math.round((secs % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function fmtTs(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function dayLabel(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/* ------------------------------------------------------------------ */
/*  Severity styling                                                  */
/* ------------------------------------------------------------------ */

const SEV_DOT: Record<string, string> = {
  critical: 'bg-[#ef4444]',
  warn: 'bg-[#f59e0b]',
  info: 'bg-[#3b82f6]',
}
const SEV_TEXT: Record<string, string> = {
  critical: 'text-[#ef4444]',
  warn: 'text-[#f59e0b]',
  info: 'text-[#3b82f6]',
}
const SEV_BORDER: Record<string, string> = {
  critical: 'border-[#ef4444]/25',
  warn: 'border-[#f59e0b]/25',
  info: 'border-[#3b82f6]/25',
}

/* ------------------------------------------------------------------ */
/*  NotifyStatusBanner — shows configured notification channels       */
/* ------------------------------------------------------------------ */

type NotifyStatusData = {
  slack: { configured: boolean; channel: string; has_token: boolean }
  pagerduty: { configured: boolean }
  webhook: { configured: boolean; url: string }
}

function NotifyStatusBanner() {
  const [status, setStatus] = useState<NotifyStatusData | null>(null)
  useEffect(() => {
    api.notifyStatus().then(setStatus).catch(() => {})
  }, [])
  if (!status) return null

  const channels = [
    { key: 'slack', label: 'Slack', configured: status.slack.configured, channel: status.slack.channel },
    { key: 'pagerduty', label: 'PagerDuty', configured: status.pagerduty.configured, channel: '' },
    { key: 'webhook', label: 'Webhook', configured: status.webhook.configured, channel: '' },
  ]
  const configured = channels.filter(c => c.configured)
  if (configured.length === 0) return null // don't clutter if nothing configured

  return (
    <div className="flex items-center gap-2 text-xs text-[var(--dim)]">
      <span>Channels:</span>
      {configured.map(ch => (
        <span key={ch.key} className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
          {ch.label}{ch.key === 'slack' && ch.channel ? ` ${ch.channel}` : ''}
        </span>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  AlertHistory view                                                 */
/* ------------------------------------------------------------------ */

export default function AlertHistory({ refreshKey }: { refreshKey?: number }) {
  const { instances, setView, navToDetail } = useStore()
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [rangeHours, setRangeHours] = useState(24)
  const [instanceFilter, setInstanceFilter] = useState('')
  const [severityFilter, setSeverityFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [search, setSearch] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  // Fetch history + stats whenever range / instance filter / tick changes
  useEffect(() => {
    setLoading(true)
    setLoadError(null)
    const now = Math.floor(Date.now() / 1000)
    const from = now - rangeHours * 3600
    Promise.all([
      api.alerts.history({ from, to: now, instance: instanceFilter || undefined }),
      api.alerts.stats(rangeHours),
    ])
      .then(([h, s]) => { setAlerts(h); setStats(s); setLastRefreshed(new Date()) })
      .catch((e: any) => { setAlerts([]); setStats(null); setLoadError(e?.message ?? 'Failed to load alert history') })
      .finally(() => setLoading(false))
  }, [refreshKey, rangeHours, instanceFilter, refreshTick])

  // Auto-refresh every 60s
  useEffect(() => {
    const id = setInterval(() => {
      setRefreshTick(t => t + 1)
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  // Severity / category / search / active filters applied in memory
  const filtered = useMemo(() => {
    let out = alerts
    if (activeOnly) out = out.filter(a => !a.resolved)
    if (severityFilter) out = out.filter(a => a.severity === severityFilter)
    if (categoryFilter) out = out.filter(a => a.category === categoryFilter)
    if (search) {
      const q = search.toLowerCase()
      out = out.filter(a =>
        a.title.toLowerCase().includes(q) ||
        a.message.toLowerCase().includes(q) ||
        a.instance.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
      )
    }
    return out
  }, [alerts, activeOnly, severityFilter, categoryFilter, search])

  // Group by day label
  const groups = useMemo(() => {
    const map = new Map<string, Alert[]>()
    for (const a of filtered) {
      const label = dayLabel(a.created_at)
      if (!map.has(label)) map.set(label, [])
      map.get(label)!.push(a)
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, items }))
  }, [filtered])

  const allCategories = useMemo(() => {
    const cats = new Set(alerts.map(a => a.category))
    return Array.from(cats).sort()
  }, [alerts])

  return (
    <div className="space-y-4">
      {loadError && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-400">
          <XCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{loadError}</span>
          <button onClick={() => setLoadError(null)} className="text-xs hover:underline opacity-70 shrink-0">Dismiss</button>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Bell className="w-5 h-5" /> Alert History
          <button onClick={() => setView('discover')} title="About alert severity levels" className="text-[var(--dim)] hover:text-[var(--text)] transition-colors">
            <HelpCircle size={13} />
          </button>
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <NotifyStatusBanner />
          {lastRefreshed && !loading && (
            <span className="text-[11px] text-[var(--dim)] hidden sm:block">
              Updated {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <div className="flex items-center gap-1">
            {RANGE_OPTIONS.map(o => (
              <button
                key={o.hours}
                onClick={() => setRangeHours(o.hours)}
                className={cn(
                  'px-3 py-1 rounded text-sm font-medium transition-colors',
                  rangeHours === o.hours
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--hover)] text-[var(--text-muted)] hover:text-[var(--text)]'
                )}
              >{o.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Stats strip */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <Card className="p-3">
            <div className="text-xl font-bold">{stats.total_fired}</div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">Total fired</div>
          </Card>
          <Card className="p-3">
            <div className={cn('text-xl font-bold', stats.currently_firing > 0 && 'text-[#ef4444]')}>
              {stats.currently_firing}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">Firing now</div>
          </Card>
          <Card className="p-3">
            <div className="text-xl font-bold text-[#22c55e]">{stats.resolved}</div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">Resolved</div>
          </Card>
          <Card className="p-3">
            <div className={cn('text-xl font-bold', stats.critical > 0 && 'text-[#ef4444]')}>
              {stats.critical}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">Critical</div>
          </Card>
          <Card className="p-3">
            <div className="text-xl font-bold">
              {stats.avg_duration_secs > 0 ? fmtDuration(Math.round(stats.avg_duration_secs)) : '—'}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">Avg duration</div>
          </Card>
          <Card className="p-3">
            <div className="text-xl font-bold truncate" title={stats.top_categories[0]?.category}>
              {stats.top_categories[0]?.category ?? '—'}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">Top category</div>
          </Card>
        </div>
      )}

      {/* Filter bar */}
      <Card className="p-3">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-1.5 flex-1 min-w-[180px] bg-[var(--hover)] rounded px-2 py-1.5">
            <Search className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0" />
            <input
              type="text"
              placeholder="Search title, message, instance..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-[var(--text-muted)] hover:text-[var(--text)]">
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <select
            value={instanceFilter}
            onChange={e => setInstanceFilter(e.target.value)}
            className="bg-[var(--hover)] rounded px-2 py-1.5 text-sm outline-none"
          >
            <option value="">All instances</option>
            {instances.map(i => <option key={i} value={i}>{i}</option>)}
          </select>

          <select
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value)}
            className="bg-[var(--hover)] rounded px-2 py-1.5 text-sm outline-none"
          >
            <option value="">All severity</option>
            <option value="critical">Critical</option>
            <option value="warn">Warning</option>
            <option value="info">Info</option>
          </select>

          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="bg-[var(--hover)] rounded px-2 py-1.5 text-sm outline-none"
          >
            <option value="">All categories</option>
            {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={e => setActiveOnly(e.target.checked)}
              className="rounded"
            />
            Firing only
          </label>

          <span className="ml-auto text-xs text-[var(--text-muted)]">
            {filtered.length} alert{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
      </Card>

      {/* Timeline */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 rounded-lg bg-[var(--hover)] animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-10 text-center text-[var(--text-muted)]">
          <Bell className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <div className="text-sm">No alerts in this time range</div>
          {(severityFilter || categoryFilter || search || activeOnly) && (
            <button
              onClick={() => { setSeverityFilter(''); setCategoryFilter(''); setSearch(''); setActiveOnly(false) }}
              className="mt-2 text-xs text-[var(--accent)] hover:underline"
            >Clear filters</button>
          )}
        </Card>
      ) : (
        <div className="space-y-5">
          {groups.map(({ label, items }) => (
            <div key={label}>
              <div className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2 px-1">
                {label} <span className="font-normal normal-case">({items.length})</span>
              </div>
              <div className="space-y-1">
                {items.map(alert => (
                  <div
                    key={alert.id}
                    className={cn(
                      'border rounded-lg overflow-hidden transition-colors cursor-pointer hover:bg-[var(--hover)]/50',
                      SEV_BORDER[alert.severity] ?? 'border-[var(--border)]',
                    )}
                    onClick={() => setSelectedAlert(alert)}
                  >
                    <div className="flex items-start gap-3 p-3">
                      <div className={cn(
                        'w-2 h-2 rounded-full mt-[5px] flex-shrink-0',
                        SEV_DOT[alert.severity] ?? 'bg-[var(--text-muted)]'
                      )} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={cn('text-sm font-medium truncate', SEV_TEXT[alert.severity])} title={alert.title}>
                            {alert.title}
                          </span>
                          {alert.resolved ? (
                            <span className="flex items-center gap-0.5 text-xs text-[#22c55e]">
                              <CheckCircle className="w-3 h-3" /> resolved
                            </span>
                          ) : (
                            <span className="text-xs font-medium text-[#ef4444]">firing</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-xs text-[var(--text-muted)]">{alert.instance}</span>
                          <Badge className="text-[var(--dim)] border-[var(--border)]">{alert.category}</Badge>
                          <span className="text-xs text-[var(--text-muted)]">{fmtTs(alert.created_at)}</span>
                          {alert.duration_s > 0 && (
                            <span className="text-xs text-[var(--text-muted)] flex items-center gap-0.5">
                              <Clock className="w-3 h-3" />
                              {fmtDuration(alert.duration_s)}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="text-[10px] text-[var(--dim)] shrink-0">→</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {selectedAlert && (
        <AlertDetailPanel
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
          onNavToInstance={name => { navToDetail(name); setSelectedAlert(null) }}
        />
      )}
    </div>
  )
}
