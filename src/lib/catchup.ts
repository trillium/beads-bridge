import { beadText, mapLimit } from './exec'
import { relayStatus, RelayStatusTracker } from './relay-status'
import { storeFromId } from '../util'

export interface CatchupEntry {
  id: string
  kind: string
  title: string
  live: string
}

function firstLine(s: string): string {
  return s.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 160) || '(empty)'
}

export async function catchupEntries(
  limit = 8,
  tracker: RelayStatusTracker = relayStatus,
): Promise<CatchupEntry[]> {
  const rows = tracker.list().slice(0, Math.max(1, Math.min(8, limit)))
  return mapLimit(rows, 4, async ({ item }) => {
    const store = storeFromId(item.id)
    if (!store) return { id: item.id, kind: item.kind, title: item.title, live: 'local marker — no bead to re-read' }
    const body = await beadText(store, ['show', item.id])
    const gone = /unknown|no such|not found/i.test(body.slice(0, 200))
    return { id: item.id, kind: item.kind, title: item.title, live: gone ? 'gone from store' : firstLine(body) }
  })
}

export function formatCatchup(entries: CatchupEntry[], followups: { id: string; reason: string; tool: string }[]): string {
  if (!entries.length) {
    return [
      `# catchup — clear`,
      ``,
      `Nothing touched recently. Stores are authoritative; awareness rebuilds from them.`,
      `Start with relay_verify <bead-id> or query_store for open work.`,
    ].join('\n')
  }
  const lines = entries.map((e) => `- ${e.id} [${e.kind}] ${e.title}\n  live: ${e.live}`)
  const tails = followups.slice(0, 8).map((f) => `followup: ${f.tool} ${f.id} — ${f.reason}`)
  return [`# catchup — ${entries.length} recently-touched (live re-read, stores authoritative)`, ``, ...lines, ...(tails.length ? [``, ...tails] : [])].join('\n')
}

export async function relayCatchup(limit = 8, tracker: RelayStatusTracker = relayStatus): Promise<string> {
  const entries = await catchupEntries(limit, tracker)
  return formatCatchup(entries, tracker.followups())
}
