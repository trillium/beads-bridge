// Date bounds, sort order, and opaque keyset cursors for bead list queries.
//
// The pure helpers here are the contract. SQL (`src/lib/sql-beads.ts`) and the
// bd argv (`src/routes/query/store.ts`) both apply them. pageRows is the
// in-memory statement of the same order, used by tests.
//
// published_at is not a column on bead rows (created_at and updated_at are).
// Callers that pass it get an error instead of a made-up timestamp.
import type { SqlParam } from './sql'

export class QueryOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryOrderError'
  }
}

export const PUBLISHED_AT_MSG =
  'published_at is not stored on bead rows (there is no published_at column; created_at and updated_at are). Use those. A status-store query that omits order_by already sorts by updated_at descending, then priority, then id.'

/** Captain status feed: the `status` store. */
export const STATUS_FEED_STORE = 'status'

export type OrderField = 'priority' | 'created_at' | 'updated_at' | 'id'
export type SortDir = 'asc' | 'desc'

export interface OrderColumn {
  col: OrderField
  dir: SortDir
}

export type CursorVal = string | number | null

export interface TimeBound {
  /** `YYYY-MM-DD HH:MM:SS` UTC, for SQL datetime comparison. */
  sql: string
  /** RFC3339 UTC, for bd `--*-after` / `--*-before` flags. */
  flag: string
}

export interface DateBounds {
  createdAfter?: TimeBound
  createdBefore?: TimeBound
  updatedAfter?: TimeBound
  updatedBefore?: TimeBound
}

const ORDER_FIELDS = new Set<OrderField>(['priority', 'created_at', 'updated_at', 'id'])

export function legacyOrder(): OrderColumn[] {
  return [
    { col: 'priority', dir: 'asc' },
    { col: 'created_at', dir: 'desc' },
    { col: 'id', dir: 'asc' },
  ]
}

/** Newest updated first. Priority is only a tie-break, then id. */
export function statusFeedOrder(): OrderColumn[] {
  return [
    { col: 'updated_at', dir: 'desc' },
    { col: 'priority', dir: 'asc' },
    { col: 'id', dir: 'asc' },
  ]
}

export function isLegacyOrder(cols: OrderColumn[]): boolean {
  const want = legacyOrder()
  return columnsEqual(cols, want)
}

export function columnsEqual(a: OrderColumn[], b: OrderColumn[]): boolean {
  if (a.length !== b.length) return false
  return a.every((c, i) => c.col === b[i].col && c.dir === b[i].dir)
}

function defaultDir(field: OrderField): SortDir {
  // bd list: created/updated are newest-first; priority and id are ascending.
  return field === 'created_at' || field === 'updated_at' ? 'desc' : 'asc'
}

export type OrderKind = 'legacy' | 'status-feed' | 'explicit'

/**
 * Order for one list. Omitted options keep bd's default (priority, newest
 * created, id), except the status store, which is the captain's status feed
 * and defaults to updated_at descending.
 */
export function resolveOrder(store: string, orderBy?: string, descending?: boolean): { columns: OrderColumn[]; kind: OrderKind } {
  const asked = orderBy?.trim()
  if (asked === 'published_at') throw new QueryOrderError(PUBLISHED_AT_MSG)
  if (asked) {
    if (!ORDER_FIELDS.has(asked as OrderField)) {
      throw new QueryOrderError(`order_by must be created_at, updated_at, priority, or id (got "${asked.slice(0, 40)}")`)
    }
    const field = asked as OrderField
    const dir: SortDir = descending === undefined ? defaultDir(field) : (descending ? 'desc' : 'asc')
    const columns: OrderColumn[] = field === 'id'
      ? [{ col: 'id', dir }]
      : [{ col: field, dir }, { col: 'id', dir: 'asc' }]
    return { columns, kind: 'explicit' }
  }
  if (store === STATUS_FEED_STORE) {
    const columns = statusFeedOrder()
    if (descending !== undefined) columns[0] = { col: columns[0].col, dir: descending ? 'desc' : 'asc' }
    return { columns, kind: 'status-feed' }
  }
  const columns = legacyOrder()
  if (descending !== undefined) {
    columns[0] = { col: columns[0].col, dir: descending ? 'desc' : 'asc' }
    return { columns, kind: 'explicit' }
  }
  return { columns, kind: 'legacy' }
}

export function formatOrder(cols: OrderColumn[]): string {
  return cols.map((c) => `${c.col} ${c.dir}`).join(', ')
}

/** bd `--sort` / `--reverse` for the primary column. Compound tie-breaks stay in SQL. */
export function bdSortArgs(cols: OrderColumn[] | undefined): string[] {
  if (!cols || isLegacyOrder(cols)) return []
  const primary = cols[0]
  const sort = primary.col === 'created_at' ? 'created'
    : primary.col === 'updated_at' ? 'updated'
      : primary.col === 'priority' ? 'priority'
        : 'id'
  const naturalDesc = primary.col === 'created_at' || primary.col === 'updated_at'
  const reverse = naturalDesc ? primary.dir === 'asc' : primary.dir === 'desc'
  const args = ['--sort', sort]
  if (reverse) args.push('--reverse')
  return args
}

// ---------------------------------------------------------------- time bounds

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function realUtc(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/**
 * Exclusive-bound time. RFC3339 UTC, or `YYYY-MM-DD` as midnight UTC.
 * Fractional seconds are floored (bead timestamps are second precision).
 * Other forms are rejected so a local or relative time is never guessed.
 */
export function normalizeBound(raw: string): TimeBound {
  const s = raw.trim()
  if (!s) throw new QueryOrderError('empty date bound')
  const date = DATE_ONLY.exec(s)
  if (date) {
    const y = Number(date[1]); const mo = Number(date[2]); const d = Number(date[3])
    if (!realUtc(y, mo, d, 0, 0, 0)) throw new QueryOrderError(`invalid date "${s.slice(0, 40)}"`)
    const sql = `${date[1]}-${date[2]}-${date[3]} 00:00:00`
    return { sql, flag: `${date[1]}-${date[2]}-${date[3]}T00:00:00Z` }
  }
  const m = RFC3339_UTC.exec(s)
  if (!m) {
    throw new QueryOrderError(
      `date bound must be RFC3339 UTC (2026-10-16T01:02:03Z) or YYYY-MM-DD (UTC midnight); got "${s.slice(0, 40)}"`,
    )
  }
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const h = Number(m[4]); const mi = Number(m[5]); const sec = Number(m[6])
  if (!realUtc(y, mo, d, h, mi, sec)) throw new QueryOrderError(`invalid date "${s.slice(0, 40)}"`)
  const sql = `${m[1]}-${m[2]}-${m[3]} ${pad(h)}:${pad(mi)}:${pad(sec)}`
  const flag = `${m[1]}-${m[2]}-${m[3]}T${pad(h)}:${pad(mi)}:${pad(sec)}Z`
  return { sql, flag }
}

const SQL_DT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/

/** Compare key for a stored or bound timestamp. ISO and SQL forms of the same second match. */
export function instantKey(raw: string): string {
  const s = raw.trim()
  const sql = SQL_DT.exec(s)
  if (sql) return normalizeBound(`${sql[1]}T${sql[2]}Z`).sql
  return normalizeBound(s).sql
}

function optionalBound(v: string | undefined, label: string): TimeBound | undefined {
  if (v == null) return undefined
  const t = v.trim()
  if (!t) return undefined
  try {
    return normalizeBound(t)
  } catch (e) {
    if (e instanceof QueryOrderError) throw new QueryOrderError(`${label}: ${e.message}`)
    throw e
  }
}

export function parseDescending(v: string | undefined): boolean | undefined {
  if (v == null) return undefined
  const s = v.trim().toLowerCase()
  if (!s) return undefined
  if (s === '1' || s === 'true' || s === 'yes') return true
  if (s === '0' || s === 'false' || s === 'no') return false
  throw new QueryOrderError(`descending must be true or false (got "${s.slice(0, 20)}")`)
}

export function parseDateBounds(input: {
  createdAfter?: string
  createdBefore?: string
  updatedAfter?: string
  updatedBefore?: string
  publishedAfter?: string
  publishedBefore?: string
}): DateBounds {
  if (input.publishedAfter?.trim() || input.publishedBefore?.trim()) throw new QueryOrderError(PUBLISHED_AT_MSG)
  return {
    createdAfter: optionalBound(input.createdAfter, 'created_after'),
    createdBefore: optionalBound(input.createdBefore, 'created_before'),
    updatedAfter: optionalBound(input.updatedAfter, 'updated_after'),
    updatedBefore: optionalBound(input.updatedBefore, 'updated_before'),
  }
}

export function appendBdDateFlags(args: string[], bounds: DateBounds | undefined): void {
  if (!bounds) return
  if (bounds.createdAfter) args.push('--created-after', bounds.createdAfter.flag)
  if (bounds.createdBefore) args.push('--created-before', bounds.createdBefore.flag)
  if (bounds.updatedAfter) args.push('--updated-after', bounds.updatedAfter.flag)
  if (bounds.updatedBefore) args.push('--updated-before', bounds.updatedBefore.flag)
}

/**
 * bd has no keyset. The closest flag moves the primary timestamp past the
 * cursor (exclusive, same as bd's own before/after). Tie rows at that exact
 * second are finished on the SQL path; this only covers the bd fallback.
 */
export function cursorBdFlags(cols: OrderColumn[], vals: CursorVal[]): string[] {
  if (!cols.length || vals[0] == null) return []
  const primary = cols[0]
  if (primary.col !== 'updated_at' && primary.col !== 'created_at') return []
  let flag: string
  try {
    flag = normalizeBound(String(vals[0])).flag
  } catch {
    return []
  }
  const name = primary.col === 'updated_at' ? 'updated' : 'created'
  const which = primary.dir === 'desc' ? 'before' : 'after'
  return [`--${name}-${which}`, flag]
}

// ---------------------------------------------------------------- cursors

interface CursorPayload {
  v: 1
  store: string
  cols: OrderColumn[]
  vals: CursorVal[]
}

export function encodeCursor(payload: CursorPayload): string {
  return `v1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

export function decodeCursor(token: string): CursorPayload {
  const t = token.trim()
  if (!t.startsWith('v1.')) throw new QueryOrderError('cursor is not a beads-bridge page token')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(t.slice(3), 'base64url').toString('utf8'))
  } catch {
    throw new QueryOrderError('cursor is not a beads-bridge page token')
  }
  if (!parsed || typeof parsed !== 'object') throw new QueryOrderError('cursor is not a beads-bridge page token')
  const p = parsed as Partial<CursorPayload>
  if (p.v !== 1 || typeof p.store !== 'string' || !Array.isArray(p.cols) || !Array.isArray(p.vals)) {
    throw new QueryOrderError('cursor is not a beads-bridge page token')
  }
  if (p.cols.length !== p.vals.length || p.cols.length === 0 || p.cols.length > 4) {
    throw new QueryOrderError('cursor is not a beads-bridge page token')
  }
  const cols: OrderColumn[] = []
  for (const c of p.cols) {
    if (!c || typeof c !== 'object') throw new QueryOrderError('cursor is not a beads-bridge page token')
    const col = (c as OrderColumn).col
    const dir = (c as OrderColumn).dir
    if (!ORDER_FIELDS.has(col) || (dir !== 'asc' && dir !== 'desc')) {
      throw new QueryOrderError('cursor is not a beads-bridge page token')
    }
    cols.push({ col, dir })
  }
  const vals: CursorVal[] = p.vals.map((v) => {
    if (v === null) return null
    if (typeof v === 'string' || typeof v === 'number') return v
    throw new QueryOrderError('cursor is not a beads-bridge page token')
  })
  return { v: 1, store: p.store, cols, vals }
}

// ---------------------------------------------------------------- row order (the contract tests pin)

export interface SortableRow {
  id: string
  priority?: number | null
  createdAt?: string | null
  updatedAt?: string | null
}

function rowValue(row: SortableRow, col: OrderField): string | number | null {
  if (col === 'id') return row.id
  if (col === 'priority') return row.priority ?? null
  const raw = col === 'created_at' ? row.createdAt : row.updatedAt
  if (raw == null || raw === '') return null
  return instantKey(raw)
}

function normalizeCursorVal(col: OrderField, v: CursorVal): string | number | null {
  if (v === null) return null
  if (col === 'priority') {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) throw new QueryOrderError('cursor priority is not a number')
    return n
  }
  if (col === 'id') return String(v)
  return instantKey(String(v))
}

function compareVal(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  const as = String(a)
  const bs = String(b)
  return as === bs ? 0 : as < bs ? -1 : 1
}

export function compareRows(a: SortableRow, b: SortableRow, cols: OrderColumn[]): number {
  for (const c of cols) {
    const cmp = compareVal(rowValue(a, c.col), rowValue(b, c.col))
    if (cmp === 0) continue
    return c.dir === 'asc' ? cmp : -cmp
  }
  return 0
}

export function sortRows<T extends SortableRow>(rows: T[], cols: OrderColumn[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => compareRows(a.r, b.r, cols) || a.i - b.i)
    .map((x) => x.r)
}

/** True when `row` sorts strictly after the cursor. */
export function rowAfterCursor(row: SortableRow, cols: OrderColumn[], vals: CursorVal[]): boolean {
  if (vals.length !== cols.length) throw new QueryOrderError('cursor does not match this order')
  for (let i = 0; i < cols.length; i++) {
    const cmp = compareVal(rowValue(row, cols[i].col), normalizeCursorVal(cols[i].col, vals[i]))
    if (cmp === 0) continue
    return cols[i].dir === 'asc' ? cmp > 0 : cmp < 0
  }
  return false
}

export function cursorVals(row: SortableRow, cols: OrderColumn[]): CursorVal[] {
  return cols.map((c) => {
    const v = rowValue(row, c.col)
    if (c.col === 'created_at' || c.col === 'updated_at') {
      const raw = c.col === 'created_at' ? row.createdAt : row.updatedAt
      return raw ?? null
    }
    return v
  })
}

function inBounds(row: SortableRow, bounds: DateBounds | undefined): boolean {
  if (!bounds) return true
  const created = row.createdAt ? instantKey(row.createdAt) : null
  const updated = row.updatedAt ? instantKey(row.updatedAt) : null
  if (bounds.createdAfter && (created == null || created <= bounds.createdAfter.sql)) return false
  if (bounds.createdBefore && (created == null || created >= bounds.createdBefore.sql)) return false
  if (bounds.updatedAfter && (updated == null || updated <= bounds.updatedAfter.sql)) return false
  if (bounds.updatedBefore && (updated == null || updated >= bounds.updatedBefore.sql)) return false
  return true
}

export function pageRows<T extends SortableRow>(rows: T[], opts: {
  columns: OrderColumn[]
  limit: number
  store: string
  bounds?: DateBounds
  cursor?: string
}): { rows: T[]; nextCursor?: string } {
  let xs = rows.filter((r) => inBounds(r, opts.bounds))
  xs = sortRows(xs, opts.columns)
  if (opts.cursor?.trim()) {
    const c = decodeCursor(opts.cursor)
    if (c.store !== opts.store) throw new QueryOrderError('cursor is for a different store')
    if (!columnsEqual(c.cols, opts.columns)) throw new QueryOrderError('cursor is for a different order; repeat the same order_by and descending')
    xs = xs.filter((r) => rowAfterCursor(r, opts.columns, c.vals))
  }
  const page = xs.slice(0, opts.limit)
  if (xs.length <= opts.limit || !page.length) return { rows: page }
  const last = page[page.length - 1]
  const vals = cursorVals(last, opts.columns)
  if (vals.some((v) => v == null)) return { rows: page }
  return {
    rows: page,
    nextCursor: encodeCursor({ v: 1, store: opts.store, cols: opts.columns, vals }),
  }
}

// ---------------------------------------------------------------- SQL fragments

export function orderBySql(cols: OrderColumn[]): string {
  if (!cols.length) return 'ORDER BY priority ASC, created_at DESC, id ASC'
  return `ORDER BY ${cols.map((c) => `${c.col} ${c.dir === 'asc' ? 'ASC' : 'DESC'}`).join(', ')}`
}

/** Keyset predicate. Same "first difference" rule as rowAfterCursor. Values are bound, never interpolated. */
export function keysetSql(cols: OrderColumn[], vals: CursorVal[]): { sql: string; args: SqlParam[] } {
  if (cols.length !== vals.length || cols.length === 0) throw new QueryOrderError('cursor does not match this order')
  const parts: string[] = []
  const args: SqlParam[] = []
  for (let i = 0; i < cols.length; i++) {
    const eq: string[] = []
    const eqArgs: SqlParam[] = []
    for (let j = 0; j < i; j++) {
      const bound = bindVal(cols[j].col, vals[j])
      eq.push(`${cols[j].col} = ?`)
      eqArgs.push(bound)
    }
    const op = cols[i].dir === 'asc' ? '>' : '<'
    const ineqArg = bindVal(cols[i].col, vals[i])
    parts.push(eq.length ? `(${[...eq, `${cols[i].col} ${op} ?`].join(' AND ')})` : `${cols[i].col} ${op} ?`)
    args.push(...eqArgs, ineqArg)
  }
  return { sql: `(${parts.join(' OR ')})`, args }
}

function bindVal(col: OrderField, v: CursorVal): SqlParam {
  const n = normalizeCursorVal(col, v)
  if (n === null) throw new QueryOrderError(`cursor is missing ${col}`)
  return n
}

export interface ListWindow {
  columns: OrderColumn[]
  kind: OrderKind
  bounds: DateBounds
  /** Decoded cursor, already checked against store + order. */
  cursor?: CursorPayload
}

export function parseListWindow(input: {
  store: string
  orderBy?: string
  descending?: boolean
  createdAfter?: string
  createdBefore?: string
  updatedAfter?: string
  updatedBefore?: string
  publishedAfter?: string
  publishedBefore?: string
  cursor?: string
}): ListWindow {
  const { columns, kind } = resolveOrder(input.store, input.orderBy, input.descending)
  const bounds = parseDateBounds(input)
  let cursor: CursorPayload | undefined
  const token = input.cursor?.trim()
  if (token) {
    cursor = decodeCursor(token)
    if (cursor.store !== input.store) throw new QueryOrderError('cursor is for a different store')
    if (!columnsEqual(cursor.cols, columns)) {
      throw new QueryOrderError('cursor is for a different order; repeat the same order_by and descending')
    }
  }
  return { columns, kind, bounds, cursor }
}
