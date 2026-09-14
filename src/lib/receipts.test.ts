// Unit tests: FUNNEL_BASE=https://example.test bun test src/lib/receipts.test.ts
// (node:test, no new deps). False-success guardrail: every mutating bridge
// operation returns a verified receipt, and unverified work is an explicit
// error naming what is unverified — never a success. Batch commit phases run
// on injected fakes — no subprocesses, no stores touched.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isVerified,
  requireVerified,
  toVerifiable,
  unverifiedError,
  unverifiedMessage,
} from './receipts'
import { formatReceipt } from './mutate'
import { formatBatch, runBatch, type BatchFns } from './batch'
import type { CreateInput } from './create'

describe('receipt shape', () => {
  it('carries canonical id, store, operation, and verification state', () => {
    const out = formatReceipt({ operation: 'created', id: 'task-abc12', store: 'task', verified: true, detail: 'shown' })
    assert.match(out, /# created task-abc12 \(STORE: task\)/)
    assert.match(out, /Verified: yes/)
  })
  it('flags unverified receipts conspicuously (never silent success)', () => {
    const out = formatReceipt({ operation: 'comment added', id: 'task-abc12', store: 'task', verified: false, detail: 'x' })
    assert.match(out, /Verified: NO/)
  })
})

describe('unverifiedMessage / unverifiedError', () => {
  it('names the operation, id, and store', () => {
    const msg = unverifiedMessage({ operation: 'closed', id: 'task-abc12', store: 'task', verified: false })
    assert.match(msg, /closed/)
    assert.match(msg, /task-abc12/)
    assert.match(msg, /task/)
  })
  it('tells the caller not to report success and to re-read', () => {
    const msg = unverifiedMessage({ operation: 'created', id: 'brain-zz99', store: 'brain', verified: false })
    assert.match(msg, /not reporting success/)
    assert.match(msg, /re-read brain-zz99/)
  })
  it('unverifiedError is an Error carrying the message', () => {
    const e = unverifiedError({ operation: 'updated', id: 'task-q1', store: 'task', verified: false })
    assert.ok(e instanceof Error)
    assert.match(e.message, /unverified: updated task-q1/)
  })
})

describe('requireVerified', () => {
  it('passes verified receipts through unchanged', () => {
    const r = { operation: 'created', id: 'task-abc12', store: 'task', verified: true, detail: 'd' }
    assert.equal(requireVerified(r), r)
  })
  it('throws on unverified, naming id/store/operation (every failure path)', () => {
    for (const op of ['created', 'updated', 'comment added', 'closed', 'labels updated']) {
      assert.throws(
        () => requireVerified({ operation: op, id: 'task-zz1', store: 'task', verified: false }),
        (e: unknown) => e instanceof Error && e.message.includes(op) && e.message.includes('task-zz1') && e.message.includes('task'),
      )
    }
  })
})

describe('toVerifiable / isVerified', () => {
  it('builds the guardrail input from create/edit result fields', () => {
    assert.deepEqual(toVerifiable('created', 'task-a1', 'task', true), {
      operation: 'created', id: 'task-a1', store: 'task', verified: true,
    })
    assert.equal(isVerified(toVerifiable('created', 'task-a1', 'task', false)), false)
  })
})

function fakeBatch(opts: { beadVerified: boolean; edgeVerified: boolean }): BatchFns {
  let n = 0
  return {
    createBeadFn: async (input: CreateInput) => {
      n++
      const id = `${input.store}-t${n}`
      return { id, detail: `created ${id}`, verified: opts.beadVerified }
    },
    addEdge: async (_store: string, from: string, to: string) => `linked ${from} -> ${to}`,
    verifyEdge: async () => opts.edgeVerified,
  }
}

describe('batch false-success guardrail', () => {
  it('unverified beads fail completion with a named failure (never success)', async () => {
    const r = await runBatch({
      beads: [
        { name: 'root', store: 'task', title: 'Root' },
        { name: 'child', store: 'task', title: 'Child', parent: 'root' },
      ],
    }, fakeBatch({ beadVerified: false, edgeVerified: true }))
    assert.equal(r.complete, false)
    assert.equal(r.beads.length, 2)
    assert.ok(r.beads.every((b) => !b.verified))
    const named = r.failures.filter((f) => f.error.startsWith('unverified:'))
    assert.equal(named.length, 2)
    assert.ok(named.every((f) => /task-t\d/.test(f.error) && f.error.includes('task')))
    const text = formatBatch(r)
    assert.match(text, /partial failure/)
    assert.match(text, /unverified \(landed but did not read back — not success\)/)
  })
  it('ok-but-unverified edges fail completion and name the edge', async () => {
    const r = await runBatch({
      beads: [
        { name: 'a', store: 'task', title: 'A' },
        { name: 'b', store: 'task', title: 'B', depends_on: ['a'] },
      ],
    }, fakeBatch({ beadVerified: true, edgeVerified: false }))
    assert.equal(r.complete, false)
    assert.ok(r.edges.length > 0 && r.edges.every((e) => e.ok && !e.verified))
    const named = r.failures.filter((f) => f.error.startsWith('unverified:'))
    assert.ok(named.length > 0)
    assert.ok(named.every((f) => f.error.includes('edge')))
    assert.match(formatBatch(r), /partial failure/)
  })
  it('fully verified batches still complete', async () => {
    const r = await runBatch({
      beads: [{ name: 'solo', store: 'task', title: 'Solo' }],
    }, fakeBatch({ beadVerified: true, edgeVerified: true }))
    assert.equal(r.complete, true)
    assert.match(formatBatch(r), /# batch — complete/)
  })
})
