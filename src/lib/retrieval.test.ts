// Unit tests: bun test src/lib/retrieval.test.ts (node:test, no new deps).
// Pure builders/parsers/merge/walk only — walkGraph runs on stub fetchers,
// so depth caps, dedupe, and truncation never touch real stores.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  activityArgs,
  attachClaimedDetail,
  CLAIMED_DETAIL_MAX_BEADS,
  cleanLabels,
  clampLimit,
  excerptText,
  formatActivity,
  formatSearch,
  formatSnapshot,
  mergeByUpdated,
  parseRetrievalRows,
  claimAnchorMs,
  classifyClaim,
  formatClaimed,
  humanAge,
  pickRetrievalStores,
  searchArgs,
  staleAfterMsFromHours,
  toClaimedRow,
  walkGraph,
  CLAIM_STALE_AFTER_MS,
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
        assignee: undefined, startedAt: undefined,
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

describe('claimed beads', () => {
  it('parses assignee + started_at claim evidence', () => {
    const rows = parseRetrievalRows(
      JSON.stringify([{ id: 'inbox-1', title: 't', status: 'in_progress', assignee: 'pi-inbox', started_at: '2026-09-16T10:00:00Z', labels: [] }]),
      'inbox',
    )
    assert.equal(rows[0].assignee, 'pi-inbox')
    assert.equal(rows[0].startedAt, '2026-09-16T10:00:00Z')
  })
  it('anchors claim time on started, falls back, computes age', () => {
    const now = Date.parse('2026-09-16T12:00:00Z')
    const a = toClaimedRow(row('a', '2026-09-16T11:00:00Z', { startedAt: '2026-09-16T10:00:00Z', assignee: 'x' }), now)
    assert.equal(a.claimAt, '2026-09-16T10:00:00.000Z')
    assert.equal(a.claimAgeMs, 2 * 3600_000)
    assert.equal(humanAge(a.claimAgeMs as number), '2h0m')
    const b = toClaimedRow(row('b'), now)
    assert.equal(b.claimAt, null)
    assert.equal(humanAge(3 * 86400_000 + 60000), '3d0h')
  })
  it('formats oldest-first rows with claimant and age, names the empty case', () => {
    const out = formatClaimed(
      [{ ...toClaimedRow(row('a', '2026-09-16T11:00:00Z', { startedAt: '2026-09-16T10:00:00Z', assignee: 'pi-inbox' }), Date.parse('2026-09-16T12:00:00Z')) }],
      [], ['inbox'],
    )
    assert.match(out, /inbox-a|inbox/)
    assert.match(out, /@pi-inbox/)
    assert.match(out, /agent hands only/)
    assert.match(out, /claim-blind/)
    assert.match(formatClaimed([], [], ['inbox']), /Nothing claimed/)
  })
  it('falls back to @unassigned when no claimant is recorded', () => {
    const out = formatClaimed(
      [{ ...toClaimedRow(row('a')) }],
      [], ['inbox'],
    )
    assert.match(out, /@unassigned/)
    assert.match(out, /claim time unknown/)
  })
  it('renders attached detail excerpts and history lines inline', () => {
    const out = formatClaimed(
      [{ ...toClaimedRow(row('a', '2026-09-16T11:00:00Z', { startedAt: '2026-09-16T10:00:00Z', assignee: 'pi-inbox', labels: ['project:x'] }), Date.parse('2026-09-16T12:00:00Z')) }],
      [], ['inbox'], [],
      new Map([['a', { status: 'in_progress', labels: ['project:x'], excerpt: 'fix the thing' }]]),
      new Map([['a', 'claimed | started']]),
    )
    assert.match(out, /detail:.*fix the thing/)
    assert.match(out, /change: claimed \| started/)
    assert.match(out, /project:x/)
  })
  it('collapses whitespace in excerpts', () => {
    assert.equal(excerptText('a\n\n  b\tc', 10), 'a b c')
    assert.equal(excerptText('', 10), '')
  })
  it('caps detail enrichment bounds', () => {
    assert.equal(CLAIMED_DETAIL_MAX_BEADS, 20)
    assert.equal(typeof attachClaimedDetail, 'function')
  })
})

describe('claim-state taxonomy (task-5w84p.4)', () => {
  const now = Date.parse('2026-09-16T12:00:00Z')
  const fresh = { claimAt: '2026-09-16T10:00:00.000Z', claimAgeMs: 2 * 3600_000 }
  const old = { claimAt: '2026-09-10T10:00:00.000Z', claimAgeMs: 6 * 24 * 3600_000 }
  const base = { status: 'in_progress' as const, labels: [] as string[], assignee: 'pi-x', closeReason: undefined as string | undefined }

  it('separates claimed / active / unknown on fresh rows', () => {
    assert.equal(classifyClaim({ ...base, ...fresh }, null, now).state, 'active')
    assert.equal(classifyClaim({ ...base, ...fresh, assignee: undefined }, null, now).state, 'claimed')
    assert.equal(classifyClaim({ ...base, claimAt: null, claimAgeMs: null }, null, now).state, 'unknown')
  })
  it('marks age past the threshold stale — never completed or abandoned', () => {
    for (const state of [
      classifyClaim({ ...base, ...old }, null, now).state,
      classifyClaim({ ...base, ...old, assignee: undefined }, null, now).state,
    ]) assert.equal(state, 'stale')
  })
  it('completes only on explicit close evidence', () => {
    assert.equal(classifyClaim({ ...base, ...fresh, status: 'closed' }, null, now).state, 'completed')
    assert.equal(classifyClaim({ ...base, ...old, closeReason: 'done' }, null, now).state, 'completed')
    // Live detail can close a row the scan saw as in_progress.
    assert.equal(classifyClaim({ ...base, ...fresh }, { status: 'done', labels: [] }, now).state, 'completed')
  })
  it('abandons only on explicit release labels', () => {
    assert.equal(classifyClaim({ ...base, ...fresh, labels: ['lifecycle:released'] }, null, now).state, 'abandoned')
    assert.equal(classifyClaim({ ...base, ...old }, { status: 'in_progress', labels: ['state:abandoned'] }, now).state, 'abandoned')
    // Completed evidence wins over release labels.
    assert.equal(classifyClaim({ ...base, ...fresh, status: 'closed', labels: ['abandoned'] }, null, now).state, 'completed')
  })
  it('makes the stale threshold explicit and overridable', () => {
    assert.equal(CLAIM_STALE_AFTER_MS, 48 * 3600_000)
    assert.equal(staleAfterMsFromHours(undefined), CLAIM_STALE_AFTER_MS)
    assert.equal(staleAfterMsFromHours('junk'), CLAIM_STALE_AFTER_MS)
    assert.equal(staleAfterMsFromHours(1), 3600_000)
    // A fresh row reads stale under a 1h threshold — the override applies.
    assert.equal(classifyClaim({ ...base, ...fresh }, null, now, staleAfterMsFromHours(1)).state, 'stale')
    assert.equal(classifyClaim({ ...base, ...old }, null, now, staleAfterMsFromHours(24 * 30)).state, 'active')
  })
  it('attaches state + evidence on toClaimedRow and surfaces both per row', () => {
    const active = toClaimedRow(row('a', '2026-09-16T11:00:00Z', { startedAt: '2026-09-16T10:00:00Z', assignee: 'x' }), now)
    assert.equal(active.state, 'active')
    assert.ok(active.evidence.some((e) => e.startsWith('assignee:@x')))
    const out = formatClaimed([active], [], ['task'])
    assert.match(out, /\[state=active\]/)
    assert.match(out, /evidence: /)
    assert.match(out, /never inferred from age or silence/)
    assert.match(out, /Stale-after default/)
  })
  it('re-verdicts against live detail at format time', () => {
    const freshRow = toClaimedRow(row('a', '2026-09-16T11:00:00Z', { startedAt: '2026-09-16T10:00:00Z', assignee: 'x' }), now)
    const out = formatClaimed([freshRow], [], ['task'], [], new Map([['a', { status: 'closed', labels: [], excerpt: '', closeReason: 'done' }]]))
    assert.match(out, /\[state=completed\]/)
    assert.match(out, /close-reason:done/)
  })
})
