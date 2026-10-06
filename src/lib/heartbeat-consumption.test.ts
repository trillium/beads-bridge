// Heartbeat consumption-semantics regression tests (task-36na1).
//
// Incident: inbox-lkyt closed 2026-09-27T05:47:36Z, yet an explicit
// heartbeat at ~05:55Z reported `delta (0 changed) / Feeds current.`
// Log reconstruction showed TWO stacked causes:
//   (B, actual) the close went through `bd` directly, never touching the
//       relay-status projection — heartbeat structurally cannot show
//       out-of-band store writes;
//   (A, latent) every footered MCP response CONSUMED the caller's delta,
//       so even a bridge-mediated event was one-shot: reported once by
//       whatever footer happened to compose next, then gone.
//
// The fix is acknowledge-on-read: automatic footers PEEK (project without
// advancing); only explicit `heartbeat` / `relay_status` reads advance the
// cursor. These tests pin that contract with isolated trackers and fixed
// timestamps — fully deterministic, no stores, no clock.
// Unit tests: bun test src/lib/heartbeat-consumption.test.ts (node:test).
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEARTBEAT_EXCLUDED_TOOLS,
  advanceHeartbeatCursor,
  heartbeatCursor,
  peekHeartbeatBlock,
  renderHeartbeatBlock,
  resetHeartbeatCursors,
} from './heartbeat'
import { RelayStatusTracker } from './relay-status'
import { clearFollowons, registerFollowon, runFollowons } from './followons'

const T0 = Date.parse('2026-09-27T05:40:00.000Z')

/** The exact close expression from src/routes/mcp.ts (bead_decision). */
function bridgeClose(t: RelayStatusTracker, id: string, now: number): void {
  t.markDone(id, now) ?? t.touch({ id, kind: 'completion', title: `Closed ${id}`, state: 'done', now })
}

/** The heartbeat follow-on spec exactly as registered in src/routes/mcp.ts. */
function registerMcpSpec(t: RelayStatusTracker): void {
  registerFollowon({
    name: 'heartbeat', priority: 100, excludeTools: HEARTBEAT_EXCLUDED_TOOLS,
    run: (ctx) => peekHeartbeatBlock(ctx.caller, { tracker: t, now: ctx.at }),
  })
}

function footer(t: RelayStatusTracker, tool: string, caller: string, at: number): string {
  return runFollowons({ tool, outcome: 'ok', caller, at }).lines.join('\n')
}

beforeEach(() => {
  resetHeartbeatCursors()
  clearFollowons()
})

describe('async closure surfaces on explicit heartbeat', () => {
  it('a bridge-mediated close after baseline shows on the next explicit heartbeat', () => {
    const t = new RelayStatusTracker()
    renderHeartbeatBlock('c', { tracker: t, now: T0 + 1000 }) // baseline
    bridgeClose(t, 'inbox-aaa', T0 + 2000)
    const hb = renderHeartbeatBlock('c', { tracker: t, now: T0 + 3000 })
    assert.match(hb, /delta/)
    assert.match(hb, /inbox-aaa/)
  })
  it('out-of-band store writes never enter the projection (incident cause B)', () => {
    // A direct `bd` close touches the store only — the tracker hears
    // nothing, so heartbeat structurally cannot report it. This pins the
    // boundary: heartbeat covers bridge-mediated changes;
    // `retrieval_activity` (live store reads) is the anchor for the rest.
    const t = new RelayStatusTracker()
    renderHeartbeatBlock('c', { tracker: t, now: T0 + 1000 }) // baseline
    // ... external close happens here (no tracker call exists to make) ...
    const hb = renderHeartbeatBlock('c', { tracker: t, now: T0 + 3000 })
    assert.match(hb, /delta \(0 changed/)
    assert.match(hb, /Feeds current\./)
  })
})

describe('intervening automatic footers peek, never consume', () => {
  it('an unrelated footer reports the pending close but leaves it for heartbeat', () => {
    const t = new RelayStatusTracker()
    registerMcpSpec(t)
    renderHeartbeatBlock('c', { tracker: t, now: T0 + 1000 }) // baseline
    bridgeClose(t, 'inbox-bbb', T0 + 2000)
    const f = footer(t, 'bead_show', 'c', T0 + 3000)
    assert.match(f, /inbox-bbb/, 'footer still surfaces the pending event')
    assert.equal(heartbeatCursor('c'), T0 + 1000, 'footer must not advance the cursor')
    const hb = renderHeartbeatBlock('c', { tracker: t, now: T0 + 4000 })
    assert.match(hb, /inbox-bbb/, 'explicit heartbeat still sees the close')
  })
  it('many intervening footers cannot drain the delta', () => {
    const t = new RelayStatusTracker()
    registerMcpSpec(t)
    renderHeartbeatBlock('c', { tracker: t, now: T0 + 1000 })
    bridgeClose(t, 'inbox-ccc', T0 + 2000)
    for (const [i, tool] of ['bead_show', 'query_store', 'bead_create', 'whoami', 'retrieval_search'].entries()) {
      const f = footer(t, tool, 'c', T0 + 3000 + i)
      assert.match(f, /inbox-ccc/, `${tool} footer repeats the pending event`)
    }
    assert.match(renderHeartbeatBlock('c', { tracker: t, now: T0 + 9000 }), /inbox-ccc/)
  })
  it('error-outcome footers peek too', () => {
    const t = new RelayStatusTracker()
    registerMcpSpec(t)
    renderHeartbeatBlock('c', { tracker: t, now: T0 + 1000 })
    bridgeClose(t, 'inbox-ddd', T0 + 2000)
    const r = runFollowons({ tool: 'bead_show', outcome: 'error', caller: 'c', at: T0 + 3000 })
    assert.match(r.lines.join('\n'), /inbox-ddd/)
    assert.equal(heartbeatCursor('c'), T0 + 1000)
  })
})

describe('explicit reads acknowledge', () => {
  it('a second explicit heartbeat no longer repeats the acknowledged close', () => {
    const t = new RelayStatusTracker()
    registerMcpSpec(t)
    renderHeartbeatBlock('c', { tracker: t, now: T0 + 1000 })
    bridgeClose(t, 'inbox-eee', T0 + 2000)
    assert.match(renderHeartbeatBlock('c', { tracker: t, now: T0 + 3000 }), /inbox-eee/)
    const again = renderHeartbeatBlock('c', { tracker: t, now: T0 + 4000 })
    assert.match(again, /delta \(0 changed/, 'acknowledged — nothing new')
    assert.doesNotMatch(again, /inbox-eee/)
  })
  it('manual advance (the relay_status path) acknowledges the same way', () => {
    const t = new RelayStatusTracker()
    registerMcpSpec(t)
    renderHeartbeatBlock('c', { tracker: t, now: T0 + 1000 })
    bridgeClose(t, 'inbox-fff', T0 + 2000)
    advanceHeartbeatCursor('c', T0 + 3000) // what relay_status does after showing the full projection
    assert.doesNotMatch(renderHeartbeatBlock('c', { tracker: t, now: T0 + 4000 }), /inbox-fff/)
  })
  it('peek on a first-ever query is baseline and creates no cursor', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'task-z9', kind: 'task', title: 'Zed', now: T0 })
    const p = peekHeartbeatBlock('fresh', { tracker: t, now: T0 + 1000 })
    assert.match(p, /baseline/)
    assert.match(p, /task-z9/)
    assert.equal(heartbeatCursor('fresh'), null, 'peek must not plant a cursor')
  })
})

describe('per-caller isolation', () => {
  it('distinct OAuth clientIds hold independent cursors', () => {
    const t = new RelayStatusTracker()
    registerMcpSpec(t)
    renderHeartbeatBlock('client-A', { tracker: t, now: T0 + 1000 })
    renderHeartbeatBlock('client-B', { tracker: t, now: T0 + 1000 })
    bridgeClose(t, 'inbox-ggg', T0 + 2000)
    assert.match(renderHeartbeatBlock('client-A', { tracker: t, now: T0 + 3000 }), /inbox-ggg/)
    // B never read since the close: its delta still holds it, even though
    // A already acknowledged — one's advance never affects another's.
    assert.match(renderHeartbeatBlock('client-B', { tracker: t, now: T0 + 4000 }), /inbox-ggg/)
    // And A, having acknowledged, no longer sees it.
    assert.doesNotMatch(renderHeartbeatBlock('client-A', { tracker: t, now: T0 + 5000 }), /inbox-ggg/)
  })
  it('loopback-local is ONE shared cursor (gateway fan-in — known limitation)', () => {
    // Every caller arriving via the MCPJungle gateway resolves to the
    // constant 'loopback-local' (src/routes/mcp.ts caller resolver), so
    // distinct humans behind the gateway share a cursor. Footers no longer
    // write cursors at all, so the blast radius is now explicit
    // heartbeat/relay_status races only — but the sharing itself needs
    // gateway-forwarded identity to fix, which the bridge never receives.
    const t = new RelayStatusTracker()
    registerMcpSpec(t)
    renderHeartbeatBlock('loopback-local', { tracker: t, now: T0 + 1000 })
    bridgeClose(t, 'inbox-hhh', T0 + 2000)
    assert.match(renderHeartbeatBlock('loopback-local', { tracker: t, now: T0 + 3000 }), /inbox-hhh/)
    assert.doesNotMatch(
      renderHeartbeatBlock('loopback-local', { tracker: t, now: T0 + 4000 }),
      /inbox-hhh/,
      'same key = same cursor: a second gateway client would miss it too',
    )
  })
})
