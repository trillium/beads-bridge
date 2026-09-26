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
// - Delta: tracker items with lastTouchedAt strictly after the caller's
//   cursor. First-ever query (no cursor) returns the current projection
//   bounded, labeled mode 'baseline'; empty projection -> 'Feeds current.'
// - After every composed footer and every heartbeat call the cursor
//   advances to composition START (at-least-once: a concurrently touched
//   item may repeat next time, never silently skipped).
// - Concurrent callers hold independent cursors; one's advance never
//   affects another's.
// SAFETY: observational only — reads tracker.list(), advances an
// in-memory cursor map. No store reads, no writes, no agent requests.
// BOUNDS: at most HEARTBEAT_MAX_ITEMS rows, HEARTBEAT_MAX_CHARS chars.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { relayStatus, type RelayStatusTracker } from './relay-status'

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
  '## heartbeat — {{mode}} ({{count}} changed)',
  '{{#changed}}{{items}}',
  '{{/changed}}{{#empty}}Feeds current.{{/empty}}',
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
    .split('{{items}}').join(input.items)
}

/**
 * Compose the heartbeat footer block for a caller and advance its cursor.
 * Read-only over the tracker (list() never mutates); bounded output.
 */
export function renderHeartbeatBlock(
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
    const lines = shown.map((r) => `- ${r.item.id} [${r.item.kind}/${r.state}] ${r.item.title}`)
    if (delta.length > shown.length) lines.push(`- … +${delta.length - shown.length} more`)
    return renderHeartbeatTemplate(tpl, { mode, count: delta.length, items: lines.join('\n') }).replace(/\s+$/, '')
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
  advanceHeartbeatCursor(caller, t0)
  return text.length > HEARTBEAT_MAX_CHARS ? `${text.slice(0, HEARTBEAT_MAX_CHARS - 1)}…` : text
}
