/**
 * Notification + sound utility for AI analysis completion/errors.
 * Plays a synthesized tone (no audio files needed) and shows a browser
 * notification when the tab is not focused.
 */

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

function showBrowserNotif(title: string, body: string) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'granted') {
    try {
      new Notification(title, { body, silent: true })
    } catch {}
  }
}

/** Call once (e.g. on first Run Analysis click) to prompt the browser permission dialog. */
export function requestNotifPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
}

/** Play a pleasant double-ding and show a browser notification. */
export function notifyDone(label: string) {
  // Two-note ascending ding: E5 → A5
  playTone([659, 880], 0.18)
  showBrowserNotif('Analysis complete', label)
}

/** Play a low error buzz and show a browser notification. */
export function notifyError(label: string) {
  // Descending low tones: D3 → A2
  playTone([147, 110], 0.25, 0.2)
  showBrowserNotif('Analysis failed', label)
}
