# Priority and project resolution

Written after the 2026-10-17 incident (robots tickets filed from task-bb8qi):
`project_edit "Sidecar"` rewrote an unrelated résumé project,
`relay_upsert_task project-a4t` filed under another project, and a `Sidecar`
created "as P0" kept P2.

## Project resolution (`src/lib/relay.ts` `lookupProject`)

Every project-targeting write (`project_edit`, `relay_upsert_task`,
`relay_capture`, `relay_dispatch_request`, `relay_flow`) goes through one door:

1. **Exact id** (`project-xxxx[.n]`) is read straight from the projects store
   (`show <id> --json`); the returned id must equal the one asked for (bd
   resolves partial ids by hash substring, so a near-miss is *not* a match).
   It does not depend on any list window.
2. Otherwise **exact** slug, then whole title, then alias — strict tiers over the
   COMPLETE project list (`fetchProjectRows`; an unreadable or capped list is an
   error, never a partial answer).
3. Several hits in the deciding tier → **ambiguous error listing every
   candidate id**. No hit → **unknown-project error** listing nearest names
   (explicitly *not matched*). Either way nothing is written.

Fuzzy token ranking (`rankProjects`, `relay_resolve`) is for suggestions only.

Root cause of the incident: the old lookup listed only 200 of ~700 projects,
fell back to "top fuzzy hit" on any miss, and a miss on `project-a4t`
(token `project`) or `Sidecar` (token in another project's slug) silently
picked a wrong project and reported success. A stale local store copy produces
the same shape of miss; the fix makes a miss an error, not a guess.

The association written on tasks is `project:<slug>` where slug is the project's
own `project:` label, else the slugified title. A project with children already
using a short slug (e.g. `project-a4t` → `project:displayd`) must carry that
`project:` label itself, or exact-id writes label with the long title slug.

## Priority

The real P status is the bd field (`bd create|update --priority N`, shown as
`[● P2 · OPEN]` in `show`). A `priority:P0` **label is only a tag** and never
changes it.

- `bead_create`, `bead_batch_create` beads, `bead_edit`, `project_edit`,
  `relay_upsert_task` take `priority` (`0-4` or `P0-P4`).
- `priority:*` labels are **rejected** (create, batch, upsert extras,
  `bead_label add`) with a pointer to the field. Removing one is allowed.
- The write is verified by the `show` header reading back the requested P
  (`src/lib/priority.ts`); the label is never accepted as proof.
- Not applied: an idempotent-create *revision* of an existing bead
  (`operation_id` reuse) does not change that bead's priority — use `bead_edit`.
