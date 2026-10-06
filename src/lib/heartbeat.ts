// Heartbeat (task-ksmy1: inbox-uagq + inbox-lr1k) — the concrete
// follow-on service built on the generalized mechanism (followons.ts).
//
// Reports ONLY beads/feed state that changed since that caller's previous
// MCP query, reading the existing relay-status ephemeral projection
// (RelayStatusTracker) — never a parallel state model, never the stores.
//
// CURSOR RULE (also stated in docs/heartbeat.md):
// - Key: OAuth clientId when the call bears an OAuth token,
//   'loopback-local' for loopback service-bearer calls, 'anonymous' else.
//   NOTE: every caller arriving via the MCPJungle gateway shares the
//   single 'loopback-local' key (the gateway fans in with one bearer) —
//   distinct humans behind the gateway are NOT isolated from each other.
// - Delta: tracker items with lastTouchedAt strictly after the caller's
//   cursor. First-ever query (no cursor) returns the current projection
//   bounded, labeled mode 'baseline'; empty projection -> 'Feeds current.'
// - ACKNOWLEDGE-ON-READ (task-36na1): the cursor advances ONLY on calls
//   whose response shows the caller the state — the explicit `heartbeat`
//   tool (the delta) and `relay_status` (the full projection). Automatic
//   footers PEEK: they project the unacknowledged delta without advancing,
//   so an intervening call can never silently consume an event the caller
//   never asked to checkpoint. Trade-off: footers repeat the pending delta
//   (bounded, <=600 chars) until the caller explicitly heartbeats.
//   Cursor advances to composition START (at-least-once: a concurrently
//   touched item may repeat next time, never silently skipped).
// - SCOPE: the projection only ever contains bridge-mediated touches
//   (relayStatus.touch/markDone in the MCP tool callbacks). Out-of-band
//   store writes (direct `bd` CLI) never enter it — heartbeat cannot show
//   them; `retrieval_activity` (live store reads) is the authoritative
//   cross-check for those. Cursors AND the projection are in-memory: a
//   bridge restart resets every caller to baseline.
// SAFETY: observational only — reads tracker.list(), advances an
// in-memory cursor map. No store reads, no writes, no agent requests.
// BOUNDS: at most HEARTBEAT_MAX_ITEMS rows, HEARTBEAT_MAX_CHARS chars.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  activityStateLabel,
  relayItemTiming,
  renderItemStamp,
  relayStatus,
  type RelayItemState,
  type RelayStatusTracker,
} from './relay-status'

export const HEARTBEAT_MAX_ITEMS = 5
export const HEARTBEAT_MAX_CHARS = 600
export const HEARTBEAT_EMPTY_NOTICE = 'Feeds current.'
export const HEARTBEAT_CALLER_ANONYMOUS = 'anonymous'
export const HEARTBEAT_CALLER_LOOPBACK = 'loopback-local'

/** Tools whose responses stay bare: footer output must never re-trigger. */
export const HEARTBEAT_EXCLUDED_TOOLS = ['heartbeat', 'relay_status', 'timeout_probe']

export const HEARTBEAT_TEMPLATE_ENV = 'HEARTBEAT_TEMPLATE_FILE'

const cursors = new Map<string, number>()

/** Last composition-start ms for a caller, or null on first-ever query. */
export function heartbeatCursor(caller: string): number | null {
  return cursors.get(caller) ?? null
}

/** Advance a caller's cursor (composition-start => at-least-once). */
export function advanceHeartbeatCursor(caller: string, at: number = Date.now()): void {
  cursors.set(caller, at)
}

/** Test seam: drop all cursors. */
export function resetHeartbeatCursors(): void {
  cursors.clear()
}

function defaultTemplatePath(): string {
  return join(__dirname, '..', '..', 'config', 'heartbeat.md')
}

const FALLBACK_TEMPLATE = [
  '## heartbeat — {{mode}} ({{count}} changed; read at {{read}})',
  '{{#changed}}{{items}}',
  '{{/changed}}{{#empty}}Feeds current. (read at {{read}}){{/empty}}',
].join('\n')

/** Filesystem-backed template (env override, else config/heartbeat.md).
 *  Never throws — falls back to the built-in default on any read failure,
 *  so wording deploys/config errors can never fail a tool response. */
export function loadHeartbeatTemplate(): string {
  const raw = (() => {
    try {
      const p = process.env[HEARTBEAT_TEMPLATE_ENV]?.trim() || defaultTemplatePath()
      const t = readFileSync(p, 'utf8')
      return t.trim() ? t : FALLBACK_TEMPLATE
    } catch {
      return FALLBACK_TEMPLATE
    }
  })()
  return raw.includes('{{count}}') ? raw : FALLBACK_TEMPLATE
}

export interface HeartbeatRenderInput {
  mode: 'baseline' | 'delta'
  count: number
  items: string
  /** Read time the block (and every age in it) is measured against. */
  read: string
}

/** Pure mini-template: {{#changed}}/{{#empty}} blocks + placeholders. */
export function renderHeartbeatTemplate(tpl: string, input: HeartbeatRenderInput): string {
  const changed = input.count > 0
  let out = changed
    ? tpl.replace(/\{\{#empty\}\}[\s\S]*?\{\{\/empty\}\}/g, '')
    : tpl.replace(/\{\{#changed\}\}[\s\S]*?\{\{\/changed\}\}/g, '')
  out = out
    .replace(/\{\{#changed\}\}/g, '')
    .replace(/\{\{\/changed\}\}/g, '')
    .replace(/\{\{#empty\}\}/g, '')
    .replace(/\{\{\/empty\}\}/g, '')
  return out
    .split('{{mode}}').join(input.mode)
    .split('{{count}}').join(String(input.count))
    .split('{{read}}').join(input.read)
    .split('{{items}}').join(input.items)
}

/**
 * Compose the heartbeat block for a caller WITHOUT advancing its cursor.
 * Pure projection over the tracker (list() never mutates); bounded output.
 * Automatic footers use this (peek): an intervening call reports the
 * pending delta but never consumes it — only an explicit `heartbeat` or
 * `relay_status` read acknowledges (advances). `now` is injected so tests
 * (and the follow-on context's composition-start `at`) stay deterministic.
 */
export function peekHeartbeatBlock(
  caller: string,
  opts: { tracker?: RelayStatusTracker; now?: number } = {},
): string {
  const tracker = opts.tracker ?? relayStatus
  const t0 = opts.now ?? Date.now()
  const cursor = heartbeatCursor(caller)
  const rows = tracker.list(t0)
  const delta = cursor == null ? rows : rows.filter((r) => Date.parse(r.item.lastTouchedAt) > cursor)
  const tpl = loadHeartbeatTemplate()
  const mode = cursor == null ? 'baseline' : 'delta'
  const build = (shownCount: number): string => {
    const shown = delta.slice(0, shownCount)
    // Same bridge-activity vocabulary as the relay-status footer: this
    // projection's state is never bead lifecycle (see activityStateLabel).
    // Every row carries its event's own timestamp plus the age against THIS
    // read, with the basis marked (`at` = source time, `touched` = the
    // bridge's touch only) — a proof event ten minutes old can never render
    // as current progress (task-60f3z).
    const lines = shown.map(
      (r) => `- ${r.item.id} [${r.item.kind}/${activityStateLabel(r.state)}] ${r.item.title} — ${renderItemStamp(r.item, t0)}`,
    )
    if (delta.length > shown.length) lines.push(`- … +${delta.length - shown.length} more`)
    return renderHeartbeatTemplate(tpl, {
      mode,
      count: delta.length,
      read: new Date(t0).toISOString(),
      items: lines.join('\n'),
    }).replace(/\s+$/, '')
  }
  // Shrink by whole rows first so the overflow marker is never sliced off;
  // the hard slice below is a last-resort guard that cannot trigger while
  // a header + overflow line fits (tens of chars, always under budget).
  let count = Math.min(delta.length, HEARTBEAT_MAX_ITEMS)
  let text = build(count)
  while (text.length > HEARTBEAT_MAX_CHARS && count > 0) {
    count -= 1
    text = build(count)
  }
  return text.length > HEARTBEAT_MAX_CHARS ? `${text.slice(0, HEARTBEAT_MAX_CHARS - 1)}…` : text
}

/**
 * Compose the heartbeat footer block for a caller and advance its cursor.
 * Explicit acknowledge-on-read path: the `heartbeat` tool and
 * `relay_status` reads (whose responses show the caller the state).
 * Read-only over the tracker (list() never mutates); bounded output.
 */
export function renderHeartbeatBlock(
  caller: string,
  opts: { tracker?: RelayStatusTracker; now?: number } = {},
): string {
  const t0 = opts.now ?? Date.now()
  const text = peekHeartbeatBlock(caller, { tracker: opts.tracker, now: t0 })
  advanceHeartbeatCursor(caller, t0)
  return text
}

/** One delta row as data: the source/touch timestamps plus ages. */
export interface HeartbeatItemReading {
  id: string
  kind: string
  state: RelayItemState
  title: string
  basis: 'source' | 'touch'
  /** Event time (source when available, else the bridge touch). */
  event: { at?: string; atMs?: number; ageMs?: number; age: string }
  /** The bridge's touch, always present, never a stand-in for the event. */
  touched: { at?: string; atMs?: number; ageMs?: number; age: string }
}

/**
 * The heartbeat read as DATA (task-60f3z requirement 3): the read time plus
 * per-item source/touch timestamps and ages computed against it, so a
 * consumer can report both absolute time and age — and recompute the delta
 * against its own clock — without parsing the rendered block.
 *
 * Mirrors peekHeartbeatBlock's cursor rules exactly (same baseline/delta
 * split, same items) and never advances the cursor, so composing the payload
 * cannot acknowledge anything.
 */
export function heartbeatReading(
  caller: string,
  opts: { tracker?: RelayStatusTracker; now?: number } = {},
): {
  caller: string
  mode: 'baseline' | 'delta'
  readAt: string
  readAtMs: number
  count: number
  items: HeartbeatItemReading[]
} {
  const tracker = opts.tracker ?? relayStatus
  const t0 = opts.now ?? Date.now()
  const cursor = heartbeatCursor(caller)
  const rows = tracker.list(t0)
  const delta = cursor == null ? rows : rows.filter((r) => Date.parse(r.item.lastTouchedAt) > cursor)
  return {
    caller,
    mode: cursor == null ? 'baseline' : 'delta',
    readAt: new Date(t0).toISOString(),
    readAtMs: t0,
    count: delta.length,
    items: delta.slice(0, HEARTBEAT_MAX_ITEMS).map(({ item, state }) => {
      const t = relayItemTiming(item, state, t0)
      return { id: t.id, kind: t.kind, state: t.state, title: item.title, basis: t.basis, event: t.event, touched: t.touched }
    }),
  }
}
