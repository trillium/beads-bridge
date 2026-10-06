// Real timestamps + computed ages for everything the bridge reports
// (task-60f3z).
//
// WHY: on 2026-10-06 a worker status said "working" while its pane showed
// CH99.6% with nothing advancing, and a pane read said "still working" for
// work whose last meaningful action was minutes old. The read could not
// tell fresh evidence from stale evidence: heartbeat rows carried no time at
// all, and the one time that did appear (the projection's `touched=`) is
// the bridge's own touch time, which reads like the action's own time.
//
// RULES this module encodes (one place, so no surface invents its own):
// - SOURCE time wins. When the event carries its own timestamp (a store's
//   `updated_at`, a caller-supplied occurrence time) it is reported as the
//   event time and never replaced by a bridge touch time.
// - TOUCH time is labeled as such. With no source time, the touch is
//   rendered with a `touched` marker, never as the action's own time.
// - Ages are computed against an injected READ time, so the rendered delta
//   stays correct however long after the event the read happens.
// - Structured fields carry ISO + epoch ms + basis, so a consumer computes
//   the delta itself instead of parsing a rendered string. Every rendered
//   age has a structured twin.
//
// Pure and subprocess-free (unit-testable); `now` is always injected or
// defaulted at the boundary, never read from a hidden clock inside a
// formatter.
/**
 * Compact machine-ish duration ("45s", "3h12m", "2d0h") — the token form
 * used inside structured evidence lines. Lives here so every age in the
 * bridge renders from one vocabulary.
 */
export function humanAge(ms: number): string {
  const m = Math.max(0, Math.floor(ms / MINUTE))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m % 60}m`
  return `${m}m`
}

/** Below this the event is "just now" — anything more precise is noise. */
export const JUST_NOW_MS = 45_000

/** Rendered when a timestamp is missing or unparseable — never a guess. */
export const AGE_UNKNOWN = 'age unknown'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Parse a timestamp from a store row or a caller argument into epoch ms.
 * Accepts ISO strings (what `bd --json` emits) and epoch numbers in either
 * seconds or milliseconds. Returns null for anything unusable, so callers
 * label the time as unknown instead of inventing one.
 */
export function parseStampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    // < 1e11 is epoch SECONDS (1.7e9 today); anything larger is ms.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return parseStampMs(Number(s))
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : null
}

/** Normalize any accepted timestamp form to an ISO string, or null. */
export function stampIso(value: unknown): string | null {
  const ms = parseStampMs(value)
  return ms == null ? null : new Date(ms).toISOString()
}

/**
 * Human-readable age of an event relative to a read time. The delta is
 * measured from `now` (the READ), so the answer is correct for that read no
 * matter how stale the event is. Future timestamps (clock skew between the
 * store and the bridge) render as `in …` rather than a negative age.
 */
export function formatAge(atMs: number, nowMs: number = Date.now()): string {
  const delta = nowMs - atMs
  if (!Number.isFinite(delta)) return AGE_UNKNOWN
  if (delta < 0) return `in ${humanDuration(-delta)}`
  if (delta < JUST_NOW_MS) return 'just now'
  return `${humanDuration(delta)} ago`
}

/** Compact duration only ("45s", "10 minutes", "3h12m"). */
function humanDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.floor(ms / SECOND))}s`
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE)
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR)
    return `${h} hour${h === 1 ? '' : 's'}`
  }
  const d = Math.floor(ms / DAY)
  return `${d} day${d === 1 ? '' : 's'}`
}

/** A timestamp plus everything a consumer needs to recompute the delta. */
export interface StampFields {
  /** ISO of the event time (omitted when unparseable). */
  at?: string
  /** Epoch ms of the event time — what a consumer subtracts from its own read time. */
  atMs?: number
  /** now - atMs, computed at read time. */
  ageMs?: number
  /** Rendered age ("10 minutes ago"). */
  age: string
}

/** Fields for one timestamp, computed against the read time. */
export function stampFields(atMs: number | null | undefined, nowMs: number = Date.now()): StampFields {
  if (atMs == null || !Number.isFinite(atMs)) return { age: AGE_UNKNOWN }
  return { at: new Date(atMs).toISOString(), atMs, ageMs: Math.max(0, nowMs - atMs), age: formatAge(atMs, nowMs) }
}

/**
 * Fields for any accepted timestamp form (ISO, Date, epoch). Unparseable
 * input yields `{age: 'age unknown'}` — the honest answer, never a
 * substituted touch time.
 */
export function stampFieldsOf(value: unknown, nowMs: number = Date.now()): StampFields {
  return stampFields(parseStampMs(value), nowMs)
}

/**
 * One-line rendered stamp: absolute time plus its age, with an explicit
 * marker for which time it is.
 *
 *   source: `at 2026-10-06T05:12:00.000Z (10 minutes ago)`
 *   touch:  `touched 2026-10-06T05:12:00.000Z (10 minutes ago, touch time — not the action's own time)`
 *
 * `basis` decides the wording; 'touch' never renders as a bare `at`.
 */
export function renderStamp(
  value: unknown,
  nowMs: number = Date.now(),
  basis: 'source' | 'touch' = 'source',
): string {
  const f = stampFieldsOf(value, nowMs)
  if (f.at == null) return `${basis === 'source' ? 'at' : 'touched'} ${AGE_UNKNOWN}`
  return basis === 'source'
    ? `at ${f.at} (${f.age})`
    : `touched ${f.at} (${f.age}, touch time — not the action's own time)`
}