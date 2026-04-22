/**
 * View routing helpers — pure functions so they can be unit-tested without
 * a React or DOM environment.
 */

export type View = 'overview' | 'detail' | 'alerts' | 'history' | 'explore' | 'compare' | 'advisor' | 'terminal' | 'logs' | 'chlogs' | 'analyzer' | 'scanner' | 'cost' | 'maintenance' | 'runcheck' | 'audit' | 'thresholds' | 'guide'

/** All route names that the app recognises as valid deep-link targets. */
export const VALID_VIEWS: View[] = [
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
  'guide',
]

/**
 * Resolve the view from a raw `?view=` query-string value.
 *
 * Returns the value unchanged when it is a known valid route, or falls back
 * to `'overview'` for unknown / missing values.
 */
export function resolveView(raw: string | null | undefined): View {
  if (raw && (VALID_VIEWS as string[]).includes(raw)) {
    return raw as View
  }
  return 'overview'
}

/**
 * Parse the `?view=` param from a URL search string and resolve it.
 *
 * @param search  The `location.search` string (e.g. `"?view=history&instance=prod"`).
 */
export function resolveViewFromSearch(search: string): View {
  const params = new URLSearchParams(search)
  return resolveView(params.get('view'))
}
