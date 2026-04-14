/**
 * Notification + sound utility for AI analysis completion/errors.
 *
 * Three channels:
 *  1. In-app toast   — always fires (dispatches a custom DOM event picked up by <NotificationToasts>)
 *  2. OS notification — fires when tab is not focused (requires permission)
 *  3. Audio tone      — synthesized, no audio files needed
 */

// ---------------------------------------------------------------------------
// In-app toast event bus
// ---------------------------------------------------------------------------

export type ToastKind = 'done' | 'error'

export interface ToastEvent {
  kind: ToastKind
  title: string
  body: string
}

export function dispatchToast(evt: ToastEvent) {
  window.dispatchEvent(new CustomEvent('ch-toast', { detail: evt }))
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
      const osc = ctx.createOscillator()
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
  } catch {
    // AudioContext not supported or blocked
  }
}

// ---------------------------------------------------------------------------
// OS notification (shows when tab is not focused)
// ---------------------------------------------------------------------------

function showBrowserNotif(title: string, body: string) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  // Browsers suppress Notification when tab is focused — we use the in-app
  // toast for that case, so only fire OS notification when hidden.
  if (document.visibilityState === 'visible') return
  try {
    new Notification(title, { body })
  } catch {}
}

/** Call once on first user interaction to prompt the OS permission dialog. */
export function requestNotifPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Analysis finished successfully. */
export function notifyDone(label: string) {
  playTone([659, 880], 0.18)
  dispatchToast({ kind: 'done', title: 'Analysis complete', body: label })
  showBrowserNotif('Analysis complete', label)
}

/** Analysis failed. */
export function notifyError(label: string) {
  playTone([147, 110], 0.25, 0.2)
  dispatchToast({ kind: 'error', title: 'Analysis failed', body: label })
  showBrowserNotif('Analysis failed', label)
}
