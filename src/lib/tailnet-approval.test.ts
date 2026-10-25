// FUNNEL_BASE=https://example.test bun test src/lib/tailnet-approval.test.ts
// The tailnet approval app is driven over real HTTP; the socket peer is
// injected (the test server can only be reached from loopback).
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createPendingApproval, pendingApprovalState } from './oauth'
import { pending } from './oauth-tx'
import { createTailnetApprovalApp, isTailnetAddress, tailnetApprovalUrl } from './tailnet-approval'

describe('isTailnetAddress (100.64.0.0/10)', () => {
  it('accepts the whole CGNAT block, mapped or not', () => {
    for (const a of ['100.64.0.0', '100.100.1.2', '100.127.255.255', '::ffff:100.74.138.74']) assert.ok(isTailnetAddress(a), a)
  })
  it('rejects everything outside it', () => {
    for (const a of ['100.63.255.255', '100.128.0.0', '99.64.0.1', '127.0.0.1', '10.0.0.1', '192.168.1.1', '::1', '', 'nonsense', '100.64.0.1.5']) {
      assert.ok(!isTailnetAddress(a), a)
    }
  })
})

describe('tailnetApprovalUrl', () => {
  it('builds http://<ip>:<port>/oauth/approve/<id> for a tailnet ip only', () => {
    assert.equal(tailnetApprovalUrl('bbpa_x', '100.64.1.2', 3738), 'http://100.64.1.2:3738/oauth/approve/bbpa_x')
    assert.equal(tailnetApprovalUrl('bbpa_x', 'unset', 3738), null)
    assert.equal(tailnetApprovalUrl('bbpa_x', '8.8.8.8', 3738), null)
  })
})

describe('tailnet approval app', () => {
  let server: Server
  let base = ''
  before(async () => {
    const app = createTailnetApprovalApp({ peer: (req) => req.get('x-test-peer') ?? '' })
    server = await new Promise<Server>((res) => {
      const s = app.listen(0, '127.0.0.1', () => res(s))
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => void server.close())
  beforeEach(() => {
    process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'tn-approval-')), 'store.json')
    pending.clear()
  })

  const TAILNET = { 'x-test-peer': '100.100.1.2' }
  const mk = () => createPendingApproval({ tx: 'bbtx_t', clientName: 'Test <b>Client</b>', redirectHost: 'app.example', scope: ['mcp'] })
  const get = (id: string, headers: Record<string, string> = TAILNET) => fetch(`${base}/oauth/approve/${id}`, { headers })
  const post = (id: string, decision: string, headers: Record<string, string> = TAILNET) =>
    fetch(`${base}/oauth/approve/${id}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: `decision=${decision}`,
    })

  it('404s for a non-tailnet peer, on GET and POST, without touching the record', async () => {
    const p = mk()
    for (const peer of ['203.0.113.9', '127.0.0.1', '', '100.63.0.1']) {
      assert.equal((await get(p.id, { 'x-test-peer': peer })).status, 404, peer)
      assert.equal((await post(p.id, 'approve', { 'x-test-peer': peer })).status, 404, peer)
    }
    assert.equal(pendingApprovalState(p.id), 'pending')
  })

  it('404s a tailnet peer that carries proxy-forwarding headers (a proxied hop)', async () => {
    const p = mk()
    assert.equal((await get(p.id, { ...TAILNET, 'x-forwarded-for': '100.100.1.2' })).status, 404)
    assert.equal((await post(p.id, 'approve', { ...TAILNET, 'x-forwarded-proto': 'https' })).status, 404)
    assert.equal(pendingApprovalState(p.id), 'pending')
  })

  it('never trusts X-Forwarded-For as the tailnet check', async () => {
    const p = mk()
    assert.equal((await get(p.id, { 'x-test-peer': '203.0.113.9', 'x-forwarded-for': '100.100.1.2' })).status, 404)
  })

  it('shows the grant (client, redirect host, scope, code) escaped, with Approve and Deny', async () => {
    const p = mk()
    const r = await get(p.id)
    assert.equal(r.status, 200)
    const html = await r.text()
    assert.ok(html.includes('Test &lt;b&gt;Client&lt;/b&gt;'))
    assert.ok(html.includes('app.example'))
    assert.ok(html.includes('mcp'))
    assert.ok(html.includes(p.shortCode))
    assert.match(html, /value="approve"/)
    assert.match(html, /value="deny"/)
  })

  it('404s an unknown or expired id even from the tailnet', async () => {
    assert.equal((await get('bbpa_unknown')).status, 404)
    assert.equal((await post('bbpa_unknown', 'approve')).status, 404)
  })

  it('POST approve marks the record approved, once', async () => {
    const p = mk()
    assert.equal((await post(p.id, 'approve')).status, 200)
    assert.equal(pendingApprovalState(p.id), 'approved')
    assert.equal((await post(p.id, 'deny')).status, 409)
    assert.equal(pendingApprovalState(p.id), 'approved')
  })

  it('POST deny marks the record denied and cancels the transaction', async () => {
    const p = mk()
    pending.set('bbtx_t', { clientId: 'c', redirectUri: 'https://app.example/cb', scope: ['mcp'], state: '', challenge: 'x', resource: 'r', expiresAt: Date.now() + 1000 })
    assert.equal((await post(p.id, 'deny')).status, 200)
    assert.equal(pendingApprovalState(p.id), 'denied')
    assert.equal(pending.has('bbtx_t'), false)
  })

  it('refuses a cross-origin form post', async () => {
    const p = mk()
    const r = await post(p.id, 'approve', { ...TAILNET, origin: 'https://evil.example' })
    assert.equal(r.status, 403)
    assert.equal(pendingApprovalState(p.id), 'pending')
  })

  it('serves nothing else', async () => {
    assert.equal((await fetch(`${base}/`, { headers: TAILNET })).status, 404)
    assert.equal((await fetch(`${base}/mcp`, { headers: TAILNET })).status, 404)
  })
})
