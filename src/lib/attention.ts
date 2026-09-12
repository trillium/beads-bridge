import { beadText } from './exec'
import { relayStatus, RelayStatusTracker } from './relay-status'
import { storeFromId } from '../util'

export interface NextAction {
  tool: string
  id: string
  why: string
  after: string
}

const RANK: Record<string, number> = { failed: 0, verify: 1, stale: 2, waiting: 3, active: 4 }

export async function attentionNext(tracker: RelayStatusTracker = relayStatus): Promise<string> {
  const rows = tracker.list()
  if (!rows.length) {
    return [
      `# attention-next — one action`,
      ``,
      `Do: query_store task — nothing touched recently, pull the open queue and pick the smallest item.`,
      `After: relay_verify <id> on whatever you pick, then relay_upsert_task only if it is missing.`,
    ].join('\n')
  }
  const scored = rows
    .map(({ item, state }) => {
      if (item.needsVerify) return { item, key: 'verify', rank: RANK.verify, why: 'touched but never re-read — confirm it landed before reasoning further' }
      if (state === 'failed') return { item, key: 'failed', rank: RANK.failed, why: 'a write failed — re-read before replying' }
      if (state === 'stale') return { item, key: 'stale', rank: RANK.stale, why: 'aged past TTL — refresh only if still relevant' }
      if (state === 'waiting') return { item, key: 'waiting', rank: RANK.waiting, why: 'dispatch requested, not executed — check whether an agent claimed it' }
      return { item, key: 'active', rank: RANK.active, why: 'most recent live thread — advance it or close it' }
    })
    .sort((a, b) => a.rank - b.rank)
  const top = scored[0]
  const action: NextAction =
    top.key === 'verify'
      ? { tool: 'relay_verify or bead_show', id: top.item.id, why: top.why, after: 'relay_status mark_verified, then continue the thread' }
      : top.key === 'waiting'
        ? { tool: 'bead_show', id: top.item.id, why: top.why, after: 'if unclaimed, nudge the target; the relay never executes it' }
        : { tool: 'bead_show', id: top.item.id, why: top.why, after: 'smallest write that moves it: bead_comment, relay_upsert_task, or bead_decision' }
  let live = ''
  const store = storeFromId(action.id)
  if (store) {
    const body = await beadText(store, ['show', action.id])
    live = /unknown|no such|not found/i.test(body.slice(0, 200))
      ? `live: gone from ${store} — drop it and take the next followup`
      : `live: ${body.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 160)}`
  }
  return [
    `# attention-next — one action`,
    ``,
    `Do: ${action.tool} ${action.id} — ${action.why}.`,
    ...(live ? [live] : []),
    `After: ${action.after}.`,
  ].join('\n')
}

export { relayStatus }
