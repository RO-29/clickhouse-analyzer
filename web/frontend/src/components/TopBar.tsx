import { useState } from 'react'
import { Sun, Moon, Menu } from 'lucide-react'
import { useStore, type View } from '../hooks/useStore'
import { cn } from '../lib/utils'

const VIEW_TITLES: Record<View, string> = {
  overview: 'Overview',
  detail: 'Instance Detail',
  alerts: 'Alerts',
  explore: 'Explore',
  compare: 'Compare Nodes',
  advisor: 'Advisor',
  terminal: 'Terminal',
  scanner: 'Table Scanner',
  cost: 'Cost Explorer',
  analyzer: 'AI Analyzer',
  logs: 'Application Logs',
  chlogs: 'ClickHouse Logs',
  maintenance: 'Maintenance Windows',
}

const PRESETS = ['15m', '1h', '6h', '24h', '7d']

function toLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const QUICK_RANGES = [
  { label: 'Today', from: () => { const d = new Date(); d.setHours(0,0,0,0); return d }, to: () => new Date() },
  { label: 'Yesterday', from: () => { const d = new Date(); d.setDate(d.getDate()-1); d.setHours(0,0,0,0); return d }, to: () => { const d = new Date(); d.setDate(d.getDate()-1); d.setHours(23,59,59,0); return d } },
  { label: 'Last 2h', from: () => new Date(Date.now()-2*3600000), to: () => new Date() },
  { label: 'Last 12h', from: () => new Date(Date.now()-12*3600000), to: () => new Date() },
]

interface TopBarProps {
  onMobileMenuClick?: () => void
}

export function TopBar({ onMobileMenuClick }: TopBarProps) {
  const { view, selectedInstance, rangePreset, setRangePreset, setCustomRange, theme, toggleTheme } = useStore()

  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  const title = view === 'detail' && selectedInstance
    ? `${selectedInstance}`
    : VIEW_TITLES[view] ?? 'Overview'

  const handleGo = () => {
    if (!customFrom || !customTo) return
    const fromTs = Math.floor(new Date(customFrom).getTime() / 1000)
    const toTs = Math.floor(new Date(customTo).getTime() / 1000)
    if (isNaN(fromTs) || isNaN(toTs) || fromTs >= toTs) return
    setCustomRange(fromTs, toTs)
  }

  // These views don't use the time range selector
  const timeRangeViews = ['detail', 'alerts', 'explore', 'compare', 'advisor']
  const showTimeRange = timeRangeViews.includes(view)

  return (
    <header className="sticky top-0 z-30 bg-[var(--bg)]/80 backdrop-blur-sm border-b border-[var(--border)]">
      <div className="flex items-center justify-between px-3 sm:px-6 h-12 gap-3">
        {/* Left: hamburger (mobile) + page title */}
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onMobileMenuClick}
            className="md:hidden p-1.5 rounded-lg text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors shrink-0"
            title="Open menu"
          >
            <Menu size={18} />
          </button>
          <h1 className="text-sm font-semibold truncate">{title}</h1>
        </div>

        {/* Right: theme toggle + time range controls */}
        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-lg text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        {!showTimeRange ? null : <div className="hidden md:flex items-center gap-2">
          {/* Presets */}
          <div className="flex items-center bg-[var(--surface)] rounded-lg border border-[var(--border)] p-0.5">
            {PRESETS.map(p => (
              <button
                key={p}
                onClick={() => setRangePreset(p)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                  rangePreset === p
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--dim)] hover:text-[var(--text)]',
                )}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Quick ranges */}
          <div className="flex items-center gap-1">
            {QUICK_RANGES.map(q => (
              <button
                key={q.label}
                onClick={() => {
                  const f = toLocalDatetime(q.from())
                  const t = toLocalDatetime(q.to())
                  setCustomFrom(f)
                  setCustomTo(t)
                  const fromTs = Math.floor(q.from().getTime() / 1000)
                  const toTs = Math.floor(q.to().getTime() / 1000)
                  setCustomRange(fromTs, toTs)
                }}
                className="px-2 py-1 rounded-md text-xs text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
              >
                {q.label}
              </button>
            ))}
          </div>

          {/* Custom range */}
          <div className="flex items-center gap-2">
            <input
              type="datetime-local"
              value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
              className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text)] w-[200px] focus:outline-none focus:border-[var(--accent)]"
            />
            <span className="text-[var(--dim)] text-sm">to</span>
            <input
              type="datetime-local"
              value={customTo}
              onChange={e => setCustomTo(e.target.value)}
              className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--text)] w-[200px] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={handleGo}
              className="px-3 py-1 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
            >
              Go
            </button>
          </div>
        </div>}
        </div>
      </div>
    </header>
  )
}
