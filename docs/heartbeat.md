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

## Cursor rule (acknowledge-on-read, task-36na1)

- Key: OAuth `clientId` when the call bears an OAuth token,
  `loopback-local` for loopback service-bearer calls, `anonymous` else.
  Every caller arriving via the MCPJungle gateway shares the single
  `loopback-local` key (the gateway fans in with one bearer) — distinct
  humans behind the gateway are NOT isolated from each other. Fixing that
  needs gateway-forwarded client identity, which the bridge never receives.
- Delta: tracker items with `lastTouchedAt` strictly after the caller's
  cursor. First-ever query (no cursor) returns the current projection as
  mode `baseline`; later queries are mode `delta`.
- The cursor advances ONLY on calls whose response shows the caller the
  state: the explicit `heartbeat` tool (the delta) and `relay_status`
  (the full projection). Automatic footers PEEK — they project the
  pending delta without advancing — so an intervening call can report an
  async event but never silently consume it (before task-36na1 every
  footered response consumed the delta: one-shot semantics, and a footer
  nobody read still ate the event). Trade-off: footers repeat the pending
  delta (bounded, 600 chars) until the caller explicitly heartbeats.
- The cursor advances to composition start on every acknowledging read
  (at-least-once: a concurrently touched item may repeat next time, never
  silently skipped).
- Concurrent callers hold independent cursors (per OAuth clientId).

## Coverage boundary

The projection only ever contains bridge-mediated touches. Out-of-band
store writes (direct `bd` CLI, REST mutations that bypass the tracker)
never enter it, so heartbeat structurally cannot report them — on
2026-09-27 an inbox bead closed via `bd` was correctly absent from the
next heartbeat while `retrieval_activity` (live store reads) showed it.
`retrieval_activity` is the authoritative cross-check for external
changes. Cursors and the projection are in-memory: a bridge restart
resets every caller to baseline.

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
