# Live MCP Activity UI (`/live`)

Observational live view of Beads Bridge MCP activity (project-s1rf.1.1.2).
Two panels: activity cards (left — call type + lifecycle) and resolved
content (right — auto-follows the newest result, bead refs as tabs).

## How it works

- `src/lib/activity.ts` — in-memory event ring (restart clears it, same
  ephemeral posture as heartbeat cursors / the relay-status projection).
  One `ActivityEvent` per completed MCP `tools/call`: tool, outcome,
  caller, session id, coarse client class, duration, argument NAMES only
  (values never recorded), validated bead refs, bounded result summary.
- `withActivity` wraps the MCP handlers INSIDE the follow-on scope
  (`src/routes/mcp.ts`), so `tool`/`caller` are the canonical scoped
  values from the task-ksmy1 mechanism — no parallel identity model.
- `src/routes/activity.ts` (`liveRouter`, mount order -14) serves:
  `GET /live` (page), `GET /live/config`, `GET /live/recent?limit=`,
  `GET /live/view` (current shared view state, read-only), `GET /live/events`
  (SSE: replays recent activity, writes the current view frame, then streams).
- Bead content in the detail pane resolves client-side via the existing
  read-only `GET /:id` route. Multi-bead results render as tab buttons;
  the first tab loads automatically.
- `src/lib/view-state.ts` — one shared view per bridge instance (drawer +
  selected activity), broadcast as named `event: view` frames. See
  "Layout" and "Shared view state" below.

## Layout: drawer on a phone, two panels on desktop

The page is mobile-first (reviewed on an iPhone in portrait): below 900px the
activity/navigation list is an off-canvas **drawer** (`#panel`,
`min(88vw, 360px)`, safe-area padded) and the live content is the ordinary
document body; at 900px and up the two-panel layout with independent scroll
panes is unchanged. The hamburger opens the drawer; the lane behind it
(`#scrim`), the in-drawer Close, and Escape close it; tapping a card closes it
so the content the card points at is what you see. Nothing is wider than the
viewport — `html, body { overflow-x: hidden }` and long content wraps
(`pre { white-space: pre-wrap; overflow-wrap: anywhere }`) — so the page body
never scrolls sideways in portrait.

## Visual design (task-xpsoy): token palette + inline icon set

The page carries its own tiny design system, still fully inline
(no stylesheet, font, CDN, or icon download — served over Tailscale):

- **Palette.** CSS custom properties on `:root` (light default) with a
  `@media (prefers-color-scheme: dark)` override, so the OS scheme picks
  the theme; `color-scheme: light dark` stays declared. Tokens: `bg`,
  `surface`, `ink`, `muted`, `edge`, `accent`/`accent-ink`, `ok`/`ok-soft`,
  `err`/`err-soft`, `chip-bg`, `pre-bg`, `scrim`, `shadow`. No scattered
  hex literals remain.
- **Icons.** Inline SVG only (`stroke="currentColor"`, sized in `em`,
  decorative instances `aria-hidden`): hamburger (menu), crosshair
  (auto-follow), pause/play (swap on toggle), X (close), plus a per-row
  status glyph (check / x / clock by outcome). Every control keeps its
  accessible name (`Show/Hide activity navigation` labels, `Close` and
  `Pause/Resume` text).
- **Invariants unchanged.** 900px drawer breakpoint, `nav#panel`,
  `aria-controls="panel"`, scrim, Escape/Close/scrim dismissal, named
  `event: view` sync, GET-only `/live` surface.

## Shared view state (`event: view` frames, `GET /live/view`)

One **shared** view per bridge instance: which activity the sidecar points at
(`selectedSeq`) and whether the drawer is open (`drawer`).

- **What "the same session" means.** The ring is process-global and a viewer
  carries no identity, so the only coherent session key is the bridge instance
  itself: every viewer of `/live` on one instance shares this view, and a
  second instance on another port is a different session. State is memory-only
  (a restart clears it, same posture as the ring).
- **Transport.** Changes ride the EXISTING SSE fan-out as named
  `event: view` messages (`broadcastSseFrame` in `src/lib/activity.ts`).
  Activity frames keep their original unnamed shape, so a page that does not
  know the event is unaffected. Each frame carries the whole view plus a
  monotonic `revision`; a client applies last-write-wins and never depends on
  frame ordering or on having seen earlier frames.
- **Events.** `view:current` (state replay for a connecting or reconnecting
  viewer), `view:open`, `view:close`, `view:select`.
- **Current state.** A viewer is brought to it three ways: baked into the page
  at load, fetched from the read-only `GET /live/view`, and replayed on every
  SSE (re)connect — so a reconnect never leaves a stale local guess.
- **What drives it.** The observed stream: every recorded activity event moves
  the shared cursor (`origin: 'activity'`), so all viewers follow the same
  event and a late joiner lands on it too.

### Drawer sync — verified vs. proposed

VERIFIED (`src/routes/live-view.test.ts` plus the mobile verification recorded
with the holding task): one change frame reaches two simultaneous SSE viewers
at the same revision; every viewer converges on the shared cursor; a late
joiner gets the current state; the page applies frames and ignores stale
revisions.

PROPOSED, NOT IMPLEMENTED: a viewer's own tap (open/close the drawer, select a
card) is **local**. It cannot be posted back, because every `/live` route is
GET-only by design so the UI can never re-trigger itself, and this repo has no
guard path registry a write route would have to be registered in first. When
that channel lands the shape is `POST /live/view` with `{ drawer?,
selectedSeq? }` → `setView(patch, origin)` (the single mutation entry point
the activity driver already uses), registered in the guard's path list before
the route exists, never touching beads or the ring. Today the client keeps
local authority once the drawer is touched and adopts server state on load and
reconnect, so a tap never fights a server frame.

## Persistent heartbeat (`GET /live/heartbeat`, `event: heartbeat`)

The footer delta each footered response carries is transient: once its
activity scrolls or ages out of the ring, no always-visible indication of
the latest heartbeat remains. The persistent surface fixes that: one
in-memory snapshot (`src/lib/heartbeat-latest.ts`) holds the most recently
composed heartbeat block and the page shows it in a region above the
panels, updated in place — never appended as another card, never pushed
out by activity.

- **What "status" means.** WHEN the bridge last served a heartbeat
  projection (composition time), to WHOM (caller key only — OAuth
  clientId | `loopback-local` | `anonymous`, never a token), through
  WHICH path (`footer`: the automatic peek on a footered response, or
  `heartbeat`: an explicit `heartbeat` tool read), and the block TEXT
  itself. `relay_status` reads advance the same cursor but return the
  relay projection, not a heartbeat block, so they are not recorded.
- **Age is honest.** The region ticks the snapshot age locally; past
  `HEARTBEAT_STALE_AFTER_MS` (5 min, served as `staleAfterMs` so page and
  server cannot drift) the region reads `stale`, never current.
- **Transport.** Recorded at the composition call sites in
  `src/routes/mcp.ts`, broadcast on the existing SSE fan-out as named
  `event: heartbeat` frames (monotonic `rev`, last-write-wins), replayed
  as `heartbeat:current` on every SSE (re)connect, readable any time at
  `GET /live/heartbeat`, baked into `GET /live` at load. Activity frames
  keep their unnamed shape; a page that does not know the event ignores
  it. Sources are footer peeks + explicit `heartbeat` reads only.
- **Bounds.** Cap 1: only the latest snapshot is retained, never a
  history. Text re-sliced to `HEARTBEAT_MAX_CHARS`; caller is a sanitized
  key (never arg values or tokens); SSE subscribers share the existing
  cap. Recording never throws, so composing a response can never fail
  because of display.
- **Safety unchanged.** Observational only (memory, restart clears it),
  GET-only, no bead mutation or work creation driven by display events.

## Safety model (inherited from the parent bead — do not weaken)

- Observational only: no store reads, no writes, no agent requests.
- Loop prevention: `HEARTBEAT_EXCLUDED_TOOLS` are never recorded, and all
  `/live` endpoints are GET-only so the UI cannot re-trigger itself.
- Bounded: ring cap, summary chars, bead-ref count, SSE subscriber cap.
- Failure isolation: every record/extract/publish step is guarded;
  recording never alters the response.
- Payloads: arg names + byte-shape thinking only; summaries are the
  truncated head of the result with the relay footer stripped.

## Backend configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `ACTIVITY_AUTOFOLLOW_DEFAULT` | `1` | Page auto-follows newest (`0/false/no/off` disables) |
| `ACTIVITY_MAX_EVENTS` | `200` | Ring cap (10–1000) |
| `ACTIVITY_SUMMARY_CHARS` | `300` | Summary cap (40–1000) |
| `ACTIVITY_MAX_BEADREFS` | `10` | Bead refs per event (1–40) |

## Coordination note

Shares the follow-on/relay-status area with the heartbeat investigation
(task-36na1). This UI only READS `currentScope()`,
`HEARTBEAT_EXCLUDED_TOOLS`, and telemetry parse helpers — it changes no
heartbeat/relay/follow-on semantics.
