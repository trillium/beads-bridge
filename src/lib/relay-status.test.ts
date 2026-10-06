import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  RelayStatusTracker,
  activityStateLabel,
  formatRelayStatus,
  relayItemTiming,
  relayStatusReading,
  relayStatusTtlMs,
  withRelayStatus,
  RELAY_STATUS_MAX_CHARS,
} from './relay-status'
import { BRIDGE_OP_NAMES, stalenessTriple } from './capabilities'
import { serverVersion } from './whoami'

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  delete process.env.RELAY_STATUS_TTL_MS
})

describe('relayStatusTtlMs', () => {
  it('defaults to two hours and honours env override', () => {
    assert.equal(relayStatusTtlMs(), 2 * HOUR)
    process.env.RELAY_STATUS_TTL_MS = '60000'
    assert.equal(relayStatusTtlMs(), 60000)
  })
})

describe('staleness', () => {
  it('ages out after TTL unless pinned or waiting', () => {
    const t = new RelayStatusTracker()
    const now = Date.now()
    t.touch({ id: 'task-aaa', kind: 'task', now })
    t.touch({ id: 'task-bbb', kind: 'task', pinned: true, now })
    t.touch({ id: 'task-ccc', kind: 'dispatch', state: 'waiting', now })
    const later = now + 3 * HOUR
    const states = Object.fromEntries(t.list(later).map((r) => [r.item.id, r.state]))
    assert.equal(states['task-aaa'], 'stale')
    assert.equal(states['task-bbb'], 'active')
    assert.equal(states['task-ccc'], 'waiting')
  })
})

describe('bounding', () => {
  it('caps items and total chars', () => {
    const t = new RelayStatusTracker()
    for (let i = 0; i < 20; i++) t.touch({ id: `task-${i}`, kind: 'task', title: `item number ${i}` })
    assert.ok(t.size <= 8)
    assert.ok(formatRelayStatus(t).length <= RELAY_STATUS_MAX_CHARS)
  })
  it('renders clear when empty and stays concise', () => {
    const out = formatRelayStatus(new RelayStatusTracker())
    assert.match(out, /clear/)
    assert.match(out, /authoritative/)
  })
})

describe('same-turn chaining', () => {
  it('one tool result causes a second MCP read before the user-facing reply', () => {
    const t = new RelayStatusTracker()
    const now = Date.now()
    t.touch({ id: 'task-stale1', kind: 'task', title: 'Fix login loop', now })
    const reply1 = withRelayStatus('# created task-stale1', t, now)
    assert.match(reply1, /task-stale1/)
    assert.doesNotMatch(reply1, /followup:/)
    const later = now + 3 * HOUR
    const reply2 = withRelayStatus('# query — task (3)', t, later)
    assert.match(reply2, /followup: bead_show task-stale1 — stale/)
    const chained = t.markVerified('task-stale1', later)
    assert.ok(chained)
    const reply3 = withRelayStatus(`# task-stale1 re-read — still open`, t, later)
    assert.doesNotMatch(reply3, /followup: bead_show task-stale1/)
  })
  it('failed items trigger a follow-up read that clears on verify', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'task-f1', kind: 'failure', title: 'Dispatch failed', state: 'failed' })
    assert.match(formatRelayStatus(t), /followup: bead_show task-f1 — failed/)
    t.markVerified('task-f1')
    assert.doesNotMatch(formatRelayStatus(t), /followup:/)
  })
  it('needs-verify items suggest relay_verify first', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'task-v1', kind: 'verify', needsVerify: true })
    assert.match(formatRelayStatus(t), /followup: relay_verify or bead_show task-v1/)
  })
})

describe('bridge-activity vocabulary (inbox-1uxt)', () => {
  // The tracker's `state` is bridge bookkeeping, not bead lifecycle: a bead
  // read as CLOSED must not be projected as `active` in the SAME response
  // (that read + this projection compose one reply). Rendering the raw
  // `active` token made one response assert OPEN and CLOSED at once.
  it('renders the default touch state as a non-lifecycle activity label', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'inbox-abc', kind: 'task', title: 'A bead the bridge touched' })
    const out = formatRelayStatus(t)
    assert.match(out, /- inbox-abc \[task\/touched\]/)
    assert.doesNotMatch(out, /\[[^\]]*\/active\]/, 'a lifecycle-shaped `active` token would collide with bead lifecycle OPEN')
    assert.match(out, /never bead lifecycle/)
  })
  it('activityStateLabel only relabels the lifecycle-colliding state', () => {
    assert.equal(activityStateLabel('active'), 'touched')
    for (const s of ['waiting', 'failed', 'done', 'stale'] as const) {
      assert.equal(activityStateLabel(s), s)
    }
  })
})

describe('staleness footer (task-qgplz.2)', () => {
  it('every footer ends with the version/commit/hash triple', () => {
    const triple = stalenessTriple()
    assert.match(
      triple,
      /^staleness: backend v\S+ \/ manifest v\S+ \/ commit \S+ \/ schema [0-9a-f]{16}$/,
    )
    assert.ok(triple.includes(`v${serverVersion()}`))
    for (const out of [formatRelayStatus(new RelayStatusTracker()), formatRelayStatus(trackerWithItems())]) {
      assert.ok(out.endsWith(`\n${triple}`), 'triple is the last footer line')
      assert.match(out, /## relay-status/) // old-shape header still parses
      assert.ok(out.length <= RELAY_STATUS_MAX_CHARS)
    }
  })
  it('withRelayStatus keeps the body parseable and appends the triple', () => {
    const reply = withRelayStatus('# created task-x', new RelayStatusTracker())
    assert.ok(reply.startsWith('# created task-x\n\n'))
    assert.ok(reply.endsWith(`\n${stalenessTriple()}`))
  })
  it('string compare detects any backend advance', () => {
    const t0 = stalenessTriple()
    assert.equal(stalenessTriple(), t0) // stable within a backend
    assert.notEqual(stalenessTriple([...opsPlusOne()]), t0) // tool-surface advance
  })
  it('triple survives truncation intact', () => {
    const t = new RelayStatusTracker()
    for (let i = 0; i < 20; i++) {
      t.touch({ id: `task-long-${i}`, kind: 'task', title: `x`.repeat(120) })
    }
    const out = formatRelayStatus(t)
    assert.ok(out.length <= RELAY_STATUS_MAX_CHARS)
    assert.ok(out.endsWith(`\n${stalenessTriple()}`))
  })
})

function trackerWithItems(): RelayStatusTracker {
  const t = new RelayStatusTracker()
  t.touch({ id: 'task-a1', kind: 'task', title: 'Something' })
  return t
}

function opsPlusOne(): string[] {
  return [...BRIDGE_OP_NAMES, 'hypothetical_new_tool']
}

// ---- source time vs touch time, and computed ages (task-60f3z) ----
//
// The incident this closes: a worker status said "working" while its last
// meaningful action was minutes old, because the only time on the wire was
// the bridge's touch time (or absent). Three rules are pinned here.
describe('event timestamps and ages (task-60f3z)', () => {
  const READ = Date.parse('2026-10-06T05:30:00.000Z')

  function mixed(): RelayStatusTracker {
    const t = new RelayStatusTracker()
    t.touch({ id: 'task-src', kind: 'task', title: 'Store changed this 22 minutes ago', now: READ - 60_000, at: new Date(READ - 22 * 60_000).toISOString() })
    t.touch({ id: 'task-touch', kind: 'dispatch', title: 'Bridge dispatched it', now: READ - 4 * 60_000 })
    return t
  }

  it('keeps the SOURCE time and shows the touch beside it, never in place of it', () => {
    const t = mixed()
    const src = t.get('task-src')
    assert.ok(src)
    assert.equal(src.timeBasis, 'source')
    assert.equal(src.eventAt, new Date(READ - 22 * 60_000).toISOString())
    const out = formatRelayStatus(t, READ)
    assert.match(out, /at 2026-10-06T05:08:00\.000Z \(22 minutes ago\) · touched \d{4}-\d\d-\d\dT[^ ]+ \(1 minutes? ago\)/)
  })

  it('labels a touch-only time as a touch, in words', () => {
    const t = mixed()
    assert.equal(t.get('task-touch')?.eventAt, undefined)
    assert.equal(t.get('task-touch')?.timeBasis, 'touch')
    assert.match(formatRelayStatus(t, READ), /touched \d{4}-\d\d-\d\dT[^ ]+ \(4 minutes ago, touch time — not the action's own time\)/)
  })

  it('marks the read time so every age has a stated anchor', () => {
    const out = formatRelayStatus(mixed(), READ)
    assert.match(out, new RegExp(`read at ${new Date(READ).toISOString()}`))
  })

  it('renders stale and fresh rows distinguishably in one projection', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'task-fresh', kind: 'task', title: 'Fresh', now: READ })
    t.touch({ id: 'task-stale', kind: 'task', title: 'Stale evidence', now: READ - 3 * HOUR })
    const out = formatRelayStatus(t, READ)
    assert.match(out, /- task-fresh .*just now/)
    assert.match(out, /- task-stale .*3 hours ago/)
  })

  it('markVerified/markDone keep a source time when given one and drop it otherwise', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'task-v', kind: 'verify', title: 'v', now: READ - 10 * 60_000, at: new Date(READ - 50 * 60_000).toISOString() })
    t.markVerified('task-v', READ)
    assert.equal(t.get('task-v')?.timeBasis, 'touch', 'no source time means no event time is claimed')
    assert.equal(t.get('task-v')?.eventAt, undefined)
    t.markDone('task-v', READ, new Date(READ - 30 * 60_000).toISOString())
    assert.equal(t.get('task-v')?.timeBasis, 'source')
    assert.equal(t.get('task-v')?.eventAt, new Date(READ - 30 * 60_000).toISOString())
  })

  it('structured timings carry both times, the basis, and ages at read', () => {
    const r = relayStatusReading(mixed(), READ)
    assert.equal(r.readAtMs, READ)
    assert.equal(r.count, 2)
    const src = r.items.find((i) => i.id === 'task-src')!
    assert.equal(src.basis, 'source')
    assert.equal(src.event.atMs, READ - 22 * 60_000)
    assert.equal(src.event.ageMs, 22 * 60_000)
    assert.equal(src.event.age, '22 minutes ago')
    assert.equal(src.touched.atMs, READ - 60_000, 'the bridge touch is carried separately')
    const touch = r.items.find((i) => i.id === 'task-touch')!
    assert.equal(touch.basis, 'touch')
    assert.equal(touch.event.ageMs, 4 * 60_000)
    assert.equal(touch.touched.ageMs, 4 * 60_000)
  })

  it('an item with no usable timestamp reports unknown, never a guess', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'task-bad', kind: 'task', title: 'bad source time', now: READ - 60_000, at: 'not-a-time' })
    const timing = relayItemTiming(t.get('task-bad')!, 'active', READ)
    assert.equal(timing.basis, 'touch', 'an unparseable source time is not a source time')
    assert.match(formatRelayStatus(t, READ), /touch time — not the action's own time/)
  })

  it('an age tracks the read: the same projection reads 10m old now, 70m old an hour later', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'task-x', kind: 'task', title: 'x', now: READ })
    assert.match(formatRelayStatus(t, READ), /just now/)
    assert.match(formatRelayStatus(t, READ + 70 * 60_000), /1 hour ago/)
  })
})
