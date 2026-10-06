// Heartbeat tests (task-ksmy1 safety floor): loop prevention,
// observational-only (no mutation), bounded output, cursor delta
// (first query / unchanged / changed / concurrent), template rendering.
// Unit tests: bun test src/lib/heartbeat.test.ts (node:test, no new deps).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  HEARTBEAT_MAX_CHARS,
  HEARTBEAT_MAX_ITEMS,
  HEARTBEAT_EMPTY_NOTICE,
  HEARTBEAT_EXCLUDED_TOOLS,
  HEARTBEAT_TEMPLATE_ENV,
  advanceHeartbeatCursor,
  heartbeatCursor,
  heartbeatReading,
  loadHeartbeatTemplate,
  renderHeartbeatBlock,
  renderHeartbeatTemplate,
  resetHeartbeatCursors,
} from './heartbeat'
import { RelayStatusTracker } from './relay-status'
import { clearFollowons, registerFollowon, runFollowons } from './followons'

const T0 = Date.parse('2026-09-26T12:00:00.000Z')
let savedTpl: string | undefined

function tracked(): RelayStatusTracker {
  const t = new RelayStatusTracker()
  t.touch({ id: 'task-a1', kind: 'task', title: 'Alpha', now: T0 })
  t.touch({ id: 'task-b2', kind: 'dispatch', title: 'Beta', state: 'waiting', now: T0 + 1000 })
  return t
}

function snapshot(t: RelayStatusTracker): string {
  return JSON.stringify(t.list(T0 + 999999).map((r) => [r.item.id, r.item.title, r.item.lastTouchedAt, r.item.state, r.item.needsVerify]))
}

beforeEach(() => {
  resetHeartbeatCursors()
  clearFollowons()
  savedTpl = process.env[HEARTBEAT_TEMPLATE_ENV]
  delete process.env[HEARTBEAT_TEMPLATE_ENV]
})

afterEach(() => {
  if (savedTpl === undefined) delete process.env[HEARTBEAT_TEMPLATE_ENV]
  else process.env[HEARTBEAT_TEMPLATE_ENV] = savedTpl
})

describe('loop prevention', () => {
  it('heartbeat/relay_status/timeout_probe are excluded from follow-ons', () => {
    assert.ok(HEARTBEAT_EXCLUDED_TOOLS.includes('heartbeat'))
    assert.ok(HEARTBEAT_EXCLUDED_TOOLS.includes('relay_status'))
    assert.ok(HEARTBEAT_EXCLUDED_TOOLS.includes('timeout_probe'))
    registerFollowon({
      name: 'heartbeat', priority: 100, excludeTools: HEARTBEAT_EXCLUDED_TOOLS,
      run: () => ['x'],
    })
    for (const tool of HEARTBEAT_EXCLUDED_TOOLS) {
      const r = runFollowons({ tool, outcome: 'ok', caller: 'c', at: T0 })
      assert.deepEqual(r.lines, [], `${tool}: footer output must never re-trigger`)
    }
    const ok = runFollowons({ tool: 'bead_show', outcome: 'ok', caller: 'c', at: T0 })
    assert.deepEqual(ok.lines, ['x'])
  })
})

describe('observational only', () => {
  it('composing a block mutates nothing but the caller cursor', () => {
    const t = tracked()
    const before = snapshot(t)
    const size = t.size
    const out = renderHeartbeatBlock('caller-1', { tracker: t, now: T0 + 5000 })
    assert.match(out, /task-a1/)
    assert.equal(snapshot(t), before, 'tracker items untouched')
    assert.equal(t.size, size)
    assert.equal(heartbeatCursor('caller-1'), T0 + 5000)
  })
})

describe('bounded output', () => {
  it('caps rows and chars on a full tracker with long titles', () => {
    const t = new RelayStatusTracker()
    for (let i = 0; i < 20; i++) {
      t.touch({ id: `task-long-${i}`, kind: 'task', title: 'y'.repeat(120), now: T0 + i })
    }
    const out = renderHeartbeatBlock('c', { tracker: t, now: T0 + 100000 })
    assert.ok(out.length <= HEARTBEAT_MAX_CHARS, `len ${out.length}`)
    const rows = out.split('\n').filter((l) => l.startsWith('- task-long-'))
    assert.ok(rows.length <= HEARTBEAT_MAX_ITEMS, `${rows.length} rows`)
    assert.match(out, /\+\d+ more/)
  })
})

describe('cursor delta', () => {
  it('first-ever query returns the baseline projection', () => {
    const out = renderHeartbeatBlock('new-caller', { tracker: tracked(), now: T0 + 2000 })
    assert.match(out, /baseline/)
    assert.match(out, /task-a1/)
    assert.match(out, /task-b2/)
    assert.doesNotMatch(out, new RegExp(HEARTBEAT_EMPTY_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
  it('unchanged state returns the minimal acknowledgement', () => {
    const t = tracked()
    renderHeartbeatBlock('c', { tracker: t, now: T0 + 2000 })
    const again = renderHeartbeatBlock('c', { tracker: t, now: T0 + 3000 })
    assert.match(again, /delta/)
    assert.match(again, new RegExp(HEARTBEAT_EMPTY_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
  it('changed state reports only items touched after the cursor', () => {
    const t = tracked()
    renderHeartbeatBlock('c', { tracker: t, now: T0 + 2000 })
    t.touch({ id: 'task-c3', kind: 'task', title: 'Gamma', now: T0 + 4000 })
    const out = renderHeartbeatBlock('c', { tracker: t, now: T0 + 5000 })
    assert.match(out, /task-c3/)
    assert.doesNotMatch(out, /task-a1/)
    assert.doesNotMatch(out, /task-b2/)
  })
  it('concurrent callers hold independent cursors', () => {
    const t = tracked()
    renderHeartbeatBlock('alice', { tracker: t, now: T0 + 2000 })
    t.touch({ id: 'task-c3', kind: 'task', title: 'Gamma', now: T0 + 4000 })
    const bob = renderHeartbeatBlock('bob', { tracker: t, now: T0 + 5000 })
    assert.match(bob, /baseline/)
    assert.match(bob, /task-a1/)
    assert.match(bob, /task-c3/)
    const alice = renderHeartbeatBlock('alice', { tracker: t, now: T0 + 6000 })
    assert.match(alice, /task-c3/)
    assert.doesNotMatch(alice, /task-a1/)
  })
  it('empty tracker on first query is Feeds current, not an error', () => {
    const out = renderHeartbeatBlock('c', { tracker: new RelayStatusTracker(), now: T0 })
    assert.match(out, new RegExp(HEARTBEAT_EMPTY_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
  it('renders bridge activity, never a lifecycle-shaped state (inbox-1uxt)', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'inbox-abc', kind: 'task', title: 'Closed outside the bridge', now: T0 })
    const out = renderHeartbeatBlock('c', { tracker: t, now: T0 + 2000 })
    assert.match(out, /- inbox-abc \[task\/touched\]/)
    assert.doesNotMatch(out, /\[[^\]]*\/active\]/, '`active` beside a bead id reads as lifecycle OPEN')
  })
})

describe('template rendering', () => {
  it('selects changed/empty blocks and fills placeholders', () => {
    const tpl = '[{{mode}}:{{count}}]{{#changed}}<{{items}}>{{/changed}}{{#empty}}E{{/empty}}'
    assert.equal(
      renderHeartbeatTemplate(tpl, { mode: 'delta', count: 2, items: 'a\nb', read: 'T0' }),
      '[delta:2]<a\nb>',
    )
    assert.equal(renderHeartbeatTemplate(tpl, { mode: 'delta', count: 0, items: '', read: 'T0' }), '[delta:0]E')
  })
  it('loads a filesystem template so wording evolves without code changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-'))
    try {
      const p = join(dir, 'custom.md')
      writeFileSync(p, 'CUSTOM {{count}} {{#empty}}NONE{{/empty}}{{#changed}}{{items}}{{/changed}}')
      process.env[HEARTBEAT_TEMPLATE_ENV] = p
      assert.match(loadHeartbeatTemplate(), /CUSTOM/)
      const t = tracked()
      renderHeartbeatBlock('c', { tracker: t, now: T0 + 2000 })
      assert.match(renderHeartbeatBlock('c', { tracker: t, now: T0 + 3000 }), /CUSTOM 0 NONE/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('falls back to the built-in default on missing file or bad template', () => {
    process.env[HEARTBEAT_TEMPLATE_ENV] = '/nonexistent/hb-template.md'
    assert.match(loadHeartbeatTemplate(), /\{\{count\}\}/)
    const dir = mkdtempSync(join(tmpdir(), 'hb-'))
    try {
      const p = join(dir, 'bad.md')
      writeFileSync(p, 'no placeholders here')
      process.env[HEARTBEAT_TEMPLATE_ENV] = p
      assert.match(loadHeartbeatTemplate(), /\{\{count\}\}/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('manual cursor advance composes (relay_status reads advance too)', () => {
    const t = tracked()
    advanceHeartbeatCursor('c', T0 + 2000)
    const out = renderHeartbeatBlock('c', { tracker: t, now: T0 + 3000 })
    assert.match(out, new RegExp(HEARTBEAT_EMPTY_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

// ---- timestamps + computed ages (task-60f3z) ----
//
// The 2026-10-06 failure: a worker status said "working" while its last
// meaningful action was minutes old, because the heartbeat row carried no
// time at all. These tests pin the three rules that fix it — source time is
// preserved, a touch-only time is labeled as such, and the age is measured
// against the read.
describe('event timestamps and ages (task-60f3z)', () => {
  const READ = T0 + 30 * 60_000

  function mixed(): RelayStatusTracker {
    const t = new RelayStatusTracker()
    // Source timestamp: the store's own last-change time for this bead.
    t.touch({
      id: 'task-src',
      kind: 'task',
      title: 'Store says it changed 20 minutes ago',
      now: T0 + 60_000,
      at: new Date(READ - 20 * 60_000).toISOString(),
    })
    // Touch only: the bridge acted, but nothing carries an event time.
    t.touch({ id: 'task-touch', kind: 'dispatch', title: 'Dispatched, no source time', now: T0 + 2 * 60_000 })
    return t
  }

  it('renders every row with a timestamp and an age against this read', () => {
    const out = renderHeartbeatBlock('c', { tracker: mixed(), now: READ })
    assert.match(out, /read at \d{4}-\d\d-\d\dT/)
    assert.match(out, /- task-src \[task\/touched\].*20 minutes ago/)
    assert.match(out, /- task-touch \[dispatch\/touched\].*28 minutes ago/)
  })

  it('makes stale and fresh evidence unmistakable in one block', () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'task-fresh', kind: 'task', title: 'Fresh', now: READ })
    t.touch({ id: 'task-old', kind: 'task', title: 'Stale proof', now: READ - 47 * 60_000 })
    const out = renderHeartbeatBlock('c', { tracker: t, now: READ })
    assert.match(out, /- task-fresh .*just now/)
    assert.match(out, /- task-old .*47 minutes ago/)
  })

  it('preserves the SOURCE time and never substitutes the touch time', () => {
    const t = mixed()
    const src = t.get('task-src')
    assert.ok(src)
    assert.equal(src.timeBasis, 'source')
    assert.equal(src.eventAt, new Date(READ - 20 * 60_000).toISOString())
    assert.notEqual(src.eventAt, src.lastTouchedAt, 'the bridge touch is not the event time')
    const out = renderHeartbeatBlock('c', { tracker: t, now: READ })
    assert.match(out, /at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ \(20 minutes ago\)/)
    assert.match(out, /· touched /, 'the touch stays visible beside the source time')
  })

  it('labels a touch-only time as a touch, not the action own time', () => {
    const t = mixed()
    const touched = t.get('task-touch')
    assert.ok(touched)
    assert.equal(touched.timeBasis, 'touch')
    assert.equal(touched.eventAt, undefined, 'a touch is never backfilled as an event time')
    const out = renderHeartbeatBlock('c', { tracker: t, now: READ })
    assert.match(out, /touched \d{4}-\d\d-\d\dT[^)]*touch time/)
  })

  it('stays inside the char budget with timestamps on every row', () => {
    const t = new RelayStatusTracker()
    for (let i = 0; i < 8; i++) {
      t.touch({ id: `task-${i}`, kind: 'task', title: `row ${i}`, now: READ - i * 60000 })
    }
    const out = renderHeartbeatBlock('c', { tracker: t, now: READ })
    assert.ok(out.length <= HEARTBEAT_MAX_CHARS, `block is ${out.length} chars`)
    assert.match(out, /ago|just now/)
  })

  it('heartbeatReading ships the data needed to recompute the delta', () => {
    const r = heartbeatReading('c', { tracker: mixed(), now: READ })
    assert.equal(r.mode, 'baseline')
    assert.equal(r.readAtMs, READ)
    assert.equal(r.readAt, new Date(READ).toISOString())
    assert.equal(r.count, 2)
    const src = r.items.find((i) => i.id === 'task-src')
    assert.ok(src)
    assert.equal(src.basis, 'source')
    assert.equal(src.event.atMs, READ - 20 * 60_000)
    assert.equal(src.event.ageMs, 20 * 60_000)
    assert.equal(src.event.age, '20 minutes ago')
    // The touch is carried separately, never in place of the event.
    assert.equal(src.touched.atMs, T0 + 60_000)
    const touch = r.items.find((i) => i.id === 'task-touch')
    assert.ok(touch)
    assert.equal(touch.basis, 'touch')
    assert.equal(touch.event.ageMs, 28 * 60_000)
  })

  it('heartbeatReading mirrors the cursor split without acknowledging anything', () => {
    const t = mixed()
    advanceHeartbeatCursor('c', T0 + 10_000)
    const r = heartbeatReading('c', { tracker: t, now: READ })
    assert.equal(r.mode, 'delta')
    assert.equal(r.count, 2)
    assert.equal(heartbeatCursor('c'), T0 + 10_000, 'reading data never advances the cursor')
    renderHeartbeatBlock('c', { tracker: t, now: READ })
    const empty = heartbeatReading('c', { tracker: t, now: READ })
    assert.equal(empty.mode, 'delta')
    assert.equal(empty.count, 0, 'acknowledged read empties the delta')
  })
})
