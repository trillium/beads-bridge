// FUNNEL_BASE=https://example.test bun test src/routes/oauth-restart.test.ts
// A grant survives server restarts: every step of the OAuth flow runs in a
// fresh bridge process (src/routes/oauth-restart.fixture.ts), killed with
// SIGKILL before the next step starts, all sharing one OAUTH_STORE_PATH. The
// only thing that can carry the grant from step to step is the persisted record.
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { BASE } from '../config'
import { mcpResource } from '../lib/oauth'

const FIXTURE = join(__dirname, 'oauth-restart.fixture.ts')
const REDIRECT = 'https://app.example/cb'
const TAILNET_PEER = { 'x-test-peer': '100.100.1.2' }

interface Bridge { child: ChildProcess; pid: number; pub: string; tail: string }
const live = new Set<ChildProcess>()

async function startBridge(storePath: string): Promise<Bridge> {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, FUNNEL_BASE: BASE, OAUTH_STORE_PATH: storePath, TAILNET_IP: '100.64.9.9' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  live.add(child)
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! })
    rl.once('line', (l) => { rl.close(); resolve(l) })
    child.once('exit', (code) => reject(new Error(`bridge exited (${code}) before listening`)))
  })
  const { pid, pub, tail } = JSON.parse(line) as { pid: number; pub: number; tail: number }
  return { child, pid, pub: `http://127.0.0.1:${pub}`, tail: `http://127.0.0.1:${tail}` }
}

// A crash, not a graceful stop: nothing gets a chance to flush.
async function kill(b: Bridge): Promise<void> {
  const gone = new Promise<void>((r) => b.child.once('exit', () => r()))
  b.child.kill('SIGKILL')
  await gone
  live.delete(b.child)
}

afterEach(() => {
  for (const c of live) c.kill('SIGKILL')
  live.clear()
})

const form = (o: Record<string, string>): string => new URLSearchParams(o).toString()
const post = (url: string, o: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(o) })

describe('OAuth grant across server restarts', () => {
  it('authorize → restart → tailnet approve → restart → browser completes → restart → token exchange', { timeout: 30000 }, async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'oauth-restart-')), 'store.json')
    const resource = mcpResource(BASE)
    const pids: number[] = []

    // Process 1: the client registers and the browser opens the approval page.
    let b = await startBridge(storePath)
    pids.push(b.pid)
    const reg = await fetch(`${b.pub}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Restart Test', redirect_uris: [REDIRECT] }),
    })
    const { client_id } = (await reg.json()) as { client_id: string }
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource, state: 's1' })
    const page = await fetch(`${b.pub}/oauth/authorize?${q}`)
    assert.equal(page.status, 200)
    const html = await page.text()
    const tx = html.match(/name="tx" value="([^"]+)"/)?.[1] ?? ''
    const approval = html.match(/name="approval" value="([^"]+)"/)?.[1] ?? ''
    assert.ok(tx && approval)
    await kill(b)

    // Process 2: the human approves from the tailnet device.
    b = await startBridge(storePath)
    pids.push(b.pid)
    assert.deepEqual(await (await fetch(`${b.pub}/oauth/pending/${approval}/status`)).json(), { status: 'pending' })
    assert.equal((await post(`${b.tail}/oauth/approve/${approval}`, { decision: 'approve' }, TAILNET_PEER)).status, 200)
    await kill(b)

    // Process 3: the waiting browser's poll sees it and submits the form.
    b = await startBridge(storePath)
    pids.push(b.pid)
    assert.deepEqual(await (await fetch(`${b.pub}/oauth/pending/${approval}/status`)).json(), { status: 'approved' })
    const granted = await post(`${b.pub}/oauth/authorize`, { tx, approval, decision: 'approve' })
    assert.equal(granted.status, 302)
    const location = new URL(granted.headers.get('location')!)
    assert.equal(location.origin + location.pathname, REDIRECT)
    assert.equal(location.searchParams.get('state'), 's1')
    const code = location.searchParams.get('code')!
    assert.ok(code)
    await kill(b)

    // Process 4: the client exchanges the code (PKCE) for a token.
    b = await startBridge(storePath)
    pids.push(b.pid)
    const tok = await fetch(`${b.pub}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource }),
    })
    assert.equal(tok.status, 200)
    const body = (await tok.json()) as { access_token: string; refresh_token: string }
    assert.match(body.access_token, /^bb_at_/)
    assert.match(body.refresh_token, /^bb_rt_/)
    // The grant was consumed exactly once: the record is gone and cannot be replayed.
    const onDisk = JSON.parse(readFileSync(storePath, 'utf8'))
    assert.deepEqual(onDisk.grants, {})
    assert.equal(onDisk.access[body.access_token].resource, resource)
    assert.equal((await post(`${b.pub}/oauth/authorize`, { tx, approval, decision: 'approve' })).status, 400)
    await kill(b)

    assert.equal(new Set(pids).size, 4, 'every step ran in its own process')
  })

  it('an already-approved browser finishes its one-click grant after a restart', { timeout: 30000 }, async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'oauth-restart-')), 'store.json')
    const resource = mcpResource(BASE)
    let b = await startBridge(storePath)
    const reg = await fetch(`${b.pub}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Restart Test', redirect_uris: [REDIRECT] }),
    })
    const { client_id } = (await reg.json()) as { client_id: string }
    const q = (c: string) => new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: c, code_challenge_method: 'S256', resource, state: 's2' })
    // First grant over the tailnet, to earn the remembered-browser cookie.
    const first = await (await fetch(`${b.pub}/oauth/authorize?${q('c1')}`)).text()
    const tx1 = first.match(/name="tx" value="([^"]+)"/)![1]
    const ap1 = first.match(/name="approval" value="([^"]+)"/)![1]
    await post(`${b.tail}/oauth/approve/${ap1}`, { decision: 'approve' }, TAILNET_PEER)
    const cookie = ((await post(`${b.pub}/oauth/authorize`, { tx: tx1, approval: ap1, decision: 'approve' })).headers.get('set-cookie') ?? '').split(';')[0]
    assert.match(cookie, /^bb_approval=/)
    // Second grant: the page opens, then the bridge restarts before the click.
    const again = await (await fetch(`${b.pub}/oauth/authorize?${q('c2')}`, { headers: { cookie } })).text()
    assert.match(again, /already approved/i)
    const tx2 = again.match(/name="tx" value="([^"]+)"/)![1]
    await kill(b)
    b = await startBridge(storePath)
    const ok = await post(`${b.pub}/oauth/authorize`, { tx: tx2, decision: 'approve' }, { cookie })
    assert.equal(ok.status, 302)
    assert.ok(new URL(ok.headers.get('location')!).searchParams.get('code'))
    await kill(b)
  })
})
