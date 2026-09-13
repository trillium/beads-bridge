// Unit tests: bun test src/lib/batch.test.ts (node:test, no new deps).
// Commit phase runs on injected fakes — no subprocesses, no stores touched.
// (Importing batch pulls STORES from config, so run with FUNNEL_BASE set.)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatBatch, runBatch, validateBatch, type BatchFns } from './batch'
import type { CreateInput } from './create'

interface Fake extends BatchFns {
  created: CreateInput[]
  edges: { store: string; from: string; to: string; type?: string }[]
}

function fake(failTitles: string[] = []): Fake {
  let n = 0
  const f: Fake = {
    created: [],
    edges: [],
    createBeadFn: async (input: CreateInput) => {
      if (failTitles.includes(input.title)) throw new Error(`boom: ${input.title}`)
      n++
      f.created.push(input)
      const id = `${input.store}-t${n}`
      return { id, detail: `created ${id}`, verified: true }
    },
    addEdge: async (store: string, from: string, to: string, type?: string) => {
      f.edges.push({ store, from, to, type })
      return `linked ${from} -> ${to}`
    },
    verifyEdge: async () => true,
  }
  return f
}

describe('happy-path graph', () => {
  it('creates beads, resolves names, wires parent/deps/relations', async () => {
    const f = fake()
    const r = await runBatch({
      beads: [
        { name: 'root', store: 'task', title: 'Root' },
        { name: 'child', store: 'task', title: 'Child', parent: 'root' },
        { name: 'tests', store: 'task', title: 'Tests', depends_on: ['child'] },
      ],
      relations: [{ from: 'tests', to: 'root', type: 'validates' }],
    }, f)
    assert.equal(r.complete, true)
    assert.deepEqual(r.beads.map((b) => b.name), ['root', 'child', 'tests'])
    assert.deepEqual(r.beads.map((b) => b.id), ['task-t1', 'task-t2', 'task-t3'])
    assert.ok(r.beads.every((b) => b.verified))
    // Parent resolved to the canonical id at commit.
    assert.equal(f.created[1].parent, 'task-t1')
    // depends_on + relation wired as dep edges with resolved ids.
    assert.deepEqual(f.edges, [
      { store: 'task', from: 'task-t3', to: 'task-t2', type: undefined },
      { store: 'task', from: 'task-t3', to: 'task-t1', type: 'validates' },
    ])
    assert.ok(r.edges.every((e) => e.ok && e.verified))
    const text = formatBatch(r)
    assert.ok(text.includes('# batch — complete'))
    assert.ok(text.includes('task-t1') && text.includes('task-t3'))
  })
})

describe('intra-batch reference resolution', () => {
  it('canonical ids pass through, names resolve', async () => {
    const f = fake()
    const r = await runBatch({
      beads: [
        { name: 'a', store: 'task', title: 'A' },
        { name: 'b', store: 'task', title: 'B', parent: 'a', depends_on: ['a'] },
      ],
    }, f)
    assert.equal(r.complete, true)
    assert.equal(f.created[1].parent, 'task-t1')
    assert.deepEqual(f.edges, [{ store: 'task', from: 'task-t2', to: 'task-t1', type: undefined }])
  })
})

describe('partial failure reporting', () => {
  it('reports exactly what landed and what did not — never silent', async () => {
    const f = fake(['Bad child'])
    const r = await runBatch({
      beads: [
        { name: 'root', store: 'task', title: 'Root' },
        { name: 'bad', store: 'task', title: 'Bad child', parent: 'task-zzz99' },
        { name: 'orphan', store: 'task', title: 'Orphan', depends_on: ['bad'] },
      ],
      relations: [{ from: 'root', to: 'bad', type: 'related' }],
    }, f)
    assert.equal(r.complete, false)
    // Root landed; bad failed at runtime; orphan skipped (dep unlanded).
    assert.deepEqual(r.beads.map((b) => b.name), ['root'])
    assert.deepEqual(r.failures.map((f2) => f2.target), ['bad', 'orphan', 'edge root→bad'])
    assert.ok(r.failures.some((f2) => f2.error.includes('boom')))
    assert.ok(r.failures.some((f2) => f2.error.includes('did not land')))
    // Orphan never attempted — no half-write beyond the reported landing.
    assert.ok(!f.created.some((c) => c.title === 'Orphan'))
    const text = formatBatch(r)
    assert.ok(text.includes('# batch — partial failure'))
    assert.ok(text.includes('did not land'))
  })
})

describe('bad-label rejection', () => {
  it('rejects the whole batch before any write', async () => {
    const f = fake()
    await assert.rejects(
      () => runBatch({ beads: [{ name: 'a', store: 'task', title: 'A', labels: ['has space'] }] }, f),
      /bad label/,
    )
    assert.equal(f.created.length, 0)
  })
})

describe('validateBatch', () => {
  it('rejects duplicate names', () => {
    assert.throws(
      () => validateBatch({ beads: [{ name: 'a', store: 'task', title: 'A' }, { name: 'a', store: 'task', title: 'B' }] }),
      /duplicate bead name/,
    )
  })
  it('rejects forward refs', () => {
    assert.throws(
      () => validateBatch({ beads: [{ name: 'a', store: 'task', title: 'A', depends_on: ['b'] }, { name: 'b', store: 'task', title: 'B' }] }),
      /comes later/,
    )
  })
  it('rejects unknown refs', () => {
    assert.throws(
      () => validateBatch({ beads: [{ name: 'a', store: 'task', title: 'A', parent: 'nope' }] }),
      /unknown reference/,
    )
  })
  it('rejects unknown stores', () => {
    assert.throws(
      () => validateBatch({ beads: [{ name: 'a', store: 'nope', title: 'A' }] }),
      /unknown store/,
    )
  })
  it('rejects cross-store edges', () => {
    assert.throws(
      () => validateBatch({ beads: [{ name: 'a', store: 'task', title: 'A' }, { name: 'b', store: 'brain', title: 'B', depends_on: ['a'] }] }),
      /stay in one store/,
    )
  })
  it('rejects bad relation types', () => {
    assert.throws(
      () => validateBatch({ beads: [{ name: 'a', store: 'task', title: 'A' }], relations: [{ from: 'a', to: 'a', type: 'implements' }] }),
      /bad type/,
    )
  })
  it('rejects empty batches', () => {
    assert.throws(() => validateBatch({ beads: [] }), /empty/)
  })
})
