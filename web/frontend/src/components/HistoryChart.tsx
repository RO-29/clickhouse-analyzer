import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Legend,
} from 'recharts'
import { Sparkles } from 'lucide-react'
import { fmtBytes, fmtDuration, fmtCompact, chToDate } from '../lib/utils'

interface SeriesDef {
  key: string
  label: string
  color: string
  type?: 'area' | 'bar'
}

interface HistoryChartProps {
  data: Record<string, any>[]
  series: SeriesDef[]
  title: string
  height?: number
  yFormat?: 'bytes' | 'ms' | 'number'
  note?: string
  onAnalyze?: (data: Record<string, any>[], series: SeriesDef[], title: string) => void
  chartType?: 'area' | 'bar'
}

const MS_DAY = 86_400_000

function ChartTooltip({ active, payload, label, formatValue, data }: any) {
  if (!active || !payload?.length) return null
  // Try to get the actual ts from the row
  const row = Array.isArray(data) ? data.find((r: any) => r.ts === label) : null
  const ts = row?.ts ?? label
  const d = ts ? chToDate(ts) : null
  const timeStr = d && !isNaN(d.getTime())
    ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : String(label)
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-xl px-3 py-2 text-[11px] min-w-[130px]">
      <div className="text-[var(--dim)] mb-1.5">{timeStr}</div>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} className="flex items-center gap-2 mb-0.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
          <span className="text-[var(--dim)] truncate">{entry.name}:</span>
          <span className="font-medium text-[var(--text)]">{formatValue(entry.value ?? 0)}</span>
        </div>
      ))}
    </div>
  )
}

export function HistoryChart({
  data: rawData,
  series,
  title,
  height = 160,
  yFormat = 'number',
  note,
  onAnalyze,
  chartType = 'area',
}: HistoryChartProps) {
  const data = Array.isArray(rawData) ? rawData : []

  const formatValue = (v: number) => {
    if (yFormat === 'bytes') return fmtBytes(v)
    if (yFormat === 'ms') return fmtDuration(v)
    return fmtCompact(v)
  }

  const spanMs = (() => {
    if (data.length < 2) return 0
    const toMs = (t: any) => chToDate(t).getTime()
    return Math.abs(toMs(data[data.length - 1].ts) - toMs(data[0].ts))
  })()

  const formatTs = (ts: any) => {
    if (!ts) return ''
    const d = chToDate(ts)
    if (spanMs > 7 * MS_DAY) return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
    if (spanMs > MS_DAY) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }

  const empty = data.length === 0
  const allZero = !empty && note !== undefined && series.every(s =>
    data.every(row => !(Number(row[s.key]) > 0))
  )

  const commonAxisProps = {
    tick: { fontSize: 10, fill: '#64748b' as string },
    axisLine: false,
    tickLine: false,
  }

  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3 pb-1 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)]">{title}</span>
          {allZero && note && (
            <span className="ml-2 text-[10px] text-[var(--dim)] italic normal-case tracking-normal">{note}</span>
          )}
        </div>
        {onAnalyze && !empty && !allZero && (
          <button
            onClick={() => onAnalyze(data, series, title)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-[var(--accent)] hover:bg-[var(--accent-subtle)] border border-transparent hover:border-[var(--accent)]/20 transition-colors"
            title="Analyze with AI"
          >
            <Sparkles size={10} />
            Analyze
          </button>
        )}
      </div>

      {/* Chart body */}
      <div className="px-2 pb-3">
        {empty ? (
          <div style={{ height }} className="flex items-center justify-center">
            <svg width="100%" height={height} className="opacity-[0.10]">
              <rect x="4" y="4" width="calc(100% - 8)" height={height - 8} rx="6"
                fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 4" />
              <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle"
                fill="currentColor" fontSize="11" fontFamily="system-ui, sans-serif">
                No data in range
              </text>
            </svg>
          </div>
        ) : allZero ? (
          <div style={{ height }} className="flex items-center justify-center">
            <span className="text-[var(--dim)] text-[11px] italic opacity-60">— not applicable —</span>
          </div>
        ) : chartType === 'bar' ? (
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barSize={6}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="0" />
              <XAxis dataKey="ts" tickFormatter={formatTs} {...commonAxisProps} minTickGap={48} />
              <YAxis tickFormatter={v => formatValue(Number(v))} {...commonAxisProps} width={44} />
              <Tooltip
                content={(props: any) => <ChartTooltip {...props} formatValue={formatValue} data={data} />}
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              />
              {series.length > 1 && (
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 10, paddingTop: 6 }}
                />
              )}
              {series.map(s => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[2, 2, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                {series.map((s, i) => (
                  <linearGradient key={s.key} id={`hc-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="0" />
              <XAxis dataKey="ts" tickFormatter={formatTs} {...commonAxisProps} minTickGap={48} />
              <YAxis tickFormatter={v => formatValue(Number(v))} {...commonAxisProps} width={44} />
              <Tooltip
                content={(props: any) => <ChartTooltip {...props} formatValue={formatValue} data={data} />}
                cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }}
              />
              {series.length > 1 && (
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 10, paddingTop: 6 }}
                />
              )}
              {series.map((s, i) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={1.5}
                  fill={series.length === 1 ? `url(#hc-grad-${i})` : 'transparent'}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0, fill: s.color }}
                  connectNulls
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
