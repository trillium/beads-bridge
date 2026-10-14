// Credential-failure boundary contract for the bridge's public MCP doors.
//
// Why: a ChatGPT MCP client failed with `INVALID_ARGUMENT McpServerError:
// Session terminated` — nothing in that string says the credential is the
// problem or that re-authenticating is the fix. This suite pins what a client
// receives for the four credential states on every door a connector can use:
//
//   no token | malformed token | well-formed but expired token | valid token
//
// Layer choice: the credential boundary lives HERE (withMcpAuth in the bridge
// doors), not in MCPJungle. The gateway (127.0.0.1:8338) and the session proxy
// (127.0.0.1:8337) accept any bearer, or none, on loopback — see
// docs/auth-boundary.md for captured evidence. So the bridge door is the only
// place a distinguishable auth failure can be asserted.
//
// Status: the boundary meets the full contract. Each failure case carries a
// distinct, truthful error_description (status 401, the Bearer challenge with
// resource_metadata and error=invalid_token stay stable). See
// docs/auth-boundary.md.
//
// Hermetic: FUNNEL_BASE=https://example.test bun test src/routes/auth-boundary.test.ts
// OAuth store + telemetry live in temp dirs; the loopback gateway upstream is
// stubbed, so no live store or gateway is touched.
// Live (opt-in, read-only — `initialize` POSTs only, no tokens printed):
//   AUTH_BOUNDARY_LIVE=1 FUNNEL_BASE=... bun test src/routes/auth-boundary.test.ts
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { BASE, toolKey } from '../config'
import { chatgptResource, jungleResource, loadStore, mcpResource, mintTokenPair, saveStore } from '../lib/oauth'
import { chatgptRouter } from './chatgpt'
import { jungleRouter } from './jungle'
import { mcpRouter } from './mcp'

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'auth-boundary-test', version: '0' } },
}

// Well-formed (bb_at_ + 24 chars, the minted shape) but never issued/expired.
const EXPIRED_TOKEN = 'bb_at_expiredexpiredexpiredxx'
const UNKNOWN_TOKEN = 'bb_at_neverissuedneverissuedx'
const MALFORMED_TOKEN = 'not-a-token'

interface Door {
  name: string
  path: string
  resource: (base: string) => string
}
const DOORS: Door[] = [
  { name: '/mcp (bridge-direct)', path: '/mcp', resource: mcpResource },
  { name: '/chatgpt/mcp (ChatGPT scoped door)', path: '/chatgpt/mcp', resource: chatgptResource },
  { name: '/jungle/mcp (full-gateway door)', path: '/jungle/mcp', resource: jungleResource },
]

interface Outcome {
  status: number
  wwwAuthenticate: string | null
  body: { error?: string; error_description?: string; result?: unknown } | null
  raw: string
}

async function call(base: string, path: string, token?: string): Promise<Outcome> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(INIT) })
  const raw = await res.text()
  let body: Outcome['body'] = null
  try {
    body = JSON.parse(raw)
  } catch {
    const line = raw.split('\n').find((l) => l.startsWith('data:'))
    if (line) body = JSON.parse(line.slice(5).trim())
  }
  return { status: res.status, wwwAuthenticate: res.headers.get('www-authenticate'), body, raw }
}

// Seed a token record that is well-formed but already past its expiry.
// loadStore() prunes it on read and leaves a hashed tombstone, which is how
// the gate tells "expired" from "never issued".
function seedExpiredToken(resource: string): void {
  const store = JSON.parse(JSON.stringify(loadStore()))
  store.access[EXPIRED_TOKEN] = { clientId: 'auth-boundary-test', scope: ['mcp'], resource, expiresAt: Date.now() - 60_000 }
  writeFileSync(process.env.OAUTH_STORE_PATH!, JSON.stringify(store))
}

// ── The contract ─────────────────────────────────────────────────────────────
// Mirror of docs/auth-boundary.md. Each predicate is one clause of "clear
// error boundary"; none is relaxed to match current behavior.
const REAUTH_HINT = /re-?authenticat|re-?authori[sz]|reconnect|sign in again|authorize again/i

function expectChallenge(o: Outcome): void {
  assert.equal(o.status, 401)
  assert.match(o.wwwAuthenticate ?? '', /^Bearer /)
  assert.ok((o.wwwAuthenticate ?? '').includes('resource_metadata='))
  assert.equal(typeof o.body?.error, 'string')
  assert.equal(typeof o.body?.error_description, 'string')
}

// Stable for every case: every credential failure is an HTTP 401 Bearer challenge with
// a machine-readable error code, never a 200/5xx or a session-level error.
function expectAuthFailureShape(o: Outcome): void {
  expectChallenge(o)
  assert.equal(o.body?.error, 'invalid_token')
}

// Missing credential must say it is missing.
function expectMissingCredential(o: Outcome): void {
  expectAuthFailureShape(o)
  assert.match(o.body?.error_description ?? '', /no authorization|missing|not provided/i)
}

// A PRESENT-but-bad credential must say the credential is the problem and that
// re-authenticating is the fix, and must not claim nothing was sent.
function expectCredentialProblem(o: Outcome, kind: RegExp): void {
  expectAuthFailureShape(o)
  const d = o.body?.error_description ?? ''
  assert.doesNotMatch(d, /no authorization/i)
  assert.match(d, kind)
  assert.match(d, REAUTH_HINT)
}

function descriptionOf(o: Outcome): string {
  return o.body?.error_description ?? ''
}

// ── Hermetic suite ───────────────────────────────────────────────────────────

const realFetch = globalThis.fetch
let server: import('node:http').Server
let base = ''
const upstreamHits: string[] = []

before(async () => {
  // Stub only the loopback gateway hop for the valid-token case on the proxy
  // doors; everything else (the test's own requests) passes through.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('http://127.0.0.1:8338/')) {
      upstreamHits.push(url)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'stub-gateway', version: '0' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return realFetch(input, init)
  }) as typeof fetch
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use(mcpRouter)
  app.use(chatgptRouter)
  app.use(jungleRouter)
  server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => {
  globalThis.fetch = realFetch
  server?.close()
})

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'auth-boundary-')), 'store.json')
  process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'auth-boundary-tel-'))
  upstreamHits.length = 0
})

for (const door of DOORS) {
  describe(`credential boundary: ${door.name}`, () => {
    it('valid token → 200 initialize result, no auth challenge', { timeout: 30000 }, async () => {
      const pair = mintTokenPair('auth-boundary-test', ['mcp'], door.resource(BASE))
      const o = await call(base, door.path, pair.accessToken)
      assert.equal(o.status, 200)
      assert.equal(o.wwwAuthenticate, null)
      assert.ok(o.body?.result !== undefined)
    })

    it('no token → 401 Bearer challenge naming a missing credential', { timeout: 30000 }, async () => {
      const o = await call(base, door.path)
      expectMissingCredential(o)
      assert.deepEqual(upstreamHits, []) // refused before any proxy hop
    })

    it('malformed token → 401 invalid_token saying the credential is invalid and to re-authenticate', { timeout: 30000 }, async () => {
      const o = await call(base, door.path, MALFORMED_TOKEN)
      expectCredentialProblem(o, /malformed|invalid/i)
      assert.deepEqual(upstreamHits, [])
    })

    it('expired token → 401 invalid_token saying it expired and to re-authenticate', { timeout: 30000 }, async () => {
      seedExpiredToken(door.resource(BASE))
      const o = await call(base, door.path, EXPIRED_TOKEN)
      expectCredentialProblem(o, /expired/i)
      assert.deepEqual(upstreamHits, [])
    })

    it('expired token stays "expired" after the store has been saved (tombstone persisted)', { timeout: 30000 }, async () => {
      seedExpiredToken(door.resource(BASE))
      saveStore(loadStore()) // a write prunes the record to a tombstone on disk
      assert.ok(!(EXPIRED_TOKEN in JSON.parse(readFileSync(process.env.OAUTH_STORE_PATH!, 'utf8')).access))
      expectCredentialProblem(await call(base, door.path, EXPIRED_TOKEN), /expired/i)
    })

    it('well-formed but never-issued token → 401 invalid_token, not "expired", with re-authenticate', { timeout: 30000 }, async () => {
      const o = await call(base, door.path, UNKNOWN_TOKEN)
      expectCredentialProblem(o, /not recognized|invalid/i)
      assert.doesNotMatch(descriptionOf(o), /expired/i)
    })

    it('valid token minted for another door → 401 naming the wrong endpoint, not "no authorization"', { timeout: 30000 }, async () => {
      const other = DOORS.find((d) => d !== door)!
      const pair = mintTokenPair('auth-boundary-test', ['mcp'], other.resource(BASE))
      const o = await call(base, door.path, pair.accessToken)
      expectCredentialProblem(o, /different endpoint/i)
      assert.deepEqual(upstreamHits, [])
    })

    it('none / malformed / unknown / expired are pairwise distinguishable', { timeout: 30000 }, async () => {
      seedExpiredToken(door.resource(BASE))
      const descriptions = [
        descriptionOf(await call(base, door.path)),
        descriptionOf(await call(base, door.path, MALFORMED_TOKEN)),
        descriptionOf(await call(base, door.path, UNKNOWN_TOKEN)),
        descriptionOf(await call(base, door.path, EXPIRED_TOKEN)),
      ]
      assert.equal(new Set(descriptions).size, 4)
    })

    it('challenge header description matches the JSON body and never echoes the token', { timeout: 30000 }, async () => {
      seedExpiredToken(door.resource(BASE))
      for (const token of [MALFORMED_TOKEN, UNKNOWN_TOKEN, EXPIRED_TOKEN]) {
        const o = await call(base, door.path, token)
        assert.ok((o.wwwAuthenticate ?? '').includes(`error_description="${descriptionOf(o)}"`))
        assert.ok((o.wwwAuthenticate ?? '').includes('error="invalid_token"'))
        assert.ok(!o.raw.includes(token) && !(o.wwwAuthenticate ?? '').includes(token))
      }
    })
  })
}

describe('credential boundary: doors agree', () => {
  it('a given failure case yields the same status and body on every door', { timeout: 60000 }, async () => {
    seedExpiredToken(mcpResource(BASE))
    for (const token of [undefined, MALFORMED_TOKEN, UNKNOWN_TOKEN, EXPIRED_TOKEN]) {
      const outs = await Promise.all(DOORS.map((d) => call(base, d.path, token)))
      for (const o of outs) {
        assert.equal(o.status, outs[0].status)
        assert.equal(o.raw, outs[0].raw)
      }
    }
  })
})

// ── Live suite (opt-in, read-only) ───────────────────────────────────────────
// Probes a running bridge over loopback with `initialize` only — the bridge is
// stateless there, so nothing is created or changed. The valid case uses the
// service key on /mcp (never printed; failure output is the response body).
// The scoped doors have no valid-token live case: minting a chatgpt-audience
// token would write to the production OAuth store.
const LIVE = process.env.AUTH_BOUNDARY_LIVE === '1'
const LIVE_BASE = process.env.AUTH_BOUNDARY_LIVE_BASE ?? 'http://127.0.0.1:3737'

// bun ignores node:test's `{ skip }` option, so pick the function instead.
;(LIVE ? describe : describe.skip)('credential boundary: live bridge (read-only)', () => {
  for (const path of ['/mcp', '/chatgpt/mcp']) {
    it(`${path}: no token → 401 Bearer challenge`, { timeout: 30000 }, async () => {
      expectMissingCredential(await call(LIVE_BASE, path))
    })
    it(`${path}: malformed and unknown tokens → 401 invalid_token`, { timeout: 30000 }, async () => {
      expectAuthFailureShape(await call(LIVE_BASE, path, MALFORMED_TOKEN))
      expectAuthFailureShape(await call(LIVE_BASE, path, EXPIRED_TOKEN))
    })
    // Only meaningful against a bridge running this build; an older process
    // still answers "No authorization provided" until it is redeployed.
    it(`${path}: bad credential says invalid + re-authenticate`, { timeout: 30000 }, async () => {
      expectCredentialProblem(await call(LIVE_BASE, path, MALFORMED_TOKEN), /malformed|invalid/i)
    })
  }
  it('/mcp: service key on loopback → 200 initialize result', { timeout: 30000 }, async () => {
    const o = await call(LIVE_BASE, '/mcp', toolKey)
    assert.equal(o.status, 200)
    assert.ok(o.body?.result !== undefined)
  })
})
