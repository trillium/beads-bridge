// Federated store-name aliases (task-4lb3r): singular/plural input
// convenience for MCP store parameters and bead-id prefixes.
//
// THE RULE (mechanical, never fuzzy): a requested name resolves to a
// canonical store only when it is an exact match (case-insensitive) or one
// of that store's deterministic singular/plural spellings:
//   - trailing-s: ideas<->idea, projects<->project, task<->tasks
//   - ies/y: stories<->story, companies<->company
//   - es-plural for s/x/z/ch/sh stems: inbox<->inboxes
// Mass nouns ending in "ss" (staleness) have no alias. Separators are
// significant: nightshift_tasks never resolves to nightshift-tasks.
// Anything outside this rule is refused, never guessed — silently sending
// a query to the WRONG store is worse than refusing.
//
// Canonical names stay authoritative: listings, whoami, and bridge_info
// always report canonical spellings; aliases only appear in a
// "resolved alias X -> canonical Y" note on the accepting response.
import { STORES } from '../config'

export type StoreResolution =
  | { kind: 'exact'; store: string }
  | { kind: 'alias'; store: string; requested: string }
  | { kind: 'ambiguous'; requested: string; candidates: string[] }
  | { kind: 'unknown'; requested: string }

export type BeadStoreResolution =
  | { kind: 'ok'; store: string; viaAlias: boolean }
  | { kind: 'unknown'; prefix: string }
  | { kind: 'ambiguous'; prefix: string; candidates: string[] }

const isConsonant = (c: string): boolean => /[b-df-hj-np-tv-z]/.test(c)

// Deterministic singular/plural spellings of one canonical store name.
// Lowercase; at most one alias per store with the current registry.
export function aliasesForStore(store: string): string[] {
  const s = store.toLowerCase()
  if (s.length < 2) return []
  if (s.endsWith('ies') && s.length > 4) return [s.slice(0, -3) + 'y']
  if (s.endsWith('ss')) return []
  if (s.endsWith('s')) return [s.slice(0, -1)]
  if (s.endsWith('y') && s.length > 2 && isConsonant(s[s.length - 2])) {
    return [s.slice(0, -1) + 'ies']
  }
  if (/((s|x|z|ch|sh))$/.test(s)) return [`${s}es`]
  return [`${s}s`]
}

// Resolve a requested store name against a registry (default: live STORES).
// Exact (case-insensitive) always wins; aliases only compete when nothing
// is exact, so two canonical spellings can never be ambiguous with each
// other — ambiguity needs one alias shared by 2+ stores and exact by none.
export function resolveStoreName(requested: string, stores: string[] = STORES): StoreResolution {
  const raw = (requested ?? '').trim()
  const name = raw.toLowerCase()
  if (!name) return { kind: 'unknown', requested: raw }
  const exact = stores.find((s) => s.toLowerCase() === name)
  if (exact) return { kind: 'exact', store: exact }
  const hits = [...new Set(stores.filter((s) => aliasesForStore(s).includes(name)))].sort()
  if (hits.length === 1) return { kind: 'alias', store: hits[0], requested: raw }
  if (hits.length > 1) return { kind: 'ambiguous', requested: raw, candidates: hits }
  return { kind: 'unknown', requested: raw }
}

export function unknownStoreError(requested: string, stores: string[] = STORES): string {
  const q = (requested ?? '').trim() || '(empty)'
  return `unknown store: ${q} (known: ${[...stores].sort().join(', ')}) — aliases cover singular/plural spellings only (idea<->ideas, story<->stories, inbox<->inboxes); anything else is refused, never guessed`
}

export function ambiguousStoreError(requested: string, candidates: string[]): string {
  return `ambiguous store name: ${requested} (candidates: ${candidates.join(', ')}) — use the full canonical store name`
}

// Bead-id prefix before the first '-' (dotted children like task-9x.1 keep
// the head segment). Legacy: project- beads live in projects — which is
// also the plural alias, so the override only matters if a 'project' store
// ever registers alongside 'projects'.
export function resolveBeadStore(id: string, stores: string[] = STORES): BeadStoreResolution {
  const clean = (id ?? '').trim()
  const dash = clean.indexOf('-')
  if (clean.length === 0 || dash <= 0) return { kind: 'unknown', prefix: '' }
  const segment = clean.slice(0, dash)
  if (segment.toLowerCase() === 'project' && stores.includes('projects')) {
    return { kind: 'ok', store: 'projects', viaAlias: true }
  }
  if (stores.some((s) => clean.startsWith(`${s}-`))) {
    return { kind: 'ok', store: stores.find((s) => clean.startsWith(`${s}-`))!, viaAlias: false }
  }
  const r = resolveStoreName(segment, stores)
  if (r.kind === 'exact' || r.kind === 'alias') {
    return { kind: 'ok', store: r.store, viaAlias: true }
  }
  if (r.kind === 'ambiguous') return { kind: 'ambiguous', prefix: segment, candidates: r.candidates }
  return { kind: 'unknown', prefix: segment }
}

export function unknownBeadIdError(id: string): string {
  return `unknown bead id: ${id}`
}

export function ambiguousBeadIdError(id: string, prefix: string, candidates: string[]): string {
  return `ambiguous bead id: ${id} (prefix '${prefix}-' matches ${candidates.join(', ')}) — use the full canonical bead id`
}

// One-line rule summary for docs footers and error context.
export function aliasRuleSummary(): string {
  return 'Store aliases: exact canonical names plus deterministic singular/plural spellings only (trailing-s, -ies/-y, -es for s/x/z/ch/sh stems). No fuzzy matching — unknown or ambiguous names fail loudly.'
}
