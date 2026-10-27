// Unit tests: bun test src/routes/query/store.test.ts (node:test).
// Pure argv builders/parsers only — no subprocesses, no stores touched.
// Bare (filterless) listing is store discovery (task-mvth3): no label
// flags, just list --json --limit N.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bdBounds, formatStoreQuery, listArgs, parseRows } from './store'
import { normalizeBound, statusFeedOrder } from '../../lib/query-order'

const base = { exclude: [] as string[], limit: 20, allStates: false }

describe('listArgs', () => {
  it('builds a bare list-all argv when no filters are given', () => {
    assert.deepEqual(
      listArgs([], [], { ...base }),
      ['list', '--json', '--limit', '20'],
    )
  })
  it('adds date flags and a sort for the status feed, and leaves a bare list untouched', () => {
    const bound = normalizeBound('2026-10-02T00:00:00Z')
    assert.deepEqual(
      listArgs([], [], {
        ...base,
        order: statusFeedOrder(),
        bounds: { updatedAfter: bound, createdBefore: bound },
      }),
      ['list', '--json', '--limit', '20', '--sort', 'updated',
        '--created-before', '2026-10-02T00:00:00Z', '--updated-after', '2026-10-02T00:00:00Z'],
    )
  })
  it('tightens the bd updated-before flag to the cursor when that is earlier', () => {
    const user = normalizeBound('2026-10-05T00:00:00Z')
    const bounds = bdBounds({
      ...base,
      order: statusFeedOrder(),
      bounds: { updatedBefore: user },
      cursor: ['2026-10-02T00:00:00Z', 1, 'status-a'],
    })
    assert.equal(bounds.updatedBefore?.flag, '2026-10-02T00:00:00Z')
  })
  it('adds label, any, exclude, title, status, all flags when present', () => {
    assert.deepEqual(
      listArgs(['a'], ['b', 'c'], { exclude: ['d'], title: 'T', status: 'open', limit: 5, allStates: true }),
      ['list', '--json', '--limit', '5', '--label', 'a', '--label-any', 'b,c',
        '--exclude-label', 'd', '--title-contains', 'T', '--status', 'open', '--all'],
    )
  })
})

describe('parseRows', () => {
  it('parses id/title/labels rows', () => {
    assert.deepEqual(
      parseRows(JSON.stringify([{ id: 'task-1', title: 'T', labels: ['a'] }])),
      [{ id: 'task-1', title: 'T', labels: ['a'] }],
    )
  })
  it('drops rows without ids and tolerates junk', () => {
    assert.deepEqual(parseRows('null'), [])
    assert.deepEqual(parseRows(JSON.stringify([{ title: 'no id' }])), [])
  })
  it('keeps created_at, updated_at, and priority when the store sent them', () => {
    assert.deepEqual(
      parseRows(JSON.stringify([{
        id: 'status-e', title: 'Newest', labels: [], priority: 4,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-03T00:00:00Z',
      }])),
      [{
        id: 'status-e', title: 'Newest', labels: [], priority: 4,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z',
      }],
    )
  })
})

describe('formatStoreQuery', () => {
  it('prints timestamps and a cursor, and names the status-feed order', () => {
    const text = formatStoreQuery('status', [
      { id: 'status-e', title: 'Newest', labels: ['captain-action'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', priority: 4 },
    ], { orderKind: 'status-feed', order: statusFeedOrder(), nextCursor: 'v1.abc' })
    assert.match(text, /order: updated_at desc, priority asc, id asc/)
    assert.match(text, /status-e — Newest \[captain-action\] created_at=2026-01-01T00:00:00Z updated_at=2026-10-03T00:00:00Z/)
    assert.match(text, /next_cursor: v1\.abc/)
  })
  it('omits the order line for the legacy default', () => {
    const text = formatStoreQuery('task', [{ id: 'task-1', title: 'T', labels: [] }])
    assert.equal(text, '# query — task (1)\n\ntask-1 — T')
    assert.doesNotMatch(text, /order:/)
  })
})
