import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertCircle, CheckCircle2, ChevronDown,
  ClipboardCopy, Clock, Database, Loader2, RefreshCw, Send, Sparkles, X,
} from 'lucide-react'
import { marked } from 'marked'
import { useStore } from '../hooks/useStore'
import { cn } from '../lib/utils'

/* ─── marked config ──────────────────────────────────────────────────────── */

marked.use({ gfm: true, breaks: false })

/* ─── Types ─────────────────────────────────────────────────────────────── */

type Phase = 'idle' | 'collecting' | 'sending' | 'streaming' | 'done' | 'error'

interface CollectionStep {
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
}

type ModeId = 'full' | 'slow-queries' | 'parts-merges' | 'inserts' | 'errors'

interface Mode {
  id: ModeId
  label: string
  description: string
}

const MODES: Mode[] = [
  { id: 'full', label: 'Full Health Scan', description: 'Complete diagnosis: disk, memory, queries, merges, parts, errors.' },
  { id: 'slow-queries', label: 'Slow Query Hunter', description: 'Rank expensive queries by duration & memory. Get fix SQL.' },
  { id: 'parts-merges', label: 'Parts & Merges', description: 'Diagnose part explosion, slow merges, mutation backlog.' },
  { id: 'inserts', label: 'Insert Optimization', description: 'Analyze throughput, batch sizing, fragmentation risk.' },
  { id: 'errors', label: 'Error Investigation', description: 'Surface recent query errors with root cause & fixes.' },
]

const TIME_WINDOWS = [
  { label: 'Last 1 hour', value: 60 },
  { label: 'Last 3 hours', value: 180 },
  { label: 'Last 6 hours', value: 360 },
  { label: 'Last 24 hours', value: 1440 },
  { label: 'Last 3 days', value: 4320 },
  { label: 'Last 7 days', value: 10080 },
]

const STEPS_BY_MODE: Record<ModeId, string[]> = {
  full: ['Cluster health', 'Disk usage', 'Slow queries (duration)', 'Slow queries (memory)', 'Insert patterns', 'Active merges', 'Parts health', 'Error patterns'],
  'slow-queries': ['Cluster health', 'Disk usage', 'Slow queries (duration)', 'Slow queries (memory)'],
  'parts-merges': ['Cluster health', 'Disk usage', 'Active merges', 'Parts health'],
  inserts: ['Cluster health', 'Disk usage', 'Insert patterns', 'Active merges', 'Parts health'],
  errors: ['Cluster health', 'Disk usage', 'Error patterns'],
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function healthColor(text: string): 'critical' | 'warning' | 'ok' | 'info' {
  const u = text.toUpperCase()
  if (u.includes('CRITICAL')) return 'critical'
  if (u.includes('WARNING')) return 'warning'
  if (u.includes('OK') || u.includes('NO SIGNIFICANT')) return 'ok'
  return 'info'
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function CollectionProgress({ steps }: { steps: CollectionStep[] }) {
  return (
    <div className="flex flex-col gap-1.5 p-4 bg-[var(--hover)] rounded-lg border border-[var(--border)]">
      <div className="text-xs font-medium text-[var(--dim)] mb-1 flex items-center gap-1.5">
        <Activity size={13} className="text-[var(--accent)]" style={{ animation: 'pulse 2s infinite' }} />
        Collecting cluster data…
      </div>
      {steps.map((step) => (
        <div key={step.label} className="flex items-center gap-2 text-xs">
          {step.status === 'running' && <Loader2 size={12} className="text-[var(--accent)] animate-spin shrink-0" />}
          {step.status === 'done' && <CheckCircle2 size={12} className="text-green-500 shrink-0" />}
          {step.status === 'error' && <AlertCircle size={12} className="text-orange-500 shrink-0" />}
          {step.status === 'pending' && <span className="w-3 h-3 text-[var(--dim)] text-center shrink-0">·</span>}
          <span className={cn(
            step.status === 'running' && 'text-[var(--text)]',
            step.status === 'done' && 'text-[var(--dim)]',
            step.status === 'error' && 'text-orange-500',
            step.status === 'pending' && 'text-[var(--dim)] opacity-50',
          )}>
            {step.label}
          </span>
        </div>
      ))}
    </div>
  )
}

function AnalysisOutput({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const color = healthColor(text)
  const bannerStyles = {
    critical: 'bg-red-500/10 border-red-500/30 text-red-400',
    warning: 'bg-orange-500/10 border-orange-500/30 text-orange-400',
    ok: 'bg-green-500/10 border-green-500/30 text-green-400',
    info: 'bg-[var(--accent)]/10 border-[var(--accent)]/30 text-[var(--accent)]',
  }

  const hasSummary = text.toLowerCase().includes('## summary')

  const html = useMemo(() => {
    // Parse with marked (handles tables, lists, headings, HR, code blocks)
    let out = marked.parse(text) as string

    // Inject severity CSS classes — marked converts **CRITICAL** → <strong>CRITICAL</strong>
    out = out
      .replace(/🔴\s*<strong>CRITICAL<\/strong>/g, '<span class="sev-critical">🔴 CRITICAL</span>')
      .replace(/🟠\s*<strong>WARNING<\/strong>/g, '<span class="sev-warning">🟠 WARNING</span>')
      .replace(/🟡\s*<strong>INFO<\/strong>/g, '<span class="sev-info">🟡 INFO</span>')
      // Also handle plain emoji+text (no bold) that Claude sometimes outputs
      .replace(/🔴 CRITICAL(?!<)/g, '<span class="sev-critical">🔴 CRITICAL</span>')
      .replace(/🟠 WARNING(?!<)/g, '<span class="sev-warning">🟠 WARNING</span>')
      .replace(/🟡 INFO(?!<)/g, '<span class="sev-info">🟡 INFO</span>')

    if (isStreaming) {
      out += '<span class="streaming-cursor"></span>'
    }
    return out
  }, [text, isStreaming])

  return (
    <div className="flex flex-col gap-3">
      {hasSummary && (
        <div className={cn('flex items-center gap-2 px-3 py-1.5 rounded border text-xs font-medium', bannerStyles[color])}>
          {color === 'critical' && <AlertCircle size={13} />}
          {color === 'warning' && <AlertCircle size={13} />}
          {color === 'ok' && <CheckCircle2 size={13} />}
          {color === 'info' && <Sparkles size={13} />}
          <span className="uppercase font-semibold">{color === 'ok' ? 'HEALTHY' : color.toUpperCase()}</span>
          <span className="opacity-60 font-normal">— overall cluster status</span>
        </div>
      )}
      <div
        className="analysis-output text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

/* ─── Elapsed timer hook ─────────────────────────────────────────────────── */

function useElapsed(running: boolean) {
  const [secs, setSecs] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (running) {
      startRef.current = Date.now()
      setSecs(0)
      const id = setInterval(() => {
        setSecs(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000))
      }, 1000)
      return () => clearInterval(id)
    } else {
      startRef.current = null
    }
  }, [running])

  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/* ─── Running / Done info card ───────────────────────────────────────────── */

interface RunningInfoCardProps {
  mode: Mode
  instance: string
  timeWindow: number
  phase: Phase
  steps: CollectionStep[]
  linesReceived: number
}

function RunningInfoCard({ mode, instance, timeWindow, phase, steps, linesReceived }: RunningInfoCardProps) {
  // Timer stops when done — preserves the final elapsed value
  const elapsed = useElapsed(phase !== 'done')
  const timeLabel = TIME_WINDOWS.find((t) => t.value === timeWindow)?.label ?? `${timeWindow}m`

  const doneSteps = steps.filter((s) => s.status === 'done').length
  const totalSteps = steps.length
  const pct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : (phase === 'streaming' ? 100 : 0)

  const isDone = phase === 'done'

  const phaseLabel = isDone ? 'Complete' : {
    collecting: 'Collecting cluster data…',
    sending:    'Building AI prompt…',
    streaming:  linesReceived > 0 ? `Receiving analysis (${linesReceived} lines)…` : 'Waiting for Claude…',
    idle:       '',
    error:      'Error',
    done:       'Complete',
  }[phase] ?? ''

  return (
    <div className={cn(
      'shrink-0 mx-4 mt-3 mb-1 rounded-xl border px-4 py-3 flex flex-col gap-2.5',
      isDone
        ? 'border-green-500/25 bg-green-500/5'
        : 'border-[var(--accent)]/25 bg-[var(--accent)]/5',
    )}>
      {/* Top row: badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className={cn('flex items-center gap-1.5 text-xs font-semibold', isDone ? 'text-green-500' : 'text-[var(--accent)]')}>
          <Sparkles size={13} />
          {mode.label}
        </div>
        <span className="text-[var(--border)]">|</span>
        <div className="flex items-center gap-1 text-xs text-[var(--dim)]">
          <Database size={11} />
          {instance}
        </div>
        <span className="text-[var(--border)]">|</span>
        <div className="flex items-center gap-1 text-xs text-[var(--dim)]">
          <Activity size={11} />
          {timeLabel}
        </div>
        <span className="text-[var(--border)]">|</span>
        <div className="flex items-center gap-1 text-xs text-[var(--dim)]">
          <Clock size={11} />
          {elapsed}
        </div>
        <div className={cn('ml-auto flex items-center gap-1.5 text-xs font-medium', isDone ? 'text-green-500' : 'text-[var(--accent)]')}>
          {isDone
            ? <CheckCircle2 size={12} />
            : <Loader2 size={12} className="animate-spin" />
          }
          <span>{phaseLabel}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1 rounded-full bg-[var(--border)] overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', isDone ? 'bg-green-500' : 'bg-[var(--accent)]')}
          style={{ width: (phase === 'streaming' || isDone) ? '100%' : `${pct}%` }}
        />
      </div>

      {/* Steps summary (collecting/sending only) */}
      {(phase === 'collecting' || phase === 'sending') && totalSteps > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {steps.map((step) => (
            <div key={step.label} className="flex items-center gap-1 text-[10px]">
              {step.status === 'running'  && <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" />}
              {step.status === 'done'    && <CheckCircle2 size={10} className="text-green-500 shrink-0" />}
              {step.status === 'pending' && <span className="w-2.5 text-[var(--dim)]">·</span>}
              <span className={cn(
                step.status === 'done'    && 'text-[var(--dim)]',
                step.status === 'running' && 'text-[var(--text)]',
                step.status === 'pending' && 'text-[var(--dim)] opacity-40',
              )}>{step.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Done: compact step summary */}
      {isDone && totalSteps > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {steps.map((step) => (
            <div key={step.label} className="flex items-center gap-1 text-[10px] text-[var(--dim)]">
              <CheckCircle2 size={10} className="text-green-500 shrink-0" />
              {step.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── Main component ─────────────────────────────────────────────────────── */

export default function QueryAnalyzer() {
  const { instances, selectedInstance } = useStore()

  const [instance, setInstance] = useState(selectedInstance || instances[0] || '')
  const [mode, setMode] = useState<ModeId>('full')
  const [timeWindow, setTimeWindow] = useState(180)
  const [question, setQuestion] = useState('')
  const [followUp, setFollowUp] = useState('')

  const [phase, setPhase] = useState<Phase>('idle')
  const [steps, setSteps] = useState<CollectionStep[]>([])
  const [output, setOutput] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [linesReceived, setLinesReceived] = useState(0)

  const abortRef = useRef<AbortController | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)

  // Sync instance when store changes
  useEffect(() => {
    if (selectedInstance && !instance) setInstance(selectedInstance)
  }, [selectedInstance, instance])

  // Auto-scroll output
  useEffect(() => {
    if (phase === 'streaming') {
      outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [output, phase])

  const stopStream = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const reset = useCallback(() => {
    stopStream()
    setPhase('idle')
    setSteps([])
    setOutput('')
    setErrorMsg('')
    setFollowUp('')
  }, [stopStream])

  const runAnalysis = useCallback((appendQuestion?: string) => {
    if (!instance) return
    stopStream()

    const q = appendQuestion ?? (question || '')
    setSteps(STEPS_BY_MODE[mode].map((label) => ({ label, status: 'pending' as const })))
    setPhase('collecting')
    setOutput('')
    setErrorMsg('')
    setLinesReceived(0)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const body = JSON.stringify({ mode, time_window_mins: timeWindow, question: q })

    fetch(`/api/instances/${instance}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => 'Unknown error')
        setErrorMsg(text)
        setPhase('error')
        return
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let remainder = ''
      let event = ''

      const processLine = (line: string) => {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          const raw = line.slice(6)
          try {
            const payload = JSON.parse(raw)
            if (event === 'status') {
              setPhase(payload.phase as Phase)
              if (payload.phase === 'sending' || payload.phase === 'done') {
                setSteps((prev) => prev.map((s) => ({ ...s, status: 'done' as const })))
              }
            } else if (event === 'chunk') {
              setLinesReceived((n) => n + 1)
              setOutput((prev) => prev + (payload as string))
              setSteps((prev) => {
                const idx = prev.findIndex((s) => s.status === 'running')
                if (idx === -1) return prev
                const next = [...prev]
                next[idx] = { ...next[idx], status: 'done' as const }
                if (idx + 1 < next.length) next[idx + 1] = { ...next[idx + 1], status: 'running' as const }
                return next
              })
            } else if (event === 'debug') {
              console.group('%c[CH-Analyzer AI Debug]', 'color:#6366f1;font-weight:bold')
              console.log('Prompt size:', (payload as {prompt_kb:number}).prompt_kb + ' KB', '/', (payload as {prompt_bytes:number}).prompt_bytes + ' bytes')
              console.log('Row counts:', (payload as {row_counts:unknown}).row_counts)
              console.log('Auth envs present:', (payload as {auth_envs_present:unknown}).auth_envs_present)
              console.log('Config home:', (payload as {config_home:string}).config_home)
              console.log('Config keys:', (payload as {config_keys:unknown}).config_keys)
              console.log('Truncated:', (payload as {truncated:boolean}).truncated)
              console.log('Prompt head (800 chars):', (payload as {prompt_head:string}).prompt_head)
              console.log('Prompt tail (400 chars):', (payload as {prompt_tail:string}).prompt_tail)
              console.groupEnd()
            } else if (event === 'error') {
              setErrorMsg(payload as string)
              setPhase('error')
            } else if (event === 'stderr') {
              setErrorMsg((prev) => prev ? prev + '\n' + (payload as string) : 'Claude: ' + (payload as string))
            }
          } catch {
            // ignore parse errors
          }
          event = ''
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = remainder + decoder.decode(value, { stream: true })
        const lines = text.split('\n')
        remainder = lines.pop() ?? ''
        for (const line of lines) processLine(line)
      }
      if (remainder) processLine(remainder)
      setSteps((prev) => prev.map((s) => ({ ...s, status: 'done' as const })))
      setPhase('done')
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name !== 'AbortError') {
        setErrorMsg(err.message)
        setPhase('error')
      }
    })
  }, [instance, mode, timeWindow, question, stopStream])

  useEffect(() => () => stopStream(), [stopStream])

  const isRunning = phase === 'collecting' || phase === 'sending' || phase === 'streaming'
  const showSetup = phase === 'idle'
  const showProgress = phase === 'collecting' || phase === 'sending'
  const showOutput = phase === 'streaming' || phase === 'done' || (phase === 'error' && output)

  const handleCopy = () => {
    navigator.clipboard.writeText(output).catch(() => {})
  }

  return (
    <div className="flex h-full overflow-hidden">
      <style>{`
        /* ── Headings ── */
        .analysis-output h1 { font-size: 1.1rem; font-weight: 700; margin: 1rem 0 0.5rem; }
        .analysis-output h2 { font-size: 1rem; font-weight: 600; margin: 0.875rem 0 0.4rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
        .analysis-output h3 { font-size: 0.875rem; font-weight: 600; margin: 0.75rem 0 0.3rem; }
        .analysis-output h4 { font-size: 0.8125rem; font-weight: 600; margin: 0.5rem 0 0.25rem; }

        /* ── Body text ── */
        .analysis-output p { margin: 0.3rem 0; }
        .analysis-output strong { font-weight: 600; }
        .analysis-output em { font-style: italic; }

        /* ── Lists ── */
        .analysis-output ul { padding-left: 1.25rem; margin: 0.3rem 0; list-style: disc; }
        .analysis-output ol { padding-left: 1.25rem; margin: 0.3rem 0; list-style: decimal; }
        .analysis-output li { margin: 0.15rem 0; }
        .analysis-output li > p { margin: 0; }

        /* ── Horizontal rule ── */
        .analysis-output hr { border: none; border-top: 1px solid var(--border); margin: 0.75rem 0; }

        /* ── Code ── */
        .analysis-output pre { font-family: monospace; font-size: 0.75rem; background: var(--code-bg, var(--hover)); border: 1px solid var(--border); border-radius: 0.375rem; padding: 0.625rem; margin: 0.35rem 0; white-space: pre; overflow-x: auto; }
        .analysis-output code { font-family: monospace; font-size: 0.75rem; background: var(--hover); border-radius: 0.2rem; padding: 0.1rem 0.25rem; }
        .analysis-output pre code { background: none; padding: 0; border-radius: 0; }

        /* ── Tables ── */
        .analysis-output table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; font-size: 0.75rem; }
        .analysis-output th, .analysis-output td { border: 1px solid var(--border); padding: 0.3rem 0.6rem; text-align: left; }
        .analysis-output th { background: var(--hover); font-weight: 600; }
        .analysis-output tr:nth-child(even) td { background: var(--hover)/40; }

        /* ── Blockquote ── */
        .analysis-output blockquote { border-left: 3px solid var(--accent); padding-left: 0.75rem; margin: 0.4rem 0; color: var(--dim); }

        /* ── Severity badges ── */
        .analysis-output .sev-critical { color: #ef4444; font-weight: 700; }
        .analysis-output .sev-warning  { color: #f97316; font-weight: 700; }
        .analysis-output .sev-info     { color: #eab308; font-weight: 700; }

        /* ── Streaming cursor ── */
        .streaming-cursor { display: inline-block; width: 8px; height: 14px; background: currentColor; opacity: 0.6; margin-left: 2px; vertical-align: middle; animation: blink 1s step-end infinite; }
        @keyframes blink { 50% { opacity: 0; } }
      `}</style>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <div className={cn(
        'flex flex-col gap-4 border-r border-[var(--border)] bg-[var(--card)] shrink-0 overflow-y-auto p-3',
        showOutput ? 'w-52' : 'w-64',
      )}>
        {/* Instance */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Instance</span>
          <div className="relative">
            <select
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
              disabled={isRunning}
              className="w-full appearance-none rounded border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs focus:outline-none pr-6 disabled:opacity-50"
            >
              {instances.length === 0 && <option value="">No instances</option>}
              {instances.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
            <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
          </div>
        </div>

        {/* Mode */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Analysis Mode</span>
          <div className="flex flex-col gap-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => { setMode(m.id); if (showOutput) reset() }}
                disabled={isRunning}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:opacity-50',
                  mode === m.id
                    ? 'border-[var(--accent)]/50 bg-[var(--accent)]/8 text-[var(--text)]'
                    : 'border-[var(--border)] hover:border-[var(--border)] hover:bg-[var(--hover)] text-[var(--dim)]',
                )}
              >
                <span className="text-[11px] font-semibold">{m.label}</span>
                <span className="text-[10px] leading-snug opacity-70">{m.description}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Time window */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Time Window</span>
          <div className="relative">
            <select
              value={timeWindow}
              onChange={(e) => setTimeWindow(Number(e.target.value))}
              disabled={isRunning}
              className="w-full appearance-none rounded border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs focus:outline-none pr-6 disabled:opacity-50"
            >
              {TIME_WINDOWS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
          </div>
        </div>

        {/* Optional question */}
        {showSetup && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Optional Context</span>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask Claude something specific…"
              rows={3}
              className="w-full resize-none rounded border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--dim)]"
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="mt-auto flex flex-col gap-1.5">
          {showSetup && (
            <button
              onClick={() => runAnalysis()}
              disabled={!instance || isRunning}
              className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] text-white px-3 py-2 text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <Sparkles size={13} />
              Run Analysis
            </button>
          )}
          {showOutput && !isRunning && (
            <>
              <button
                onClick={() => runAnalysis()}
                disabled={!instance}
                className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--hover)] transition-colors disabled:opacity-40"
              >
                <RefreshCw size={12} />
                Re-analyze
              </button>
              <button
                onClick={reset}
                className="w-full flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--hover)] transition-colors"
              >
                <X size={12} />
                New Analysis
              </button>
            </>
          )}
          {isRunning && (
            <button disabled className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs opacity-60">
              <Loader2 size={12} className="animate-spin" />
              {phase === 'collecting' ? 'Collecting…' : phase === 'sending' ? 'Building prompt…' : 'Analyzing…'}
            </button>
          )}
        </div>
      </div>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

        {/* Idle splash */}
        {showSetup && (
          <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8">
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center w-14 h-14 rounded-xl bg-[var(--accent)]/10 border border-[var(--accent)]/20">
                <Sparkles size={26} className="text-[var(--accent)]" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">ClickHouse AI Analyzer</h2>
                <p className="text-xs text-[var(--dim)] mt-1 max-w-xs">
                  Auto-collects cluster stats, query patterns, and health metrics — then sends them to Claude for actionable analysis.
                </p>
              </div>
            </div>
            <div className="text-xs text-[var(--dim)] text-left bg-[var(--hover)] rounded-lg border border-[var(--border)] px-4 py-3 max-w-xs w-full space-y-1">
              <div className="font-medium text-[var(--text)] mb-2">What it collects:</div>
              {STEPS_BY_MODE[mode].map((s) => <div key={s}>• {s}</div>)}
            </div>
            <button
              onClick={() => runAnalysis()}
              disabled={!instance}
              className="flex items-center gap-2 rounded-lg bg-[var(--accent)] text-white px-4 py-2 text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <Sparkles size={13} />
              Run {MODES.find((m) => m.id === mode)?.label}
            </button>
            {!instance && (
              <p className="text-xs text-[var(--dim)]">Select an instance from the left panel first.</p>
            )}
          </div>
        )}

        {/* Collection progress */}
        {showProgress && (
          <div className="flex flex-col h-full">
            <RunningInfoCard
              mode={MODES.find((m) => m.id === mode)!}
              instance={instance}
              timeWindow={timeWindow}
              phase={phase}
              steps={steps}
              linesReceived={0}
            />
            <div className="flex flex-col items-center justify-center flex-1 px-6">
              <div className="w-full max-w-md">
                <CollectionProgress steps={steps} />
              </div>
            </div>
          </div>
        )}

        {/* Error (no output) */}
        {phase === 'error' && !output && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <AlertCircle size={32} className="text-red-500 opacity-60" />
            <div className="text-sm font-medium text-red-500">Analysis failed</div>
            {errorMsg && <div className="text-xs text-[var(--dim)] max-w-md text-center">{errorMsg}</div>}
            <button onClick={reset} className="flex items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--hover)]">
              <RefreshCw size={12} />
              Try Again
            </button>
          </div>
        )}

        {/* Analysis output */}
        {showOutput && (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            {/* Info card — shown while streaming AND after completion */}
            {(phase === 'streaming' || phase === 'done') && (
              <RunningInfoCard
                mode={MODES.find((m) => m.id === mode)!}
                instance={instance}
                timeWindow={timeWindow}
                phase={phase}
                steps={steps}
                linesReceived={linesReceived}
              />
            )}

            {/* Top bar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] shrink-0 bg-[var(--card)]">
              <div className="flex items-center gap-2 text-xs text-[var(--dim)]">
                <span className="font-medium text-[var(--text)]">
                  {MODES.find((m) => m.id === mode)?.label}
                </span>
                <span>·</span>
                <span>{TIME_WINDOWS.find((t) => t.value === timeWindow)?.label}</span>
                <span>·</span>
                <span>{instance}</span>
                {phase === 'streaming' && (
                  <><span>·</span><span className="flex items-center gap-1 text-[var(--accent)]"><Loader2 size={11} className="animate-spin" />Analyzing…</span></>
                )}
                {phase === 'done' && (
                  <><span>·</span><span className="flex items-center gap-1 text-green-500"><CheckCircle2 size={11} />Complete</span></>
                )}
                {phase === 'error' && output && (
                  <><span>·</span><span className="text-red-400">Partial</span></>
                )}
              </div>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-xs text-[var(--dim)] hover:text-[var(--text)] transition-colors"
                title="Copy analysis to clipboard"
              >
                <ClipboardCopy size={13} />
                Copy
              </button>
            </div>

            {/* Scrollable output */}
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
              <AnalysisOutput text={output} isStreaming={phase === 'streaming'} />
              <div ref={outputRef} />
            </div>

            {/* Follow-up input */}
            {(phase === 'done' || (output && phase !== 'streaming')) && (
              <div className="shrink-0 border-t border-[var(--border)] px-4 py-3 flex gap-2 items-end">
                <textarea
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (followUp.trim()) { runAnalysis(followUp); setFollowUp('') }
                    }
                  }}
                  placeholder="Ask a follow-up question… (Enter to send)"
                  rows={2}
                  className="flex-1 resize-none rounded border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--dim)]"
                />
                <button
                  onClick={() => { if (followUp.trim()) { runAnalysis(followUp); setFollowUp('') } }}
                  disabled={!followUp.trim()}
                  className="shrink-0 flex items-center justify-center rounded border border-[var(--border)] px-2.5 py-2 text-[var(--accent)] hover:bg-[var(--hover)] transition-colors disabled:opacity-40"
                >
                  <Send size={13} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
