// Live read-only parity + timing: OLD (BEADS_BRIDGE_SQL=off) vs NEW on identical inputs; run via ops/sql-parity/run.sh (see docs/sql-reads.md).
import { spawnStats, resetSpawnStats } from '../../src/lib/spawn-stats'
import { resetStoreProbeCache } from '../../src/lib/store-health'
import { sqlQuery, sqlStats, resetSqlStats } from '../../src/lib/sql'
import { resetSqlScopeCache } from '../../src/lib/sql-beads'
import { fetchBeadTexts, renderBeadBlock } from '../../src/lib/bead-text'
import { storeFromId } from '../../src/util'
import { federatedSearch, recentActivity, claimedBeads, reconstructSnapshot, formatSnapshot } from '../../src/lib/retrieval'
import { beadConnections, formatConnections } from '../../src/lib/connections'

const what = process.argv[2]
const runs = Number(process.env.RUNS ?? 3)
const setMode = (m: 'old' | 'new') => { if (m === 'old') process.env.BEADS_BRIDGE_SQL = 'off'; else delete process.env.BEADS_BRIDGE_SQL }
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

async function measure<T>(mode: 'old' | 'new', fn: () => Promise<T>): Promise<{ out: T; ms: number; spawns: number; blocking: number; sql: number; fb: number }> {
  setMode(mode); resetStoreProbeCache(); resetSqlScopeCache(); resetSpawnStats(); resetSqlStats()
  const t = performance.now()
  const out = await fn()
  const ms = performance.now() - t
  return { out, ms, spawns: spawnStats.total, blocking: spawnStats.blocking, sql: sqlStats.queries, fb: sqlStats.fallbacks }
}
async function compare<T>(label: string, fn: () => Promise<T>, key: (t: T) => string) {
  const res = { old: [] as number[], new: [] as number[] }
  let oldOut = '', newOut = '', oSp = 0, nSp = 0, nSql = 0, nFb = 0
  for (let i = 0; i < runs; i++) {
    const o = await measure('old', fn); const n = await measure('new', fn)
    res.old.push(o.ms); res.new.push(n.ms); oldOut = key(o.out); newOut = key(n.out); oSp = o.spawns; nSp = n.spawns; nSql = n.sql; nFb = n.fb
  }
  console.log(JSON.stringify({ label, identical: oldOut === newOut, bytes: oldOut.length, old_ms: Math.round(median(res.old)), new_ms: Math.round(median(res.new)), old_spawns: oSp, new_spawns: nSp, new_sql_queries: nSql, new_fallbacks: nFb }))
  if (oldOut !== newOut) { let i = 0; while (oldOut[i] === newOut[i]) i++; console.log('  first diff @', i, JSON.stringify(oldOut.slice(Math.max(0, i - 80), i + 120)), '\n  vs', JSON.stringify(newOut.slice(Math.max(0, i - 80), i + 120))) }
}

if (what === 'bundle') {
  setMode('new')
  const mix = await sqlQuery(`SELECT id FROM (SELECT i.id AS id, i.updated_at AS u, (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS n FROM issues i WHERE i.status <> 'closed' AND i.issue_type NOT IN ('gate') AND i.id NOT LIKE 'lifespan-%' ORDER BY i.updated_at DESC LIMIT 400) t ORDER BY u DESC`)
  const withC = (await sqlQuery(`SELECT i.id AS id FROM issues i WHERE i.id NOT LIKE 'lifespan-%' AND (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) > 0 ORDER BY i.updated_at DESC LIMIT 60`)).map((r) => String(r.id))
  const pool = [...new Set([...mix.map((r) => String(r.id)), ...withC])].filter((id) => storeFromId(id))
  const pick = (n: number) => { const half = Math.floor(n / 2); return [...new Set([...withC.slice(0, half), ...pool.filter((x) => !withC.includes(x)).slice(0, n)])].filter((id) => /^[A-Za-z][A-Za-z0-9_-]{2,64}(\.\d+)?$/.test(id)).slice(0, n) }
  for (const n of [10, 40]) {
    const ids = pick(n)
    await compare(`beads_bundle N=${ids.length}`, async () => {
      const refs = ids.map((id) => ({ id, store: storeFromId(id)! }))
      const t = await fetchBeadTexts(refs)
      return ids.map((id) => renderBeadBlock(id, storeFromId(id)!, t.get(id)!)).join('\n\n---\n\n')
    }, (s) => s)
  }
} else if (what === 'retrieval') {
  await compare('retrieval_search("bridge") all stores', () => federatedSearch('bridge', { perStore: 20, limit: 30 }), (r) => JSON.stringify(r))
  await compare('retrieval_search("") all stores', () => federatedSearch('', { perStore: 20, limit: 30 }), (r) => JSON.stringify(r))
  await compare('retrieval_activity all stores', () => recentActivity({ limit: 20 }), (r) => JSON.stringify(r))
  await compare('retrieval_activity since', () => recentActivity({ limit: 20, since: '2026-10-10T00:00:00Z' }), (r) => JSON.stringify(r))
  await compare('retrieval_claimed all stores', () => claimedBeads({ limit: 20, staleAfterMs: 1000 }), (r) => JSON.stringify({ ...r, rows: r.rows.map((x) => ({ ...x, claimAgeMs: undefined })) }))
}
else if (what === 'snapshot-find') {
  setMode('new')
  const cands = (await sqlQuery(`SELECT x.id AS id, x.n AS n FROM (SELECT depends_on_issue_id AS id, COUNT(*) AS n FROM dependencies WHERE depends_on_issue_id IS NOT NULL GROUP BY depends_on_issue_id) x WHERE x.id NOT LIKE 'lifespan-%' ORDER BY x.n DESC LIMIT 40`)).map((r) => String(r.id))
  for (const id of cands) { const s = await reconstructSnapshot(id, { depth: 2, cap: 60 }); console.log(id, s.beads.length, s.truncated) }
} else if (what === 'snapshot') {
  const roots = process.argv.slice(3)
  for (const root of roots) {
    await compare(`retrieval_snapshot ${root}`, () => reconstructSnapshot(root, { depth: 2, cap: 60 }), (r) => formatSnapshot(r) + JSON.stringify(r))
  }
} else if (what === 'connections') {
  const roots = process.argv.slice(3)
  for (const root of roots) {
    await compare(`bead_connections ${root}`, () => beadConnections(root), (r) => ('error' in r ? r.error : formatConnections(r) + JSON.stringify(r)))
  }
}
process.exit(0)
