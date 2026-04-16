import { useState, useCallback, useEffect } from 'react'
import { ChevronRight, RotateCcw, Wrench } from 'lucide-react'
import { flashToast } from '../lib/notify'
import { cn, scoreColor, sevColor, fmtTime } from '../lib/utils'
import { api } from '../lib/api'
import { Badge } from './Badge'
import { Sparkline } from './Sparkline'
import { useStore } from '../hooks/useStore'
import type { Instance } from '../types/api'

const STATUS_DOT: Record<string, string> = {
  ok: 'bg-green-500',
  warn: 'bg-yellow-500',
  critical: 'bg-red-500',
}

/* ── Mini alert expand inline ─────────────────────────────────────────── */
function AlertRow({
  alert,
  onResolve,
  resolving,
  onNav,
  onSelect,
}: {
  alert: any
  onResolve: (key: string) => void
  resolving: boolean
  onNav: () => void
  onSelect?: (alert: any) => void
}) {
  const [open, setOpen] = useState(false)
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onSelect) {
      onSelect(alert)
    } else {
      setOpen(o => !o)
    }
  }
  return (
    <div>
      <button
        onClick={handleClick}
        className="w-full flex items-center gap-2 text-[11px] text-left rounded hover:bg-[var(--hover)] px-2 py-1 transition-colors"
      >
        <Badge className={cn('border shrink-0', sevColor(alert.severity))}>
          {alert.severity === 'critical' ? 'CRIT' : alert.severity === 'warn' ? 'WARN' : 'INFO'}
        </Badge>
        <span className={cn('truncate flex-1', alert.possibly_recovered && 'opacity-60')}>
          {alert.title}
        </span>
        {alert.possibly_recovered && (
          <RotateCcw size={9} className="text-green-400 shrink-0" />
        )}
        <ChevronRight size={9} className={cn('text-[var(--dim)] shrink-0 transition-transform', !onSelect && open && 'rotate-90')} />
      </button>
      {!onSelect && open && (
        <div
          className="mx-2 mb-1 p-2 rounded bg-[var(--hover)] border border-[var(--border)] text-[11px] space-y-1.5"
          onClick={e => e.stopPropagation()}
        >
          <div className="text-[var(--dim)]">Fired: <span className="text-[var(--text)]">{fmtTime(alert.created_at)}</span></div>
          {alert.possibly_recovered && (
            <div className="flex items-center gap-1 text-green-400">
              <RotateCcw size={9} /> Metrics look OK — condition may have cleared
            </div>
          )}
          <div className="flex items-center gap-3 pt-0.5">
            <button onClick={e => { e.stopPropagation(); onNav() }} className="text-[var(--accent)] hover:underline">
              → Instance detail
            </button>
            {alert.dedup_key && (
              <button
                onClick={e => { e.stopPropagation(); onResolve(alert.dedup_key) }}
                disabled={resolving}
                className="text-green-400 hover:underline disabled:opacity-50"
              >
                {resolving ? 'Resolving…' : 'Mark resolved'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── NodeCard — compact list row ─────────────────────────────────────── */
export function NodeCard({
  instance,
  onClick,
  staleAlerts = 0,
  onResolved,
  onSelectAlert,
}: {
  instance: Instance
  onClick: () => void
  staleAlerts?: number
  onResolved?: () => void
  onSelectAlert?: (alert: any) => void
}) {
  const { navToDetail } = useStore()
  const [expanded, setExpanded] = useState(false)
  const [resolvingKey, setResolvingKey] = useState<string | null>(null)
  const [sparklines, setSparklines] = useState<{ cpu: number[]; mem: number[] } | null>(null)

  // Fetch sparkline data (1h, 20 points) — lazy, fires after mount
  useEffect(() => {
    let cancelled = false
    const now = Math.floor(Date.now() / 1000)
    const from = now - 3600
    Promise.all([
      api.metrics(instance.name, 'cpu_pct', from, now, 20),
      api.metrics(instance.name, 'memory_pct', from, now, 20),
    ]).then(([cpuResp, memResp]) => {
      if (cancelled) return
      const cpu = (cpuResp?.points ?? []).map((d: any) => Number(d?.value ?? 0))
      const mem = (memResp?.points ?? []).map((d: any) => Number(d?.value ?? 0))
      if (cpu.length >= 2 || mem.length >= 2) setSparklines({ cpu, mem })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [instance.name])

  const handleResolve = useCallback(async (dedupKey: string) => {
    setResolvingKey(dedupKey)
    try {
      await api.alerts.resolve(dedupKey)
      onResolved?.()
    } catch (e: any) {
      flashToast(e?.message ?? 'Failed to resolve alert', 'error')
    } finally {
      setResolvingKey(null)
    }
  }, [onResolved])

  const areas = instance.area_status ?? []
  const topAlerts = instance.top_alerts ?? []
  const counts = instance.alert_counts
  const freshAlerts = Math.max(0, instance.active_alerts - staleAlerts)

  const memPct = instance.key_metrics?.['memory_pct']
  const cpuPct = instance.key_metrics?.['cpu_pct']
  const runningQ = instance.key_metrics?.['running_queries']
  const activeMerges = instance.key_metrics?.['active_merges']

  const inMaint = instance.in_maintenance
  const maintUntil = instance.maintenance_until
    ? new Date(instance.maintenance_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  const hasAlerts = freshAlerts > 0 && counts

  return (
    <div
      className={cn(
        'border-b border-[var(--border)] last:border-0 bg-[var(--card)] transition-colors',
        inMaint && 'border-l-2 border-l-orange-500/50',
      )}
    >
      {/* Main row */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-[var(--hover)] group"
        onClick={onClick}
      >
        {/* Status dot */}
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: scoreColor(instance.health_score) }}
        />

        {/* Name */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="font-medium text-[13px] truncate" title={instance.name}>{instance.name}</span>
          {inMaint && (
            <span className="flex items-center gap-1 text-[10px] text-orange-400 bg-orange-500/10 rounded px-1.5 py-0.5 shrink-0" title={maintUntil ? `Until ${maintUntil}` : 'Maintenance'}>
              <Wrench size={9} /> {maintUntil ? `until ${maintUntil}` : 'maint'}
            </span>
          )}
        </div>

        {/* Health score */}
        <span
          className="text-[13px] font-bold tabular-nums w-7 text-right shrink-0"
          style={{ color: scoreColor(instance.health_score) }}
        >
          {instance.health_score}
        </span>

        {/* Key metrics */}
        <div className="hidden sm:flex items-center gap-4 shrink-0">
          {[
            { label: 'CPU', value: cpuPct != null ? `${cpuPct.toFixed(0)}%` : '—', warn: cpuPct != null && cpuPct > 80, crit: cpuPct != null && cpuPct > 95, sparkColor: '#f97316', sparkData: sparklines?.cpu },
            { label: 'MEM', value: memPct != null ? `${memPct.toFixed(0)}%` : '—', warn: memPct != null && memPct > 85, crit: memPct != null && memPct > 95, sparkColor: '#7c3aed', sparkData: sparklines?.mem },
            { label: 'Queries', value: runningQ != null ? String(Math.round(runningQ)) : '—', warn: false, crit: false, sparkColor: undefined, sparkData: undefined },
            { label: 'Merges', value: activeMerges != null ? String(Math.round(activeMerges)) : '—', warn: false, crit: false, sparkColor: undefined, sparkData: undefined },
          ].map(m => (
            <div key={m.label} className="text-right min-w-[48px]">
              {m.sparkData && m.sparkData.length >= 2 ? (
                <div className="flex items-end justify-end gap-1">
                  <div className={cn(
                    'text-[12px] font-semibold tabular-nums leading-tight',
                    m.crit ? 'text-red-400' : m.warn ? 'text-yellow-400' : 'text-[var(--text)]',
                  )}>{m.value}</div>
                  <Sparkline data={m.sparkData} color={m.sparkColor} width={36} height={16} fill />
                </div>
              ) : (
                <div className={cn(
                  'text-[12px] font-semibold tabular-nums leading-tight',
                  m.crit ? 'text-red-400' : m.warn ? 'text-yellow-400' : 'text-[var(--text)]',
                )}>{m.value}</div>
              )}
              <div className="text-[10px] text-[var(--dim)] uppercase tracking-wider">{m.label}</div>
            </div>
          ))}
        </div>

        {/* Area pills */}
        <div className="hidden md:flex items-center gap-1 shrink-0">
          {areas.slice(0, 6).map(a => (
            <span
              key={a.area}
              className={cn('w-2 h-2 rounded-full', STATUS_DOT[a.status] ?? 'bg-gray-500')}
              title={`${a.label}: ${a.status}`}
            />
          ))}
        </div>

        {/* Alert counts */}
        <div className="flex items-center gap-1.5 shrink-0 min-w-[60px] justify-end">
          {hasAlerts ? (
            <>
              {counts.crit > 0 && <span className="text-[11px] font-semibold text-red-400">{counts.crit}C</span>}
              {counts.warn > 0 && <span className="text-[11px] font-semibold text-yellow-400">{counts.warn}W</span>}
              {counts.info > 0 && <span className="text-[11px] font-semibold text-blue-400">{counts.info}I</span>}
            </>
          ) : (
            <span className="text-[11px] text-green-400">✓</span>
          )}
          {staleAlerts > 0 && freshAlerts === 0 && (
            <span className="text-[10px] text-[var(--dim)]">{staleAlerts}s</span>
          )}
        </div>

        {/* Expand toggle (only when there are alerts to show) */}
        {topAlerts.length > 0 && (
          <button
            className="p-1 rounded hover:bg-[var(--surface)] shrink-0"
            onClick={e => { e.stopPropagation(); setExpanded(o => !o) }}
            title={expanded ? 'Collapse alerts' : 'Expand alerts'}
          >
            <ChevronRight size={12} className={cn('text-[var(--dim)] transition-transform', expanded && 'rotate-90')} />
          </button>
        )}
        {topAlerts.length === 0 && <div className="w-[20px] shrink-0" />}
      </div>

      {/* Expanded alerts */}
      {expanded && topAlerts.length > 0 && (
        <div className="pb-2 bg-[var(--surface)]/50">
          {topAlerts.map((a, i) => (
            <AlertRow
              key={i}
              alert={a}
              onResolve={handleResolve}
              resolving={resolvingKey === a.dedup_key}
              onNav={() => navToDetail(instance.name)}
              onSelect={onSelectAlert}
            />
          ))}
        </div>
      )}
    </div>
  )
}
