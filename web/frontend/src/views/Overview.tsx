import { useEffect, useState, useCallback, useRef } from 'react'
import { RefreshCw, Sparkles, Zap } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtNum, fmtTime, scoreColor } from '../lib/utils'
import { Card, Section } from '../components/Card'
import { Badge } from '../components/Badge'
import { NodeCard } from '../components/NodeCard'
import { DataTable } from '../components/DataTable'
import { AlertDetailPanel } from '../components/AlertDetailPanel'
import type { Instance, Alert, AlertStats, HealthResponse } from '../types/api'

/* ── Loading skeleton ──────────────────────────────────────────────────── */
function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
        {[...Array(7)].map((_, i) => (
          <div key={i} className="h-14 bg-[var(--card)] rounded-lg border border-[var(--border)]" />
        ))}
      </div>
      <div className="h-32 bg-[var(--card)] rounded-lg border border-[var(--border)]" />
    </div>
  )
}

/* ── Alert Activity Strip ──────────────────────────────────────────────── */
function AlertActivityStrip({ onViewHistory }: { onViewHistory: () => void }) {
  const [stats, setStats] = useState<AlertStats | null>(null)
  useEffect(() => {
    api.alerts.stats(24).then(setStats).catch(() => {})
  }, [])

  if (!stats || stats.total_fired === 0) return null

  const fmtDur = (s: number) => {
    if (s <= 0) return null
    if (s < 3600) return `${Math.round(s / 60)}m avg`
    return `${Math.round(s / 3600)}h avg`
  }
  const dur = fmtDur(stats.avg_duration_secs)

  return (
    <button
      onClick={onViewHistory}
      className="w-full text-left rounded-lg border border-[var(--border)] bg-[var(--card)] hover:border-[var(--accent)]/40 transition-colors px-4 py-2.5 flex items-center gap-4 flex-wrap"
    >
      <span className="text-[10px] font-semibold text-[var(--dim)] uppercase tracking-widest">24h alert activity</span>
      <span className="flex items-center gap-1.5 text-[12px]">
        <span className="font-semibold">{stats.total_fired}</span>
        <span className="text-[var(--dim)]">fired</span>
      </span>
      {stats.currently_firing > 0 && (
        <span className="flex items-center gap-1.5 text-[12px] text-[#ef4444]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444] animate-pulse" />
          <span className="font-semibold">{stats.currently_firing}</span>
          <span className="opacity-70">firing now</span>
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[12px] text-[#22c55e]">
        <span className="font-semibold">{stats.resolved}</span>
        <span className="text-[var(--dim)]">resolved</span>
      </span>
      {dur && <span className="text-[12px] text-[var(--dim)]">{dur}</span>}
      {stats.top_categories[0] && (
        <span className="text-[12px] text-[var(--dim)]">
          top: <span className="text-[var(--text)]">{stats.top_categories[0].category}</span>
        </span>
      )}
      <span className="ml-auto text-[11px] text-[var(--accent)]">View history →</span>
    </button>
  )
}

/* ── Metric chip ─────────────────────────────────────────────────────── */
function MetricChip({
  label, value, valueColor, onClick, active,
}: {
  label: string
  value: string | number
  valueColor?: string
  onClick?: () => void
  active?: boolean
}) {
  return (
    <div
      className={`bg-[var(--card)] border rounded-lg px-4 py-3 flex flex-col justify-between ${
        onClick ? 'cursor-pointer hover:border-[var(--accent)]/40 transition-colors' : ''
      } ${active ? 'border-[var(--accent)]/40' : 'border-[var(--border)]'}`}
      onClick={onClick}
    >
      <div
        className="text-xl font-bold tabular-nums leading-tight"
        style={{ color: valueColor }}
      >
        {value}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)] mt-1">
        {label}
      </div>
    </div>
  )
}

/* ── Overview ────────────────────────────────────────────────────────── */
export default function Overview({ refreshKey }: { refreshKey?: number }) {
  const { setView, setInstance, setInstances, navToAlerts } = useStore()
  const [analyzeInstance, setAnalyzeInstance] = useState('')
  const { analyze } = useAIAnalysis(analyzeInstance)
  const handleAnalyze = useCallback((data: Record<string, any>) => {
    analyze('Overview', data, { contextType: 'tab', tab: 'overview' })
  }, [analyze])

  const [instances, setLocalInstances] = useState<Instance[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [manualRefreshTick, setManualRefreshTick] = useState(0)
  const [forcingPoll, setForcingPoll] = useState(false)
  const [forcePollMsg, setForcePollMsg] = useState('')
  const [healthData, setHealthData] = useState<HealthResponse | null>(null)
  const isFirstLoad = useRef(true)

  const handleForcePoll = useCallback(async () => {
    setForcingPoll(true)
    setForcePollMsg('')
    try {
      await api.forcePoll()
      setForcePollMsg('Polling now…')
      setTimeout(() => setManualRefreshTick(t => t + 1), 3000)
      setTimeout(() => setForcePollMsg(''), 5000)
    } catch {
      setForcePollMsg('Failed')
      setTimeout(() => setForcePollMsg(''), 3000)
    } finally {
      setForcingPoll(false)
    }
  }, [])

  const doLoad = useCallback(async () => {
    let cancelled = false
    if (isFirstLoad.current) setLoading(true)
    else setRefreshing(true)
    try {
      const [inst, alrt] = await Promise.all([
        api.overview(),
        api.alerts.active(),
      ])
      api.health().then(h => { if (!cancelled) setHealthData(h) }).catch(() => {})
      if (!cancelled) {
        setLocalInstances(inst)
        setAlerts(alrt)
        setInstances(inst.map(i => i.name))
        setLastRefreshed(new Date())
        if (inst.length > 0) {
          const worst = [...inst].sort((a, b) => a.health_score - b.health_score)[0]
          setAnalyzeInstance(worst.name)
        }
      }
    } catch {
      // silently handle
    } finally {
      if (!cancelled) {
        setLoading(false)
        setRefreshing(false)
        isFirstLoad.current = false
      }
    }
    return () => { cancelled = true }
  }, [setInstances])

  useEffect(() => {
    doLoad()
  }, [doLoad, refreshKey, manualRefreshTick])

  if (loading) return <Skeleton />

  /* ---- derived stats ---- */
  const totalInstances = instances.length
  const staleHours = (() => { try { return parseInt(localStorage.getItem('ch-stale-hours') ?? '24', 10) || 24 } catch { return 24 } })()
  const now = Date.now() / 1000
  const isFresh = (a: Alert) => !a.resolved && (now - (a.updated_at ?? a.created_at)) <= staleHours * 3600
  const freshAlerts = alerts.filter(isFresh)
  const staleCount = alerts.filter(a => !a.resolved && (now - (a.updated_at ?? a.created_at)) > staleHours * 3600).length

  const critFiring = freshAlerts.filter(a => a.severity === 'critical').length
  const warnFiring = freshAlerts.filter(a => a.severity === 'warn').length
  const infoFiring = freshAlerts.filter(a => a.severity !== 'critical' && a.severity !== 'warn').length

  const staleByInstance = new Map<string, number>()
  for (const a of alerts) {
    if (!a.resolved && (now - (a.updated_at ?? a.created_at)) > staleHours * 3600) {
      staleByInstance.set(a.instance, (staleByInstance.get(a.instance) ?? 0) + 1)
    }
  }

  const avgHealth = totalInstances > 0
    ? Math.round(instances.reduce((s, i) => s + i.health_score, 0) / totalInstances)
    : 0
  const runningQueries = instances.reduce((s, i) => s + (i.key_metrics?.['running_queries'] ?? 0), 0)
  const activeMerges = instances.reduce((s, i) => s + (i.key_metrics?.['active_merges'] ?? 0), 0)

  const goToInstance = (name: string) => {
    setInstance(name)
    setView('detail')
  }

  const alertCols = [
    { key: 'severity', label: 'Sev', format: (v: any) => <Badge severity={v} dot /> },
    { key: 'instance', label: 'Instance' },
    { key: 'category', label: 'Category' },
    { key: 'title', label: 'Title' },
    { key: 'created_at', label: 'Time', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(v)}</span> },
  ]

  return (
    <div className="space-y-0">
      {/* ── Header row ── */}
      <div className="flex items-center gap-3 pb-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--dim)] border border-[var(--border)]">current state</span>
          {lastRefreshed && (
            <span className="text-[11px] text-[var(--dim)]">as of {lastRefreshed.toLocaleTimeString()}</span>
          )}
        </div>
        <div className="flex-1" />
        {refreshing && (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--dim)]">
            <RefreshCw size={10} className="animate-spin" /> Refreshing…
          </div>
        )}
        <button
          onClick={() => setManualRefreshTick(t => t + 1)}
          disabled={refreshing}
          title="Re-fetches data from the database"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-[var(--dim)] hover:bg-[var(--hover)] border border-[var(--border)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          Refresh UI
        </button>
        <button
          onClick={handleForcePoll}
          disabled={forcingPoll}
          title="Runs all collectors immediately"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-orange-400 hover:bg-orange-500/15 border border-orange-500/25 transition-colors disabled:opacity-50"
        >
          <Zap size={10} className={forcingPoll ? 'animate-pulse' : ''} />
          {forcingPoll ? 'Polling…' : forcePollMsg || 'Force Poll'}
        </button>
        <button
          onClick={() => handleAnalyze({ instances, alerts, avgHealth, critFiring, warnFiring, infoFiring, staleCount, runningQueries, activeMerges })}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent-subtle)] border border-[var(--accent)]/20 transition-colors"
        >
          <Sparkles size={10} />
          Analyze
        </button>
      </div>

      {/* ── Metric strip ── */}
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
        <MetricChip label="Instances" value={totalInstances} />
        <MetricChip label="Avg Health" value={avgHealth} valueColor={scoreColor(avgHealth)} />
        <MetricChip label="Running Queries" value={fmtNum(runningQueries)} />
        <MetricChip label="Active Merges" value={fmtNum(activeMerges)} />
        <MetricChip
          label="Critical"
          value={critFiring}
          valueColor={critFiring > 0 ? '#ef4444' : undefined}
          onClick={() => critFiring > 0 ? navToAlerts({ severity: 'critical' }) : undefined}
          active={critFiring > 0}
        />
        <MetricChip
          label="Warning"
          value={warnFiring}
          valueColor={warnFiring > 0 ? '#eab308' : undefined}
          onClick={() => warnFiring > 0 ? navToAlerts({ severity: 'warn' }) : undefined}
          active={warnFiring > 0}
        />
        <MetricChip
          label={staleCount > 0 ? `Info (+${staleCount} stale)` : 'Info'}
          value={infoFiring}
          valueColor={infoFiring > 0 ? '#60a5fa' : undefined}
          onClick={() => infoFiring > 0 ? navToAlerts({ severity: 'info' }) : undefined}
          active={infoFiring > 0}
        />
      </div>

      {/* ── 24h Alert Activity ── */}
      <div className="pt-3">
        <AlertActivityStrip onViewHistory={() => setView('history')} />
      </div>

      {/* ── Instances section ── */}
      <Section
        title={`Instances · ${totalInstances}`}
        defaultOpen
        actions={
          <span className="text-[10px] text-[var(--dim)] mr-1">
            {healthData && (
              <span className={`inline-flex items-center gap-1 ${healthData.status === 'ok' ? 'text-green-400' : 'text-yellow-400'}`}>
                <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: healthData.status === 'ok' ? '#22c55e' : '#eab308' }} />
                v{healthData.version} · up {healthData.uptime}
              </span>
            )}
          </span>
        }
      >
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          {/* Table header */}
          <div className="grid bg-[var(--surface)] border-b border-[var(--border)] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)]"
            style={{ gridTemplateColumns: '16px 1fr 48px 280px 80px 100px 24px' }}
          >
            <span />
            <span>Instance</span>
            <span className="text-right">Health</span>
            <span className="hidden sm:block text-right pr-8">CPU / MEM / Queries / Merges</span>
            <span className="hidden md:block">Areas</span>
            <span className="text-right">Alerts</span>
            <span />
          </div>
          {instances.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-[var(--dim)] text-center">No instances configured</div>
          ) : (
            instances.map(inst => (
              <NodeCard
                key={inst.name}
                instance={inst}
                onClick={() => goToInstance(inst.name)}
                staleAlerts={staleByInstance.get(inst.name) ?? 0}
                onResolved={() => setManualRefreshTick(t => t + 1)}
                onSelectAlert={setSelectedAlert}
              />
            ))
          )}
        </div>
      </Section>

      {/* ── Active alerts ── */}
      {freshAlerts.length > 0 && (
        <Section
          title={`Active Alerts · ${freshAlerts.length}${staleCount > 0 ? ` (${staleCount} stale hidden)` : ''}`}
          defaultOpen={freshAlerts.length <= 20}
        >
          <Card noPad>
            <DataTable columns={alertCols} data={freshAlerts} pageSize={50} onRowClick={row => setSelectedAlert(row as Alert)} />
          </Card>
        </Section>
      )}

      {selectedAlert && (
        <AlertDetailPanel
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
        />
      )}
    </div>
  )
}
