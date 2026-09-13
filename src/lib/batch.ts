// Atomic multi-bead graph creation: one call creates a whole bead graph.
//
// Later beads refer to earlier ones by intra-batch name; names resolve to
// canonical IDs at commit. Parent/child, explicit dependencies, and generic
// typed relations are all declared in the batch. Validation failures reject
// the whole batch before any write; runtime failures land as an explicit
// partial-failure report naming exactly what landed and what did not.
import { STORES } from '../config'
import { storeFromId } from '../util'
import { createBead, validateCreateLabels, type CreateInput } from './create'
import { runMutation } from './mutate'
import { execStdout } from './exec'

export const MAX_BATCH_BEADS = 20
export const MAX_BATCH_RELATIONS = 40

export const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

// Dependency types accepted by `dep add --type` (plus the default blocks
// used for plain depends_on edges, which omit the flag). XSTORE_ALIASES are
// the Brain federation vocabulary for cross-store links; they normalize to
// the nearest bd dep type for same-store dep-table writes, while cross-store
// mention-links carry the requested verbatim type in text (no info lost).
export const DEP_TYPES = [
  'blocks',
  'tracks',
  'related',
  'parent-child',
  'discovered-from',
  'until',
  'caused-by',
  'validates',
  'relates-to',
  'supersedes',
] as const

// Brain cross-store edge vocabulary → canonical bd dep type used when the
// edge lands in one store's dep table. Cross-store edges skip the dep table
// (see below) and record the requested type verbatim instead.
export const XSTORE_ALIASES: Record<string, string> = {
  source: 'discovered-from',
  provenance: 'discovered-from',
  'derived-from': 'caused-by',
  destination: 'relates-to',
  'recorded-in': 'relates-to',
}

export const XSTORE_TYPES = [...DEP_TYPES, ...Object.keys(XSTORE_ALIASES)]

export function canonicalEdgeType(type: string): { requested: string; canonical: string } {
  const requested = type.trim()
  const canonical = XSTORE_ALIASES[requested] ?? requested
  return { requested, canonical }
}

export function isKnownEdgeType(type: string): boolean {
  const t = type.trim()
  return (DEP_TYPES as readonly string[]).includes(t) || t in XSTORE_ALIASES
}

// Cross-store edges cannot land in either store's dep table: `dep add`
// accepts a foreign id without error but `dep list`/graph never resolve it
// (the join is local), so the edge would be a silent half-landing. The
// bridge's cross-store primitive is the mention-link instead: a typed comment
// on the from-bead naming the to-bead. The existing read side
// (extractLinks → connections.mentioned, retrieval.snapshotNeighbors) already
// traverses these, so a mention-link reads back and traverses like any edge.
export const XSTORE_EDGE_MARKER = 'Cross-store edge'

export function buildCrossStoreEdgeText(fromId: string, toId: string, type: string, toStore: string): string {
  return `${XSTORE_EDGE_MARKER} (${type}): ${fromId} --${type}--> ${toId} (STORE: ${toStore})`
}

export function crossStoreEdgePresent(commentsText: string, toId: string): boolean {
  return commentsText.includes(XSTORE_EDGE_MARKER) && commentsText.includes(toId)
}

export interface BatchBeadInput {
  name: string
  store: string
  title: string
  description?: string
  labels?: string[]
  parent?: string
  depends_on?: string[]
}

export interface BatchRelationInput {
  from: string
  to: string
  type: string
}

export interface BatchInput {
  beads: BatchBeadInput[]
  relations?: BatchRelationInput[]
}

interface ResolvedRef {
  // Intra-batch refs carry name + a placeholder id `<name>` filled with the
  // canonical id at commit; canonical ids carry id with no name.
  id: string
  name: string | null
}

interface ResolvedBead {
  index: number
  name: string
  store: string
  title: string
  description?: string
  labels: string[]
  parent: ResolvedRef | null
  deps: ResolvedRef[]
}

interface ResolvedRelation {
  from: string
  fromId: string
  to: string
  toId: string
  store: string
  // Canonical bd dep type (valid for `dep add --type` on same-store writes).
  type: string
  // Verbatim requested type — carried in cross-store mention-link text so
  // Brain vocabulary (derived-from, recorded-in, …) loses nothing.
  requested: string
}

export interface BatchBeadReceipt {
  name: string
  id: string
  store: string
  verified: boolean
  detail: string
}

export interface BatchEdgeReceipt {
  from: string
  fromId: string
  to: string
  toId: string
  store: string
  type: string
  // True when the edge spans stores and landed as a mention-link (comment on
  // the from-bead) rather than a dep-table row. Read the type accordingly:
  // verbatim Brain vocabulary, traversable via mentioned edges.
  xstore: boolean
  ok: boolean
  verified: boolean
  detail: string
}

export interface BatchFailure {
  target: string
  error: string
}

export interface BatchResult {
  beads: BatchBeadReceipt[]
  edges: BatchEdgeReceipt[]
  failures: BatchFailure[]
  complete: boolean
}

// Seam for tests: real subprocess fns by default, fakes under test.
export interface BatchFns {
  createBeadFn(input: CreateInput): Promise<{ id: string; detail: string; verified: boolean }>
  addEdge(store: string, fromId: string, toId: string, type?: string): Promise<string>
  verifyEdge(store: string, fromId: string, toId: string): Promise<boolean>
}

async function realAddEdge(store: string, fromId: string, toId: string, type?: string): Promise<string> {
  const toStore = storeFromId(toId)
  if (toStore && toStore !== store) {
    const edgeType = type ?? 'blocks'
    const text = buildCrossStoreEdgeText(fromId, toId, edgeType, toStore)
    await runMutation(store, ['comment', fromId, text])
    return `cross-store link recorded on ${fromId} → ${toId} (${edgeType}, via mention)`
  }
  const args = ['dep', 'add', fromId, toId, ...(type ? ['--type', type] : [])]
  return runMutation(store, args)
}

async function realVerifyEdge(store: string, fromId: string, toId: string): Promise<boolean> {
  const toStore = storeFromId(toId)
  if (toStore && toStore !== store) {
    // Mention-link verification: the edge line reads back on the from-bead
    // AND the target exists in its own store. Either half missing → false.
    try {
      const [comments, shown] = await Promise.all([
        execStdout(store, ['comments', fromId], 12000).catch(() => null),
        execStdout(toStore, ['show', toId], 10000).catch(() => null),
      ])
      return comments !== null && crossStoreEdgePresent(comments, toId) && shown !== null
    } catch {
      return false
    }
  }
  try {
    const out = await execStdout(store, ['dep', 'list', fromId, '--direction=down', '--json'], 12000)
    const arr: unknown = JSON.parse(out || '[]')
    return Array.isArray(arr) && arr.some((r) => (r as { id?: unknown }).id === toId)
  } catch {
    return false
  }
}

export const defaultBatchFns: BatchFns = {
  createBeadFn: (input) => createBead(input),
  addEdge: realAddEdge,
  verifyEdge: realVerifyEdge,
}

function fail(msg: string): never {
  throw new Error(msg)
}

// Resolve one ref: a batch name wins; otherwise it must be a canonical bead
// id. Bead-level refs (parent, depends_on) must point backwards (earlier
// beads) so commit order is topological by construction and cycles are
// impossible; standalone relations wire after all creates so any order goes.
function resolveRef(ref: string, context: string, byName: Map<string, number>, selfIndex: number | null): ResolvedRef {
  const clean = ref.trim()
  if (!clean) fail(`${context}: empty reference`)
  const idx = byName.get(clean)
  if (idx !== undefined) {
    if (selfIndex !== null && idx >= selfIndex) fail(`${context}: refers to "${clean}" which comes later — bead refs must point to earlier beads`)
    return { id: `<${clean}>`, name: clean }
  }
  if (!storeFromId(clean)) fail(`${context}: unknown reference "${clean}" (not a batch name or bead id)`)
  return { id: clean, name: null }
}

export function validateBatch(input: BatchInput): { beads: ResolvedBead[]; relations: ResolvedRelation[] } {
  const beads = input.beads ?? []
  if (!beads.length) fail('batch is empty (give at least 1 bead)')
  if (beads.length > MAX_BATCH_BEADS) fail(`batch has ${beads.length} beads (max ${MAX_BATCH_BEADS})`)
  const byName = new Map<string, number>()
  for (const b of beads) {
    const name = b.name?.trim() ?? ''
    if (!NAME_RE.test(name)) fail(`bad bead name "${b.name}" (match ${NAME_RE})`)
    if (byName.has(name)) fail(`duplicate bead name "${name}"`)
    byName.set(name, byName.size)
  }
  const relations = input.relations ?? []
  if (relations.length > MAX_BATCH_RELATIONS) fail(`batch has ${relations.length} relations (max ${MAX_BATCH_RELATIONS})`)

  const resolved: ResolvedBead[] = beads.map((b, index) => {
    const name = b.name.trim()
    const context = `bead "${name}"`
    if (!STORES.includes(b.store)) fail(`${context}: unknown store: ${b.store} (known: ${STORES.join(', ')})`)
    const title = b.title?.trim().slice(0, 200) ?? ''
    if (!title) fail(`${context}: title is required`)
    const { ok, bad } = validateCreateLabels(b.labels)
    if (bad.length) fail(`${context}: bad label: ${bad.join(', ')}`)
    return {
      index,
      name,
      store: b.store,
      title,
      description: b.description?.slice(0, 4000),
      labels: ok,
      parent: b.parent?.trim() ? resolveRef(b.parent, context, byName, index) : null,
      deps: (b.depends_on ?? []).map((r) => resolveRef(r, context, byName, index)),
    }
  })

  // Parent stays same-store: hierarchy lives in one store's table and no
  // cross-store primitive supports it. Deps and relations may span stores —
  // same-store legs land in the dep table, cross-store legs land as typed
  // mention-links (see realAddEdge); both verify and both report explicitly.
  const storeOf = (beadName: string): string => resolved[byName.get(beadName)!].store
  for (const r of resolved) {
    if (r.parent) {
      const pstore = r.parent.name ? storeOf(r.parent.name) : storeFromId(r.parent.id)
      if (pstore !== r.store) fail(`bead "${r.name}": parent ${r.parent.name ?? r.parent.id} lives in ${pstore}, not ${r.store} (parent stays in one store)`)
    }
  }

  const resolvedRelations: ResolvedRelation[] = relations.map((rel, i) => {
    const tag = `relation ${i}`
    const from = resolveRef(rel.from?.trim() ?? '', tag, byName, null)
    const to = resolveRef(rel.to?.trim() ?? '', tag, byName, null)
    const raw = rel.type?.trim() ?? ''
    if (!isKnownEdgeType(raw)) fail(`${tag}: bad type "${rel.type}" (want ${(XSTORE_TYPES as readonly string[]).join('|')})`)
    const { requested, canonical } = canonicalEdgeType(raw)
    const fromStore = from.name ? storeOf(from.name) : storeFromId(from.id)!
    return {
      from: from.name ?? from.id,
      fromId: from.id,
      to: to.name ?? to.id,
      toId: to.id,
      store: fromStore,
      type: canonical,
      requested,
    }
  })

  return { beads: resolved, relations: resolvedRelations }
}

export async function runBatch(input: BatchInput, fns: BatchFns = defaultBatchFns): Promise<BatchResult> {
  const { beads, relations } = validateBatch(input)
  const storeByName = new Map(beads.map((b) => [b.name, b.store]))
  const receipts: BatchBeadReceipt[] = []
  const edges: BatchEdgeReceipt[] = []
  const failures: BatchFailure[] = []
  const landed = new Map<string, string>()

  for (const b of beads) {
    // Skip beads whose intra-batch parent/deps never landed — reported, not silent.
    const missing = [
      ...(b.parent?.name ? [b.parent.name] : []),
      ...b.deps.filter((d) => d.name).map((d) => d.name!),
    ].filter((n) => !landed.has(n))
    if (missing.length) {
      failures.push({ target: b.name, error: `skipped: ${missing.join(', ')} did not land` })
      continue
    }
    const parent = b.parent ? (b.parent.name ? landed.get(b.parent.name) : b.parent.id) : undefined
    try {
      const { id, detail, verified } = await fns.createBeadFn({
        store: b.store,
        title: b.title,
        description: b.description,
        labels: b.labels,
        parent: parent ?? undefined,
      })
      landed.set(b.name, id)
      receipts.push({ name: b.name, id, store: b.store, verified, detail })
    } catch (e) {
      failures.push({ target: b.name, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const resolveId = (token: string): string | null => {
    if (token.startsWith('<')) {
      const id = landed.get(token.slice(1, -1))
      return id ?? null
    }
    return token
  }

  const wireEdge = async (store: string, from: string, fromIdToken: string, to: string, toIdToken: string, type?: string, note?: string) => {
    const fromId = resolveId(fromIdToken)
    const toId = resolveId(toIdToken)
    const xstoreOf = (f: string | null, t: string | null): boolean => {
      const ts = t ? storeFromId(t) : null
      return !!f && !!t && !!ts && ts !== store
    }
    if (!fromId || !toId) {
      edges.push({ from, fromId: fromId ?? fromIdToken, to, toId: toId ?? toIdToken, store, type: type ?? 'blocks', xstore: xstoreOf(fromId, toId), ok: false, verified: false, detail: `skipped: ${!fromId ? from : to} did not land` })
      return
    }
    const xstore = xstoreOf(fromId, toId)
    try {
      const detail = await fns.addEdge(store, fromId, toId, type)
      const verified = await fns.verifyEdge(store, fromId, toId)
      const full = note ? `${note} — ${detail}` : detail
      edges.push({ from, fromId, to, toId, store, type: type ?? 'blocks', xstore, ok: true, verified, detail: full.slice(0, 300) })
    } catch (e) {
      edges.push({ from, fromId, to, toId, store, type: type ?? 'blocks', xstore, ok: false, verified: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  for (const b of beads) {
    if (!landed.has(b.name)) continue
    for (const d of b.deps) {
      await wireEdge(b.store, b.name, `<${b.name}>`, d.name ?? d.id, d.id)
    }
  }
  for (const r of relations) {
    // Cross-store legs carry the requested Brain vocabulary verbatim in the
    // mention-link; same-store legs use the canonical bd dep type (aliases
    // normalize, noted on the receipt so nothing is misreported).
    const toStore = r.toId.startsWith('<') ? storeByName.get(r.to) ?? null : storeFromId(r.toId)
    const cross = !!toStore && toStore !== r.store
    const edgeType = cross ? r.requested : r.type
    const note = !cross && r.requested !== r.type ? `requested "${r.requested}" stored as "${r.type}"` : undefined
    await wireEdge(r.store, r.from, r.fromId, r.to, r.toId, edgeType, note)
  }

  const failedEdges = edges.filter((e) => !e.ok).map((e) => ({ target: `edge ${e.from}→${e.to}`, error: e.detail }))
  const allFailures = [...failures, ...failedEdges]
  return { beads: receipts, edges, failures: allFailures, complete: allFailures.length === 0 }
}

export function formatBatch(r: BatchResult): string {
  const landed = r.beads.length
  const failed = r.failures.length
  const head = r.complete
    ? `# batch — complete (${landed} bead${landed === 1 ? '' : 's'}, ${r.edges.length} edge${r.edges.length === 1 ? '' : 's'})`
    : `# batch — partial failure (${landed} landed, ${failed} failed)`
  const beadLines = r.beads.map((b) =>
    `- ${b.name} → ${b.id} (STORE: ${b.store}) — ${b.verified ? 'verified: yes' : 'verified: NO — re-read before reporting success'}`,
  )
  const edgeLines = r.edges.map((e) =>
    `- ${e.from} (${e.fromId}) --${e.type}--> ${e.to} (${e.toId}) — ${e.ok ? (e.verified ? `ok, verified${e.xstore ? ' (cross-store mention-link)' : ''}` : 'ok, UNVERIFIED — re-check') : `FAILED: ${e.detail}`}`,
  )
  const failLines = r.failures.filter((f) => !f.target.startsWith('edge ')).map((f) => `- ${f.target}: did not land — ${f.error}`)
  return [
    head,
    ``,
    ...beadLines,
    ...(edgeLines.length ? [``, `edges:`, ...edgeLines] : []),
    ...(failLines.length ? [``, `did not land:`, ...failLines] : []),
  ].join('\n')
}
