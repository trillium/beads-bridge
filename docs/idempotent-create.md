# Idempotent, revision-aware bead creation

The same logical request must never become two beads.

## The incident this exists for

A Mac mini provisioning request (`errors-5uf`) arrived twice over ChatGPT's
at-least-once delivery and was handled as two separate beads —
`inbox-zmj0` and `inbox-sx6k` — costing a duplicate triage pass. Nothing was
wrong with the caller: it could not know the first attempt had landed.

**The tolerance is ours, not the caller's.** Nothing in this path asks
ChatGPT to delay execution, deduplicate, or retry carefully. A caller that
replays blindly is the normal case, not a misuse to be policed.

## The field

`bead_create` accepts an optional **`operation_id`** (1–200 chars): a
*client-generated logical id for one intended action*.

```json
{"tool": "bead_create",
 "arguments": {"store": "task",
               "title": "Provision mac mini for the fleet runner",
               "description": "Install tailscale and register it.",
               "operation_id": "mac-mini-provision-2026-10-05"}}
```

Reuse the **same** `operation_id` for:

- a retry of a call whose response was lost,
- a network/proxy replay of the identical request,
- a second runtime or model executing the same request,
- a continuation turn of a voice request that adds scope.

Change it for a genuinely different request.

Callers that supply **no** `operation_id` get the implicit-intent behaviour
described under [Implicit intents](#implicit-intents-no-operation_id) below:
distinct requests still make distinct beads, but an overlapping or retried
same-title request converges on one bead.

## How the key works

The bridge derives a deterministic, label-safe key from
`(store, operation_id)`:

```
opkey:<first 12 hex of sha256(store + NUL + operation_id)>
```

and stamps it on the bead as a label. Consequences, all deliberate:

- **The bead id stays server-generated and unguessable.** No `--id` forging.
- **The raw client id never lands in a label**, so it cannot leak a
  bearer-shaped value into a queryable field.
- **The key is scoped by store**: the same client id against two stores is
  two independent operations.
- The key **leads** the label list, so the 10-label cap can never drop it —
  without it, a duplicate submission would not find its bead.

Lookup is a plain label query (`bd list --label opkey:<key> --all --json`),
so idempotency survives a bridge restart: the state lives in the store, not
in the server's memory.

## Reconciliation, stated explicitly

When a submission arrives carrying an operation key that a bead already
holds, **no second bead is created**. Instead:

| Aspect | Policy | Why |
|---|---|---|
| **Title** | The later submission is **authoritative** — it replaces the old title. | Titles are short and always re-stated whole; the latest phrasing is the accurate one. |
| **Body** | **Additive merge.** New text is appended under a visible `[bb-rev N · opkey:…]` marker. Text never shrinks. **Exception:** if the later body *supersets* the earlier one (the caller re-sent the accumulated text plus more), the merge collapses to the later body — authoritative without being asked. | A paused voice turn typically resumes with *only the newly spoken scope*. A replacing write would silently drop what was already captured. |
| **Labels** | **Additive union.** A revision can add scope, never retract it. | Retraction by a partial re-statement is a data-loss bug, not a refinement. |
| **Materially distinct added scope** | **Promoted to a child bead** — but only when the caller passes **`promote: true`**. The child carries its own key `opkey:<parent key>.r<seq>` (so a replayed promotion finds the child instead of forking a second one) and deliberately does **not** carry the parent key — otherwise the next submission would treat the child as a duplicate of the operation and close it. `bd create --parent` *inherits the parent's labels*, so the parent key is explicitly stripped from the child right after it is created; every other inherited label (`project:`, `resume:`, …) is left alone. (Found by the promotion test: without the strip, the child matched the parent key and the operation resolved to two beads.) | An automatic similarity heuristic would re-create the very duplicate-bead failure this path exists to prevent, in a new dress. Explicit opt-in keeps "one logical action = one bead" unconditional. |

Two more rules that hold regardless of the above:

- **Every submission of one operation runs under a per-operation lock**
  (keyed mutex over the whole lookup→write sequence), so two concurrent
  submissions cannot both observe "no bead yet" and both create.
- **Cross-process race:** if two beads somehow carry the same key, the
  canonical one is the **earliest `created_at`, ties broken by
  lexicographic id** — a total, clock-independent rule every process agrees
  on. The loser is *closed* with a `[bb-dup]` note naming the canonical
  bead: closed, never deleted, so the race stays auditable.

## Durable revision history

Each accepted submission appends **one note** to the bead:

```
[bb-rev] seq=2 hash=3f9a1c2b8d7e6f50 mode=revision op=opkey:1a2b3c4d5e6f at=2026-10-05T19:20:19Z
{"title":"Provision mac mini","description":"and install tailscale on it", …}
```

Notes are the durable substrate: no side table to lose, readable with the
ordinary bead read path (`bead_show`). The payload records what was
submitted, so a revision is readable without re-deriving anything.

**Ordering rule: the monotonic per-operation SEQUENCE NUMBER. The content
hash identifies which revision a submission is, and is the tiebreak.**

- `seq` is assigned at write time while holding the operation lock, as
  `max(existing seq) + 1`, derived from *durable history* — a restarted
  process continues the same numbering.
- `at` (arrival wall-clock) is recorded for humans but **never** orders
  anything: two retries inside one clock tick would tie, and a replayed
  request would move history around.
- **Every delivery consumes exactly one sequence number**, so the history is
  a total, replay-invariant record of what was submitted. That is why the
  incident's two submissions are *two* revisions rather than one plus
  silence: "this arrived twice" is information an operator wants later.
- Readers order by `(seq, hash)`: `seq` is unique per operation and `hash`
  breaks any hypothetical tie, so the order is total and replay-invariant.

## Replays: recorded, but they do not rewrite the bead

A delivery whose content hash equals the last recorded revision is recorded
with mode **`duplicate`**: the history note is appended (the delivery
happened) and **nothing is written** to the bead's title, body, or labels.
So a retry storm of five identical requests produces one bead whose body
still says the request once, with five readable revisions.

## Parent

`parent` is fixed at creation. A revision that supplies a different parent
has it recorded in history but does not re-parent the bead: hierarchy is
structure, and silently re-parenting an existing action would move work
under someone else's subtree. Use `promote: true` to add scope as a child.

## Reading the history back

```ts
import { readRevisionHistory } from './lib/idempotent-create'
const revs = await readRevisionHistory('task', 'task-abc12')
// [{seq, hash, mode, at, operationKey, payload}, …] ordered by (seq, hash)
```

`readRevisionHistory` reads the JSON projection first and falls back to a
text scan, so history survives whatever shape the CLI's `show` takes.

## What the caller sees

The receipt states the disposition, so a caller that re-submits can see it
did **not** get a new bead:

```
# revision of existing bead task-abc12 (STORE: task)

Verified: yes — bead reads back

Idempotency: opkey:1a2b3c4d5e6f — operation opkey:1a2b3c4d5e6f already
exists — revision 2 recorded on the existing bead, no duplicate created
Reconciled: body merged additively; labels added: urgent
```

Dispositions: `created`, `revision` (something was reconciled), `duplicate`
(identical replay — recorded, bead unchanged), `promoted` (added scope became
a child bead).

## Implicit intents (no `operation_id`)

### The second incident (2026-10-17)

One user request produced **two** beads titled *Verify localStorage support
and persistence in Tesla browser* — `task-i6nzy` and `task-p4pu8`, created
**3 seconds apart** (06:49:54Z / 06:49:57Z) by the same caller
(`by:loopback-local`, `source:mcp`). The user sent a command, then added
information while the first agent turn was still running; both turns called
`bead_create` with the same title and **different bodies** (709 vs 1205
chars) and **no `operation_id`**.

**Why the existing detection missed it.**

1. The only protection for id-less creates was `ckey:` (`createKey` in
   `create.ts`), a hash of store + title + **body** + labels + parent. A
   follow-up that *adds information* has a different body, so it always hashed
   differently (`ckey:de81aa3be6da4543` vs `ckey:f9d6251af40dea9a`) — the
   key was built to recognise a byte-identical *retry*, never a continuation.
2. `ckey` is lookup-then-create with no process-level lock: two overlapping
   calls both ran the lookup before either create finished, so even
   *identical* concurrent calls both created.
3. `opkey:` (above) needs the caller to volunteer an `operation_id`; neither
   turn did, and the tool cannot make a caller do so.

`src/lib/intent.test.ts` ("baseline: why the old ckey path made two beads")
reproduces both failures against `createBead`.

### The rule

`src/lib/intent.ts`. A create without `operation_id` is a **follow-up of the
same intent**, and is merged onto the existing bead instead of creating a new
one, only when **all** of these hold:

| Condition | Why |
|---|---|
| same store, same caller (`by:`), same normalized title, same `parent` | the intent key `ikey:<12 hex>` = hash of these — deliberately **not** the body |
| the earlier bead is still **open** | a closed bead is finished work; the same words again are a new task |
| the earlier bead is younger than the window (**2 min**, `BEADS_BRIDGE_INTENT_WINDOW_MS`) | a follow-up arrives while the turn is running or just after; the same title next week is a new task |
| the bodies are **related**: either is empty, one contains the other, or they share ≥ 40 % of the smaller body's significant words (> 3 letters) | same title with an unrelated body is a different task (the two incident bodies share 55 %) |

Everything else stays a separate bead, and the caller can force it with
**`distinct: true`**. The title match alone never merges anything. The
relatedness gate is a conservative heuristic that only runs *inside* the
window and the other four conditions, so a wrong guess costs one merged
bead that `distinct: true` / `operation_id` avoids — it is not a general
similarity matcher.

A merge uses the same policy as `operation_id` revisions (title
authoritative, body additive, labels union) and appends a `[bb-rev]` note
with `op=ikey:…`.

### Mechanics

- **Per-intent lock** (`withOperationLock`): the second of two overlapping
  calls waits for the first to finish and register its bead, then converges
  on it — no lookup-then-create race inside a process.
- **Process registry** (`IntentRegistry`): remembers recent intents so the
  common case needs no store round trip. Accelerator only.
- **`ikey:` label** on every bead created here (leads the label list so the
  10-label cap cannot drop it): the store is the source of truth, so a bridge
  restart or a second process still finds the bead.
- **Retry after a timeout**: `createBead` already recovers a late-landing
  write by `ckey`; the retry then finds the landed bead by `ikey` and
  reconciles onto it.
- **Partial completion**: once the bead exists, a failing later step (revision
  note, edit, label) no longer fails the whole call. The result carries
  `incomplete`, the MCP tool returns `PARTIAL: bead <id> …` (an error, never a
  clean success) naming the safe retry, and repeating the call re-derives
  every step from the bead's current state — it converges on the same bead
  and completes what is missing, appending nothing twice.
- **Read-after-write**: a follow-up is only `verified` when the merged title
  and body read back on the bead afterwards.

Not covered: `bead_batch_create`, the relay's capture/upsert paths and
`bead_edit` repeated by hand do not go through this path.

## Tests

`src/lib/idempotency.test.ts` — pure algebra: key derivation, content
hashing, label merge, envelope round-trip, the ordering rule, lock
serialization.

`src/lib/intent.test.ts` — implicit intents against an in-memory fake store: the incident (overlapping and sequential), five concurrent identical creates, cold-registry lookup via `ikey`, retry after a committed/uncommitted timeout, partial completion (note/edit/label failures), and the distinct-tasks cases (unrelated body, beyond window, closed predecessor, other caller/parent, `distinct: true`). Also reproduces the old `ckey` path making two beads.

`src/lib/idempotency-live.test.ts` — real scratch store, real CLI:

| Failure mode | Test |
|---|---|
| The incident: one logical request submitted twice | ONE bead, TWO readable revisions |
| Duplicate retries | five identical retries → one bead, five recorded deliveries, no field rewritten |
| Voice turn pauses, continues with more scope | one bead, body merged, both scopes readable |
| Network replay | label-order-only difference → recorded as `duplicate`, bead body unchanged |
| Several runtime/model executions | five concurrent submissions → one bead, seqs 1..5 in order |
| Cross-process race | pre-existing bead wins as canonical |
| Distinct added scope | `promote: true` → child bead, promotion recorded |
| No logical id, different titles | two beads, no `opkey` |

## Not covered

- Cross-*host* simultaneous creates are reconciled by the canonical/collapse
  rule, not prevented by a distributed lock — there is no cross-process lock
  in this design, only the per-operation in-process mutex plus the
  post-hoc canonical collapse.
- `bead_batch_create` does not yet take `operation_id`; a replayed batch is
  still one batch's worth of beads.