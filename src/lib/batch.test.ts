// Unit tests: bun test src/lib/batch.test.ts (node:test, no new deps).
// Commit phase runs on injected fakes — no subprocesses, no stores touched.
// (Importing batch pulls STORES from config, so run with FUNNEL_BASE set.)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCrossStoreEdgeText,
  canonicalEdgeType,
  crossStoreEdgePresent,
  formatBatch,
  isKnownEdgeType,
  runBatch,
  validateBatch,
  XSTORE_EDGE_MARKER,
  type BatchFns,
} from './batch'
import { extractLinks } from '../util'
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
  it('rejects cross-store parent (hierarchy stays in one store)', () => {
    assert.throws(
      () => validateBatch({ beads: [{ name: 'a', store: 'task', title: 'A' }, { name: 'b', store: 'brain', title: 'B', parent: 'a' }] }),
      /parent.*stays in one store/,
    )
  })
  it('allows cross-store depends_on and relations', () => {
    const { beads, relations } = validateBatch({
      beads: [
        { name: 'a', store: 'task', title: 'A' },
        { name: 'b', store: 'brain', title: 'B', depends_on: ['a'] },
      ],
      relations: [{ from: 'b', to: 'a', type: 'related' }],
    })
    assert.equal(beads.length, 2)
    assert.equal(relations.length, 1)
    assert.equal(relations[0].store, 'brain')
    assert.equal(relations[0].type, 'related')
  })
  it('rejects bad relation types', () => {
    assert.throws(
      () => validateBatch({ beads: [{ name: 'a', store: 'task', title: 'A' }], relations: [{ from: 'a', to: 'a', type: 'implements' }] }),
      /bad type/,
    )
  })
  it('accepts Brain cross-store vocabulary and normalizes aliases', () => {
    assert.ok(isKnownEdgeType('derived-from'))
    assert.ok(isKnownEdgeType('recorded-in'))
    assert.ok(!isKnownEdgeType('implements'))
    assert.deepEqual(canonicalEdgeType('source'), { requested: 'source', canonical: 'discovered-from' })
    assert.deepEqual(canonicalEdgeType('provenance'), { requested: 'provenance', canonical: 'discovered-from' })
    assert.deepEqual(canonicalEdgeType('derived-from'), { requested: 'derived-from', canonical: 'caused-by' })
    assert.deepEqual(canonicalEdgeType('destination'), { requested: 'destination', canonical: 'relates-to' })
    assert.deepEqual(canonicalEdgeType('recorded-in'), { requested: 'recorded-in', canonical: 'relates-to' })
    assert.deepEqual(canonicalEdgeType('related'), { requested: 'related', canonical: 'related' })
    assert.deepEqual(canonicalEdgeType('supersedes'), { requested: 'supersedes', canonical: 'supersedes' })
    const { relations } = validateBatch({
      beads: [{ name: 'a', store: 'task', title: 'A' }],
      relations: [{ from: 'a', to: 'a', type: 'derived-from' }],
    })
    assert.equal(relations[0].requested, 'derived-from')
    assert.equal(relations[0].type, 'caused-by')
  })
  it('rejects empty batches', () => {
    assert.throws(() => validateBatch({ beads: [] }), /empty/)
  })
})

describe('cross-store mention-links', () => {
  it('edge text carries the marker plus both bare ids', () => {
    const text = buildCrossStoreEdgeText('task-t1ab', 'brain-hs3l', 'derived-from', 'brain')
    assert.ok(text.includes(XSTORE_EDGE_MARKER))
    assert.ok(text.includes('task-t1ab') && text.includes('brain-hs3l'))
    assert.ok(text.includes('derived-from'))
    assert.ok(crossStoreEdgePresent(`noise\n${text}\nnoise`, 'brain-hs3l'))
    assert.ok(!crossStoreEdgePresent('unrelated comments', 'brain-hs3l'))
  })
  it('edge text is traversable: extractLinks finds the foreign id', () => {
    const text = buildCrossStoreEdgeText('task-t1ab', 'brain-hs3l', 'related', 'brain')
    assert.ok(extractLinks(text).some((l) => l.endsWith('/brain-hs3l')))
  })
  it('wires cross-store deps/relations verbatim and flags xstore receipts', async () => {
    const f = fake()
    const r = await runBatch({
      beads: [
        { name: 'a', store: 'task', title: 'A' },
        { name: 'b', store: 'brain', title: 'B', depends_on: ['task-zzz99'] },
      ],
      relations: [{ from: 'b', to: 'a', type: 'derived-from' }],
    }, f)
    assert.equal(r.complete, true)
    // depends_on keeps the default blocks edge; the relation keeps the
    // requested Brain vocabulary verbatim on the cross-store leg.
    const dep = r.edges.find((e) => e.type === 'blocks')!
    const rel = r.edges.find((e) => e.type === 'derived-from')!
    assert.ok(dep.xstore && rel.xstore)
    assert.ok(r.edges.every((e) => e.ok && e.verified))
    // Fake saw the resolved canonical ids on both legs.
    assert.ok(f.edges.some((e) => e.store === 'brain' && e.from === 'brain-t2' && e.to === 'task-zzz99'))
    assert.ok(f.edges.some((e) => e.store === 'brain' && e.from === 'brain-t2' && e.to === 'task-t1' && e.type === 'derived-from'))
    const text = formatBatch(r)
    assert.ok(text.includes('# batch — complete'))
    assert.ok(text.includes('cross-store mention-link'))
  })
  it('normalizes aliases on same-store legs and notes it', async () => {
    const f = fake()
    const r = await runBatch({
      beads: [{ name: 'a', store: 'task', title: 'A' }],
      relations: [{ from: 'a', to: 'a', type: 'source' }],
    }, f)
    assert.equal(r.complete, true)
    assert.equal(r.edges[0].type, 'discovered-from')
    assert.equal(r.edges[0].xstore, false)
    assert.ok(r.edges[0].detail.includes('requested "source" stored as "discovered-from"'))
    assert.deepEqual(f.edges, [{ store: 'task', from: 'task-t1', to: 'task-t1', type: 'discovered-from' }])
  })
  it('cross-store edge failure is an explicit partial failure, never silent', async () => {
    const f = fake()
    f.addEdge = async (store: string, from: string, to: string) => {
      if (to === 'task-zzz99') throw new Error('mention write failed: store unavailable')
      f.edges.push({ store, from, to })
      return `linked ${from} -> ${to}`
    }
    const r = await runBatch({
      beads: [
        { name: 'a', store: 'task', title: 'A' },
        { name: 'b', store: 'brain', title: 'B' },
      ],
      relations: [{ from: 'b', to: 'task-zzz99', type: 'supersedes' }],
    }, f)
    assert.equal(r.complete, false)
    assert.equal(r.edges.length, 1)
    assert.equal(r.edges[0].ok, false)
    assert.equal(r.edges[0].xstore, true)
    assert.deepEqual(r.failures.map((x) => x.target), ['edge b→task-zzz99'])
    assert.ok(r.failures[0].error.includes('mention write failed'))
    const text = formatBatch(r)
    assert.ok(text.includes('# batch — partial failure'))
    assert.ok(text.includes('FAILED'))
  })
})
