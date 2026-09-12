import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  RelayStatusTracker,
  formatRelayStatus,
  relayStatusTtlMs,
  withRelayStatus,
  RELAY_STATUS_MAX_CHARS,
} from './relay-status'

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
