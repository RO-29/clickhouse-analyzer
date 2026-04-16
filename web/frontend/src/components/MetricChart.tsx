import { useEffect, useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { api } from '../lib/api'
import { useStore } from '../hooks/useStore'
import { fmtBytes, fmtPercent, fmtNum } from '../lib/utils'
import type { MetricPoint } from '../types/api'

const DEFAULT_COLORS = [
  '#7c3aed', '#22c55e', '#eab308', '#ef4444', '#06b6d4',
  '#f97316', '#ec4899', '#a855f7',
]

interface MetricDef {
  name: string
  label: string
  color: string
}

interface MetricChartProps {
  instance: string
  metrics: MetricDef[] | string[]
  title: string
  height?: number
  yFormat?: 'bytes' | 'percent' | 'number' | 'ms'
}

const MS_DAY = 86_400_000

function ChartTooltip({ active, payload, label, formatValue }: any) {
  if (!active || !payload?.length) return null
  const d = new Date(label * 1000)
  const timeStr = d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-xl px-3 py-2 text-[11px] min-w-[120px]">
      <div className="text-[var(--dim)] mb-1.5">{timeStr}</div>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} className="flex items-center gap-2 mb-0.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
          {payload.length > 1 && <span className="text-[var(--dim)] truncate max-w-[100px]">{entry.name}:</span>}
          <span className="font-medium text-[var(--text)]">{formatValue(entry.value ?? 0)}</span>
        </div>
      ))}
    </div>
  )
}

export function MetricChart({ instance, title, metrics, height = 160, yFormat = 'number' }: MetricChartProps) {
  const { getTimeRange } = useStore()
  const { from, to } = getTimeRange()
  const [series, setSeries] = useState<{ label: string; color: string; points: MetricPoint[] }[]>([])
  const [loading, setLoading] = useState(true)

  const defs: MetricDef[] = metrics.map((m, i) => {
    if (typeof m === 'string') return { name: m, label: m.split('.').pop()!, color: DEFAULT_COLORS[i % DEFAULT_COLORS.length] }
    return m
  })

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const results = await Promise.all(
          defs.map(d => api.metrics(instance, d.name, from, to))
        )
        if (!cancelled) {
          setSeries(results.map((r, i) => ({
            label: defs[i].label,
            color: defs[i].color,
            points: r.points,
          })))
        }
      } catch {
        if (!cancelled) setSeries([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, from, to, JSON.stringify(defs.map(d => d.name))])

  const formatValue = (v: number) => {
    if (yFormat === 'bytes') return fmtBytes(v)
    if (yFormat === 'percent') return fmtPercent(v)
    if (yFormat === 'ms') return v.toFixed(1) + 'ms'
    return fmtNum(v)
  }

  const points0 = series[0]?.points ?? []
  const spanMs = points0.length >= 2
    ? Math.abs(points0[points0.length - 1].ts - points0[0].ts) * 1000
    : 0

  const formatTs = (ts: number) => {
    const d = new Date(ts * 1000)
    if (spanMs > 7 * MS_DAY) return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
    if (spanMs > MS_DAY) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }

  // Pivot series into recharts row format: { ts, label0: val, label1: val, ... }
  const chartData = points0.map((p, i) => {
    const row: Record<string, any> = { ts: p.ts }
    series.forEach(s => { row[s.label] = s.points[i]?.value ?? null })
    return row
  })

  const empty = chartData.length === 0

  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)]">
        {title}
      </div>
      <div className="px-2 pb-3">
        {loading ? (
          <div style={{ height }} className="flex items-center justify-center text-[var(--dim)] text-xs">
            Loading…
          </div>
        ) : empty ? (
          <div style={{ height }} className="flex items-center justify-center text-[var(--dim)] text-xs">
            No data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                {series.map((s, i) => (
                  <linearGradient key={s.label} id={`mc-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="0" />
              <XAxis
                dataKey="ts"
                tickFormatter={formatTs}
                tick={{ fontSize: 10, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
                minTickGap={48}
              />
              <YAxis
                tickFormatter={v => formatValue(Number(v))}
                tick={{ fontSize: 10, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
                width={44}
                domain={yFormat === 'percent' ? [0, 100] : ['auto', 'auto']}
              />
              <Tooltip
                content={(props: any) => <ChartTooltip {...props} formatValue={formatValue} />}
                cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }}
              />
              {series.map((s, i) => (
                <Area
                  key={s.label}
                  type="monotone"
                  dataKey={s.label}
                  stroke={s.color}
                  strokeWidth={1.5}
                  fill={series.length === 1 ? `url(#mc-grad-${i})` : 'transparent'}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0, fill: s.color }}
                  connectNulls
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      {series.length > 1 && !empty && !loading && (
        <div className="flex flex-wrap gap-3 px-4 pb-3">
          {series.map(s => (
            <div key={s.label} className="flex items-center gap-1.5 text-[10px] text-[var(--dim)]">
              <span className="w-2 h-px block" style={{ backgroundColor: s.color, height: '2px' }} />
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
