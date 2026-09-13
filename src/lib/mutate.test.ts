// Unit tests: bun test src/lib/mutate.test.ts (node:test, no new deps).
// Failure paths use a bogus store binary (spawn ENOENT — hermetic, no real
// store touched). Success paths against real stores are verified live;
// here we cover receipts, validation, and throw-on-failure semantics.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  commentBead,
  formatReceipt,
  labelBead,
  noteBead,
  runMutation,
  runMutationSync,
  verifyBead,
} from './mutate'

const BOGUS = 'no-such-store-xyz'

describe('formatReceipt', () => {
  it('shapes a verified receipt with explicit id, store, operation', () => {
    const out = formatReceipt({ operation: 'created', id: 'task-abc12', store: 'task', verified: true, detail: 'shown' })
    assert.match(out, /# created task-abc12 \(STORE: task\)/)
    assert.match(out, /Verified: yes/)
    assert.match(out, /shown/)
  })
  it('flags unverified receipts conspicuously', () => {
    const out = formatReceipt({ operation: 'comment added', id: 'task-abc12', store: 'task', verified: false, detail: 'x' })
    assert.match(out, /Verified: NO/)
  })
  it('inserts the extra block (labels) between verification and detail', () => {
    const out = formatReceipt(
      { operation: 'created', id: 'task-abc12', store: 'task', verified: true, detail: 'DETAIL' },
      'Labels: project:x',
    )
    const lv = out.indexOf('Verified: yes')
    const ll = out.indexOf('Labels: project:x')
    const ld = out.indexOf('DETAIL')
    assert.ok(lv >= 0 && ll > lv && ld > ll)
  })
})

describe('runMutation', () => {
  it('throws instead of returning error text as success', async () => {
    await assert.rejects(() => runMutation(BOGUS, ['show', 'task-1'], 5000))
  })
  it('sync variant throws too', () => {
    assert.throws(() => runMutationSync(BOGUS, ['show', 'task-1'], 5000))
  })
  it('failure messages do not echo user text back', async () => {
    const secret = 'S3CR3T-user-text-must-not-leak'
    try {
      await runMutation(BOGUS, ['comment', 'task-1', secret], 5000)
      assert.fail('should have thrown')
    } catch (e) {
      assert.doesNotMatch((e as Error).message, /S3CR3T/)
    }
  })
})

describe('verifyBead', () => {
  it('returns null (never throws) when the bead does not read back', async () => {
    assert.equal(await verifyBead(BOGUS, 'task-1'), null)
  })
})

describe('mutation validation', () => {
  it('commentBead rejects empty text before spawning', async () => {
    await assert.rejects(() => commentBead(BOGUS, 'task-1', '   '), /Missing text/)
  })
  it('noteBead rejects empty text before spawning', async () => {
    await assert.rejects(() => noteBead(BOGUS, 'task-1', ''), /Missing text/)
  })
  it('labelBead requires add and/or remove', async () => {
    await assert.rejects(() => labelBead(BOGUS, 'task-1', {}), /add and\/or remove/)
  })
})
