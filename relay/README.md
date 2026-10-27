# relay

Deterministic task-routing relay for the beads federation. Part of
`beads-bridge`: a ts/http bridge over bead-store CLIs, this Go module is a
self-contained subdirectory (`relay/`) that shells out to the same store CLIs
(`task`, `project`, `ideas`, ...) using the same conventions the TS side uses
(`<store>` subprocess args, `prefix:value` labels).

Reads every eligible open task, applies a *deterministic* classifier (no LLM),
records the decision as persistent child-bead evidence, and marks the task with
a routing label. A separate observer re-audits the work; on disagreement the
relay downgrades the affected task (or the whole route class) and preserves
both decisions.

Non-execution is structural: the relay package has no claim/launch/execute
methods. Tests assert the call log only contains read+label+create.

## Build & test

```
cd relay
go build ./...
go vet ./...
go test ./...
```

## CLI

```
relay process <task-id>            classify one task
relay sweep                        classify all eligible open tasks
relay audit <task-id> <choice> [note] [--as <actor>]
relay routes                       list workflow routes + trust state
```

Config comes from env (see `relay --help` / `config.FromEnv`):
`RELAY_STORE`, `RELAY_THRESHOLD`, `RELAY_RULES_VERSION`,
`RELAY_ALLOW_PROVISIONAL`, `RELAY_SUSPENSION_SCOPE`, `RELAY_ACTOR`.

## Integration boundary

- **In:** store CLIs via `internal/store.CLIStore` (shell-out, 10s timeout,
  `--json` parsing, stdin body for create). Same shape as `src/lib/exec.ts`.
- **In:** workflow route definitions as beads labeled `kind:workflow`,
  `route:<slug>`, `trust:*` — the *runtime* (`relay` labels + child evidence
  beads) never writes back into workflow definitions.
- **Out:** task labels (`routing:ready`, `routing:triage`, `route:<slug>`,
  `audit:disagreed`) and child evidence beads (`kind:evidence`) under each
  classified task.
- **Sweep entrypoint:** `relay sweep` lists only *eligible* tasks: status open,
  no parent, no existing `routing:*` label. Closed/child/already-routed tasks
  are skipped with a recorded reason.

## Evidence model

Every classification persists one child bead under the task:

```
kind:evidence                    (label)
{                                (body, JSON)
  "schemaVersion": 1,
  "taskId":        "task-<id>",
  "inputFingerprint": "<sha256 of title+description+rulesVersion>",
  "ruleVersion":   "relay-1",
  "threshold":     0.65,
  "classifiedAt":  "<rfc3339>",
  "decision":      { "kind": "route|triage", "route": "<slug>", "confidence": 0.9, "reason": "..." },
  "stages":        [ ... each stage's candidates ... ],
  "labelsApplied": [ "routing:ready", "route:<slug>" ]
}
```

The `inputFingerprint` includes the task id, so same-content different-task
inputs never collide; idempotent reprocessing of the *same* task is prevented
by the `routing:*` eligibility label rather than by fingerprint matching.

## Trust lifecycle (`trust:*` labels on workflow beads)

- `trust:provisional` — registered route, not yet validated. Relay will NOT
  route to it unless `RELAY_ALLOW_PROVISIONAL=true`; the task falls back to
  `routing:triage` with reason `route-not-usable:provisional`.
- `trust:trusted` — validated route; normal routing.
- `trust:downgraded` — suspended route (audit disagreement under
  `RELAY_SUSPENSION_SCOPE=class`). Routes to `routing:triage`, reason
  `route-not-usable:downgraded`.

Promotion `provisional → trusted` is a policy decision — see "Deferred
policies". The relay itself never writes trust labels on the happy path.

## Audit seam (shadow audit, two-of-three)

An observer (human or agent) calls `relay audit <task-id> <their-choice> …`.
The relay compares against the stored evidence decision.

- **Agree:** no change; AGREE comment appended to the task.
- **Disagree:** the task loses `routing:ready` + `route:<slug>`, gains
  `routing:triage` + `audit:disagreed`, and both sides' evidence bodies are
  preserved (the auditor's choice is written onto the evidence bead as a
  comment). With `RELAY_SUSPENSION_SCOPE=class`, the route's workflow bead is
  set to `trust:downgraded` too.

The audit outcome feeds a `two-of-three` witness model in the parent system:
this module yields a single observation; three independent observations are
required before any route trust transitions.

## Deferred policy decisions (documented, not hard-coded)

These are the remaining decisions the ISA leaves to the fleet operator. The
runtime is intentionally configurable or read-only about them:

| Policy | Current behavior | Where it will land |
|---|---|---|
| Label schema & naming | `routing:*`, `route:*`, `audit:*`, `kind:*`, `trust:*` fixed anchors | config `label` section |
| Confidence threshold | `RELAY_THRESHOLD` (default 0.65) | already env-configurable |
| Promotion rule | min 10 validation agreements, auto-promote off, human approval required (`Promotion` struct) | promotion service not yet written |
| Audit cadence / comparator | on-demand `audit` subcommand; `witness-two-of-three` constant | watcher ownership + cadence scheduled |
| Downgrade blast radius | `RELAY_SUSPENSION_SCOPE` task vs class | already env-configurable |
| Revalidation after downgrade | none (route stays downgraded) | revalidation job to define |
| Retention / redaction | evidence beads are never deleted | retention policy to define |

## Layout

```
relay/
  cmd/relay/                 CLI (process/sweep/audit/routes)
  internal/config/           env-driven config
  internal/store/            Store interface + CLIStore adapter + MemoryStore test double
  internal/classify/         staged deterministic classifier (explicit → regex → keywords)
  internal/relay/            orchestration: eligibility, idempotency, evidence, audit seam
```