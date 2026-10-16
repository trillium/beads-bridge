// Read-only SQL access to the shared Dolt database (`brain_unified`).
//
// WHY: every bead read used to spawn one `bd` subprocess per item or store
// (a 55-store sweep = 55 spawns; a 47-bead snapshot = hundreds). This module
// is the ONE small door for reading bead rows over the mysql protocol
// instead, so a sweep is one statement. It is read-only by construction:
// `assertReadOnlySql` rejects everything but a single SELECT, and the pool
// exposes no write API. Mutations stay in src/lib/mutate.ts (bd).
//
// ROLLOUT: SQL is an optimisation with an automatic, LOGGED fallback to the
// old bd-subprocess path (`withSqlFallback`). `BEADS_BRIDGE_SQL=off` forces
// the old path everywhere (reversible rollout, no redeploy of code needed).
//
// Config (env only, no secrets in code):
//   BEADS_BRIDGE_SQL            off|0|false|no -> force the bd path
//   BEADS_BRIDGE_SQL_HOST       default 127.0.0.1
//   BEADS_BRIDGE_SQL_PORT       default 3307
//   BEADS_BRIDGE_SQL_USER       default root
//   BEADS_BRIDGE_SQL_PASSWORD   default empty
//   BEADS_BRIDGE_SQL_DATABASE   default brain_unified
//   BEADS_BRIDGE_SQL_TIMEOUT_MS default 10000 (per statement)
//   BEADS_BRIDGE_SQL_POOL       default 4 connections

export class SqlReadOnlyError extends Error {
  constructor(reason: string, public readonly statement: string) {
    super(`sql refused (read-only): ${reason}`)
    this.name = 'SqlReadOnlyError'
  }
}

// Strip quoted literals/identifiers so keyword scanning only sees structure.
function stripQuoted(sql: string): string {
  return sql.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, ' ? ')
}

// Dolt exposes write operations as SQL functions/procedures
// (dolt_commit, dolt_reset, ...). Reading Dolt *tables* (dolt_history_issues,
// dolt_log) is fine; calling a dolt_ function is not.
const WRITE_WORDS =
  /\b(insert|update|delete|replace|drop|alter|create|truncate|rename|grant|revoke|call|set|load|handler|lock|unlock|use|into|prepare|execute|deallocate|do|optimize|analyze|repair|flush|kill|reset|purge|install|uninstall|shutdown|savepoint|rollback|commit|begin|start)\b/i

// Throws unless `sql` is exactly one SELECT statement (optionally WITH ...
// SELECT). Exported for the unit test and for any caller that builds SQL.
export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== 'string' || !sql.trim()) throw new SqlReadOnlyError('empty statement', String(sql))
  // Comments hide payloads (/*! executable */, -- tails): refuse them outright.
  if (/\/\*|\*\/|--|#/.test(stripQuoted(sql))) throw new SqlReadOnlyError('comments are not allowed', sql)
  const body = stripQuoted(sql).trim().replace(/;+\s*$/, '')
  if (body.includes(';')) throw new SqlReadOnlyError('multiple statements', sql)
  if (!/^\(*\s*(select|with)\b/i.test(body)) throw new SqlReadOnlyError('only SELECT is allowed', sql)
  const bad = WRITE_WORDS.exec(body)
  if (bad) throw new SqlReadOnlyError(`forbidden keyword "${bad[1].toLowerCase()}"`, sql)
  if (/\bfor\s+update\b|\block\s+in\s+share\s+mode\b/i.test(body)) throw new SqlReadOnlyError('locking read', sql)
  if (/\bdolt_[a-z_]+\s*\(/i.test(body)) throw new SqlReadOnlyError('dolt function call', sql)
  if (/\b(get_lock|release_lock|sleep|benchmark|load_file|sys_exec)\s*\(/i.test(body)) {
    throw new SqlReadOnlyError('side-effecting function', sql)
  }
}

export type SqlParam = string | number | boolean | null
export type SqlRow = Record<string, unknown>

export interface SqlConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  timeoutMs: number
  pool: number
}

export function sqlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.BEADS_BRIDGE_SQL ?? '').trim().toLowerCase()
  return !['off', '0', 'false', 'no', 'disabled'].includes(v)
}

export function sqlConfig(env: NodeJS.ProcessEnv = process.env): SqlConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d
  }
  return {
    host: env.BEADS_BRIDGE_SQL_HOST?.trim() || '127.0.0.1',
    port: num(env.BEADS_BRIDGE_SQL_PORT, 3307),
    user: env.BEADS_BRIDGE_SQL_USER?.trim() || 'root',
    password: env.BEADS_BRIDGE_SQL_PASSWORD ?? '',
    database: env.BEADS_BRIDGE_SQL_DATABASE?.trim() || 'brain_unified',
    timeoutMs: num(env.BEADS_BRIDGE_SQL_TIMEOUT_MS, 10000),
    pool: num(env.BEADS_BRIDGE_SQL_POOL, 4),
  }
}

// ---- observability (also what the before/after measurement reads) ----

export const sqlStats = { queries: 0, errors: 0, fallbacks: 0 }
export function resetSqlStats(): void {
  sqlStats.queries = 0
  sqlStats.errors = 0
  sqlStats.fallbacks = 0
}

// ---- client ----

interface BunSql {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>
  close(): Promise<void>
}

let client: BunSql | null = null
let clientKey = ''
// After a connection failure, don't hammer a down server on every request:
// go straight to the bd path until the cool-down passes.
let downUntil = 0
const DOWN_COOLDOWN_MS = 15000

function getClient(): BunSql {
  const cfg = sqlConfig()
  const key = JSON.stringify(cfg)
  if (client && key === clientKey) return client
  const Ctor = (globalThis as { Bun?: { SQL?: new (opts: unknown) => BunSql } }).Bun?.SQL
  if (!Ctor) throw new Error('Bun.SQL is unavailable in this runtime')
  if (client) void client.close().catch(() => {})
  client = new Ctor({
    adapter: 'mysql',
    hostname: cfg.host,
    port: cfg.port,
    username: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: cfg.pool,
    idleTimeout: 30,
    connectionTimeout: 5,
  })
  clientKey = key
  return client
}

export async function closeSql(): Promise<void> {
  const c = client
  client = null
  clientKey = ''
  if (c) await c.close().catch(() => {})
}

// Run ONE read-only statement. Throws SqlReadOnlyError for anything but a
// SELECT (before touching the network). Resolves plain row objects.
export async function sqlQuery(sql: string, params: SqlParam[] = []): Promise<SqlRow[]> {
  assertReadOnlySql(sql)
  if (!sqlEnabled()) throw new Error('sql reads disabled (BEADS_BRIDGE_SQL=off)')
  if (Date.now() < downUntil) throw new Error('sql reads cooling down after a connection failure')
  const { timeoutMs } = sqlConfig()
  sqlStats.queries++
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const run = getClient().unsafe(sql, params)
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`sql statement timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    const rows = await Promise.race([run, timeout])
    return Array.from(rows as ArrayLike<SqlRow>, (r) => ({ ...r }))
  } catch (e) {
    sqlStats.errors++
    const msg = e instanceof Error ? e.message : String(e)
    if (/ECONNREFUSED|ECONNRESET|connect|closed|timed out|EHOSTUNREACH|ETIMEDOUT/i.test(msg)) {
      downUntil = Date.now() + DOWN_COOLDOWN_MS
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Optimise-with-fallback: try the SQL implementation; on ANY failure (or when
// SQL is switched off / unavailable) log once per call and run the legacy bd
// path. The legacy path is the source of truth for behaviour, so a SQL
// failure can never change a tool's answer, only its speed.
export async function withSqlFallback<T>(label: string, viaSql: () => Promise<T>, viaBd: () => Promise<T>): Promise<T> {
  if (!sqlEnabled()) return viaBd()
  try {
    return await viaSql()
  } catch (e) {
    sqlStats.fallbacks++
    const msg = e instanceof Error ? e.message : String(e)
    // Cooling-down is the steady state while the DB is down: don't spam.
    if (!/cooling down/.test(msg)) console.warn(`[sql-fallback] ${label}: ${msg.slice(0, 200)} — using bd subprocess path`)
    return viaBd()
  }
}

export const SQL_TEST_HOOKS = {
  resetDown(): void {
    downUntil = 0
  },
}
