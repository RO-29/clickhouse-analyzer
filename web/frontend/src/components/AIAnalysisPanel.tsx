import { useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, Sparkles, Zap, Trash2 } from 'lucide-react'
import { marked } from 'marked'
import { cn } from '../lib/utils'
import { QueryConfirmDialog } from './QueryConfirmDialog'
import { validateAllReadOnly } from '../lib/sqlValidator'
import type { AnalysisEntry, AnalyzeOptions } from '../hooks/useAIAnalysis'

marked.use({ gfm: true, breaks: false })

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface DeepQueryInfo {
  entryLabel: string
  tab: string
  elementId?: string
  queries: Array<{ sql: string; description: string }>
  description: string
}

interface AIAnalysisPanelProps {
  instance: string
  entries: AnalysisEntry[]
  isOpen: boolean
  onToggle: () => void
  onAnalyze: (label: string, data: Record<string, any>, options: AnalyzeOptions) => void
  onClear: () => void
}

/* -------------------------------------------------------------------------- */
/*  Markdown renderer — reuses QueryAnalyzer CSS class                        */
/* -------------------------------------------------------------------------- */

function renderMd(text: string, isStreaming: boolean): string {
  let out = marked.parse(text) as string
  out = out
    .replace(/🔴\s*<strong>CRITICAL<\/strong>/g, '<span class="sev-critical">🔴 CRITICAL</span>')
    .replace(/🟠\s*<strong>WARNING<\/strong>/g, '<span class="sev-warning">🟠 WARNING</span>')
    .replace(/🟡\s*<strong>INFO<\/strong>/g, '<span class="sev-info">🟡 INFO</span>')
    .replace(/🔴 CRITICAL(?!<)/g, '<span class="sev-critical">🔴 CRITICAL</span>')
    .replace(/🟠 WARNING(?!<)/g, '<span class="sev-warning">🟠 WARNING</span>')
    .replace(/🟡 INFO(?!<)/g, '<span class="sev-info">🟡 INFO</span>')
  if (isStreaming) out += '<span class="streaming-cursor"></span>'
  return out
}

/* -------------------------------------------------------------------------- */
/*  Entry card                                                                */
/* -------------------------------------------------------------------------- */

function EntryCard({
  entry,
  isLoadingDeep,
  onGoDeeper,
}: {
  entry: AnalysisEntry
  isLoadingDeep: boolean
  onGoDeeper: () => void
}) {
  const canGoDeeper =
    entry.contextType === 'row' && entry.status === 'done' && !!entry.elementId

  const statusDot = {
    streaming: 'bg-yellow-400 animate-pulse',
    done: 'bg-green-400',
    error: 'bg-red-400',
  }[entry.status]

  const statusLabel = {
    streaming: 'Analyzing…',
    done: 'Done',
    error: 'Error',
  }[entry.status]

  const html = useMemo(
    () => (entry.output ? renderMd(entry.output, entry.status === 'streaming') : ''),
    [entry.output, entry.status],
  )

  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <Sparkles size={12} className="text-purple-400 flex-none" />
        <span className="text-xs font-medium text-[var(--text)] truncate flex-1 min-w-0">
          {entry.label}
        </span>
        <span className="text-xs text-[var(--dim)] flex-none">
          {(() => {
            const now = new Date()
            const ts = entry.timestamp
            const sameDay =
              ts.getFullYear() === now.getFullYear() &&
              ts.getMonth() === now.getMonth() &&
              ts.getDate() === now.getDate()
            return sameDay
              ? ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : ts.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) +
                ' ' +
                ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          })()}
        </span>
        <span className="flex items-center gap-1 text-xs text-[var(--dim)] flex-none">
          <span className={cn('inline-block w-1.5 h-1.5 rounded-full', statusDot)} />
          {statusLabel}
        </span>
        {canGoDeeper && (
          <button
            onClick={onGoDeeper}
            disabled={isLoadingDeep}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 border border-purple-500/20 transition-colors disabled:opacity-50 flex-none"
          >
            <Zap size={10} />
            {isLoadingDeep ? 'Loading…' : 'Go Deeper'}
          </button>
        )}
      </div>

      {/* Output */}
      {entry.output ? (
        <div
          className="analysis-output text-sm leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : entry.status === 'streaming' ? (
        <div className="text-xs text-[var(--dim)] animate-pulse">Thinking…</div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Panel                                                                     */
/* -------------------------------------------------------------------------- */

export function AIAnalysisPanel({
  instance,
  entries,
  isOpen,
  onToggle,
  onAnalyze,
  onClear,
}: AIAnalysisPanelProps) {
  const [confirmDialog, setConfirmDialog] = useState<DeepQueryInfo | null>(null)
  const [loadingDeep, setLoadingDeep] = useState<string | null>(null)

  const handleGoDeeper = async (entry: AnalysisEntry) => {
    if (!entry.elementId) return
    setLoadingDeep(entry.id)
    try {
      const params = new URLSearchParams({ tab: entry.tab })
      params.set('element_id', entry.elementId)

      const resp = await fetch(
        `/api/instances/${instance}/analyze-element/queries?${params}`,
      )
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${resp.status}`)
      }
      const data = await resp.json()

      // Client-side read-only guard
      const sqlList: string[] = (data.queries ?? []).map((q: any) => q.sql as string)
      const validation = validateAllReadOnly(sqlList)
      if (!validation.valid) {
        alert(
          `Blocked: the following query is not read-only and cannot be run:\n\n${validation.offender}`,
        )
        return
      }

      setConfirmDialog({
        entryLabel: entry.label,
        tab: entry.tab,
        elementId: entry.elementId,
        queries: data.queries ?? [],
        description: data.description ?? `Run ${sqlList.length} read-only queries on ${instance}`,
      })
    } catch (err: any) {
      alert(`Failed to load deep queries: ${err.message}`)
    } finally {
      setLoadingDeep(null)
    }
  }

  const handleConfirmDeep = (info: DeepQueryInfo) => {
    setConfirmDialog(null)
    onAnalyze(
      `Deep: ${info.entryLabel}`,
      {},
      {
        contextType: 'row',
        tab: info.tab,
        elementId: info.elementId,
        mode: 'deep',
        deepQueries: info.queries.map(q => q.sql),
      },
    )
  }

  return (
    <>
      {/* ── Panel ── */}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-40 bg-[var(--surface)] border-t border-[var(--border)] flex flex-col',
          'transition-[height] duration-200 ease-in-out',
          isOpen ? 'h-[45vh] min-h-[280px]' : 'h-9',
        )}
      >
        {/* Collapsed / expanded header bar */}
        <div
          className="flex-none flex items-center gap-2 px-4 h-9 cursor-pointer select-none hover:bg-white/[0.02] transition-colors"
          onClick={onToggle}
        >
          <Sparkles size={13} className="text-purple-400 flex-none" />
          <span className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider">
            AI Analysis
          </span>
          {entries.length > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/20 text-purple-400">
              {entries.length}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {isOpen && entries.length > 0 && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  onClear()
                }}
                className="p-1 rounded text-[var(--dim)] hover:text-[var(--text)] transition-colors"
                title="Clear all"
              >
                <Trash2 size={12} />
              </button>
            )}
            {isOpen ? (
              <ChevronDown size={13} className="text-[var(--dim)]" />
            ) : (
              <ChevronUp size={13} className="text-[var(--dim)]" />
            )}
          </div>
        </div>

        {/* Content area */}
        {isOpen && (
          <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]">
            {entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--dim)]">
                <Sparkles size={20} className="opacity-30" />
                <p className="text-sm">Click ✨ on any tab, row, or chart to analyze with AI</p>
              </div>
            ) : (
              entries.map(entry => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  isLoadingDeep={loadingDeep === entry.id}
                  onGoDeeper={() => handleGoDeeper(entry)}
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Confirmation dialog ── */}
      {confirmDialog && (
        <QueryConfirmDialog
          instance={instance}
          description={confirmDialog.description}
          queries={confirmDialog.queries}
          onConfirm={() => handleConfirmDeep(confirmDialog)}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </>
  )
}
