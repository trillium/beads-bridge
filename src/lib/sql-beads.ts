// Bead READS over SQL (src/lib/sql.ts), shaped exactly like the `bd list
// --json` / `bd search --json` rows the bridge already parses, so every
// downstream parser, formatter and tool output stays unchanged.
//
// This is a faithful port of bd's read semantics (brain fork, see
// docs/sql-reads.md for the source-of-truth map):
//   - namespace scoping: a store's beads are the ids whose prefix the store
//     owns in `brain_store_prefixes` (`id LIKE '<prefix>-%'`), default prefix =
//     the store name; wisps are merged in after issues (their own tables);
//   - bd list: SQL order+LIMIT(+1), Go-side re-sort by --sort, then truncate;
//   - bd search: tokenised title/description/comment match, then (for free-text
//     queries with no --sort) Go-side relevance ranking over the FULL match set
//     and a post-rank limit.
// Anything this port cannot reproduce faithfully THROWS (SqlUnsupported) and
// the caller falls back to the bd subprocess path.
import { sqlQuery, type SqlParam, type SqlRow } from './sql'
import { keysetSql, orderBySql, type CursorVal, type OrderColumn } from './query-order'

export class SqlUnsupported extends Error {
  constructor(why: string) {
    super(`sql path unsupported: ${why}`)
    this.name = 'SqlUnsupported'
  }
}

/** A row shaped like one element of `bd list --json` (only fields the bridge reads). */
export interface BdRow {
  id: string
  title: string
  status?: string
  priority?: number
  labels?: string[]
  created_at?: string
  updated_at?: string
  started_at?: string
  closed_at?: string
  close_reason?: string
  assignee?: string
  comment_count: number
  description?: string
}

interface Tables {
  main: string
  labels: string
  comments: string
  deps: string
}
const ISSUES: Tables = { main: 'issues', labels: 'labels', comments: 'comments', deps: 'dependencies' }
const WISPS: Tables = { main: 'wisps', labels: 'wisp_labels', comments: 'wisp_comments', deps: 'wisp_dependencies' }

// bd: `gate` + domain.DefaultInfraTypes() (agent, role, message). A store that
// overrides `types.infra` is not modelled; the custom-status probe refuses when any store sets it.
export const LIST_EXCLUDED_TYPES = ['gate', 'agent', 'role', 'message']

export const BUILTIN_STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed', 'pinned', 'hooked']

// ---------------------------------------------------------------- store scope

interface Scope {
  prefixes: Map<string, string[]> // store -> owned id prefixes
  at: number
}
let scopeCache: Scope | null = null
const SCOPE_TTL_MS = 60_000

export function resetSqlScopeCache(): void {
  scopeCache = null
  customStatusProbe = null
}

async function loadScope(): Promise<Scope> {
  if (scopeCache && Date.now() - scopeCache.at < SCOPE_TTL_MS) return scopeCache
  const [pref, alias] = await Promise.all([
    sqlQuery('SELECT `prefix`, `store` FROM brain_store_prefixes ORDER BY `prefix`'),
    sqlQuery('SELECT `alias`, `store` FROM brain_store_aliases'),
  ])
  const byStore = new Map<string, string[]>()
  for (const r of pref) {
    const s = String(r.store)
    byStore.set(s, [...(byStore.get(s) ?? []), String(r.prefix)])
  }
  const aliases = new Map<string, string>()
  for (const r of alias) aliases.set(String(r.alias), String(r.store))
  const prefixes = new Map<string, string[]>()
  for (const [a, canonical] of aliases) if (!byStore.has(a)) prefixes.set(a, byStore.get(canonical) ?? [canonical])
  for (const [s, p] of byStore) prefixes.set(s, p)
  scopeCache = { prefixes, at: Date.now() }
  return scopeCache
}

/** id prefixes the store owns (bd's narrow namespace scope). Default: the store name. */
export async function storePrefixes(store: string): Promise<string[]> {
  const { prefixes } = await loadScope()
  const direct = prefixes.get(store)
  if (direct?.length) return direct
  return [store]
}

// Custom statuses/types change list defaults and validation; this port only
// handles the built-in set, so refuse (-> bd) when any store defines custom ones.
let customStatusProbe: Promise<boolean> | null = null
async function assertNoCustomStatuses(): Promise<void> {
  customStatusProbe ??= (async () => {
    const [a, b] = await Promise.all([
      sqlQuery('SELECT COUNT(*) AS c FROM brain_unified_custom_statuses'),
      sqlQuery("SELECT COUNT(*) AS c FROM brain_unified_config WHERE `key` IN ('status.custom', 'types.infra')"),
    ])
    return Number(a[0]?.c ?? 0) + Number(b[0]?.c ?? 0) === 0
  })()
  let ok: boolean
  try {
    ok = await customStatusProbe
  } catch (e) {
    customStatusProbe = null
    throw e
  }
  if (!ok) throw new SqlUnsupported('custom statuses are configured')
}

// ---------------------------------------------------------------- filters

export interface BeadFilter {
  /** bd search free text (title/description/comments tokens, or id-ish). */
  query?: string
  searchComments?: boolean
  status?: string
  excludeStatus?: string[]
  /** bd list defaults: gate + infra types (agent/role/message), pinned, templates. */
  excludeTypes?: string[]
  notPinned?: boolean
  notTemplate?: boolean
  labels?: string[]
  labelsAny?: string[]
  excludeLabels?: string[]
  titleContains?: string
  descContains?: string
  notesContains?: string
  /** UTC `YYYY-MM-DD HH:MM:SS` lower bound (exclusive) on updated_at. */
  updatedAfter?: string
  /** UTC `YYYY-MM-DD HH:MM:SS` upper bound (exclusive) on updated_at. */
  updatedBefore?: string
  /** Exclusive bounds on created_at, same clock form as updatedAfter. */
  createdAfter?: string
  createdBefore?: string
  /** Keyset page: sort columns plus the last row's values. */
  keyset?: { columns: OrderColumn[]; values: CursorVal[] }
  /** bd --parent: children by parent-child edge or dotted-id convention. */
  parentId?: string
  ids?: string[]
}

const DEP_TARGET = 'COALESCE(depends_on_issue_id, depends_on_wisp_id, depends_on_external)'

export function normalizeLabels(ss: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of ss ?? []) {
    const t = s.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

export function searchTokens(query: string): string[] {
  const fields = query.toLowerCase().split(/\s+/).filter(Boolean)
  return [...new Set(fields)]
}

export function looksLikeIssueId(q: string): boolean {
  const idx = q.indexOf('-')
  if (idx <= 0 || idx >= q.length - 1) return false
  if (q.includes(' ')) return false
  return /^[0-9A-Za-z.-]+$/.test(q)
}

function likeEsc(s: string): string {
  return s // bd does NOT escape LIKE metacharacters; neither do we (parity)
}

function buildWhere(f: BeadFilter, t: Tables): { sql: string[]; args: SqlParam[] } {
  const sql: string[] = []
  const args: SqlParam[] = []
  if (f.query) {
    const lower = f.query.toLowerCase()
    const probe: string[] = []
    const probeArgs: SqlParam[] = []
    if (f.searchComments) {
      const toks = searchTokens(f.query)
      for (const tok of toks.length ? toks : [lower]) {
        probe.push(`EXISTS (SELECT 1 FROM ${t.comments} bd_cmt WHERE bd_cmt.issue_id = ${t.main}.id AND LOWER(bd_cmt.text) LIKE ?)`)
        probeArgs.push(`%${tok}%`)
      }
    }
    if (looksLikeIssueId(f.query)) {
      sql.push(`(id = ? OR id LIKE ? OR LOWER(title) LIKE ? OR LOWER(external_ref) LIKE ?${probe.map((p) => ` OR ${p}`).join('')})`)
      args.push(lower, `${lower}%`, `%${lower}%`, `%${lower}%`, ...probeArgs)
    } else {
      const toks = searchTokens(f.query)
      const parts: string[] = []
      if (!toks.length) {
        parts.push('LOWER(title) LIKE ?', 'LOWER(description) LIKE ?')
        args.push(`%${lower}%`, `%${lower}%`)
      } else {
        for (const tok of toks) {
          parts.push('LOWER(title) LIKE ?', 'LOWER(description) LIKE ?')
          args.push(`%${tok}%`, `%${tok}%`)
        }
      }
      parts.push(...probe)
      args.push(...probeArgs)
      parts.push('id LIKE ?')
      args.push(`%${lower}%`)
      sql.push(`(${parts.join(' OR ')})`)
    }
  }
  if (f.titleContains) { sql.push('LOWER(title) LIKE ?'); args.push(`%${f.titleContains.toLowerCase()}%`) }
  if (f.descContains) { sql.push('LOWER(description) LIKE ?'); args.push(`%${f.descContains.toLowerCase()}%`) }
  if (f.notesContains) { sql.push('LOWER(notes) LIKE ?'); args.push(`%${f.notesContains.toLowerCase()}%`) }
  if (f.status) { sql.push('status = ?'); args.push(f.status) }
  if (f.excludeStatus?.length) {
    sql.push(`status NOT IN (${f.excludeStatus.map(() => '?').join(',')})`)
    args.push(...f.excludeStatus)
  }
  if (f.excludeTypes?.length) {
    sql.push(`issue_type NOT IN (${f.excludeTypes.map(() => '?').join(',')})`)
    args.push(...f.excludeTypes)
  }
  if (f.notPinned) sql.push('(pinned = 0 OR pinned IS NULL)')
  if (f.notTemplate) sql.push('(is_template = 0 OR is_template IS NULL)')
  if (f.ids?.length) {
    sql.push(`id IN (${f.ids.map(() => '?').join(', ')})`)
    args.push(...f.ids)
  }
  if (f.parentId) {
    sql.push(
      `(id IN (SELECT issue_id FROM ${t.deps} WHERE type = 'parent-child' AND ${DEP_TARGET} = ?) OR (id LIKE CONCAT(?, '.%') AND id NOT IN (SELECT issue_id FROM ${t.deps} WHERE type = 'parent-child')))`,
    )
    args.push(f.parentId, f.parentId)
  }
  for (const l of f.labels ?? []) {
    sql.push(`id IN (SELECT issue_id FROM ${t.labels} WHERE label = ?)`)
    args.push(l)
  }
  if (f.labelsAny?.length) {
    sql.push(`id IN (SELECT issue_id FROM ${t.labels} WHERE label IN (${f.labelsAny.map(() => '?').join(', ')}))`)
    args.push(...f.labelsAny)
  }
  if (f.excludeLabels?.length) {
    sql.push(`id NOT IN (SELECT issue_id FROM ${t.labels} WHERE label IN (${f.excludeLabels.map(() => '?').join(', ')}))`)
    args.push(...f.excludeLabels)
  }
  if (f.createdAfter) { sql.push('created_at > ?'); args.push(f.createdAfter) }
  if (f.createdBefore) { sql.push('created_at < ?'); args.push(f.createdBefore) }
  if (f.updatedAfter) { sql.push('updated_at > ?'); args.push(f.updatedAfter) }
  if (f.updatedBefore) { sql.push('updated_at < ?'); args.push(f.updatedBefore) }
  if (f.keyset) {
    const k = keysetSql(f.keyset.columns, f.keyset.values)
    sql.push(k.sql)
    args.push(...k.args)
  }
  return { sql, args }
}

/** bd accepts many time forms; only RFC3339-UTC / bare UTC datetimes are reproduced. */
export function sinceToSqlUtc(since: string): string {
  const s = since.trim()
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})Z$/.exec(s)
  if (m) return `${m[1]} ${m[2]}`
  throw new SqlUnsupported(`time expression "${s.slice(0, 40)}" (only RFC3339 UTC is ported)`)
}

// ---------------------------------------------------------------- ordering

export type SortKey = '' | 'updated' | 'created'

function orderSql(sort: SortKey): string {
  if (sort === 'updated') return 'ORDER BY updated_at DESC, id ASC'
  if (sort === 'created') return 'ORDER BY created_at DESC, id ASC'
  return 'ORDER BY priority ASC, created_at DESC, id ASC'
}

const FMT = (c: string, a: string): string => `DATE_FORMAT(${c}, '%Y-%m-%dT%H:%i:%sZ') AS ${a}`

function selectCols(t: Tables, withDescription: boolean): string {
  return [
    `${t.main}.id AS id`,
    'title',
    'status',
    'priority',
    "COALESCE(assignee, '') AS assignee",
    "COALESCE(close_reason, '') AS close_reason",
    withDescription ? "COALESCE(description, '') AS description" : "'' AS description",
    FMT('created_at', 's_created'),
    FMT('updated_at', 's_updated'),
    FMT('started_at', 's_started'),
    FMT('closed_at', 's_closed'),
  ].join(', ')
}

// ---------------------------------------------------------------- queries

export interface SweepSpec {
  filter: BeadFilter
  sort: SortKey
  /** When set, replaces the bd sort key. Columns are an allowlist, never caller text. */
  order?: OrderColumn[]
  /** SQL LIMIT per store per table; 0 = unlimited (search ranking path). */
  sqlLimit: number
  withDescription?: boolean
  /** bd search merges the wisps table; bd list skips it (SkipWisps, list_filter.go) unless --include-infra. */
  wisps: boolean
}

interface RawRow extends BdRow {
  _store: string
  _wisp: boolean
  _updated?: string
  _created?: string
}

// UNION ALL of parenthesised SELECTs. Dolt rejects a lone `(SELECT ... LIMIT n)`
// (syntax error), so a single part is emitted without its parentheses.
export function unionAll(parts: string[]): string {
  return parts.length === 1 ? parts[0].replace(/^\(([\s\S]*)\)$/, '$1') : parts.join(' UNION ALL ')
}

// One statement for all stores: per store, an issues subquery and a wisps
// subquery (ORDER BY/LIMIT inside each), UNION ALL'd.
async function sweepRaw(stores: string[], spec: SweepSpec): Promise<RawRow[]> {
  if (!stores.length) return []
  const parts: string[] = []
  const params: SqlParam[] = []
  for (const store of stores) {
    const prefixes = await storePrefixes(store)
    for (const [t, isWisp] of spec.wisps ? ([[ISSUES, 0], [WISPS, 1]] as const) : ([[ISSUES, 0]] as const)) {
      const w = buildWhere(spec.filter, t)
      const ns = `(${prefixes.map(() => 'id LIKE ?').join(' OR ')})`
      const where = [ns, ...w.sql].join(' AND ')
      const limit = spec.sqlLimit > 0 ? ` LIMIT ${Math.floor(spec.sqlLimit)}` : ''
      const ordering = spec.order?.length ? orderBySql(spec.order) : orderSql(spec.sort)
      parts.push(
        `(SELECT ${selectCols(t, !!spec.withDescription)}, ? AS _store, ${isWisp} AS _wisp FROM ${t.main} WHERE ${where} ${ordering}${limit})`,
      )
      params.push(store, ...prefixes.map((p) => `${p.replace(/-$/, '')}-%`), ...w.args)
    }
  }
  const rows = await sqlQuery(unionAll(parts), params)
  return rows.map(toRaw)
}

function toRaw(r: SqlRow): RawRow {
  const o: RawRow = {
    id: String(r.id),
    title: String(r.title ?? ''),
    status: r.status == null ? undefined : String(r.status),
    priority: r.priority == null ? undefined : Number(r.priority),
    comment_count: 0,
    _store: String(r._store),
    _wisp: Number(r._wisp) === 1,
  }
  const set = (k: 'created_at' | 'updated_at' | 'started_at' | 'closed_at', v: unknown): void => {
    if (typeof v === 'string' && v) o[k] = v
  }
  set('created_at', r.s_created)
  set('updated_at', r.s_updated)
  set('started_at', r.s_started)
  set('closed_at', r.s_closed)
  if (r.assignee) o.assignee = String(r.assignee)
  if (r.close_reason) o.close_reason = String(r.close_reason)
  if (r.description) o.description = String(r.description)
  return o
}

// labels + comment counts for the FINAL row set only (bd hydrates after LIMIT).
async function hydrate(rows: RawRow[]): Promise<void> {
  if (!rows.length) return
  const issueIds = rows.filter((r) => !r._wisp).map((r) => r.id)
  const wispIds = rows.filter((r) => r._wisp).map((r) => r.id)
  const run = async (ids: string[], t: Tables): Promise<[SqlRow[], SqlRow[]]> => {
    if (!ids.length) return [[], []]
    const ph = ids.map(() => '?').join(',')
    return Promise.all([
      sqlQuery(`SELECT issue_id, label FROM ${t.labels} WHERE issue_id IN (${ph}) ORDER BY issue_id, label`, ids),
      sqlQuery(`SELECT issue_id, COUNT(*) AS c FROM ${t.comments} WHERE issue_id IN (${ph}) GROUP BY issue_id`, ids),
    ])
  }
  const [[il, ic], [wl, wc]] = await Promise.all([run(issueIds, ISSUES), run(wispIds, WISPS)])
  const labels = new Map<string, string[]>()
  const counts = new Map<string, number>()
  for (const [src, tag] of [[il, 'i'], [wl, 'w']] as const) {
    for (const r of src) {
      const k = `${tag}:${r.issue_id}`
      labels.set(k, [...(labels.get(k) ?? []), String(r.label)])
    }
  }
  for (const [src, tag] of [[ic, 'i'], [wc, 'w']] as const) {
    for (const r of src) counts.set(`${tag}:${r.issue_id}`, Number(r.c))
  }
  for (const r of rows) {
    const k = `${r._wisp ? 'w' : 'i'}:${r.id}`
    const l = labels.get(k)
    if (l?.length) r.labels = l
    r.comment_count = counts.get(k) ?? 0
  }
}

function strip(r: RawRow): BdRow {
  const { _store, _wisp, _updated, _created, ...rest } = r
  void _store; void _wisp; void _updated; void _created
  return rest
}

// bd merges wisps AFTER issues; an id present in both prefers the wisp.
function mergeWisps(rows: RawRow[]): RawRow[] {
  const wispIds = new Set(rows.filter((r) => r._wisp).map((r) => r.id))
  const issues = rows.filter((r) => !r._wisp && !wispIds.has(r.id))
  return [...issues, ...rows.filter((r) => r._wisp)]
}

// Go slices.SortFunc by updated/created (descending); '' = no re-sort.
function goSort(rows: RawRow[], sort: SortKey): RawRow[] {
  if (!sort) return rows
  const key = (r: RawRow): string => (sort === 'updated' ? r.updated_at : r.created_at) ?? ''
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (key(a.r) < key(b.r) ? 1 : key(a.r) > key(b.r) ? -1 : a.i - b.i))
    .map((x) => x.r)
}

function group(rows: RawRow[]): Map<string, RawRow[]> {
  const m = new Map<string, RawRow[]>()
  for (const r of rows) m.set(r._store, [...(m.get(r._store) ?? []), r])
  return m
}

export interface ListSweepOpts {
  limit: number
  sort?: SortKey
  labels?: string[]
  labelsAny?: string[]
  excludeLabels?: string[]
  titleContains?: string
  descContains?: string
  notesContains?: string
  status?: string
  /** bd list --all (no default closed/pinned exclusion). */
  allStates?: boolean
  since?: string
  parentId?: string
  /** Explicit order. When set, the bd `--sort` key is not re-applied in memory. */
  order?: OrderColumn[]
  /** Keyset values aligned with `order`. */
  cursor?: CursorVal[]
  createdAfter?: string
  createdBefore?: string
  /** Exclusive upper bound. `since` / `updatedAfter` remain the lower bound. */
  updatedBefore?: string
  /** When set, wins over `since` (already normalized UTC). */
  updatedAfter?: string
}

// The BeadFilter `bd list` builds from its flags (list_filter.go defaults included).
function listFilter(o: ListSweepOpts): BeadFilter {
  const status = o.status?.trim()
  if (status && status !== 'all' && !BUILTIN_STATUSES.includes(status)) {
    throw new SqlUnsupported(`status "${status.slice(0, 40)}" (list validates against configured statuses)`)
  }
  const filter: BeadFilter = {
    labels: normalizeLabels(o.labels),
    labelsAny: normalizeLabels(o.labelsAny),
    excludeLabels: normalizeLabels(o.excludeLabels),
    titleContains: o.titleContains,
    descContains: o.descContains,
    notesContains: o.notesContains,
    parentId: o.parentId,
    updatedAfter: o.updatedAfter ?? (o.since ? sinceToSqlUtc(o.since) : undefined),
    updatedBefore: o.updatedBefore,
    createdAfter: o.createdAfter,
    createdBefore: o.createdBefore,
    keyset: o.order?.length && o.cursor?.length ? { columns: o.order, values: o.cursor } : undefined,
    // bd list (cmd/bd/list_filter.go) always hides gates + infra types + templates,
    // and hides pinned unless --all or --status pinned|hooked.
    excludeTypes: LIST_EXCLUDED_TYPES,
    notTemplate: true,
    notPinned: !(o.allStates || status === 'pinned' || status === 'hooked'),
  }
  if (status && status !== 'all') filter.status = status
  else if (!status && !o.allStates) filter.excludeStatus = ['closed', 'pinned']
  return filter
}

/**
 * `bd list --json --limit N [--sort S] ...` for MANY stores in one round trip
 * (+1 for hydration). Rows come back per store, in bd's output order.
 */
export async function sqlListSweep(stores: string[], o: ListSweepOpts): Promise<Map<string, BdRow[]>> {
  await assertNoCustomStatuses()
  // A caller-supplied order is already the SQL ORDER BY. goSort would
  // re-rank by one column and drop the id/priority tie-break.
  const sort = o.order?.length ? '' : (o.sort ?? '')
  const filter = listFilter(o)
  const raw = await sweepRaw(stores, { filter, sort, order: o.order, sqlLimit: o.limit + 1, wisps: false })
  const per = group(raw)
  const finalByStore = new Map<string, RawRow[]>()
  const all: RawRow[] = []
  for (const s of stores) {
    let rows = goSort(mergeWisps(per.get(s) ?? []), sort)
    if (o.limit > 0 && rows.length > o.limit) rows = rows.slice(0, o.limit)
    finalByStore.set(s, rows)
    all.push(...rows)
  }
  await hydrate(all)
  return new Map(stores.map((s) => [s, (finalByStore.get(s) ?? []).map(strip)]))
}

// ---- bd search relevance (cmd/bd/search_rank.go), ported verbatim ----

const SCORE = { phraseTitle: 1000, phraseDesc: 400, allTitle: 300, allCombined: 150, tokTitle: 40, tokDesc: 10, bTitle: 5, bDesc: 2 }

function isWordByte(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)
}

function wordBoundaryHit(hay: string, tok: string): boolean {
  if (!tok) return false
  // Go indexes BYTES; compare on UTF-8 bytes so boundaries match.
  const h = Buffer.from(hay, 'utf8')
  const t = Buffer.from(tok, 'utf8')
  let from = 0
  for (;;) {
    const i = h.indexOf(t, from)
    if (i < 0) return false
    if (i === 0 || !isWordByte(h[i - 1])) return true
    from = i + 1
    if (from >= h.length) return false
  }
}

export function scoreIssue(title0: string, desc0: string, tokens: string[], raw: string): number {
  const title = title0.toLowerCase()
  const desc = desc0.toLowerCase()
  const combined = `${title}\n${desc}`
  let score = 0
  if (raw) {
    if (title.includes(raw)) score += SCORE.phraseTitle
    if (desc.includes(raw)) score += SCORE.phraseDesc
  }
  if (tokens.length) {
    const allTitle = tokens.every((t) => title.includes(t))
    const allCombined = tokens.every((t) => combined.includes(t))
    if (allTitle) score += SCORE.allTitle
    else if (allCombined) score += SCORE.allCombined
  }
  for (const tok of tokens) {
    if (title.includes(tok)) {
      score += SCORE.tokTitle
      if (wordBoundaryHit(title, tok)) score += SCORE.bTitle
    }
    if (desc.includes(tok)) {
      score += SCORE.tokDesc
      if (wordBoundaryHit(desc, tok)) score += SCORE.bDesc
    }
  }
  return score
}

export function rankSearch<T extends { id: string; title: string; description?: string }>(rows: T[], query: string): T[] {
  if (rows.length < 2) return rows
  const tokens = searchTokens(query)
  const raw = query.trim().toLowerCase()
  const scored = rows.map((r) => ({ r, s: scoreIssue(r.title, r.description ?? '', tokens, raw) }))
  scored.sort((a, b) => (a.s !== b.s ? b.s - a.s : a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0))
  return scored.map((x) => x.r)
}

/** Max matches per store+table pulled for relevance ranking before deferring to bd. */
export const RANK_CAP = 1500

export interface SearchSweepOpts {
  limit: number
  status?: string
  labels?: string[]
  createdAfter?: string
  createdBefore?: string
  updatedAfter?: string
  updatedBefore?: string
}

/** `bd search <q> --json --limit N [--label L]... --status S` for many stores in one round trip. */
export async function sqlSearchSweep(stores: string[], query: string, o: SearchSweepOpts): Promise<Map<string, BdRow[]>> {
  await assertNoCustomStatuses()
  const status = (o.status ?? 'all').trim()
  const filter: BeadFilter = {
    query,
    searchComments: true,
    labels: normalizeLabels(o.labels),
    createdAfter: o.createdAfter,
    createdBefore: o.createdBefore,
    updatedAfter: o.updatedAfter,
    updatedBefore: o.updatedBefore,
  }
  if (status && status !== 'all') filter.status = status
  else if (status !== 'all') filter.excludeStatus = ['closed']
  const rank = !looksLikeIssueId(query)
  const raw = await sweepRaw(stores, {
    filter,
    sort: '',
    sqlLimit: rank ? RANK_CAP + 1 : o.limit,
    withDescription: rank,
    wisps: true,
  })
  if (rank) {
    // bd ranks the FULL match set before limiting; if a store has more matches
    // than we are willing to pull, the exact ranking is not reproducible here.
    const seen = new Map<string, number>()
    for (const r of raw) {
      const k = `${r._store}:${r._wisp}`
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    for (const n of seen.values()) if (n > RANK_CAP) throw new SqlUnsupported(`more than ${RANK_CAP} matches in one store (ranking needs the full set)`)
  }
  const per = group(raw)
  const finalByStore = new Map<string, RawRow[]>()
  const all: RawRow[] = []
  for (const s of stores) {
    let rows = mergeWisps(per.get(s) ?? [])
    if (rank) {
      rows = rankSearch(rows, query)
      if (o.limit > 0 && rows.length > o.limit) rows = rows.slice(0, o.limit)
    }
    finalByStore.set(s, rows)
    all.push(...rows)
  }
  await hydrate(all)
  // description was only needed for scoring; bd's JSON carries it, the bridge ignores it.
  return new Map(stores.map((s) => [s, (finalByStore.get(s) ?? []).map((r) => { const o2 = strip(r); delete o2.description; return o2 })]))
}

export const _internal = { buildWhere, likeEsc, orderSql, goSort, mergeWisps }

/**
 * Comment count per EXACT bead id (issues + wisps; a wisp row wins over an
 * issues row, as in bd). Ids that do not exist exactly are absent from the map.
 */
export async function sqlCommentCounts(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!ids.length) return out
  const ph = ids.map(() => '?').join(',')
  const [issueRows, wispRows] = await Promise.all([
    sqlQuery(`SELECT i.id AS id, (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS n FROM issues i WHERE i.id IN (${ph})`, ids),
    sqlQuery(`SELECT x.id AS id, (SELECT COUNT(*) FROM wisp_comments c WHERE c.issue_id = x.id) AS n FROM wisps x WHERE x.id IN (${ph})`, ids),
  ])
  const want = new Set(ids)
  for (const r of [...issueRows, ...wispRows]) {
    const id = String(r.id)
    if (want.has(id)) out.set(id, Number(r.n))
  }
  return out
}


// ---------------------------------------------------------------- graph batches
// One statement per BFS level instead of several bd spawns per bead.

const BATCH = 200
function chunks<T>(xs: T[], n = BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/**
 * `bd show <id> --json` rows (only the fields the bridge reads) for EXACT ids,
 * issues table first, a wisp row winning over an issues row. No namespace
 * scope and no list defaults: show resolves any id. Absent ids are absent.
 */
export async function sqlBeadsById(ids: string[]): Promise<Map<string, BdRow>> {
  const out = new Map<string, BdRow>()
  const uniq = [...new Set(ids)]
  if (!uniq.length) return out
  const raws: RawRow[] = []
  for (const part of chunks(uniq)) {
    const ph = part.map(() => '?').join(',')
    // Two statements, not UNION ALL: Dolt plans `UNION ALL ... IN (...)` as a scan (1.4s vs 2ms).
    const q = (t: Tables, isWisp: number): Promise<SqlRow[]> =>
      sqlQuery(`SELECT ${selectCols(t, false)}, '' AS _store, ${isWisp} AS _wisp FROM ${t.main} WHERE id IN (${ph})`, part)
    for (const rows of await Promise.all([q(ISSUES, 0), q(WISPS, 1)])) raws.push(...rows.map(toRaw))
  }
  const want = new Set(uniq)
  const rows = mergeWisps(raws.filter((r) => want.has(r.id)))
  await hydrate(rows)
  for (const r of rows) out.set(r.id, strip(r))
  return out
}

// ---------------------------------------------------------------- partial ids

export type PartialIdResolution =
  | { kind: 'ok'; id: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'none' }

/**
 * bd's `ResolvePartialID` (internal/utils/id_parser.go), minus the exact-id
 * fast path (callers try the exact id first). `bd show|comments|dep list <id>`
 * accept a truncated id: the hash part (id minus the store prefix) is matched
 * as a SUBSTRING of every candidate's hash; an exact hash match wins, otherwise
 * exactly one substring match resolves and zero (`none`) or several
 * (`ambiguous`) is an error. `list --parent` does NOT resolve (callers pass the
 * literal id there). Pure so the rules are testable without a database.
 *
 * `prefixes` are the store's owned id prefixes; the first is bd's configured
 * `issue_prefix`, the rest play `allowed_prefixes`. `candidates` must be a
 * superset of the store-namespace ids whose hash contains the input's hash;
 * the substring test here is literal and case-sensitive, as in Go.
 */
export function resolvePartialId(input: string, candidates: string[], prefixes: string[]): PartialIdResolution {
  const known = prefixes.map((p) => p.replace(/-$/, '')).filter(Boolean)
  const configured = known[0] ?? 'bd'
  const withHyphen = `${configured}-`
  let normalized: string
  if (input.startsWith(withHyphen)) normalized = input
  else if (known.some((p) => input.startsWith(`${p}-`))) normalized = input
  else if (looksLikePrefixedId(input)) normalized = input // a foreign prefix is looked up as-is
  else normalized = withHyphen + input
  const hashPart = normalized.startsWith(withHyphen) ? normalized.slice(withHyphen.length) : normalized
  const byLength = [...known].sort((a, b) => b.length - a.length)
  const hashOf = (id: string): string => {
    const p = byLength.find((k) => id.startsWith(`${k}-`))
    return p ? id.slice(p.length + 1) : id
  }
  const matches: string[] = []
  let exact = ''
  for (const id of candidates) {
    if (id === input) return { kind: 'ok', id }
    const h = hashOf(id)
    if (h === hashPart) exact = id // no break: the last exact hash wins, as in Go
    if (h.includes(hashPart)) matches.push(id)
  }
  if (exact) return { kind: 'ok', id: exact }
  if (matches.length === 1) return { kind: 'ok', id: matches[0] }
  return matches.length ? { kind: 'ambiguous', matches } : { kind: 'none' }
}

// bd: 1-8 lowercase alphanumerics, a hyphen, then an alphanumeric first char.
function looksLikePrefixedId(input: string): boolean {
  const i = input.indexOf('-')
  if (i <= 0 || i > 8) return false
  return /^[a-z0-9]+$/.test(input.slice(0, i)) && /^[a-z0-9]/.test(input.slice(i + 1))
}

/**
 * Resolve truncated ids the way `bd show <partial>` does, for many at once.
 * Only the ids that resolve are in the result (input -> full id); `none` and
 * `ambiguous` are absent, which is how the bd path treats them too (its
 * `show` errors, the bead is skipped). Candidates are read from the issues and
 * wisps tables inside the store's namespace.
 */
export async function sqlResolvePartialIds(refs: { store: string; id: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const ref of [...new Map(refs.map((r) => [r.id, r])).values()]) {
    const prefixes = await storePrefixes(ref.store)
    const known = prefixes.map((p) => p.replace(/-$/, ''))
    const configured = known[0] ?? 'bd'
    // The hash part, to narrow the scan; an empty hash is ambiguous by construction.
    const bare = ref.id.startsWith(`${configured}-`) ? ref.id.slice(configured.length + 1) : ref.id
    if (!bare) continue
    const ns = `(${known.map(() => 'id LIKE ?').join(' OR ')})`
    const args: SqlParam[] = [...known.map((p) => `${p}-%`), bare]
    const q = (table: string): Promise<SqlRow[]> =>
      sqlQuery(`SELECT id FROM ${table} WHERE ${ns} AND LOCATE(?, id) > 0 ORDER BY id`, args)
    const rows = (await Promise.all([q('issues'), q('wisps')])).flat()
    const got = resolvePartialId(ref.id, [...new Set(rows.map((r) => String(r.id)))], prefixes)
    if (got.kind === 'ok') out.set(ref.id, got.id)
  }
  return out
}

/** One edge of `bd dep list <id> --direction=down|up --json`. */
export interface SqlDepEdge {
  id: string
  title: string
  status?: string
  type: string
  unresolved: boolean
}

// bd: strip the legacy "external:<store>:<id>" wrapper from a dependency target.
export function resolveExternalDepTarget(target: string): string {
  if (!target.startsWith('external:')) return target
  const rest = target.slice('external:'.length)
  const i = rest.indexOf(':')
  return i >= 0 && i + 1 < rest.length ? rest.slice(i + 1) : target
}

const DOWN_PARALLEL = 16

/**
 * `bd dep list <id> --direction=<d> --json` for many ids at once (issues.go
 * GetDependencies/DependentsWithMetadata): dependency rows from `dependencies`
 * then `wisp_dependencies`, each joined to its target bead. A target with no
 * row stays visible as an unresolved edge (down: "(not found)" title).
 */
export async function sqlDepEdges(ids: string[], direction: 'down' | 'up'): Promise<Map<string, SqlDepEdge[]>> {
  const out = new Map<string, SqlDepEdge[]>()
  const uniq = [...new Set(ids)]
  for (const id of uniq) out.set(id, [])
  if (!uniq.length) return out
  type Raw = { owner: string; other: string; type: string }
  const raws: Raw[] = []
  if (direction === 'down') {
    // bd lists a bead's edges in Dolt's plan order for `WHERE issue_id = ?` with only the row id and
    // target selected; `IN (...)`, UNION parts and wider projections plan differently and reorder a
    // bead's own edges. So: one narrow `=` query per bead (bounded concurrency), then the types by id.
    for (const table of ['dependencies', 'wisp_dependencies']) {
      for (const part of chunks(uniq, DOWN_PARALLEL)) {
        const lists = await Promise.all(
          part.map((id) => sqlQuery(`SELECT id, ${DEP_TARGET} AS o FROM ${table} WHERE issue_id = ?`, [id])),
        )
        const rowIds: string[] = []
        for (const l of lists) for (const r of l) rowIds.push(String(r.id))
        const types = new Map<string, string>()
        for (const idPart of chunks([...new Set(rowIds)])) {
          const ph = idPart.map(() => '?').join(',')
          for (const r of await sqlQuery(`SELECT id, type FROM ${table} WHERE id IN (${ph})`, idPart)) {
            types.set(String(r.id), String(r.type ?? ''))
          }
        }
        part.forEach((owner, i) => {
          for (const r of lists[i]) raws.push({ owner, other: String(r.o), type: types.get(String(r.id)) ?? '' })
        })
      }
    }
  } else {
    for (const part of chunks(uniq)) {
      const ph = part.map(() => '?').join(',')
      for (const table of ['dependencies', 'wisp_dependencies']) {
        const rows = await sqlQuery(`SELECT ${DEP_TARGET} AS owner, issue_id AS other, type FROM ${table} WHERE ${DEP_TARGET} IN (${ph})`, part)
        for (const r of rows) raws.push({ owner: String(r.owner), other: String(r.other), type: String(r.type ?? '') })
      }
    }
  }
  const want = new Set(uniq)
  const edges = raws.filter((r) => want.has(r.owner))
  const lookup = edges.map((r) => (direction === 'down' ? resolveExternalDepTarget(r.other) : r.other))
  const found = new Map<string, { title: string; status?: string }>()
  for (const part of chunks([...new Set(lookup)])) {
    const ph = part.map(() => '?').join(',')
    const [issueRows, wispRows] = await Promise.all([
      sqlQuery(`SELECT id, title, status FROM issues WHERE id IN (${ph})`, part),
      sqlQuery(`SELECT id, title, status FROM wisps WHERE id IN (${ph})`, part),
    ])
    // issues first, a wisp row wins (as in mergeWisps)
    for (const r of [...issueRows, ...wispRows]) {
      found.set(String(r.id), { title: String(r.title ?? ''), status: r.status ? String(r.status) : undefined })
    }
  }
  edges.forEach((r, i) => {
    const key = lookup[i]
    const hit = found.get(key)
    const edge: SqlDepEdge = hit
      ? { id: key, title: hit.title, status: hit.status, type: r.type, unresolved: false }
      : { id: r.other, title: direction === 'down' ? '(not found)' : '', type: r.type, unresolved: direction === 'down' }
    out.get(r.owner)!.push(edge)
  })
  return out
}

/**
 * `bd list --json --limit 50 --parent <id>` for many parents in one statement
 * (one ordered, limited subquery per parent, same namespace + list defaults).
 * Returns each parent's children (id, title) in bd's output order.
 */
export async function sqlChildren(
  parents: { store: string; id: string }[],
  limit = 50,
): Promise<Map<string, { id: string; title: string }[]>> {
  await assertNoCustomStatuses()
  const out = new Map<string, { id: string; title: string }[]>()
  for (const p of parents) out.set(p.id, [])
  if (!parents.length) return out
  for (const part of chunks(parents, 40)) {
    const sqlParts: string[] = []
    const params: SqlParam[] = []
    for (const p of part) {
      const prefixes = await storePrefixes(p.store)
      const w = buildWhere(listFilter({ limit, parentId: p.id }), ISSUES)
      const ns = `(${prefixes.map(() => 'id LIKE ?').join(' OR ')})`
      sqlParts.push(
        `(SELECT id, title, ? AS _parent FROM issues WHERE ${[ns, ...w.sql].join(' AND ')} ${orderSql('')} LIMIT ${limit + 1})`,
      )
      params.push(p.id, ...prefixes.map((x) => `${x.replace(/-$/, '')}-%`), ...w.args)
    }
    for (const r of await sqlQuery(unionAll(sqlParts), params)) {
      out.get(String(r._parent))?.push({ id: String(r.id), title: String(r.title ?? '') })
    }
  }
  for (const [k, v] of out) if (v.length > limit) out.set(k, v.slice(0, limit))
  return out
}
