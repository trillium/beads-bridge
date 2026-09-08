import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bundleIds } from './beads'
import { mapLimit } from '../lib/exec'

describe('bundleIds', () => {
  it('keeps valid bead ids in order', () => {
    assert.deepEqual(bundleIds(['task-9omwr', 'resumes-zak']), ['task-9omwr', 'resumes-zak'])
  })
  it('drops invalid ids, trims, dedupes', () => {
    assert.deepEqual(bundleIds([' task-9omwr ', 'nope', 'a', 'task-9omwr', 'has space', 'UPPER-xy1']), ['task-9omwr'])
  })
  it('rejects path-like and child ids', () => {
    assert.deepEqual(bundleIds(['project-hpm.1', '../x', 'a/b']), [])
  })
  it('caps at 40', () => {
    const many = Array.from({ length: 60 }, (_, i) => `task-a${String(i).padStart(2, '0')}`)
    assert.equal(bundleIds(many).length, 40)
  })
})

describe('mapLimit', () => {
  it('preserves input order under concurrency', async () => {
    const delays = [30, 5, 20, 10]
    const out = await mapLimit(delays, 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    assert.deepEqual(out, delays)
  })
  it('surfaces worker errors instead of hanging', async () => {
    await assert.rejects(mapLimit([1], 1, async () => { throw new Error('boom') }), /boom/)
  })
})
