# Projects on Beads Bridge

Projects are first-class beads in the `projects` store. This doc covers the
conventions and the MCP ops that work on them. Implementations live in
`src/lib/relay.ts`; tools are registered in `src/routes/mcp.ts`.

## How a project bead is represented

- One bead per project in the `projects` store.
- `project:<slug>` label — the canonical join key used everywhere else
  (`task`, `stories`, capture routes, evidence packs).
- `state:foreground` label — foreground project; its absence means backlog.
  Promotion (backlog → foreground) happens as a side effect of capture /
  task-write for that project, never implicitly at resolve time.
- `state:deprecated` label — lifecycle status: the project is closed /
  superseded. Its absence means active. Independent of foreground/backlog.
- `alias:` / `aka:` labels — alternate names the resolver matches against.

## Lifecycle label convention

| Lifecycle | Labels |
| --------- | ------ |
| active (default) | no `state:*` deprecation label (may still carry `state:foreground`) |
| deprecated | `state:deprecated` added |

`state:deprecated` is set and cleared only through `project_edit`; nothing
else toggles it automatically.

## Read ops

- `relay_resolve_project` — natural-language → ranked project candidates
  (foreground/backlog explicitly flagged).
- `relay_list_projects` — foreground scope or full backlog search.

## Write ops

- `project_edit` — edit an existing project bead directly. Resolves by id,
  slug, or name; then applies any of: `title`, `description` (empty clears),
  `note` (appended), `lifecycle` (`active` | `deprecated`). Does **not**
  create task or correction beads and never promotes/demotes. Every mutation
  step verifies read-after-write; an unverified write is an error naming the
  bead, and partial application is reported explicitly. Deprecating a
  project is the motivating case: record it here, not as a note elsewhere.

### project_edit contract

Input: `{ project, title?, description?, note?, lifecycle? }`.

Rejections (before any write):

- missing/blank `project` → `project is required (id, slug, or name)`
- no editable field → `give title, description, note, and/or lifecycle`
- `lifecycle` not `active`/`deprecated` → `unknown lifecycle: <v>`
- no project matches the ref → `unknown project: <ref>`

Output shape (one line per applied step, all-verified banner on success):

```
# project updated <id> (STORE: projects)
project: <slug>
title: <title>
state: <foreground|backlog> · lifecycle: <active|deprecated (state:deprecated)>
- update: title + description updated (verified)
- note: note appended (verified)
- lifecycle: set deprecated — state:deprecated added (verified)
All steps verified — project reads back.
```

A failed step returns as an error with the same shape plus
`Partial: N step(s) failed — re-read <id> before reporting success.`

## Cross-references

- `promoteProject` (`src/lib/relay.ts`) — the promote-on-write helper.
- `bead_edit` — the generic bead content tool `project_edit` wraps.
- `blurbs/label-taxonomy.md` — full label namespaces served at /guide/labels.