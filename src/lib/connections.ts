// Single-bead connection graph: typed dependency edges both directions,
// children/parent hierarchy, same-label beads, and ids mentioned in text.
// One call replaces four manual steps (show, dep list down/up, label
// queries, mention scan). Reads only; bounded fan-out.
import { execStdout, beadText } from './exec'
import { type Row } from '../routes/query/params'
import { parseRows, runList } from '../routes/query/store'
import { storeFromId, extractLinks } from '../util'
import { BASE } from '../config'

export interface Connection {
  id: string
  title: string
  status?: string
  via: string
}

export interface LabelGroup {
  label: string
  beads: Connection[]
}

export interface ConnectionSet {
  bead: { id: string; title: string; store: string; status?: string; labels: string[] }
  dependsOn: Connection[]
  dependedOnBy: Connection[]
  children: Connection[]
  parent: string | null
  sameLabels: LabelGroup[]
  mentioned: string[]
}

// Dotted numeric suffixes are children (task-2nwlw.1 → parent task-2nwlw).
export function parentOf(id: string): string | null {
  const m = id.match(/^(.+)\.\d+$/)
  return m ? m[1] : null
}

// Only join-labels count as connections (not workflow/system labels).
export function linkLabels(labels: string[], cap = 4): string[] {
  return labels.filter((l) => l.startsWith('project:') || l.startsWith('resume:')).slice(0, cap)
}

interface DepRecord {
  id?: unknown
  title?: unknown
  status?: unknown
  dependency_type?: unknown
}

export function toConnection(r: DepRecord, via: string): Connection | null {
  if (typeof r.id !== 'string' || !r.id) return null
  return {
    id: r.id,
    title: typeof r.title === 'string' ? r.title.slice(0, 120) : '',
    status: typeof r.status === 'string' ? r.status : undefined,
    via: typeof r.dependency_type === 'string' && r.dependency_type ? r.dependency_type : via,
  }
}

async function depEdges(store: string, id: string, direction: 'down' | 'up'): Promise<Connection[]> {
  try {
    const out = await execStdout(store, ['dep', 'list', id, `--direction=${direction}`, '--json'], 12000)
    const arr: unknown = JSON.parse(out || '[]')
    if (!Array.isArray(arr)) return []
    return arr
      .map((r) => toConnection(r as DepRecord, direction === 'down' ? 'depends-on' : 'depended-on-by'))
      .filter((c): c is Connection => !!c && c.id !== id)
  } catch {
    return []
  }
}

async function showMeta(store: string, id: string): Promise<{ title: string; status?: string; labels: string[] }> {
  try {
    const out = await execStdout(store, ['show', id, '--json'], 12000)
    const d = JSON.parse(out || 'null')
    const row = Array.isArray(d) ? d[0] : d
    if (!row || typeof row !== 'object') return { title: '', labels: [] }
    const r = row as Record<string, unknown>
    return {
      title: typeof r.title === 'string' ? r.title.slice(0, 160) : '',
      status: typeof r.status === 'string' ? r.status : undefined,
      labels: Array.isArray(r.labels) ? (r.labels as unknown[]).map(String) : [],
    }
  } catch {
    return { title: '', labels: [] }
  }
}

async function childrenOf(store: string, id: string): Promise<Connection[]> {
  try {
    const out = await execStdout(store, ['list', '--json', '--limit', '50', '--parent', id], 12000)
    return parseRows(out)
      .filter((r) => r.id !== id)
      .map((r: Row) => ({ id: r.id, title: r.title, via: 'child' }))
  } catch {
    return []
  }
}

function mentionedIds(store: string, id: string, text: string): string[] {
  const out: string[] = []
  for (const link of extractLinks(text)) {
    if (!link.startsWith(`${BASE}/`)) continue
    for (const part of link.slice(BASE.length + 1).split(/[+/?&]/)) {
      const clean = part.trim()
      if (clean && clean !== id && storeFromId(clean) && !out.includes(clean)) out.push(clean)
    }
    if (out.length >= 20) break
  }
  return out
}

export async function beadConnections(id: string): Promise<ConnectionSet | { error: string }> {
  const clean = id.trim()
  const store = storeFromId(clean)
  if (!store) return { error: `unknown bead id: ${id}` }
  const [meta, down, up, children, text] = await Promise.all([
    showMeta(store, clean),
    depEdges(store, clean, 'down'),
    depEdges(store, clean, 'up'),
    childrenOf(store, clean),
    beadText(store, ['show', clean]).then((body) =>
      beadText(store, ['comments', clean]).then((c) => (c ? `${body}\n\n${c}` : body)),
    ),
  ])
  // Same-label beads across the link-heavy stores (bounded).
  const labels = linkLabels(meta.labels, 3)
  const searchStores = [...new Set([store, 'task', 'stories'])].slice(0, 3)
  const sameLabels: LabelGroup[] = []
  for (const label of labels) {
    const beads: Connection[] = []
    for (const s of searchStores) {
      const { rows } = runList(s, [label], [], { exclude: [], status: undefined, limit: 8, allStates: true })
      for (const r of rows) {
        if (r.id !== clean && !beads.some((b) => b.id === r.id)) {
          beads.push({ id: r.id, title: r.title, via: `label:${label}` })
        }
      }
      if (beads.length >= 20) break
    }
    sameLabels.push({ label, beads: beads.slice(0, 20) })
  }
  // Parent-child edges surface as dependents too — fold dotted children in
  // so the hierarchy reads in one place.
  const dotted = up.filter(
    (c) => c.via === 'parent-child' && c.id.startsWith(`${clean}.`) && !children.some((k) => k.id === c.id),
  ).map((c) => ({ ...c, via: 'child' }))
  return {
    bead: { id: clean, title: meta.title, store, status: meta.status, labels: meta.labels },
    dependsOn: down,
    dependedOnBy: up,
    children: [...children, ...dotted],
    parent: parentOf(clean),
    sameLabels,
    mentioned: mentionedIds(store, clean, text),
  }
}

const line = (c: Connection): string =>
  `- ${c.id} — ${c.title}${c.status ? ` [${c.status}]` : ''} (${c.via})`

export function formatConnections(set: ConnectionSet): string {
  const { bead } = set
  const section = (title: string, lines: string[]): string[] =>
    lines.length ? [`## ${title}`, ``, ...lines, ``] : [`## ${title}`, ``, `- none`, ``]
  return [
    `# connections — ${bead.id} (STORE: ${bead.store})`,
    ``,
    bead.title,
    `Labels: ${bead.labels.join(', ') || '(none)'}`,
    ``,
    ...section('depends on', set.dependsOn.map(line)),
    ...section('depended on by', set.dependedOnBy.map(line)),
    ...section('children', set.children.map(line)),
    `## parent`,
    ``,
    set.parent ? `- ${set.parent}` : `- none (top-level)`,
    ``,
    ...set.sameLabels.flatMap((g) => section(`label:${g.label} (${g.beads.length})`, g.beads.map(line))),
    `## mentioned in text`,
    ``,
    ...(set.mentioned.length ? set.mentioned.map((id) => `- ${id}`) : ['- none']),
  ].join('\n')
}
