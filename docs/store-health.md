# Store health, write guard and feedback edits

## Why

Authoritative stores moved to a remote brain host; the store CLIs on a client
host (`task`, `inbox`, `projects`, ...) are thin wrappers that forward over ssh.
Some wrappers are broken (`no beads database found`) or resolve to another
store's workspace (`scratch` -> `brain`). The bridge runs the same CLIs a human
runs, so it must never read or write a store the CLI does not resolve to.

## How it works (`src/lib/store-health.ts`)

- `<store> where` is the probe. Statuses: `ok`, `no-database`, `fallback-local`,
  `local-shadow`, `misrouted`, `unreachable`, `unknown`.
- Writes (`create/update/edit/comment/note/close/label/...`) are refused for
  `no-database`, `fallback-local`, `local-shadow`, `misrouted`. Reads are refused
  for the silently-wrong statuses; a `no-database` read returns the diagnosis
  instead of the raw CLI error. `unreachable`/`unknown` never block (only definite
  signals do). There is no fallback store and no bridge-side re-route.
- Probe results are cached 30s (ok) / 5s (bad).
- `BEADS_BRIDGE_STORE_GUARD=off` disables the guard (tests and ops only; the
  live scratch-store helpers set it because a scratch store is not the registry's).
- Legacy GET routes (`read.ts`, `actions.ts`, `activity.ts`, `util.bd`) are not
  guarded.

## Tools

- `store_health` — `{store?, roundtrip?}`: lists the probe for one/all stores;
  `roundtrip` reads a known record, creates a `bridge-roundtrip` test bead,
  reads it back and closes it (refused for broken stores and for `inbox`).
- `feedback_edit` — `{id, text, mode: replace|append, reason?}`; `id` is the
  short id (`mwfd`) or filename. The superseded version is kept read-only at
  `<feedback dir>/.history/<name>.r<N>.md`; frontmatter gains `revision`,
  `updated_at`, `last_edit_reason`. Success is reported only after read-back.
