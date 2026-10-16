// Level-batched neighbourhood reads for retrieval_snapshot and bead_connections.
//
// The bd-subprocess path spends ~6 spawns per bead (show --json, dep list x2,
// list --parent, show, comments) plus a BLOCKING spawnSync `list --label` per
// project label. This module loads a whole BFS level in a handful of
// statements instead; the rendered `show`/`comments` text (needed only for
// mention extraction) still comes from bd, batched (src/lib/bead-text.ts).
// Anything it cannot answer throws and the caller falls back to the old path.
import { fetchBeadTexts, type BeadRef } from './bead-text'
import { sqlBeadsById, sqlChildren, sqlDepEdges, sqlListSweep, type BdRow, type SqlDepEdge } from './sql-beads'

export interface GraphNode {
  id: string
  store: string
  /** `show --json`-shaped row; null when the bead does not exist. */
  meta: BdRow | null
  down: SqlDepEdge[]
  up: SqlDepEdge[]
  children: { id: string; title: string }[]
  /** show body + comments, same composition the bd path scans for mentions. */
  text: string
}

export async function loadGraphNodes(refs: BeadRef[], label: string): Promise<Map<string, GraphNode>> {
  const uniq = [...new Map(refs.map((r) => [r.id, r])).values()]
  const ids = uniq.map((r) => r.id)
  const [metas, down, up, kids] = await Promise.all([
    sqlBeadsById(ids),
    sqlDepEdges(ids, 'down'),
    sqlDepEdges(ids, 'up'),
    sqlChildren(uniq),
  ])
  // Text is the expensive part: only for beads that exist.
  const present = uniq.filter((r) => metas.has(r.id))
  const texts = await fetchBeadTexts(present, label)
  const out = new Map<string, GraphNode>()
  for (const r of uniq) {
    const t = texts.get(r.id)
    out.set(r.id, {
      id: r.id,
      store: r.store,
      meta: metas.get(r.id) ?? null,
      down: down.get(r.id) ?? [],
      up: up.get(r.id) ?? [],
      children: kids.get(r.id) ?? [],
      text: t ? (t.comments ? `${t.body}\n\n${t.comments}` : t.body) : '',
    })
  }
  return out
}

/** `list --label L --all --limit 8` per store for every label, one statement per label. */
export async function loadLabelPeers(
  labels: string[],
  stores: string[],
  limit = 8,
): Promise<Map<string, Map<string, BdRow[]>>> {
  const out = new Map<string, Map<string, BdRow[]>>()
  const ls = [...new Set(labels)]
  const ss = [...new Set(stores)]
  await Promise.all(
    ls.map(async (l) => {
      out.set(l, await sqlListSweep(ss, { limit, labels: [l], allStates: true }))
    }),
  )
  return out
}
