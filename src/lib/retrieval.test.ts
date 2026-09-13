// Unit tests: bun test src/lib/retrieval.test.ts (node:test, no new deps).
// Pure builders/parsers/merge/walk only — walkGraph runs on stub fetchers,
// so depth caps, dedupe, and truncation never touch real stores.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  activityArgs,
  cleanLabels,
  clampLimit,
  formatActivity,
  formatSearch,
  formatSnapshot,
  mergeByUpdated,
  parseRetrievalRows,
  pickRetrievalStores,
  searchArgs,
  walkGraph,
  type NeighborSet,
  type RetrievalRow,
} from './retrieval'

const row = (id: string, updatedAt?: string, extra: Partial<RetrievalRow> = {}): RetrievalRow => ({
  store: 'task',
  id,
  title: `title ${id}`,
  labels: [],
  ...(updatedAt ? { updatedAt } : {}),
  ...extra,
})

describe('searchArgs', () => {
  it('builds a full-text search argv with filters', () => {
    assert.deepEqual(
      searchArgs('federated search', { labels: ['a'], perStore: 10 }),
      ['search', 'federated search', '--json', '--limit', '10', '--label', 'a', '--status', 'all'],
    )
  })
  it('passes an explicit status through instead of all', () => {
    assert.deepEqual(
      searchArgs('x', { status: 'open', perStore: 5 }),
      ['search', 'x', '--json', '--limit', '5', '--status', 'open'],
    )
  })
  it('falls back to list-all when the query is blank', () => {
    assert.deepEqual(
      searchArgs('   ', { perStore: 20 }),
      ['list', '--json', '--limit', '20', '--all'],
    )
  })
  it('keeps the query as one argv element (shell-free)', () => {
    const args = searchArgs('a"b `c` $d', { perStore: 5 })
    assert.equal(args[1], 'a"b `c` $d')
  })
})

describe('parseRetrievalRows', () => {
  it('keeps status, labels, timestamps, and counts', () => {
    assert.deepEqual(
      parseRetrievalRows(JSON.stringify([{
        id: 'task-1', title: 'T', status: 'open', labels: ['a'],
        updated_at: '2026-09-13T19:00:00Z', created_at: '2026-09-12T00:00:00Z',
        comment_count: 3, close_reason: 'done',
      }]), 'task'),
      [{
        store: 'task', id: 'task-1', title: 'T', status: 'open', labels: ['a'],
        updatedAt: '2026-09-13T19:00:00Z', createdAt: '2026-09-12T00:00:00Z',
        commentCount: 3, closeReason: 'done',
      }],
    )
  })
  it('drops rows without ids and tolerates junk', () => {
    assert.deepEqual(parseRetrievalRows('null', 'task'), [])
    assert.deepEqual(parseRetrievalRows('not json', 'task'), [])
    assert.deepEqual(parseRetrievalRows(JSON.stringify([{ title: 'no id' }]), 'task'), [])
  })
})

describe('activityArgs', () => {
  it('sorts by updated and includes closed by default', () => {
    assert.deepEqual(activityArgs({ limit: 20 }), ['list', '--json', '--limit', '20', '--sort', 'updated', '--all'])
  })
  it('uses an explicit status and label/since filters', () => {
    assert.deepEqual(
      activityArgs({ limit: 10, status: 'open', labels: ['a'], since: '2026-09-01' }),
      ['list', '--json', '--limit', '10', '--sort', 'updated', '--label', 'a', '--status', 'open', '--updated-after', '2026-09-01'],
    )
  })
})

describe('mergeByUpdated', () => {
  it('orders globally newest-first across stores', () => {
    const out = mergeByUpdated([
      [row('task-1', '2026-09-10T00:00:00Z')],
      [row('brain-1', '2026-09-13T00:00:00Z'), row('brain-2', '2026-09-11T00:00:00Z')],
    ])
    assert.deepEqual(out.map((r) => r.id), ['brain-1', 'brain-2', 'task-1'])
  })
  it('sorts timestamp-less rows last', () => {
    const out = mergeByUpdated([[row('task-9'), row('task-1', '2026-09-10T00:00:00Z')]])
    assert.deepEqual(out.map((r) => r.id), ['task-1', 'task-9'])
  })
})

describe('pickRetrievalStores/cleanLabels/clampLimit', () => {
  it('defaults to every known store and flags unknown ones', () => {
    const all = pickRetrievalStores()
    assert.ok(all.stores.includes('task') && all.unknown.length === 0)
    const some = pickRetrievalStores(['task', 'nope'])
    assert.deepEqual(some.stores, ['task'])
    assert.deepEqual(some.unknown, ['nope'])
  })
  it('drops invalid labels and clamps limits', () => {
    assert.deepEqual(cleanLabels(['project:ok', 'bad label!']), ['project:ok'])
    assert.equal(clampLimit('5', 20), 5)
    assert.equal(clampLimit('9999', 20), 100)
    assert.equal(clampLimit('junk', 20), 20)
  })
})

describe('walkGraph', () => {
  const meta = (id: string): RetrievalRow => ({ store: 'task', id, title: id, labels: [] })
  const fetcher = (graph: Record<string, string[]>): ((id: string) => Promise<NeighborSet | null>) =>
    async (id) => ({
      meta: meta(id),
      neighbors: (graph[id] ?? []).map((n) => ({ id: n, via: 'depends-on' })),
    })

  it('dedupes cycles and records depth/via', async () => {
    const { nodes, truncated } = await walkGraph('a', fetcher({ a: ['b'], b: ['a', 'c'], c: [] }), 3, 60)
    assert.equal(truncated, false)
    assert.deepEqual(nodes.map((n) => n.id), ['a', 'b', 'c'])
    assert.deepEqual(nodes.map((n) => n.depth), [0, 1, 2])
    assert.equal(nodes[0].via, 'root')
  })
  it('caps traversal depth explicitly', async () => {
    const { nodes } = await walkGraph('a', fetcher({ a: ['b'], b: ['c'], c: ['d'], d: [] }), 1, 60)
    assert.deepEqual(nodes.map((n) => n.id), ['a', 'b'])
  })
  it('caps bead count and reports truncation', async () => {
    const { nodes, truncated } = await walkGraph(
      'a', fetcher({ a: ['b', 'c', 'd', 'e'], b: [], c: [], d: [], e: [] }), 3, 3,
    )
    assert.equal(truncated, true)
    assert.equal(nodes.length, 3)
  })
  it('skips beads the fetcher cannot read', async () => {
    const { nodes } = await walkGraph('a', async (id) => (id === 'b' ? null : {
      meta: meta(id),
      neighbors: id === 'a' ? [{ id: 'b', via: 'child' }] : [],
    }), 2, 60)
    assert.deepEqual(nodes.map((n) => n.id), ['a'])
  })
})

describe('empty-result formats', () => {
  it('search/activity/snapshot name the empty case', () => {
    assert.match(formatSearch('zzz-no-match', [], [], ['task']), /No beads matched/)
    assert.match(formatActivity([], [], ['task']), /No activity in scope/)
    assert.match(formatSnapshot({ root: 'task-1', beads: [], truncated: false }), /0 beads/)
    assert.match(
      formatSnapshot({ root: '', beads: [], truncated: false, error: 'Give a bead id or search phrase.' }),
      /Give a bead id/,
    )
  })
})
