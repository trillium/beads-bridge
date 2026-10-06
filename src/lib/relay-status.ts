import { stalenessTriple } from './capabilities'
import { parseStampMs, stampFieldsOf, type StampFields } from './age'

export type RelayItemState = 'active' | 'waiting' | 'failed' | 'done' | 'stale'
export type RelayItemKind = 'task' | 'dispatch' | 'verify' | 'note' | 'completion' | 'failure'

/**
 * Which timestamp an item's reported time is (task-60f3z).
 *
 * - `source`: the event's OWN time — the store's `updated_at`, or a
 *   caller-supplied occurrence time. Reported as the item's time; the bridge
 *   touch is kept alongside it, never in its place.
 * - `touch`: only the bridge knows when it touched the id. Rendered with an
 *   explicit `touched` marker so it can never be read as the action's own
 *   time (the 2026-10-06 failure: a 10-minute-old proof rendered as a
 *   current "working" claim because nothing said how old it was).
 */
export type RelayTimeBasis = 'source' | 'touch'

export interface RelayItem {
  id: string
  kind: RelayItemKind
  title: string
  state: Exclude<RelayItemState, 'stale'>
  lastTouchedAt: string
  /**
   * The event's own time when the SOURCE provided one. Never set from the
   * touch time: an absent source time is reported as absent (`basis: 'touch'`),
   * not backfilled with the bridge's own clock.
   */
  eventAt?: string
  timeBasis: RelayTimeBasis
  pinned: boolean
  needsVerify: boolean
}

export interface RelayFollowup {
  id: string
  reason: string
  tool: string
}

export const RELAY_STATUS_MAX_ITEMS = 8
export const RELAY_STATUS_MAX_CHARS = 1500
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000

export function relayStatusTtlMs(): number {
  const raw = Number(process.env.RELAY_STATUS_TTL_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS
}

export function isRelayStale(item: RelayItem, now: number = Date.now()): boolean {
  if (item.pinned || item.state === 'waiting') return false
  return now - Date.parse(item.lastTouchedAt) > relayStatusTtlMs()
}

export function relayStateOf(item: RelayItem, now: number = Date.now()): RelayItemState {
  return isRelayStale(item, now) ? 'stale' : item.state
}

/**
 * Rendered label for an item's bridge-activity state.
 *
 * The projection's `state` is bridge bookkeeping, NOT bead lifecycle:
 * `'active'` means "the bridge touched this id recently", never "the bead
 * is open". Rendering the raw `active` token beside a bead id made one
 * response assert OPEN and CLOSED for the same bead at once: `bead_show`
 * read a bead as CLOSED while the footer counted that same id as
 * `[task/active]`. Out-of-band closes (direct `bd`/store CLI) never enter
 * the projection by design (docs/heartbeat.md "Coverage boundary"), so
 * the lifecycle-looking vocabulary — not the tracked data — has to stop
 * claiming a lifecycle state. `'active'` renders as `'touched'` so the
 * token can never be read as lifecycle OPEN (task inbox-1uxt).
 */
export function activityStateLabel(state: RelayItemState): string {
  return state === 'active' ? 'touched' : state
}

/**
 * Re-stamp an existing item: the touch time is always refreshed, the event
 * time is set ONLY from a source timestamp that parses (a missing or
 * unusable source time clears the previous one rather than leaving a stale
 * event time paired with a fresh touch).
 */
function applyTiming(item: RelayItem, now: number, at?: string | number | Date | null): void {
  item.lastTouchedAt = new Date(now).toISOString()
  const sourceMs = parseStampMs(at)
  if (sourceMs == null) {
    delete item.eventAt
    item.timeBasis = 'touch'
    return
  }
  item.eventAt = new Date(sourceMs).toISOString()
  item.timeBasis = 'source'
}

export class RelayStatusTracker {
  private items = new Map<string, RelayItem>()

  /**
   * Record a bridge action on an id.
   *
   * `now` is the bridge's touch time (always set). `at` is the OPTIONAL
   * source time of the event itself — the store's `updated_at`, a bead
   * receipt's time, or a caller-declared occurrence time. When `at` parses,
   * it becomes the item's reported event time and `timeBasis` is `source`;
   * otherwise the item is `touch` and every renderer says so. A source time
   * is never replaced by the touch time, and the touch time is never passed
   * off as the action's own.
   */
  touch(input: {
    id: string
    kind: RelayItemKind
    title?: string
    state?: RelayItem['state']
    pinned?: boolean
    needsVerify?: boolean
    now?: number
    at?: string | number | Date | null
  }): RelayItem {
    const id = input.id.trim()
    const prev = this.items.get(id)
    const touchedMs = input.now ?? Date.now()
    const sourceMs = parseStampMs(input.at)
    const item: RelayItem = {
      id,
      kind: input.kind,
      title: (input.title ?? prev?.title ?? id).replace(/\s+/g, ' ').trim().slice(0, 120) || id,
      state: input.state ?? (prev?.state === 'failed' ? 'failed' : 'active'),
      lastTouchedAt: new Date(touchedMs).toISOString(),
      ...(sourceMs == null ? {} : { eventAt: new Date(sourceMs).toISOString() }),
      timeBasis: sourceMs == null ? 'touch' : 'source',
      pinned: input.pinned ?? prev?.pinned ?? false,
      needsVerify: input.needsVerify ?? false,
    }
    this.items.delete(id)
    this.items.set(id, item)
    this.prune()
    return item
  }

  markVerified(id: string, now: number = Date.now(), at?: string | number | Date | null): RelayItem | null {
    const item = this.items.get(id.trim())
    if (!item) return null
    item.needsVerify = false
    applyTiming(item, now, at)
    if (item.state === 'failed') item.state = 'active'
    return item
  }

  markDone(id: string, now: number = Date.now(), at?: string | number | Date | null): RelayItem | null {
    const item = this.items.get(id.trim())
    if (!item) return null
    item.state = 'done'
    item.needsVerify = false
    applyTiming(item, now, at)
    return item
  }

  pin(id: string, pinned = true): RelayItem | null {
    const item = this.items.get(id.trim())
    if (!item) return null
    item.pinned = pinned
    return item
  }

  get(id: string): RelayItem | null {
    return this.items.get(id.trim()) ?? null
  }

  list(now: number = Date.now()): { item: RelayItem; state: RelayItemState }[] {
    const out = [...this.items.values()].map((item) => ({ item, state: relayStateOf(item, now) }))
    out.sort((a, b) => Date.parse(b.item.lastTouchedAt) - Date.parse(a.item.lastTouchedAt))
    return out.slice(0, RELAY_STATUS_MAX_ITEMS)
  }

  followups(now: number = Date.now()): RelayFollowup[] {
    const out: RelayFollowup[] = []
    for (const { item, state } of this.list(now)) {
      if (item.needsVerify) out.push({ id: item.id, reason: 'needs verification', tool: 'relay_verify or bead_show' })
      else if (state === 'failed') out.push({ id: item.id, reason: 'failed — re-read before replying', tool: 'bead_show' })
      else if (state === 'stale') out.push({ id: item.id, reason: 'stale — refresh if still relevant', tool: 'bead_show' })
    }
    return out
  }

  clear(): void {
    this.items.clear()
  }

  get size(): number {
    return this.items.size
  }

  private prune(): void {
    while (this.items.size > RELAY_STATUS_MAX_ITEMS) {
      const oldest = this.items.keys().next().value
      if (oldest === undefined) break
      const item = this.items.get(oldest)
      if (item?.pinned) {
        let moved = false
        for (const [k, v] of this.items) {
          if (!v.pinned) {
            this.items.delete(k)
            moved = true
            break
          }
        }
        if (!moved) break
      } else {
        this.items.delete(oldest)
      }
    }
  }
}

export const relayStatus = new RelayStatusTracker()

/**
 * Everything a consumer needs to judge an item's freshness WITHOUT parsing a
 * rendered string (task-60f3z): which kind of time this is, the raw ISO and
 * epoch-ms of the event, and the age already computed against the read time.
 *
 * `event` is the time to reason about (source time when the source gave one,
 * else the bridge touch — labeled by `basis` so the consumer knows which).
 * `touched` is always the bridge's own touch, kept separate so a source
 * timestamp is never overwritten by it.
 */
export interface RelayItemTiming {
  id: string
  kind: RelayItemKind
  state: RelayItemState
  /** Which timestamp `event` is. */
  basis: RelayTimeBasis
  /** Event time (source time, or the touch when no source time exists). */
  event: StampFields
  /** The bridge's own touch — always present, never standing in for the event. */
  touched: StampFields
}

/** Resolve an item's reported event time per the source-preserving rule. */
export function relayItemEventMs(item: RelayItem): number | null {
  return parseStampMs(item.timeBasis === 'source' ? item.eventAt : item.lastTouchedAt)
}

/** Structured timing for one item, ages computed against the read time. */
export function relayItemTiming(item: RelayItem, state: RelayItemState, now: number = Date.now()): RelayItemTiming {
  return {
    id: item.id,
    kind: item.kind,
    state,
    basis: item.timeBasis,
    event: stampFieldsOf(relayItemEventMs(item), now),
    touched: stampFieldsOf(item.lastTouchedAt, now),
  }
}

/** Structured timing for a whole projection (the MCP payload shape). */
export function relayTimings(
  tracker: RelayStatusTracker = relayStatus,
  now: number = Date.now(),
): RelayItemTiming[] {
  return tracker.list(now).map(({ item, state }) => relayItemTiming(item, state, now))
}

/**
 * Rendered stamp for one item: absolute time + age + an explicit basis
 * marker. Source items show their event time AND the touch; touch-only items
 * say so in words, so nobody can read a touch as the action's own time.
 */
export function renderItemStamp(item: RelayItem, now: number = Date.now()): string {
  const event = stampFieldsOf(relayItemEventMs(item), now)
  if (item.timeBasis === 'source' && event.at) {
    const touched = stampFieldsOf(item.lastTouchedAt, now)
    return `at ${event.at} (${event.age}) · touched ${touched.at} (${touched.age})`
  }
  return `touched ${item.lastTouchedAt} (${event.age}, touch time — not the action's own time)`
}

export function formatRelayBody(
  tracker: RelayStatusTracker = relayStatus,
  now: number = Date.now(),
): string {
  const rows = tracker.list(now)
  const lines = ['## relay-status (ephemeral bridge-activity projection — never bead lifecycle; Beads stores are authoritative)']
  lines.push(`read at ${new Date(now).toISOString()} — every age below is measured against this read; "at" is the event's own source time, "touched" is the bridge's touch`)
  if (!rows.length) {
    lines.push('clear — nothing touched recently')
  } else {
    for (const { item, state } of rows) {
      const flags = [
        item.pinned ? 'pinned' : null,
        item.needsVerify ? 'needs-verify' : null,
      ].filter(Boolean).join(',')
      lines.push(`- ${item.id} [${item.kind}/${activityStateLabel(state)}] ${item.title}${flags ? ` (${flags})` : ''} — ${renderItemStamp(item, now)}`)
    }
    for (const f of tracker.followups(now)) {
      lines.push(`followup: ${f.tool} ${f.id} — ${f.reason}`)
    }
  }
  let out = lines.join('\n')
  // Reserve room so the staleness triple (task-qgplz.2) is never truncated:
  // record it at connect (T0); any backend advance changes the string.
  const triple = stalenessTriple()
  const budget = RELAY_STATUS_MAX_CHARS - triple.length - 1
  if (out.length > budget) out = out.slice(0, budget - 1) + '…'
  return out
}

export function formatRelayStatus(
  tracker: RelayStatusTracker = relayStatus,
  now: number = Date.now(),
): string {
  return `${formatRelayBody(tracker, now)}\n${stalenessTriple()}`
}

export function withRelayStatus(
  body: string,
  tracker: RelayStatusTracker = relayStatus,
  now: number = Date.now(),
): string {
  return `${body}\n\n${formatRelayStatus(tracker, now)}`
}

/**
 * The relay-status read as data: the read time plus per-item source/touch
 * timestamps and ages. Shipped alongside the rendered body so a consumer can
 * recompute any delta against its own clock instead of re-parsing prose
 * (task-60f3z requirement 3).
 */
export function relayStatusReading(
  tracker: RelayStatusTracker = relayStatus,
  now: number = Date.now(),
): { readAt: string; readAtMs: number; count: number; items: RelayItemTiming[] } {
  const items = relayTimings(tracker, now)
  return { readAt: new Date(now).toISOString(), readAtMs: now, count: items.length, items }
}
