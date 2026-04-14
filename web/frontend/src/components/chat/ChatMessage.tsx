import { useMemo, useState } from 'react'
import { ClipboardCopy, AlertCircle, Check, ChevronDown, ChevronRight, FlaskConical } from 'lucide-react'
import { marked } from 'marked'
import { cn } from '../../lib/utils'
import type { ChatMessage as ChatMessageType } from '../../types/api'
import { CollapsibleProgress } from './CollapsibleProgress'
import { ThinkingSpinner } from '../ThinkingSpinner'

marked.use({ gfm: true, breaks: false })

/* ─── Inline styles ──────────────────────────────────────────────────────── */

const MESSAGE_STYLES = `
  .analysis-output h1 { font-size: 1.1rem; font-weight: 700; margin: 1rem 0 0.5rem; }
  .analysis-output h2 { font-size: 1rem; font-weight: 600; margin: 0.875rem 0 0.4rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
  .analysis-output h3 { font-size: 0.875rem; font-weight: 600; margin: 0.75rem 0 0.3rem; }
  .analysis-output h4 { font-size: 0.8125rem; font-weight: 600; margin: 0.5rem 0 0.25rem; }
  .analysis-output p { margin: 0.3rem 0; }
  .analysis-output strong { font-weight: 600; }
  .analysis-output em { font-style: italic; }
  .analysis-output ul { padding-left: 1.25rem; margin: 0.3rem 0; list-style: disc; }
  .analysis-output ol { padding-left: 1.25rem; margin: 0.3rem 0; list-style: decimal; }
  .analysis-output li { margin: 0.15rem 0; }
  .analysis-output li > p { margin: 0; }
  .analysis-output hr { border: none; border-top: 1px solid var(--border); margin: 0.75rem 0; }
  .analysis-output pre { font-family: monospace; font-size: 0.75rem; background: var(--code-bg, var(--hover)); border: 1px solid var(--border); border-radius: 0.375rem; padding: 0.625rem; margin: 0.35rem 0; white-space: pre; overflow-x: auto; }
  .analysis-output code { font-family: monospace; font-size: 0.75rem; background: var(--hover); border-radius: 0.2rem; padding: 0.1rem 0.25rem; }
  .analysis-output pre code { background: none; padding: 0; border-radius: 0; }
  .analysis-output table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; font-size: 0.75rem; }
  .analysis-output th, .analysis-output td { border: 1px solid var(--border); padding: 0.3rem 0.6rem; text-align: left; }
  .analysis-output th { background: var(--hover); font-weight: 600; }
  .analysis-output blockquote { border-left: 3px solid var(--accent); padding-left: 0.75rem; margin: 0.4rem 0; color: var(--dim); }
  .analysis-output .sev-critical { color: #ef4444; font-weight: 700; }
  .analysis-output .sev-warning  { color: #f97316; font-weight: 700; }
  .analysis-output .sev-info     { color: #eab308; font-weight: 700; }
  .streaming-cursor { display: inline-block; width: 8px; height: 14px; background: currentColor; opacity: 0.6; margin-left: 2px; vertical-align: middle; animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
`

/* ─── helpers ────────────────────────────────────────────────────────────── */

function fmtTs(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  )
}

function renderMarkdown(content: string, isStreaming: boolean): string {
  let out = marked.parse(content) as string
  // Severity badges
  out = out
    .replace(/🔴\s*<strong>CRITICAL<\/strong>/g, '<span class="sev-critical">🔴 CRITICAL</span>')
    .replace(/🟠\s*<strong>WARNING<\/strong>/g,  '<span class="sev-warning">🟠 WARNING</span>')
    .replace(/🟡\s*<strong>INFO<\/strong>/g,      '<span class="sev-info">🟡 INFO</span>')
    .replace(/🔴 CRITICAL(?!<)/g, '<span class="sev-critical">🔴 CRITICAL</span>')
    .replace(/🟠 WARNING(?!<)/g,  '<span class="sev-warning">🟠 WARNING</span>')
    .replace(/🟡 INFO(?!<)/g,     '<span class="sev-info">🟡 INFO</span>')
  if (isStreaming) out += '<span class="streaming-cursor"></span>'
  return out
}

/* ─── Evidence panel ─────────────────────────────────────────────────────── */

function EvidencePanel({ evidence }: { evidence: NonNullable<ChatMessageType['evidence']> }) {
  const [open, setOpen] = useState(false)

  const rowEntries = Object.entries(evidence.rowCounts).filter(([, v]) => v > 0)

  return (
    <div className="mt-1 border border-[var(--border)] rounded-lg text-xs overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors text-left"
      >
        <FlaskConical size={11} />
        <span className="font-medium">Evidence sent to Claude</span>
        <span className="ml-1 text-[var(--dim)]">
          {evidence.promptKb} KB{evidence.truncated ? ' (truncated)' : ''}
          {rowEntries.length > 0 && ` · ${rowEntries.length} data sources`}
        </span>
        {open ? <ChevronDown size={11} className="ml-auto" /> : <ChevronRight size={11} className="ml-auto" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-[var(--border)] bg-[var(--surface)]/40">
          {/* Row counts */}
          {rowEntries.length > 0 && (
            <div className="pt-2">
              <p className="text-[10px] uppercase tracking-widest text-[var(--dim)] mb-1">Data collected</p>
              <div className="flex flex-wrap gap-1">
                {rowEntries.map(([k, v]) => (
                  <span key={k} className="px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)] font-mono">
                    {k}: {v}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Collection errors */}
          {evidence.collectionErrors.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-widest text-[var(--dim)] mb-1">Collection errors</p>
              <ul className="space-y-0.5 text-red-400">
                {evidence.collectionErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          {/* Prompt head */}
          {evidence.promptHead && (
            <div>
              <p className="text-[10px] uppercase tracking-widest text-[var(--dim)] mb-1">Prompt (first 5 KB)</p>
              <pre className="whitespace-pre-wrap break-all font-mono text-[10px] bg-[var(--hover)] border border-[var(--border)] rounded p-2 max-h-48 overflow-y-auto leading-relaxed">
                {evidence.promptHead}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ─── Props ──────────────────────────────────────────────────────────────── */

interface ChatMessageProps {
  message: ChatMessageType
  isLast: boolean
}

/* ─── User bubble ─────────────────────────────────────────────────────────── */

function UserBubble({ message }: { message: ChatMessageType }) {
  return (
    <div className="flex flex-col items-end gap-1 w-full">
      <div
        className={cn(
          'max-w-[75%] ml-auto px-4 py-2.5',
          'bg-[var(--accent)]/15 border border-[var(--accent)]/20',
          'rounded-2xl rounded-tr-sm',
          'text-sm text-[var(--fg)]',
          'whitespace-pre-wrap break-words',
        )}
      >
        {message.content}
      </div>
      <span className="text-[10px] text-[var(--dim)] mr-0.5">
        {fmtTs(message.timestamp)}
      </span>
    </div>
  )
}

/* ─── Assistant bubble ────────────────────────────────────────────────────── */

function AssistantBubble({ message, isLast }: { message: ChatMessageType; isLast: boolean }) {
  const [copied, setCopied] = useState(false)

  const isStreaming = message.status === 'streaming'
  const isError     = message.status === 'error'
  const isDone      = message.status === 'done'
  const isPlanning  = message.phase === 'planning'
  const showCursor  = isLast && isStreaming

  const hasProgress =
    (message.steps && message.steps.length > 0) ||
    (message.thinkingLines && message.thinkingLines.length > 0)

  const html = useMemo(
    () => (message.content ? renderMarkdown(message.content, showCursor) : ''),
    [message.content, showCursor],
  )

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  // Compute elapsedSecs from timestamp to now (frozen when done/error)
  const elapsedSecs = useMemo(() => {
    if (isDone || isError) {
      // Use a stable approximation — caller should pass a real elapsedSecs if possible
      return 0
    }
    return Math.max(0, (Date.now() - message.timestamp) / 1000)
  }, [isDone, isError, message.timestamp])

  return (
    <div className="flex flex-col gap-2 w-full">
      {/* Planning: spinner only */}
      {isPlanning && !message.content && (
        <div className="flex items-center gap-2 text-sm text-[var(--dim)]">
          <ThinkingSpinner size={16} className="text-orange-400" />
          <span>Thinking…</span>
        </div>
      )}

      {/* CollapsibleProgress */}
      {hasProgress && (
        <CollapsibleProgress
          phase={message.phase ?? 'collecting'}
          steps={message.steps ?? []}
          thinkingLines={message.thinkingLines ?? []}
          elapsedSecs={elapsedSecs}
        />
      )}

      {/* Error state */}
      {isError && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-400">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{message.content || 'An error occurred.'}</span>
        </div>
      )}

      {/* Markdown content */}
      {!isError && message.content && (
        <div className="relative group">
          <div
            className="analysis-output text-sm leading-relaxed"
            dangerouslySetInnerHTML={{ __html: html }}
          />

          {/* Copy button — only when done */}
          {isDone && (
            <button
              type="button"
              onClick={handleCopy}
              title="Copy"
              className={cn(
                'absolute bottom-0 right-0',
                'opacity-0 group-hover:opacity-100 transition-opacity',
                'p-1 rounded text-[var(--dim)] hover:text-[var(--fg)]',
                'bg-[var(--surface)] border border-[var(--border)]',
              )}
            >
              {copied
                ? <Check size={12} className="text-green-400" />
                : <ClipboardCopy size={12} />
              }
            </button>
          )}
        </div>
      )}

      {/* Evidence panel — shown when done */}
      {isDone && message.evidence && (
        <EvidencePanel evidence={message.evidence} />
      )}

      {/* Timestamp */}
      <span className="text-[10px] text-[var(--dim)]">
        {fmtTs(message.timestamp)}
      </span>
    </div>
  )
}

/* ─── Export ─────────────────────────────────────────────────────────────── */

export function ChatMessage({ message, isLast }: ChatMessageProps) {
  return (
    <>
      <style>{MESSAGE_STYLES}</style>
      <div
        className={cn(
          'w-full',
          message.role === 'user' ? 'flex justify-end' : 'flex justify-start',
        )}
      >
        <div
          className={cn(
            message.role === 'user' ? 'w-full' : 'w-full max-w-full',
          )}
        >
          {message.role === 'user' ? (
            <UserBubble message={message} />
          ) : (
            <AssistantBubble message={message} isLast={isLast} />
          )}
        </div>
      </div>
    </>
  )
}
