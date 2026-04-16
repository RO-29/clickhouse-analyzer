import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
  type ScriptableContext,
} from 'chart.js'
import { Sparkles } from 'lucide-react'
import { fmtBytes, fmtDuration, fmtCompact } from '../lib/utils'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

interface SeriesDef {
  key: string
  label: string
  color: string
}

interface HistoryChartProps {
  data: Record<string, any>[]
  series: SeriesDef[]
  title: string
  height?: number
  yFormat?: 'bytes' | 'ms' | 'number'
  note?: string  // shown below title when all series values are zero (N/A indicator)
  onAnalyze?: (data: Record<string, any>[], series: SeriesDef[], title: string) => void
}

export function HistoryChart({
  data: rawData,
  series,
  title,
  height = 160,
  yFormat = 'number',
  note,
  onAnalyze,
}: HistoryChartProps) {
  const data = Array.isArray(rawData) ? rawData : []

  const formatValue = (v: number) => {
    if (yFormat === 'bytes') return fmtBytes(v)
    if (yFormat === 'ms') return fmtDuration(v)
    return fmtCompact(v)
  }

  const spanMs = (() => {
    if (data.length < 2) return 0
    const toMs = (t: any) => typeof t === 'string' ? new Date(t).getTime() : t * 1000
    return Math.abs(toMs(data[data.length - 1].ts) - toMs(data[0].ts))
  })()
  const MS_DAY = 86_400_000

  const labels = data.map(row => {
    const ts = row.ts
    if (!ts) return ''
    const d = typeof ts === 'string' ? new Date(ts) : new Date(ts * 1000)
    if (spanMs > 7 * MS_DAY) return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
    if (spanMs > MS_DAY) return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  })

  const chartData = {
    labels,
    datasets: series.map(s => ({
      label: s.label,
      data: data.map(row => Number(row[s.key]) || 0),
      borderColor: s.color,
      // Gradient fill — opaque near the line, transparent at the bottom
      backgroundColor: (ctx: ScriptableContext<'line'>) => {
        const chart = ctx.chart
        const { ctx: c, chartArea } = chart
        if (!chartArea) return s.color + '20'
        const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
        gradient.addColorStop(0, s.color + '4d')   // ~30%
        gradient.addColorStop(0.55, s.color + '15') // ~8%
        gradient.addColorStop(1, s.color + '00')    // 0%
        return gradient
      },
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: s.color,
      pointHoverBorderWidth: 2,
      tension: 0.3,
      fill: series.length === 1,
    })),
  }

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: series.length > 1,
        position: 'bottom',
        labels: { boxWidth: 10, padding: 10, color: '#9ca3af', font: { size: 11 } },
      },
      tooltip: {
        backgroundColor: 'rgba(15,20,30,0.95)',
        borderColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        titleColor: '#f3f4f6',
        bodyColor: '#9ca3af',
        padding: 10,
        cornerRadius: 8,
        callbacks: {
          title: items => {
            if (!items.length) return ''
            const row = data[items[0].dataIndex]
            if (!row?.ts) return String(items[0].label ?? '')
            const d = typeof row.ts === 'string' ? new Date(row.ts) : new Date(row.ts * 1000)
            return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
          },
          label: ctx => ` ${ctx.dataset.label}: ${formatValue(ctx.parsed.y)}`,
        },
      },
    },
    scales: {
      x: {
        ticks: { maxTicksLimit: 8, color: '#6b7280', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { display: false },
      },
      y: {
        ticks: { callback: v => formatValue(Number(v)), color: '#6b7280', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { display: false },
      },
    },
  }

  const empty = data.length === 0
  const allZero = !empty && note !== undefined && series.every(s =>
    data.every(row => !(Number(row[s.key]) > 0))
  )

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
      <div className="px-5 pt-4 pb-2 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">{title}</span>
          {allZero && note && (
            <span className="ml-2 text-[11px] text-[var(--dim)] italic normal-case tracking-normal">{note}</span>
          )}
        </div>
        {onAnalyze && !empty && !allZero && (
          <button
            onClick={() => onAnalyze(data, series, title)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-purple-400 hover:bg-purple-500/15 border border-transparent hover:border-purple-500/20 transition-colors"
            title="Analyze with AI"
          >
            <Sparkles size={11} />
            Analyze
          </button>
        )}
      </div>
      <div className="px-5 pb-4">
        {empty ? (
          <div style={{ height }} className="flex items-center justify-center text-[var(--dim)]">
            <svg width="100%" height={height} className="opacity-[0.12]">
              <rect x="4" y="4" width="calc(100% - 8)" height={height - 8} rx="6"
                fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 4" />
              <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle"
                fill="currentColor" fontSize="12" fontFamily="system-ui, sans-serif">
                No data in range
              </text>
            </svg>
          </div>
        ) : allZero ? (
          <div style={{ height }} className="flex items-center justify-center">
            <span className="text-[var(--dim)] text-xs italic opacity-60">— not applicable —</span>
          </div>
        ) : (
          <div style={{ height }}>
            <Line data={chartData} options={options} />
          </div>
        )}
      </div>
    </div>
  )
}
