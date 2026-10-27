// Date bounds, stable order, ties, and keyset pages. No database and no stores.
// Run: FUNNEL_BASE=https://example.test bun test src/lib/query-order.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertReadOnlySql } from './sql'
import {
  QueryOrderError,
  PUBLISHED_AT_MSG,
  bdSortArgs,
  columnsEqual,
  decodeCursor,
  encodeCursor,
  formatOrder,
  isLegacyOrder,
  keysetSql,
  legacyOrder,
  normalizeBound,
  orderBySql,
  pageRows,
  parseDateBounds,
  parseDescending,
  parseListWindow,
  resolveOrder,
  sortRows,
  statusFeedOrder,
  type SortableRow,
} from './query-order'

function row(id: string, updated: string, priority: number, created = updated): SortableRow {
  return { id, updatedAt: updated, createdAt: created, priority }
}

const FEED: SortableRow[] = [
  row('status-b', '2026-10-02T00:00:00Z', 2, '2026-09-01T00:00:00Z'),
  row('status-a', '2026-10-02T00:00:00Z', 0, '2026-09-02T00:00:00Z'),
  row('status-c', '2026-10-02T00:00:00Z', 0, '2026-09-03T00:00:00Z'),
  row('status-d', '2026-10-01T00:00:00Z', 0, '2026-10-01T00:00:00Z'),
  row('status-e', '2026-10-03T00:00:00Z', 4, '2026-01-01T00:00:00Z'),
]

describe('date bounds', () => {
  it('accepts RFC3339 UTC and YYYY-MM-DD as UTC midnight, exclusive on both ends', () => {
    assert.deepEqual(normalizeBound('2026-10-02T01:02:03Z'), {
      sql: '2026-10-02 01:02:03',
      flag: '2026-10-02T01:02:03Z',
    })
    assert.deepEqual(normalizeBound('2026-10-02'), {
      sql: '2026-10-02 00:00:00',
      flag: '2026-10-02T00:00:00Z',
    })
    const bound = normalizeBound('2026-10-02T00:00:00Z')
    const rows = [
      row('eq', '2026-10-02T00:00:00Z', 1),
      row('after', '2026-10-02T00:00:01Z', 2),
      row('before', '2026-10-01T23:59:59Z', 0),
    ]
    const after = pageRows(rows, {
      columns: legacyOrder(), limit: 10, store: 'task', bounds: { createdAfter: bound, updatedAfter: bound },
    })
    assert.deepEqual(after.rows.map((r) => r.id), ['after'])
    const before = pageRows(rows, {
      columns: legacyOrder(), limit: 10, store: 'task', bounds: { createdBefore: bound, updatedBefore: bound },
    })
    assert.deepEqual(before.rows.map((r) => r.id), ['before'])
  })

  it('rejects calendars, offsets, and relative phrases', () => {
    for (const s of ['2026-13-01', '2026-10-02T00:00:00+02:00', 'yesterday', '3 days ago', '']) {
      assert.throws(() => normalizeBound(s), QueryOrderError, s)
    }
  })

  it('refuses published_at instead of inventing a timestamp', () => {
    assert.throws(() => parseDateBounds({ publishedAfter: '2026-10-02' }), (e: unknown) => {
      assert.ok(e instanceof QueryOrderError)
      assert.equal(e.message, PUBLISHED_AT_MSG)
      return true
    })
    assert.throws(() => resolveOrder('status', 'published_at'), QueryOrderError)
  })
})

describe('status feed order', () => {
  it('sorts the status store by updated_at descending, then priority, then id', () => {
    const { columns, kind } = resolveOrder('status')
    assert.equal(kind, 'status-feed')
    assert.deepEqual(columns, statusFeedOrder())
    assert.equal(formatOrder(columns), 'updated_at desc, priority asc, id asc')
    // Newest first even when that row is P4. Same timestamp: lower priority number, then id.
    assert.deepEqual(sortRows(FEED, columns).map((r) => r.id), [
      'status-e', 'status-a', 'status-c', 'status-b', 'status-d',
    ])
  })

  it('keeps every other store on today\'s priority, newest-created, id order', () => {
    const { columns, kind } = resolveOrder('task')
    assert.equal(kind, 'legacy')
    assert.ok(isLegacyOrder(columns))
    // p0 rows go first, newest created_at among them, then id. Priority still leads.
    assert.deepEqual(sortRows(FEED, columns).map((r) => r.id), [
      'status-d', 'status-c', 'status-a', 'status-b', 'status-e',
    ])
  })

  it('lets an explicit order_by override the status default', () => {
    const { columns, kind } = resolveOrder('status', 'priority', true)
    assert.equal(kind, 'explicit')
    assert.deepEqual(columns, [
      { col: 'priority', dir: 'desc' },
      { col: 'id', dir: 'asc' },
    ])
    assert.deepEqual(bdSortArgs(columns), ['--sort', 'priority', '--reverse'])
    assert.deepEqual(bdSortArgs(statusFeedOrder()), ['--sort', 'updated'])
    assert.deepEqual(bdSortArgs(legacyOrder()), [])
  })
})

describe('keyset pagination', () => {
  it('walks a tied set without gaps or duplicates', () => {
    const columns = statusFeedOrder()
    const want = sortRows(FEED, columns).map((r) => r.id)
    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 10; i++) {
      const page = pageRows(FEED, { columns, limit: 2, store: 'status', cursor })
      seen.push(...page.rows.map((r) => r.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
      const decoded = decodeCursor(cursor)
      assert.equal(decoded.store, 'status')
      assert.ok(columnsEqual(decoded.cols, columns))
    }
    assert.deepEqual(seen, want)
    assert.equal(new Set(seen).size, want.length)
  })

  it('encodes the sort key and id, and rejects a cursor from another order or store', () => {
    const columns = statusFeedOrder()
    const first = pageRows(FEED, { columns, limit: 1, store: 'status' })
    assert.ok(first.nextCursor)
    const decoded = decodeCursor(first.nextCursor!)
    assert.equal(decoded.vals[2], 'status-e')
    assert.equal(encodeCursor(decoded), first.nextCursor)
    assert.throws(() => pageRows(FEED, { columns, limit: 2, store: 'task', cursor: first.nextCursor }), /different store/)
    assert.throws(
      () => pageRows(FEED, { columns: legacyOrder(), limit: 2, store: 'status', cursor: first.nextCursor }),
      /different order/,
    )
    assert.throws(() => decodeCursor('nope'), QueryOrderError)
  })

  it('builds a bound keyset predicate that matches the tie order', () => {
    const columns = statusFeedOrder()
    const k = keysetSql(columns, ['2026-10-02T00:00:00Z', 0, 'status-a'])
    assert.equal(
      k.sql,
      '(updated_at < ? OR (updated_at = ? AND priority > ?) OR (updated_at = ? AND priority = ? AND id > ?))',
    )
    assert.deepEqual(k.args, ['2026-10-02 00:00:00', '2026-10-02 00:00:00', 0, '2026-10-02 00:00:00', 0, 'status-a'])
    assert.ok(!k.sql.includes('status-a'), 'id is a bind parameter')
    assert.doesNotThrow(() => assertReadOnlySql(`SELECT id FROM issues WHERE ${k.sql}`))
    const page = pageRows(FEED, {
      columns,
      limit: 10,
      store: 'status',
      cursor: encodeCursor({ v: 1, store: 'status', cols: columns, vals: ['2026-10-02T00:00:00Z', 0, 'status-a'] }),
    })
    assert.deepEqual(page.rows.map((r) => r.id), ['status-c', 'status-b', 'status-d'])
  })
})

describe('parseListWindow', () => {
  it('parses a status page with a date and a descending override', () => {
    const w = parseListWindow({
      store: 'status',
      createdAfter: '2026-10-01',
      descending: parseDescending('false'),
    })
    assert.equal(w.kind, 'status-feed')
    assert.equal(w.columns[0].dir, 'asc')
    assert.equal(w.bounds.createdAfter?.sql, '2026-10-01 00:00:00')
    assert.equal(w.cursor, undefined)
  })

  it('order SQL for the legacy default matches bd\'s unsorted list', () => {
    assert.equal(orderBySql(legacyOrder()), 'ORDER BY priority ASC, created_at DESC, id ASC')
    assert.equal(orderBySql(statusFeedOrder()), 'ORDER BY updated_at DESC, priority ASC, id ASC')
    assert.notEqual(orderBySql(statusFeedOrder()), 'ORDER BY updated_at DESC, id ASC')
  })
})
