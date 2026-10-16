// Level-batched neighbourhood reads for retrieval_snapshot and bead_connections.
//
// The bd-subprocess path spends ~6 spawns per bead (show --json, dep list x2,
// list --parent, show, comments) plus a BLOCKING spawnSync `list --label` per
// project label. This module loads a whole BFS level in a handful of
// statements instead; the rendered `show`/`comments` text (needed only for
// mention extraction) still comes from bd, batched (src/lib/bead-text.ts).
// Anything it cannot answer throws and the caller falls back to the old path.
import { fetchBeadTexts, type BeadRef } from './bead-text'
import { sqlBeadsById, sqlChildren, sqlDepEdges, sqlListSweep, sqlResolvePartialIds, type BdRow, type SqlDepEdge } from './sql-beads'

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
  const exact = await sqlBeadsById(uniq.map((r) => r.id))
  // A truncated id (a line-wrapped mention) is not a row; bd resolves it for
  // show / comments / dep list (but not for list --parent), so the SQL path
  // reads those through the resolved full id and keeps the node under the id
  // that was asked for. Unresolvable (none / ambiguous) stays a missing bead.
  const missing = uniq.filter((r) => !exact.has(r.id))
  const alias = missing.length ? await sqlResolvePartialIds(missing) : new Map<string, string>()
  const real = (id: string): string => alias.get(id) ?? id
  const extra = [...new Set([...alias.values()])].filter((id) => !exact.has(id))
  const [more, down, up, kids] = await Promise.all([
    extra.length ? sqlBeadsById(extra) : Promise.resolve(new Map<string, BdRow>()),
    sqlDepEdges(uniq.map((r) => real(r.id)), 'down'),
    sqlDepEdges(uniq.map((r) => real(r.id)), 'up'),
    sqlChildren(uniq), // literal ids: `list --parent <partial>` finds nothing in bd
  ])
  const metas = new Map([...exact, ...more])
  const metaOf = (id: string): BdRow | null => metas.get(real(id)) ?? null
  // Text is the expensive part: only for beads that exist. bd renders the
  // resolved bead identically whether asked by full or truncated id.
  const present = uniq.filter((r) => metaOf(r.id))
  const texts = await fetchBeadTexts(
    present.map((r) => ({ id: real(r.id), store: r.store })),
    label,
  )
  const out = new Map<string, GraphNode>()
  for (const r of uniq) {
    const t = texts.get(real(r.id))
    out.set(r.id, {
      id: r.id,
      store: r.store,
      meta: metaOf(r.id),
      down: down.get(real(r.id)) ?? [],
      up: up.get(real(r.id)) ?? [],
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
