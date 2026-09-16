// Durable per-query MCP telemetry (inbox-au8v): structured JSONL request log
// at the bridge MCP boundary for lifecycle research (conversations vs
// refreshes vs reconnects, distinguished server-side later).
//
// Privacy posture (deliberate, documented):
// - Authorization header: presence boolean only, value never recorded.
// - Tool args: names + byte length only, never raw values (args carry
//   arbitrary user/bead content).
// - User-Agent: coarse client class only (consistent with analytics.ts).
// - Client IP is NOT visible at the fetch layer (express req.ip never
//   reaches here); session-id + protocol version + timing carry the
//   lifecycle signal instead. Passing ip through mountFetch is a
//   documented future extension, not done here.
// - Logging never fails a response: every IO path is guarded.
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { serverVersion } from './whoami'
import { loadManifest } from './capabilities'

export type McpQueryEntry = {
  ts: string
  durationMs: number
  method: string | null
  msgId: string | number | null
  tool: string | null
  argNames: string[]
  argBytes: number
  sessionId: string | null
  protocolVersion: string | null
  clientName: string | null
  clientVersion: string | null
  clientCapabilities: string[]
  mcpProtocolHeader: string | null
  client: string
  authPresent: boolean
  status: number
  backendVersion: string
  manifestVersion: number | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const META = 'io.modelcontextprotocol/'

/** Coarse client class — never the raw UA string. */
export function clientClass(ua: string | null): string {
  if (!ua) return 'none'
  const u = ua.toLowerCase()
  if (u.includes('chatgpt') || u.includes('gptbot')) return 'chatgpt'
  if (u.includes('curl')) return 'curl'
  if (u.includes('python')) return 'python'
  if (u.includes('node') || u.includes('undici')) return 'node'
  return 'other'
}

/** Arg shape only: sorted names + total JSON byte length. Values never leave. */
export function argShape(args: unknown): { names: string[]; bytes: number } {
  if (!isRecord(args)) return { names: [], bytes: 0 }
  let bytes = 0
  try {
    bytes = JSON.stringify(args).length
  } catch {
    bytes = -1
  }
  return { names: Object.keys(args).sort(), bytes }
}

export function parseMcpBody(body: unknown): {
  method: string | null
  msgId: string | number | null
  tool: string | null
  argNames: string[]
  argBytes: number
  protocolVersion: string | null
  clientName: string | null
  clientVersion: string | null
  clientCapabilities: string[]
} {
  const empty = {
    method: null, msgId: null, tool: null, argNames: [] as string[], argBytes: 0,
    protocolVersion: null, clientName: null, clientVersion: null, clientCapabilities: [] as string[],
  }
  if (!isRecord(body)) return empty
  const method = typeof body.method === 'string' ? body.method : null
  const msgId = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null
  const params = isRecord(body.params) ? body.params : null
  const meta = params && isRecord(params._meta) ? params._meta : null
  const protocolVersion =
    meta && typeof meta[`${META}protocolVersion`] === 'string'
      ? (meta[`${META}protocolVersion`] as string) : null
  const caps = meta && isRecord(meta[`${META}clientCapabilities`])
    ? Object.keys(meta[`${META}clientCapabilities`] as Record<string, unknown>).sort() : []
  const info = meta && isRecord(meta[`${META}clientInfo`])
    ? (meta[`${META}clientInfo`] as Record<string, unknown>) : null
  let tool: string | null = null
  let argNames: string[] = []
  let argBytes = 0
  if (method === 'tools/call' && params && typeof params.name === 'string') {
    tool = params.name
    const shape = argShape(params.arguments)
    argNames = shape.names
    argBytes = shape.bytes
  }
  return {
    method, msgId, tool, argNames, argBytes, protocolVersion,
    clientName: info && typeof info.name === 'string' ? info.name : null,
    clientVersion: info && typeof info.version === 'string' ? info.version : null,
    clientCapabilities: caps,
  }
}

export type TelemetryRetention = {
  retentionDays: number
  maxTotalBytes: number
  maxFileBytes: number
}

/** Env-tunable retention knobs with durable defaults. */
export function retentionConfig(): TelemetryRetention {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : dflt
  }
  return {
    retentionDays: num(process.env.MCP_TELEMETRY_RETENTION_DAYS, 30),
    maxTotalBytes: num(process.env.MCP_TELEMETRY_MAX_BYTES, 100 * 1024 * 1024),
    maxFileBytes: num(process.env.MCP_TELEMETRY_MAX_FILE_BYTES, 10 * 1024 * 1024),
  }
}

/**
 * Persistent default outside OS tmp (survives reboots).
 * Precedence: MCP_TELEMETRY_DIR > XDG_DATA_HOME > ~/.local/share.
 */
export function telemetryDir(): string {
  const override = process.env.MCP_TELEMETRY_DIR
  if (override && override.length > 0) return override
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.length > 0) return join(xdg, 'beads-bridge', 'telemetry')
  return join(homedir(), '.local', 'share', 'beads-bridge', 'telemetry')
}

function telemetryPath(now = new Date(), maxFileBytes = retentionConfig().maxFileBytes): string {
  const day = now.toISOString().slice(0, 10)
  const base = `mcp-queries-${day}`
  try {
    const first = join(telemetryDir(), `${base}.jsonl`)
    const size = statSync(first).size
    if (size < maxFileBytes) return first
    // Size rotation: spill to suffixed shards mcp-queries-<day>-<n>.jsonl
    let n = 1
    for (; n < 1000; n++) {
      const cand = join(telemetryDir(), `${base}-${n}.jsonl`)
      try {
        if (statSync(cand).size < maxFileBytes) return cand
      } catch {
        return cand
      }
    }
    return join(telemetryDir(), `${base}-${n}.jsonl`)
  } catch {
    return join(telemetryDir(), `${base}.jsonl`)
  }
}

export type PruneResult = {
  deleted: string[]
  keptFiles: number
  keptBytes: number
}

/**
 * Prune old/over-budget telemetry files. Deletes oldest first.
 * Never throws. Returns a receipt of what was removed.
 */
export function pruneTelemetry(
  dir = telemetryDir(),
  opts: Partial<TelemetryRetention> = {},
): PruneResult {
  const empty: PruneResult = { deleted: [], keptFiles: 0, keptBytes: 0 }
  try {
    const cfg = { ...retentionConfig(), ...opts }
    const cutoff = Date.now() - cfg.retentionDays * 86400 * 1000
    let files: { name: string; mtime: number; size: number }[]
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((name) => {
          const st = statSync(join(dir, name))
          return { name, mtime: st.mtimeMs, size: st.size }
        })
        .sort((a, b) => a.mtime - b.mtime)
    } catch {
      return empty
    }
    const deleted: string[] = []
    // Pass 1: age-based retention on daily/shard files.
    const fresh = files.filter((f) => {
      if (f.mtime < cutoff) {
        try {
          unlinkSync(join(dir, f.name))
          deleted.push(f.name)
        } catch { /* keep going */ }
        return false
      }
      return true
    })
    // Pass 2: total size cap, oldest first.
    let total = fresh.reduce((s, f) => s + f.size, 0)
    const kept = [...fresh]
    while (total > cfg.maxTotalBytes && kept.length > 0) {
      const oldest = kept.shift()!
      try {
        unlinkSync(join(dir, oldest.name))
        deleted.push(oldest.name)
        total -= oldest.size
      } catch {
        kept.unshift(oldest)
        break
      }
    }
    return { deleted, keptFiles: kept.length, keptBytes: total }
  } catch {
    return empty
  }
}

let lastPruneAt = 0
function maybePrune(): void {
  // Throttle: at most one prune sweep per minute per process.
  if (Date.now() - lastPruneAt < 60_000) return
  lastPruneAt = Date.now()
  pruneTelemetry()
}

/** Append one entry as JSONL. Never throws. */
export function appendTelemetry(entry: McpQueryEntry): void {
  try {
    mkdirSync(telemetryDir(), { recursive: true })
    appendFileSync(telemetryPath(), JSON.stringify(entry) + '\n')
    maybePrune()
  } catch {
    /* telemetry must never fail a response */
  }
}

/** Read back JSONL rows (oldest file first); skips corrupt lines. Never throws. */
export function readTelemetry(
  dir = telemetryDir(),
  filter: (e: McpQueryEntry) => boolean = () => true,
): McpQueryEntry[] {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
    const out: McpQueryEntry[] = []
    for (const f of files) {
      let raw: string
      try {
        raw = readFileSync(join(dir, f), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as McpQueryEntry
          if (filter(e)) out.push(e)
        } catch { /* skip corrupt lines */ }
      }
    }
    return out
  } catch {
    return []
  }
}

export function manifestVersionSafe(): number | null {
  try {
    return loadManifest().manifestVersion
  } catch {
    return null
  }
}

export type FetchLike = (req: globalThis.Request) => Promise<globalThis.Response>

/**
 * Wrap a fetch-style MCP handler with durable per-query telemetry.
 * Reads (never consumes) the request clone; logs after the response.
 */
export function withTelemetry(next: FetchLike): FetchLike {
  return async (fetchReq: globalThis.Request): Promise<globalThis.Response> => {
    const start = Date.now()
    let body: unknown = null
    try {
      if ((fetchReq.method ?? 'GET') !== 'GET') body = await fetchReq.clone().json()
    } catch {
      body = null
    }
    const parsed = parseMcpBody(body)
    const h = fetchReq.headers
    const client = clientClass(h.get('user-agent'))
    let res: globalThis.Response
    try {
      res = await next(fetchReq)
    } catch (e) {
      appendTelemetry({
        ts: new Date(start).toISOString(),
        durationMs: Date.now() - start,
        ...parsed,
        sessionId: h.get('mcp-session-id'),
        mcpProtocolHeader: h.get('mcp-protocol-version'),
        client,
        authPresent: h.has('authorization'),
        status: 500,
        backendVersion: serverVersion(),
        manifestVersion: manifestVersionSafe(),
      })
      throw e
    }
    appendTelemetry({
      ts: new Date(start).toISOString(),
      durationMs: Date.now() - start,
      ...parsed,
      sessionId: h.get('mcp-session-id'),
      mcpProtocolHeader: h.get('mcp-protocol-version'),
      client,
      authPresent: h.has('authorization'),
      status: res.status,
      backendVersion: serverVersion(),
      manifestVersion: manifestVersionSafe(),
    })
    return res
  }
}
