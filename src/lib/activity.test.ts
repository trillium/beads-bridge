// Live MCP Activity UI tests (project-s1rf.1.1.2) safety floor:
// observational-only (no mutation), loop prevention (bare tools excluded),
// bounded payloads/ring, validated bead refs, failure isolation, ordering.
// Unit tests: bun test src/lib/activity.test.ts (node:test, no new deps).
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  activityAutoFollowDefault,
  activityMaxBeadRefs,
  activityMaxEvents,
  activitySummaryChars,
  extractBeadRefs,
  recentEvents,
  recordEvent,
  resetActivity,
  subscribeActivity,
  subscriberCount,
  summarizeResult,
  withActivity,
} from './activity'
import { runWithScope } from './followons'

function ev(over: Record<string, unknown> = {}) {
  return {
    at: new Date(0).toISOString(),
    tool: 'bead_show',
    outcome: 'ok' as const,
    caller: 'loopback-local',
    sessionId: null,
    client: 'curl',
    authed: false,
    durationMs: 3,
    argNames: ['id'],
    beadRefs: [],
    summary: 'x',
    ...over,
  }
}

function jsonRpcResult(text: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }] },
  })
}

describe('activity ring', () => {
  beforeEach(() => resetActivity())

  it('orders newest-first and assigns monotonic seq', () => {
    const a = recordEvent(ev({ tool: 'aaa' }))
    const b = recordEvent(ev({ tool: 'bbb' }))
    assert.ok(b.seq > a.seq)
    const rec = recentEvents(10)
    assert.equal(rec[0].tool, 'bbb')
    assert.equal(rec[1].tool, 'aaa')
  })

  it('caps the ring at activityMaxEvents', () => {
    const max = activityMaxEvents()
    for (let i = 0; i < max + 25; i++) recordEvent(ev({ tool: `t${i}` }))
    const rec = recentEvents(max + 50)
    assert.equal(rec.length, max)
    assert.equal(rec[0].tool, `t${max + 24}`)
  })

  it('recentEvents clamps absurd limits', () => {
    recordEvent(ev())
    assert.equal(recentEvents(0).length, 1)
    assert.equal(recentEvents(-5).length, 1)
    assert.ok(recentEvents(999999).length <= 500)
  })

  it('publishes to subscribers and drops failing sinks', () => {
    const seen: number[] = []
    const unsub = subscribeActivity((line) => {
      seen.push(JSON.parse(line.replace(/^data: /, '')).seq)
      return true
    })
    subscribeActivity(() => false) // one-shot failing sink
    const before = subscriberCount()
    const e = recordEvent(ev())
    assert.deepEqual(seen, [e.seq])
    assert.equal(subscriberCount(), before - 1) // failing sink evicted
    unsub()
  })
})

describe('extraction', () => {
  it('keeps validated bead ids, drops free-text hyphenations', () => {
    const refs = extractBeadRefs('see task-f89c9 and the follow-on end-to-end heartbeat-delta for inbox-lkyt')
    assert.ok(refs.includes('task-f89c9'), `got ${refs}`)
    assert.ok(!refs.includes('follow-on'))
    assert.ok(!refs.includes('end-to-end'))
    assert.ok(!refs.includes('heartbeat-delta'))
  })

  it('keeps dotted sub-ids and dedupes, bounded by max', () => {
    const refs = extractBeadRefs('project-s1rf.1.1.2 then project-s1rf.1.1.2 again and task-f89c9', 2)
    assert.deepEqual(refs, ['project-s1rf.1.1.2', 'task-f89c9'])
  })

  it('never throws on garbage', () => {
    assert.deepEqual(extractBeadRefs(''), [])
  })
})

describe('summarizeResult', () => {
  it('prefers inner MCP result text and strips the relay footer', () => {
    const body = jsonRpcResult('# task-f89c9\n\nreal result here\n\n## relay-status (ephemeral projection — x)\n- row\nstale-triple')
    const s = summarizeResult(body)
    assert.ok(s.includes('real result here'), `got ${s}`)
    assert.ok(!s.includes('relay-status'), `got ${s}`)
  })

  it('bounds output length', () => {
    const max = activitySummaryChars()
    const s = summarizeResult(jsonRpcResult('y'.repeat(5000)))
    assert.ok(s.length <= max, `len ${s.length} > ${max}`)
  })

  it('falls back to the raw head for non-JSON', () => {
    assert.equal(summarizeResult('plain text result'), 'plain text result')
  })

  it('unwraps SSE-framed answers before summarizing', () => {
    const body = `event: message\ndata: ${jsonRpcResult('# task-f89c9\n\nreal result')}\n\n`
    const s = summarizeResult(body)
    assert.ok(s.includes('real result'), `got ${s}`)
    assert.ok(!s.includes('event:'), `got ${s}`)
  })
})

describe('withActivity', () => {
  beforeEach(() => resetActivity())

  const mcpReq = (tool: string, args: unknown = {}) =>
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: tool, arguments: args } }),
    })

  it('records tool, caller, session, arg names, bead refs — never values', async () => {
    const inner = async () => new Response(jsonRpcResult('# task-f89c9\n\nbody text'), { status: 200 })
    const h = withActivity(inner)
    const res = await runWithScope({ tool: 'bead_show', caller: 'loopback-local' }, () => h(mcpReq('bead_show', { id: 'task-f89c9', secret: 's3cr3t' })))
    assert.equal(res.status, 200)
    const rec = recentEvents(5)
    assert.equal(rec.length, 1)
    assert.equal(rec[0].tool, 'bead_show')
    assert.equal(rec[0].caller, 'loopback-local')
    assert.equal(rec[0].sessionId, 'sess-1')
    assert.deepEqual(rec[0].argNames, ['id', 'secret'])
    assert.ok(rec[0].beadRefs.includes('task-f89c9'))
    const serialized = JSON.stringify(rec[0])
    assert.ok(!serialized.includes('s3cr3t'), 'arg values must never be recorded')
  })

  it('skips bare/loop-excluded tools (loop prevention)', async () => {
    const inner = async () => new Response(jsonRpcResult('Feeds current.'), { status: 200 })
    const h = withActivity(inner)
    await runWithScope({ tool: 'heartbeat', caller: 'loopback-local' }, () => h(mcpReq('heartbeat')))
    assert.equal(recentEvents(5).length, 0)
  })

  it('skips unknown (non-tools/call) envelopes', async () => {
    const inner = async () => new Response('{}', { status: 200 })
    const h = withActivity(inner)
    const res = await runWithScope({ tool: 'unknown', caller: 'anonymous' }, () =>
      h(new Request('http://localhost/mcp', { method: 'GET' })),
    )
    assert.equal(res.status, 200)
    assert.equal(recentEvents(5).length, 0)
  })

  it('marks isError bodies as error outcome', async () => {
    const inner = async () =>
      new Response(JSON.stringify({ result: { content: [{ type: 'text', text: 'Nope' }], isError: true } }), { status: 200 })
    const h = withActivity(inner)
    await runWithScope({ tool: 'bead_show', caller: 'anonymous' }, () => h(mcpReq('bead_show')))
    assert.equal(recentEvents(5)[0].outcome, 'error')
  })

  it('records handler throws as error events, then rethrows (failure isolation)', async () => {
    const inner = async () => {
      throw new Error('boom')
    }
    const h = withActivity(inner)
    await assert.rejects(runWithScope({ tool: 'query_store', caller: 'anonymous' }, () => h(mcpReq('query_store'))), /boom/)
    const rec = recentEvents(5)
    assert.equal(rec.length, 1)
    assert.equal(rec[0].outcome, 'error')
  })

  it('returns the original response untouched when bodies are unreadable', async () => {
    const inner = async () => new Response(jsonRpcResult('ok'), { status: 200 })
    const h = withActivity(inner)
    const res = await runWithScope({ tool: 'whoami', caller: 'anonymous' }, () => h(mcpReq('whoami')))
    assert.equal(await res.text(), jsonRpcResult('ok'))
  })
})

describe('config', () => {
  it('auto-follow defaults on; maxes are sane', () => {
    assert.equal(activityAutoFollowDefault(), process.env.ACTIVITY_AUTOFOLLOW_DEFAULT === '0' ? false : true)
    assert.ok(activityMaxEvents() >= 10)
    assert.ok(activitySummaryChars() >= 40)
    assert.ok(activityMaxBeadRefs() >= 1)
  })
})
