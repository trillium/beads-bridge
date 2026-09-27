// Heartbeat live regression tests (task-36na1): end-to-end through the
// REAL mcpRouter over loopback HTTP (same harness as mcp-auth.test.ts)
// against a REAL store that is SCRATCH, not the captain's inbox
// (task-8hmyn): per-run temp Dolt store via `bd init -p inbox`, reached
// through the same `inbox` wrapper the bridge shells out to, with
// BEADS_DIR redirected. Real route + real CLI + real Dolt — only the
// database is throwaway. Following the relay-live pattern (unique titles,
// force-delete cleanup, per-test timeout), plus a start-of-suite orphan
// sweep so an interrupted run self-heals on the next run. Settles,
// against real code + a real (scratch) store:
//   - a bridge-mediated async close survives an intervening unrelated call
//     (automatic footers peek; explicit heartbeat still reports it);
//   - explicit heartbeat acknowledges (second read drops the event);
//   - distinct OAuth clientIds hold independent cursors;
//   - retrieval_activity (store reads) agrees with heartbeat;
//   - an EXTERNAL close (direct `bd`, the inbox-lkyt incident replay) is
//     invisible to heartbeat yet visible to retrieval_activity.
// Live tests: FUNNEL_BASE=https://example.test bun test src/lib/heartbeat-live.test.ts
// (Importing the route pulls toolKey/BASE from config, so FUNNEL_BASE must
// be set. OAuth + telemetry state are isolated per test via temp dirs.
// The bead store is an isolated scratch store per run; the captain's inbox
// is never touched — verified by comparing the inbox item list before and
// after the suite.)
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { BASE, toolKey } from '../config'
import { mcpResource, mintTokenPair } from './oauth'
import { mcpRouter } from '../routes/mcp'
import { resetHeartbeatCursors } from './heartbeat'
import { execStdout } from './exec'
import { showBeadAsync } from '../routes/query/store'
import {
  liveRunTag,
  initScratchStoreSync,
  sweepScratchBeadsSync,
  redirectStoreEnv,
  removeScratchStore,
} from './live-test-store'

const STORE = 'inbox'
// Run-derived tag (task-8hmyn): unique per run, never a hardcoded task id.
// LEGACY_TAG is swept on the REAL store at suite start so beads orphaned
// by pre-fix interrupted runs are reaped exactly once, then never again.
const TAG = liveRunTag('bb-hb')
const LEGACY_TAG = 'bb-hb-36na1'

// Suite setup runs at import time as blocking sync statements, NOT in
// before(): the sweep + `bd init` take ~10-15s, beyond the runner's 5s
// hook budget (hook timeout options are not honored), and the package is
// type:commonjs so top-level await is rejected by tsc. A setup failure
// throws here, failing the file loudly instead of silently testing the
// wrong store. Sweep BEFORE isolation is installed, so it hits the real
// store: self-heal orphans from pre-fix runs that died before cleanup()
// ran. The 30-minute age guard keeps a concurrent old-code run's
// in-flight scratch beads (seconds old) out of the sweep — only true
// orphans. Post-fix runs never write to the real store at all, so no new
// orphans can appear there; the sweep is strictly legacy hygiene.
let scratchDir = ''
let restoreStoreEnv: (() => void) | null = null
try {
  sweepScratchBeadsSync(STORE, `${LEGACY_TAG} `, 30 * 60 * 1000)
  scratchDir = initScratchStoreSync('inbox')
  restoreStoreEnv = redirectStoreEnv(`${scratchDir}/.beads`)
} catch (e) {
  throw new Error(`heartbeat-live setup failed (isolation not installed): ${(e as Error)?.message ?? e}`)
}

after(() => {
  restoreStoreEnv?.()
  restoreStoreEnv = null
  if (scratchDir) removeScratchStore(scratchDir)
  scratchDir = ''
})

function scratchTitle(): string {
  return `${TAG} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function cleanup(id: string): Promise<void> {
  await execStdout(STORE, ['delete', id, '--force'], 20000).catch(() => {})
  assert.equal(await showBeadAsync(STORE, id), null, `scratch bead ${id} must be gone after cleanup`)
}

// --- MCP-over-HTTP harness (same shape as mcp-auth.test.ts) ---

let rpcId = 1000

async function rpc(
  base: string,
  body: unknown,
  token?: string,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
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
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'heartbeat-live-test', version: '0' } },
}

async function session(base: string, token: string): Promise<string> {
  const init = await rpc(base, { ...INIT, id: rpcId++ }, token)
  assert.equal(init.status, 200, `initialize failed: ${JSON.stringify(init.json)?.slice(0, 300)}`)
  return init.headers.get('mcp-session-id') ?? ''
}

async function callTool(base: string, sess: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await rpc(
    base,
    { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } },
    token,
    sess || undefined,
  )
  assert.equal(res.status, 200, `${name} failed with status ${res.status}: ${JSON.stringify(res.json)?.slice(0, 300)}`)
  const content = res.json?.result?.content
  assert.ok(Array.isArray(content) && typeof content[0]?.text === 'string', `${name}: no text content: ${JSON.stringify(res.json)?.slice(0, 300)}`)
  assert.equal(res.json?.result?.isError, undefined, `${name} returned isError: ${content[0].text.slice(0, 300)}`)
  return content[0].text as string
}

function createdId(receiptText: string): string {
  const m = receiptText.match(/^# created (\S+) \(STORE: inbox\)/m)
  assert.ok(m, `no created inbox id in receipt: ${receiptText.slice(0, 300)}`)
  return m[1]
}

async function createScratch(base: string, sess: string, token: string): Promise<string> {
  const text = await callTool(base, sess, token, 'bead_create', {
    store: STORE, title: scratchTitle(), description: 'scratch bead for heartbeat-live test; safe to delete',
  })
  return createdId(text)
}

describe('heartbeat live (task-36na1)', () => {
  it('bridge-mediated async close survives an intervening call; heartbeat acks', { timeout: 120000 }, async (t) => {
    process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'hb-live-oauth-')), 'store.json')
    process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'hb-live-tel-'))
    resetHeartbeatCursors()
    await withApp(async (base) => {
      const sess = await session(base, toolKey) // loopback-local caller, like every gateway client
      await callTool(base, sess, toolKey, 'heartbeat') // baseline
      const id = await createScratch(base, sess, toolKey)
      t.after(() => cleanup(id))
      const closed = await callTool(base, sess, toolKey, 'bead_decision', { id, decision: 'close' })
      assert.match(closed, new RegExp(id), 'close receipt names the bead')
      const intervening = await callTool(base, sess, toolKey, 'whoami')
      assert.match(intervening, new RegExp(id), 'intervening footer still surfaces the pending close (peek)')
      const hb = await callTool(base, sess, toolKey, 'heartbeat')
      assert.match(hb, new RegExp(id), 'explicit heartbeat still reports the close — not consumed by the footer')
      const hb2 = await callTool(base, sess, toolKey, 'heartbeat')
      assert.doesNotMatch(hb2, new RegExp(id), 'second heartbeat acknowledged the close')
    })
  })

  it('distinct OAuth callers hold independent cursors', { timeout: 120000 }, async (t) => {
    process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'hb-live-oauth-')), 'store.json')
    process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'hb-live-tel-'))
    resetHeartbeatCursors()
    const pairA = mintTokenPair('hb-live-A', ['mcp'], mcpResource(BASE))
    const pairB = mintTokenPair('hb-live-B', ['mcp'], mcpResource(BASE))
    await withApp(async (base) => {
      const sessA = await session(base, pairA.accessToken)
      const sessB = await session(base, pairB.accessToken)
      await callTool(base, sessA, pairA.accessToken, 'heartbeat') // A baseline
      await callTool(base, sessB, pairB.accessToken, 'heartbeat') // B baseline
      const id2 = await createScratch(base, sessA, pairA.accessToken)
      t.after(() => cleanup(id2))
      await callTool(base, sessA, pairA.accessToken, 'bead_decision', { id: id2, decision: 'close' })
      assert.match(await callTool(base, sessA, pairA.accessToken, 'heartbeat'), new RegExp(id2))
      const id3 = await createScratch(base, sessA, pairA.accessToken)
      t.after(() => cleanup(id3))
      await callTool(base, sessA, pairA.accessToken, 'bead_decision', { id: id3, decision: 'close' })
      const hbA = await callTool(base, sessA, pairA.accessToken, 'heartbeat')
      assert.match(hbA, new RegExp(id3), 'A sees the new close')
      assert.doesNotMatch(hbA, new RegExp(id2), 'A already acknowledged the older close')
      const hbB = await callTool(base, sessB, pairB.accessToken, 'heartbeat')
      assert.match(hbB, new RegExp(id2), "B still sees what A acknowledged — cursors are independent")
      assert.match(hbB, new RegExp(id3), 'B sees the new close too')
    })
  })

  it('retrieval_activity agrees with heartbeat on a bridged close', { timeout: 120000 }, async (t) => {
    process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'hb-live-oauth-')), 'store.json')
    process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'hb-live-tel-'))
    resetHeartbeatCursors()
    await withApp(async (base) => {
      const sess = await session(base, toolKey)
      await callTool(base, sess, toolKey, 'heartbeat') // baseline
      const id = await createScratch(base, sess, toolKey)
      t.after(() => cleanup(id))
      await callTool(base, sess, toolKey, 'bead_decision', { id, decision: 'close' })
      const activity = await callTool(base, sess, toolKey, 'retrieval_activity', { stores: [STORE], limit: 20, history: true })
      assert.match(activity, new RegExp(id), 'retrieval_activity (store reads) shows the closed scratch bead')
      const hb = await callTool(base, sess, toolKey, 'heartbeat')
      assert.match(hb, new RegExp(id), 'heartbeat (projection) agrees')
      const show = await execStdout(STORE, ['show', id], 15000)
      assert.match(show, /CLOSED/i, 'the store itself says closed — all three agree')
    })
  })

  it('external close is invisible to heartbeat, visible to retrieval_activity (incident replay)', { timeout: 120000 }, async (t) => {
    process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'hb-live-oauth-')), 'store.json')
    process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'hb-live-tel-'))
    resetHeartbeatCursors()
    await withApp(async (base) => {
      const sess = await session(base, toolKey)
      await callTool(base, sess, toolKey, 'heartbeat') // baseline
      const id = await createScratch(base, sess, toolKey)
      t.after(() => cleanup(id))
      await callTool(base, sess, toolKey, 'heartbeat') // advance past the create touch
      await execStdout(STORE, ['close', id], 15000) // EXTERNAL close — bypasses the bridge, like inbox-lkyt
      const show = await execStdout(STORE, ['show', id], 15000)
      assert.match(show, /CLOSED/i, 'external close really closed the store bead')
      const hb = await callTool(base, sess, toolKey, 'heartbeat')
      assert.doesNotMatch(hb, new RegExp(id), 'heartbeat cannot show what never entered the projection')
      const activity = await callTool(base, sess, toolKey, 'retrieval_activity', { stores: [STORE], limit: 20 })
      assert.match(activity, new RegExp(id), 'retrieval_activity still surfaces it — the authoritative cross-check')
    })
  })
})
