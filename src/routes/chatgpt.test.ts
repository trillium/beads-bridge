// Scoped ChatGPT front-door auth-gate regression tests (mirrors jungle.test.ts).
// Unit tests: FUNNEL_BASE=https://example.test bun test src/routes/chatgpt.test.ts
// (Importing the route pulls BASE from config, so run with FUNNEL_BASE set.)
// Live tests need the loopback gateway (launchd com.mcpjungle.gateway) with
// the `chatgpt` tool group registered, and run only with JUNGLE_LIVE=1 —
// loopback only, never public.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import express from 'express'
import { BASE } from '../config'
import { chatgptResource, geminiResource, grokResource, jungleResource, mcpResource, mintTokenPair } from '../lib/oauth'
import { CHATGPT_UPSTREAM, chatgptRouter, verifyChatgptToken } from './chatgpt'

const root = join(__dirname, '..', '..')

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'chatgpt-test-')), 'store.json')
})

describe('verifyChatgptToken', () => {
  it('refuses no token and garbage', () => {
    assert.equal(verifyChatgptToken(undefined), undefined)
    assert.equal(verifyChatgptToken(''), undefined)
    assert.equal(verifyChatgptToken('bb_at_nope'), undefined)
  })
  it('refuses bridge-direct (/mcp) and full-jungle tokens — no cross-accept', () => {
    const direct = mintTokenPair('chatgpt-front', ['mcp'], mcpResource(BASE))
    assert.equal(verifyChatgptToken(direct.accessToken), undefined)
    const jungle = mintTokenPair('chatgpt-jungle', ['mcp'], jungleResource(BASE))
    assert.equal(verifyChatgptToken(jungle.accessToken), undefined)
  })
  it('refuses the sibling scoped doors — grok and gemini tokens never open chatgpt', () => {
    const grok = mintTokenPair('grok-scoped', ['mcp'], grokResource(BASE))
    assert.equal(verifyChatgptToken(grok.accessToken), undefined)
    const gemini = mintTokenPair('gemini-scoped', ['mcp'], geminiResource(BASE))
    assert.equal(verifyChatgptToken(gemini.accessToken), undefined)
  })
  it('accepts a chatgpt-audience token', () => {
    const pair = mintTokenPair('chatgpt-scoped', ['mcp'], chatgptResource(BASE))
    const auth = verifyChatgptToken(pair.accessToken)
    assert.ok(auth)
    assert.equal(auth?.clientId, 'chatgpt-scoped')
    assert.deepEqual(auth?.scopes, ['mcp'])
  })
})

describe('chatgpt wiring (source contract)', () => {
  it('pins the upstream to the loopback chatgpt group — never off-loopback, never the full gateway', () => {
    assert.equal(CHATGPT_UPSTREAM, 'http://127.0.0.1:8338/v0/groups/chatgpt/mcp')
  })
  it('serves OAuth discovery for the chatgpt audience', () => {
    const oauth = readFileSync(join(root, 'src/routes/oauth.ts'), 'utf8')
    assert.ok(oauth.includes("'/.well-known/oauth-protected-resource/chatgpt/mcp'"))
    assert.ok(oauth.includes("'/.well-known/oauth-authorization-server/chatgpt/mcp'"))
  })
  it('keeps the chatgpt gate on the chatgpt audience (exact equality)', () => {
    const code = readFileSync(join(root, 'src/routes/chatgpt.ts'), 'utf8')
    assert.ok(
      code.includes('rec.resource === chatgptResource(BASE)'),
      'the audience rule is exact equality, declared in this door\'s own file',
    )
  })
  it('keeps the client bearer off the loopback hop', () => {
    // The hop mechanism lives in the shared factory now; the rule is asserted
    // where a new door would have to break it (see scoped-door.test.ts).
    const shared = readFileSync(join(root, 'src/lib/scoped-door.ts'), 'utf8')
    assert.ok(!shared.includes("'authorization'"), 'client bearer never crosses the loopback hop')
  })
  it('lets the access gate pass the front door for public clients', () => {
    const gate = readFileSync(join(root, 'src/lib/access-gate.ts'), 'utf8')
    assert.ok(gate.includes("'/chatgpt/mcp'"))
    const server = readFileSync(join(root, 'src/server.ts'), 'utf8')
    assert.ok(server.includes('accessGate'), 'server.ts must wire the access gate')
  })
  it('accepts the chatgpt audience in resource normalization', () => {
    const lib = readFileSync(join(root, 'src/lib/oauth.ts'), 'utf8')
    assert.ok(lib.includes('/chatgpt/mcp'))
    assert.ok(lib.includes('export function chatgptResource'))
  })
})

// Live front-door proof through the real loopback gateway. Skipped unless
// JUNGLE_LIVE=1: requires the launchd gateway with the `chatgpt` tool group
// (beads-bridge only) registered.
async function rpc(base: string, body: unknown, token?: string, sessionId?: string): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`${base}/chatgpt/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
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

describe('chatgpt front door live (needs JUNGLE_LIVE=1 + loopback gateway)', () => {
  it('refuses unauthenticated calls, serves beads-bridge-only tools to a chatgpt-audience token', { timeout: 120000 }, async () => {
    // node:test skip options are not honored by every runner (bun runs the
    // body anyway), so guard here: without an explicit opt-in this is a
    // trivial pass on machines with no gateway.
    if (!process.env.JUNGLE_LIVE) return
    const app = express()
    app.use(express.json({ limit: '2mb' }))
    app.use(chatgptRouter)
    const server = await new Promise<import('node:http').Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s))
    })
    try {
      const addr = server.address()
      assert.ok(addr && typeof addr === 'object')
      const base = `http://127.0.0.1:${(addr as import('node:net').AddressInfo).port}`

      // No token: refused with an RFC 9728 challenge naming the chatgpt
      // audience, never proxied.
      const denied = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      assert.equal(denied.status, 401)
      assert.match(
        denied.headers.get('www-authenticate') ?? '',
        /oauth-protected-resource\/chatgpt\/mcp/,
      )

      // Wrong-audience tokens stay out too.
      const wrong = mintTokenPair('chatgpt-wrong', ['mcp'], jungleResource(BASE))
      const refused = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, wrong.accessToken)
      assert.equal(refused.status, 401)

      // Valid chatgpt-audience flow: initialize, then tools/list.
      const pair = mintTokenPair('chatgpt-live-probe', ['mcp'], chatgptResource(BASE))
      const init = await rpc(
        base,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'chatgpt-test', version: '0' } },
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
      assert.ok(tools.length > 0, 'scoped group must not be empty')
      assert.ok(
        tools.every((t) => t.name.startsWith('beads-bridge__')),
        `every scoped tool is beads-bridge-only: ${tools.map((t) => t.name).slice(0, 5).join(', ')}`,
      )
      for (const other of ['firstmate_mcp__', 'interceptor__', 'apple-notes__', 'agent-mail', 'coding-standards']) {
        assert.ok(
          tools.every((t) => !t.name.startsWith(other)),
          `no leakage from other servers (checked ${other})`,
        )
      }
    } finally {
      server.close()
    }
  })
})
