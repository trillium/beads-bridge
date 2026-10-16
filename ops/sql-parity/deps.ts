// Live read-only: `bd dep list` edge ORDER vs the SQL port (sqlDepEdges), the way production calls it
// (many ids in one batch). With ids, checks those; with none, samples beads that have 2-8 edges per
// direction. Prints one line per mismatch plus a summary. Run via ops/sql-parity/run.sh.
import { execStdout, mapLimit } from '../../src/lib/exec'
import { sqlDepEdges } from '../../src/lib/sql-beads'
import { sqlQuery } from '../../src/lib/sql'
import { storeFromId } from '../../src/util'

const N = Number(process.env.SAMPLE ?? 120)
const given = process.argv.slice(2)
const sample = async (col: string): Promise<string[]> =>
  (await sqlQuery(`SELECT ${col} AS k FROM dependencies WHERE ${col} IS NOT NULL AND ${col} NOT LIKE 'lifespan-%' GROUP BY ${col} HAVING COUNT(*) BETWEEN 2 AND 8 ORDER BY ${col}`))
    .map((r) => String(r.k))
    .filter((id) => storeFromId(id))
    .filter((_, i, a) => i % Math.max(1, Math.floor(a.length / N)) === 0)
    .slice(0, N)
let bad = 0
let total = 0
let sorted = 0
const isSorted = (xs: string[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1] <= x)
for (const dir of ['down', 'up'] as const) {
  const ids = given.length ? given : await sample(dir === 'down' ? 'issue_id' : 'depends_on_issue_id')
  const sql = await sqlDepEdges(ids, dir)
  await mapLimit(ids, 6, async (id) => {
    const out = JSON.parse((await execStdout(storeFromId(id)!, ['dep', 'list', id, `--direction=${dir}`, '--json'], 15000)) || '[]') as { id: string }[]
    const bd = out.filter((r) => r.id && r.id !== id).map((r) => r.id)
    const mine = (sql.get(id) ?? []).filter((e) => e.id && e.id !== id).map((e) => e.id)
    total++
    if (isSorted(bd)) sorted++
    if (JSON.stringify(bd) !== JSON.stringify(mine)) {
      bad++
      console.log(JSON.stringify({ id, dir, bd, sql: mine }))
    }
  })
}
console.log(JSON.stringify({ checked: total, mismatches: bad, bd_lists_sorted_by_id: sorted }))
process.exit(bad ? 1 : 0)
