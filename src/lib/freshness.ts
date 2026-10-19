// Read-path freshness for bead_show (task-6b6ij).
//
// WHY: the tools were honest about data but silent about trust. On
// 2026-10-19 a search title was trusted over bead_show comments and a false
// "zero movement" conclusion was stated. Every bead_show answer now says when
// it was read, the store's last touch, and whether the answer is live.
//
// RULES:
// - `as_of` is this read's time. Every age is measured against it.
// - `last_touch` is the store's `updated_at`. Comments bump it, so it covers
//   comment movement too. It is a touch, not the bead's own change time.
// - `fresh` is true only when the body AND the touch were read from the
//   store in this response and the touch parsed. A failed or absent touch
//   yields `fresh: false` with a reason, never a guessed time.
import { execStdout } from './exec'
import { withSqlFallback } from './sql'
import { sqlBeadsById } from './sql-beads'
import { stampFieldsOf } from './age'

export interface BeadFreshness {
  /** Read time (ISO). Ages below are measured against it. */
  as_of: string
  /** The store's last touch of the bead (`updated_at`, comments included); null when unknown. */
  last_touch: string | null
  /** Age of `last_touch` relative to `as_of`, or `age unknown`. */
  last_touch_age: string
  /** True when the body and the touch were read live and the touch is known. */
  fresh: boolean
  /** Why `fresh` is false. */
  reason?: string
}

/** The store's `updated_at` for one exact id: SQL first, bd subprocess as the fallback. */
export async function fetchLastTouch(store: string, id: string): Promise<string | null> {
  return withSqlFallback(
    'bead_show_freshness',
    async () => (await sqlBeadsById([id])).get(id)?.updated_at ?? null,
    async () => {
      const rows = JSON.parse(await execStdout(store, ['show', id, '--json'], 10000)) as unknown
      const row = Array.isArray(rows) ? rows[0] : rows
      const at = (row as { updated_at?: unknown } | null)?.updated_at
      return typeof at === 'string' && at ? at : null
    },
  )
}

/**
 * Freshness for one bead read. Never throws: a failed touch lookup is a
 * `fresh: false` answer with its reason, so the body is still returned.
 */
export async function beadFreshness(store: string, id: string, now: number = Date.now()): Promise<BeadFreshness> {
  let touch: string | null = null
  let failed = false
  try {
    touch = await fetchLastTouch(store, id)
  } catch {
    failed = true
  }
  const f = stampFieldsOf(touch, now)
  const known = f.at != null
  return {
    as_of: new Date(now).toISOString(),
    last_touch: f.at ?? null,
    last_touch_age: f.age,
    fresh: known,
    ...(known ? {} : { reason: failed ? 'touch lookup failed' : 'store reported no touch time' }),
  }
}

/** The human-readable freshness block appended to bead_show text. */
export function renderFreshness(f: BeadFreshness): string {
  const touch = f.last_touch ? `${f.last_touch} (${f.last_touch_age})` : 'unknown'
  return [
    '## freshness',
    `as_of: ${f.as_of} (this read)`,
    `last_touch: ${touch} — the store's last update, comments included`,
    `fresh: ${f.fresh}${f.reason ? ` — ${f.reason}` : ''}`,
  ].join('\n')
}
