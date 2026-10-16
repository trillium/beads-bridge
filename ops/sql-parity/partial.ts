// Live read-only: bd's partial-id resolution (`bd show <truncated id>`) vs the SQL port
// (sqlResolvePartialIds). For sampled real beads it tries truncated, mid-substring and bare-hash
// inputs plus a no-match id and compares the bead bd resolves to (or "unresolved" for ambiguous and
// none, which bd reports as errors) with the port. Prints one line per mismatch plus a summary and
// exits 1 on any mismatch. Run via ops/sql-parity/run.sh (SAMPLE=n per store, default 25).
import { execStdout, mapLimit } from '../../src/lib/exec'
import { sqlResolvePartialIds, sqlBeadsById } from '../../src/lib/sql-beads'
import { sqlQuery } from '../../src/lib/sql'

const N = Number(process.env.SAMPLE ?? 25)
const stores = process.argv.slice(2).length ? process.argv.slice(2) : ['task', 'brain', 'projects']
let total = 0
let bad = 0
const tally = { resolved: 0, unresolved: 0 }
for (const store of stores) {
  const rows = await sqlQuery(`SELECT id FROM issues WHERE id NOT LIKE 'lifespan-%' ORDER BY RAND() LIMIT 400`)
  const ids = rows.map((r) => String(r.id))
  const own = ids.filter((id) => id.startsWith(`${store === 'projects' ? 'project' : store}-`)).slice(0, N)
  const inputs = new Set<string>()
  for (const id of own) {
    const cut = id.indexOf('-')
    const p = id.slice(0, cut + 1)
    const h = id.slice(cut + 1)
    inputs.add(`${p}${h.slice(0, 3)}`)
    inputs.add(`${p}${h.slice(0, Math.max(3, h.length - 1))}`)
    inputs.add(`${p}${h.slice(1, 4)}`)
    inputs.add(h.slice(0, 4))
  }
  inputs.add(`${own[0]?.slice(0, own[0].indexOf('-') + 1) ?? 'x-'}zzzzq`)
  const list = [...inputs]
  const exact = await sqlBeadsById(list)
  const mine = await sqlResolvePartialIds(list.filter((i) => !exact.has(i)).map((id) => ({ store, id })))
  await mapLimit(list, 6, async (input) => {
    if (exact.has(input)) return
    let bd = 'unresolved'
    try {
      const d = JSON.parse((await execStdout(store, ['show', input, '--json'], 15000)) || 'null')
      const row = Array.isArray(d) ? d[0] : d
      if (row?.id) bd = String(row.id)
    } catch {
      /* ambiguous / no match: bd exits non-zero */
    }
    const sql = mine.get(input) ?? 'unresolved'
    total++
    tally[bd === 'unresolved' ? 'unresolved' : 'resolved']++
    if (bd !== sql) {
      bad++
      console.log(JSON.stringify({ store, input, bd, sql }))
    }
  })
}
console.log(JSON.stringify({ checked: total, mismatches: bad, ...tally }))
process.exit(bad ? 1 : 0)
