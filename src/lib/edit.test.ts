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
  it('builds title/description updates', () => {
    assert.deepEqual(buildEditArgs('task-1', { title: 'New' }), ['update', 'task-1', '--title', 'New'])
    assert.deepEqual(buildEditArgs('task-1', { description: 'D' }), ['update', 'task-1', '-d', 'D'])
  })
})
