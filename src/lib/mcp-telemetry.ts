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
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

function telemetryDir(): string {
  return process.env.MCP_TELEMETRY_DIR ?? join(tmpdir(), 'beads-bridge-telemetry')
}

function telemetryPath(now = new Date()): string {
  const day = now.toISOString().slice(0, 10)
  return join(telemetryDir(), `mcp-queries-${day}.jsonl`)
}

/** Append one entry as JSONL. Never throws. */
export function appendTelemetry(entry: McpQueryEntry): void {
  try {
    mkdirSync(telemetryDir(), { recursive: true })
    appendFileSync(telemetryPath(), JSON.stringify(entry) + '\n')
  } catch {
    /* telemetry must never fail a response */
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
