import { useCallback } from 'react'
import { useStore } from './useStore'
import { notifyDone, notifyError, requestNotifPermission } from '../lib/notify'
import type { AnalysisEntry, AnalyzeOptions } from '../types/api'

// Re-export so existing imports from this module keep working
export type { AnalysisEntry, AnalyzeOptions }

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
}

export const PANEL_EXPANDED_HEIGHT = 'calc(45vh + 8px)'
export const PANEL_COLLAPSED_HEIGHT = '36px'

export function useAIAnalysis(instance: string) {
  const { aiEntries: entries, aiPanelOpen: isOpen, setAiEntries: setEntries, setAiPanelOpen: setIsOpen, clearAiEntries: clearEntries } = useStore()

  const analyze = useCallback(
    async (
      label: string,
      visibleData: Record<string, any>,
      options: AnalyzeOptions,
    ) => {
      const id = generateId()
      const newEntry: AnalysisEntry = {
        id,
        label,
        contextType: options.contextType,
        tab: options.tab,
        elementId: options.elementId,
        status: 'streaming',
        output: '',
        timestamp: new Date(),
      }

      setEntries(prev => [newEntry, ...prev])
      setIsOpen(true)
      requestNotifPermission()

      // Track whether we've already notified so we don't double-fire
      let notified = false
      const fireNotifyDone = () => { if (!notified) { notified = true; notifyDone(label) } }
      const fireNotifyError = () => { if (!notified) { notified = true; notifyError(label) } }

      try {
        const resp = await fetch(
          `/api/instances/${instance}/analyze-element`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              context_type: options.contextType,
              context_label: label,
              tab: options.tab,
              visible_data: visibleData,
              mode: options.mode ?? 'quick',
              deep_queries: options.deepQueries,
            }),
          },
        )

        if (!resp.ok || !resp.body) {
          let msg = `HTTP ${resp.status}`
          try {
            const j = await resp.json()
            if (j?.error) msg = j.error
          } catch {}
          setEntries(prev =>
            prev.map(e =>
              e.id === id ? { ...e, status: 'error', output: `Error: ${msg}` } : e,
            ),
          )
          fireNotifyError()
          return
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEvent = ''
        let currentData = ''

        const flush = () => {
          if (currentEvent === 'chunk' && currentData) {
            try {
              const text = JSON.parse(currentData) as string
              setEntries(prev =>
                prev.map(e =>
                  e.id === id ? { ...e, output: e.output + text } : e,
                ),
              )
            } catch {}
          } else if (currentEvent === 'error' && currentData) {
            try {
              const msg = JSON.parse(currentData) as string
              setEntries(prev =>
                prev.map(e =>
                  e.id === id
                    ? {
                        ...e,
                        status: 'error',
                        output: e.output + `\n\n**Error:** ${msg}`,
                      }
                    : e,
                ),
              )
              fireNotifyError()
            } catch {}
          } else if (currentEvent === 'status' && currentData) {
            try {
              const s = JSON.parse(currentData) as { phase: string }
              if (s.phase === 'done') {
                setEntries(prev =>
                  prev.map(e =>
                    e.id === id ? { ...e, status: 'done' } : e,
                  ),
                )
              }
            } catch {}
          }
          currentEvent = ''
          currentData = ''
        }

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line === '') {
              flush()
            } else if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              currentData = line.slice(6)
            }
          }
        }

        // Ensure done even if backend didn't send status:done
        setEntries(prev =>
          prev.map(e =>
            e.id === id && e.status === 'streaming'
              ? { ...e, status: 'done' }
              : e,
          ),
        )
        fireNotifyDone()
      } catch (err: any) {
        setEntries(prev =>
          prev.map(e =>
            e.id === id
              ? { ...e, status: 'error', output: `Error: ${err.message}` }
              : e,
          ),
        )
        fireNotifyError()
      }
    },
    [instance, setEntries, setIsOpen],
  )

  return { entries, isOpen, setIsOpen, analyze, clearEntries }
}
