import { useState, useEffect } from 'react'
import { ShieldCheck, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { cn } from '../lib/utils'

interface DeepQuery {
  sql: string
  description: string
}

interface QueryConfirmDialogProps {
  instance: string
  description: string
  queries: DeepQuery[]
  onConfirm: () => void
  onCancel: () => void
}

export function QueryConfirmDialog({
  instance,
  description,
  queries,
  onConfirm,
  onCancel,
}: QueryConfirmDialogProps) {
  const [showSql, setShowSql] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div className="relative z-10 w-full max-w-lg mx-4 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center gap-3">
          <ShieldCheck size={18} className="text-purple-400 flex-none" />
          <div>
            <div className="text-sm font-semibold text-[var(--text)]">Run Deep Analysis?</div>
            <div className="text-xs text-[var(--dim)] mt-0.5">Instance: {instance}</div>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Plain English summary */}
          <div className="flex items-start gap-2 text-sm text-[var(--text)]">
            <AlertTriangle size={14} className="text-yellow-400 flex-none mt-0.5" />
            <span>{description}</span>
          </div>

          {/* Read-only guarantee */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-xs text-green-400">
            <ShieldCheck size={12} className="flex-none" />
            All queries are read-only SELECT statements — no data will be modified.
          </div>

          {/* Expandable SQL */}
          <div>
            <button
              onClick={() => setShowSql(v => !v)}
              className="flex items-center gap-1.5 text-xs text-[var(--dim)] hover:text-[var(--text)] transition-colors"
            >
              {showSql ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {showSql ? 'Hide SQL' : `Show SQL (${queries.length} ${queries.length === 1 ? 'query' : 'queries'})`}
            </button>

            {showSql && (
              <div className="mt-2 space-y-2 max-h-60 overflow-y-auto">
                {queries.map((q, i) => (
                  <div key={i} className="rounded-lg border border-[var(--border)] overflow-hidden">
                    <div className="px-3 py-1.5 bg-[var(--card)] text-[10px] font-medium text-[var(--dim)] uppercase tracking-wider border-b border-[var(--border)]">
                      {q.description}
                    </div>
                    <pre className="px-3 py-2 text-[11px] font-mono text-[var(--text)] bg-[var(--code-bg,var(--card))] overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {q.sql}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--border)] flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg text-sm text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={cn(
              'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors',
              'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border border-purple-500/30',
            )}
          >
            Run {queries.length} {queries.length === 1 ? 'Query' : 'Queries'}
          </button>
        </div>
      </div>
    </div>
  )
}
