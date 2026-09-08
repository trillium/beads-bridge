// Random pick: uniform sample across open beads in the work queues —
// something to do or revisit. Read-only; reshuffle by calling again.
// Pool: task, stories, resume_bullets, inbox, workflows (intersected with
// the registry), open items only, recent-first capped per store.
import { runList } from '../routes/query/store'
import { STORES } from '../config'

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

export function pickStores(store: string | undefined): string[] | { error: string } {
  if (store) return STORES.includes(store) ? [store] : { error: `unknown store: ${store}` }
  const eligible = PICK_STORES.filter((s) => STORES.includes(s))
  return eligible.length ? eligible : { error: 'no work stores registered' }
}

export function gatherCandidates(stores: string[]): { candidates: Candidate[]; pool: number } {
  const candidates: Candidate[] = []
  for (const s of stores) {
    const { rows } = runList(s, [], [], { exclude: [], status: undefined, limit: PER_STORE_LIMIT, allStates: false })
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
