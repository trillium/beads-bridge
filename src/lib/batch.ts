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
// used for plain depends_on edges, which omit the flag).
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
  type: string
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
  const args = ['dep', 'add', fromId, toId, ...(type ? ['--type', type] : [])]
  return runMutation(store, args)
}

async function realVerifyEdge(store: string, fromId: string, toId: string): Promise<boolean> {
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

  // Same-store edges: bead_create's parent rule, extended to deps and
  // relations (each store is its own database — cross-store edges cannot land).
  const storeOf = (beadName: string): string => resolved[byName.get(beadName)!].store
  for (const r of resolved) {
    if (r.parent) {
      const pstore = r.parent.name ? storeOf(r.parent.name) : storeFromId(r.parent.id)
      if (pstore !== r.store) fail(`bead "${r.name}": parent ${r.parent.name ?? r.parent.id} lives in ${pstore}, not ${r.store}`)
    }
    for (const d of r.deps) {
      const dstore = d.name ? storeOf(d.name) : storeFromId(d.id)
      if (dstore !== r.store) fail(`bead "${r.name}": depends_on ${d.name ?? d.id} lives in ${dstore}, not ${r.store} (edges stay in one store)`)
    }
  }

  const resolvedRelations: ResolvedRelation[] = relations.map((rel, i) => {
    const tag = `relation ${i}`
    const from = resolveRef(rel.from?.trim() ?? '', tag, byName, null)
    const to = resolveRef(rel.to?.trim() ?? '', tag, byName, null)
    const type = rel.type?.trim() ?? ''
    if (!(DEP_TYPES as readonly string[]).includes(type)) fail(`${tag}: bad type "${rel.type}" (want ${(DEP_TYPES as readonly string[]).join('|')})`)
    const fromStore = from.name ? storeOf(from.name) : storeFromId(from.id)!
    const toStore = to.name ? storeOf(to.name) : storeFromId(to.id)!
    if (fromStore !== toStore) fail(`${tag}: endpoints span stores (${fromStore} vs ${toStore} — edges stay in one store)`)
    return {
      from: from.name ?? from.id,
      fromId: from.id,
      to: to.name ?? to.id,
      toId: to.id,
      store: fromStore,
      type,
    }
  })

  return { beads: resolved, relations: resolvedRelations }
}

export async function runBatch(input: BatchInput, fns: BatchFns = defaultBatchFns): Promise<BatchResult> {
  const { beads, relations } = validateBatch(input)
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

  const wireEdge = async (store: string, from: string, fromIdToken: string, to: string, toIdToken: string, type?: string) => {
    const fromId = resolveId(fromIdToken)
    const toId = resolveId(toIdToken)
    if (!fromId || !toId) {
      edges.push({ from, fromId: fromId ?? fromIdToken, to, toId: toId ?? toIdToken, store, type: type ?? 'blocks', ok: false, verified: false, detail: `skipped: ${!fromId ? from : to} did not land` })
      return
    }
    try {
      const detail = await fns.addEdge(store, fromId, toId, type)
      const verified = await fns.verifyEdge(store, fromId, toId)
      edges.push({ from, fromId, to, toId, store, type: type ?? 'blocks', ok: true, verified, detail: detail.slice(0, 300) })
    } catch (e) {
      edges.push({ from, fromId, to, toId, store, type: type ?? 'blocks', ok: false, verified: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  for (const b of beads) {
    if (!landed.has(b.name)) continue
    for (const d of b.deps) {
      await wireEdge(b.store, b.name, `<${b.name}>`, d.name ?? d.id, d.id)
    }
  }
  for (const r of relations) {
    await wireEdge(r.store, r.from, r.fromId, r.to, r.toId, r.type)
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
    `- ${e.from} (${e.fromId}) --${e.type}--> ${e.to} (${e.toId}) — ${e.ok ? (e.verified ? 'ok, verified' : 'ok, UNVERIFIED — re-check') : `FAILED: ${e.detail}`}`,
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
