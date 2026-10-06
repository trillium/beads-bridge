// Scoped group front doors (`/chatgpt/mcp`, `/grok/mcp`, `/gemini/mcp`):
// gate matrix, wiring contract, and the live round-trip through the real
// loopback MCPJungle group.
//
// One table-driven file rather than three near-identical ones: the three doors
// share their mechanism (`src/lib/scoped-door.ts`), so the assertions that
// matter are one assertion applied per audience. The table is also what makes
// the all-pairs audience matrix — the property that must never regress —
// readable in one place instead of implied across three copies.
//
// Unit tests: FUNNEL_BASE=https://example.test bun test src/routes/scoped-doors.test.ts
// (Importing a door pulls BASE from config, so FUNNEL_BASE must be set.)
// Live tests need the loopback gateway (launchd com.mcpjungle.gateway) with the
// `chatgpt`, `grok` and `gemini` tool groups registered, and run only with
// JUNGLE_LIVE=1 — loopback only, never public.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { BASE } from '../config'
import {
  chatgptResource,
  geminiResource,
  grokResource,
  jungleResource,
  mcpResource,
  mintTokenPair,
  normalizeResource,
} from '../lib/oauth'
import { assertLoopbackUpstream } from '../lib/scoped-door'
import { CHATGPT_UPSTREAM, chatgptRouter, verifyChatgptToken } from './chatgpt'
import { GEMINI_UPSTREAM, geminiRouter, verifyGeminiToken } from './gemini'
import { GROK_UPSTREAM, grokRouter, verifyGrokToken } from './grok'
import { oauthRouter } from './oauth'

const root = join(__dirname, '..', '..')

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'scoped-door-test-')), 'store.json')
})

type Verify = (bearerToken?: string) => { token: string; clientId: string; scopes: string[] } | undefined

interface Door {
  name: string
  path: string
  upstream: string
  file: string
  verify: Verify
  resource: (base: string) => string
  router: express.Router
}

const DOORS: Door[] = [
  {
    name: 'chatgpt',
    path: '/chatgpt/mcp',
    upstream: CHATGPT_UPSTREAM,
    file: 'src/routes/chatgpt.ts',
    verify: verifyChatgptToken,
    resource: chatgptResource,
    router: chatgptRouter,
  },
  {
    name: 'grok',
    path: '/grok/mcp',
    upstream: GROK_UPSTREAM,
    file: 'src/routes/grok.ts',
    verify: verifyGrokToken,
    resource: grokResource,
    router: grokRouter,
  },
  {
    name: 'gemini',
    path: '/gemini/mcp',
    upstream: GEMINI_UPSTREAM,
    file: 'src/routes/gemini.ts',
    verify: verifyGeminiToken,
    resource: geminiResource,
    router: geminiRouter,
  },
]

// Every audience the server mints for. The OAuth server, the gates and the
// `invalid_target` rejection all read one list, so audience isolation is an
// all-pairs property, not three pairwise ones.
const AUDIENCES: { name: string; resource: (base: string) => string }[] = [
  { name: 'mcp', resource: mcpResource },
  { name: 'jungle', resource: jungleResource },
  { name: 'chatgpt', resource: chatgptResource },
  { name: 'grok', resource: grokResource },
  { name: 'gemini', resource: geminiResource },
]

// ── Audience isolation (the boundary that must never widen) ────────────────

describe('scoped door gates accept exactly one audience', () => {
  for (const door of DOORS) {
    it(`${door.name}: accepts its own audience`, () => {
      const pair = mintTokenPair(`${door.name}-scoped`, ['mcp'], door.resource(BASE))
      const auth = door.verify(pair.accessToken)
      assert.ok(auth, `${door.name} must accept its own audience`)
      assert.equal(auth?.clientId, `${door.name}-scoped`)
      assert.deepEqual(auth?.scopes, ['mcp'])
    })

    it(`${door.name}: refuses no token, empty, and garbage`, () => {
      assert.equal(door.verify(undefined), undefined)
      assert.equal(door.verify(''), undefined)
      assert.equal(door.verify('bb_at_nope'), undefined)
    })

    it(`${door.name}: refuses every OTHER audience (all-pairs)`, () => {
      for (const other of AUDIENCES) {
        if (other.name === door.name) continue
        const pair = mintTokenPair(`${door.name}-vs-${other.name}`, ['mcp'], other.resource(BASE))
        assert.equal(
          door.verify(pair.accessToken),
          undefined,
          `a ${other.name}-audience token must not open ${door.path}`,
        )
      }
    })
  }
})

// ── Loopback boundary ──────────────────────────────────────────────────────

describe('scoped door upstreams are loopback by construction', () => {
  for (const door of DOORS) {
    it(`${door.name}: pins the upstream to its loopback tool group`, () => {
      assert.equal(door.upstream, `http://127.0.0.1:8338/v0/groups/${door.name}/mcp`)
      assert.equal(new URL(door.upstream).hostname, '127.0.0.1')
    })
  }
  it('the shared factory refuses an off-loopback upstream instead of trusting a comment', () => {
    assert.throws(() => assertLoopbackUpstream('http://gateway.example:8338/v0/groups/grok/mcp'), /must be 127\.0\.0\.1/)
    assert.throws(() => assertLoopbackUpstream('http://localhost:8338/v0/groups/grok/mcp'), /must be 127\.0\.0\.1/)
    assert.doesNotThrow(() => assertLoopbackUpstream('http://127.0.0.1:8338/v0/groups/grok/mcp'))
  })
})

// ── Wiring contract (source) ───────────────────────────────────────────────

describe('scoped door wiring (source contract)', () => {
  for (const door of DOORS) {
    it(`${door.name}: declares its audience rule as exact equality in its own file`, () => {
      const code = readFileSync(join(root, door.file), 'utf8')
      assert.ok(
        code.includes(`rec.resource === ${door.name}Resource(BASE)`),
        `${door.file} must carry the exact-audience predicate`,
      )
      assert.ok(code.includes(`'${door.upstream}'`), `${door.file} must carry the loopback const verbatim`)
    })
  }
  it('the client bearer never crosses the hop: the shared hop list omits authorization', () => {
    const shared = readFileSync(join(root, 'src/lib/scoped-door.ts'), 'utf8')
    assert.ok(!shared.includes("'authorization'"))
    assert.ok(shared.includes("'mcp-session-id'"), 'the MCP headers do cross')
  })
  it('every audience lives in ONE list that both normalizeResource and the rejection message read', () => {
    const lib = readFileSync(join(root, 'src/lib/oauth.ts'), 'utf8')
    const fn = /export function audienceResources\(base: string\): string\[\] \{([\s\S]*?)\n\}/.exec(lib)
    assert.ok(fn, 'audienceResources must exist')
    for (const path of ['/mcp', '/jungle/mcp', '/chatgpt/mcp', '/grok/mcp', '/gemini/mcp']) {
      assert.ok(fn[1].includes(`\${bare}${path}`), `audienceResources must carry ${path}`)
    }
    assert.ok(
      /export function normalizeResource[\s\S]{0,300}audienceResources\(base\)/.test(lib),
      'normalizeResource must read that list rather than its own copy',
    )
    const routes = readFileSync(join(root, 'src/routes/oauth.ts'), 'utf8')
    assert.ok(
      routes.includes('audienceResources(BASE).join'),
      'the invalid_target message must read the same list, so it names every valid audience',
    )
  })
})

// ── Discovery, served for real ─────────────────────────────────────────────

async function withOauth(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(express.urlencoded({ extended: false, limit: '2mb' }))
  app.use(express.json({ limit: '2mb' }))
  app.use(oauthRouter)
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

describe('discovery serves every scoped audience', { timeout: 30000 }, () => {
  it('protected-resource metadata names each door resource exactly', async () => {
    await withOauth(async (base) => {
      for (const door of DOORS) {
        const res = await fetch(`${base}/.well-known/oauth-protected-resource${door.path}`)
        assert.equal(res.status, 200, `${door.path} discovery must be mounted`)
        const body = (await res.json()) as { resource?: string; authorization_servers?: string[] }
        assert.equal(body.resource, door.resource(BASE))
        assert.deepEqual(body.authorization_servers, [BASE])
      }
    })
  })
  it('authorization-server metadata is served at each door suffix', async () => {
    await withOauth(async (base) => {
      for (const door of DOORS) {
        const res = await fetch(`${base}/.well-known/oauth-authorization-server${door.path}`)
        assert.equal(res.status, 200, `${door.path} issuer metadata must be mounted`)
        const body = (await res.json()) as { issuer?: string }
        assert.equal(body.issuer, BASE)
      }
    })
  })
  it('an unknown audience is still not a resource (the list did not become a prefix match)', async () => {
    assert.equal(normalizeResource(BASE, `${BASE}/grok/mcp`), `${BASE}/grok/mcp`)
    assert.equal(normalizeResource(BASE, `${BASE}/grok/mcp/`), `${BASE}/grok/mcp`)
    for (const bogus of ['/grok/mcpx', '/grok', '/x/grok/mcp', '/GROK/MCP']) {
      assert.equal(normalizeResource(BASE, `${BASE}${bogus}`), null, `${bogus} must not normalize`)
    }
  })
})

// ── Live front-door proof through the real loopback gateway ────────────────

async function rpc(url: string, body: unknown, token?: string, sessionId?: string): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
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

describe('scoped front doors live (needs JUNGLE_LIVE=1 + loopback gateway)', () => {
  it('401 challenge without a token, then the door’s own audience reaches its beads-bridge-only group', { timeout: 180000 }, async () => {
    // node:test skip options are not honored by every runner (bun runs the
    // body anyway), so guard here: without an explicit opt-in this is a
    // trivial pass on machines with no gateway.
    if (!process.env.JUNGLE_LIVE) return
    const app = express()
    app.use(express.json({ limit: '2mb' }))
    for (const door of DOORS) app.use(door.router)
    const server = await new Promise<import('node:http').Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s))
    })
    try {
      const addr = server.address()
      assert.ok(addr && typeof addr === 'object')
      const base = `http://127.0.0.1:${(addr as import('node:net').AddressInfo).port}`

      for (const door of DOORS) {
        const url = `${base}${door.path}`

        // No token: refused with an RFC 9728 challenge naming THIS door's
        // audience, never proxied.
        const denied = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        assert.equal(denied.status, 401, `${door.path} must refuse anonymous callers`)
        assert.match(
          denied.headers.get('www-authenticate') ?? '',
          new RegExp(`oauth-protected-resource${door.path}`),
          `${door.path} challenge must point at its own metadata`,
        )

        // A sibling door's token stays out.
        const sibling = door.name === 'chatgpt' ? geminiResource : chatgptResource
        const wrong = mintTokenPair(`${door.name}-wrong-door`, ['mcp'], sibling(BASE))
        const refused = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, wrong.accessToken)
        assert.equal(refused.status, 401, `${door.path} must not cross-accept a sibling audience`)

        // Own audience: initialize, then tools/list through the real gateway
        // group.
        const pair = mintTokenPair(`${door.name}-live-probe`, ['mcp'], door.resource(BASE))
        const init = await rpc(
          url,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: `${door.name}-test`, version: '0' } },
          },
          pair.accessToken,
        )
        assert.equal(init.status, 200, `${door.path} initialize: ${JSON.stringify(init.json)?.slice(0, 300)}`)
        const listed = await rpc(
          url,
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
          pair.accessToken,
          init.headers.get('mcp-session-id') ?? undefined,
        )
        assert.equal(listed.status, 200, `${door.path} tools/list: ${JSON.stringify(listed.json)?.slice(0, 300)}`)
        const tools = listed.json?.result?.tools as Array<{ name: string }>
        assert.ok(Array.isArray(tools), `no tools array for ${door.path}: ${JSON.stringify(listed.json)?.slice(0, 300)}`)
        assert.ok(tools.length > 0, `${door.name} group must not be empty`)
        assert.ok(
          tools.every((t) => t.name.startsWith('beads-bridge__')),
          `${door.name} group is beads-bridge-only: ${tools.map((t) => t.name).slice(0, 5).join(', ')}`,
        )
        for (const other of ['firstmate_mcp__', 'interceptor__', 'apple-notes__', 'agent-mail', 'coding-standards']) {
          assert.ok(
            tools.every((t) => !t.name.startsWith(other)),
            `${door.name} group must not leak ${other}`,
          )
        }
      }
    } finally {
      server.close()
    }
  })
})
