import { useEffect, useState } from 'react'
import { useStore } from '../hooks/useStore'
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
function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <Card>
      <div className="text-3xl font-bold" style={{ color }}>{value}</div>
      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">{label}</div>
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
export default function Overview() {
  const { setView, setInstance, setInstances } = useStore()
  const [instances, setLocalInstances] = useState<Instance[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [inst, alrt] = await Promise.all([
          api.overview(),
          api.alerts.active(),
        ])
        if (!cancelled) {
          setLocalInstances(inst)
          setAlerts(alrt)
          setInstances(inst.map((i) => i.name))
        }
      } catch {
        // silently handle — user sees empty state
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [setInstances])

  if (loading) return <Skeleton />

  /* ---- derived stats ---- */
  const totalInstances = instances.length
  const staleHours = (() => { try { return parseInt(localStorage.getItem('ch-stale-hours') ?? '24', 10) || 24 } catch { return 24 } })()
  const now = Date.now() / 1000
  const freshFiring = alerts.filter((a) => !a.resolved && (now - (a.updated_at ?? a.created_at)) <= staleHours * 3600).length
  const staleCount = alerts.filter((a) => !a.resolved && (now - (a.updated_at ?? a.created_at)) > staleHours * 3600).length

  const staleByInstance = new Map<string, number>()
  for (const a of alerts) {
    if (!a.resolved && (now - (a.updated_at ?? a.created_at)) > staleHours * 3600) {
      staleByInstance.set(a.instance, (staleByInstance.get(a.instance) ?? 0) + 1)
    }
  }
  const firingAlerts = freshFiring
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
      <div className="text-xs text-[var(--dim)] bg-[var(--hover)] rounded-lg px-3 py-2 border border-[var(--border)]">
        Overview always shows <strong>current state</strong> — health scores, alerts, and metrics reflect right now.
        Use <strong>Detail</strong> or <strong>Explore</strong> to view historical data with the time range selector.
      </div>

      {/* ---- Stat cards ---- */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard label="Instances" value={totalInstances} />
        <StatCard
          label="Firing Alerts"
          value={staleCount > 0 ? `${firingAlerts} + ${staleCount}` : firingAlerts}
          color={firingAlerts > 0 ? '#ef4444' : staleCount > 0 ? '#9ca3af' : undefined}
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

      {/* ---- Active alerts table ---- */}
      {alerts.length > 0 && (
        <Card title="Active Alerts">
          <DataTable columns={alertCols} data={alerts} maxRows={30} />
        </Card>
      )}
    </div>
  )
}
