// Self-retrieval primitives: federated full-text search, federated
// recent-activity, and bounded project-reconstruction snapshots.
//
// All store access is shell-free argv over execStdout (never a shell string)
// with bounded fan-out via mapLimit. Reads only — no mutations here.
// Pure builders/parsers/formatters stay subprocess-free for unit tests.
import { execStdout, beadText, mapLimit } from './exec'
import { STORES, BASE } from '../config'
import { storeFromId, extractLinks } from '../util'
import { cleanLabel } from '../routes/query/params'
import { listArgs } from '../routes/query/store'
import { runList } from '../routes/query/store'

export interface RetrievalRow {
  store: string
  id: string
  title: string
  status?: string
  labels: string[]
  updatedAt?: string
  createdAt?: string
  commentCount?: number
  closeReason?: string
}

export interface StoreError {
  store: string
  error: string
}

export const RETRIEVAL_MAX_STORES = 10
export const RETRIEVAL_MAX_PER_STORE = 50
export const RETRIEVAL_MAX_LIMIT = 100

export function pickRetrievalStores(wanted?: string[]): { stores: string[]; unknown: string[] } {
  if (!wanted || !wanted.length) return { stores: [...STORES], unknown: [] }
  const unknown = wanted.filter((s) => !STORES.includes(s))
  const stores = [...new Set(wanted.filter((s) => STORES.includes(s)))].slice(0, RETRIEVAL_MAX_STORES)
  return { stores, unknown }
}

export function cleanLabels(labels?: string[]): string[] {
  return (labels ?? []).map(cleanLabel).filter((x): x is string => !!x).slice(0, 10)
}

export function clampLimit(v: unknown, def: number): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n)) return def
  return Math.min(RETRIEVAL_MAX_LIMIT, Math.max(1, Math.floor(n as number)))
}

// ---- row parsing (shared by search + activity) ----

export function parseRetrievalRows(stdout: string, store: string): RetrievalRow[] {
  let arr: unknown[]
  try {
    const d = JSON.parse(stdout || 'null')
    arr = Array.isArray(d) ? d : []
  } catch {
    return []
  }
  return arr
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      store,
      id: String(x.id ?? x.bead_id ?? '?'),
      title: String(x.title ?? '').slice(0, 160),
      status: typeof x.status === 'string' ? x.status : undefined,
      labels: Array.isArray(x.labels) ? (x.labels as unknown[]).map(String) : [],
      updatedAt: typeof x.updated_at === 'string' ? x.updated_at : undefined,
      createdAt: typeof x.created_at === 'string' ? x.created_at : undefined,
      commentCount: typeof x.comment_count === 'number' ? x.comment_count : undefined,
      closeReason: typeof x.close_reason === 'string' ? x.close_reason.slice(0, 160) : undefined,
    }))
    .filter((x) => x.id !== '?')
}

// ---- 1. federated full-text search ----

export interface SearchOpts {
  stores?: string[]
  status?: string
  labels?: string[]
  perStore?: number
  limit?: number
}

// Blank query falls back to list-all (store discovery), mirroring query_store.
export function searchArgs(query: string, opts: { status?: string; labels?: string[]; perStore: number }): string[] {
  const q = query.trim()
  if (!q) {
    return listArgs([], [], {
      exclude: [],
      status: opts.status,
      limit: opts.perStore,
      allStates: !opts.status,
    })
  }
  const args = ['search', q, '--json', '--limit', String(opts.perStore)]
  for (const l of opts.labels ?? []) args.push('--label', l)
  args.push('--status', opts.status ?? 'all')
  return args
}

export async function federatedSearch(
  query: string,
  opts: SearchOpts = {},
): Promise<{ rows: RetrievalRow[]; errors: StoreError[]; stores: string[]; unknownStores: string[] }> {
  const { stores, unknown } = pickRetrievalStores(opts.stores)
  const labels = cleanLabels(opts.labels)
  const perStore = Math.min(RETRIEVAL_MAX_PER_STORE, Math.max(1, opts.perStore ?? 20))
  const limit = Math.min(RETRIEVAL_MAX_LIMIT, Math.max(1, opts.limit ?? 30))
  const status = opts.status?.trim().slice(0, 64) || undefined
  const args = searchArgs(query, { status, labels, perStore })
  const per = await mapLimit(stores, 6, async (store): Promise<{ rows: RetrievalRow[]; error?: string }> => {
    try {
      return { rows: parseRetrievalRows(await execStdout(store, args, 15000), store) }
    } catch (e) {
      return { rows: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }
    }
  })
  const rows: RetrievalRow[] = []
  const errors: StoreError[] = []
  per.forEach((r, i) => {
    rows.push(...r.rows)
    if (r.error) errors.push({ store: stores[i], error: r.error })
  })
  return { rows: rows.slice(0, limit), errors, stores, unknownStores: unknown }
}

export function formatSearch(
  query: string,
  rows: RetrievalRow[],
  errors: StoreError[],
  stores: string[],
  unknownStores: string[] = [],
): string {
  const lines = [
    `# federated search — "${query.trim() || '(all)'}" (${rows.length} across ${stores.length} stores)`,
    ``,
  ]
  if (!rows.length) {
    lines.push(`No beads matched — widen the query or drop filters.`, ``)
  }
  for (const r of rows) {
    lines.push(
      `- ${r.id} [${r.store}] — ${r.title}${r.status ? ` [${r.status}]` : ''}${r.labels.length ? ` (${r.labels.slice(0, 4).join(', ')})` : ''}`,
    )
  }
  if (unknownStores.length) lines.push(``, `Skipped unknown stores: ${unknownStores.join(', ')}`)
  for (const e of errors) lines.push(``, `error [${e.store}]: ${e.error}`)
  return lines.join('\n')
}

// ---- 2. federated recent-activity ----

export interface ActivityOpts {
  stores?: string[]
  limit?: number
  status?: string
  labels?: string[]
  since?: string
}

export function activityArgs(opts: { limit: number; status?: string; labels?: string[]; since?: string }): string[] {
  const args = ['list', '--json', '--limit', String(opts.limit), '--sort', 'updated']
  for (const l of opts.labels ?? []) args.push('--label', l)
  if (opts.status) args.push('--status', opts.status)
  else args.push('--all')
  if (opts.since) args.push('--updated-after', opts.since)
  return args
}

// Globally newest-first; rows without timestamps sort last, stable by id.
export function mergeByUpdated(lists: RetrievalRow[][]): RetrievalRow[] {
  const key = (r: RetrievalRow): string => r.updatedAt ?? r.createdAt ?? ''
  return lists
    .flat()
    .sort((a, b) => (key(b) < key(a) ? -1 : key(b) > key(a) ? 1 : a.id < b.id ? -1 : 1))
}

export async function recentActivity(
  opts: ActivityOpts = {},
): Promise<{ rows: RetrievalRow[]; errors: StoreError[]; stores: string[]; unknownStores: string[] }> {
  const { stores, unknown } = pickRetrievalStores(opts.stores)
  const labels = cleanLabels(opts.labels)
  const limit = clampLimit(opts.limit, 20)
  const status = opts.status?.trim().slice(0, 64) || undefined
  const since = opts.since?.trim().slice(0, 64) || undefined
  const perStore = Math.min(RETRIEVAL_MAX_PER_STORE, Math.max(limit, 10))
  const args = activityArgs({ limit: perStore, status, labels, since })
  const per = await mapLimit(stores, 6, async (store): Promise<{ rows: RetrievalRow[]; error?: string }> => {
    try {
      return { rows: parseRetrievalRows(await execStdout(store, args, 15000), store) }
    } catch (e) {
      return { rows: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }
    }
  })
  const errors: StoreError[] = []
  const lists = per.map((r, i) => {
    if (r.error) errors.push({ store: stores[i], error: r.error })
    return r.rows
  })
  return { rows: mergeByUpdated(lists).slice(0, limit), errors, stores, unknownStores: unknown }
}

// Compact change info: last history entries collapsed to one line.
// Null when the bead has no history (or history is unreachable).
export async function historyLine(store: string, id: string, maxEntries = 3): Promise<string | null> {
  let out: string
  try {
    out = await execStdout(store, ['history', id, '--limit', String(Math.max(1, Math.min(10, maxEntries)))], 12000)
  } catch {
    return null
  }
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const body = (lines[0].startsWith('📜') ? lines.slice(1) : lines).join(' | ').replace(/\s+/g, ' ')
  return body.slice(0, 240) || null
}

export async function attachHistory(rows: RetrievalRow[], maxEntries = 2): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await mapLimit(rows, 6, async (r) => {
    const line = await historyLine(r.store, r.id, maxEntries)
    if (line) out.set(r.id, line)
  })
  return out
}

export function formatActivity(
  rows: RetrievalRow[],
  errors: StoreError[],
  stores: string[],
  unknownStores: string[] = [],
  history?: Map<string, string>,
): string {
  const lines = [`# recent activity — newest first (${rows.length} across ${stores.length} stores)`, ``]
  if (!rows.length) lines.push(`No activity in scope — widen stores, limit, or filters.`, ``)
  for (const r of rows) {
    lines.push(
      `- ${r.id} [${r.store}] — ${r.title}${r.status ? ` [${r.status}]` : ''}${r.updatedAt ? ` (updated ${r.updatedAt})` : ''}${r.closeReason ? ` (receipt: ${r.closeReason})` : ''}`,
    )
    const h = history?.get(r.id)
    if (h) lines.push(`  change: ${h}`)
  }
  if (unknownStores.length) lines.push(``, `Skipped unknown stores: ${unknownStores.join(', ')}`)
  for (const e of errors) lines.push(``, `error [${e.store}]: ${e.error}`)
  return lines.join('\n')
}

// ---- 3. bounded reconstruction snapshot ----

export const SNAPSHOT_DEFAULT_DEPTH = 2
export const SNAPSHOT_MAX_DEPTH = 4
export const SNAPSHOT_DEFAULT_CAP = 60
export const SNAPSHOT_MAX_CAP = 200

export interface SnapshotNode extends RetrievalRow {
  depth: number
  via: string
}

export interface Snapshot {
  root: string
  alternatives?: string[]
  beads: SnapshotNode[]
  truncated: boolean
  error?: string
}

export interface NeighborSet {
  meta: RetrievalRow
  neighbors: { id: string; via: string }[]
}

export type NeighborFetcher = (id: string) => Promise<NeighborSet | null>

// Deterministic BFS: depth cap + bead cap, visited dedupe, stable order.
// Pure over the injected fetcher — unit-testable without stores.
export async function walkGraph(
  rootId: string,
  fetch: NeighborFetcher,
  maxDepth: number,
  maxBeads: number,
): Promise<{ nodes: SnapshotNode[]; truncated: boolean }> {
  const seen = new Set<string>([rootId])
  const nodes: SnapshotNode[] = []
  let truncated = false
  let frontier: { id: string; depth: number; via: string }[] = [{ id: rootId, depth: 0, via: 'root' }]
  while (frontier.length) {
    const next: { id: string; depth: number; via: string }[] = []
    for (const { id, depth, via } of frontier) {
      if (nodes.length >= maxBeads) {
        truncated = true
        return { nodes, truncated }
      }
      let set: NeighborSet | null = null
      try {
        set = await fetch(id)
      } catch {
        set = null
      }
      if (!set) continue
      nodes.push({ ...set.meta, depth, via })
      if (depth < maxDepth) {
        for (const n of set.neighbors) {
          if (seen.has(n.id)) continue
          seen.add(n.id)
          // Queue cap: nodes already emitted + nodes queued. The
          // nodes.length check at the top of the loop still enforces the
          // hard cap, so already-queued beads are visited while room lasts.
          // (Do NOT break the frontier loop here: a truncation flagged while
          // expanding one bead must not skip other queued beads under cap.)
          if (nodes.length + next.length >= maxBeads) {
            truncated = true
            break
          }
          next.push({ id: n.id, depth: depth + 1, via: n.via })
        }
      }
    }
    frontier = next
  }
  return { nodes, truncated }
}

async function showRow(store: string, id: string): Promise<RetrievalRow | null> {
  try {
    const out = await execStdout(store, ['show', id, '--json'], 12000)
    const d = JSON.parse(out || 'null')
    const row = (Array.isArray(d) ? d[0] : d) as Record<string, unknown> | null
    if (!row || typeof row !== 'object') return null
    const [parsed] = parseRetrievalRows(JSON.stringify([row]), store)
    return parsed ?? null
  } catch {
    return null
  }
}

async function depEdges(store: string, id: string, direction: 'down' | 'up'): Promise<{ id: string; via: string }[]> {
  try {
    const out = await execStdout(store, ['dep', 'list', id, `--direction=${direction}`, '--json'], 12000)
    const arr: unknown = JSON.parse(out || '[]')
    if (!Array.isArray(arr)) return []
    const out2: { id: string; via: string }[] = []
    for (const r of arr) {
      if (typeof r !== 'object' || r === null) continue
      const rec = r as Record<string, unknown>
      if (typeof rec.id !== 'string' || !rec.id || rec.id === id) continue
      out2.push({
        id: rec.id,
        via: typeof rec.dependency_type === 'string' && rec.dependency_type
          ? rec.dependency_type
          : direction === 'down' ? 'depends-on' : 'depended-on-by',
      })
    }
    return out2
  } catch {
    return []
  }
}

function mentionedIn(store: string, id: string, text: string): string[] {
  const out: string[] = []
  for (const link of extractLinks(text)) {
    if (!link.startsWith(`${BASE}/`)) continue
    for (const part of link.slice(BASE.length + 1).split(/[+/?&]/)) {
      const clean = part.trim()
      if (clean && clean !== id && storeFromId(clean) && !out.includes(clean)) out.push(clean)
    }
    if (out.length >= 20) break
  }
  return out
}

// Live neighbor fetcher: parent/child/dependency/mentioned/project edges.
export async function snapshotNeighbors(id: string): Promise<NeighborSet | null> {
  const store = storeFromId(id)
  if (!store) return null
  const [meta, down, up, text] = await Promise.all([
    showRow(store, id),
    depEdges(store, id, 'down'),
    depEdges(store, id, 'up'),
    beadText(store, ['show', id]).then((body) =>
      beadText(store, ['comments', id]).then((c) => (c ? `${body}\n\n${c}` : body)),
    ),
  ])
  if (!meta) return null
  const neighbors: { id: string; via: string }[] = [...down, ...up]
  // Children: explicit --parent listing plus dotted-suffix dependents.
  try {
    const out = await execStdout(store, ['list', '--json', '--limit', '50', '--parent', id], 12000)
    for (const r of parseRetrievalRows(out, store)) {
      if (r.id !== id) neighbors.push({ id: r.id, via: 'child' })
    }
  } catch { /* children are best-effort */ }
  for (const c of up) {
    if (c.via === 'parent-child' && c.id.startsWith(`${id}.`)) {
      neighbors.push({ id: c.id, via: 'child' })
    }
  }
  // Dotted suffix → parent edge (child → parent upward).
  const pm = id.match(/^(.+)\.\d+$/)
  if (pm && storeFromId(pm[1])) neighbors.push({ id: pm[1], via: 'parent' })
  // Same project: project: labels join beads across task/stories + own store.
  const projectLabels = meta.labels.filter((l) => l.startsWith('project:')).slice(0, 3)
  const searchStores = [...new Set([store, 'task', 'stories'])].filter((s) => STORES.includes(s)).slice(0, 3)
  for (const label of projectLabels) {
    for (const s of searchStores) {
      const { rows } = runList(s, [label], [], { exclude: [], status: undefined, limit: 8, allStates: true })
      for (const r of rows) {
        if (r.id !== id) neighbors.push({ id: r.id, via: `label:${label}` })
      }
      if (neighbors.length >= 60) break
    }
    if (neighbors.length >= 60) break
  }
  for (const m of mentionedIn(store, id, text)) neighbors.push({ id: m, via: 'mentioned' })
  // Dedupe neighbor edges, keep first via.
  const seen = new Set<string>()
  const deduped = neighbors.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
  return { meta, neighbors: deduped.slice(0, 60) }
}

export interface SnapshotOpts {
  depth?: number
  cap?: number
}

export async function reconstructSnapshot(input: string, opts: SnapshotOpts = {}): Promise<Snapshot> {
  const depth = Math.min(SNAPSHOT_MAX_DEPTH, Math.max(0, opts.depth ?? SNAPSHOT_DEFAULT_DEPTH))
  const cap = Math.min(SNAPSHOT_MAX_CAP, Math.max(1, opts.cap ?? SNAPSHOT_DEFAULT_CAP))
  const clean = input.trim()
  if (!clean) return { root: '', beads: [], truncated: false, error: 'Give a bead id or search phrase.' }
  let root = clean
  let alternatives: string[] | undefined
  if (!storeFromId(clean)) {
    // Search phrase in — top hit becomes the root.
    const { rows } = await federatedSearch(clean, { perStore: 5, limit: 5 })
    if (!rows.length) return { root: clean, beads: [], truncated: false, error: `No beads matched "${clean}" — nothing to reconstruct.` }
    root = rows[0].id
    alternatives = rows.slice(1).map((r) => r.id)
  } else {
    const store = storeFromId(clean)!
    const meta = await showRow(store, clean)
    if (!meta) return { root: clean, beads: [], truncated: false, error: `Bead not found: ${clean}` }
  }
  const { nodes, truncated } = await walkGraph(root, snapshotNeighbors, depth, cap)
  return { root, alternatives, beads: nodes, truncated }
}

export function formatSnapshot(snap: Snapshot): string {
  if (snap.error) return [`# reconstruction snapshot`, ``, snap.error].join('\n')
  const lines = [
    `# reconstruction snapshot — ${snap.root} (${snap.beads.length} beads${snap.truncated ? ', truncated at cap' : ''})`,
    ``,
  ]
  if (snap.alternatives?.length) lines.push(`Other matches for the phrase: ${snap.alternatives.join(', ')}`, ``)
  const byDepth = new Map<number, SnapshotNode[]>()
  for (const b of snap.beads) {
    const arr = byDepth.get(b.depth) ?? []
    arr.push(b)
    byDepth.set(b.depth, arr)
  }
  for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
    lines.push(`## depth ${d}`, ``)
    for (const b of byDepth.get(d)!) {
      lines.push(
        `- ${b.id} [${b.store}] — ${b.title}${b.status ? ` [${b.status}]` : ''}${b.updatedAt ? ` (updated ${b.updatedAt})` : ''} (via ${b.via})`,
      )
    }
    lines.push(``)
  }
  return lines.join('\n')
}
