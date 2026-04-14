import { useEffect, useState, useCallback, useRef } from 'react'
import { RefreshCw, Sparkles, Zap } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtNum, fmtTime, scoreColor } from '../lib/utils'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { NodeCard } from '../components/NodeCard'
import { DataTable } from '../components/DataTable'
import type { Instance, Alert, HealthResponse } from '../types/api'

/* ------------------------------------------------------------------ */
/*  Loading skeleton                                                  */
/* ------------------------------------------------------------------ */
function Skeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {[...Array(7)].map((_, i) => (
          <Card key={i}>
            <div className="h-8 bg-[var(--hover)] rounded w-1/2 mb-2" />
            <div className="h-3 bg-[var(--hover)] rounded w-2/3" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i}>
            <div className="h-24 bg-[var(--hover)] rounded" />
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
  const { setView, setInstance, setInstances, navToAlerts } = useStore()
  const [analyzeInstance, setAnalyzeInstance] = useState('')
  const { analyze } = useAIAnalysis(analyzeInstance)
  const handleAnalyze = useCallback((data: Record<string, any>) => {
    analyze('Overview', data, { contextType: 'tab', tab: 'overview' })
  }, [analyze])

  const [instances, setLocalInstances] = useState<Instance[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [manualRefreshTick, setManualRefreshTick] = useState(0)
  const [forcingPoll, setForcingPoll] = useState(false)
  const [forcePollMsg, setForcePollMsg] = useState('')

  const handleForcePoll = useCallback(async () => {
    setForcingPoll(true)
    setForcePollMsg('')
    try {
      await api.forcePoll()
      setForcePollMsg('Polling now…')
      // auto-refresh UI after a short delay so results appear
      setTimeout(() => setManualRefreshTick(t => t + 1), 3000)
      setTimeout(() => setForcePollMsg(''), 5000)
    } catch {
      setForcePollMsg('Failed')
      setTimeout(() => setForcePollMsg(''), 3000)
    } finally {
      setForcingPoll(false)
    }
  }, [])
  const isFirstLoad = useRef(true)
  const [healthData, setHealthData] = useState<HealthResponse | null>(null)

  const doLoad = useCallback(async (isManual = false) => {
    let cancelled = false
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
      // Health is optional — older deploys may not have it
      api.health().then(h => { if (!cancelled) setHealthData(h) }).catch(() => {})
      if (!cancelled) {
        setLocalInstances(inst)
        setAlerts(alrt)
        setInstances(inst.map((i) => i.name))
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
  const staleCount = alerts.filter((a) => !a.resolved && (now - (a.updated_at ?? a.created_at)) > staleHours * 3600).length

  const critFiring = freshAlerts.filter((a) => a.severity === 'critical').length
  const warnFiring = freshAlerts.filter((a) => a.severity === 'warn').length
  const infoFiring = freshAlerts.filter((a) => a.severity !== 'critical' && a.severity !== 'warn').length

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
    { key: 'severity', label: 'Sev', format: (v: any) => <Badge severity={v} /> },
    { key: 'instance', label: 'Instance' },
    { key: 'category', label: 'Category' },
    { key: 'title', label: 'Title' },
    { key: 'created_at', label: 'Time', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(v)}</span> },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header: current state label + refresh ---- */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text)]">Overview</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--hover)] text-[var(--dim)] border border-[var(--border)]">current state</span>
          {lastRefreshed && (
            <span className="text-xs text-[var(--dim)]">as of {lastRefreshed.toLocaleTimeString()}</span>
          )}
        </div>
        <div className="flex-1" />
        {refreshing && (
          <div className="flex items-center gap-1.5 text-xs text-[var(--dim)]">
            <RefreshCw size={11} className="animate-spin" />
            Refreshing…
          </div>
        )}
        <button
          onClick={() => setManualRefreshTick(t => t + 1)}
          disabled={refreshing}
          title="Re-fetches data from the database. Does NOT run collectors."
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-[var(--dim)] hover:bg-[var(--hover)] border border-[var(--border)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          Refresh UI
        </button>
        <button
          onClick={handleForcePoll}
          disabled={forcingPoll}
          title="Runs all collectors immediately and updates Alerts + Slack. Use this to see results right now without waiting for the next poll cycle."
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-orange-400 hover:bg-orange-500/15 border border-orange-500/25 transition-colors disabled:opacity-50"
        >
          <Zap size={11} className={forcingPoll ? 'animate-pulse' : ''} />
          {forcingPoll ? 'Polling…' : forcePollMsg || 'Force Poll'}
        </button>
        <button
          onClick={() => handleAnalyze({ instances, alerts, avgHealth, critFiring, warnFiring, infoFiring, staleCount, runningQueries, activeMerges })}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 transition-colors"
        >
          <Sparkles size={11} />
          Analyze
        </button>
      </div>

      {/* ---- Stat cards ---- */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {/* Summary: instances, health, queries, merges */}
        <Card>
          <div className="text-2xl font-bold">{totalInstances}</div>
          <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Instances</div>
        </Card>
        <Card>
          <div className="text-2xl font-bold" style={{ color: scoreColor(avgHealth) }}>{avgHealth}</div>
          <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Avg Health</div>
        </Card>
        <Card>
          <div className="text-2xl font-bold">{fmtNum(runningQueries)}</div>
          <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Running Queries</div>
        </Card>
        <Card>
          <div className="text-2xl font-bold">{fmtNum(activeMerges)}</div>
          <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Active Merges</div>
        </Card>

        {/* Alert severity cards — clickable */}
        <button
          onClick={() => critFiring > 0 && navToAlerts({ severity: 'critical' })}
          disabled={critFiring === 0}
          className="text-left disabled:cursor-default"
        >
          <Card className={critFiring > 0 ? 'hover:border-red-500/40 transition-colors cursor-pointer' : ''}>
            <div className={`text-2xl font-bold ${critFiring > 0 ? 'text-red-400' : 'text-[var(--dim)]'}`}>{critFiring}</div>
            <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Critical</div>
          </Card>
        </button>
        <button
          onClick={() => warnFiring > 0 && navToAlerts({ severity: 'warn' })}
          disabled={warnFiring === 0}
          className="text-left disabled:cursor-default"
        >
          <Card className={warnFiring > 0 ? 'hover:border-yellow-500/40 transition-colors cursor-pointer' : ''}>
            <div className={`text-2xl font-bold ${warnFiring > 0 ? 'text-yellow-400' : 'text-[var(--dim)]'}`}>{warnFiring}</div>
            <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Warning</div>
          </Card>
        </button>
        <button
          onClick={() => infoFiring > 0 && navToAlerts({ severity: 'info' })}
          disabled={infoFiring === 0}
          className="text-left disabled:cursor-default"
        >
          <Card className={infoFiring > 0 ? 'hover:border-blue-500/40 transition-colors cursor-pointer' : ''}>
            <div className={`text-2xl font-bold ${infoFiring > 0 ? 'text-blue-400' : 'text-[var(--dim)]'}`}>{infoFiring}</div>
            <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">
              Info{staleCount > 0 ? <span className="ml-1 text-gray-500 normal-case font-normal">+{staleCount} stale</span> : null}
            </div>
          </Card>
        </button>
      </div>

      {/* ---- Instance node cards ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {instances.map((inst) => (
          <NodeCard
            key={inst.name}
            instance={inst}
            onClick={() => goToInstance(inst.name)}
            staleAlerts={staleByInstance.get(inst.name) ?? 0}
            onResolved={() => setManualRefreshTick(t => t + 1)}
          />
        ))}
      </div>

      {/* ---- Active alerts table (fresh only) ---- */}
      {freshAlerts.length > 0 && (
        <Card title={`Active Alerts · ${freshAlerts.length}${staleCount > 0 ? ` (${staleCount} stale hidden)` : ''}`}>
          <DataTable columns={alertCols} data={freshAlerts} pageSize={50} />
        </Card>
      )}

      {/* ---- System Health (optional, hidden if /health unavailable) ---- */}
      {healthData && (
        <Card title="System Health">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: healthData.status === 'ok' ? '#22c55e' : '#eab308' }}
              />
              <span className="text-sm font-medium capitalize">{healthData.status}</span>
            </div>
            <div className="text-xs text-[var(--dim)]">v{healthData.version}</div>
            <div className="text-xs text-[var(--dim)]">up {healthData.uptime}</div>
            {healthData.instances && healthData.instances.length > 0 && (
              <div className="flex items-center gap-3 ml-2">
                {healthData.instances.map(inst => (
                  <div key={inst.name} className="flex items-center gap-1.5 text-xs">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{
                        backgroundColor:
                          inst.status === 'ok' ? '#22c55e'
                          : inst.status === 'degraded' ? '#eab308'
                          : '#ef4444',
                      }}
                    />
                    <span className="text-[var(--text)]">{inst.name}</span>
                    {inst.last_poll_at && (
                      <span className="text-[var(--dim)]">· {new Date(inst.last_poll_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
