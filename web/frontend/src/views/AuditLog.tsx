import { useEffect, useState, useMemo } from 'react'
import { ClipboardList, CheckCircle, BellOff, Shield, Wrench, Search, XCircle } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { Card } from '../components/Card'
import type { AuditEvent } from '../types/api'

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const RANGE_OPTIONS = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
]

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'alert_resolve', label: 'Alert resolved' },
  { value: 'alert_snooze', label: 'Alert snoozed' },
  { value: 'snooze_delete', label: 'Snooze removed' },
  { value: 'alert_ack', label: 'Alert acknowledged' },
  { value: 'ack_delete', label: 'Ack removed' },
  { value: 'maintenance_create', label: 'Maintenance created' },
  { value: 'maintenance_delete', label: 'Maintenance ended' },
]

const ACTION_LABELS: Record<string, string> = {
  alert_resolve: 'Alert resolved',
  alert_snooze: 'Alert snoozed',
  snooze_delete: 'Snooze removed',
  alert_ack: 'Alert acknowledged',
  ack_delete: 'Ack removed',
  maintenance_create: 'Maintenance created',
  maintenance_delete: 'Maintenance ended',
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

type ActionIconName = 'resolve' | 'snooze' | 'ack' | 'maintenance' | 'default'

function actionIconType(action: string): ActionIconName {
  if (action === 'alert_resolve') return 'resolve'
  if (action === 'alert_snooze' || action === 'snooze_delete') return 'snooze'
  if (action === 'alert_ack' || action === 'ack_delete') return 'ack'
  if (action.startsWith('maintenance_')) return 'maintenance'
  return 'default'
}

function ActionIcon({ action }: { action: string }) {
  const type = actionIconType(action)
  const cls = 'w-4 h-4 shrink-0'
  if (type === 'resolve') return <CheckCircle className={cn(cls, 'text-[#22c55e]')} />
  if (type === 'snooze') return <BellOff className={cn(cls, 'text-[#f59e0b]')} />
  if (type === 'ack') return <Shield className={cn(cls, 'text-[#3b82f6]')} />
  if (type === 'maintenance') return <Wrench className={cn(cls, 'text-[#a78bfa]')} />
  return <ClipboardList className={cn(cls, 'text-[var(--text-muted)]')} />
}

function fmtTs(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
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
/*  AuditLog view                                                     */
/* ------------------------------------------------------------------ */

export default function AuditLog({ refreshKey }: { refreshKey?: number }) {
  const { instances } = useStore()
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [rangeHours, setRangeHours] = useState(24)
  const [instanceFilter, setInstanceFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [search, setSearch] = useState('')
  const [refreshTick, setRefreshTick] = useState(0)

  // Fetch audit events whenever range / instance / action filter / tick changes
  useEffect(() => {
    setLoading(true)
    setLoadError(null)
    const now = Math.floor(Date.now() / 1000)
    const from = now - rangeHours * 3600
    api.audit({
      from,
      to: now,
      instance: instanceFilter || undefined,
      action: actionFilter || undefined,
    })
      .then(data => { setEvents(data); setLastRefreshed(new Date()) })
      .catch((e: any) => { setEvents([]); setLoadError(e?.message ?? 'Failed to load audit log') })
      .finally(() => setLoading(false))
  }, [refreshKey, rangeHours, instanceFilter, actionFilter, refreshTick])

  // Auto-refresh every 60s
  useEffect(() => {
    const id = setInterval(() => {
      setRefreshTick(t => t + 1)
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  // Search filter applied in memory
  const filtered = useMemo(() => {
    if (!search) return events
    const q = search.toLowerCase()
    return events.filter(e =>
      e.action.toLowerCase().includes(q) ||
      e.actor.toLowerCase().includes(q) ||
      e.instance.toLowerCase().includes(q) ||
      e.details.toLowerCase().includes(q)
    )
  }, [events, search])

  // Group by day label
  const groups = useMemo(() => {
    const map = new Map<string, AuditEvent[]>()
    for (const ev of filtered) {
      const label = dayLabel(ev.ts)
      if (!map.has(label)) map.set(label, [])
      map.get(label)!.push(ev)
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, items }))
  }, [filtered])

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
          <ClipboardList className="w-5 h-5" /> Audit Log
        </h2>
        <div className="flex items-center gap-2">
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

      {/* Filter bar */}
      <Card className="p-3">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-1.5 flex-1 min-w-[180px] bg-[var(--hover)] rounded px-2 py-1.5">
            <Search className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0" />
            <input
              type="text"
              placeholder="Search action, actor, instance, details..."
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
            value={actionFilter}
            onChange={e => setActionFilter(e.target.value)}
            className="bg-[var(--hover)] rounded px-2 py-1.5 text-sm outline-none"
          >
            {ACTION_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <span className="ml-auto text-xs text-[var(--text-muted)]">
            {filtered.length} event{filtered.length !== 1 ? 's' : ''}
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
          <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <div className="text-sm">No audit events in this time range</div>
          {(instanceFilter || actionFilter || search) && (
            <button
              onClick={() => { setInstanceFilter(''); setActionFilter(''); setSearch('') }}
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
                {items.map(ev => (
                  <div
                    key={ev.id}
                    className="border border-[var(--border)] rounded-lg overflow-hidden hover:bg-[var(--hover)]/50 transition-colors"
                  >
                    <div className="flex items-start gap-3 p-3">
                      <ActionIcon action={ev.action} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">
                            {actionLabel(ev.action)}
                          </span>
                          <span className="text-xs text-[var(--text-muted)] bg-[var(--hover)] px-1.5 py-0.5 rounded">
                            {ev.instance}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-xs text-[var(--text-muted)]">by {ev.actor}</span>
                          {ev.details && (
                            <span className="text-xs text-[var(--dim)] truncate max-w-[400px]" title={ev.details}>
                              {ev.details}
                            </span>
                          )}
                          <span className="text-xs text-[var(--dim)] ml-auto shrink-0">{fmtTs(ev.ts)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
