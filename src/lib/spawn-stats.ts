// Counts bead-store subprocesses this process starts, by verb. Observational
// only (a counter bump per spawn): the before/after measurements in
// docs/sql-reads.md and the PR read it, and tests assert on it.
export const spawnStats = { total: 0, blocking: 0, byVerb: {} as Record<string, number> }

export function noteSpawn(args: readonly string[] | string | undefined, blocking = false): void {
  spawnStats.total++
  if (blocking) spawnStats.blocking++
  const verb = (typeof args === 'string' ? args.trim().split(/\s+/)[0] : args?.[0]) || '?'
  spawnStats.byVerb[verb] = (spawnStats.byVerb[verb] ?? 0) + 1
}

export function resetSpawnStats(): void {
  spawnStats.total = 0
  spawnStats.blocking = 0
  spawnStats.byVerb = {}
}
