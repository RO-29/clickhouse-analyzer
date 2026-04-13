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
} from 'chart.js'
import { Sparkles } from 'lucide-react'
import { fmtBytes, fmtDuration, fmtNum } from '../lib/utils'

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
  onAnalyze?: (data: Record<string, any>[], series: SeriesDef[], title: string) => void
}

export function HistoryChart({
  data: rawData,
  series,
  title,
  height = 160,
  yFormat = 'number',
  onAnalyze,
}: HistoryChartProps) {
  const data = Array.isArray(rawData) ? rawData : []
  const formatValue = (v: number) => {
    if (yFormat === 'bytes') return fmtBytes(v)
    if (yFormat === 'ms') return fmtDuration(v)
    return fmtNum(v)
  }

  const labels = data.map(row => {
    const ts = row.ts
    if (!ts) return ''
    const d = typeof ts === 'string' ? new Date(ts) : new Date(ts * 1000)
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  })

  const chartData = {
    labels,
    datasets: series.map(s => ({
      label: s.label,
      data: data.map(row => Number(row[s.key]) || 0),
      borderColor: s.color,
      backgroundColor: s.color + '1a',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.3,
      fill: series.length === 1,
    })),
  }

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: series.length > 1,
        position: 'bottom',
        labels: { boxWidth: 12, padding: 8, color: '#9ca3af', font: { size: 11 } },
      },
      tooltip: {
        callbacks: {
          label: ctx => `${ctx.dataset.label}: ${formatValue(ctx.parsed.y)}`,
        },
      },
    },
    scales: {
      x: {
        ticks: { maxTicksLimit: 8, color: '#6b7280', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
      },
      y: {
        ticks: {
          callback: v => formatValue(Number(v)),
          color: '#6b7280',
          font: { size: 10 },
        },
        grid: { color: 'rgba(255,255,255,0.04)' },
      },
    },
  }

  const empty = data.length === 0

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
      <div className="px-5 pt-4 pb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)] flex-1">
          {title}
        </span>
        {onAnalyze && !empty && (
          <button
            onClick={() => onAnalyze(data, series, title)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-purple-400 hover:bg-purple-500/15 border border-transparent hover:border-purple-500/20 transition-colors"
            title="Analyze this chart with AI"
          >
            <Sparkles size={11} />
            Analyze
          </button>
        )}
      </div>
      <div className="px-5 pb-4">
        {empty ? (
          <div style={{ height }} className="flex items-center justify-center text-[var(--dim)] text-sm">
            No data
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
