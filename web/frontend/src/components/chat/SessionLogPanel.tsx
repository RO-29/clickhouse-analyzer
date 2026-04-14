import { useState } from 'react'
import {
  Terminal, ChevronDown, ChevronRight,
  Zap, Database, CheckCircle2, AlertCircle, Layers, FileText,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ChatLogEntry } from '../../types/api'

/* ─── helpers ────────────────────────────────────────────────────────────── */

function fmtOffset(ms: number): string {
  if (ms < 1000) return `+${ms}ms`
  return `+${(ms / 1000).toFixed(1)}s`
}

function fmtDuration(ms: number | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/* ─── per-entry icon + color ─────────────────────────────────────────────── */

function EntryIcon({ kind }: { kind: ChatLogEntry['kind'] }) {
  switch (kind) {
    case 'phase':      return <Layers      size={11} className="text-purple-400 shrink-0 mt-0.5" />
    case 'tool_start': return <Database    size={11} className="text-blue-400 shrink-0 mt-0.5" />
    case 'tool_done':  return <CheckCircle2 size={11} className="text-green-500 shrink-0 mt-0.5" />
    case 'debug':      return <FileText    size={11} className="text-yellow-400 shrink-0 mt-0.5" />
    case 'error':      return <AlertCircle size={11} className="text-red-400 shrink-0 mt-0.5" />
    case 'done':       return <Zap         size={11} className="text-green-400 shrink-0 mt-0.5" />
    default:           return <span className="w-2.5 h-2.5 shrink-0" />
  }
}

function entryTextClass(kind: ChatLogEntry['kind']): string {
  switch (kind) {
    case 'phase':      return 'text-purple-300'
    case 'tool_start': return 'text-blue-300'
    case 'tool_done':  return 'text-green-300'
    case 'debug':      return 'text-yellow-300'
    case 'error':      return 'text-red-400'
    case 'done':       return 'text-green-400 font-medium'
    default:           return 'text-[var(--dim)]'
  }
}

/* ─── SQL expander ───────────────────────────────────────────────────────── */

function SqlBlock({ sql }: { sql: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 text-[10px] text-blue-400/70 hover:text-blue-400 transition-colors"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        SQL
      </button>
      {open && (
        <pre className="mt-1 text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-all bg-[var(--hover)] border border-[var(--border)] rounded p-2 text-blue-200 max-h-48 overflow-y-auto">
          {sql.trim()}
        </pre>
      )}
    </div>
  )
}

/* ─── Single log entry ───────────────────────────────────────────────────── */

function LogRow({ entry }: { entry: ChatLogEntry }) {
  return (
    <div className="flex gap-2 text-[11px]">
      {/* timestamp */}
      <span className="shrink-0 text-[var(--dim)] font-mono w-12 text-right leading-snug pt-0.5">
        {fmtOffset(entry.offsetMs)}
      </span>

      {/* icon */}
      <EntryIcon kind={entry.kind} />

      {/* content */}
      <div className="flex-1 min-w-0">
        <div className={cn('leading-snug', entryTextClass(entry.kind))}>
          {entry.text}
          {/* row count + elapsed for tool_done */}
          {entry.kind === 'tool_done' && (
            <span className="ml-2 text-[var(--dim)] text-[10px]">
              {entry.rowCount != null && `${entry.rowCount.toLocaleString()} rows`}
              {entry.rowCount != null && entry.elapsedMs != null && ' · '}
              {entry.elapsedMs != null && fmtDuration(entry.elapsedMs)}
            </span>
          )}
        </div>
        {/* SQL for tool_start */}
        {entry.kind === 'tool_start' && entry.sql && (
          <SqlBlock sql={entry.sql} />
        )}
      </div>
    </div>
  )
}

/* ─── Panel ──────────────────────────────────────────────────────────────── */

interface SessionLogPanelProps {
  logs: ChatLogEntry[]
}

export function SessionLogPanel({ logs }: SessionLogPanelProps) {
  const [open, setOpen] = useState(false)

  if (logs.length === 0) return null

  return (
    <div className="mt-1 border border-[var(--border)] rounded-lg text-xs overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors text-left"
      >
        <Terminal size={11} />
        <span className="font-medium">Session log</span>
        <span className="ml-1 text-[var(--dim)]">{logs.length} events</span>
        {open
          ? <ChevronDown size={11} className="ml-auto" />
          : <ChevronRight size={11} className="ml-auto" />
        }
      </button>

      {open && (
        <div className="px-3 py-2.5 border-t border-[var(--border)] bg-[var(--surface)]/40 flex flex-col gap-2">
          {logs.map((entry, i) => (
            <LogRow key={i} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
