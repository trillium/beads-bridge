// Scope-label discovery for bare composition: Tier 1 (this resume,
// deliberate) = project: slugs on task/stories labeled resume:<id>;
// Tier 2 (any resume) = slugs on sys:resume projects. Tier 1 wins the cap.
// Cached — discovery changes on human timescales, but composition must fit
// inside a web-fetch timeout even when the box is loaded.
import { runList } from './store'
import { cleanLabel, MAX_LABELS } from './params'

const scopeLabelCache = new Map<string, { at: number; labels: string[] }>()
const SCOPE_LABEL_TTL_MS = 300_000

export function discoverScopeLabels(id: string): string[] {
  const hit = scopeLabelCache.get(id)
  if (hit && Date.now() - hit.at < SCOPE_LABEL_TTL_MS) return hit.labels
  const tier1 = new Map<string, number>()
  const tier2 = new Map<string, number>()
  const scope = `resume:${id}`
  for (const store of ['task', 'stories'] as const) {
    const { rows } = runList(store, [scope], [], { exclude: [], status: undefined, limit: 50, allStates: true })
    for (const r of rows) {
      for (const l of r.labels) {
        if (l.startsWith('project:') && cleanLabel(l)) tier1.set(l, (tier1.get(l) ?? 0) + 1)
      }
    }
  }
  {
    const { rows } = runList('projects', ['sys:resume'], [], { exclude: [], status: undefined, limit: 50, allStates: true })
    for (const r of rows) {
      for (const l of r.labels) {
        if (l.startsWith('project:') && cleanLabel(l) && !tier1.has(l)) tier2.set(l, (tier2.get(l) ?? 0) + 1)
      }
    }
  }
  const rank = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l)
  const labels = [...rank(tier1), ...rank(tier2)].slice(0, MAX_LABELS)
  scopeLabelCache.set(id, { at: Date.now(), labels })
  return labels
}
