import { useState, useRef, useEffect } from 'react'
import { Sun, Moon, Menu, Lock, LockOpen, X, Loader2, ExternalLink } from 'lucide-react'
import { useStore, type View } from '../hooks/useStore'
import { cn } from '../lib/utils'

const VIEW_TITLES: Record<View, string> = {
  overview: 'Overview',
  detail: 'Instance Detail',
  alerts: 'Alerts',
  history: 'Alert History',
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
  runcheck: 'Run Checks',
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

/* ── Re-auth modal ─────────────────────────────────────────────────────────── */

function ReAuthModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [lines, setLines] = useState<{ type: 'output' | 'url' | 'error'; text: string }[]>([])
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Start the login flow immediately on mount
  useEffect(() => {
    const ac = new AbortController()
    abortRef.current = ac
    setState('running')

    ;(async () => {
      try {
        const resp = await fetch('/api/auth/login', { method: 'POST', signal: ac.signal })
        if (!resp.ok || !resp.body) {
          setState('error')
          setLines(l => [...l, { type: 'error', text: `HTTP ${resp.status}` }])
          return
        }
        const reader = resp.body.getReader()
        const dec = new TextDecoder()
        let buf = '', ev = '', data = ''
        const flush = () => {
          if (ev === 'url' && data) {
            try {
              const url = JSON.parse(data) as string
              setLoginUrl(url)
              setLines(l => [...l, { type: 'url', text: url }])
            } catch {}
          } else if (ev === 'output' && data) {
            try { setLines(l => [...l, { type: 'output', text: JSON.parse(data) as string }]) } catch {}
          } else if (ev === 'error' && data) {
            try { setLines(l => [...l, { type: 'error', text: JSON.parse(data) as string }]) } catch {}
          } else if (ev === 'done') {
            setState('done')
            setTimeout(onSuccess, 1000)
          }
          ev = ''; data = ''
        }
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const parts = buf.split('\n')
          buf = parts.pop() ?? ''
          for (const line of parts) {
            if (line === '') flush()
            else if (line.startsWith('event: ')) ev = line.slice(7).trim()
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
        }
        if (state !== 'done') setState('done')
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setState('error')
          setLines(l => [...l, { type: 'error', text: err.message }])
        }
      }
    })()

    return () => ac.abort()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-xl rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border)]">
          <Lock size={16} className="text-orange-400 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Re-authenticate Claude</div>
            <div className="text-[11px] text-[var(--dim)] mt-0.5">
              Your claude.ai session expired. Open the link below on any device to log back in.
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {state === 'running' && lines.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-[var(--dim)]">
              <Loader2 size={14} className="animate-spin" />
              Starting authentication flow…
            </div>
          )}

          {/* URL — most important, shown prominently */}
          {loginUrl && (
            <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 space-y-2">
              <div className="text-xs font-semibold text-blue-400">Open this URL in your browser:</div>
              <a
                href={loginUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-1.5 text-[11px] font-mono text-blue-300 hover:text-blue-200 break-all leading-relaxed"
              >
                <ExternalLink size={11} className="shrink-0 mt-0.5" />
                {loginUrl}
              </a>
              <p className="text-[10px] text-[var(--dim)]">
                After completing login in your browser, this panel will close automatically.
              </p>
            </div>
          )}

          {/* Other output lines */}
          {lines.filter(l => l.type !== 'url').length > 0 && (
            <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] p-3 space-y-1 font-mono text-[11px]">
              {lines.filter(l => l.type !== 'url').map((l, i) => (
                <div key={i} className={l.type === 'error' ? 'text-red-400' : 'text-[var(--dim)]'}>
                  {l.text}
                </div>
              ))}
            </div>
          )}

          {state === 'done' && !loginUrl && (
            <div className="text-sm text-green-400">Authentication completed successfully.</div>
          )}

          {state === 'error' && (
            <div className="text-sm text-red-400">
              Login flow failed. SSH into the server and run:{' '}
              <code className="font-mono bg-[var(--surface)] px-1 rounded">
                HOME=/var/lib/ch-analyzer claude auth login
              </code>
            </div>
          )}

          {/* Status indicator */}
          <div className="flex items-center gap-2">
            {state === 'running' && (
              <><Loader2 size={11} className="animate-spin text-[var(--dim)]" />
              <span className="text-[10px] text-[var(--dim)]">Waiting for login flow…</span></>
            )}
            {state === 'done' && <span className="text-[10px] text-green-400">Done</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── TopBar ────────────────────────────────────────────────────────────────── */

interface TopBarProps {
  onMobileMenuClick?: () => void
}

export function TopBar({ onMobileMenuClick }: TopBarProps) {
  const {
    view, selectedInstance, rangePreset, setRangePreset, setCustomRange,
    theme, toggleTheme, authExpired, setAuthExpired,
  } = useStore()

  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [showReAuth, setShowReAuth] = useState(false)

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
    <>
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

          {/* Right: auth + theme toggle + time range controls */}
          <div className="flex items-center gap-3">
            {/* Auth indicator — always visible, prominent when expired */}
            <button
              onClick={() => setShowReAuth(true)}
              title={authExpired ? 'Session expired — click to re-authenticate' : 'Claude auth — click to re-authenticate'}
              className={cn(
                'p-1.5 rounded-lg transition-colors relative',
                authExpired
                  ? 'text-orange-400 hover:bg-orange-500/15 animate-pulse'
                  : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
              )}
            >
              {authExpired ? <Lock size={15} /> : <LockOpen size={15} />}
              {authExpired && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-400" />
              )}
            </button>

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

      {showReAuth && (
        <ReAuthModal
          onClose={() => setShowReAuth(false)}
          onSuccess={() => {
            setShowReAuth(false)
            setAuthExpired(false)
          }}
        />
      )}
    </>
  )
}
