import { useState, useRef, useEffect } from 'react'
import { Sun, Moon, Menu, Lock, LockOpen, X, Loader2, ExternalLink, Copy, Check, ChevronRight, Settings, HelpCircle } from 'lucide-react'
import { useStore, type View } from '../hooks/useStore'
import { cn } from '../lib/utils'
import { api } from '../lib/api'

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
  audit: 'Audit Log',
  thresholds: 'Alert Thresholds',
  guide: 'Feature Guide',
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
  const [tab, setTab] = useState<'login' | 'paste'>('paste')
  const [lines, setLines] = useState<{ type: 'output' | 'url' | 'error'; text: string }[]>([])
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [callbackState, setCallbackState] = useState<'idle' | 'submitting' | 'ok' | 'error'>('idle')
  const [callbackError, setCallbackError] = useState('')
  const [pasteJson, setPasteJson] = useState('')
  const [pasteState, setPasteState] = useState<'idle' | 'submitting' | 'ok' | 'error'>('idle')
  const [pasteError, setPasteError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const submitPaste = async () => {
    const raw = pasteJson.trim()
    if (!raw) return
    setPasteState('submitting')
    setPasteError('')
    try {
      const r = await fetch('/api/auth/set-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      setPasteState('ok')
      setTimeout(onSuccess, 800)
    } catch (e: any) {
      setPasteState('error')
      setPasteError(e.message ?? 'Failed')
    }
  }

  const buildCallbackUrl = (raw: string): string => {
    raw = raw.trim()
    if (raw.startsWith('http')) return raw
    let code = raw
    let st = ''
    const hashIdx = raw.indexOf('#')
    if (hashIdx !== -1) { code = raw.slice(0, hashIdx); st = raw.slice(hashIdx + 1) }
    if (!st && loginUrl) {
      try { st = new URL(loginUrl).searchParams.get('state') ?? '' } catch {}
    }
    return st ? `${code}#${st}` : code
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
              window.open(url, '_blank', 'noopener,noreferrer')
            } catch {}
          } else if (ev === 'output' && data) {
            try { const text = JSON.parse(data) as string; setLines(l => [...l, { type: 'output', text }]) } catch {}
          } else if (ev === 'error' && data) {
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
        if (!urlReceived) setState('done')
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          if (!urlReceived) {
            setState('error')
            setLines(l => [...l, { type: 'error', text: err.message }])
          }
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
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border)]">
          <Lock size={15} className="text-orange-400 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Re-authenticate Claude</div>
            <div className="text-[11px] text-[var(--dim)] mt-0.5">Your claude.ai session expired.</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--border)]">
          {(['paste', 'login'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={cn('px-4 py-2 text-[11px] font-medium transition-colors',
                tab === t ? 'border-b-2 border-[var(--accent)] text-[var(--fg)]' : 'text-[var(--dim)] hover:text-[var(--fg)]')}>
              {t === 'paste' ? 'Paste Tokens' : 'Login Flow'}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-3">
          {/* ── Paste tokens tab ── */}
          {tab === 'paste' && (
            <div className="space-y-3">
              <p className="text-[11px] text-[var(--dim)]">
                Paste your OAuth access token (<code className="font-mono bg-[var(--surface)] px-1 rounded text-[var(--fg)]">sk-ant-oat01-…</code>),
                the full credentials JSON from <code className="font-mono bg-[var(--surface)] px-1 rounded text-[var(--fg)]">~/.claude/.credentials.json</code>,
                or any JSON containing <code className="font-mono bg-[var(--surface)] px-1 rounded text-[var(--fg)]">accessToken</code>.
              </p>
              <textarea
                rows={5}
                value={pasteJson}
                onChange={e => setPasteJson(e.target.value)}
                placeholder="sk-ant-oat01-… or paste full credentials JSON"
                className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-3 py-2 text-[10px] font-mono text-[var(--fg)] placeholder-[var(--dim)] focus:outline-none focus:border-[var(--accent)] resize-none"
              />
              {pasteState === 'error' && <p className="text-[10px] text-red-400">{pasteError}</p>}
              {pasteState === 'ok' && <p className="text-[10px] text-green-400">Saved — you're back in.</p>}
              <button onClick={submitPaste} disabled={pasteState === 'submitting' || !pasteJson.trim()}
                className="px-4 py-1.5 rounded text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50">
                {pasteState === 'submitting' ? <Loader2 size={11} className="animate-spin inline" /> : 'Save'}
              </button>
            </div>
          )}

          {/* ── Login flow tab ── */}
          {tab === 'login' && (
            <>
              {state === 'running' && !loginUrl && (
                <div className="flex items-center gap-2 text-sm text-[var(--dim)]">
                  <Loader2 size={14} className="animate-spin" /> Starting authentication flow…
                </div>
              )}
              {loginUrl && (
                <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-blue-400">Login URL</span>
                    <div className="flex items-center gap-1.5">
                      <button onClick={copyUrl} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-[var(--surface)] border border-[var(--border)] text-[var(--dim)] hover:text-[var(--fg)] transition-colors">
                        {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
                        {copied ? 'Copied!' : 'Copy'}
                      </button>
                      <a href={loginUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-blue-500 text-white hover:bg-blue-600 transition-colors">
                        <ExternalLink size={10} /> Open
                      </a>
                    </div>
                  </div>
                  <input readOnly value={loginUrl} onFocus={e => e.target.select()}
                    className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-[10px] font-mono text-blue-300 focus:outline-none" />
                  <p className="text-[10px] text-[var(--dim)]">Complete login in the browser — this panel will close automatically when done.</p>
                </div>
              )}
              {nonUrlLines.filter(l => l.type === 'output').length > 0 && (
                <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] p-3 space-y-0.5 font-mono text-[10px]">
                  {nonUrlLines.filter(l => l.type === 'output').map((l, i) => (
                    <div key={i} className="text-[var(--dim)]">{l.text}</div>
                  ))}
                </div>
              )}
              {/* Manual callback — collapsed by default */}
              {loginUrl && state !== 'done' && (
                <div>
                  <button onClick={() => setShowManual(v => !v)} className="text-[10px] text-[var(--dim)] hover:text-[var(--fg)] underline">
                    {showManual ? 'Hide' : 'Not completing automatically? Paste callback URL'}
                  </button>
                  {showManual && (
                    <div className="mt-2 space-y-2">
                      <div className="flex gap-2">
                        <input type="text" value={callbackUrl} onChange={e => setCallbackUrl(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') submitCallback() }}
                          placeholder="Paste redirect URL or code…"
                          className="flex-1 bg-[var(--card)] border border-[var(--border)] rounded px-2 py-1.5 text-[10px] font-mono text-[var(--fg)] placeholder-[var(--dim)] focus:outline-none focus:border-[var(--accent)]"
                        />
                        <button onClick={() => submitCallback()} disabled={callbackState === 'submitting' || !callbackUrl.trim()}
                          className="px-3 py-1.5 rounded text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50">
                          {callbackState === 'submitting' ? <Loader2 size={11} className="animate-spin" /> : 'Submit'}
                        </button>
                      </div>
                      {callbackState === 'error' && <p className="text-[10px] text-red-400">{callbackError}</p>}
                      {callbackState === 'ok' && <p className="text-[10px] text-green-400">Forwarded — waiting…</p>}
                    </div>
                  )}
                </div>
              )}
              {state === 'done' && <div className="text-sm text-green-400">Authentication completed.</div>}
              {state === 'error' && !loginUrl && (
                <div className="text-[11px] text-red-400">Login flow failed. Try the "Paste Tokens" tab instead.</div>
              )}
              <div className="flex items-center gap-2">
                {state === 'running' && loginUrl && (
                  <><Loader2 size={10} className="animate-spin text-[var(--dim)]" />
                  <span className="text-[10px] text-[var(--dim)]">Waiting for login to complete…</span></>
                )}
                {state === 'done' && <span className="text-[10px] text-green-400">Done</span>}
              </div>
            </>
          )}
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
    view, selectedInstance, setView, rangePreset, setRangePreset, setCustomRange,
    theme, toggleTheme, authExpired, setAuthExpired,
    denseMode, setDenseMode,
    refreshInterval,
  } = useStore()

  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [showReAuth, setShowReAuth] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notifyStatus, setNotifyStatus] = useState<{
    slack: { configured: boolean; channel: string; has_token: boolean }
    pagerduty: { configured: boolean }
    webhook: { configured: boolean; url: string }
  } | null>(null)
  const settingsRef = useRef<HTMLDivElement>(null)

  // When auth expires, silently attempt token refresh before asking user to re-auth.
  useEffect(() => {
    if (!authExpired) return
    setRefreshing(true)
    fetch('/api/auth/refresh', { method: 'POST' })
      .then(r => r.json())
      .then((j: any) => {
        if (j.refreshed || j.message === 'token still valid') {
          setAuthExpired(false)
        } else {
          setShowReAuth(true)
        }
      })
      .catch(() => setShowReAuth(true))
      .finally(() => setRefreshing(false))
  }, [authExpired]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close settings popover when clicking outside
  useEffect(() => {
    if (!settingsOpen) return
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [settingsOpen])

  // Fetch notification status once on mount
  useEffect(() => {
    api.notifyStatus()
      .then(s => setNotifyStatus(s))
      .catch(() => {/* leave null */})
  }, [])

  const handleGo = () => {
    if (!customFrom || !customTo) return
    const fromTs = Math.floor(new Date(customFrom).getTime() / 1000)
    const toTs = Math.floor(new Date(customTo).getTime() / 1000)
    if (isNaN(fromTs) || isNaN(toTs) || fromTs >= toTs) return
    setCustomRange(fromTs, toTs)
  }

  const timeRangeViews = ['detail', 'alerts', 'explore', 'compare', 'advisor']
  const showTimeRange = timeRangeViews.includes(view)

  return (
    <>
      <header className="sticky top-0 z-30 bg-[var(--card)]/90 backdrop-blur-md border-b border-[var(--border)]">
        <div className="flex items-center justify-between px-4 h-11 gap-3">
          {/* Left: hamburger (mobile) + breadcrumb */}
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={onMobileMenuClick}
              className="md:hidden p-1.5 rounded-md text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors shrink-0"
              title="Open menu"
            >
              <Menu size={16} />
            </button>

            {/* Breadcrumb */}
            <div className="flex items-center gap-1 text-[12px] min-w-0">
              <button
                onClick={() => setView('overview')}
                className="text-[var(--dim)] hover:text-[var(--text)] transition-colors shrink-0 font-medium"
              >
                CH Analyzer
              </button>
              <ChevronRight size={11} className="text-[var(--border)] shrink-0" />
              <span className="text-[var(--text)] font-medium truncate" title={VIEW_TITLES[view] ?? 'Overview'}>
                {VIEW_TITLES[view] ?? 'Overview'}
              </span>
              {view === 'detail' && selectedInstance && (
                <>
                  <ChevronRight size={11} className="text-[var(--border)] shrink-0" />
                  <span className="text-[var(--accent)] font-medium truncate" title={selectedInstance}>
                    {selectedInstance}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Right: auth + theme + time range */}
          <div className="flex items-center gap-2">
            {/* LIVE indicator */}
            {refreshInterval > 0 && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-green-500/10 border border-green-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse shrink-0" />
                <span className="text-[10px] font-semibold text-green-400 uppercase tracking-wider hidden sm:inline">Live</span>
              </div>
            )}
            {/* Auth indicator */}
            <button
              onClick={() => !refreshing && setShowReAuth(true)}
              title={refreshing ? 'Refreshing token…' : authExpired ? 'Session expired — click to re-authenticate' : 'Claude auth — click to re-authenticate'}
              className={cn(
                'p-1.5 rounded-md transition-colors relative',
                refreshing
                  ? 'text-blue-400'
                  : authExpired
                  ? 'text-orange-400 hover:bg-orange-500/15 animate-pulse'
                  : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
              )}
            >
              {refreshing ? <Loader2 size={14} className="animate-spin" /> : authExpired ? <Lock size={14} /> : <LockOpen size={14} />}
              {authExpired && !refreshing && (
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-orange-400" />
              )}
            </button>

            {/* Settings gear */}
            <div ref={settingsRef} className="relative">
              <button
                onClick={() => setSettingsOpen(v => !v)}
                className={cn(
                  'p-1.5 rounded-md transition-colors',
                  settingsOpen
                    ? 'text-[var(--text)] bg-[var(--surface)]'
                    : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
                )}
                title="Settings"
              >
                <Settings size={14} />
              </button>

              {settingsOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg p-3 space-y-3">
                  {/* Dense mode */}
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-2">Display</div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={denseMode}
                        onChange={() => setDenseMode(!denseMode)}
                        className="rounded"
                      />
                      <span className="text-xs">Dense mode</span>
                    </label>
                  </div>

                  {/* Notifications */}
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-2">Notifications</div>
                    {notifyStatus === null ? (
                      <span className="text-[10px] text-[var(--dim)]">...</span>
                    ) : (
                      <div className="space-y-1">
                        {[
                          { label: 'Slack', ok: notifyStatus.slack.configured },
                          { label: 'PagerDuty', ok: notifyStatus.pagerduty.configured },
                          { label: 'Webhook', ok: notifyStatus.webhook.configured },
                        ].map(({ label, ok }) => (
                          <div key={label} className="flex items-center gap-2 text-xs">
                            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', ok ? 'bg-green-500' : 'bg-[var(--dim)]')} />
                            <span className={ok ? 'text-[var(--text)]' : 'text-[var(--dim)]'}>{label}</span>
                            {!ok && <span className="text-[9px] text-[var(--dim)] ml-auto">not configured</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => setView('guide')}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                view === 'guide'
                  ? 'text-[var(--accent)] bg-[var(--surface)]'
                  : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]'
              )}
              title="Feature guide (?)"
            >
              <HelpCircle size={14} />
            </button>

            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-md text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>

            {showTimeRange && (
              /* Mobile: compact preset pills only */
              <div className="flex md:hidden items-center gap-0.5 bg-[var(--surface)] rounded-md border border-[var(--border)] p-0.5">
                {PRESETS.map(p => (
                  <button
                    key={p}
                    onClick={() => setRangePreset(p)}
                    className={cn(
                      'px-1.5 py-1 rounded text-[10px] font-medium transition-colors',
                      rangePreset === p
                        ? 'bg-[var(--accent)] text-white'
                        : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--hover)]',
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}

            {showTimeRange && (
              <div className="hidden md:flex items-center gap-2">
                {/* Presets */}
                <div className="flex items-center bg-[var(--surface)] rounded-md border border-[var(--border)] p-0.5 gap-0.5">
                  {PRESETS.map(p => (
                    <button
                      key={p}
                      onClick={() => setRangePreset(p)}
                      className={cn(
                        'px-2 py-1 rounded text-[11px] font-medium transition-colors',
                        rangePreset === p
                          ? 'bg-[var(--accent)] text-white'
                          : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--hover)]',
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>

                {/* Quick ranges */}
                <div className="flex items-center gap-0.5">
                  {QUICK_RANGES.map(q => (
                    <button
                      key={q.label}
                      onClick={() => {
                        const f = toLocalDatetime(q.from())
                        const t = toLocalDatetime(q.to())
                        setCustomFrom(f)
                        setCustomTo(t)
                        setCustomRange(
                          Math.floor(q.from().getTime() / 1000),
                          Math.floor(q.to().getTime() / 1000),
                        )
                      }}
                      className="px-2 py-1 rounded text-[11px] text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
                    >
                      {q.label}
                    </button>
                  ))}
                </div>

                {/* Custom range */}
                <div className="flex items-center gap-1.5">
                  <input
                    type="datetime-local"
                    value={customFrom}
                    onChange={e => setCustomFrom(e.target.value)}
                    className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1 text-[11px] text-[var(--text)] w-[175px] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-[var(--dim)] text-[11px]">to</span>
                  <input
                    type="datetime-local"
                    value={customTo}
                    onChange={e => setCustomTo(e.target.value)}
                    className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1 text-[11px] text-[var(--text)] w-[175px] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={handleGo}
                    className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
                  >
                    Apply
                  </button>
                </div>
              </div>
            )}
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
