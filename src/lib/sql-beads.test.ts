// Pure-function tests for the SQL read port (no database): filter building,
// bd relevance ranking, time/dep helpers, SQL assembly, the bundle text
// splitter, the batched BFS contract, and the automatic bd fallback.
// Output-parity against real stores is a live read-only run (docs/sql-reads.md).
// Run: FUNNEL_BASE=https://example.test bun test src/lib/sql-beads.test.ts
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  _internal,
  rankSearch,
  resolveExternalDepTarget,
  resolvePartialId,
  scoreIssue,
  searchTokens,
  looksLikeIssueId,
  normalizeLabels,
  sinceToSqlUtc,
  unionAll,
  SqlUnsupported,
  type BeadFilter,
} from './sql-beads'
import { assertReadOnlySql, resetSqlStats, sqlStats } from './sql'
import { splitShow, SHOW_SEPARATOR, renderBeadBlock } from './bead-text'
import { walkGraph, type NeighborSet, type RetrievalRow } from './retrieval'
import { runListQuery } from '../routes/query/store'

const T = { main: 'issues', labels: 'labels', comments: 'comments', deps: 'dependencies' }

describe('buildWhere', () => {
  it('user text only ever travels as bind parameters', () => {
    const evil = "x'; DROP TABLE issues; --"
    const f: BeadFilter = { titleContains: evil, descContains: evil, notesContains: evil, labels: [evil], excludeLabels: [evil], status: evil }
    const w = _internal.buildWhere(f, T)
    const text = w.sql.join(' AND ')
    assert.ok(!text.includes('DROP'), text)
    assert.ok(w.args.some((a) => String(a).includes('DROP')))
    assert.equal((text.match(/\?/g) ?? []).length, w.args.length, 'one ? per bind arg')
    assert.doesNotThrow(() => assertReadOnlySql(`SELECT id FROM issues WHERE ${text}`))
  })

  it('empty filter adds no predicates', () => {
    assert.deepEqual(_internal.buildWhere({}, T), { sql: [], args: [] })
  })

  it('AND labels add one subquery each; OR labels one IN list', () => {
    const w = _internal.buildWhere({ labels: ['a', 'b'], labelsAny: ['c', 'd'] }, T)
    assert.equal(w.sql.length, 3)
    assert.deepEqual(w.args, ['a', 'b', 'c', 'd'])
  })

  it('title/desc/notes are lower-cased LIKE contains', () => {
    const w = _internal.buildWhere({ titleContains: 'BrIdge' }, T)
    assert.deepEqual(w.sql, ['LOWER(title) LIKE ?'])
    assert.deepEqual(w.args, ['%bridge%'])
  })

  it('wisp tables are addressed through the table map', () => {
    const w = _internal.buildWhere({ labels: ['x'] }, { main: 'wisps', labels: 'wisp_labels', comments: 'wisp_comments', deps: 'wisp_dependencies' })
    assert.match(w.sql[0], /wisp_labels/)
  })

  it('free-text query on an id-looking string also probes id/external_ref', () => {
    const w = _internal.buildWhere({ query: 'task-0xdm4' }, T)
    assert.match(w.sql[0], /external_ref/)
    assert.equal(w.args[0], 'task-0xdm4')
  })

  it('updatedAfter is an exclusive bound', () => {
    assert.deepEqual(_internal.buildWhere({ updatedAfter: '2026-10-16 01:02:03' }, T), { sql: ['updated_at > ?'], args: ['2026-10-16 01:02:03'] })
  })
})

describe('sinceToSqlUtc', () => {
  it('converts RFC3339 UTC', () => assert.equal(sinceToSqlUtc('2026-10-16T01:02:03Z'), '2026-10-16 01:02:03'))
  it('refuses forms it does not reproduce (-> bd)', () => {
    for (const s of ['2026-10-16', '2026-10-16T01:02:03+02:00', '3 days ago', 'yesterday', '']) {
      assert.throws(() => sinceToSqlUtc(s), SqlUnsupported, s)
    }
  })
})

describe('unionAll', () => {
  it('a lone part is emitted WITHOUT parentheses (Dolt rejects "(SELECT … LIMIT n)")', () => {
    assert.equal(unionAll(['(SELECT 1 LIMIT 5)']), 'SELECT 1 LIMIT 5')
  })
  it('several parts stay parenthesised', () => {
    assert.equal(unionAll(['(SELECT 1)', '(SELECT 2)']), '(SELECT 1) UNION ALL (SELECT 2)')
  })
  it('both shapes pass the read-only guard', () => {
    assert.doesNotThrow(() => assertReadOnlySql(unionAll(['(SELECT id FROM issues LIMIT 5)'])))
    assert.doesNotThrow(() => assertReadOnlySql(unionAll(['(SELECT id FROM issues LIMIT 5)', '(SELECT id FROM wisps LIMIT 5)'])))
  })
})

describe('resolveExternalDepTarget', () => {
  it('strips the legacy external:<store>: wrapper', () => assert.equal(resolveExternalDepTarget('external:task:task-abc'), 'task-abc'))
  it('leaves plain ids and malformed wrappers alone', () => {
    assert.equal(resolveExternalDepTarget('task-abc'), 'task-abc')
    assert.equal(resolveExternalDepTarget('external:task'), 'external:task')
    assert.equal(resolveExternalDepTarget('external:task:'), 'external:task:')
  })
})

describe('search helpers', () => {
  it('tokens: lower-cased, de-duplicated, whitespace split', () => assert.deepEqual(searchTokens('Foo  bar FOO'), ['foo', 'bar']))
  it('looksLikeIssueId', () => {
    assert.equal(looksLikeIssueId('task-abc'), true)
    assert.equal(looksLikeIssueId('-abc'), false)
    assert.equal(looksLikeIssueId('abc-'), false)
    assert.equal(looksLikeIssueId('two words-x'), false)
    assert.equal(looksLikeIssueId('nodash'), false)
  })
  it('normalizeLabels trims, drops blanks, de-duplicates in order', () => {
    assert.deepEqual(normalizeLabels([' a ', '', 'b', 'a']), ['a', 'b'])
    assert.deepEqual(normalizeLabels(undefined), [])
  })
})

describe('bd relevance ranking (search_rank.go port)', () => {
  it('phrase-in-title outranks token-in-description', () => {
    const rows = [
      { id: 'a-2', title: 'unrelated', description: 'mentions bridge here' },
      { id: 'a-1', title: 'the bridge', description: '' },
    ]
    assert.deepEqual(rankSearch(rows, 'bridge').map((r) => r.id), ['a-1', 'a-2'])
  })
  it('ties break by id ascending (deterministic)', () => {
    const rows = [
      { id: 'a-3', title: 'x', description: '' },
      { id: 'a-1', title: 'x', description: '' },
      { id: 'a-2', title: 'x', description: '' },
    ]
    assert.deepEqual(rankSearch(rows, 'zzz').map((r) => r.id), ['a-1', 'a-2', 'a-3'])
  })
  it('fewer than two rows are returned untouched', () => {
    const one = [{ id: 'a', title: 't' }]
    assert.equal(rankSearch(one, 'q'), one)
  })
  it('score weights: phrase title 1000 + all-in-title 300 + token 40 + boundary 5', () => {
    assert.equal(scoreIssue('bridge', '', ['bridge'], 'bridge'), 1000 + 300 + 40 + 5)
    assert.equal(scoreIssue('xbridgex', '', ['bridge'], 'bridge'), 1000 + 300 + 40) // no word boundary
    assert.equal(scoreIssue('', 'bridge', ['bridge'], 'bridge'), 400 + 150 + 10 + 2)
    assert.equal(scoreIssue('nothing', '', ['bridge'], 'bridge'), 0)
  })
})

describe('splitShow', () => {
  const part = (id: string) => `○ ${id} · title ${id}   [● P2 · OPEN]\n\nbody ${id}`
  it('splits a multi-id render back into per-id text', () => {
    const out = [part('a-1'), part('a-2')].join(SHOW_SEPARATOR)
    assert.deepEqual(splitShow(out, ['a-1', 'a-2']), [part('a-1'), part('a-2')])
  })
  it('refuses when the part count does not match', () => {
    assert.equal(splitShow(part('a-1'), ['a-1', 'a-2']), null)
  })
  it('refuses when a header does not name the expected id (misaligned output)', () => {
    const out = [part('a-2'), part('a-1')].join(SHOW_SEPARATOR)
    assert.equal(splitShow(out, ['a-1', 'a-2']), null)
  })
  it('ids with regex metacharacters are matched literally', () => {
    const out = [part('a.1'), part('a-2')].join(SHOW_SEPARATOR)
    assert.notEqual(splitShow(out, ['a.1', 'a-2']), null)
    assert.equal(splitShow([part('aX1'), part('a-2')].join(SHOW_SEPARATOR), ['a.1', 'a-2']), null)
  })
  it('renderBeadBlock: no comments section when the comment text is empty', () => {
    assert.equal(renderBeadBlock('a-1', 'task', { body: 'B', comments: '' }), '# a-1 (STORE: task)\n\nB')
    assert.equal(renderBeadBlock('a-1', 'task', { body: 'B', comments: 'C' }), '# a-1 (STORE: task)\n\nB\n\n## Comments\nC')
  })
})

describe('walkGraph with a batched (prefetch) fetcher', () => {
  const row = (id: string): RetrievalRow => ({ store: 'task', id, title: id, labels: [] })
  const edges: Record<string, string[]> = { r: ['a', 'b'], a: ['c', 'b'], b: ['c'], c: [] }
  const mk = (): { fetch: (id: string) => Promise<NeighborSet | null>; prefetch: (ids: string[]) => Promise<void>; levels: string[][] } => {
    const levels: string[][] = []
    return {
      levels,
      prefetch: async (ids) => { levels.push([...ids]) },
      fetch: async (id) => (id in edges ? { meta: row(id), neighbors: edges[id].map((n) => ({ id: n, via: 'dep' })) } : null),
    }
  }

  it('prefetch is called once per BFS level with that level\'s whole frontier', async () => {
    const f = mk()
    const out = await walkGraph('r', f.fetch, 3, 50, f.prefetch)
    assert.deepEqual(f.levels, [['r'], ['a', 'b'], ['c']])
    assert.deepEqual(out.nodes.map((n) => n.id), ['r', 'a', 'b', 'c'])
    assert.equal(out.truncated, false)
  })

  it('result is identical with and without prefetch', async () => {
    const f = mk()
    const plain = await walkGraph('r', f.fetch, 3, 50)
    const batched = await walkGraph('r', f.fetch, 3, 50, f.prefetch)
    assert.deepEqual(batched, plain)
  })

  it('a prefetch error propagates (so the caller can fall back to bd); fetch errors do not', async () => {
    await assert.rejects(walkGraph('r', async () => null, 2, 10, async () => { throw new Error('sql down') }), /sql down/)
    const out = await walkGraph('r', async () => { throw new Error('boom') }, 2, 10)
    assert.deepEqual(out.nodes, [])
  })

  it('bead cap truncates and flags it', async () => {
    const f = mk()
    const out = await walkGraph('r', f.fetch, 3, 2, f.prefetch)
    assert.equal(out.nodes.length, 2)
    assert.equal(out.truncated, true)
  })
})

describe('resolvePartialId (bd ResolvePartialID port)', () => {
  const task = ['task-']
  const ids = ['task-jht8m', 'task-jhx11', 'task-abc12', 'task-abc123']

  it('a unique hash substring resolves (the truncated, line-wrapped mention case)', () => {
    assert.deepEqual(resolvePartialId('task-jht', ids, task), { kind: 'ok', id: 'task-jht8m' })
  })

  it('a bare hash is namespaced into the configured prefix', () => {
    assert.deepEqual(resolvePartialId('jht8', ids, task), { kind: 'ok', id: 'task-jht8m' })
  })

  it('several substring matches are ambiguous and name every match', () => {
    assert.deepEqual(resolvePartialId('task-jh', ids, task), { kind: 'ambiguous', matches: ['task-jht8m', 'task-jhx11'] })
  })

  it('no match is none', () => {
    assert.deepEqual(resolvePartialId('task-zzz', ids, task), { kind: 'none' })
    assert.deepEqual(resolvePartialId('task-jht8m9', ids, task), { kind: 'none' })
  })

  it('an exact hash wins over longer substring matches', () => {
    assert.deepEqual(resolvePartialId('task-abc12', ids, task), { kind: 'ok', id: 'task-abc12' })
    assert.deepEqual(resolvePartialId('task-abc1', ids, task), { kind: 'ambiguous', matches: ['task-abc12', 'task-abc123'] })
  })

  it('the match is a case-sensitive substring, not a prefix', () => {
    assert.deepEqual(resolvePartialId('task-ht8', ids, task), { kind: 'ok', id: 'task-jht8m' })
    assert.deepEqual(resolvePartialId('task-JHT', ids, task), { kind: 'none' })
  })

  it('only the configured prefix is stripped from the input: a truncated allowed-prefix id does not resolve, as in bd', () => {
    const two = ['project-', 'proj-']
    assert.deepEqual(resolvePartialId('proj-g1', ['proj-g1g', 'project-3vc'], two), { kind: 'none' })
    assert.deepEqual(resolvePartialId('proj-g1g', ['proj-g1g', 'project-3vc'], two), { kind: 'ok', id: 'proj-g1g' })
    assert.deepEqual(resolvePartialId('3v', ['proj-g1g', 'project-3vc'], two), { kind: 'ok', id: 'project-3vc' })
  })

  it('an input that is itself a candidate returns it (exact-id fast path)', () => {
    assert.deepEqual(resolvePartialId('task-abc12', ['task-abc12'], task), { kind: 'ok', id: 'task-abc12' })
  })
})

describe('walkGraph with a partial-id mention (bd double listing)', () => {
  // A mention `task-jht` resolves to task-jht8m. bd keys the node by the mention but its meta.id
  // is the real bead, whose label-peer neighbours include the real id: it is listed at depth 1
  // (as the mention) and again at depth 2 (as the real id). The SQL path must reproduce that.
  const row = (id: string): RetrievalRow => ({ store: 'task', id, title: id, labels: [] })
  const graph: Record<string, NeighborSet> = {
    root: { meta: row('root'), neighbors: [{ id: 'task-jht', via: 'mention' }] },
    'task-jht': { meta: row('task-jht8m'), neighbors: [{ id: 'task-jht8m', via: 'label' }] },
    'task-jht8m': { meta: row('task-jht8m'), neighbors: [] },
  }
  it('lists the resolved bead at depth 1 and again at depth 2', async () => {
    const out = await walkGraph('root', async (id) => graph[id] ?? null, 2, 50)
    assert.deepEqual(out.nodes.map((n) => [n.id, n.depth]), [['root', 0], ['task-jht8m', 1], ['task-jht8m', 2]])
  })
  it('an unresolved mention (none or ambiguous) is skipped, not listed', async () => {
    const out = await walkGraph('root', async (id) => (id === 'root' ? graph.root : null), 2, 50)
    assert.deepEqual(out.nodes.map((n) => n.id), ['root'])
  })
})

describe('runListQuery fallback', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('BEADS_BRIDGE_SQL')) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('flag off: bd path only, SQL untouched', async () => {
    process.env.BEADS_BRIDGE_SQL = 'off'
    resetSqlStats()
    const r = await runListQuery('no_such_store_zz', [], [], { exclude: [], limit: 1, allStates: false })
    assert.equal(r.rows.length, 0)
    assert.ok(r.error, 'the bd path reports its own error as data')
    assert.equal(sqlStats.queries, 0)
    assert.equal(sqlStats.fallbacks, 0)
  })

  it('SQL unreachable: logs the fallback, counts it, and answers via bd (errors stay data)', async () => {
    process.env.BEADS_BRIDGE_SQL_PORT = '1' // nothing listens here
    process.env.BEADS_BRIDGE_SQL_TIMEOUT_MS = '1500'
    resetSqlStats()
    const warn = console.warn
    const lines: string[] = []
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')) }
    let r
    try {
      r = await runListQuery('no_such_store_zz', [], [], { exclude: [], limit: 1, allStates: false })
    } finally {
      console.warn = warn
    }
    assert.equal(sqlStats.fallbacks, 1)
    assert.match(lines.join('\n'), /\[sql-fallback\] query_store: .* — using bd subprocess path/)
    assert.deepEqual(r.rows, [])
    assert.ok(r.error)
  })
})
