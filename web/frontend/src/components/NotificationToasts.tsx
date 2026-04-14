import { useEffect, useState, useCallback } from 'react'
import { CheckCircle, XCircle, X, ExternalLink } from 'lucide-react'
import { cn } from '../lib/utils'
import { useStore } from '../hooks/useStore'
import {
  loadStoredNotifs, dismissNotif, dismissAllNotifs, type StoredNotif,
} from '../lib/notify'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function NotificationToasts() {
  const { setView, setActiveChatId } = useStore()

  // Initialise from localStorage so notifications survive refresh / new tabs
  const [notifs, setNotifs] = useState<StoredNotif[]>(() => loadStoredNotifs())

  // Pick up notifications fired in this tab
  useEffect(() => {
    const handler = (e: Event) => {
      const notif = (e as CustomEvent<StoredNotif>).detail
      // Prepend; dedupe by id in case of re-renders
      setNotifs(prev => [notif, ...prev.filter(n => n.id !== notif.id)])
    }
    window.addEventListener('ch-toast', handler)
    return () => window.removeEventListener('ch-toast', handler)
  }, [])

  const dismiss = useCallback((id: string) => {
    dismissNotif(id)
    setNotifs(prev => prev.filter(n => n.id !== id))
  }, [])

  const dismissAll = useCallback(() => {
    dismissAllNotifs()
    setNotifs([])
  }, [])

  // Click on notification body → open that analysis session in the Analyzer view
  const open = useCallback((notif: StoredNotif) => {
    if (notif.sessionId) {
      setView('analyzer')
      setActiveChatId(notif.sessionId)
    }
    dismiss(notif.id)
  }, [setView, setActiveChatId, dismiss])

  if (notifs.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-h-[calc(100vh-2rem)] overflow-y-auto">
      {/* Multi-notif header */}
      {notifs.length > 1 && (
        <div className="flex items-center justify-between px-1 pointer-events-auto">
          <span className="text-[11px] text-[var(--dim)]">{notifs.length} notifications</span>
          <button
            onClick={dismissAll}
            className="text-[11px] text-[var(--dim)] hover:text-[var(--text)] transition-colors"
          >
            Dismiss all
          </button>
        </div>
      )}

      {notifs.map(notif => (
        <div
          key={notif.id}
          className={cn(
            'flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border pointer-events-auto',
            'min-w-[280px] max-w-[380px]',
            'animate-[slideIn_0.2s_ease-out]',
            notif.kind === 'done'
              ? 'bg-[var(--card)] border-green-500/30'
              : 'bg-[var(--card)] border-red-500/30',
          )}
        >
          {notif.kind === 'done'
            ? <CheckCircle size={16} className="shrink-0 mt-0.5 text-green-400" />
            : <XCircle    size={16} className="shrink-0 mt-0.5 text-red-400" />
          }

          {/* Body — clickable if there's a session to navigate to */}
          <button
            className={cn(
              'flex-1 min-w-0 text-left',
              notif.sessionId && 'hover:opacity-80 transition-opacity cursor-pointer',
              !notif.sessionId && 'cursor-default',
            )}
            onClick={() => open(notif)}
            title={notif.sessionId ? 'Click to open analysis' : undefined}
          >
            <p className="text-xs font-semibold text-[var(--text)]">{notif.title}</p>
            <p className="text-xs text-[var(--dim)] truncate">{notif.body}</p>
            <p className="text-[10px] text-[var(--dim)] opacity-50 mt-0.5">{fmtTime(notif.timestamp)}</p>
          </button>

          {notif.sessionId && (
            <ExternalLink size={11} className="shrink-0 mt-1 text-[var(--dim)] opacity-40" />
          )}

          <button
            onClick={() => dismiss(notif.id)}
            className="shrink-0 text-[var(--dim)] hover:text-[var(--text)] transition-colors"
            title="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
