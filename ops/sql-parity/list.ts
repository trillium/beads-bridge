// Parity: runListQuery (SQL) vs runListAsync (bd) over many filter shapes. Read-only.
import { runListQuery, runListAsync, type ListOpts } from '../../src/routes/query/store'
import { resetStoreProbeCache } from '../../src/lib/store-health'
import { resetSqlScopeCache } from '../../src/lib/sql-beads'
import { sqlStats, resetSqlStats } from '../../src/lib/sql'
import { spawnStats, resetSpawnStats } from '../../src/lib/spawn-stats'

const base: ListOpts = { exclude: [], limit: 20, allStates: false }
const stores = ['task', 'brain', 'projects', 'stories', 'inbox', 'resume_bullets', 'ideas', 'friction', 'questions']
type C = { store: string; all: string[]; any: string[]; o: Partial<ListOpts> }
const cases: C[] = []
for (const s of stores) {
  cases.push({ store: s, all: [], any: [], o: {} })
  cases.push({ store: s, all: [], any: [], o: { allStates: true, limit: 50 } })
  cases.push({ store: s, all: [], any: [], o: { limit: 5 } })
  cases.push({ store: s, all: [], any: [], o: { title: 'bridge' } })
  cases.push({ store: s, all: [], any: [], o: { status: 'open' } })
  cases.push({ store: s, all: [], any: [], o: { status: 'closed', limit: 10 } })
  cases.push({ store: s, all: [], any: [], o: { desc: 'the', limit: 10 } })
}
cases.push({ store: 'projects', all: ['state:foreground'], any: [], o: { allStates: true } })
cases.push({ store: 'projects', all: ['sys:resume'], any: [], o: { allStates: true, limit: 50 } })
cases.push({ store: 'task', all: [], any: ['project:beads-bridge', 'project:pai'], o: { allStates: true } })
cases.push({ store: 'task', all: [], any: [], o: { exclude: ['source:mcp'], limit: 30 } })
cases.push({ store: 'task', all: ['source:mcp', 'by:claude'], any: [], o: { allStates: true } })
cases.push({ store: 'task', all: [], any: [], o: { notes: 'a', limit: 10 } })

const key = (r: { rows: unknown; error?: string }) => JSON.stringify(r)
let bad = 0, errs = 0
for (const c of cases) {
  const opts = { ...base, ...c.o }
  delete process.env.BEADS_BRIDGE_SQL; resetStoreProbeCache(); resetSqlScopeCache(); resetSqlStats(); resetSpawnStats()
  const n = await runListQuery(c.store, c.all, c.any, opts)
  const nSp = spawnStats.total, nFb = sqlStats.fallbacks
  const o = await runListAsync(c.store, c.all, c.any, opts)
  const same = key(n) === key(o)
  if (!same || nFb || n.error || o.error) {
    bad += same ? 0 : 1; errs += n.error || o.error ? 1 : 0
    console.log(same ? 'SAME' : 'DIFF', JSON.stringify(c), 'new', n.rows.length, n.error ?? '', 'old', o.rows.length, o.error ?? '', 'fb', nFb, 'spawns', nSp)
    if (!same) { const a = n.rows.map((r) => r.id), b = o.rows.map((r) => r.id); console.log('  new', a.join(' ')); console.log('  old', b.join(' ')) }
  }
}
console.log(JSON.stringify({ cases: cases.length, diffs: bad, withErrorsOrFallbacks: errs }))
process.exit(0)
