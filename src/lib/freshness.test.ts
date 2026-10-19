import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadFreshness, renderFreshness, type BeadFreshness } from './freshness'

// bead_show freshness (task-6b6ij). The store is a fake CLI script so the
// bd fallback runs for real without touching any bead store. SQL is forced
// off and the store guard disabled for this file only.

const READ = Date.parse('2026-10-19T09:00:00.000Z')
const TOUCH = '2026-10-19T07:00:00Z'

let dir: string
const saved: Record<string, string | undefined> = {}

function fakeStore(name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'freshness-'))
  for (const k of ['BEADS_BRIDGE_SQL', 'BEADS_BRIDGE_STORE_GUARD']) saved[k] = process.env[k]
  process.env.BEADS_BRIDGE_SQL = 'off'
  process.env.BEADS_BRIDGE_STORE_GUARD = 'off'
})

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('beadFreshness', () => {
  it('is fresh when the store reports an updated_at, aged against the read', async () => {
    const store = fakeStore('store-ok', `echo '[{"id":"task-x","updated_at":"${TOUCH}"}]'`)
    const f = await beadFreshness(store, 'task-x', READ)
    assert.equal(f.fresh, true)
    assert.equal(f.as_of, new Date(READ).toISOString())
    assert.equal(f.last_touch, new Date(TOUCH).toISOString())
    assert.equal(f.last_touch_age, '2 hours ago')
    assert.equal(f.reason, undefined)
  })

  it('is not fresh, with a reason, when the store reports no touch time', async () => {
    const store = fakeStore('store-notouch', `echo '[{"id":"task-x"}]'`)
    const f = await beadFreshness(store, 'task-x', READ)
    assert.equal(f.fresh, false)
    assert.equal(f.last_touch, null)
    assert.equal(f.last_touch_age, 'age unknown')
    assert.equal(f.reason, 'store reported no touch time')
  })

  it('never throws: a failed touch lookup is a fresh:false answer with its reason', async () => {
    const store = fakeStore('store-fail', 'echo "boom" >&2; exit 2')
    const f = await beadFreshness(store, 'task-x', READ)
    assert.equal(f.fresh, false)
    assert.equal(f.last_touch, null)
    assert.equal(f.reason, 'touch lookup failed')
  })
})

describe('renderFreshness', () => {
  it('names the read time, the touch with age, and the fresh flag', () => {
    const f: BeadFreshness = {
      as_of: new Date(READ).toISOString(),
      last_touch: new Date(TOUCH).toISOString(),
      last_touch_age: '2 hours ago',
      fresh: true,
    }
    const out = renderFreshness(f)
    assert.match(out, /^## freshness/m)
    assert.match(out, /as_of: 2026-10-19T09:00:00\.000Z \(this read\)/)
    assert.match(out, /last_touch: 2026-10-19T07:00:00\.000Z \(2 hours ago\) — the store's last update, comments included/)
    assert.match(out, /fresh: true$/m)
  })

  it('shows unknown touch and the reason when not fresh', () => {
    const out = renderFreshness({
      as_of: new Date(READ).toISOString(),
      last_touch: null,
      last_touch_age: 'age unknown',
      fresh: false,
      reason: 'touch lookup failed',
    })
    assert.match(out, /last_touch: unknown/)
    assert.match(out, /fresh: false — touch lookup failed/)
  })
})
