/**
 * Client-side SQL read-only validator.
 * Whitelist: SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH (CTEs leading to SELECT).
 * Applied before showing queries in confirmation dialogs AND before sending to backend.
 * The backend also enforces this server-side — two layers of defense.
 */

// Matches the first meaningful SQL keyword, skipping leading -- and /* */ comments
const READ_ONLY_START =
  /^\s*(\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\s/i

export function isReadOnlySql(sql: string): boolean {
  return READ_ONLY_START.test(sql)
}

export interface ValidationResult {
  valid: true
  offender?: never
}

export interface ValidationFailure {
  valid: false
  offender: string
}

export function validateAllReadOnly(
  queries: string[],
): ValidationResult | ValidationFailure {
  for (const q of queries) {
    if (!isReadOnlySql(q)) {
      return { valid: false, offender: q }
    }
  }
  return { valid: true }
}
