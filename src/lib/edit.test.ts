// Unit tests: bun test src/lib/edit.test.ts (node:test, no new deps).
// Pure argv builder only — no subprocesses, no stores touched.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildEditArgs } from './edit'

describe('buildEditArgs', () => {
  it('needs at least one field', () => {
    assert.equal(buildEditArgs('task-1', {}), null)
    assert.equal(buildEditArgs('task-1', { title: '  ' }), null)
  })
  it('passes a 5,200-char description through verbatim (no silent slice)', () => {
    const long = 'x'.repeat(5200)
    assert.deepEqual(buildEditArgs('task-1', { description: long }), ['update', 'task-1', '-d', long])
  })
  it('builds title/description updates', () => {
    assert.deepEqual(buildEditArgs('task-1', { title: 'New' }), ['update', 'task-1', '--title', 'New'])
    assert.deepEqual(buildEditArgs('task-1', { description: 'D' }), ['update', 'task-1', '-d', 'D'])
  })
})
