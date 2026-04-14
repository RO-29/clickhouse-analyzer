/**
 * Notification utility for AI analysis completion/errors.
 *
 * Channels:
 *  1. In-app toast   — always fires, persists in localStorage until dismissed
 *  2. OS notification — fires when permission granted (no visibility gate)
 *  3. Audio tone      — synthesized, no audio files needed
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastKind = 'done' | 'error'

export interface StoredNotif {
  id: string
  kind: ToastKind
  title: string
  body: string
  sessionId?: string   // AI chat session to navigate to on click
  timestamp: number
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'ch-notifs'
const MAX_NOTIFS   = 50
const MAX_AGE_MS   = 7 * 86_400_000  // keep 7 days

export function loadStoredNotifs(): StoredNotif[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const all = JSON.parse(raw) as StoredNotif[]
    const cutoff = Date.now() - MAX_AGE_MS
    return all.filter(n => n.timestamp > cutoff)
  } catch { return [] }
}

export function dismissNotif(id: string): void {
  try {
    const updated = loadStoredNotifs().filter(n => n.id !== id)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
  } catch {}
}

export function dismissAllNotifs(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
}

function storeNotif(notif: StoredNotif): void {
  try {
    const updated = [notif, ...loadStoredNotifs()].slice(0, MAX_NOTIFS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
  } catch {}
}

// ---------------------------------------------------------------------------
// In-app toast event bus
// ---------------------------------------------------------------------------

export function dispatchToast(notif: StoredNotif): void {
  window.dispatchEvent(new CustomEvent('ch-toast', { detail: notif }))
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

function playTone(freqs: number[], duration: number, gainVal = 0.25) {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    freqs.forEach((freq, i) => {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = ctx.currentTime + i * (duration * 0.6)
      gain.gain.setValueAtTime(gainVal, start)
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
      osc.start(start)
      osc.stop(start + duration)
    })
  } catch {}
}

// ---------------------------------------------------------------------------
// OS / browser notification
// ---------------------------------------------------------------------------

function showBrowserNotif(title: string, body: string) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  // Fire regardless of tab visibility — user explicitly granted permission
  try { new Notification(title, { body }) } catch {}
}

/** Call on first user interaction to prompt the OS permission dialog. */
export function requestNotifPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function makeId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
}

/** Analysis finished successfully. */
export function notifyDone(label: string, sessionId?: string) {
  playTone([659, 880], 0.18)
  const notif: StoredNotif = {
    id: makeId(),
    kind: 'done',
    title: 'Analysis complete',
    body: label,
    sessionId,
    timestamp: Date.now(),
  }
  storeNotif(notif)
  dispatchToast(notif)
  showBrowserNotif('Analysis complete ✓', label)
}

/** Analysis failed. */
export function notifyError(label: string) {
  playTone([147, 110], 0.25, 0.2)
  const notif: StoredNotif = {
    id: makeId(),
    kind: 'error',
    title: 'Analysis failed',
    body: label,
    timestamp: Date.now(),
  }
  storeNotif(notif)
  dispatchToast(notif)
  showBrowserNotif('Analysis failed', label)
}
