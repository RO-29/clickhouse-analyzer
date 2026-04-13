export function fmtBytes(b: number | string | null | undefined): string {
  const n = Number(b)
  if (!isFinite(n) || n === 0) return '0 B'
  const k = 1024, s = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.max(0, Math.floor(Math.log(Math.abs(n)) / Math.log(k))), s.length - 1)
  return parseFloat((n / Math.pow(k, i)).toFixed(1)) + ' ' + s[i]
}

export function fmtNum(n: number | null | undefined): string {
  return n != null ? Number(n).toLocaleString() : '\u2014'
}

export function fmtTime(unix: number): string {
  if (!unix) return '\u2014'
  return new Date(unix * 1000).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  })
}

export function fmtDuration(ms: number | string | null | undefined): string {
  const n = Number(ms)
  if (!isFinite(n)) return '—'
  if (n < 1000) return n.toFixed(0) + 'ms'
  if (n < 60000) return (n / 1000).toFixed(1) + 's'
  return (n / 60000).toFixed(1) + 'm'
}

export function scoreColor(s: number): string {
  return s >= 80 ? '#22c55e' : s >= 50 ? '#eab308' : '#ef4444'
}

export function scoreBg(s: number): string {
  return s >= 80 ? 'bg-green-500/10 text-green-400' : s >= 50 ? 'bg-yellow-500/10 text-yellow-400' : 'bg-red-500/10 text-red-400'
}

export function sevColor(s: string): string {
  return s === 'critical' ? 'bg-red-500/10 text-red-400 border-red-500/20'
    : s === 'warn' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
    : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
}

export function cn(...classes: (string | boolean | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function timeRange(rangeSeconds: number): { from: number; to: number } {
  const now = Math.floor(Date.now() / 1000)
  return { from: now - rangeSeconds, to: now }
}

/** Convert preset label to [from, to] epoch seconds */
export function presetToRange(preset: string): [number, number] {
  const map: Record<string, number> = {
    '15m': 15 * 60,
    '1h': 60 * 60,
    '6h': 6 * 60 * 60,
    '24h': 24 * 60 * 60,
    '7d': 7 * 24 * 60 * 60,
  }
  const delta = map[preset] ?? 60 * 60
  const now = Math.floor(Date.now() / 1000)
  return [now - delta, now]
}

export function healthColor(score: number): string {
  if (score >= 80) return '#22c55e'
  if (score >= 50) return '#eab308'
  return '#ef4444'
}

export function fmtPercent(v: number): string {
  return `${v.toFixed(1)}%`
}
