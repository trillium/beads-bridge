// Implicit-intent create: one user request must not become two beads even
// when the caller never sent an `operation_id`.
//
// THE INCIDENT: a user sent a command, then added information while the
// first agent turn was still running. Both turns called `bead_create` with
// the same title and DIFFERENT bodies and no `operation_id` — 3 s apart,
// two beads (task-i6nzy / task-p4pu8, "Verify localStorage support and
// persistence in Tesla browser"). The older default key (`ckey:`, create.ts)
// hashes title + BODY, so a follow-up that adds information always hashes
// differently and is never recognised; and its lookup-then-create had no
// process-level lock, so two near-simultaneous creates both saw "nothing
// yet". See docs/idempotent-create.md "Implicit intents".
//
// THE RULE (deliberate; the full statement lives in the doc):
//   same store + same caller + same normalized title + same parent
//   + the earlier bead is still OPEN
//   + the earlier bead is younger than INTENT_WINDOW_MS
//   + the bodies are related (one empty, one contains the other, or enough
//     shared significant words)
//   => the later call is a follow-up of the SAME intent: it is reconciled
//      onto the canonical bead (title authoritative, body additive, labels
//      union — the same policy as operation_id revisions) instead of
//      creating a new one.
//   Anything else stays a separate bead: same title but an unrelated body,
//   a later call outside the window, a closed predecessor, another caller or
//   parent, or an explicit `distinct: true`.
//
// MECHANISM: an `ikey:<hash>` label (store+caller+title+parent, NOT the
// body) is stamped on every bead made here, so the lookup survives restarts
// and other processes; a process-level registry short-circuits the store
// round trip, and a per-intent lock makes the second of two overlapping
// calls wait for the first to finish and then converge on its bead.
import { createHash } from 'node:crypto'
import type { CreateInput } from './create'
import {
  contentHash,
  mergeBody,
  mergeLabels,
  nextSeq,
  renderRevision,
  withOperationLock,
  type Revision,
} from './idempotency'

export const INTENT_PREFIX = 'ikey:'
export const INTENT_HEX = 12
/** Default window in which a same-title follow-up is the same intent. */
export const DEFAULT_INTENT_WINDOW_MS = 2 * 60 * 1000
/** Shared-significant-word share (of the smaller body) that makes bodies "related". */
export const RELATED_OVERLAP = 0.4
const REGISTRY_MAX = 500

export function intentWindowMs(): number {
  const raw = Number(process.env.BEADS_BRIDGE_INTENT_WINDOW_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTENT_WINDOW_MS
}

// Case, punctuation and whitespace differences are not different titles.
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

// Store + caller + title + parent. Deliberately NOT the body: a follow-up
// that adds information must land on the same key (that is the incident).
export function intentKey(input: { store: string; caller?: string; title: string; parent?: string }): string {
  const digest = createHash('sha256')
    .update(
      [input.store.trim().toLowerCase(), (input.caller ?? '').trim().toLowerCase(), normalizeTitle(input.title), (input.parent ?? '').trim()].join('\u0000'),
    )
    .digest('hex')
  return `${INTENT_PREFIX}${digest.slice(0, INTENT_HEX)}`
}

const words = (s: string): Set<string> => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 3))

// Conservative "is this body a continuation of that one" gate. Only used
// INSIDE the window and the same title/caller/parent; it decides between
// "follow-up" and "second task that happens to share a title".
export function bodiesRelated(current: string, next: string): boolean {
  const a = current.trim()
  const b = next.trim()
  if (!a || !b) return true
  if (a.includes(b) || b.includes(a)) return true
  const wa = words(a)
  const wb = words(b)
  if (!wa.size || !wb.size) return false
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / Math.min(wa.size, wb.size) >= RELATED_OVERLAP
}

export interface IntentRow {
  id: string
  title?: string
  description?: string
  labels?: string[]
  created_at?: string
  status?: string
}

interface RegistryEntry {
  id: string
  store: string
  createdAt: number
}

// Process-level record of intents this process settled recently. Purely an
// accelerator: the store (ikey label) stays the source of truth, so losing
// the map on restart costs a lookup, never a duplicate.
export class IntentRegistry {
  private entries = new Map<string, RegistryEntry[]>()
  constructor(private now: () => number = () => Date.now()) {}

  record(key: string, store: string, id: string): void {
    const list = (this.entries.get(key) ?? []).filter((e) => e.id !== id)
    list.push({ id, store, createdAt: this.now() })
    this.entries.set(key, list)
    this.prune()
  }

  /** Newest first, inside the window. */
  recent(key: string, windowMs: number): RegistryEntry[] {
    this.prune()
    return [...(this.entries.get(key) ?? [])].filter((e) => this.now() - e.createdAt <= windowMs).reverse()
  }

  forget(key: string, id: string): void {
    const rest = (this.entries.get(key) ?? []).filter((e) => e.id !== id)
    if (rest.length) this.entries.set(key, rest)
    else this.entries.delete(key)
  }

  private prune(): void {
    const horizon = this.now() - Math.max(intentWindowMs(), 1) * 2
    for (const [k, list] of this.entries) {
      const keep = list.filter((e) => e.createdAt >= horizon)
      if (keep.length) this.entries.set(k, keep)
      else this.entries.delete(k)
    }
    while (this.entries.size > REGISTRY_MAX) this.entries.delete(this.entries.keys().next().value as string)
  }
}

export const intentRegistry = new IntentRegistry()

export interface IntentState {
  title: string
  description: string
  labels: string[]
  status?: string
}

export interface IntentDeps {
  create(input: CreateInput): Promise<{ id: string; detail: string; verified: boolean; recovered?: string }>
  /** Beads carrying a label, open and closed. */
  findByLabel(store: string, label: string): Promise<IntentRow[]>
  /** Empty title = unreadable. */
  readState(store: string, id: string): Promise<IntentState>
  history(store: string, id: string): Promise<Revision[]>
  edit(store: string, id: string, patch: { title?: string; description?: string }): Promise<void>
  addLabels(store: string, id: string, labels: string[]): Promise<void>
  /** Durable revision note; resolves true only when it read back. */
  note(store: string, id: string, text: string): Promise<boolean>
  /** Bead `show` text, or null when it does not read back. */
  verify(store: string, id: string): Promise<string | null>
  now(): number
}

export interface IntentInput extends CreateInput {
  /** Force a separate bead even when a recent same-title bead exists. */
  distinct?: boolean
}

export type IntentDisposition = 'created' | 'revision' | 'duplicate'

export interface IntentResult {
  id: string
  store: string
  disposition: IntentDisposition
  revision: number
  intentKey: string
  applied: string[]
  /** Steps that failed AFTER the bead existed; retrying the same call converges. */
  incomplete: string[]
  verified: boolean
  detail: string
  recovered?: string
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200)

async function findCandidate(
  input: IntentInput,
  key: string,
  deps: IntentDeps,
  registry: IntentRegistry,
): Promise<{ id: string; state: IntentState } | null> {
  const windowMs = intentWindowMs()
  const body = input.description ?? ''
  const usable = (s: IntentState) => s.title !== '' && (s.status ?? 'open') !== 'closed' && bodiesRelated(s.description, body)

  for (const entry of registry.recent(key, windowMs)) {
    if (entry.store !== input.store) continue
    const state = await deps.readState(input.store, entry.id)
    if (usable(state)) return { id: entry.id, state }
    // Closed, gone or unrelated: this entry is no longer a candidate.
    registry.forget(key, entry.id)
  }

  const rows = await deps.findByLabel(input.store, key).catch(() => [] as IntentRow[])
  const fresh = rows
    .filter((r) => (r.status ?? 'open') !== 'closed')
    .filter((r) => {
      const t = Date.parse(r.created_at ?? '')
      return !t || deps.now() - t <= windowMs
    })
    // Newest first: the intent being continued is the most recent one.
    .sort((a, b) => (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0) || b.id.localeCompare(a.id))
  for (const r of fresh) {
    const state: IntentState = {
      title: r.title ?? '',
      description: r.description ?? '',
      labels: r.labels ?? [],
      status: r.status,
    }
    if (usable(state)) return { id: r.id, state }
  }
  return null
}

export async function createIntentBead(
  input: IntentInput,
  deps: IntentDeps,
  registry: IntentRegistry = intentRegistry,
): Promise<IntentResult> {
  const caller = input.provenance?.caller
  const key = intentKey({ store: input.store, caller, title: input.title, parent: input.parent })
  // Overlapping turns of one intent queue here: the second waits for the
  // first to finish (and register its bead), then converges on it.
  return withOperationLock(`intent ${input.store} ${key}`, async () => {
    const candidate = input.distinct ? null : await findCandidate(input, key, deps, registry)
    return candidate ? followUp(input, key, candidate, deps) : first(input, key, deps, registry)
  })
}

function revision(seq: number, mode: Revision['mode'], key: string, input: IntentInput, applied: string[], now: number): Revision {
  return {
    seq,
    hash: contentHash({ title: input.title, description: input.description, labels: input.labels, parent: input.parent }),
    mode,
    at: new Date(now).toISOString(),
    operationKey: key,
    payload: {
      title: input.title,
      description: input.description,
      labels: input.labels,
      ...(input.parent ? { parent: input.parent } : {}),
      applied,
    },
  }
}

async function first(input: IntentInput, key: string, deps: IntentDeps, registry: IntentRegistry): Promise<IntentResult> {
  // The key leads so provenance + the label cap can never drop it.
  const created = await deps.create({ ...input, labels: [key, ...(input.labels ?? []).filter((l) => l !== key)] })
  // From here the bead EXISTS: a failure below is partial completion, not a
  // failed create. Register first so the very next overlapping call converges.
  registry.record(key, input.store, created.id)
  const incomplete: string[] = []
  const recorded = await deps.note(input.store, created.id, renderRevision(revision(1, 'create', key, input, ['created'], deps.now()))).catch(() => false)
  if (!recorded) incomplete.push(`revision 1 note not recorded on ${created.id}`)
  return {
    id: created.id,
    store: input.store,
    disposition: 'created',
    revision: 1,
    intentKey: key,
    applied: recorded ? ['created', 'revision 1 recorded'] : ['created'],
    incomplete,
    verified: created.verified,
    detail: created.detail,
    ...(created.recovered ? { recovered: created.recovered } : {}),
  }
}

async function followUp(
  input: IntentInput,
  key: string,
  candidate: { id: string; state: IntentState },
  deps: IntentDeps,
): Promise<IntentResult> {
  const { id, state } = candidate
  const history = await deps.history(input.store, id).catch(() => [] as Revision[])
  const seq = nextSeq(history)
  const applied: string[] = []
  const incomplete: string[] = []

  const nextTitle = input.title.trim().slice(0, 200)
  const titleChanged = Boolean(nextTitle) && nextTitle !== state.title.trim()
  const body = mergeBody(state.description, input.description ?? '', seq, key)
  const bodyChanged = body !== state.description
  const toAdd = mergeLabels(state.labels, input.labels ?? []).filter((l) => !state.labels.includes(l))
  const changed = titleChanged || bodyChanged || toAdd.length > 0

  // Each step is independent and re-derived from the bead's current state on
  // the next attempt, so a failure in one never strands the others and a
  // retry converges instead of duplicating.
  if (titleChanged || bodyChanged) {
    try {
      await deps.edit(input.store, id, { ...(titleChanged ? { title: nextTitle } : {}), ...(bodyChanged ? { description: body } : {}) })
      if (titleChanged) applied.push(`title superseded by revision ${seq}`)
      if (bodyChanged) applied.push('body merged additively')
    } catch (e) {
      incomplete.push(`edit of ${id} failed: ${errText(e)}`)
    }
  } else {
    applied.push('no field-level change (submission adds nothing new)')
  }
  if (toAdd.length) {
    try {
      await deps.addLabels(input.store, id, toAdd)
      applied.push(`labels added: ${toAdd.join(', ')}`)
    } catch (e) {
      incomplete.push(`labels ${toAdd.join(', ')} not added to ${id}: ${errText(e)}`)
    }
  }
  const recorded = await deps.note(input.store, id, renderRevision(revision(seq, changed ? 'revision' : 'duplicate', key, input, [...applied], deps.now()))).catch(() => false)
  if (!recorded) incomplete.push(`revision ${seq} note not recorded on ${id}`)

  // Read-after-write: the follow-up's information must be on the bead now.
  const after = await deps.readState(input.store, id)
  const addedBody = (input.description ?? '').trim()
  const landed =
    after.title !== '' &&
    (!bodyChanged || after.description.includes(addedBody) || after.description === body) &&
    (!titleChanged || after.title.trim() === nextTitle)
  const detail = (await deps.verify(input.store, id)) ?? 'unreadable after revision'
  return {
    id,
    store: input.store,
    disposition: changed ? 'revision' : 'duplicate',
    revision: seq,
    intentKey: key,
    applied,
    incomplete,
    verified: landed && detail !== 'unreadable after revision',
    detail,
  }
}

export function formatIntentReconciliation(r: IntentResult): string {
  const why =
    r.disposition === 'created'
      ? 'new intent — bead created'
      : r.disposition === 'revision'
        ? `same intent as ${r.id} (same caller, title and parent, still open, inside the follow-up window) — revision ${r.revision} merged onto it, no duplicate created`
        : `same intent as ${r.id} and nothing new to add — delivery recorded as revision ${r.revision}, bead unchanged`
  return [
    `Intent: ${r.intentKey} — ${why}`,
    r.applied.length ? `Reconciled: ${r.applied.join('; ')}` : 'Reconciled: nothing to change',
    ...(r.incomplete.length ? [`INCOMPLETE: ${r.incomplete.join('; ')} — the bead exists; repeating this exact call completes the missing steps without a duplicate`] : []),
    ...(r.disposition === 'created' ? [] : ['If this was a genuinely separate task, repeat the call with distinct: true.']),
  ].join('\n')
}
