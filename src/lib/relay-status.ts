export type RelayItemState = 'active' | 'waiting' | 'failed' | 'done' | 'stale'
export type RelayItemKind = 'task' | 'dispatch' | 'verify' | 'note' | 'completion' | 'failure'

export interface RelayItem {
  id: string
  kind: RelayItemKind
  title: string
  state: Exclude<RelayItemState, 'stale'>
  lastTouchedAt: string
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

export class RelayStatusTracker {
  private items = new Map<string, RelayItem>()

  touch(input: {
    id: string
    kind: RelayItemKind
    title?: string
    state?: RelayItem['state']
    pinned?: boolean
    needsVerify?: boolean
    now?: number
  }): RelayItem {
    const id = input.id.trim()
    const prev = this.items.get(id)
    const item: RelayItem = {
      id,
      kind: input.kind,
      title: (input.title ?? prev?.title ?? id).replace(/\s+/g, ' ').trim().slice(0, 120) || id,
      state: input.state ?? (prev?.state === 'failed' ? 'failed' : 'active'),
      lastTouchedAt: new Date(input.now ?? Date.now()).toISOString(),
      pinned: input.pinned ?? prev?.pinned ?? false,
      needsVerify: input.needsVerify ?? false,
    }
    this.items.delete(id)
    this.items.set(id, item)
    this.prune()
    return item
  }

  markVerified(id: string, now: number = Date.now()): RelayItem | null {
    const item = this.items.get(id.trim())
    if (!item) return null
    item.needsVerify = false
    item.lastTouchedAt = new Date(now).toISOString()
    if (item.state === 'failed') item.state = 'active'
    return item
  }

  markDone(id: string, now: number = Date.now()): RelayItem | null {
    const item = this.items.get(id.trim())
    if (!item) return null
    item.state = 'done'
    item.needsVerify = false
    item.lastTouchedAt = new Date(now).toISOString()
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

export function formatRelayStatus(
  tracker: RelayStatusTracker = relayStatus,
  now: number = Date.now(),
): string {
  const rows = tracker.list(now)
  const lines = ['## relay-status (ephemeral projection — Beads stores are authoritative)']
  if (!rows.length) {
    lines.push('clear — nothing touched recently')
    return lines.join('\n')
  }
  for (const { item, state } of rows) {
    const flags = [
      item.pinned ? 'pinned' : null,
      item.needsVerify ? 'needs-verify' : null,
    ].filter(Boolean).join(',')
    lines.push(`- ${item.id} [${item.kind}/${state}] ${item.title}${flags ? ` (${flags})` : ''} touched=${item.lastTouchedAt}`)
  }
  for (const f of tracker.followups(now)) {
    lines.push(`followup: ${f.tool} ${f.id} — ${f.reason}`)
  }
  let out = lines.join('\n')
  if (out.length > RELAY_STATUS_MAX_CHARS) out = out.slice(0, RELAY_STATUS_MAX_CHARS - 1) + '…'
  return out
}

export function withRelayStatus(
  body: string,
  tracker: RelayStatusTracker = relayStatus,
  now: number = Date.now(),
): string {
  return `${body}\n\n${formatRelayStatus(tracker, now)}`
}
