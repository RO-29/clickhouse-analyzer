import { useEffect, useState } from 'react'
import { CheckCircle, XCircle, X } from 'lucide-react'
import { cn } from '../lib/utils'
import type { ToastEvent } from '../lib/notify'

interface Toast extends ToastEvent {
  id: number
}

let nextId = 0

export function NotificationToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToastEvent>).detail
      const id = ++nextId
      setToasts(prev => [...prev, { ...detail, id }])
      // Auto-dismiss after 5s
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000)
    }
    window.addEventListener('ch-toast', handler)
    return () => window.removeEventListener('ch-toast', handler)
  }, [])

  const dismiss = (id: number) => setToasts(prev => prev.filter(t => t.id !== id))

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={cn(
            'flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border pointer-events-auto',
            'min-w-[260px] max-w-[360px]',
            'animate-[slideIn_0.2s_ease-out]',
            toast.kind === 'done'
              ? 'bg-[var(--card)] border-green-500/30'
              : 'bg-[var(--card)] border-red-500/30',
          )}
        >
          {toast.kind === 'done'
            ? <CheckCircle size={16} className="shrink-0 mt-0.5 text-green-400" />
            : <XCircle size={16} className="shrink-0 mt-0.5 text-red-400" />
          }
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-[var(--text)]">{toast.title}</p>
            <p className="text-xs text-[var(--dim)] truncate">{toast.body}</p>
          </div>
          <button
            onClick={() => dismiss(toast.id)}
            className="shrink-0 text-[var(--dim)] hover:text-[var(--text)] transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
