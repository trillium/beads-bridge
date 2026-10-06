// Pure singular/plural spellings for store names (task-4lb3r rule, task-d8ipc
// extraction, task-7pqcz both-directions): zero imports, so modules that must
// stay dependency-free (src/lib/create.ts — its tests run without FUNNEL_BASE
// or a registry) can derive a store's candidate id prefixes without pulling in
// config. Single source for the rule: src/lib/store-aliases.ts re-exports this.
//
// THE RULE (mechanical, never fuzzy): a name and its deterministic
// singular/plural spelling are the SAME store, in BOTH directions. A store
// registered as a plural accepts its singular (`inboxes` accepts `inbox`)
// exactly as one registered as a singular accepts its plural (`inbox` accepts
// `inboxes`) — task-7pqcz closed the one-way gap on the plural-registered side.
//
//   forward (registered name is a singular): consonant+`y` -> `-ies`,
//     s/x/z/ch/sh -> `+es`, otherwise -> `+s`
//   reverse (registered name already looks plural): `-ies` -> `-y`,
//     `-es` after s/x/z/ch/sh -> stem, trailing `-s` -> stem
//
// Every reverse reading that applies is carried (`cases` is the `+s` plural of
// the real word `case` AND the `+es` plural of the non-word `cas`): the
// registry decides which reading exists, and if two stores claim one spelling
// the call fails loudly as ambiguous — never guessed. Mass nouns ending in
// `-ss` (`staleness`) stay exact-only, and a trailing-`s` SINGULAR (`status`)
// keeps its mechanical `-s` reading only: the rule cannot tell `status` from
// `ideas` (both vowel+`s`), so inventing `statuses` would invent `ideases`
// too — a spelling nobody registered, which is the guessing this rule refuses.
const isConsonant = (c: string): boolean => /[b-df-hj-np-tv-z]/.test(c)

/** Deterministic plural of a singular stem — the forward direction. */
export function pluralOfSingular(core: string): string {
  const c = core.toLowerCase()
  if (c.endsWith('y') && c.length > 2 && isConsonant(c[c.length - 2])) {
    return `${c.slice(0, -1)}ies`
  }
  if (/((s|x|z|ch|sh))$/.test(c)) return `${c}es`
  return `${c}s`
}

/** Every deterministic singular reading of a plural-looking name — the reverse direction. */
export function singularsOf(plural: string): string[] {
  const s = plural.toLowerCase()
  // `-ies` is decisive: the trailing-s strip of an -ies word is never a word.
  if (s.endsWith('ies') && s.length > 4) return [s.slice(0, -3) + 'y']
  const out: string[] = []
  if (/((s|x|z|ch|sh))es$/.test(s)) out.push(s.slice(0, -2))
  if (s.endsWith('s')) out.push(s.slice(0, -1))
  return [...new Set(out)].filter((a) => a !== s)
}

// Deterministic singular/plural spellings of one canonical store name.
// Lowercase; the head of the list is the preferred reading, and the list is
// bounded by the two suffix rules above (at most 2 entries).
export function aliasesForStore(store: string): string[] {
  const s = store.toLowerCase()
  if (s.length < 2) return []
  if (s.endsWith('ss')) return [] // mass noun: exact only
  const reverse = singularsOf(s)
  if (reverse.length) return reverse
  return [pluralOfSingular(s)]
}
