# Heartbeat + follow-ons (task-ksmy1)

Heartbeat is the concrete follow-on service on the generalized
post-action hook mechanism (`src/lib/followons.ts`). It is both an
explicitly callable MCP tool (`heartbeat`) and an automatic footer on
every Beads Bridge tool response. Both read the existing relay-status
ephemeral projection (`src/lib/relay-status.ts`) — no parallel state.

## What the footer shows

Only beads/feed state that changed since that caller's previous MCP
query: `- <id> [<kind>/<state>] <title>` rows (max 5, then `+N more`),
or the minimal acknowledgement **Feeds current.** when nothing changed.
The block is capped at 600 chars. The `staleness:` triple stays the last
footer line; heartbeat lines sit between the relay-status block and it.

## Cursor rule

- Key: OAuth `clientId` when the call bears an OAuth token,
  `loopback-local` for loopback service-bearer calls, `anonymous` else.
- Delta: tracker items with `lastTouchedAt` strictly after the caller's
  cursor. First-ever query (no cursor) returns the current projection as
  mode `baseline`; later queries are mode `delta`.
- The cursor advances to composition start on every footer and every
  `heartbeat` / `relay_status` read (at-least-once: a concurrently
  touched item may repeat next time, never silently skipped).
- Concurrent callers hold independent cursors.

## Loop prevention

Follow-ons return footer text, never tool calls (terminal by
construction); `runFollowons` refuses re-entrant runs; and `heartbeat`,
`relay_status`, `timeout_probe` answer bare (no footer), so footer
output can never fire a follow-on. Heartbeat is observational only: no
store reads/writes, no agent requests (proven in
`src/lib/heartbeat.test.ts`).

## Template config

Wording lives in `config/heartbeat.md` (override path via
`HEARTBEAT_TEMPLATE_FILE`), reloaded per composition — no code change,
no restart needed for wording. Placeholders: `{{mode}}`
(`baseline`|`delta`), `{{count}}`, `{{items}}`; blocks
`{{#changed}}…{{/changed}}` / `{{#empty}}…{{/empty}}` select on
whether anything changed. A template missing `{{count}}`, or any read
failure, falls back to the built-in default — config can never fail a
tool response.
