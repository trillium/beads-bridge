// Event-loop stall during bead_connections / retrieval_snapshot: a 5ms ticker records the worst gap
// (what a concurrent `whoami` call would wait). Works against both the original (main) and this branch.
import { beadConnections } from '../../src/lib/connections'
import { reconstructSnapshot } from '../../src/lib/retrieval'
const mode = process.argv[2]
const roots = process.argv.slice(3)
let last = performance.now(), maxGap = 0, ticks = 0
const timer = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++ }, 5)
for (const root of roots) {
  maxGap = 0; ticks = 0; last = performance.now()
  const t = performance.now()
  const res = mode === 'snapshot' ? await reconstructSnapshot(root, { depth: 2, cap: 60 }) : await beadConnections(root)
  const ms = performance.now() - t
  await new Promise((r) => setTimeout(r, 30)) // let the ticker record a trailing block
  console.log(JSON.stringify({ mode, root, ms: Math.round(ms), max_event_loop_gap_ms: Math.round(maxGap), ticks, beads: 'beads' in res ? res.beads.length : undefined }))
}
clearInterval(timer)
process.exit(0)
