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
  `GET /live/events` (SSE, replays recent then streams).
- Bead content in the detail pane resolves client-side via the existing
  read-only `GET /:id` route. Multi-bead results render as tab buttons;
  the first tab loads automatically.

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
