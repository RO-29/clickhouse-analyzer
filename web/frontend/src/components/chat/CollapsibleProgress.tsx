import { useEffect, useState } from 'react'
import {
  ChevronRight, ChevronDown, Sparkles, Wrench, Database,
  Loader2, CheckCircle2, X,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StepInfo, ThinkingLine } from '../../types/api'

export interface CollapsibleProgressProps {
  phase: 'planning' | 'collecting' | 'streaming' | 'done' | 'error'
  steps: StepInfo[]
  thinkingLines: ThinkingLine[]
  elapsedSecs: number
}

/* ─── helpers ────────────────────────────────────────────────────────────── */

function fmtElapsed(secs: number): string {
  if (secs < 60) return `${secs.toFixed(1)}s`
  const m = Math.floor(secs / 60)
  const s = (secs % 60).toFixed(0).padStart(2, '0')
  return `${m}m ${s}s`
}

function ThinkingKindIcon({ kind }: { kind: ThinkingLine['kind'] }) {
  if (kind === 'plan') return <Sparkles size={11} className="text-purple-400 shrink-0" />
  if (kind === 'sql')  return <Database  size={11} className="text-blue-400 shrink-0" />
  return                      <Wrench    size={11} className="text-orange-400 shrink-0" />
}

function StepStatusIcon({ status }: { status: StepInfo['status'] }) {
  if (status === 'running') return <Loader2 size={11} className="text-[var(--accent)] animate-spin shrink-0" />
  if (status === 'done')    return <CheckCircle2 size={11} className="text-green-500 shrink-0" />
  if (status === 'error')   return <X size={11} className="text-red-400 shrink-0" />
  // pending
  return <span className="inline-block w-2.5 h-2.5 rounded-full border border-[var(--border)] shrink-0" />
}

/* ─── component ──────────────────────────────────────────────────────────── */

export function CollapsibleProgress({
  phase,
  steps,
  thinkingLines,
  elapsedSecs,
}: CollapsibleProgressProps) {
  const isDone  = phase === 'done'
  const isError = phase === 'error'

  // Start expanded while planning/collecting; auto-collapse when streaming starts
  const [expanded, setExpanded] = useState<boolean>(
    phase === 'planning' || phase === 'collecting',
  )

  useEffect(() => {
    if (phase === 'streaming') setExpanded(false)
    if (phase === 'planning' || phase === 'collecting') setExpanded(true)
  }, [phase])

  const elapsedLabel = fmtElapsed(elapsedSecs)
  const headerLabel  = isDone ? `Done in ${elapsedLabel}` : `Analyzing… ${elapsedLabel}`

  const borderColor = isError
    ? 'border-l-red-500'
    : isDone
    ? 'border-l-green-500'
    : 'border-l-purple-500'

  const headerIconColor = isError
    ? 'text-red-400'
    : isDone
    ? 'text-green-400'
    : 'text-purple-400'

  return (
    <div
      className={cn(
        'rounded-lg border border-[var(--border)] border-l-2 bg-[var(--surface)] overflow-hidden',
        borderColor,
      )}
    >
      {/* ── Header (always visible) ── */}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--hover)] transition-colors"
      >
        {expanded
          ? <ChevronDown size={13} className="text-[var(--dim)] shrink-0" />
          : <ChevronRight size={13} className="text-[var(--dim)] shrink-0" />
        }
        <Sparkles size={13} className={cn('shrink-0', headerIconColor)} />
        <span className={cn('text-xs font-medium flex-1', headerIconColor)}>
          {headerLabel}
        </span>
        {!isDone && !isError && (
          <Loader2 size={12} className="text-purple-400 animate-spin shrink-0" />
        )}
      </button>

      {/* ── Body (collapsible) ── */}
      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-3">

          {/* Thinking lines */}
          {thinkingLines.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider mb-0.5">
                Reasoning
              </div>
              {thinkingLines.map((line, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-[var(--dim)]">
                  <ThinkingKindIcon kind={line.kind} />
                  <span className="leading-snug">{line.text}</span>
                </div>
              ))}
            </div>
          )}

          {/* Steps timeline */}
          {steps.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider mb-0.5">
                Steps
              </div>
              {steps.map((step) => (
                <div key={step.id} className="flex items-center gap-2 text-xs">
                  <StepStatusIcon status={step.status} />
                  <span className={cn(
                    'flex-1 leading-snug',
                    step.status === 'done'    && 'text-[var(--dim)]',
                    step.status === 'running' && 'text-[var(--fg)]',
                    step.status === 'error'   && 'text-red-400',
                    step.status === 'pending' && 'text-[var(--dim)] opacity-50',
                  )}>
                    {step.label}
                  </span>
                  {step.elapsedMs != null && step.status === 'done' && (
                    <span className="text-[10px] text-[var(--dim)] shrink-0">
                      {step.elapsedMs < 1000
                        ? `${step.elapsedMs}ms`
                        : `${(step.elapsedMs / 1000).toFixed(1)}s`}
                    </span>
                  )}
                  {step.rowCount != null && step.status === 'done' && (
                    <span className="text-[10px] text-[var(--dim)] shrink-0">
                      {step.rowCount.toLocaleString()} rows
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
