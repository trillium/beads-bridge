// feature-n7e over the real /mcp route: the guard sits in front of the actual
// tool callbacks, pauses before they run, and voice_confirm settles the call.
// Every call here targets a bead id no store resolves, so the real callbacks can
// never write — what is proved is ORDER (pause first) and ROUTING (confirm reaches
// the real callback), not a store write. Rules are injected; no glossary read.
// Unit tests: FUNNEL_BASE=https://example.test bun test src/routes/voice-guard-mcp.test.ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { toolKey } from '../config'
import { parseMisrecognitions, resetVoiceGuard } from '../lib/voice-guard'
import { mcpRouter } from './mcp'

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'voice-guard-oauth-')), 'store.json')
  process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'voice-guard-tel-'))
  resetVoiceGuard(async () => parseMisrecognitions("- 'feed' (F) may mean 'bead' (B)", 'glossary-jgv'))
})

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use(mcpRouter)
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s))
  })
  try {
    await fn(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`)
  } finally {
    server.close()
  }
}

let rpcId = 1
async function call(base: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${toolKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  })
  const raw = await res.text()
  const line = raw.startsWith('{') ? raw : raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5)
  const result = JSON.parse(line).result
  return { text: result.content.map((c: { text: string }) => c.text).join('\n'), isError: result.isError === true }
}

const NOWHERE = 'nowhere-zz9'

describe('/mcp voice guard', () => {
  it('lists voice_confirm', async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${toolKey}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      assert.ok((await res.text()).includes('"voice_confirm"'))
    })
  })

  it('a clean call reaches the real callback in one step (no pause)', { timeout: 30000 }, async () => {
    await withApp(async (base) => {
      const r = await call(base, 'bead_comment', { id: NOWHERE, text: 'all fine here' })
      assert.ok(!r.text.includes('PAUSED'), r.text)
      assert.match(r.text, /unknown bead id|unknown/i)
    })
  })

  it('a flagged call pauses before the callback; confirm routes to the real callback; cancel drops it', { timeout: 30000 }, async () => {
    await withApp(async (base) => {
      const paused = await call(base, 'bead_comment', { id: NOWHERE, text: 'the feed is stuck' })
      assert.match(paused.text, /PAUSED — bead_comment was NOT executed/)
      assert.ok(!/unknown bead id/i.test(paused.text.split('voice_guard (JSON)')[0].split('Finish with')[0]), 'callback must not have run')
      const token = /"token":"(vg_[0-9a-f]+)"/.exec(paused.text)![1]

      // Same call again: same pending request, still not executed.
      const again = await call(base, 'bead_comment', { id: NOWHERE, text: 'the feed is stuck' })
      assert.ok(again.text.includes(token))

      // original → the real callback runs (and rejects the unknown id, so nothing is written)
      const ran = await call(base, 'voice_confirm', { token, decision: 'original' })
      assert.match(ran.text, /bead_comment reported an error; vg_[0-9a-f]+ is still pending/)
      assert.match(ran.text, /unknown/i)

      const cancelled = await call(base, 'voice_confirm', { token, decision: 'cancel' })
      assert.match(cancelled.text, /cancelled .*not executed/)
      const after = await call(base, 'voice_confirm', { token, decision: 'original' })
      assert.ok(after.isError)
      assert.match(after.text, /already cancelled/)
    })
  })

  it('an unknown token is an error and executes nothing', { timeout: 30000 }, async () => {
    await withApp(async (base) => {
      const r = await call(base, 'voice_confirm', { token: 'vg_deadbeef0000', decision: 'accept' })
      assert.ok(r.isError)
      assert.match(r.text, /no pending request/)
    })
  })
})
