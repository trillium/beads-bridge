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
      renderHeartbeatTemplate(tpl, { mode: 'delta', count: 2, items: 'a\nb' }),
      '[delta:2]<a\nb>',
    )
    assert.equal(renderHeartbeatTemplate(tpl, { mode: 'delta', count: 0, items: '' }), '[delta:0]E')
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
