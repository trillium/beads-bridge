// Read-only guard + config + fallback behaviour of src/lib/sql.ts. No database
// needed: every rejection happens before the network is touched.
// Run: bun test src/lib/sql.test.ts (node:test, no new deps).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertReadOnlySql,
  SqlReadOnlyError,
  sqlConfig,
  sqlEnabled,
  sqlQuery,
  withSqlFallback,
  resetSqlStats,
  sqlStats,
} from './sql'

describe('assertReadOnlySql — accepts reads', () => {
  const good = [
    'SELECT 1',
    'select id, title from issues where id = ?',
    "SELECT id FROM issues WHERE title LIKE '%update the delete flow%'", // keywords inside a literal
    'SELECT i.id FROM issues i WHERE i.updated_at > ? ORDER BY i.updated_at DESC LIMIT 10;',
    '(SELECT id FROM issues WHERE id LIKE ? LIMIT 5) UNION ALL (SELECT id FROM wisps WHERE id LIKE ? LIMIT 5)',
    'WITH x AS (SELECT id FROM issues) SELECT * FROM x',
    'SELECT issue_id, label FROM labels WHERE issue_id IN (?,?,?)',
    'SELECT h.commit_date FROM dolt_history_issues h WHERE h.id = ?', // dolt TABLE reads are fine
    'SELECT created_at, closed_at, started_at FROM issues',
  ]
  for (const q of good) {
    it(q.slice(0, 60), () => assert.doesNotThrow(() => assertReadOnlySql(q)))
  }
})

describe('assertReadOnlySql — rejects everything that is not one SELECT', () => {
  const bad: Array<[string, string]> = [
    ['INSERT INTO issues (id) VALUES (1)', 'insert'],
    ["UPDATE issues SET title = 'x'", 'update'],
    ['DELETE FROM issues', 'delete'],
    ['REPLACE INTO issues (id) VALUES (1)', 'replace'],
    ['DROP TABLE issues', 'drop'],
    ['ALTER TABLE issues ADD COLUMN x int', 'alter'],
    ['CREATE TABLE t (a int)', 'create'],
    ['TRUNCATE issues', 'truncate'],
    ['SET autocommit = 0', 'set'],
    ["CALL dolt_commit('-am','x')", 'call'],
    ["SELECT dolt_commit('-am','x')", 'dolt function'],
    ["SELECT DOLT_RESET('--hard')", 'dolt function'],
    ["SELECT dolt_checkout('main')", 'dolt function'],
    ['SELECT 1; DROP TABLE issues', 'multiple statements'],
    ['SELECT 1; SELECT 2', 'multiple statements'],
    ["SELECT id INTO OUTFILE '/tmp/x' FROM issues", 'into'],
    ['SELECT id FROM issues FOR UPDATE', 'locking'],
    ['SELECT id FROM issues LOCK IN SHARE MODE', 'locking'],
    ['SELECT /*! DROP TABLE issues */ 1', 'comment'],
    ['SELECT 1 -- ; DROP TABLE issues', 'comment'],
    ['SELECT 1 # tail', 'comment'],
    ['WITH x AS (SELECT 1) DELETE FROM issues', 'delete'],
    ['SELECT SLEEP(10)', 'side-effecting'],
    ["SELECT GET_LOCK('x', 10)", 'side-effecting'],
    ['SHOW TABLES', 'only SELECT'],
    ['EXPLAIN SELECT 1', 'only SELECT'],
    ['USE other_db', 'only SELECT'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['START TRANSACTION', 'only SELECT'],
    ['COMMIT', 'only SELECT'],
  ]
  for (const [q, why] of bad) {
    it(`${q.slice(0, 50) || '(empty)'} — ${why}`, () => {
      assert.throws(() => assertReadOnlySql(q), SqlReadOnlyError)
    })
  }

  it('sqlQuery refuses before touching the network', async () => {
    resetSqlStats()
    await assert.rejects(sqlQuery("UPDATE issues SET title='x'"), SqlReadOnlyError)
    assert.equal(sqlStats.queries, 0)
  })
})

describe('config + rollout flag', () => {
  const saved = { ...process.env }
  const clear = (): void => {
    for (const k of Object.keys(process.env)) if (k.startsWith('BEADS_BRIDGE_SQL')) delete process.env[k]
  }
  afterEach(() => {
    clear()
    Object.assign(process.env, saved)
  })
  beforeEach(clear)

  it('defaults: 127.0.0.1:3307 brain_unified, no credentials baked in', () => {
    const c = sqlConfig({})
    assert.equal(c.host, '127.0.0.1')
    assert.equal(c.port, 3307)
    assert.equal(c.database, 'brain_unified')
    assert.equal(c.password, '')
  })

  it('env overrides', () => {
    const c = sqlConfig({ BEADS_BRIDGE_SQL_HOST: 'db.test', BEADS_BRIDGE_SQL_PORT: '13307', BEADS_BRIDGE_SQL_DATABASE: 'x' })
    assert.equal(c.host, 'db.test')
    assert.equal(c.port, 13307)
    assert.equal(c.database, 'x')
  })

  it('BEADS_BRIDGE_SQL=off|0|false forces the old path', () => {
    assert.equal(sqlEnabled({}), true)
    for (const v of ['off', 'OFF', '0', 'false', 'no']) assert.equal(sqlEnabled({ BEADS_BRIDGE_SQL: v }), false)
    assert.equal(sqlEnabled({ BEADS_BRIDGE_SQL: 'on' }), true)
  })

  it('flag off: SQL implementation is never invoked', async () => {
    process.env.BEADS_BRIDGE_SQL = 'off'
    let sqlCalled = false
    const out = await withSqlFallback('t', async () => { sqlCalled = true; return 'sql' }, async () => 'bd')
    assert.equal(out, 'bd')
    assert.equal(sqlCalled, false)
  })

  it('SQL failure falls back to bd and is counted + logged', async () => {
    resetSqlStats()
    const warn = console.warn
    const lines: string[] = []
    console.warn = (...a: unknown[]) => { lines.push(a.join(' ')) }
    try {
      const out = await withSqlFallback('probe', async () => { throw new Error('boom') }, async () => 'bd')
      assert.equal(out, 'bd')
    } finally {
      console.warn = warn
    }
    assert.equal(sqlStats.fallbacks, 1)
    assert.match(lines.join('\n'), /\[sql-fallback\] probe: boom/)
  })

  it('SQL success never touches the bd path', async () => {
    let bdCalled = false
    const out = await withSqlFallback('t', async () => 'sql', async () => { bdCalled = true; return 'bd' })
    assert.equal(out, 'sql')
    assert.equal(bdCalled, false)
  })
})
