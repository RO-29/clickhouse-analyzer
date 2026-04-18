import { describe, it, expect } from 'vitest'
import { VALID_VIEWS, resolveView, resolveViewFromSearch } from './viewRouting'
import type { View } from './viewRouting'

// ---------------------------------------------------------------------------
// resolveView — pure function that maps a raw string to a View or 'overview'
// ---------------------------------------------------------------------------

describe('resolveView', () => {
  it('returns "overview" for null', () => {
    expect(resolveView(null)).toBe('overview')
  })

  it('returns "overview" for undefined', () => {
    expect(resolveView(undefined)).toBe('overview')
  })

  it('returns "overview" for an empty string', () => {
    expect(resolveView('')).toBe('overview')
  })

  it('returns "overview" for an unknown route', () => {
    expect(resolveView('nonexistent')).toBe('overview')
  })

  it('returns "overview" for a near-miss typo', () => {
    expect(resolveView('HISTORY')).toBe('overview')
    expect(resolveView('runCheck')).toBe('overview')
  })

  it('falls back to overview for removed routes (dashboard, discover)', () => {
    expect(resolveView('dashboard')).toBe('overview')
    expect(resolveView('discover')).toBe('overview')
  })

  // ── Recently-fixed routes (were missing before the bug fix) ──────────────
  it('recognises "history"', () => {
    expect(resolveView('history')).toBe('history')
  })

  it('recognises "runcheck"', () => {
    expect(resolveView('runcheck')).toBe('runcheck')
  })

  // ── All 17 valid views ───────────────────────────────────────────────────
  const allViews: View[] = [
    'overview',
    'detail',
    'alerts',
    'history',
    'explore',
    'compare',
    'advisor',
    'terminal',
    'logs',
    'chlogs',
    'analyzer',
    'scanner',
    'cost',
    'maintenance',
    'runcheck',
    'audit',
    'thresholds',
  ]

  it('has exactly 17 valid views', () => {
    expect(VALID_VIEWS).toHaveLength(17)
  })

  it('VALID_VIEWS contains every expected route', () => {
    for (const v of allViews) {
      expect(VALID_VIEWS).toContain(v)
    }
  })

  it.each(allViews)('resolveView("%s") returns "%s"', (v) => {
    expect(resolveView(v)).toBe(v)
  })
})

// ---------------------------------------------------------------------------
// resolveViewFromSearch — parses a location.search string
// ---------------------------------------------------------------------------

describe('resolveViewFromSearch', () => {
  it('parses ?view=overview', () => {
    expect(resolveViewFromSearch('?view=overview')).toBe('overview')
  })

  it('parses ?view=history (recently-fixed deep link)', () => {
    expect(resolveViewFromSearch('?view=history')).toBe('history')
  })

  it('parses ?view=runcheck (recently-fixed deep link)', () => {
    expect(resolveViewFromSearch('?view=runcheck')).toBe('runcheck')
  })

  it('falls back to overview for removed routes (?view=discover, ?view=dashboard)', () => {
    expect(resolveViewFromSearch('?view=discover')).toBe('overview')
    expect(resolveViewFromSearch('?view=dashboard')).toBe('overview')
  })

  it('ignores other params and still resolves the view', () => {
    expect(resolveViewFromSearch('?view=analyzer&instance=prod')).toBe('analyzer')
  })

  it('falls back to overview when ?view is absent', () => {
    expect(resolveViewFromSearch('')).toBe('overview')
    expect(resolveViewFromSearch('?instance=prod')).toBe('overview')
  })

  it('falls back to overview for an unknown view param', () => {
    expect(resolveViewFromSearch('?view=hackerRoute')).toBe('overview')
  })

  it('falls back to overview when ?view is empty', () => {
    expect(resolveViewFromSearch('?view=')).toBe('overview')
  })

  it.each([
    'detail',
    'alerts',
    'explore',
    'compare',
    'advisor',
    'terminal',
    'logs',
    'chlogs',
    'scanner',
    'cost',
    'maintenance',
    'audit',
    'thresholds',
  ] as View[])('resolveViewFromSearch("?view=%s") returns "%s"', (v) => {
    expect(resolveViewFromSearch(`?view=${v}`)).toBe(v)
  })
})
