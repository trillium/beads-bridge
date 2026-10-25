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
import { createHash, randomBytes } from 'node:crypto'
import { APPROVAL_PORT, BASE, toolKey } from '../config'
import { accessGate } from '../lib/access-gate'
import { audienceResources, chatgptResource, jungleResource, loadStore, lookupAccess, mcpResource, mintTokenPair, saveStore } from '../lib/oauth'
import { pending } from '../lib/oauth-tx'
import { createTailnetApprovalApp } from '../lib/tailnet-approval'
import * as oauthLibNs from '../lib/oauth'
import * as oauthRouteNs from './oauth'
import { oauthRouter } from './oauth'
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

// ── Approval boundary: the human grant is tailnet-only ───────────────────────
// The public listener (access gate + oauthRouter) and the tailnet listener
// (createTailnetApprovalApp) are separate Express apps, exactly as server.ts
// binds them. The tailnet app's socket peer is injected (a test server can
// only be reached from loopback); the public app has no such seam, so any
// "tailnet-range address on the public listener" is a header-only claim.
describe('approval boundary: tailnet-only QR approval', () => {
  const TAILNET_PEER = { 'x-test-peer': '100.100.1.2' }
  const REDIRECT = 'https://app.example/cb'
  let pub: import('node:http').Server
  let tail: import('node:http').Server
  let pubBase = ''
  let tailBase = ''
  const priorTailnetIp = process.env.TAILNET_IP

  before(async () => {
    process.env.TAILNET_IP = '100.64.9.9'
    const listen = (app: express.Express): Promise<import('node:http').Server> =>
      new Promise((r) => {
        const s = app.listen(0, '127.0.0.1', () => r(s))
      })
    const publicApp = express()
    publicApp.use(accessGate)
    publicApp.use(express.urlencoded({ extended: false, limit: '2mb' }))
    publicApp.use(express.json({ limit: '2mb' }))
    publicApp.use(oauthRouter)
    publicApp.use((_req, res) => void res.status(404).type('text/plain').send('not found'))
    pub = await listen(publicApp)
    tail = await listen(createTailnetApprovalApp({ peer: (req) => req.get('x-test-peer') ?? '' }))
    pubBase = `http://127.0.0.1:${(pub.address() as AddressInfo).port}`
    tailBase = `http://127.0.0.1:${(tail.address() as AddressInfo).port}`
  })
  after(() => {
    if (priorTailnetIp === undefined) delete process.env.TAILNET_IP
    else process.env.TAILNET_IP = priorTailnetIp
    pub?.close()
    tail?.close()
  })
  beforeEach(() => {
    process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'approval-boundary-')), 'store.json')
    pending.clear()
  })

  const form = (o: Record<string, string>): string => new URLSearchParams(o).toString()
  const post = (url: string, o: Record<string, string>, headers: Record<string, string> = {}) =>
    realFetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(o) })

  async function startFlow(resource: string, cookie?: string) {
    const reg = await realFetch(`${pubBase}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Boundary Test', redirect_uris: [REDIRECT] }),
    })
    const { client_id } = (await reg.json()) as { client_id: string }
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource, state: 's1' })
    const page = await realFetch(`${pubBase}/oauth/authorize?${q}`, { headers: cookie ? { cookie } : {} })
    const html = await page.text()
    return {
      client_id,
      verifier,
      status: page.status,
      html,
      tx: html.match(/name="tx" value="([^"]+)"/)?.[1] ?? '',
      approval: html.match(/name="approval" value="([^"]+)"/)?.[1] ?? '',
    }
  }

  async function exchange(f: { client_id: string; verifier: string }, location: string, resource: string) {
    const code = new URL(location).searchParams.get('code')!
    return realFetch(`${pubBase}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', code, client_id: f.client_id, redirect_uri: REDIRECT, code_verifier: f.verifier, resource }),
    })
  }

  it('the public page offers a tappable tailnet link, a QR of the same link and a short code — and no setup-key field', async () => {
    const f = await startFlow(mcpResource(BASE))
    assert.equal(f.status, 200)
    const link = f.html.match(/<a href="([^"]+)"/)?.[1]
    assert.equal(link, `http://100.64.9.9:${APPROVAL_PORT}/oauth/approve/${f.approval}`)
    assert.match(f.html, /<svg [^>]*shape-rendering="crispEdges"/) // inline QR
    const code = loadStore().pendingApprovals[f.approval].shortCode
    assert.ok(f.html.includes(code))
    assert.doesNotMatch(f.html, /setup[_ ]key/i)
    assert.doesNotMatch(f.html, /type="password"/)
  })

  it('(a) the approval route is 404 from a non-tailnet address', async () => {
    const f = await startFlow(mcpResource(BASE))
    for (const peer of ['203.0.113.9', '127.0.0.1', '192.168.1.5']) {
      const r = await realFetch(`${tailBase}/oauth/approve/${f.approval}`, { headers: { 'x-test-peer': peer } })
      assert.equal(r.status, 404, peer)
      assert.equal((await post(`${tailBase}/oauth/approve/${f.approval}`, { decision: 'approve' }, { 'x-test-peer': peer })).status, 404, peer)
    }
    assert.equal(loadStore().pendingApprovals[f.approval].status, 'pending')
  })

  it('(b) 404 from a tailnet-range address that arrives on the public listener', async () => {
    const f = await startFlow(mcpResource(BASE))
    const spoof = { 'x-forwarded-for': '100.100.1.2', 'x-forwarded-proto': 'https', ...TAILNET_PEER }
    assert.equal((await realFetch(`${pubBase}/oauth/approve/${f.approval}`, { headers: spoof })).status, 404)
    assert.equal((await post(`${pubBase}/oauth/approve/${f.approval}`, { decision: 'approve' }, spoof)).status, 404)
    assert.equal(loadStore().pendingApprovals[f.approval].status, 'pending')
    // …and the same request with forwarding markers is refused even on the tailnet listener.
    assert.equal((await realFetch(`${tailBase}/oauth/approve/${f.approval}`, { headers: spoof })).status, 404)
  })

  it('(c) 200 and approves from the tailnet listener; the public poll sees only the state word', async () => {
    const f = await startFlow(mcpResource(BASE))
    const poll = async () => realFetch(`${pubBase}/oauth/pending/${f.approval}/status`)
    assert.deepEqual(await (await poll()).json(), { status: 'pending' })
    const view = await realFetch(`${tailBase}/oauth/approve/${f.approval}`, { headers: TAILNET_PEER })
    assert.equal(view.status, 200)
    const html = await view.text()
    assert.ok(html.includes('Boundary Test') && html.includes('app.example'))
    assert.equal((await post(`${tailBase}/oauth/approve/${f.approval}`, { decision: 'approve' }, TAILNET_PEER)).status, 200)
    assert.deepEqual(await (await poll()).json(), { status: 'approved' })
    assert.deepEqual(await (await realFetch(`${pubBase}/oauth/pending/bbpa_unknown/status`)).json(), { status: 'expired' })
  })

  it('(c) deny from the tailnet sends the browser back access_denied and consumes the record', async () => {
    const f = await startFlow(mcpResource(BASE))
    assert.equal((await post(`${tailBase}/oauth/approve/${f.approval}`, { decision: 'deny' }, TAILNET_PEER)).status, 200)
    assert.deepEqual(await (await realFetch(`${pubBase}/oauth/pending/${f.approval}/status`)).json(), { status: 'denied' })
    const r = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, approval: f.approval, decision: 'deny' })
    assert.equal(r.status, 302)
    const loc = new URL(r.headers.get('location') ?? '')
    assert.equal(loc.searchParams.get('error'), 'access_denied')
    assert.equal(r.headers.get('set-cookie'), null)
    assert.equal(pending.has(f.tx), false)
    assert.equal(f.approval in loadStore().pendingApprovals, false)
    const again = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, approval: f.approval, decision: 'approve' })
    assert.equal(again.status, 400)
  })

  it('(c2) a browser that still submits approve after a tailnet deny gets access_denied, no code', async () => {
    const f = await startFlow(mcpResource(BASE))
    await post(`${tailBase}/oauth/approve/${f.approval}`, { decision: 'deny' }, TAILNET_PEER)
    const r = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, approval: f.approval, decision: 'approve' })
    assert.equal(r.status, 302)
    const loc = new URL(r.headers.get('location') ?? '')
    assert.equal(loc.searchParams.get('error'), 'access_denied')
    assert.equal(loc.searchParams.get('code'), null)
  })

  it('(d) the pending record is single-use: a replay and a second tx cannot reuse it', async () => {
    const a = await startFlow(mcpResource(BASE))
    await post(`${tailBase}/oauth/approve/${a.approval}`, { decision: 'approve' }, TAILNET_PEER)
    // Bound to its tx: another transaction presenting this approval gets no code.
    const b = await startFlow(mcpResource(BASE))
    const wrong = await post(`${pubBase}/oauth/authorize`, { tx: b.tx, approval: a.approval, decision: 'approve' })
    assert.equal(wrong.status, 403)
    assert.equal(wrong.headers.get('location'), null)
    assert.equal(wrong.headers.get('set-cookie'), null)
    // The rightful tx consumes it once…
    const ok = await post(`${pubBase}/oauth/authorize`, { tx: a.tx, approval: a.approval, decision: 'approve' })
    assert.equal(ok.status, 302)
    // …and it is gone afterwards.
    assert.equal(a.approval in loadStore().pendingApprovals, false)
    assert.deepEqual(await (await realFetch(`${pubBase}/oauth/pending/${a.approval}/status`)).json(), { status: 'expired' })
    assert.equal((await post(`${tailBase}/oauth/approve/${a.approval}`, { decision: 'approve' }, TAILNET_PEER)).status, 404)
  })

  it('(d) an expired pending record cannot approve or complete the flow', async () => {
    const f = await startFlow(mcpResource(BASE))
    const raw = JSON.parse(readFileSync(process.env.OAUTH_STORE_PATH!, 'utf8'))
    raw.pendingApprovals[f.approval].expiresAt = Date.now() - 1
    writeFileSync(process.env.OAUTH_STORE_PATH!, JSON.stringify(raw))
    assert.deepEqual(await (await realFetch(`${pubBase}/oauth/pending/${f.approval}/status`)).json(), { status: 'expired' })
    assert.equal((await post(`${tailBase}/oauth/approve/${f.approval}`, { decision: 'approve' }, TAILNET_PEER)).status, 404)
    const r = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, approval: f.approval, decision: 'approve' })
    assert.equal(r.status, 403)
    assert.equal(r.headers.get('location'), null)
    assert.match(await r.text(), /expired|not granted/i)
  })

  it('a browser POST before the tailnet approval gets no code (409), and nothing is consumed', async () => {
    const f = await startFlow(mcpResource(BASE))
    const early = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, approval: f.approval, decision: 'approve' })
    assert.equal(early.status, 409)
    assert.equal(loadStore().pendingApprovals[f.approval].status, 'pending')
  })

  for (const resource of audienceResources(BASE)) {
    it(`(e) an approved record completes the code flow and mints a token for exactly ${resource}`, { timeout: 30000 }, async () => {
      const f = await startFlow(resource)
      await post(`${tailBase}/oauth/approve/${f.approval}`, { decision: 'approve' }, TAILNET_PEER)
      const granted = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, approval: f.approval, decision: 'approve' })
      assert.equal(granted.status, 302)
      const location = granted.headers.get('location')!
      assert.equal(new URL(location).origin + new URL(location).pathname, REDIRECT)
      assert.equal(new URL(location).searchParams.get('state'), 's1')
      assert.match(granted.headers.get('set-cookie') ?? '', /^bb_approval=/) // approval cookie, as before
      // PKCE: a wrong verifier is refused…
      const bad = await exchange({ ...f, verifier: 'wrong-verifier-wrong-verifier-wrong-verifier' }, location, resource)
      assert.equal(bad.status, 400)
    })
  }

  it('(e) the right verifier yields a token valid for its own audience only; refresh rotates', { timeout: 30000 }, async () => {
    const resource = chatgptResource(BASE)
    const f = await startFlow(resource)
    await post(`${tailBase}/oauth/approve/${f.approval}`, { decision: 'approve' }, TAILNET_PEER)
    const granted = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, approval: f.approval, decision: 'approve' })
    const tok = await exchange(f, granted.headers.get('location')!, resource)
    assert.equal(tok.status, 200)
    const body = (await tok.json()) as { access_token: string; refresh_token: string }
    assert.equal(lookupAccess(body.access_token)?.resource, resource)
    // the same code cannot be used twice
    assert.equal((await exchange(f, granted.headers.get('location')!, resource)).status, 400)
    // exact audience: the chatgpt token opens /chatgpt/mcp and is refused on /mcp
    assert.equal((await call(base, '/chatgpt/mcp', body.access_token)).status, 200)
    const wrong = await call(base, '/mcp', body.access_token)
    assert.equal(wrong.status, 401)
    assert.match(descriptionOf(wrong), /different endpoint/i)
    // refresh rotation: old refresh dies, the new pair works
    const rot = await realFetch(`${pubBase}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', refresh_token: body.refresh_token }),
    })
    assert.equal(rot.status, 200)
    const next = (await rot.json()) as { access_token: string }
    assert.equal(lookupAccess(body.access_token), null)
    assert.equal(lookupAccess(next.access_token)?.resource, resource)
    const replay = await realFetch(`${pubBase}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', refresh_token: body.refresh_token }),
    })
    assert.equal(replay.status, 400)
  })

  it('an already-approved browser (cookie) still gets the one-click page and no QR', { timeout: 30000 }, async () => {
    const resource = mcpResource(BASE)
    const f = await startFlow(resource)
    await post(`${tailBase}/oauth/approve/${f.approval}`, { decision: 'approve' }, TAILNET_PEER)
    const granted = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, approval: f.approval, decision: 'approve' })
    const cookie = (granted.headers.get('set-cookie') ?? '').split(';')[0]
    const again = await startFlow(resource, cookie)
    assert.match(again.html, /already approved/i)
    assert.doesNotMatch(again.html, /<svg [^>]*shape-rendering="crispEdges"/)
    const ok = await post(`${pubBase}/oauth/authorize`, { tx: again.tx, decision: 'approve' }, { cookie })
    assert.equal(ok.status, 302)
  })

  it('(f) setup_key is no longer accepted anywhere', async () => {
    const f = await startFlow(mcpResource(BASE))
    for (const key of ['', 'bo_anything', 'wrong']) {
      const r = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, decision: 'approve', setup_key: key })
      assert.equal(r.status, 403)
      assert.equal(r.headers.get('location'), null)
      assert.doesNotMatch(await r.text(), /setup[_ ]key/i)
    }
    // An env-provided key is not an alternate door either.
    process.env.OAUTH_SETUP_KEY = 'bo_env_key'
    try {
      const r = await post(`${pubBase}/oauth/authorize`, { tx: f.tx, decision: 'approve', setup_key: 'bo_env_key' })
      assert.equal(r.status, 403)
      assert.equal(r.headers.get('location'), null)
    } finally {
      delete process.env.OAUTH_SETUP_KEY
    }
    // And the code that read it is gone.
    const oauthLib: Record<string, unknown> = oauthLibNs
    for (const name of ['setupKeyPath', 'getSetupKey', 'setupKeyMatches']) assert.equal(name in oauthLib, false, name)
    assert.equal('oauthSetupHint' in oauthRouteNs, false)
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
