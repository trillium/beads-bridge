import { beadText, mapLimit } from './exec'
import { relayStatus, RelayStatusTracker, renderItemStamp } from './relay-status'
import { storeFromId } from '../util'

export interface CatchupEntry {
  id: string
  kind: string
  title: string
  live: string
  /** Bridge-side touch time (the toucher, not necessarily the actor). */
  touchedAt?: string
  /** Rendered touch stamp with the age against this read. */
  stamp?: string
}

function firstLine(s: string): string {
  return s.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 160) || '(empty)'
}

export async function catchupEntries(
  limit = 8,
  tracker: RelayStatusTracker = relayStatus,
  now: number = Date.now(),
): Promise<CatchupEntry[]> {
  const rows = tracker.list(now).slice(0, Math.max(1, Math.min(8, limit)))
  return mapLimit(rows, 4, async ({ item }) => {
    // Age is computed against ONE read time for the whole catchup, so the
    // ages in this response are mutually comparable (task-60f3z).
    const stamp = renderItemStamp(item, now)
    const store = storeFromId(item.id)
    if (!store) {
      return { id: item.id, kind: item.kind, title: item.title, live: 'local marker — no bead to re-read', touchedAt: item.lastTouchedAt, stamp }
    }
    const body = await beadText(store, ['show', item.id])
    const gone = /unknown|no such|not found/i.test(body.slice(0, 200))
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      live: gone ? 'gone from store' : firstLine(body),
      touchedAt: item.lastTouchedAt,
      stamp,
    }
  })
}

export function formatCatchup(
  entries: CatchupEntry[],
  followups: { id: string; reason: string; tool: string }[],
): string {
  if (!entries.length) {
    return [
      `# catchup — clear`,
      ``,
      `Nothing touched recently. Stores are authoritative; awareness rebuilds from them.`,
      `Start with relay_verify <bead-id> or query_store for open work.`,
    ].join('\n')
  }
  // Every row states how old the evidence is: a live store re-read that
  // exists says NOTHING about whether the worker is still working right
  // now (2026-10-06: "still working" reported for work whose last
  // meaningful action was minutes old).
  const lines = entries.map((e) => `- ${e.id} [${e.kind}] ${e.title}\n  live: ${e.live}${e.stamp ? `\n  evidence age: ${e.stamp}` : ''}`)
  const tails = followups.slice(0, 8).map((f) => `followup: ${f.tool} ${f.id} — ${f.reason}`)
  return [`# catchup — ${entries.length} recently-touched (live re-read, stores authoritative)`, ``, ...lines, ...(tails.length ? [``, ...tails] : []), ``, `Evidence age is measured against this read; an old touch is not proof of current work.`].join('\n')
}

export async function relayCatchup(
  limit = 8,
  tracker: RelayStatusTracker = relayStatus,
  now: number = Date.now(),
): Promise<string> {
  const entries = await catchupEntries(limit, tracker, now)
  return formatCatchup(entries, tracker.followups(now))
}