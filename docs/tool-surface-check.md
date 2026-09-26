# tool_surface_check — verdict semantics

`tool_surface_check` (task-trv5y) compares the MCP tool surface described
in a feedback record against the live surface and returns additions,
removals, schema/capability changes, plus a `needs_refresh` verdict.

## What the comparison actually measures

A server cannot observe the tool list a client currently holds, so the
tool is explicit about its inputs:

1. **Live surface** — `BRIDGE_OP_NAMES` in `src/lib/capabilities.ts`
   (the same list `bridge_info`/`whoami` hash into the staleness line),
   plus backend version + commit + manifest version + schema hash.
2. **Reference surface** — one of:
   - **(a) caller-supplied** `client_tools` (your `tools/list` snapshot)
     and optional `client_schema`: a *direct* staleness check.
   - **(b) feedback record** (default: most recent `FEEDBACK_DIR/*.md`
     by timestamp — filenames are ISO-stamped so lexicographic order is
     chronological): tool names mentioned in its text plus any recorded
     `vX.Y.Z` / `commit` / `schema` triple. A *feedback-era snapshot
     vs live* check.

## needs_refresh semantics

- `YES` — the reference surface differs from live (an addition, a
  removal, or a schema-hash mismatch). Ask the user for a manual MCP
  refresh (disconnect + reconnect); an old connection cannot see newly
  registered tools.
- `NO` — the reference surface equals live. No refresh needed.
- `UNKNOWN` (`needs_refresh: UNKNOWN`) — there is no reference surface
  at all: the feedback record names no tools, records no schema hash,
  and no `client_tools`/`client_schema` was supplied. This is an
  explicit "cannot determine from here", never a guess — supply
  `client_tools` for a firm verdict.

Without caller-supplied input the verdict compares the feedback-era
snapshot vs live, **not** your loaded tools: the response always carries
a `client tools/list is not observable from the server` line so the
scope of the verdict is unambiguous.

## Schema/capability changes

- The schema-hash line compares the recorded hash (prefix-tolerant)
  against the live hash.
- `newer since recorded version` reuses `capabilities_since` on the
  version the feedback recorded — i.e. what a refresh would bring.

## Operational notes

- Observational only: no Bead mutations, no follow-on actions, output
  capped at 4000 chars.
- The gateway caches tool metadata at register time, so after this
  ships run `mcpjungle register --conf <exported conf> --force` before
  gateway clients can see `tool_surface_check` (firstmate owns that step).
