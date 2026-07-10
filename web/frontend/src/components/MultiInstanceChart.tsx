import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { fmtBytes, fmtPercent, fmtNum } from '../lib/utils'

interface Series {
  instance: string
  color: string
  points: Array<{ ts: number; value: number }>
}

interface Props {
  series: Series[]
  title?: string
  height?: number
  yFormat?: 'bytes' | 'percent' | 'number' | 'ms'
}

const MS_DAY = 86_400_000

function formatValue(v: number, yFormat: Props['yFormat']): string {
  if (yFormat === 'bytes') return fmtBytes(v)
  if (yFormat === 'percent') return fmtPercent(v)
  if (yFormat === 'ms') return v.toFixed(1) + 'ms'
  return fmtNum(v)
}

function ChartTooltip({ active, payload, label, yFormat }: any) {
  if (!active || !payload?.length) return null
  const d = new Date(label * 1000)
  const timeStr = d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-xl px-3 py-2 text-[11px] min-w-[140px]">
      <div className="text-[var(--dim)] mb-1.5">{timeStr}</div>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} className="flex items-center gap-2 mb-0.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
          <span className="text-[var(--dim)] truncate max-w-[120px]">{entry.name}:</span>
          <span className="font-medium text-[var(--text)]">{formatValue(entry.value ?? 0, yFormat)}</span>
        </div>
      ))}
    </div>
  )
}

export function MultiInstanceChart({ series, title, height = 300, yFormat = 'number' }: Props) {
  if (!series.length) return null

  // Collect all unique timestamps across all series.
  const tsSet = new Set<number>()
  for (const s of series) {
    for (const p of s.points) tsSet.add(p.ts)
  }
  const allTs = [...tsSet].sort((a, b) => a - b)

  // Pivot: [{ ts, "inst-a": val, "inst-b": val, … }]
  const chartData = allTs.map(ts => {
    const row: Record<string, any> = { ts }
    for (const s of series) {
      const pt = s.points.find(p => p.ts === ts)
      row[s.instance] = pt ? pt.value : null
    }
    return row
  })

  const spanMs = allTs.length >= 2
    ? Math.abs(allTs[allTs.length - 1] - allTs[0]) * 1000
    : 0

  const formatTs = (ts: number) => {
    const d = new Date(ts * 1000)
    if (spanMs > 7 * MS_DAY) return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
    if (spanMs > MS_DAY) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }

  const empty = chartData.length === 0

  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden">
      {title && (
        <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)]">
          {title}
        </div>
      )}
      <div className="px-2 pb-3">
        {empty ? (
          <div style={{ height }} className="flex items-center justify-center text-[var(--dim)] text-xs">
            No data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
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
                tickFormatter={v => formatValue(Number(v), yFormat)}
                tick={{ fontSize: 10, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
                width={52}
                domain={yFormat === 'percent' ? [0, 100] : ['auto', 'auto']}
              />
              <Tooltip
                content={(props: any) => <ChartTooltip {...props} yFormat={yFormat} />}
                cursor={{ stroke: 'rgba(148,163,184,0.25)', strokeWidth: 1 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              />
              {series.map(s => (
                <Line
                  key={s.instance}
                  type="monotone"
                  dataKey={s.instance}
                  stroke={s.color}
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0, fill: s.color }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
