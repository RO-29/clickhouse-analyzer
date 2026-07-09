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

/**
 * Parse a ClickHouse timestamp into a Date.
 *
 * ClickHouse returns naive datetime strings ("YYYY-MM-DD HH:MM:SS", UTC on
 * ClickHouse Cloud) with no timezone marker. `new Date("2026-07-09 06:48:22")`
 * would parse that as *local* time, shifting it by the viewer's UTC offset. We
 * pin such strings to UTC so downstream toLocale* renders them in the viewer's
 * local timezone \u2014 i.e. query in UTC, display in local.
 *
 * Numbers are treated as epoch seconds; strings that already carry a zone
 * (trailing Z or \u00b1hh:mm, e.g. Go RFC3339) are trusted as-is.
 */
export function chToDate(s: string | number | null | undefined): Date {
  if (s == null || s === '') return new Date(NaN)
  if (typeof s === 'number') return new Date(s * 1000)
  const str = String(s).trim()
  if (/([zZ]|[+-]\d\d:?\d\d)$/.test(str)) return new Date(str)
  return new Date(str.replace(' ', 'T') + 'Z')
}

/** ClickHouse UTC timestamp \u2192 local "dd Mon, HH:MM". */
export function fmtCHDateTime(s: string | number | null | undefined): string {
  const d = chToDate(s)
  if (isNaN(d.getTime())) return '\u2014'
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

/** ClickHouse UTC timestamp \u2192 local "dd/MM HH:MM:SS" (compact, for dense tables). */
export function fmtCHClock(s: string | number | null | undefined): string {
  const d = chToDate(s)
  if (isNaN(d.getTime())) return '\u2014'
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
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

/** Compact notation: 1847392 → "1.8M", 340000 → "340K" */
export function fmtCompact(n: number | null | undefined): string {
  const v = Number(n)
  if (!isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return String(v)
}

/** Tailwind class for latency badge background + text */
export function latencyBg(ms: number | null | undefined): string {
  const v = Number(ms)
  if (!isFinite(v)) return 'bg-gray-500/10 text-gray-400'
  if (v >= 1000) return 'bg-red-500/10 text-red-400 border border-red-500/20'
  if (v >= 100) return 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
  return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
}

/** Tailwind class for query kind badge */
export function kindBg(kind: string | null | undefined): string {
  const k = String(kind ?? '').toLowerCase()
  if (k === 'select') return 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
  if (k === 'insert') return 'bg-green-500/10 text-green-400 border border-green-500/20'
  if (k === 'alter') return 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
  return 'bg-gray-500/10 text-gray-400 border border-gray-500/20'
}

/** Simple SQL keyword colorizer — returns array of {text, isKeyword, isString, isComment} tokens */
export function tokenizeSql(raw: string): Array<{ t: string; k: 'kw' | 'str' | 'num' | 'fn' | 'cmt' | 'op' | 'plain' }> {
  const KW = new Set(['SELECT','FROM','WHERE','GROUP','BY','ORDER','HAVING','LIMIT','WITH',
    'AS','ON','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS','ARRAY','UNION','ALL',
    'DISTINCT','AND','OR','NOT','IN','LIKE','ILIKE','IS','NULL','CASE','WHEN','THEN','ELSE','END',
    'INSERT','INTO','UPDATE','DELETE','CREATE','DROP','ALTER','TABLE','PREWHERE','FINAL',
    'SAMPLE','FORMAT','SETTINGS','IF','GLOBAL','ANY','ASOF','SEMI','ANTI',
  ])
  const FN = new Set(['count','sum','avg','min','max','uniq','uniqExact','countIf','sumIf','avgIf',
    'toDate','toDateTime','toStartOf','formatReadableSize','quantile','quantileExact',
    'arrayJoin','now','today','yesterday','if','multiIf','ifNull','coalesce','any','anyLast',
    'runningDifference','neighbor','dateDiff','addDays','groupArray','groupUniqArray',
  ])
  const out: Array<{ t: string; k: 'kw' | 'str' | 'num' | 'fn' | 'cmt' | 'op' | 'plain' }> = []
  let pos = 0
  while (pos < raw.length) {
    if (raw[pos] === "'" || raw[pos] === '`') {
      const q = raw[pos]
      let end = pos + 1
      while (end < raw.length && raw[end] !== q) end++
      out.push({ t: raw.slice(pos, end + 1), k: 'str' })
      pos = end + 1
    } else if (raw.slice(pos, pos + 2) === '--') {
      let end = raw.indexOf('\n', pos)
      if (end === -1) end = raw.length
      out.push({ t: raw.slice(pos, end), k: 'cmt' })
      pos = end
    } else if (/[a-zA-Z_]/.test(raw[pos])) {
      let end = pos + 1
      while (end < raw.length && /[\w]/.test(raw[end])) end++
      const word = raw.slice(pos, end)
      const up = word.toUpperCase()
      out.push({ t: word, k: KW.has(up) ? 'kw' : FN.has(word.toLowerCase()) ? 'fn' : 'plain' })
      pos = end
    } else if (/\d/.test(raw[pos])) {
      let end = pos + 1
      while (end < raw.length && /[\d.]/.test(raw[end])) end++
      out.push({ t: raw.slice(pos, end), k: 'num' })
      pos = end
    } else {
      out.push({ t: raw[pos], k: /[(),*]/.test(raw[pos]) ? 'op' : 'plain' })
      pos++
    }
  }
  return out
}
