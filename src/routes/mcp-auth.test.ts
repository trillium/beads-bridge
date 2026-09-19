// /mcp loopback-service-bearer regression tests (task-y1i3e).
//
// The MCPJungle gateway calls /mcp from 127.0.0.1 with a static bearer.
// A static OAuth access token (24h TTL) silently 401s days later — the
// 2026-09-18 outage — so the bridge also accepts its own never-expiring
// service key on true direct-loopback sockets only. These tests pin:
//   - OAuth /mcp-audience tokens still work; jungle-audience tokens don't
//     cross-accept; garbage/anonymous still get the RFC 9728 challenge.
//   - The service key works on direct loopback and is rejected the moment
//     the request looks Funnel-forwarded (forwarding headers present).
// Unit tests: FUNNEL_BASE=https://example.test bun test src/routes/mcp-auth.test.ts
// (Importing the route pulls toolKey/BASE from config, so FUNNEL_BASE must
// be set. OAuth + telemetry state are isolated per test via temp dirs —
/// the live bridge store is never touched.)
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { Request } from 'express'
import { BASE, toolKey } from '../config'
import { jungleResource, mcpResource, mintTokenPair } from '../lib/oauth'
import { isLoopbackServiceCall, mcpRouter } from './mcp'

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'mcp-auth-test-')), 'store.json')
  process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'mcp-auth-tel-'))
})

// Minimal fake request for the pure classifier: only what it reads
// (socket.remoteAddress, headers.authorization, req.get).
function fakeReq(opts: {
  peer?: string
  headers?: Record<string, string>
}): Request {
  const lowered: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) lowered[k.toLowerCase()] = v
  return {
    socket: { remoteAddress: opts.peer ?? '127.0.0.1' },
    headers: lowered,
    get(h: string): string | undefined {
      return lowered[h.toLowerCase()]
    },
  } as unknown as Request
}

describe('isLoopbackServiceCall', () => {
  it('accepts the service key on direct loopback', () => {
    assert.equal(
      isLoopbackServiceCall(fakeReq({ headers: { authorization: `Bearer ${toolKey}` } })),
      true,
    )
  })
  it('accepts IPv6 loopback forms', () => {
    for (const peer of ['::1', '::ffff:127.0.0.1']) {
      assert.equal(
        isLoopbackServiceCall(fakeReq({ peer, headers: { authorization: `Bearer ${toolKey}` } })),
        true,
        peer,
      )
    }
  })
  it('rejects the service key with forwarding headers (Funnel shape)', () => {
    assert.equal(
      isLoopbackServiceCall(
        fakeReq({
          headers: {
            authorization: `Bearer ${toolKey}`,
            'x-forwarded-for': '203.0.113.7',
            'x-forwarded-proto': 'https',
          },
        }),
      ),
      false,
    )
  })
  it('rejects the service key off loopback (tailnet, LAN, public)', () => {
    for (const peer of ['100.84.3.5', '192.168.1.5', '203.0.113.7']) {
      assert.equal(
        isLoopbackServiceCall(fakeReq({ peer, headers: { authorization: `Bearer ${toolKey}` } })),
        false,
        peer,
      )
    }
  })
  it('rejects garbage, missing, and non-Bearer credentials', () => {
    assert.equal(isLoopbackServiceCall(fakeReq({ headers: { authorization: 'Bearer bb_at_nope' } })), false)
    assert.equal(isLoopbackServiceCall(fakeReq({ headers: {} })), false)
    assert.equal(
      isLoopbackServiceCall(fakeReq({ headers: { authorization: `Basic ${toolKey}` } })),
      false,
    )
  })
  it('rejects OAuth tokens — they stay on the OAuth gate, not this path', () => {
    const pair = mintTokenPair('oauth-probe', ['mcp'], mcpResource(BASE))
    assert.equal(
      isLoopbackServiceCall(fakeReq({ headers: { authorization: `Bearer ${pair.accessToken}` } })),
      false,
    )
  })
})

async function rpc(
  base: string,
  body: unknown,
  token?: string,
  sessionId?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extraHeaders,
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let json: any = null
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  } else {
    const line = text.split('\n').find((l) => l.startsWith('data:'))
    json = line ? JSON.parse(line.slice(5).trim()) : null
  }
  return { status: res.status, headers: res.headers, json }
}

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
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

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-auth-test', version: '0' } },
}

async function toolNames(base: string, token: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; names: string[] }> {
  const init = await rpc(base, INIT, token, undefined, extraHeaders)
  assert.equal(init.status, 200, `initialize failed: ${JSON.stringify(init.json)?.slice(0, 300)}`)
  const sessionId = init.headers.get('mcp-session-id') ?? undefined
  const listed = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token, sessionId, extraHeaders)
  assert.equal(listed.status, 200, `tools/list failed: ${JSON.stringify(listed.json)?.slice(0, 300)}`)
  const tools = listed.json?.result?.tools as Array<{ name: string }>
  assert.ok(Array.isArray(tools), `no tools array: ${JSON.stringify(listed.json)?.slice(0, 300)}`)
  return { status: listed.status, names: tools.map((t) => t.name) }
}

describe('/mcp over HTTP (dual-gate contract)', () => {
  it('OAuth /mcp-audience token lists unprefixed tools (existing path intact)', { timeout: 30000 }, async () => {
    const pair = mintTokenPair('chatgpt-direct', ['mcp'], mcpResource(BASE))
    await withApp(async (base) => {
      const { names } = await toolNames(base, pair.accessToken)
      assert.ok(names.length > 0)
      assert.ok(names.includes('query_store'))
      assert.ok(names.every((n) => !n.includes('__')), 'bridge-direct tools carry no server prefix')
    })
  })

  it('service key on direct loopback lists the same tools (gateway path)', { timeout: 30000 }, async () => {
    await withApp(async (base) => {
      const { names } = await toolNames(base, toolKey)
      assert.ok(names.includes('query_store'))
      assert.ok(names.includes('whoami'))
    })
  })

  it('service key with a forwarding header is rejected (off-host shape)', { timeout: 30000 }, async () => {
    await withApp(async (base) => {
      const denied = await rpc(
        base,
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        toolKey,
        undefined,
        { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' },
      )
      assert.equal(denied.status, 401)
    })
  })

  it('jungle-audience token does not cross-accept on /mcp', { timeout: 30000 }, async () => {
    const pair = mintTokenPair('chatgpt-jungle', ['mcp'], jungleResource(BASE))
    await withApp(async (base) => {
      const denied = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, pair.accessToken)
      assert.equal(denied.status, 401)
    })
  })

  it('anonymous and garbage callers get the RFC 9728 challenge, never tools', { timeout: 30000 }, async () => {
    await withApp(async (base) => {
      const anon = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      assert.equal(anon.status, 401)
      assert.match(anon.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp/)
      const garbage = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 'bb_at_nope')
      assert.equal(garbage.status, 401)
    })
  })
})
