import { useState, useEffect, useCallback } from 'react'
import { DollarSign, HardDrive, Cloud, Cpu, RefreshCw, AlertTriangle, Info, ChevronDown, ChevronRight } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import type { CostReport, CostOverview } from '../types/api'

/* ─── Formatters ──────────────────────────────────────────────────────────── */

function fmtUSD(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return '<$0.01'
  if (v < 100) return `$${v.toFixed(2)}`
  return `$${Math.round(v).toLocaleString()}`
}

function fmtGB(v: number): string {
  if (v === 0) return '—'
  if (v >= 1000) return `${(v / 1000).toFixed(1)} TB`
  if (v >= 1) return `${v.toFixed(1)} GB`
  return `${(v * 1024).toFixed(0)} MB`
}

function fmtBytes(b: number): string {
  if (b === 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

/* ─── Stat card ───────────────────────────────────────────────────────────── */

function StatCard({
  label, value, sub, icon: Icon, accent,
}: {
  label: string
  value: string
  sub?: string
  icon: typeof DollarSign
  accent?: string
}) {
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl px-5 py-4 flex items-start gap-4">
      <div className={cn('p-2 rounded-lg shrink-0', accent ?? 'bg-[var(--surface)]')}>
        <Icon size={18} className={accent ? 'text-white' : 'text-[var(--dim)]'} />
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <div className="text-xs text-[var(--dim)] mt-0.5 uppercase tracking-wider">{label}</div>
        {sub && <div className="text-xs text-[var(--dim)] mt-1">{sub}</div>}
      </div>
    </div>
  )
}

/* ─── Storage bar ─────────────────────────────────────────────────────────── */

function StorageBar({ localGB, s3GB }: { localGB: number; s3GB: number }) {
  const total = localGB + s3GB
  if (total === 0) return <div className="text-xs text-[var(--dim)]">No storage data</div>
  const localPct = (localGB / total) * 100
  const s3Pct = (s3GB / total) * 100
  return (
    <div className="space-y-2">
      <div className="h-3 rounded-full overflow-hidden bg-[var(--surface)] flex">
        <div className="bg-blue-500 transition-all" style={{ width: `${localPct}%` }} title={`Local EBS: ${fmtGB(localGB)}`} />
        <div className="bg-yellow-500 transition-all" style={{ width: `${s3Pct}%` }} title={`S3: ${fmtGB(s3GB)}`} />
      </div>
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-blue-500 shrink-0" />
          <span className="text-[var(--dim)]">Local EBS</span>
          <span className="font-mono font-medium">{fmtGB(localGB)}</span>
          <span className="text-[var(--dim)]">({localPct.toFixed(0)}%)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-yellow-500 shrink-0" />
          <span className="text-[var(--dim)]">S3 Object</span>
          <span className="font-mono font-medium">{fmtGB(s3GB)}</span>
          <span className="text-[var(--dim)]">({s3Pct.toFixed(0)}%)</span>
        </div>
      </div>
    </div>
  )
}

/* ─── Pricing assumptions panel ───────────────────────────────────────────── */

function PricingPanel({ pricing }: { pricing: CostReport['pricing'] }) {
  const [open, setOpen] = useState(false)
  const rows: [string, string][] = [
    ['Pricing Model', pricing.model],
    ['vCPU / hr', pricing.vcpu_hourly_usd > 0 ? `$${pricing.vcpu_hourly_usd}` : 'N/A (managed)'],
    ['Server fee / hr', pricing.server_hourly_usd > 0 ? `$${pricing.server_hourly_usd}` : 'N/A (managed)'],
    ['EBS block storage / GB / month', `$${pricing.ebs_gb_monthly_usd}`],
    ['S3 object storage / GB / month', `$${pricing.s3_gb_monthly_usd}`],
  ]
  return (
    <div className="border border-[var(--border)] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-[var(--surface)] hover:bg-[var(--hover)] transition-colors text-left"
      >
        {open ? <ChevronDown size={14} className="text-[var(--dim)]" /> : <ChevronRight size={14} className="text-[var(--dim)]" />}
        <Info size={13} className="text-[var(--dim)]" />
        <span className="text-xs font-medium">Pricing Assumptions</span>
        <span className="ml-auto text-xs text-[var(--dim)] font-mono">{pricing.model}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] divide-y divide-[var(--border)]">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center px-4 py-2">
              <span className="text-xs text-[var(--dim)] flex-1">{label}</span>
              <span className="text-xs font-mono font-medium">{value}</span>
            </div>
          ))}
          <div className="px-4 py-2.5 text-[10px] text-[var(--dim)] leading-relaxed">
            Altinity BYOC rates (AWS/GCP/Azure): $0.0625/vCPU/hr + $0.347/server/hr.
            Storage costs are AWS/GCP rates applied to data measured in ClickHouse system.parts.
            Override rates in <code className="font-mono bg-[var(--surface)] px-1 rounded">altinity:</code> config section.
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Per-instance detail ─────────────────────────────────────────────────── */

function InstanceCostDetail({ instance }: { instance: string }) {
  const [report, setReport] = useState<CostReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tableSearch, setTableSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.cost(instance)
      setReport(data)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load cost data')
    } finally {
      setLoading(false)
    }
  }, [instance])

  useEffect(() => { load() }, [load])

  if (loading) return (
    <div className="space-y-3 animate-pulse">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-20 rounded-xl bg-[var(--surface)]" />
      ))}
    </div>
  )

  if (error) return (
    <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-400">
      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
      {error}
    </div>
  )

  if (!report) return null

  const computeUnknown = report.compute.source === 'unknown'
  const filteredTables = report.by_table.filter(t =>
    !tableSearch || `${t.database}.${t.table}`.toLowerCase().includes(tableSearch.toLowerCase())
  )

  return (
    <div className="space-y-5">
      {/* Notes */}
      {report.notes?.length > 0 && (
        <div className="space-y-1">
          {report.notes.map((note, i) => (
            <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-[10px] text-yellow-300">
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              {note}
            </div>
          ))}
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Est. Monthly Total"
          value={fmtUSD(report.total_monthly_usd)}
          sub="compute + storage"
          icon={DollarSign}
          accent="bg-[var(--accent)]"
        />
        <StatCard
          label="Compute"
          value={computeUnknown ? '?' : fmtUSD(report.compute.monthly_total_usd)}
          sub={computeUnknown ? 'Set vcpu_override in config' : `${report.compute.vcpu_limit.toFixed(1)} vCPUs · ${report.compute.server_count} server${report.compute.server_count !== 1 ? 's' : ''}`}
          icon={Cpu}
        />
        <StatCard
          label="Local Storage (EBS)"
          value={fmtUSD(report.storage.local_monthly_usd)}
          sub={fmtGB(report.storage.local_gb)}
          icon={HardDrive}
        />
        <StatCard
          label="S3 Object Storage"
          value={fmtUSD(report.storage.s3_monthly_usd)}
          sub={fmtGB(report.storage.s3_gb)}
          icon={Cloud}
        />
      </div>

      {/* Storage split + Compute details */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Storage breakdown */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">Storage Breakdown</div>
          <StorageBar localGB={report.storage.local_gb} s3GB={report.storage.s3_gb} />
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="rounded-lg bg-[var(--surface)] px-3 py-2">
              <div className="text-[10px] text-[var(--dim)]">EBS monthly</div>
              <div className="text-sm font-semibold tabular-nums">{fmtUSD(report.storage.local_monthly_usd)}</div>
              <div className="text-[10px] text-[var(--dim)] mt-0.5">${report.pricing.ebs_gb_monthly_usd}/GB</div>
            </div>
            <div className="rounded-lg bg-[var(--surface)] px-3 py-2">
              <div className="text-[10px] text-[var(--dim)]">S3 monthly</div>
              <div className="text-sm font-semibold tabular-nums">{fmtUSD(report.storage.s3_monthly_usd)}</div>
              <div className="text-[10px] text-[var(--dim)] mt-0.5">${report.pricing.s3_gb_monthly_usd}/GB</div>
            </div>
          </div>
        </div>

        {/* Compute details */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">Compute Details</div>
          {computeUnknown ? (
            <div className="text-xs text-[var(--dim)] italic">
              K8s metrics not available. Set <code className="font-mono bg-[var(--surface)] px-1 rounded">altinity.vcpu_override</code> in config to estimate compute.
            </div>
          ) : (
            <div className="space-y-2">
              {[
                ['vCPUs', report.compute.vcpu_limit.toFixed(1), `from ${report.compute.source}`],
                ['Memory', report.compute.memory_gb > 0 ? fmtGB(report.compute.memory_gb) : '—', ''],
                ['Servers', String(report.compute.server_count), ''],
                ['Server fee / month', fmtUSD(report.compute.monthly_server_fee_usd), `$${report.pricing.server_hourly_usd}/hr × 730h`],
                ['vCPU cost / month', fmtUSD(report.compute.monthly_vcpu_usd), `$${report.pricing.vcpu_hourly_usd}/vCPU/hr`],
              ].map(([label, value, hint]) => (
                <div key={label} className="flex items-baseline gap-2 rounded-lg bg-[var(--surface)] px-3 py-2">
                  <span className="text-[10px] text-[var(--dim)] w-36 shrink-0">{label}</span>
                  <span className="text-xs font-semibold tabular-nums">{value}</span>
                  {hint && <span className="text-[10px] text-[var(--dim)] ml-auto">{hint}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Top tables by cost */}
      {report.by_table.length > 0 && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">
              Top Tables by Storage Cost
            </div>
            <div className="ml-auto">
              <input
                value={tableSearch}
                onChange={e => setTableSearch(e.target.value)}
                placeholder="Filter tables…"
                className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-xs focus:outline-none focus:border-[var(--accent)] transition-colors w-44"
              />
            </div>
          </div>
          <div className="overflow-auto max-h-96">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-[var(--card)] border-b border-[var(--border)]">
                <tr>
                  <th className="text-left px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Table</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-blue-400/70">EBS</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-yellow-400/70">S3</th>
                  <th className="text-right px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Monthly</th>
                </tr>
              </thead>
              <tbody>
                {filteredTables.map((t, i) => {
                  const maxCost = filteredTables[0]?.monthly_usd ?? 1
                  const barW = maxCost > 0 ? (t.monthly_usd / maxCost) * 100 : 0
                  return (
                    <tr key={i} className="border-b border-[var(--border)] hover:bg-[var(--hover)] transition-colors">
                      <td className="px-4 py-2 max-w-[220px]">
                        <div className="flex items-baseline gap-0.5 min-w-0">
                          <span className="text-[var(--dim)] text-[10px] shrink-0">{t.database}.</span>
                          <span className="font-medium truncate">{t.table}</span>
                        </div>
                        {/* Mini bar */}
                        <div className="mt-1 h-1 rounded-full bg-[var(--surface)] overflow-hidden">
                          <div className="h-full bg-[var(--accent)]/40 rounded-full" style={{ width: `${barW}%` }} />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-blue-400">
                        {t.local_gb > 0.001 ? fmtBytes(t.local_bytes) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-yellow-400">
                        {t.s3_gb > 0.001 ? fmtBytes(t.s3_bytes) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums">
                        {t.monthly_usd > 0 ? fmtUSD(t.monthly_usd) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pricing assumptions */}
      <PricingPanel pricing={report.pricing} />

      {/* Generated at */}
      <div className="text-[10px] text-[var(--dim)] text-right">
        Generated {new Date(report.generated_at).toLocaleString()}
      </div>
    </div>
  )
}

/* ─── Overview across all instances ──────────────────────────────────────── */

function CostOverviewPanel({ onSelect }: { onSelect: (inst: string) => void }) {
  const [overview, setOverview] = useState<CostOverview | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.costOverview()
      .then(setOverview)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading || !overview || overview.instances.length <= 1) return null

  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden mb-2">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">All Instances</span>
        <span className="text-sm font-bold">{fmtUSD(overview.total_monthly_usd)} <span className="text-xs text-[var(--dim)] font-normal">/ month total</span></span>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {overview.instances.map(inst => (
          <button
            key={inst.instance}
            onClick={() => onSelect(inst.instance)}
            className="w-full flex items-center gap-4 px-4 py-2.5 hover:bg-[var(--hover)] transition-colors text-left"
          >
            <span className="text-xs font-medium w-40 truncate shrink-0">{inst.instance}</span>
            <div className="flex-1 h-2 rounded-full bg-[var(--surface)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--accent)]/50"
                style={{ width: `${overview.total_monthly_usd > 0 ? (inst.total_monthly_usd / overview.total_monthly_usd) * 100 : 0}%` }}
              />
            </div>
            <span className="text-xs font-mono font-semibold w-20 text-right shrink-0">{fmtUSD(inst.total_monthly_usd)}</span>
            <span className="text-[10px] text-[var(--dim)] w-28 text-right shrink-0">
              EBS {fmtGB(inst.local_gb)} · S3 {fmtGB(inst.s3_gb)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ─── Main view ───────────────────────────────────────────────────────────── */

export default function CostExplorer() {
  const { selectedInstance, instances } = useStore()
  const [instance, setInstance] = useState(() => selectedInstance || '')

  useEffect(() => {
    if (!instance && (selectedInstance || instances[0])) {
      setInstance(selectedInstance || instances[0])
    }
  }, [selectedInstance, instances]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-base font-semibold flex items-center gap-2">
            <DollarSign size={16} className="text-[var(--accent)]" />
            Cost Explorer
          </h1>
          <p className="text-xs text-[var(--dim)] mt-0.5">Estimated monthly cost based on Altinity BYOC pricing + AWS S3/EBS rates</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={instance}
            onChange={e => setInstance(e.target.value)}
            className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--accent)] transition-colors"
          >
            {instances.length === 0 && <option value="">No instances</option>}
            {instances.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {/* Multi-instance overview bar */}
      <CostOverviewPanel onSelect={setInstance} />

      {/* Per-instance detail */}
      {instance ? (
        <InstanceCostDetail key={instance} instance={instance} />
      ) : (
        <div className="flex items-center justify-center h-40 text-sm text-[var(--dim)]">
          Select an instance above
        </div>
      )}
    </div>
  )
}
