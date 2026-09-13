# Timeout trials — inbox-z55u (owner-run)

Goal: measure when ChatGPT considers an MCP tool call stale, and turn the
observations into a timeout/retry contract for bridge tools.

Probe: MCP tool `timeout_probe` (`src/lib/delay-probe.ts`, wired in
`src/routes/mcp.ts`). Inputs: `delay_seconds` (0–300, capped, rejected above
the cap), `correlation_id` (optional, echoed back; minted when omitted).
Output is bare (no relay-status footer) so trial rows stay machine-parseable:

```
correlation_id: <echo>
requested_delay_s: <n>
actual_delay_ms: <n>
started_at: <iso>
finished_at: <iso>
```

The probe has no side effects: no shell, no store reads or writes.

## Delay ladder

Run in order, one call per trial. Suggested ladder (seconds):

`5, 15, 30, 60, 120, 180`

Optional extension only after the base ladder completes cleanly: `240, 300`
(the cap). Do not exceed 300 — the probe rejects it.

## What to record per trial

| Field | Values |
| ----- | ------ |
| delay asked (s) | ladder value |
| correlation id sent | caller-chosen, unique per trial (see below) |
| outcome | `waited` (full response arrived) / `timeout-error` (caller gave up with an error) / `dropped` (no response, no error) / `late response` (response arrived after a timeout-error/dropped verdict) |
| caller-side wait (s) | how long the caller actually waited before verdict |
| actual_delay_ms | from the probe output, when a response arrives |
| correlation id received | must equal the id sent; any mismatch is a finding, not data |

## Correlation-ID discipline

- Mint a fresh id per trial, e.g. `trial-<delay>s-<letter>` (`trial-60-a`).
  Never reuse an id across trials.
- A response is attributable ONLY when the echoed `correlation_id` matches
  the id sent on that trial.
- A `late response` (id matches an already-verdict trial) is logged against
  the ORIGINAL trial row — it must never be counted as the response to a
  later retry. Retries always use a NEW id.
- Retry rule for the experiment itself: at most 1 retry per ladder step, new
  id, noted as `trial-<delay>s-retry`.

## Reading the results → contract draft

- **Stale threshold**: the smallest ladder delay that stops returning
  `waited`. Report as a range (last-waited, first-not-waited), not a point.
- **Late-response behavior**: whether late responses ever arrive, and after
  how long. This decides whether retries need idempotency keys in production
  tools (if late first responses exist, mutating tools MUST take an
  idempotency key before any retry is allowed).
- **Draft contract** (to confirm or revise from data):
  1. No production tool may block longer than the measured stale threshold
     minus margin; longer work must be async (dispatch + poll).
  2. Read-only probes may run up to the threshold; anything slower uses the
     dispatch pattern.
  3. Every mutating tool gets a caller-supplied idempotency key echoed in its
     receipt, so a retry after a timeout never double-applies.
  4. Timeouts are surfaced as explicit `timeout-error` receipts naming the
     correlation id, never as silence.

## Boundary

ChatGPT-side trials are owner-run: this harness cannot reach ChatGPT, so no
trial has been executed from here. This repo delivers the probe, this
protocol, and the validation tests only.
