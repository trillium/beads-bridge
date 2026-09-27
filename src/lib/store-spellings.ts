// Pure singular/plural spellings for store names (task-4lb3r rule, task-d8ipc
// extraction): zero imports, so modules that must stay dependency-free
// (src/lib/create.ts — its tests run without FUNNEL_BASE or a registry)
// can derive a store's candidate id prefixes without pulling in config.
// Single source for the rule: src/lib/store-aliases.ts re-exports this.
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
