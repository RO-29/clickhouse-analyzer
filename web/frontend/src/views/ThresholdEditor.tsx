import { useState, useEffect, useCallback } from 'react'
import { SlidersHorizontal, ChevronDown, ChevronRight, Save, RotateCcw, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { flashToast } from '../lib/notify'
import type { ThresholdsConfig } from '../types/api'

// ---------------------------------------------------------------------------
// Field descriptor types
// ---------------------------------------------------------------------------

type FieldPath = string  // dot-separated key into the draft

interface FieldDef {
  key: FieldPath     // key within the section object
  label: string
  unit?: string
  step?: number
  min?: number
}

interface SectionDef {
  id: keyof ThresholdsConfig
  title: string
  fields: FieldDef[]
}

// ---------------------------------------------------------------------------
// Section definitions — one per ThresholdsConfig category
// ---------------------------------------------------------------------------

const SECTIONS: SectionDef[] = [
  {
    id: 'memory',
    title: 'Memory',
    fields: [
      { key: 'warn_percent',        label: 'Warn threshold',          unit: '%',  step: 1, min: 0 },
      { key: 'critical_percent',    label: 'Critical threshold',      unit: '%',  step: 1, min: 0 },
      { key: 'rss_warn_percent',    label: 'RSS warn threshold',      unit: '%',  step: 1, min: 0 },
      { key: 'rss_critical_percent',label: 'RSS critical threshold',  unit: '%',  step: 1, min: 0 },
    ],
  },
  {
    id: 'cpu',
    title: 'CPU',
    fields: [
      { key: 'warn_percent',     label: 'Warn threshold',     unit: '%', step: 1, min: 0 },
      { key: 'critical_percent', label: 'Critical threshold', unit: '%', step: 1, min: 0 },
    ],
  },
  {
    id: 'queries',
    title: 'Queries',
    fields: [
      { key: 'long_running_threshold_secs',      label: 'Long-running critical', unit: 's',   step: 1,   min: 0 },
      { key: 'long_running_warn_threshold_secs', label: 'Long-running warn',     unit: 's',   step: 1,   min: 0 },
      { key: 'max_concurrent',                   label: 'Max concurrent (crit)', unit: '',    step: 1,   min: 1 },
      { key: 'warn_concurrent',                  label: 'Warn concurrent',       unit: '',    step: 1,   min: 1 },
    ],
  },
  {
    id: 'parts',
    title: 'Parts',
    fields: [
      { key: 'warn_count',                label: 'Per-table warn',          unit: 'parts',     step: 100,  min: 0 },
      { key: 'critical_count',            label: 'Per-table critical',      unit: 'parts',     step: 100,  min: 0 },
      { key: 'warn_per_partition',        label: 'Warn per partition',      unit: 'parts',     step: 10,   min: 0 },
      { key: 'max_cluster_parts',         label: 'Cluster ceiling',         unit: 'parts',     step: 1000, min: 0 },
      { key: 'max_partitions_per_table',  label: 'Max partitions / table',  unit: 'partitions', step: 100,  min: 0 },
      { key: 'max_parts_per_partition',   label: 'Max parts / partition',   unit: 'parts',     step: 50,   min: 0 },
    ],
  },
  {
    id: 'merges',
    title: 'Merges',
    fields: [
      { key: 'max_active',              label: 'Max active (crit)',          unit: '',     step: 1,   min: 1 },
      { key: 'warn_active',             label: 'Warn active',                unit: '',     step: 1,   min: 1 },
      { key: 'min_active_when_backlog', label: 'Min active when backlog',    unit: '',     step: 1,   min: 0 },
      { key: 'backlog_part_count',      label: 'Backlog floor (parts)',      unit: 'parts', step: 100, min: 0 },
    ],
  },
  {
    id: 'mutations',
    title: 'Mutations',
    fields: [
      { key: 'stuck_threshold_secs', label: 'Stuck threshold', unit: 's', step: 60, min: 0 },
    ],
  },
  {
    id: 'inserts',
    title: 'Inserts',
    fields: [
      { key: 'throughput_drop_percent',         label: 'Throughput drop alert',     unit: '%',    step: 5,    min: 0 },
      { key: 'small_insert_threshold',          label: 'Small insert size',         unit: 'rows', step: 10,   min: 0 },
      { key: 'small_insert_warn_count',         label: 'Small insert warn count',   unit: '',     step: 1,    min: 0 },
      { key: 'delayed_inserts_warn',            label: 'DelayedInserts warn',       unit: '',     step: 1,    min: 0 },
      { key: 'delayed_inserts_critical',        label: 'DelayedInserts critical',   unit: '',     step: 1,    min: 0 },
      { key: 'pending_async_inserts_warn',      label: 'Pending async warn',        unit: 'rows', step: 100,  min: 0 },
      { key: 'pending_async_inserts_critical',  label: 'Pending async critical',    unit: 'rows', step: 100,  min: 0 },
      { key: 'rejected_inserts_rate_warn',      label: 'Rejected rate warn',        unit: '/min', step: 0.5,  min: 0 },
    ],
  },
  {
    id: 'disk',
    title: 'Disk',
    fields: [
      { key: 'warn_percent',     label: 'Warn threshold',     unit: '%', step: 1, min: 0 },
      { key: 'critical_percent', label: 'Critical threshold', unit: '%', step: 1, min: 0 },
    ],
  },
  {
    id: 's3',
    title: 'S3',
    fields: [
      { key: 'latency_warn_secs',      label: 'Latency warn',       unit: 's', step: 0.5, min: 0 },
      { key: 'latency_critical_secs',  label: 'Latency critical',   unit: 's', step: 0.5, min: 0 },
      { key: 'max_concurrent_reads',   label: 'Max concurrent reads', unit: '', step: 5,   min: 1 },
    ],
  },
  {
    id: 'replication',
    title: 'Replication',
    fields: [
      { key: 'lag_warn_secs',     label: 'Lag warn',     unit: 's', step: 5, min: 0 },
      { key: 'lag_critical_secs', label: 'Lag critical', unit: 's', step: 5, min: 0 },
    ],
  },
  {
    id: 'dictionaries',
    title: 'Dictionaries',
    fields: [
      { key: 'reload_fail_threshold', label: 'Reload fail threshold', unit: 'failures', step: 1, min: 0 },
    ],
  },
  {
    id: 'mv',
    title: 'Materialized Views',
    fields: [
      { key: 'lag_warn_secs',    label: 'Lag warn',        unit: 's', step: 30, min: 0 },
      { key: 'bloat_ratio_warn', label: 'Bloat ratio warn', unit: 'x', step: 0.5, min: 0 },
    ],
  },
  {
    id: 'background_pool',
    title: 'Background Pool',
    fields: [
      { key: 'warn_percent',     label: 'Warn threshold',     unit: '%', step: 5, min: 0 },
      { key: 'critical_percent', label: 'Critical threshold', unit: '%', step: 5, min: 0 },
    ],
  },
  {
    id: 'cache_health',
    title: 'Cache Health',
    fields: [
      { key: 'mark_hit_rate_warn_percent',     label: 'Mark hit rate warn',     unit: '%', step: 5,  min: 0 },
      { key: 'mark_hit_rate_critical_percent', label: 'Mark hit rate critical', unit: '%', step: 5,  min: 0 },
      { key: 'min_queries_for_alert',          label: 'Min queries for alert',  unit: '',  step: 10, min: 0 },
    ],
  },
  {
    id: 'query_latency',
    title: 'Query Latency',
    fields: [
      { key: 'spike_warn_multiplier',     label: 'Spike warn multiplier',     unit: 'x', step: 0.1, min: 1 },
      { key: 'spike_critical_multiplier', label: 'Spike critical multiplier', unit: 'x', step: 0.1, min: 1 },
      { key: 'min_baseline_ms',           label: 'Min baseline',              unit: 'ms', step: 10, min: 0 },
      { key: 'min_query_count',           label: 'Min query count',           unit: '',  step: 1,  min: 1 },
    ],
  },
  {
    id: 'freshness',
    title: 'Freshness',
    fields: [
      { key: 'gap_minutes',      label: 'Gap alert threshold', unit: 'min', step: 1, min: 0 },
      { key: 'min_daily_inserts',label: 'Min daily inserts',   unit: '',    step: 1, min: 0 },
    ],
  },
]

// ---------------------------------------------------------------------------
// Section accordion
// ---------------------------------------------------------------------------

interface SectionProps {
  def: SectionDef
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: Record<string, any>
  onChange: (key: string, value: number) => void
  open: boolean
  onToggle: () => void
}

function Section({ def, values, onChange, open, onToggle }: SectionProps) {
  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-[var(--surface)] hover:bg-[var(--hover)] transition-colors text-left"
      >
        <span className="text-[13px] font-medium text-[var(--text)]">{def.title}</span>
        {open
          ? <ChevronDown size={14} className="text-[var(--dim)]" />
          : <ChevronRight size={14} className="text-[var(--dim)]" />}
      </button>

      {open && (
        <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {def.fields.map(field => {
            const val = values?.[field.key] ?? 0
            return (
              <div key={field.key} className="flex items-center gap-2">
                <label className="text-xs text-[var(--text-muted)] w-44 shrink-0 leading-tight">
                  {field.label}
                </label>
                <input
                  type="number"
                  value={val}
                  step={field.step ?? 1}
                  min={field.min ?? 0}
                  onChange={e => onChange(field.key, parseFloat(e.target.value) || 0)}
                  className="w-24 bg-[var(--hover)] border border-[var(--border)] rounded px-2 py-1 text-xs outline-none focus:border-[var(--accent)] text-[var(--text)]"
                />
                {field.unit && (
                  <span className="text-xs text-[var(--dim)] shrink-0">{field.unit}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function ThresholdEditor() {
  const [loaded, setLoaded] = useState<ThresholdsConfig | null>(null)
  const [draft, setDraft] = useState<ThresholdsConfig | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['memory']))

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.thresholds.get()
      setLoaded(data)
      setDraft(JSON.parse(JSON.stringify(data)))
      setIsDirty(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load thresholds')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleChange = useCallback((sectionId: keyof ThresholdsConfig, key: string, value: number) => {
    setDraft(prev => {
      if (!prev) return prev
      return {
        ...prev,
        [sectionId]: {
          ...(prev[sectionId] as Record<string, unknown>),
          [key]: value,
        },
      }
    })
    setIsDirty(true)
  }, [])

  const handleSave = useCallback(async () => {
    if (!draft) return
    setSaving(true)
    try {
      const updated = await api.thresholds.save(draft)
      setLoaded(updated)
      setDraft(JSON.parse(JSON.stringify(updated)))
      setIsDirty(false)
      flashToast('Thresholds saved', 'done')
    } catch (e: unknown) {
      flashToast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }, [draft])

  const handleReset = useCallback(() => {
    if (!loaded) return
    setDraft(JSON.parse(JSON.stringify(loaded)))
    setIsDirty(false)
    flashToast('Reset to last saved values', 'done')
  }, [loaded])

  const toggleSection = useCallback((id: string) => {
    setOpenSections(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = 'You have unsaved changes — leave anyway?'
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--dim)]">
        <Loader2 size={20} className="animate-spin mr-2" />
        <span className="text-sm">Loading thresholds…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={load}
          className="px-3 py-1.5 rounded text-xs bg-[var(--accent)] text-white hover:opacity-90"
        >
          Retry
        </button>
      </div>
    )
  }

  if (!draft) return null

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <SlidersHorizontal size={18} className="text-[var(--accent)]" />
          <div>
            <h1 className="text-base font-semibold text-[var(--text)]">Alert Thresholds</h1>
            <p className="text-xs text-[var(--dim)] mt-0.5">
              Changes are applied live — takes effect on the next poll cycle.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
              Unsaved changes
            </span>
          )}
          <button
            onClick={handleReset}
            disabled={!isDirty}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-[var(--border)] transition-colors',
              isDirty
                ? 'text-[var(--text)] hover:bg-[var(--hover)]'
                : 'text-[var(--dim)] opacity-40 cursor-not-allowed',
            )}
          >
            <RotateCcw size={13} />
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors',
              isDirty && !saving
                ? 'bg-[var(--accent)] text-white hover:opacity-90'
                : 'bg-[var(--accent)]/40 text-white/60 cursor-not-allowed',
            )}
          >
            {saving
              ? <Loader2 size={13} className="animate-spin" />
              : <Save size={13} />}
            Save Changes
          </button>
        </div>
      </div>

      {/* Dirty banner */}
      {isDirty && (
        <div className="px-3 py-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-xs text-yellow-400">
          You have unsaved changes.
        </div>
      )}

      {/* Sections */}
      <div className="space-y-2">
        {SECTIONS.map(def => (
          <Section
            key={def.id}
            def={def}
            values={draft[def.id] as Record<string, unknown>}
            onChange={(key, value) => handleChange(def.id, key, value)}
            open={openSections.has(def.id)}
            onToggle={() => toggleSection(def.id)}
          />
        ))}
      </div>
    </div>
  )
}
