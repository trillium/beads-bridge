// Timestamp/age vocabulary (task-60f3z): source time is never replaced by a
// touch time, a touch-only time is labeled as such, and every age is computed
// against the READ time so it stays correct however late the read happens.
// Unit tests: bun test src/lib/age.test.ts (node:test, no new deps).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGE_UNKNOWN,
  JUST_NOW_MS,
  formatAge,
  humanAge,
  parseStampMs,
  renderStamp,
  stampFields,
  stampFieldsOf,
  stampIso,
} from './age'

const T0 = Date.parse('2026-10-06T05:00:00.000Z')

describe('parseStampMs', () => {
  it('accepts ISO strings, Dates, epoch seconds, and epoch ms', () => {
    assert.equal(parseStampMs('2026-10-06T05:00:00Z'), T0)
    assert.equal(parseStampMs(new Date(T0)), T0)
    assert.equal(parseStampMs(T0), T0)
    assert.equal(parseStampMs(Math.floor(T0 / 1000)), T0, 'epoch seconds are widened to ms')
    assert.equal(parseStampMs(String(Math.floor(T0 / 1000))), T0)
  })
  it('returns null for junk rather than inventing a time', () => {
    for (const junk of [undefined, null, '', '   ', 'not a time', {}, [], NaN, 0, -1]) {
      assert.equal(parseStampMs(junk), null, `expected null for ${JSON.stringify(junk)}`)
      assert.equal(stampIso(junk), null)
    }
  })
})

describe('formatAge', () => {
  it('renders human deltas against the read time', () => {
    assert.equal(formatAge(T0, T0), 'just now')
    assert.equal(formatAge(T0, T0 + 10 * 60_000), '10 minutes ago')
    assert.equal(formatAge(T0, T0 + 60 * 60_000), '1 hour ago')
    assert.equal(formatAge(T0, T0 + 3 * 3600_000), '3 hours ago')
    assert.equal(formatAge(T0, T0 + 26 * 3600_000), '1 day ago')
  })
  it('uses seconds under a minute and a just-now window for the first moments', () => {
    assert.equal(formatAge(T0, T0 + 5_000), 'just now')
    assert.equal(formatAge(T0, T0 + JUST_NOW_MS + 5000), '50s ago')
  })
  it('renders clock skew forward instead of a negative age', () => {
    assert.equal(formatAge(T0 + 120_000, T0), 'in 2 minutes')
  })
  it('moves with the read: the same event is 10m old now and 40m old an hour later', () => {
    const at = T0
    assert.equal(formatAge(at, T0 + 10 * 60_000), '10 minutes ago')
    assert.equal(formatAge(at, T0 + 50 * 60_000), '50 minutes ago')
  })
  it('humanAge stays the compact token form used in evidence lines', () => {
    assert.equal(humanAge(2 * 3600_000), '2h0m')
    assert.equal(humanAge(3 * 86400_000 + 60_000), '3d0h')
  })
})

describe('structured fields', () => {
  it('carries ISO + epoch ms + the computed delta, not just a rendered string', () => {
    const now = T0 + 10 * 60_000
    const f = stampFields(T0, now)
    assert.equal(f.at, '2026-10-06T05:00:00.000Z')
    assert.equal(f.atMs, T0)
    assert.equal(f.ageMs, 10 * 60_000)
    assert.equal(f.age, '10 minutes ago')
    // The consumer can recompute the delta itself: now - atMs.
    assert.equal(now - (f.atMs as number), f.ageMs)
  })
  it('says the age is unknown when there is no usable timestamp', () => {
    assert.deepEqual(stampFields(null, T0), { age: AGE_UNKNOWN })
    assert.deepEqual(stampFieldsOf('nonsense', T0), { age: AGE_UNKNOWN })
  })
  it('accepts any store-row timestamp form', () => {
    assert.equal(stampFieldsOf('2026-10-06T05:00:00Z', T0).age, 'just now')
    assert.equal(stampFieldsOf(T0, T0 + 60_000).ageMs, 60_000)
  })
})

describe('renderStamp', () => {
  it('marks a source time as the event time', () => {
    const out = renderStamp('2026-10-06T05:00:00Z', T0 + 10 * 60_000, 'source')
    assert.equal(out, 'at 2026-10-06T05:00:00.000Z (10 minutes ago)')
  })
  it('labels a touch time as a touch, never as the action own time', () => {
    const out = renderStamp('2026-10-06T05:00:00Z', T0 + 10 * 60_000, 'touch')
    assert.match(out, /^touched 2026-10-06T05:00:00\.000Z \(10 minutes ago, touch time/)
    assert.doesNotMatch(out, /\bat /, 'a touch must never render as `at`')
  })
  it('never fabricates a time it does not have', () => {
    assert.equal(renderStamp(undefined, T0, 'touch'), `touched ${AGE_UNKNOWN}`)
    assert.equal(renderStamp(undefined, T0, 'source'), `at ${AGE_UNKNOWN}`)
  })
})