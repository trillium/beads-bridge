// Bridge↔jungle tool-surface parity: fails when the gateway deals a stale
// downstream snapshot (2026-10-05 incident: jungle's SQLite tool cache for
// beads-bridge was frozen 2026-09-26, missing the 1.6.0 `capability` tool —
// bridge-direct served 43, /jungle/mcp + /chatgpt/mcp dealt 42, and clients
// loaded a manifest-v4-era schema while bridge_info reported v1.6.0/manifest
// v5; fixed by re-running ops/jungle-register-bearer.sh).
//
// Two layers:
// - Pure comparator + fixture tests: always run, prove a missing/extra tool
//   fails loudly (names the tools, both directions).
// - Live parity: needs the loopback gateway (launchd com.mcpjungle.gateway),
//   runs only with JUNGLE_LIVE=1 — compares bridge-direct tools/list
//   (in-process mcpRouter) against the full gateway and the chatgpt group.
//   Loopback only, never public.
//
// Unit tests: FUNNEL_BASE=https://example.test bun test src/routes/jungle-parity.test.ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { BASE } from '../config'
import { mcpResource, mintTokenPair } from '../lib/oauth'
import { mcpRouter } from './mcp'

const JUNGLE_BASE = process.env.JUNGLE_URL ?? 'http://127.0.0.1:8338'
// Every scoped group door: one beads-bridge-only group each, so a new door
// whose group was created without the server (or with extra servers) fails
// parity here rather than in a client session.
const SCOPED_GROUPS = ['chatgpt', 'grok', 'gemini'] as const
const groupEndpoint = (name: string): string => `${JUNGLE_BASE}/v0/groups/${name}/mcp`

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'parity-test-')), 'store.json')
  process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'parity-tel-'))
})

// ── Pure comparator (no I/O: the failure message IS the diagnosis) ──────────

export function findMismatch(direct: string[], downstream: string[]): { missing: string[]; extra: string[] } {
  const down = new Set(downstream)
  const up = new Set(direct)
  return {
    missing: direct.filter((n) => !down.has(n)),
    extra: downstream.filter((n) => !up.has(n)),
  }
}

export function assertParity(direct: string[], downstream: string[], surface: string): void {
  const { missing, extra } = findMismatch([...direct].sort(), [...downstream].sort())
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${surface} deals a stale snapshot — missing through ${surface}: [${missing.join(', ')}]; ` +
    `unexpected through ${surface}: [${extra.join(', ')}]. ` +
    `Re-sync with ops/jungle-register-bearer.sh, then reconnect the client.`,
  )
}

describe('findMismatch', () => {
  it('passes on identical sets regardless of order', () => {
    assertParity(['b', 'a'], ['a', 'b'], 'test-surface')
  })
  it('fails naming the tool missing downstream (the 2026-10-05 shape)', () => {
    const direct = ['bead_show', 'capability', 'whoami']
    const downstream = ['bead_show', 'whoami']
    assert.throws(() => assertParity(direct, downstream, 'test-surface'), /capability/)
  })
  it('fails naming unexpected downstream extras', () => {
    assert.throws(
      () => assertParity(['a'], ['a', 'ghost_tool'], 'test-surface'),
      /ghost_tool/,
    )
  })
})

// ── Live surface comparison ──────────────────────────────────────────────────

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'parity-test', version: '0' } },
}

async function postMcp(url: string, body: unknown, sessionId?: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extraHeaders,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let json: any = null
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    try { json = JSON.parse(text) } catch { json = null }
  } else {
    const line = text.split('\n').find((l) => l.startsWith('data:'))
    json = line ? JSON.parse(line.slice(5).trim()) : null
  }
  return { status: res.status, headers: res.headers, json }
}

async function listTools(url: string): Promise<string[]> {
  const init = await postMcp(url, INIT)
  assert.equal(init.status, 200, `initialize failed at ${url}: ${JSON.stringify(init.json)?.slice(0, 200)}`)
  const sessionId = init.headers.get('mcp-session-id') ?? undefined
  const listed = await postMcp(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId)
  assert.equal(listed.status, 200, `tools/list failed at ${url}: ${JSON.stringify(listed.json)?.slice(0, 200)}`)
  const tools = listed.json?.result?.tools as Array<{ name: string }>
  assert.ok(Array.isArray(tools), `no tools array at ${url}`)
  return tools.map((t) => t.name)
}

async function withBridgeDirect(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(express.urlencoded({ extended: false, limit: '2mb' }))
  app.use(express.json({ limit: '2mb' }))
  app.use(mcpRouter)
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s))
  })
  try {
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    await fn(`http://127.0.0.1:${(addr as import('node:net').AddressInfo).port}`)
  } finally {
    server.close()
  }
}

const strip = (names: string[], prefix: string): string[] =>
  names.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length))

describe('live bridge↔jungle parity (needs JUNGLE_LIVE=1 + loopback gateway)', () => {
async function bridgeDirectTools(): Promise<string[]> {
  const pair = mintTokenPair('parity-probe', ['mcp'], mcpResource(BASE))
  const auth = { authorization: `Bearer ${pair.accessToken}` }
  let names: string[] = []
  await withBridgeDirect(async (base) => {
    const init = await postMcp(`${base}/mcp`, INIT, undefined, auth)
    assert.equal(init.status, 200, 'bridge-direct initialize failed')
    const listed = await postMcp(
      `${base}/mcp`,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      init.headers.get('mcp-session-id') ?? undefined,
      auth,
    )
    assert.equal(listed.status, 200, 'bridge-direct tools/list failed')
    const tools = listed.json?.result?.tools as Array<{ name: string }>
    assert.ok(Array.isArray(tools), 'no tools array bridge-direct')
    names = tools.map((t) => t.name)
  })
  return names
}

it('full gateway deals every bridge-direct tool (beads-bridge__*)', { timeout: 120000 }, async () => {
    if (!process.env.JUNGLE_LIVE) return
    const direct = await bridgeDirectTools()
    assert.ok(direct.length > 0 && direct.includes('capability'), 'bridge-direct must include the 1.6.0 capability tool')
    const gateway = await listTools(`${JUNGLE_BASE}/mcp`)
    assertParity(direct, strip(gateway, 'beads-bridge__'), 'jungle full gateway')
  })

for (const group of SCOPED_GROUPS) {
  it(`${group} group deals every bridge-direct tool and nothing else`, { timeout: 120000 }, async () => {
    if (!process.env.JUNGLE_LIVE) return
    const direct = await bridgeDirectTools()
    const tools = await listTools(groupEndpoint(group))
    assert.ok(tools.every((n) => n.startsWith('beads-bridge__')), `${group} group must stay beads-bridge-only`)
    assertParity(direct, strip(tools, 'beads-bridge__'), `${group} group`)
  })
}
})
