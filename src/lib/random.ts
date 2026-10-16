// Random pick: uniform sample across open beads in the work queues —
// something to do or revisit. Read-only; reshuffle by calling again.
// Pool: task, stories, resume_bullets, inbox, workflows (intersected with
// the registry), open items only, recent-first capped per store.
import { runListQuery } from '../routes/query/store'
import { STORES } from '../config'
import { ambiguousStoreError, resolveStoreName, unknownStoreError } from './store-aliases'

export const PICK_STORES = ['task', 'stories', 'resume_bullets', 'inbox', 'workflows']
const PER_STORE_LIMIT = 50

export interface Candidate {
  id: string
  title: string
  store: string
  labels: string[]
}

// Pure: uniform indices without replacement (rand injectable for tests).
export function sampleIndices(n: number, count: number, rand: () => number = Math.random): number[] {
  const take = Math.min(Math.max(0, count), n)
  const pool = Array.from({ length: n }, (_, i) => i)
  const out: number[] = []
  while (out.length < take && pool.length) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
  }
  return out
}

export function pickStores(store: string | undefined, stores: string[] = STORES): string[] | { error: string } {
  if (store) {
    const r = resolveStoreName(store, stores)
    if (r.kind === 'exact' || r.kind === 'alias') return [r.store]
    if (r.kind === 'ambiguous') return { error: ambiguousStoreError(r.requested, r.candidates) }
    return { error: unknownStoreError(store, stores) }
  }
  const eligible = PICK_STORES.filter((s) => stores.includes(s))
  return eligible.length ? eligible : { error: 'no work stores registered' }
}

export async function gatherCandidates(stores: string[]): Promise<{ candidates: Candidate[]; pool: number }> {
  const candidates: Candidate[] = []
  const lists = await Promise.all(
    stores.map((s) => runListQuery(s, [], [], { exclude: [], status: undefined, limit: PER_STORE_LIMIT, allStates: false })),
  )
  for (const [i, s] of stores.entries()) {
    const { rows } = lists[i]
    for (const r of rows) {
      if (!candidates.some((c) => c.id === r.id)) {
        candidates.push({ id: r.id, title: r.title, store: s, labels: r.labels })
      }
    }
  }
  return { candidates, pool: candidates.length }
}

export function formatPicks(picks: Candidate[], pool: number): string {
  const lines = picks.map(
    (c) => `- ${c.id} — ${c.title} [${c.store}]${c.labels.length ? ` (${c.labels.slice(0, 4).join(', ')})` : ''}`,
  )
  return [
    `# random pick (${picks.length} of ${pool} open)`,
    ``,
    ...lines,
    ``,
    picks.length > 1 ? `Full context: bead_show on any id above.` : `Full context: bead_show ${picks[0]?.id ?? ''}.`,
    `Want another? Call again to reshuffle.`,
  ].join('\n')
}
