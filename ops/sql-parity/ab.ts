// Live read-only A/B of retrieval_snapshot: prints OLD (BEADS_BRIDGE_SQL=off) and NEW (SQL) output for each root
// between markers so the caller can diff them. Run via ops/sql-parity/run.sh (see docs/sql-reads.md).
import { resetStoreProbeCache } from '../../src/lib/store-health'
import { resetSqlScopeCache } from '../../src/lib/sql-beads'
import { reconstructSnapshot, formatSnapshot } from '../../src/lib/retrieval'

for (const root of process.argv.slice(2)) {
  for (const mode of ['old', 'new'] as const) {
    if (mode === 'old') process.env.BEADS_BRIDGE_SQL = 'off'
    else delete process.env.BEADS_BRIDGE_SQL
    resetStoreProbeCache(); resetSqlScopeCache()
    const t = performance.now()
    const snap = await reconstructSnapshot(root, { depth: 2, cap: 60 })
    const ms = Math.round(performance.now() - t)
    console.log(`@@@ ${mode} ${root} ${ms}ms`)
    console.log(formatSnapshot(snap))
    console.log(`@@@ end`)
  }
}
process.exit(0)
