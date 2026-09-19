// Ingress-auth regression tests (handoff `handoff-mgjj`, P1 security).
// The three probe cases, through real sockets against the real gate:
//   1. funnel-shaped request (loopback peer + forwarding headers, random
//      public User-Agent) on a gated path without a credential -> 403
//   2. same shape with the ChatGPT-equivalent bearer -> through
//   3. direct local (no forwarding headers) -> through, unchanged
// Plus unit coverage of the classifier (tailnet, IPv6 loopback, LAN,
// public-direct, UA-is-not-auth, garbage tokens, setup paths).
// Unit tests: FUNNEL_BASE=https://example.test bun test src/lib/access-gate.test.ts
// (Importing the gate pulls toolKey/BASE from config, so FUNNEL_BASE must be set.
// OAuth state is isolated per test via OAUTH_STORE_PATH temp dirs — the live
// bridge store is never touched.)
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { Request } from 'express'
import { BASE, toolKey } from '../config'
import { jungleResource, mcpResource, mintTokenPair } from './oauth'
import {
  accessGate,
  classifyIngress,
  hasForwardMarkers,
  hasValidCredential,
  socketPeer,
  type IngressVerdict,
} from './access-gate'

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'gate-test-')), 'store.json')
})

const RANDOM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const CHATGPT_UA = 'ChatGPT-User/1.0 (+https://openai.com)'

// Minimal fake request for the pure classifier: only what it reads
// (path, socket.remoteAddress, headers.authorization, req.get).
function fakeReq(opts: {
  path: string
  peer?: string
  headers?: Record<string, string>
}): Request {
  const lowered: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) lowered[k.toLowerCase()] = v
  return {
    path: opts.path,
    socket: { remoteAddress: opts.peer ?? '127.0.0.1' },
    headers: lowered,
    get(h: string): string | undefined {
      return lowered[h.toLowerCase()]
    },
  } as unknown as Request
}

function verdictOf(opts: {
  path: string
  peer?: string
  headers?: Record<string, string>
}): IngressVerdict {
  return classifyIngress(fakeReq(opts))
}

// Funnel shape: loopback socket peer (the proxy hop) + the forwarding
// headers Funnel stamps + a random non-ChatGPT User-Agent (the proven
// live-fault shape from the handoff log line).
const funnelHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'user-agent': RANDOM_UA,
  'x-forwarded-for': '203.0.113.7',
  'x-forwarded-proto': 'https',
  ...extra,
})

describe('classifier: public-by-design setup paths', () => {
  for (const p of ['/mcp', '/jungle/mcp', '/oauth/token', '/oauth/authorize', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server/mcp']) {
    it(`${p} passes the gate without a credential (downstream owns auth)`, () => {
      assert.equal(verdictOf({ path: p, headers: funnelHeaders() }), 'ALLOW:mcp')
    })
  }
})

describe('classifier: unauthenticated funnel-shaped traffic is denied', () => {
  it('random public UA on a gated path -> 403 (the proven live fault)', () => {
    assert.equal(verdictOf({ path: '/next', headers: funnelHeaders() }), 'DENY:403')
  })
  it('ChatGPT UA without a credential -> 403 (UA is not authentication)', () => {
    assert.equal(
      verdictOf({ path: '/next', headers: funnelHeaders({ 'user-agent': CHATGPT_UA }) }),
      'DENY:403',
    )
  })
  it('gptbot UA without a credential -> 403', () => {
    assert.equal(
      verdictOf({ path: '/retrieval/search', headers: funnelHeaders({ 'user-agent': 'GPTBot/1.0' }) }),
      'DENY:403',
    )
  })
  it('garbage bearer on a gated path -> 403', () => {
    assert.equal(
      verdictOf({ path: '/next', headers: funnelHeaders({ authorization: 'Bearer bb_at_nope' }) }),
      'DENY:403',
    )
  })
  it('write routes are gated too (verbs + actions)', () => {
    assert.equal(verdictOf({ path: '/task-1/approve', headers: funnelHeaders() }), 'DENY:403')
    assert.equal(verdictOf({ path: '/action/next', headers: funnelHeaders() }), 'DENY:403')
  })
})

describe('classifier: valid bearers pass from anywhere', () => {
  it('OAuth token (bridge-direct audience) opens gated paths via funnel', () => {
    const pair = mintTokenPair('chatgpt-test', ['mcp'], mcpResource(BASE))
    assert.ok(hasValidCredential(fakeReq({ path: '/next', headers: funnelHeaders({ authorization: `Bearer ${pair.accessToken}` }) })))
    assert.equal(
      verdictOf({ path: '/next', headers: funnelHeaders({ authorization: `Bearer ${pair.accessToken}` }) }),
      'ALLOW:credential',
    )
  })
  it('OAuth token (jungle audience) opens gated paths too', () => {
    const pair = mintTokenPair('chatgpt-jungle', ['mcp'], jungleResource(BASE))
    assert.equal(
      verdictOf({ path: '/q/task', headers: funnelHeaders({ authorization: `Bearer ${pair.accessToken}` }) }),
      'ALLOW:credential',
    )
  })
  it('service toolKey bearer opens gated paths (existing action-lane credential)', () => {
    assert.equal(
      verdictOf({ path: '/next', headers: funnelHeaders({ authorization: `Bearer ${toolKey}` }) }),
      'ALLOW:credential',
    )
  })
  it('non-Bearer scheme is not a credential', () => {
    assert.equal(
      verdictOf({ path: '/next', headers: funnelHeaders({ authorization: `Basic ${toolKey}` }) }),
      'DENY:403',
    )
  })
})

describe('classifier: direct local and tailnet unchanged', () => {
  it('direct local, random UA, no credential -> through', () => {
    assert.equal(
      verdictOf({ path: '/next', headers: { 'user-agent': RANDOM_UA } }),
      'ALLOW:localhost',
    )
  })
  it('IPv6 loopback forms stay local', () => {
    assert.equal(verdictOf({ path: '/next', peer: '::1', headers: {} }), 'ALLOW:localhost')
    assert.equal(verdictOf({ path: '/next', peer: '::ffff:127.0.0.1', headers: {} }), 'ALLOW:localhost')
  })
  it('loopback WITH forwarding headers is funnel-shaped, not local', () => {
    assert.equal(verdictOf({ path: '/next', peer: '::ffff:127.0.0.1', headers: funnelHeaders() }), 'DENY:403')
  })
  it('tailnet peer passes without a credential', () => {
    assert.equal(
      verdictOf({ path: '/next', peer: '100.84.3.5', headers: { 'user-agent': RANDOM_UA } }),
      'ALLOW:tailnet',
    )
  })
  it('LAN and public-direct peers without a credential -> 403', () => {
    assert.equal(verdictOf({ path: '/next', peer: '192.168.1.5', headers: {} }), 'DENY:403')
    assert.equal(verdictOf({ path: '/next', peer: '203.0.113.7', headers: {} }), 'DENY:403')
  })
  it('spoofed X-Forwarded-For cannot manufacture tailnet or local', () => {
    // Funnel hop carrying a forged tailnet XFF: socket peer is what counts.
    assert.equal(
      verdictOf({ path: '/next', peer: '127.0.0.1', headers: funnelHeaders({ 'x-forwarded-for': '100.84.3.5' }) }),
      'DENY:403',
    )
  })
})

describe('helpers', () => {
  it('socketPeer reads the socket, never req.ip/XFF', () => {
    const req = fakeReq({ path: '/', peer: '127.0.0.1', headers: { 'x-forwarded-for': '100.84.3.5' } })
    assert.equal(socketPeer(req), '127.0.0.1')
  })
  it('hasForwardMarkers is presence-only', () => {
    assert.equal(hasForwardMarkers(fakeReq({ path: '/', headers: {} })), false)
    assert.equal(hasForwardMarkers(fakeReq({ path: '/', headers: { 'x-forwarded-proto': 'https' } })), true)
  })
})

// The three probe cases through real sockets: an app wired exactly like
// src/server.ts (trust proxy loopback + accessGate first), one stub gated
// route and the public setup paths. Funnel shape = the headers Funnel adds.
describe('gate over HTTP (probe contract)', () => {
  async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
    const app = express()
    app.set('trust proxy', 'loopback')
    app.use(accessGate)
    app.get('/next', (_req, res) => {
      res.type('text/plain').send('next-ok')
    })
    app.post('/mcp', (_req, res) => {
      res.type('text/plain').send('mcp-pass')
    })
    app.get('/.well-known/oauth-protected-resource', (_req, res) => {
      res.type('text/plain').send('discovery-pass')
    })
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

  const funnel = (extra: Record<string, string> = {}): Record<string, string> => ({
    'user-agent': RANDOM_UA,
    'x-forwarded-for': '203.0.113.7',
    'x-forwarded-proto': 'https',
    ...extra,
  })

  it('probe 1: funnel-shaped, no credential -> 403', { timeout: 15000 }, async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/next`, { headers: funnel() })
      assert.equal(res.status, 403)
      assert.match(await res.text(), /forbidden/)
    })
  })

  it('probe 2: funnel-shaped with OAuth bearer -> through', { timeout: 15000 }, async () => {
    const pair = mintTokenPair('chatgpt-probe', ['mcp'], mcpResource(BASE))
    await withApp(async (base) => {
      const res = await fetch(`${base}/next`, {
        headers: funnel({ authorization: `Bearer ${pair.accessToken}` }),
      })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'next-ok')
    })
  })

  it('probe 2b: funnel-shaped with toolKey bearer -> through', { timeout: 15000 }, async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/next`, {
        headers: funnel({ authorization: `Bearer ${toolKey}` }),
      })
      assert.equal(res.status, 200)
    })
  })

  it('probe 3: direct local, no credential -> through unchanged', { timeout: 15000 }, async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/next`, { headers: { 'user-agent': RANDOM_UA } })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'next-ok')
    })
  })

  it('connector paths still pass the gate for the real flow', { timeout: 15000 }, async () => {
    await withApp(async (base) => {
      const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: funnel() })
      assert.equal(mcp.status, 200)
      const disco = await fetch(`${base}/.well-known/oauth-protected-resource`, { headers: funnel() })
      assert.equal(disco.status, 200)
    })
  })
})
