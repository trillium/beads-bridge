// Store health + write guard (feedback 82t1 / k3az).
//
// The bridge reaches every store by running the store's own CLI wrapper
// (`task`, `inbox`, `projects`, ...) — the same command a human runs. Since
// the authoritative stores moved to a remote brain host, those wrappers can
// be broken (`no beads database found`) or can quietly serve a different
// copy (`using local`, or a local path shadowing the remote one). This module
// asks each wrapper where it really points (`<store> where`), classifies the
// answer, and lets mutations refuse a store that is not the authoritative
// one — never writing into a stale or fallback copy.
import { execFile, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import * as yaml from 'js-yaml'
import { configFileReadOnly } from './config-dir'

export type StoreStatus = 'ok' | 'no-database' | 'fallback-local' | 'local-shadow' | 'misrouted' | 'unreachable' | 'unknown'

// Statuses that prove the CLI is NOT pointing at the authoritative store.
export const BLOCKING_STATUSES: readonly StoreStatus[] = ['no-database', 'fallback-local', 'local-shadow', 'misrouted']

export interface StoreProbe {
  store: string
  /** Exact command run, for reports: e.g. `task where`. */
  command: string
  status: StoreStatus
  /** Resolved .beads workspace path as the CLI reports it. */
  path?: string
  prefix?: string
  database?: string
  detail: string
  checkedAt: number
}

export interface ProbeContext {
  /** Path the local registry (stores.yaml) lists for this store. */
  registryPath?: string
  /** True when this host is a brain *client* (its CLIs forward to a remote host). */
  remoteClient: boolean
}

export interface RawWhere {
  code: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

const WHERE_TIMEOUT_MS = 10000

const home = (): string => process.env.HOME ?? homedir()

/** ~/.config/brain/remote.yaml present => this host forwards store CLIs to a remote brain host. */
export function remoteClientConfigured(): boolean {
  const p = process.env.BRAIN_REMOTE_CONFIG ?? join(home(), '.config', 'brain', 'remote.yaml')
  try {
    return /^\s*host\s*:\s*\S+/m.test(readFileSync(p, 'utf8'))
  } catch {
    return false
  }
}

// Pure: classify one `<store> where` run. Only definite signals block; an
// unparsable or erroring probe is `unknown` (the mutation itself then fails
// loudly or succeeds in the store the CLI really uses).
export function classifyWhere(store: string, raw: RawWhere, ctx: ProbeContext, now = Date.now()): StoreProbe {
  const base = { store, command: `${store} where`, checkedAt: now }
  const out = `${raw.stdout}\n${raw.stderr}`
  if (raw.timedOut) return { ...base, status: 'unreachable', detail: `${base.command} timed out after ${WHERE_TIMEOUT_MS / 1000}s` }
  if (/no beads database found/i.test(out)) {
    return {
      ...base,
      status: 'no-database',
      detail: `${store} CLI reports "no beads database found" — its wrapper points at a workspace that does not exist where it runs`,
    }
  }
  if (/using local/i.test(raw.stderr)) {
    return { ...base, status: 'fallback-local', detail: `${store} CLI fell back to a local copy: ${raw.stderr.trim().split('\n')[0].slice(0, 200)}` }
  }
  if (/ssh:|connection (refused|timed out|closed)|could not resolve host|no route to host/i.test(out)) {
    return { ...base, status: 'unreachable', detail: out.trim().split('\n')[0].slice(0, 200) }
  }
  const path = raw.stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/'))
  if (raw.code !== 0 || !path) {
    return { ...base, status: 'unknown', detail: `${base.command} exited ${raw.code}; output not recognised: ${out.trim().slice(0, 160)}` }
  }
  const prefix = /^\s*prefix:\s*(\S+)/m.exec(raw.stdout)?.[1]
  const database = /^\s*database:\s*(\S+)/m.exec(raw.stdout)?.[1]
  const common = { ...base, path, ...(prefix ? { prefix } : {}), ...(database ? { database } : {}) }
  // The CLI must land in the store's OWN workspace: a wrapper that resolves to a
  // different store's directory (scratch -> brain) would write into the wrong store.
  const want = ctx.registryPath ? workspaceName(ctx.registryPath) : undefined
  if (want && workspaceName(path) !== want) {
    return { ...common, status: 'misrouted', detail: `${store} CLI resolves to ${path}, but the registry says its workspace is '${want}' — writes would land in the wrong store` }
  }
  // A client host's CLIs forward to the remote host, so a healthy answer is a
  // REMOTE path. Seeing the registry's own local path means the CLI ran
  // against the stale local copy.
  if (ctx.remoteClient && ctx.registryPath && path === ctx.registryPath) {
    return { ...common, status: 'local-shadow', detail: `${store} resolves to the local registry path ${path} on a remote-client host — a stale local copy, not the authoritative store` }
  }
  return { ...common, status: 'ok', detail: `${store} resolves to ${path}` }
}

// '/x/data/tasks/.beads' and '/x/data/tasks' both name workspace 'tasks'.
const workspaceName = (p: string): string => basename(p.replace(/\/+$/, '').replace(/\/\.beads$/, ''))

const TTL_OK_MS = 30000
const TTL_BAD_MS = 5000
const cache = new Map<string, StoreProbe>()

export function resetStoreProbeCache(): void {
  cache.clear()
}

export const guardDisabled = (): boolean => process.env.BEADS_BRIDGE_STORE_GUARD === 'off'

function fresh(p: StoreProbe | undefined, now: number): p is StoreProbe {
  if (!p) return false
  return now - p.checkedAt < (p.status === 'ok' ? TTL_OK_MS : TTL_BAD_MS)
}

export interface ProbeOptions {
  registryPath?: string
  /** Bypass the cache. */
  force?: boolean
}

// Registry path for a store from stores.yaml (same file config.ts loads). Never throws.
let registry: Record<string, { path?: string }> | undefined
export function registryPathFor(store: string): string | undefined {
  if (!registry) {
    try {
      const doc = yaml.load(readFileSync(configFileReadOnly('stores.yaml'), 'utf8')) as { stores?: Record<string, { path?: string }> }
      registry = doc?.stores ?? {}
    } catch {
      registry = {}
    }
  }
  return registry[store]?.path
}
export function resetRegistryCache(): void {
  registry = undefined
}

const ctxFor = (store: string, opts?: ProbeOptions): ProbeContext => ({
  registryPath: opts?.registryPath ?? registryPathFor(store),
  remoteClient: remoteClientConfigured(),
})

export async function probeStore(store: string, opts?: ProbeOptions): Promise<StoreProbe> {
  const now = Date.now()
  const hit = cache.get(store)
  if (!opts?.force && fresh(hit, now)) return hit
  const raw = await new Promise<RawWhere>((resolve) => {
    execFile(store, ['where'], { encoding: 'utf8', timeout: WHERE_TIMEOUT_MS, env: process.env, maxBuffer: 1024 * 1024 }, (e, stdout, stderr) => {
      const err = e as { code?: unknown; killed?: boolean; signal?: string } | null
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (err && typeof err.code === 'string' ? `${err.code}` : ''),
        timedOut: err?.killed === true || err?.signal === 'SIGTERM',
      })
    })
  })
  const p = classifyWhere(store, raw, ctxFor(store, opts))
  cache.set(store, p)
  return p
}

export function probeStoreSync(store: string, opts?: ProbeOptions): StoreProbe {
  const now = Date.now()
  const hit = cache.get(store)
  if (!opts?.force && fresh(hit, now)) return hit
  const r = spawnSync(store, ['where'], { encoding: 'utf8', timeout: WHERE_TIMEOUT_MS, env: process.env, maxBuffer: 1024 * 1024 })
  const p = classifyWhere(
    store,
    {
      code: r.status,
      stdout: r.stdout ?? '',
      stderr: (r.stderr ?? '') || (r.error ? String(r.error.message) : ''),
      timedOut: (r.error as { code?: string } | undefined)?.code === 'ETIMEDOUT',
    },
    ctxFor(store, opts),
    now,
  )
  cache.set(store, p)
  return p
}

export class StoreUnavailableError extends Error {
  constructor(readonly probe: StoreProbe) {
    super(unavailableText(probe))
    this.name = 'StoreUnavailableError'
  }
}

export function unavailableText(p: StoreProbe): string {
  return (
    `store '${p.store}' is not reachable at its authoritative location (${p.status}): ${p.detail}. ` +
    `Nothing was read or written and no fallback store is used. Run store_health for the exact CLI probe; ` +
    `the wrapper behind \`${p.store}\` needs repair.`
  )
}

// Throws when the store's CLI provably is not the authoritative one.
export async function assertStoreWritable(store: string): Promise<void> {
  if (guardDisabled()) return
  const p = await probeStore(store)
  if (BLOCKING_STATUSES.includes(p.status)) throw new StoreUnavailableError(p)
}

const SILENT_WRONG: readonly StoreStatus[] = ['fallback-local', 'local-shadow', 'misrouted']
export function assertStoreReadableSync(store: string): void {
  if (guardDisabled()) return
  const p = probeStoreSync(store)
  if (SILENT_WRONG.includes(p.status)) throw new StoreUnavailableError(p)
}

// Reads: `no-database` already fails by itself, so only the statuses that
// would silently answer from the WRONG store block.
export async function assertStoreReadable(store: string): Promise<void> {
  if (guardDisabled()) return
  const p = await probeStore(store)
  if (SILENT_WRONG.includes(p.status)) throw new StoreUnavailableError(p)
}

export function assertStoreWritableSync(store: string): void {
  if (guardDisabled()) return
  const p = probeStoreSync(store)
  if (BLOCKING_STATUSES.includes(p.status)) throw new StoreUnavailableError(p)
}

// bd verbs that change a store. `comments` (plural) is a read.
const WRITE_VERBS = new Set([
  'create', 'update', 'edit', 'comment', 'note', 'close', 'reopen', 'label', 'dep', 'delete',
  'set-state', 'defer', 'undefer', 'assign', 'claim', 'rename', 'move', 'import',
])
export const isWriteVerb = (verb: string | undefined): boolean => !!verb && WRITE_VERBS.has(verb)

// A read that hit a broken store: replace the raw CLI error with the diagnosis.
export function readFailureNote(store: string, raw: string): string | null {
  if (!/no beads database found/i.test(raw)) return null
  return unavailableText({
    store,
    command: `${store} where`,
    status: 'no-database',
    detail: `${store} CLI reports "no beads database found" — its wrapper points at a workspace that does not exist where it runs`,
    checkedAt: Date.now(),
  })
}

export interface StoreHealthRow extends StoreProbe {
  registryPath?: string
}

export function formatStoreHealth(rows: StoreHealthRow[]): string {
  const bad = rows.filter((r) => r.status !== 'ok')
  return [
    `# store health — ${rows.length - bad.length}/${rows.length} stores at their authoritative location`,
    ``,
    `Probe = the store's own CLI (\`<store> where\`), the same command the bridge runs for every read and write.`,
    `Writes are refused for: ${BLOCKING_STATUSES.join(', ')}.`,
    ``,
    ...rows.map((r) => `- ${r.status === 'ok' ? 'OK ' : 'BAD'} ${r.store} [${r.status}] \`${r.command}\`${r.path ? ` -> ${r.path}` : ''}${r.prefix ? ` prefix=${r.prefix}` : ''}${r.status === 'ok' ? '' : ` — ${r.detail}`}`),
  ].join('\n')
}
