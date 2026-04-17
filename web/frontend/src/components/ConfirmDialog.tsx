import { AlertTriangle, X } from 'lucide-react'
import { cn } from '../lib/utils'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open, title, description,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  destructive = false, onConfirm, onCancel,
}: ConfirmDialogProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 w-full max-w-sm shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {destructive && <AlertTriangle size={18} className="text-red-400 shrink-0 mt-0.5" />}
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-[var(--fg)]">{title}</h3>
            {description && <p className="text-xs text-[var(--dim)] mt-1">{description}</p>}
          </div>
          <button onClick={onCancel} className="text-[var(--dim)] hover:text-[var(--fg)] shrink-0">
            <X size={14} />
          </button>
        </div>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => { onConfirm() }}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              destructive
                ? 'bg-red-500 hover:bg-red-600 text-white'
                : 'bg-[var(--accent)] hover:opacity-90 text-white',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
