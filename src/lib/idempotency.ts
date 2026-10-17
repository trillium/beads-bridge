// Idempotent, revision-aware create (beads-bridge).
//
// THE INCIDENT THIS EXISTS FOR: the same logical request (a Mac mini
// provisioning ask) arrived twice over ChatGPT's at-least-once delivery and
// was handled as two separate beads — a duplicate triage pass (errors-5uf,
// inbox-zmj0 + inbox-sx6k). Nothing about that was ChatGPT's fault: the
// caller cannot delay, deduplicate, or retry carefully, and is not asked to.
// The tolerance lives here, on our side of the boundary.
//
// HOW IT WORKS, in one paragraph: a create may carry a client-generated
// logical operation id (`operation_id`). The bridge derives a stable,
// label-safe KEY from (store, operation id) and stamps it on the bead as
// `opkey:<12 hex>`. Every later submission carrying the same operation id
// looks the key up first: a hit means "this is a revision of one intended
// action", so no second bead is created — the submission is reconciled onto
// the existing bead and recorded as a durable revision note instead.
//
// IDENTITY vs IDEMPOTENCY KEY: the bead id stays server-generated and
// unguessable (parseCreatedId, no `--id` forging). The operation key is a
// content-addressed digest of the CLIENT's identifier — never the raw value,
// so a client id never lands in a label and cannot leak a bearer-shaped
// string into a queryable field.
//
// REVISION HISTORY: each accepted submission appends ONE note to the bead
// carrying a `[bb-rev]` envelope (seq, content hash, mode, submission
// payload). Notes are durable, append-only, and readable with the ordinary
// bead read path — no side table to lose.
//
// ORDERING RULE (deterministic under retry): revisions are ordered by their
// MONOTONIC PER-OPERATION SEQUENCE NUMBER, assigned at write time while
// holding the operation lock. Every delivery of a logical operation consumes
// exactly one sequence number, so the history is a total, replay-invariant
// record of what was submitted — the content hash identifies WHICH revision
// a submission is (and marks a byte-identical replay as mode `duplicate`,
// which changes no field), and breaks any tie. Arrival wall-clock is
// recorded for humans but is NEVER used to order revisions: two retries
// inside one clock tick would tie, and a replay must not reorder history.
import { createHash } from 'node:crypto'

export const OPKEY_PREFIX = 'opkey:'
export const REVISION_MARKER = '[bb-rev]'
/** Content-hash hex length in an envelope; the full digest is never stored. */
export const HASH_HEX = 16
/** Operation-key hex length. 48 bits — collision only across 2^24 keys. */
export const OPKEY_HEX = 12
export const MAX_OPERATION_ID_CHARS = 200

export type RevisionMode = 'create' | 'revision' | 'duplicate' | 'child'

export interface RevisionPayload {
  title?: string
  description?: string
  labels?: string[]
  parent?: string
  /** Reconciliation actions actually taken for this revision. */
  applied?: string[]
  /** Id of a bead promoted out of this revision (child mode). */
  child?: string
}

export interface Revision {
  seq: number
  hash: string
  mode: RevisionMode
  /** ISO-8601 arrival stamp — informational only, never an ordering key. */
  at?: string
  operationKey: string
  payload: RevisionPayload
}

// Client operation id → canonical form, or null when there is nothing to
// key on. Callers supplying nothing keep the pre-existing single-create
// behaviour exactly (no key, no lookup, no revision history).
export function normalizeOperationId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  return t.slice(0, MAX_OPERATION_ID_CHARS)
}

// Deterministic per-store key for a logical operation. Scoped by store so
// the same client id used against two stores is two independent operations,
// and so a leaked key from one store cannot probe another.
export function operationKey(store: string, operationId: string): string {
  const digest = createHash('sha256')
    .update(`${store.trim().toLowerCase()}\u0000${operationId}`)
    .digest('hex')
  return `${OPKEY_PREFIX}${digest.slice(0, OPKEY_HEX)}`
}

// The key of the promoted child for a given revision sequence. Child
// promotion is itself idempotent: a retry that recomputes the same sequence
// finds the child by this label instead of creating a second one.
export function childOperationKey(opKey: string, seq: number): string {
  return `${opKey}.r${seq}`
}

// Content hash of a submission: what makes two submissions "the same
// submission". Order-insensitive over labels, whitespace-normalized over
// the title, verbatim over the body (a byte-different body is a different
// revision — never silently equated).
export function contentHash(input: {
  title?: string
  description?: string
  labels?: string[]
  parent?: string
}): string {
  const payload = {
    title: (input.title ?? '').trim().replace(/\s+/g, ' '),
    description: input.description ?? '',
    labels: [...new Set((input.labels ?? []).map((l) => l.trim()).filter(Boolean))].sort(),
    parent: (input.parent ?? '').trim(),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, HASH_HEX)
}

// The opkey label leads the caller's labels so the MAX_LABELS cap can never
// drop the idempotency key — without it a duplicate submission would not
// find its bead. Callers passing 9-10 labels may lose a tail label; state
// that in the schema description.
export function withOperationKey(labels: string[], opKey?: string): string[] {
  if (!opKey) return labels
  return [opKey, ...labels.filter((l) => l !== opKey)]
}

// Union merge, caller order preserved, existing entries never dropped and
// never reordered. Additive by contract: a later revision can ADD scope to
// the label set, never retract it.
export function mergeLabels(current: string[], incoming: string[]): string[] {
  const out = [...current]
  const seen = new Set(out)
  for (const l of incoming) {
    if (l && !seen.has(l)) {
      seen.add(l)
      out.push(l)
    }
  }
  return out
}

// What a later submission adds that the current bead does not already say.
// Additive scope = labels it contributes plus body text not already
// present. Used to decide whether a revision has anything to merge at all.
export function addedScope(
  current: { description?: string; labels?: string[] },
  next: { description?: string; labels?: string[] },
): { labels: string[]; hasNewBody: boolean } {
  const have = new Set(current.labels ?? [])
  const labels = [...new Set((next.labels ?? []).map((l) => l.trim()).filter(Boolean))].filter((l) => !have.has(l))
  const curBody = (current.description ?? '').trim()
  const nextBody = (next.description ?? '').trim()
  // "Added" means the body carries text the bead does not already contain.
  // A resubmission of a prefix, or of the identical body, adds nothing.
  const hasNewBody = nextBody.length > 0 && !curBody.includes(nextBody)
  return { labels, hasNewBody }
}

// Additive body merge (policy above): identical/contained text changes
// nothing, a superseding body wins wholesale, anything else is appended
// under a visible revision marker so the bead still reads as one document.
export function mergeBody(current: string, next: string, rev: number, opKey: string): string {
  const cur = current.trim()
  const add = next.trim()
  if (!add) return current
  if (cur.includes(add)) return current
  if (cur && add.includes(cur)) return add
  const marker = `[bb-rev ${rev} · ${opKey}]`
  return cur ? `${cur}\n\n${marker}\n${add}` : add
}

// `[bb-rev] envelope + payload. One line of machine-readable header, then
// the submission payload verbatim so the revision is readable after the fact
// without re-deriving anything.
export function renderRevision(rev: Revision): string {
  const head = [
    REVISION_MARKER,
    `seq=${rev.seq}`,
    `hash=${rev.hash}`,
    `mode=${rev.mode}`,
    `op=${rev.operationKey}`,
    ...(rev.at ? [`at=${rev.at}`] : []),
  ].join(' ')
  return `${head}\n${JSON.stringify(rev.payload)}`
}

const REV_RE = new RegExp(
  `${REVISION_MARKER.replace(/[[\]]/g, '\\$&')} seq=(\\d+) hash=([0-9a-f]+) mode=([a-z-]+) op=(\\S+)(?: at=(\\S+))?\\n(\\{.*\\})`,
  'g',
)

// Parse every `[bb-rev]` envelope out of a notes blob (plain text or the
// JSON show output — both are scanned, JSON escapes included). Unparseable
// text yields nothing rather than throwing: history reading degrades to
// "no revisions", never to an error on a bead with unrelated notes.
export function parseRevisions(text: string): Revision[] {
  if (!text) return []
  const out: Revision[] = []
  for (const m of text.matchAll(REV_RE)) {
    let payload: RevisionPayload = {}
    try {
      const parsed: unknown = JSON.parse(m[6])
      if (parsed && typeof parsed === 'object') payload = parsed as RevisionPayload
    } catch {
      payload = {}
    }
    out.push({
      seq: Number(m[1]),
      hash: m[2],
      mode: m[3] as RevisionMode,
      operationKey: m[4],
      at: m[5],
      payload,
    })
  }
  return out
}

// Total, replay-invariant order: sequence number first (unique per
// operation), content hash as the tiebreak. Never arrival time.
export function orderRevisions(revs: Revision[]): Revision[] {
  return [...revs].sort((a, b) => (a.seq - b.seq) || a.hash.localeCompare(b.hash))
}

// Next sequence number for an operation: one past the highest already
// recorded. Derived from durable history, not from an in-memory counter, so
// a restarted process continues the same numbering.
export function nextSeq(revs: Revision[]): number {
  return revs.reduce((max, r) => (r.seq > max ? r.seq : max), 0) + 1
}

// Per-operation serialization. Two submissions of ONE logical operation
// must not interleave between "look the key up" and "write the revision" —
// that race is exactly how a duplicate bead appears. Keyed mutex, released
// on both resolve and reject; unrelated operations never block each other.
const locks = new Map<string, Promise<unknown>>()

export async function withOperationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve()
  // A rejection in the prior holder must not poison the queue: the next
  // caller runs regardless of how the previous one ended.
  const run = prior.then(
    () => fn(),
    () => fn(),
  )
  const settled = run.then(
    () => {},
    () => {},
  )
  locks.set(key, settled)
  try {
    return await run
  } finally {
    // Only the last holder clears the entry, so the map cannot grow without
    // bound across a long-lived server.
    if (locks.get(key) === settled) locks.delete(key)
  }
}

// Human receipt line for the reconciliation that actually happened. Callers
// get told which bead they are looking at and WHY it is not a new bead —
// silence would leave the caller guessing whether its second submission
// created a duplicate.
export function formatReconciliation(r: {
  disposition: 'created' | 'revision' | 'duplicate' | 'promoted'
  id: string
  operationKey: string
  revision: number
  applied: string[]
  childId?: string
}): string {
  const why: Record<typeof r.disposition, string> = {
    created: 'new logical operation — bead created',
    revision: `operation ${r.operationKey} already exists — revision ${r.revision} recorded on the existing bead, no duplicate created`,
    duplicate: `operation ${r.operationKey} already exists and this submission is identical to the last recorded revision — bead left unchanged, delivery recorded`,
    promoted: `operation ${r.operationKey} already exists — added scope promoted to child bead, revision ${r.revision} recorded`,
  }
  const lines = [
    `Idempotency: ${r.operationKey} — ${why[r.disposition]}`,
    r.applied.length ? `Reconciled: ${r.applied.join('; ')}` : 'Reconciled: nothing to change',
    ...(r.childId ? [`Promoted child: ${r.childId}`] : []),
  ]
  return lines.join('\n')
}