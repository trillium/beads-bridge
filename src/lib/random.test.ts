// Unit tests: bun test src/lib/random.test.ts (node:test, no new deps).
// Pure sampler only — no subprocesses, no stores touched.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sampleIndices, formatPicks } from './random'

describe('sampleIndices', () => {
  it('samples without replacement, capped at n', () => {
    const got = sampleIndices(5, 3, () => 0)
    assert.deepEqual(got, [0, 1, 2])
    assert.equal(new Set(got).size, got.length)
    assert.deepEqual(sampleIndices(2, 9, () => 0.99).length, 2)
    assert.deepEqual(sampleIndices(0, 3), [])
  })
})

describe('formatPicks', () => {
  it('renders ids with context pointers', () => {
    const out = formatPicks([{ id: 'task-1', title: 'T', store: 'task', labels: ['a'] }], 42)
    assert.ok(out.includes('1 of 42 open'))
    assert.ok(out.includes('task-1 — T [task]'))
    assert.ok(out.includes('bead_show task-1'))
  })
})
