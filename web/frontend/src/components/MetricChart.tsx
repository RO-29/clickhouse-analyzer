import { useEffect, useState } from 'react'
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
import { api } from '../lib/api'
import { useStore } from '../hooks/useStore'
import { fmtBytes, fmtPercent, fmtNum } from '../lib/utils'
import type { MetricPoint } from '../types/api'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

const DEFAULT_COLORS = [
  '#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899',
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

export function MetricChart({ instance, title, metrics, height = 160, yFormat = 'number' }: MetricChartProps) {
  const { getTimeRange } = useStore()
  const { from, to } = getTimeRange()
  const [series, setSeries] = useState<{ label: string; color: string; points: MetricPoint[] }[]>([])
  const [loading, setLoading] = useState(true)

  // Normalize metrics to MetricDef[]
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
  const MS_DAY = 86_400_000

  const labels = points0.map(p => {
    const d = new Date(p.ts * 1000)
    if (spanMs > 7 * MS_DAY) {
      return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
    } else if (spanMs > MS_DAY) {
      return (
        d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      )
    }
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  })

  const data = {
    labels,
    datasets: series.map(s => ({
      label: s.label,
      data: s.points.map(p => p.value),
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
        min: yFormat === 'percent' ? 0 : undefined,
        max: yFormat === 'percent' ? 100 : undefined,
      },
    },
  }

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
      <div className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">
        {title}
      </div>
      <div className="px-5 pb-4">
        {loading ? (
          <div style={{ height }} className="flex items-center justify-center text-[var(--dim)] text-sm">
            Loading...
          </div>
        ) : series.length === 0 || series[0].points.length === 0 ? (
          <div style={{ height }} className="flex items-center justify-center text-[var(--dim)] text-sm">
            No data
          </div>
        ) : (
          <div style={{ height }}>
            <Line data={data} options={options} />
          </div>
        )}
      </div>
    </div>
  )
}
