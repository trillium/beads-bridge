# Voice-misrecognition guard (feature-n7e)

Dictated requests sometimes carry a speech-to-text slip: "feed" or "beat" for
"bead". The guard pauses a **possibly mis-heard** write *before* it runs, shows
the proposed correction, and lets a second call confirm, correct or cancel.
Clean calls are untouched and execute in one step.

Code: `src/lib/voice-guard.ts`. It wraps `server.registerTool` inside
`registerBridgeTools` (`src/routes/mcp.ts`), so no tool callback changed and
the SDK's input validation has already run.

## Where misrecognitions come from

Open beads in the `glossary` store labelled `voice-transcription`, read at
runtime (`glossary list --json --label voice-transcription`). Nothing is
hard-coded. glossary-jgv is the first entry.

## Marking a misrecognition

One rule per description line:

```
- 'feed' (F) may mean 'bead' (B), particularly for Beads task records
- 'beat' may mean 'bead' in the same contexts.
- 'feed' may mean 'bead'; keep: status feed, inbox feed
```

- Shape: `'<heard>' [(note)] may [also] mean '<meant>' …`. Leading `-`/`*`
  bullet optional; quotes may be `'`, `"` or curly.
- Optional `; keep: a, b` at the end of the line lists legitimate phrases that
  contain the heard word. A match inside a kept phrase is never flagged.
- Any other line in the description is prose and ignored. Matching is
  whole-word and case-insensitive.
- glossary-jgv parses as written (feed→bead, beat→bead). It has no `keep:`
  clause, so a legitimate "status feed" is protected by the
  confirm-with-`original` path rather than by the rule; add `; keep: status
  feed` to the glossary line to stop it pausing at all.
- A new or edited glossary entry is live within the rule cache TTL (30 s).

## What is checked

Free-text arguments (`title`, `description`, `text`, `note`, `instruction`,
`task_title`, `task_description`, `dispatch_instruction`) of: `bead_comment`,
`bead_note`, `bead_create`, `bead_batch_create`, `bead_edit`, `project_edit`,
`relay_capture`, `relay_upsert_task`, `relay_dispatch_request`, `relay_flow`.
Ids, stores, labels and enums are never scanned.

## The two-step flow

1. Call the tool as usual. If a rule matches, the response says
   `PAUSED — <tool> was NOT executed; nothing was written` and includes a second
   block `voice_guard (JSON): {...}` with the token, each finding (path, heard,
   suggested, snippet) and the arguments with suggestions applied.
2. Call `voice_confirm` with the `token` and a `decision`:
   - `accept` — run with the suggested wording.
   - `original` — run exactly what was sent (the term was right).
   - `correct` + `arguments` — run with arguments you supply (validated against
     the tool's schema).
   - `cancel` — drop it; nothing is written.

The call executes **at most once**. Repeating `voice_confirm` with the same
decision returns the cached result; a different decision after execution is
refused. Re-sending the identical original call within 2 minutes of it
settling returns the settled result instead of pausing again. A tool error
after confirmation returns the request to pending so it can be retried. A
cancelled request, if re-sent, asks again. Confirmation is bound to the
caller that created the pause.

Nothing is ever rewritten silently: detection only pauses.

## Visibility

The pause is the tool response itself (it rides the normal response footer).
Each pending pause is also a `verify` item on the relay-status tracker, titled
`voice check pending (<tool>): "feed" may mean "bead"`, so the `heartbeat`
lists it until it is settled. If the glossary cannot be read, the footer of
every guarded call carries a `voice-guard: glossary rules unavailable …` line
so the fail-open is visible.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `BEADS_BRIDGE_VOICE_GUARD` | on | `off` disables the guard entirely |
| `BEADS_BRIDGE_VOICE_STORE` | `glossary` | store holding the rules |
| `BEADS_BRIDGE_VOICE_RULES_TTL_MS` | `30000` | rule cache lifetime |

Timings (constants): pending 15 min, settled results retained 10 min, resubmit
window 2 min, 200 entries max.

## Failure modes

- **Glossary unreadable** — fails *open*: the call runs and the footer reports
  the load error. A broken glossary must not take down the write path.
- **Pending store is in-memory** — a bridge restart drops unanswered pauses;
  `voice_confirm` then reports an unknown/expired token and the original call
  can simply be re-sent. Nothing was written, so nothing is lost or duplicated.
- **Stale clients** — a client with a cached tools/list from before 1.12.0
  does not know `voice_confirm`. The guarded tools are marked `changed:
  1.12.0` so the `start_session` delta (docs/tool-surface-check.md) reports a
  refresh is needed.
