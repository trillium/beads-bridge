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

Callers that supply **no** `operation_id` keep the previous behaviour
exactly: one call, one bead, no key, no lookup, no revision notes. That
compatibility floor is asserted in `idempotency-live.test.ts`.

## How the key works

The bridge derives a deterministic, label-safe key from
`(store, operation_id)`:

```
opkey:<first 12 hex of sha256(store + " " + operation_id)>
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
| **Materially distinct added scope** | **Promoted to a child bead** — but only when the caller passes **`promote: true`**. | An automatic similarity heuristic would re-create the very duplicate-bead failure this path exists to prevent, in a new dress. Explicit opt-in keeps "one logical action = one bead" unconditional. |

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

## Tests

`src/lib/idempotency.test.ts` — pure algebra: key derivation, content
hashing, label merge, envelope round-trip, the ordering rule, lock
serialization.

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
| No logical id | old behaviour: two beads, no key, no history |

## Not covered

- Cross-*host* simultaneous creates are reconciled by the canonical/collapse
  rule, not prevented by a distributed lock — there is no cross-process lock
  in this design, only the per-operation in-process mutex plus the
  post-hoc canonical collapse.
- `bead_batch_create` does not yet take `operation_id`; a replayed batch is
  still one batch's worth of beads.