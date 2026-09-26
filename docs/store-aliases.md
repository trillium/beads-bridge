# Store-name aliases (task-4lb3r)

MCP store parameters and bead-id prefixes accept the natural singular or
plural spelling of a store: `idea` works for `ideas`, `tasks` works for
`task`, `story-…` works for a `stories` bead. This is an input
convenience — canonical names stay authoritative everywhere they are
listed (`whoami`, `bridge_info`, query headers).

## The rule (mechanical, never fuzzy)

A requested name resolves to a canonical store only when it is:

1. an exact match (case-insensitive, surrounding whitespace ignored), or
2. one of that store's deterministic singular/plural spellings:
   - trailing `-s`: `idea`↔`ideas`, `project`↔`projects`, `task`↔`tasks`
   - `-ies`/`-y`: `story`↔`stories`, `company`↔`companies`
   - `-es` for `s`/`x`/`z`/`ch`/`sh` stems: `inbox`↔`inboxes`

Exact always wins, so two registered spellings can never clash: if both
`box` and `boxes` ever registered, each resolves exactly.

Deliberate non-goals (refused, never guessed):

- **No fuzzy/similarity matching.** `ideaas`, `projekt`, `taks` are
  rejected with the known-store list. Silently sending a query to the
  WRONG store is worse than refusing.
- **Separators are significant.** `nightshift_tasks` never resolves to
  `nightshift-tasks`.
- **Mass nouns have no alias.** `staleness` (ends `-ss`) resolves only
  exactly.

## Ambiguity fails loudly

If one spelling could map to more than one store (possible only when it
is exact for none of them), the call fails with a typed error naming
the candidates instead of picking one:

```text
ambiguous store name: boxes (candidates: box, boxe) — use the full canonical store name
ambiguous bead id: boxes-1 (prefix 'boxes-' matches box, boxe) — use the full canonical bead id
```

Unknown names fail with the refusal plus the canonical list:

```text
unknown store: nope (known: applications, assertions, …) — aliases cover singular/plural spellings only (idea<->ideas, story<->stories, inbox<->inboxes); anything else is refused, never guessed
```

## Before / after

Before (backend v1.4.1):

```text
query_store(store="idea")  → unknown store: idea (known: …)
query_store(store="tasks") → unknown store: tasks (known: …)
```

After (backend v1.5.0):

```text
query_store(store="idea")  → # query — ideas (N) (resolved alias 'idea' → canonical 'ideas')
query_store(store="tasks") → # query — task (N) (resolved alias 'tasks' → canonical 'task')
```

## Implementation

Single source: `src/lib/store-aliases.ts`
(`resolveStoreName`, `resolveBeadStore`, `aliasesForStore` plus the
`unknown*`/`ambiguous*` error formatters). `storeFromId` (`src/util.ts`)
delegates to it, so every id-based path — MCP tools, GET routes,
connections, feedback, batch refs — resolves either spelling.
Store-name parameters resolve in `query_store`, `bead_create`,
`bead_batch_create`, `random`, the four retrieval ops, `relay_capture`,
and `relay_verify`. Tests: `src/lib/store-aliases.test.ts`.
