import { useState, useEffect, useCallback } from 'react'
import { Shield, Plus, Trash2, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { Card } from '../components/Card'
import type { MaintenanceWindow, Instance } from '../types/api'

/* ------------------------------------------------------------------ */
/*  Time remaining helper                                               */
/* ------------------------------------------------------------------ */
function timeRemaining(endsAt: string): string {
  const diff = new Date(endsAt).getTime() - Date.now()
  if (diff <= 0) return 'Expired'
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  if (hours > 0) return `${hours}h ${mins % 60}m remaining`
  return `${mins}m remaining`
}

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/* ------------------------------------------------------------------ */
/*  Duration options                                                    */
/* ------------------------------------------------------------------ */
const DURATION_PRESETS = [
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '2h', value: 120 },
  { label: '4h', value: 240 },
  { label: '8h', value: 480 },
  { label: 'Custom', value: 0 },
]

/* ------------------------------------------------------------------ */
/*  Maintenance view                                                    */
/* ------------------------------------------------------------------ */
export default function Maintenance() {
  const [windows, setWindows] = useState<MaintenanceWindow[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)

  // Form state
  const [formInstance, setFormInstance] = useState('*')
  const [formReason, setFormReason] = useState('')
  const [formDuration, setFormDuration] = useState(60)
  const [formCustomMinutes, setFormCustomMinutes] = useState(60)
  const [formCreatedBy, setFormCreatedBy] = useState('user')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const isCustomDuration = formDuration === 0

  const load = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true)
    try {
      const [wins, insts] = await Promise.all([
        api.maintenance.list().catch(() => [] as MaintenanceWindow[]),
        api.instances().catch(() => [] as Instance[]),
      ])
      setWindows(wins)
      setInstances(insts)
      setError(null)
      setLoadedAt(new Date())
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  // Initial load
  useEffect(() => { load() }, [load])

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(() => load(), 30_000)
    return () => clearInterval(id)
  }, [load])

  const handleCreate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formReason.trim()) { setSubmitError('Reason is required'); return }
    const duration = isCustomDuration ? formCustomMinutes : formDuration
    if (duration <= 0) { setSubmitError('Duration must be > 0'); return }
    setSubmitting(true)
    setSubmitError(null)
    try {
      await api.maintenance.create(formInstance, formReason.trim(), duration, formCreatedBy || 'user')
      setFormReason('')
      await load()
    } catch (e: any) {
      setSubmitError(e.message ?? 'Failed to create maintenance window')
    } finally {
      setSubmitting(false)
    }
  }, [formInstance, formReason, formDuration, formCustomMinutes, formCreatedBy, isCustomDuration, load])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.maintenance.delete(id)
      setWindows(ws => ws.filter(w => w.id !== id))
    } catch (e: any) {
      setError(e.message ?? 'Failed to end maintenance window')
    }
  }, [])

  const activeWindows = windows.filter(w => new Date(w.ends_at).getTime() > Date.now())

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield size={20} className="text-[var(--accent)]" />
        <div>
          <h1 className="text-base font-semibold">Maintenance Windows</h1>
          <p className="text-xs text-[var(--dim)]">Suppress alerts for an instance during planned maintenance</p>
        </div>
        <div className="flex-1" />
        {loadedAt && !refreshing && (
          <span className="text-[11px] text-[var(--dim)] hidden sm:block">
            Updated {loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-[var(--dim)] hover:bg-[var(--hover)] border border-[var(--border)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>
      )}

      {/* Create form */}
      <Card title="Schedule Maintenance">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Instance */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-[var(--dim)] uppercase tracking-wider">Instance</label>
              <select
                value={formInstance}
                onChange={e => setFormInstance(e.target.value)}
                className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                <option value="*">* All instances</option>
                {instances.map(i => (
                  <option key={i.name} value={i.name}>{i.name}</option>
                ))}
              </select>
            </div>

            {/* Reason */}
            <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-1">
              <label className="text-xs text-[var(--dim)] uppercase tracking-wider">Reason</label>
              <input
                type="text"
                value={formReason}
                onChange={e => setFormReason(e.target.value)}
                placeholder="e.g. Scheduled upgrade"
                className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--dim)]"
              />
            </div>

            {/* Created by */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-[var(--dim)] uppercase tracking-wider">Created by</label>
              <input
                type="text"
                value={formCreatedBy}
                onChange={e => setFormCreatedBy(e.target.value)}
                placeholder="user"
                className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--dim)]"
              />
            </div>
          </div>

          {/* Duration */}
          <div className="flex flex-col gap-2">
            <label className="text-xs text-[var(--dim)] uppercase tracking-wider">Duration</label>
            <div className="flex flex-wrap items-center gap-2">
              {DURATION_PRESETS.map(p => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setFormDuration(p.value)}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-sm font-medium transition-colors border',
                    formDuration === p.value
                      ? 'bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/30'
                      : 'text-[var(--dim)] border-[var(--border)] hover:text-[var(--text)] hover:bg-[var(--hover)]',
                  )}
                >
                  {p.label}
                </button>
              ))}
              {isCustomDuration && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    value={formCustomMinutes}
                    onChange={e => setFormCustomMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                    min={1}
                    className="w-20 bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-xs text-[var(--dim)]">minutes</span>
                </div>
              )}
            </div>
          </div>

          {submitError && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{submitError}</div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 border border-[var(--accent)]/20 transition-colors disabled:opacity-50"
          >
            <Plus size={14} />
            {submitting ? 'Starting…' : 'Start Maintenance'}
          </button>
        </form>
      </Card>

      {/* Active windows */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold">Active Windows</h2>
          {activeWindows.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20">
              {activeWindows.length} active
            </span>
          )}
        </div>

        {loading ? (
          <div className="space-y-2 animate-pulse">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-16 bg-[var(--surface)] border border-[var(--border)] rounded-xl" />
            ))}
          </div>
        ) : activeWindows.length === 0 ? (
          <Card>
            <div className="text-sm text-[var(--dim)] text-center py-6">No active maintenance windows</div>
          </Card>
        ) : (
          <div className="space-y-2">
            {activeWindows.map(w => (
              <Card key={w.id}>
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">
                        {w.instance === '*' ? 'All instances' : w.instance}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        {timeRemaining(w.ends_at)}
                      </span>
                    </div>
                    <div className="text-sm text-[var(--text)]">{w.reason}</div>
                    <div className="text-xs text-[var(--dim)]">
                      By {w.created_by} · started {fmtTs(w.started_at)} · ends {fmtTs(w.ends_at)}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(w.id)}
                    className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-red-400 hover:bg-red-500/15 border border-red-500/20 transition-colors"
                    title="End maintenance window now"
                  >
                    <Trash2 size={12} />
                    End now
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
