# Changelog

## Unreleased

- Store-name aliases resolve in BOTH directions (task-7pqcz): the
  singular/plural rule was one-way — it derived a plural from a registered
  singular (`inbox` → `inboxes`) but never a singular from a registered
  plural, so a store registered as `inboxes` was unreachable by `inbox`.
  Both readings now come from the same word, so either spelling of the same
  store resolves whichever form the registry holds. Where the two readings
  disagree (`cases` is the plural of the word `case` and of the non-word
  `cas`) both are offered and the registry decides: exact still wins, and
  two registered claimants fail loudly as ambiguous — never guessed, so a
  wrong-but-plausible match stays impossible. Deliberate non-goals are
  unchanged and documented in docs/store-aliases.md (no fuzzy matching;
  separators significant; `-ss` mass nouns exact-only; a trailing-`s`
  singular such as `status` keeps its mechanical reading rather than
  inventing `statuses`). The live registry's alias table is unchanged —
  the newly reachable cases are the ones that were broken. Tests name the
  rule and cover singular-in/plural-registered, plural-in/singular-
  registered, pair symmetry, and unknown names still failing cleanly.

- Deployment path for the bridge service (project-s1rf.1.1.2): the launchd job
  now serves a dedicated clean checkout
  (`~/.local/share/beads-bridge/app`, fast-forwarded to `origin/main`) instead
  of the working clone, so an uncommitted dev tree is never part of the
  running server and a deploy can no longer deadlock behind a dirty tree. That
  deadlock is what left all six `/live` variant surfaces (PR #25) serving 404
  from a service pinned at PR #23. `ops/deploy.sh` fast-forwards, installs,
  restarts the job, and fails unless `/live` and every variant return 200;
  `ops/launchd/com.beads-bridge.server.plist` is the job definition it drives.
  `ops/live-shot.mjs` captures a `/live` page over CDP, which is the only way
  to screenshot those pages: their EventSource keeps the document from ever
  firing `load`, so headless `--screenshot`/`--virtual-time-budget` hang
  forever. See docs/deploy.md, docs/live-activity.md.

## 1.6.1

- Idempotent, revision-aware create (beads-bridge, after errors-5uf): the
  same Mac mini provisioning request arrived twice over ChatGPT's
  at-least-once delivery and was handled as two beads (inbox-zmj0 /
  inbox-sx6k) — a duplicate triage pass. `bead_create` now takes an
  optional client-generated `operation_id`: submissions carrying the same
  logical id are reconciled onto ONE bead as durable revisions, never as
  duplicates. The tolerance lives on the bridge's side of the boundary —
  nothing asks the caller to delay, deduplicate, or retry carefully.
  Key: `opkey:<12 hex of sha256(store + operation_id)>` stamped as a label
  (raw client id never lands in a label; the bead id stays server-generated);
  lookup is a label query, so idempotency survives a restart. Reconciliation
  is explicit: title authoritative (latest), body additive (a superseding
  body wins wholesale), labels additive union, materially distinct added
  scope promoted to a child only on explicit `promote: true`. Every delivery is
  recorded (two submissions = one bead, two readable revisions, the shape the
  incident demands); a byte-identical replay is recorded with mode
  `duplicate` and writes nothing to the bead. Ordering rule: monotonic
  per-operation sequence number, content hash as identity and tiebreak —
  arrival time never orders revisions, so replays cannot reorder history. One logical action is serialized by a per-operation lock; a
  cross-process race collapses onto the earliest-created bead. Callers
  supplying no `operation_id` keep the previous single-create behaviour
  exactly. See docs/idempotent-create.md. Manifest v6.

## 1.6.0

- Wildcard capability interface (inbox-hkfd): one stable outer MCP tool
  (`capability`) backed by a registry of named, contract-bearing
  sub-capabilities (`src/lib/wildcard.ts`). Discovery via
  search (natural-language intent) / list / describe, invocation via
  invoke with the payload validated against the selected capability's own
  contract (strict: unknown params rejected, payload size bounded).
  Every entry advertises its read/write effect before invocation; writes
  return structured receipts and fail loudly without one; unknown ids
  fail with suggestions instead of guessing. NOT an arbitrary-tool or
  arbitrary-code endpoint: the registry is a static compiled-in allowlist
  of TypeScript handlers behind the existing withMcpAuth + access-gate
  boundary — no new route, no gate change. Ships with two demonstration
  capabilities (`echo_probe` read, `write_probe` write via namespaced
  scratchpad append); the resume resolver is the intended first real
  capability and waits on the resume-resolved-provenance investigation.
  Manifest v5.

## 1.7.0

- Agent-mail presence readout (`agent_presence`): active/stale/retired
  verdict for one agent-mail agent from last_active plus contact policy
  and unread inbox depth, served from the loopback pilot
  (`src/lib/agent-mail.ts`, `http://127.0.0.1:18765/mcp/`). Profiles are
  registration_token-gated by the pilot — without the token the tool
  reports credentialed + handshake guidance and asserts nothing about
  existence. Read-only; sending stays on agent-mail send_message.
  Manifest v6.

## Unreleased

- Scoped ChatGPT front door (`/chatgpt/mcp`): OAuth-gated streaming proxy
  to the loopback MCPJungle `chatgpt` tool group (beads-bridge server only,
  `src/routes/chatgpt.ts` — same shape as the `/jungle/mcp` front door),
  with its own OAuth audience (`<BASE>/chatgpt/mcp`, discovery at the
  `/chatgpt/mcp`-suffixed well-known paths) so scoped tokens never
  cross-accept with `/mcp` or `/jungle/mcp`. Public connector URL for
  scoped sharing: `https://<funnel-host>/chatgpt/mcp`.
- Candidate visualization surfaces for the live activity sidecar
  (project-s1rf.1.1, captain direction 2026-10-05): every viable shape for
  viewing the same MCP activity stream now sits beside the canonical page at
  its own independently reachable `/live/<variant>` URL — `/live/variants`
  (index, with where each shape came from), `/live/v1` (the canonical page,
  byte-identical, as the comparison baseline), `/live/jumbotron` (large-type
  glanceable wall panel), `/live/timeline` (marks on a time axis, width by
  duration, colour by outcome, with per-tool/caller roll-ups), `/live/log`
  (dense one-line-per-call tail) and `/live/stats` (aggregate readouts:
  totals, error rate, latency percentiles, 30-minute histogram).
  Canonical `GET /live` is unchanged: variants are additions, and none is
  canonical until the captain promotes one. ONE shared event model — every
  surface consumes the existing `/live/config`, `/live/recent`, `/live/view`,
  `/live/heartbeat` and the single `GET /live/events` SSE stream through one
  client runtime (`src/lib/live-variants.ts`), so ordering (by `seq`),
  last-write-wins view/heartbeat frames, reconnect replay and the client ring
  cap behave identically everywhere and no transport is duplicated. Still
  GET-only and observational: every variant path answers
  POST/PUT/PATCH/DELETE with 404, and no surface mutates a bead, creates work
  or triggers an MCP call. See docs/live-activity.md "Candidate
  visualizations".

- Live page visual design (task-xpsoy, supersedes task-u9aal): the `/live`
  page gets a real token palette (`:root` custom properties, light default
  + `prefers-color-scheme: dark` override, `color-scheme: light dark`
  retained) replacing every scattered literal, and an inline-SVG icon set
  (menu / auto-follow / pause-play / close / per-row status glyphs, `em`
  sized, decorative instances `aria-hidden`, controls keep their accessible
  names). Still fully self-contained inline CSS+JS, mobile-first with no
  sideways scroll, every `/live` route still GET-only, drawer contract and
  `event: view` sync untouched. See docs/live-activity.md "Visual design".

- Live MCP Activity UI is mobile-first with a multi-device-synced drawer
  (project-s1rf.1.1): below 900px the activity/navigation list is an off-canvas
  drawer and the live content is the ordinary document body (hamburger /
  scrim / Close / Escape open and close it; tapping a card closes it); 900px
  and up keeps the existing two-panel layout. One SHARED view per bridge
  instance (drawer state + selected activity) — `src/lib/view-state.ts`,
  broadcast over the existing SSE fan-out as named `event: view` frames with a
  monotonic `revision` (last-write-wins), replayed to a (re)connecting viewer
  and readable from the new read-only `GET /live/view`. Every recorded
  activity event moves the shared cursor, so two devices on one instance
  follow the same event. Activity frames keep their original unnamed shape.
  No new write route: every `/live` route stays GET-only, so a viewer's own
  drawer tap remains local — see docs/live-activity.md "Drawer sync" for the
  proposed guarded `POST /live/view` shape. Page fixes found while verifying
  at 390x844: the empty list showed nothing at first paint (now a placeholder),
  and the stream dot stayed red until the first event (now green on connect).

- `bead_create` receipt fix (task-d8ipc): `parseCreatedId` matched the
  created id against the store *name* (`projects-`), but a store's id
  *prefix* comes from its bd config (`project-`, `task-`, `idea-`,
  `assert-`) — so creates in most of the federation succeeded and then
  failed receipt parsing with `INVALID_ARGUMENT`. Receipt parsing now
  derives candidate prefixes mechanically from the canonical-or-alias
  store name (`expectedIdPrefixes`, `src/lib/create.ts`) and falls back
  to the CLI-emitted id (the CLI is authoritative for its own prefix;
  read-back `show` still decides ownership). Null now means only "no
  bead id in output". Alias callers also get the `resolved alias →
  canonical` note on the `bead_create` receipt, per the alias module's
  rule. Pure spelling rule extracted to `src/lib/store-spellings.ts`
  (re-exported by `store-aliases.ts`, single source kept).

## 1.5.0

- Federated store-name aliases (task-4lb3r): MCP store parameters
  and bead-id prefixes accept the natural singular or plural spelling
  (`idea` for `ideas`, `tasks` for `task`, `story-…` for a `stories`
  bead). Rule is mechanical only — exact match plus deterministic
  singular/plural spellings (trailing-s, -ies/-y, -es for s/x/z/ch/sh
  stems); separators stay significant and mass nouns like `staleness`
  have no alias. No fuzzy matching: unknown names are refused with the
  canonical list, and a spelling that could map to more than one store
  fails loudly naming the candidates instead of guessing. Canonical
  names stay authoritative in `whoami`/`bridge_info`/listings; accepting
  responses note the resolution (`resolved alias 'idea' → canonical
  'ideas'`). Applies to `query_store`, `bead_create`,
  `bead_batch_create`, all bead-id tools, `random`, the retrieval ops,
  `relay_capture`, `relay_verify`, and the GET store/id routes.
  Single source `src/lib/store-aliases.ts`, tests
  `src/lib/store-aliases.test.ts`, rule documented in
  `docs/store-aliases.md`. Manifest v4 (19 affected ops marked
  `changed: 1.5.0`).

## 1.4.1

- Bridge version in `whoami` tool description (task-mm1q8): the
  description now ends with a live `[bridge vX / manifest vY]` tag plus
  refresh rule, derived at startup from the same sources `bridge_info`
  and the staleness line read (`serverVersion()` + `capabilities.json`
  manifest). A client holding an older schema reads the mismatch from
  its own loaded description vs live `bridge_info`. Scope is `whoami`
  only (session-start op, no tools/list bloat). `schemaHash` stays over
  operation names only — descriptions never feed it. Manifest v3
  (`whoami` `changed: 1.4.1`).

## 1.4.0

- `tool_surface_check` MCP op (task-trv5y): compares the MCP tool
  surface described in the latest feedback record against the live
  surface — additions, removals, schema/capability changes (via
  `capabilities_since` on the recorded version) plus a `needs_refresh`
  verdict. Accepts an optional caller-supplied tools/list snapshot
  (`client_tools`/`client_schema`) for a direct staleness check; without
  it the verdict is feedback-vs-live and says so, and with no reference
  surface at all it returns an explicit unknown instead of a guess.
  Observational only (no writes, bounded output). Manifest v2.
- Generalized MCP follow-on mechanism + Heartbeat (task-ksmy1, from
  inbox-3z9q/inbox-uagq/inbox-lr1k, design brain-5eq4n): `src/lib/followons.ts`
  (declarative post-action hooks — per-tool triggers, outcome conditions,
  priority ordering, context passing, failure isolation, re-entrancy/cycle
  guards) with Heartbeat as the default follow-on, plus `src/lib/heartbeat.ts`
  (per-caller cursor delta over the relay-status projection). New callable
  `heartbeat` MCP op + automatic `## heartbeat` footer on every tool response
  (template-driven via `config/heartbeat.md`, `HEARTBEAT_TEMPLATE_FILE`
  override; empty delta reports "Feeds current."). Loop prevention (bare
  introspection tools, terminal text-only follow-ons), observational-only
  (no store reads/writes), bounded output, documented cursor rule — see
  `docs/heartbeat.md`. Manifest v2.

## 1.3.0

- Personality document (task-xqj24): Who Am I now returns one durable,
  operator-controlled bootstrap record
  (`~/.config/pai/beads-bridge-personality.md`) in full, replacing the
  500-char profile-schema model for operating instructions. New
  `personality_read` / `personality_replace` / `personality_append` /
  `personality_section_edit` MCP operations (read, full replace, append,
  targeted ## section rewrite). One-time migration moves existing operator
  notes + posture fields verbatim into the document and clears them from the
  profile (name/role/timezone stay; `identity_update` still accepts all
  fields for compatibility). Scratchpad stays alongside as live working
  memory, projected read-only into whoami as before.

## 1.2.0

- `retrieval_claimed` MCP op + federated claimed-bead query (inbox-l6ki):
  in_progress beads across all stores with claimant, claim timestamp
  (started_at) + computed age, oldest first. Claim evidence only — never
  completion or freshness. RetrievalRow gains assignee/startedAt.

## 1.2.0

- Durable per-query MCP telemetry (inbox-au8v): every /mcp request appended
  as JSONL (timestamps, op/tool, session + protocol metadata, client class,
  versions, correlation ids, timing/status). Secrets never recorded
  (auth presence only, arg names+sizes not values, coarse client class).
  Wrapped around the full fetch chain; logging never fails a response.
  Complements the task-qgplz staleness contract with empirical lifecycle data.

## 1.1.0

- Capability/version contract (task-qgplz): new `bridge_info`,
  `capability_status`, `capabilities_since` MCP operations backed by
  `capabilities.json` (manifest v1, 35 capabilities). Backend reports semver +
  commit + schema hash; stale loaded schemas are detectable with a manual MCP
  refresh path. Shipping invariant: implementation + tests + manifest entry +
  version/changelog land coherently.
- `project_edit`: direct project bead edits — title, description, note,
  lifecycle active/deprecated (inbox-z6dv).

## 1.0.0

- Initial MCP bridge surface: bead CRUD/notes/labels/decisions, whoami,
  scratchpad, relay project/task/dispatch/verify flows, retrieval search.
