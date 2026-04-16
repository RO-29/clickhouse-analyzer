import { useState, useRef, useEffect } from 'react'
import { Sun, Moon, Menu, Lock, LockOpen, X, Loader2, ExternalLink, Copy, Check } from 'lucide-react'
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
  discover: 'Feature Guide',
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
  const [copied, setCopied] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [callbackState, setCallbackState] = useState<'idle' | 'submitting' | 'ok' | 'error'>('idle')
  const [callbackError, setCallbackError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  // Build a full callback URL from whatever the user pasted.
  // Accepts: bare code, full platform.claude.com URL, or localhost URL.
  const buildCallbackUrl = (raw: string): string => {
    raw = raw.trim()
    if (raw.startsWith('http')) return raw  // already a URL — send as-is, backend strips #fragment
    // Bare code — platform.claude.com sometimes appends #STATE to the code.
    // Strip the fragment: the real code is the part before '#'.
    let code = raw
    let state = ''
    const hashIdx = raw.indexOf('#')
    if (hashIdx !== -1) { code = raw.slice(0, hashIdx); state = raw.slice(hashIdx + 1) }
    // If no state from the code, try extracting from the login URL
    if (!state && loginUrl) {
      try { state = new URL(loginUrl).searchParams.get('state') ?? '' } catch {}
    }
    return `https://platform.claude.com/oauth/code/callback?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`
  }

  const submitCallback = async (rawOverride?: string) => {
    const raw = (rawOverride ?? callbackUrl).trim()
    if (!raw) return
    const u = buildCallbackUrl(raw)
    setCallbackUrl(u)
    setCallbackState('submitting')
    setCallbackError('')
    try {
      const r = await fetch('/api/auth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      setCallbackState('ok')
      // The claude process will now exit 0 and send event:done — wait for it
    } catch (e: any) {
      setCallbackState('error')
      setCallbackError(e.message ?? 'Failed')
    }
  }

  const copyUrl = () => {
    if (!loginUrl) return
    navigator.clipboard.writeText(loginUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Start the login flow immediately on mount
  useEffect(() => {
    const ac = new AbortController()
    abortRef.current = ac
    setState('running')

    ;(async () => {
      let urlReceived = false
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
              urlReceived = true
              setLoginUrl(url)
              // Auto-open in new tab immediately
              window.open(url, '_blank', 'noopener,noreferrer')
            } catch {}
          } else if (ev === 'output' && data) {
            // Parse immediately — don't close over `data` (it's reset to '' before
            // React runs the updater, causing JSON.parse('') to throw uncaught).
            try { const text = JSON.parse(data) as string; setLines(l => [...l, { type: 'output', text }]) } catch {}
          } else if (ev === 'error' && data) {
            // Suppress process-exit errors when the URL was already delivered —
            // on headless servers claude exits non-zero after echoing the URL
            // (no real browser to open), but auth still completes fine.
            if (!urlReceived) {
              try { const text = JSON.parse(data) as string; setLines(l => [...l, { type: 'error', text }]) } catch {}
            }
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
        // Stream ended. If URL was delivered but no 'done' event arrived (claude
        // exited before completing token exchange), keep modal open so the user
        // can still paste the callback code. Don't auto-close or show error.
        // If no URL was delivered at all, something went wrong — show done so
        // the modal doesn't spin forever.
        if (!urlReceived) setState('done')
        // If urlReceived && no done event: leave state as 'running' so the
        // callback paste section stays visible.
      } catch (err: any) {
        // ERR_INCOMPLETE_CHUNKED_ENCODING and similar network errors are expected
        // when the underlying process exits while the SSE stream is open.
        // If we already have a URL, suppress the error — auth can still complete
        // via the callback paste.
        if (err.name !== 'AbortError') {
          if (!urlReceived) {
            setState('error')
            setLines(l => [...l, { type: 'error', text: err.message }])
          }
          // else: URL delivered, stream just closed — not a real error
        }
      }
    })()

    return () => ac.abort()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const nonUrlLines = lines.filter(l => l.type !== 'url')

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
              Your claude.ai session expired. Complete login in the browser tab that just opened.
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-3">
          {state === 'running' && !loginUrl && (
            <div className="flex items-center gap-2 text-sm text-[var(--dim)]">
              <Loader2 size={14} className="animate-spin" />
              Starting authentication flow…
            </div>
          )}

          {/* URL section */}
          {loginUrl && (
            <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-blue-400">Login URL</span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={copyUrl}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-[var(--surface)] border border-[var(--border)] text-[var(--dim)] hover:text-[var(--fg)] hover:border-blue-500/50 transition-colors"
                  >
                    {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                  <a
                    href={loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                  >
                    <ExternalLink size={11} /> Open
                  </a>
                </div>
              </div>
              {/* URL in a selectable input — no overflow, easy to select-all */}
              <input
                readOnly
                value={loginUrl}
                onFocus={e => e.target.select()}
                className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] font-mono text-blue-300 focus:outline-none focus:border-blue-500/50 cursor-text"
              />
              <p className="text-[10px] text-[var(--dim)]">
                A browser tab was opened automatically. If it didn't open, use Copy or click Open.
                This panel will close automatically once login is complete.
              </p>
            </div>
          )}

          {/* Callback — shown once the login URL is displayed */}
          {loginUrl && state !== 'done' && callbackState !== 'ok' && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 space-y-2">
              <div className="text-[11px] font-semibold text-[var(--dim)]">
                After login — paste the OAuth code
              </div>
              <p className="text-[10px] text-[var(--dim)] leading-relaxed">
                After approving on claude.ai your browser redirects to a URL with <code className="font-mono bg-[var(--card)] px-1 rounded">?code=…</code>.
                Paste <strong className="text-[var(--fg)]">just the code</strong>, or the full URL — either works.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={callbackUrl}
                  onChange={e => setCallbackUrl(e.target.value)}
                  onPaste={e => {
                    e.preventDefault()
                    const pasted = e.clipboardData.getData('text').trim()
                    setCallbackUrl(pasted)
                    submitCallback(pasted)
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') submitCallback() }}
                  placeholder="Paste code or full redirect URL…"
                  className="flex-1 bg-[var(--card)] border border-[var(--border)] rounded px-2 py-1.5 text-[11px] font-mono text-[var(--fg)] placeholder-[var(--dim)] focus:outline-none focus:border-[var(--accent)]"
                />
                <button
                  onClick={() => submitCallback()}
                  disabled={callbackState === 'submitting' || !callbackUrl.trim()}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {callbackState === 'submitting' ? <Loader2 size={12} className="animate-spin" /> : 'Submit'}
                </button>
              </div>
              {callbackState === 'error' && (
                <p className="text-[10px] text-red-400">{callbackError}</p>
              )}
            </div>
          )}

          {callbackState === 'ok' && state !== 'done' && (
            <div className="flex items-center gap-2 text-[11px] text-green-400">
              <Check size={12} /> Callback forwarded — waiting for claude to complete…
              <Loader2 size={11} className="animate-spin ml-1" />
            </div>
          )}

          {/* Output log — only non-URL, non-error lines */}
          {nonUrlLines.filter(l => l.type === 'output').length > 0 && (
            <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] p-3 space-y-0.5 font-mono text-[11px]">
              {nonUrlLines.filter(l => l.type === 'output').map((l, i) => (
                <div key={i} className="text-[var(--dim)]">{l.text}</div>
              ))}
            </div>
          )}

          {state === 'done' && !loginUrl && (
            <div className="text-sm text-green-400">Authentication completed successfully.</div>
          )}

          {/* Only show hard error if no URL was received */}
          {state === 'error' && !loginUrl && (
            <div className="text-sm text-red-400">
              Login flow failed. SSH into the server and run:{' '}
              <code className="font-mono bg-[var(--surface)] px-1 rounded">
                HOME=/var/lib/ch-analyzer claude auth login
              </code>
            </div>
          )}

          {/* Status */}
          <div className="flex items-center gap-2">
            {state === 'running' && loginUrl && (
              <><Loader2 size={11} className="animate-spin text-[var(--dim)]" />
              <span className="text-[10px] text-[var(--dim)]">Waiting for you to complete login…</span></>
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
