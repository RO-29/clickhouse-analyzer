import { useEffect, useState, useCallback, useRef } from 'react'
import { Sparkles, RefreshCw } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtNum, fmtTime, scoreColor } from '../lib/utils'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { NodeCard } from '../components/NodeCard'
import { DataTable } from '../components/DataTable'
import type { Instance, Alert } from '../types/api'

/* ------------------------------------------------------------------ */
/*  Stat Card                                                         */
/* ------------------------------------------------------------------ */
function StatCard({ label, value, color, sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <Card>
      <div className="text-3xl font-bold" style={{ color }}>{value}</div>
      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">{label}</div>
      {sub && <div className="text-xs text-[var(--dim)] mt-0.5">{sub}</div>}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Loading skeleton                                                  */
/* ------------------------------------------------------------------ */
function Skeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-5 gap-4">
        {[...Array(5)].map((_, i) => (
          <Card key={i}>
            <div className="h-9 bg-[var(--hover)] rounded w-1/2 mb-2" />
            <div className="h-3 bg-[var(--hover)] rounded w-2/3" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <Card key={i}>
            <div className="h-12 bg-[var(--hover)] rounded w-1/3 mb-2" />
            <div className="h-3 bg-[var(--hover)] rounded w-1/2" />
          </Card>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Overview view                                                     */
/* ------------------------------------------------------------------ */
export default function Overview({ refreshKey }: { refreshKey?: number }) {
  const { setView, setInstance, setInstances } = useStore()
  // Pick the worst-health instance for analysis (so the analyze call has a valid instance)
  const [analyzeInstance, setAnalyzeInstance] = useState('')
  const { analyze } = useAIAnalysis(analyzeInstance)
  const handleAnalyze = useCallback((data: Record<string, any>) => {
    analyze('Overview', data, { contextType: 'tab', tab: 'overview' })
  }, [analyze])
  const [instances, setLocalInstances] = useState<Instance[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const isFirstLoad = useRef(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (isFirstLoad.current) {
        setLoading(true)
      } else {
        setRefreshing(true)
      }
      try {
        const [inst, alrt] = await Promise.all([
          api.overview(),
          api.alerts.active(),
        ])
        if (!cancelled) {
          setLocalInstances(inst)
          setAlerts(alrt)
          setInstances(inst.map((i) => i.name))
          // Pick worst-health instance for the analyze button
          if (inst.length > 0) {
            const worst = [...inst].sort((a, b) => a.health_score - b.health_score)[0]
            setAnalyzeInstance(worst.name)
          }
        }
      } catch {
        // silently handle — user sees empty state
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
          isFirstLoad.current = false
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [setInstances, refreshKey])

  if (loading) return <Skeleton />

  /* ---- derived stats ---- */
  const totalInstances = instances.length
  const staleHours = (() => { try { return parseInt(localStorage.getItem('ch-stale-hours') ?? '24', 10) || 24 } catch { return 24 } })()
  const now = Date.now() / 1000
  const isFresh = (a: Alert) => !a.resolved && (now - (a.updated_at ?? a.created_at)) <= staleHours * 3600
  const freshAlerts = alerts.filter(isFresh)
  const staleCount = alerts.filter((a) => !a.resolved && (now - (a.updated_at ?? a.created_at)) > staleHours * 3600).length

  // Severity breakdown for fresh (non-stale, non-resolved) alerts
  const critFiring = freshAlerts.filter((a) => a.severity === 'critical').length
  const warnFiring = freshAlerts.filter((a) => a.severity === 'warn').length
  const infoFiring = freshAlerts.filter((a) => a.severity !== 'critical' && a.severity !== 'warn').length

  const staleByInstance = new Map<string, number>()
  for (const a of alerts) {
    if (!a.resolved && (now - (a.updated_at ?? a.created_at)) > staleHours * 3600) {
      staleByInstance.set(a.instance, (staleByInstance.get(a.instance) ?? 0) + 1)
    }
  }
  const firingAlerts = freshAlerts.length
  // Worst severity color: red if any critical, yellow if any warn, blue if only info
  const firingColor = critFiring > 0 ? '#ef4444' : warnFiring > 0 ? '#eab308' : infoFiring > 0 ? '#3b82f6' : undefined
  // Build breakdown sub-label
  const firingParts: string[] = []
  if (critFiring > 0) firingParts.push(`${critFiring} crit`)
  if (warnFiring > 0) firingParts.push(`${warnFiring} warn`)
  if (infoFiring > 0) firingParts.push(`${infoFiring} info`)
  const firingSub = firingAlerts > 0 ? firingParts.join(' · ') : undefined

  const avgHealth =
    totalInstances > 0
      ? Math.round(instances.reduce((s, i) => s + i.health_score, 0) / totalInstances)
      : 0
  const runningQueries = instances.reduce(
    (s, i) => s + (i.key_metrics?.['running_queries'] ?? i.key_metrics?.['Query'] ?? 0),
    0,
  )
  const activeMerges = instances.reduce(
    (s, i) => s + (i.key_metrics?.['active_merges'] ?? i.key_metrics?.['Merge'] ?? 0),
    0,
  )

  /* ---- click handler for instance cards ---- */
  const goToInstance = (name: string) => {
    setInstance(name)
    setView('detail')
  }

  /* ---- alert table columns (using DataTable format API: format receives cell value) ---- */
  const alertCols = [
    {
      key: 'severity',
      label: 'Severity',
      format: (v: any) => <Badge severity={v} />,
    },
    { key: 'instance', label: 'Instance' },
    { key: 'category', label: 'Category' },
    { key: 'title', label: 'Title' },
    {
      key: 'created_at',
      label: 'Time',
      format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(v)}</span>,
    },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Current state notice ---- */}
      <div className="flex items-center gap-3">
        <div className="flex-1 text-xs text-[var(--dim)] bg-[var(--hover)] rounded-lg px-3 py-2 border border-[var(--border)]">
          Overview always shows <strong>current state</strong> — health scores, alerts, and metrics reflect right now.
          Use <strong>Detail</strong> or <strong>Explore</strong> to view historical data with the time range selector.
        </div>
        {refreshing && (
          <div className="flex items-center gap-1.5 text-xs text-[var(--dim)] shrink-0">
            <RefreshCw size={11} className="animate-spin" />
            Refreshing…
          </div>
        )}
        <button
          onClick={() => handleAnalyze({ instances, alerts, avgHealth, firingAlerts, staleCount, runningQueries, activeMerges })}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 transition-colors shrink-0"
        >
          <Sparkles size={11} />
          Analyze
        </button>
      </div>

      {/* ---- Stat cards ---- */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard label="Instances" value={totalInstances} />
        <StatCard
          label="Firing Alerts"
          value={firingAlerts}
          color={firingColor}
          sub={firingSub ?? (staleCount > 0 ? `+${staleCount} stale` : undefined)}
        />
        <StatCard label="Avg Health" value={avgHealth} color={scoreColor(avgHealth)} />
        <StatCard label="Running Queries" value={fmtNum(runningQueries)} />
        <StatCard label="Active Merges" value={fmtNum(activeMerges)} />
      </div>

      {/* ---- Instance node cards with area triage ---- */}
      <div className="grid grid-cols-2 gap-4">
        {instances.map((inst) => (
          <NodeCard
            key={inst.name}
            instance={inst}
            onClick={() => goToInstance(inst.name)}
            staleAlerts={staleByInstance.get(inst.name) ?? 0}
          />
        ))}
      </div>

      {/* ---- Active alerts table (fresh only — no stale/resolved) ---- */}
      {freshAlerts.length > 0 && (
        <Card title={`Active Alerts${staleCount > 0 ? ` · ${staleCount} stale hidden` : ''}`}>
          <DataTable columns={alertCols} data={freshAlerts} maxRows={30} />
        </Card>
      )}
    </div>
  )
}
