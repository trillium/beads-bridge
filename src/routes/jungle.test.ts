// Jungle front-door auth-gate regression tests (task-jhdil).
// Unit tests: FUNNEL_BASE=https://example.test bun test src/routes/jungle.test.ts
// (Importing the route pulls BASE from config, so run with FUNNEL_BASE set.)
// Live tests need the loopback gateway (launchd com.mcpjungle.gateway) and
// run only with JUNGLE_LIVE=1 — loopback only, never public.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import express from 'express'
import { BASE } from '../config'
import { jungleResource, mcpResource, mintTokenPair } from '../lib/oauth'
import { JUNGLE_UPSTREAM, jungleRouter, verifyJungleToken } from './jungle'

const root = join(__dirname, '..', '..')

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'jungle-test-')), 'store.json')
})

describe('verifyJungleToken', () => {
  it('refuses no token and garbage', () => {
    assert.equal(verifyJungleToken(undefined), undefined)
    assert.equal(verifyJungleToken(''), undefined)
    assert.equal(verifyJungleToken('bb_at_nope'), undefined)
  })
  it('refuses a bridge-direct (/mcp audience) token — no cross-accept', () => {
    const pair = mintTokenPair('chatgpt-front', ['mcp'], mcpResource(BASE))
    assert.equal(verifyJungleToken(pair.accessToken), undefined)
  })
  it('accepts a jungle-audience token', () => {
    const pair = mintTokenPair('chatgpt-jungle', ['mcp'], jungleResource(BASE))
    const auth = verifyJungleToken(pair.accessToken)
    assert.ok(auth)
    assert.equal(auth?.clientId, 'chatgpt-jungle')
    assert.deepEqual(auth?.scopes, ['mcp'])
  })
})

describe('jungle wiring (source contract)', () => {
  it('pins the upstream to loopback :8338 — never off-loopback', () => {
    assert.equal(JUNGLE_UPSTREAM, 'http://127.0.0.1:8338/mcp')
  })
  it('serves OAuth discovery for the jungle audience', () => {
    const oauth = readFileSync(join(root, 'src/routes/oauth.ts'), 'utf8')
    assert.ok(oauth.includes("'/.well-known/oauth-protected-resource/jungle/mcp'"))
    assert.ok(oauth.includes("'/.well-known/oauth-authorization-server/jungle/mcp'"))
  })
  it('keeps the jungle gate on the jungle audience (exact equality)', () => {
    const code = readFileSync(join(root, 'src/routes/jungle.ts'), 'utf8')
    assert.ok(code.includes('rec.resource !== jungleResource(BASE)'))
    assert.ok(!code.includes("'authorization'"), 'client bearer never crosses the loopback hop')
  })
  it('leaves the bridge-direct /mcp gate on its own audience', () => {
    const mcp = readFileSync(join(root, 'src/routes/mcp.ts'), 'utf8')
    assert.ok(mcp.includes('rec.resource !== mcpResource(BASE)'))
  })
  it('lets the access gate pass the front door for public clients', () => {
    const server = readFileSync(join(root, 'src/server.ts'), 'utf8')
    assert.ok(server.includes("'/jungle/mcp'"))
  })
})

// Live front-door proof through the real loopback gateway. Skipped unless
// JUNGLE_LIVE=1: requires the launchd gateway with beads-bridge registered.
async function rpc(base: string, body: unknown, token?: string, sessionId?: string): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`${base}/jungle/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let json: any = null
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    json = JSON.parse(text)
  } else {
    // Streamable HTTP SSE: first data: line carries the JSON-RPC message.
    const line = text.split('\n').find((l) => l.startsWith('data:'))
    json = line ? JSON.parse(line.slice(5).trim()) : null
  }
  return { status: res.status, headers: res.headers, json }
}

describe('jungle front door live (needs JUNGLE_LIVE=1 + loopback gateway)', () => {
  it('refuses unauthenticated calls, serves 36 prefixed tools to a jungle-audience token', { timeout: 120000 }, async () => {
    // node:test skip options are not honored by every runner (bun runs the
    // body anyway), so guard here: without an explicit opt-in this is a
    // trivial pass on machines with no gateway.
    if (!process.env.JUNGLE_LIVE) return
    const app = express()
    app.use(express.json({ limit: '2mb' }))
    app.use(jungleRouter)
    const server = await new Promise<import('node:http').Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s))
    })
    try {
      const addr = server.address()
      assert.ok(addr && typeof addr === 'object')
      const base = `http://127.0.0.1:${(addr as import('node:net').AddressInfo).port}`

      // No token: refused with an RFC 9728 challenge, never proxied.
      const denied = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      assert.equal(denied.status, 401)
      assert.match(
        denied.headers.get('www-authenticate') ?? '',
        /oauth-protected-resource\/jungle\/mcp/,
      )

      // Valid jungle-audience flow: initialize, then tools/list.
      const pair = mintTokenPair('jungle-live-probe', ['mcp'], jungleResource(BASE))
      const init = await rpc(
        base,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'jungle-test', version: '0' } },
        },
        pair.accessToken,
      )
      assert.equal(init.status, 200, JSON.stringify(init.json)?.slice(0, 300))
      const sessionId = init.headers.get('mcp-session-id') ?? undefined
      const listed = await rpc(
        base,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        pair.accessToken,
        sessionId,
      )
      assert.equal(listed.status, 200, JSON.stringify(listed.json)?.slice(0, 300))
      const tools = listed.json?.result?.tools as Array<{ name: string }>
      assert.ok(Array.isArray(tools), `no tools array: ${JSON.stringify(listed.json)?.slice(0, 300)}`)
      const bb = tools.filter((t) => t.name.startsWith('beads-bridge__'))
      assert.equal(bb.length, 36)
      assert.ok(tools.every((t) => t.name.includes('__')), 'every gateway tool carries its server prefix')
    } finally {
      server.close()
    }
  })
})
