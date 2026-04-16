import { useState, useCallback } from 'react'
import { ChevronRight, RotateCcw, Wrench } from 'lucide-react'
import { cn, scoreColor, sevColor, fmtTime } from '../lib/utils'
import { api } from '../lib/api'
import { Card } from './Card'
import { Badge } from './Badge'
import { useStore } from '../hooks/useStore'
import type { Instance } from '../types/api'

const statusDot: Record<string, string> = {
  ok: 'bg-green-500',
  warn: 'bg-yellow-500',
  critical: 'bg-red-500',
}

const statusRing: Record<string, string> = {
  ok: '',
  warn: 'ring-1 ring-yellow-500/30',
  critical: 'ring-1 ring-red-500/40 animate-pulse',
}

export function NodeCard({
  instance,
  onClick,
  staleAlerts = 0,
  onResolved,
}: {
  instance: Instance
  onClick: () => void
  staleAlerts?: number
  onResolved?: () => void
}) {
  const { navToDetail } = useStore()
  const [expandedAlert, setExpandedAlert] = useState<number | null>(null)
  const [resolvingKey, setResolvingKey] = useState<string | null>(null)

  const handleResolve = useCallback(async (e: React.MouseEvent, dedupKey: string) => {
    e.stopPropagation()
    setResolvingKey(dedupKey)
    try {
      await api.alerts.resolve(dedupKey)
      onResolved?.()
    } catch (err) {
      console.error('resolve failed', err)
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

  const handleAlertClick = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation()
    setExpandedAlert(expandedAlert === idx ? null : idx)
  }

  const handleAlertNav = (e: React.MouseEvent) => {
    e.stopPropagation()
    navToDetail(instance.name)
  }

  const inMaint = instance.in_maintenance
  const maintUntil = instance.maintenance_until
    ? new Date(instance.maintenance_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <Card onClick={onClick} className={cn("cursor-pointer hover:border-[var(--accent)]/40 transition-colors", inMaint && "border-orange-500/30")}>
      {/* Maintenance banner */}
      {inMaint && (
        <div className="flex items-center gap-1.5 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-lg px-2.5 py-1.5 mb-3">
          <Wrench size={11} className="shrink-0" />
          <span className="font-medium">Maintenance</span>
          {maintUntil && <span className="text-orange-400/70 ml-auto">until {maintUntil}</span>}
        </div>
      )}
      {/* Header: name + health score */}
      <div className="flex items-center justify-between mb-3">
        <div className="font-medium truncate">{instance.name}</div>
        <div className="flex items-center gap-2">
          {staleAlerts > 0 && freshAlerts === 0 && (
            <Badge className="bg-[var(--border)] text-[var(--dim)] border border-[var(--border)] text-xs">
              {staleAlerts} stale
            </Badge>
          )}
          <span
            className="text-lg font-bold tabular-nums"
            style={{ color: scoreColor(instance.health_score) }}
          >
            {instance.health_score}
          </span>
        </div>
      </div>

      {/* Key metrics row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        {[
          { label: 'Mem', value: memPct != null ? `${memPct.toFixed(0)}%` : '—', warn: memPct != null && memPct > 85, crit: memPct != null && memPct > 95 },
          { label: 'CPU', value: cpuPct != null ? `${cpuPct.toFixed(0)}%` : '—', warn: cpuPct != null && cpuPct > 80, crit: cpuPct != null && cpuPct > 95 },
          { label: 'Queries', value: runningQ != null ? String(Math.round(runningQ)) : '—', warn: false, crit: false },
          { label: 'Merges', value: activeMerges != null ? String(Math.round(activeMerges)) : '—', warn: false, crit: false },
        ].map(m => (
          <div key={m.label} className="text-center">
            <div className={cn(
              'text-sm font-semibold tabular-nums',
              m.crit ? 'text-red-400' : m.warn ? 'text-yellow-400' : 'text-[var(--text)]'
            )}>{m.value}</div>
            <div className="text-[10px] text-[var(--dim)] uppercase tracking-wider">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Area pills */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        {areas.map((a) => (
          <div
            key={a.area}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--hover)] text-xs"
            title={`${a.label}: ${a.status}`}
          >
            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', statusDot[a.status] ?? 'bg-gray-500', statusRing[a.status] ?? '')} />
            <span className="text-[var(--dim)]">{a.label}</span>
          </div>
        ))}
      </div>

      {/* Alert severity counts */}
      {freshAlerts > 0 && counts && (
        <div className="flex items-center gap-2 mb-2">
          {counts.crit > 0 && (
            <span className="text-xs font-medium text-red-400">{counts.crit} crit</span>
          )}
          {counts.warn > 0 && (
            <span className="text-xs font-medium text-yellow-400">{counts.warn} warn</span>
          )}
          {counts.info > 0 && (
            <span className="text-xs font-medium text-blue-400">{counts.info} info</span>
          )}
          {staleAlerts > 0 && (
            <span className="text-xs text-[var(--dim)]">+{staleAlerts} stale</span>
          )}
        </div>
      )}

      {/* Top alerts — individually expandable */}
      {topAlerts.length > 0 ? (
        <div className="space-y-1">
          {topAlerts.map((a, i) => (
            <div key={i}>
              <button
                onClick={(e) => handleAlertClick(e, i)}
                className="w-full flex items-start gap-2 text-xs text-left rounded hover:bg-[var(--hover)] px-1 py-0.5 transition-colors"
              >
                <Badge className={cn('border shrink-0 mt-0.5', sevColor(a.severity))}>
                  {a.severity === 'critical' ? 'CRIT' : a.severity === 'warn' ? 'WARN' : 'INFO'}
                </Badge>
                <span className={cn('truncate flex-1', a.possibly_recovered && 'opacity-60')}>
                  {a.title}
                </span>
                {a.possibly_recovered && (
                  <span title="Possibly recovered"><RotateCcw size={10} className="text-green-400 shrink-0 mt-0.5" /></span>
                )}
                <ChevronRight size={10} className={cn('text-[var(--dim)] shrink-0 mt-0.5 transition-transform', expandedAlert === i && 'rotate-90')} />
              </button>
              {expandedAlert === i && (
                <div
                  className="mx-1 mb-1 p-2 rounded bg-[var(--hover)] border border-[var(--border)] text-xs space-y-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="text-[var(--dim)]">
                    Fired: <span className="text-[var(--text)]">{fmtTime(a.created_at)}</span>
                  </div>
                  {a.possibly_recovered && (
                    <div className="flex items-center gap-1 text-green-400">
                      <RotateCcw size={10} />
                      Metrics look ok — condition may have cleared
                    </div>
                  )}
                  <div className="flex items-center gap-2 pt-0.5">
                    <button
                      onClick={handleAlertNav}
                      className="text-[var(--accent)] hover:underline"
                    >
                      → Instance detail
                    </button>
                    {a.dedup_key && (
                      <button
                        onClick={(e) => handleResolve(e, a.dedup_key)}
                        disabled={resolvingKey === a.dedup_key}
                        className="text-green-400 hover:underline disabled:opacity-50"
                      >
                        {resolvingKey === a.dedup_key ? 'Resolving…' : 'Mark resolved'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-green-400">All clear</div>
      )}
    </Card>
  )
}
