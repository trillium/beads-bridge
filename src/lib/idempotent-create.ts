// Store-facing idempotent create: the seam between the pure revision algebra
// (idempotency.ts) and the real bead store.
//
// Contract, in the order the code enforces it:
//
//   1. NO LOGICAL ID -> unchanged pre-existing single-create behaviour. No
//      key, no lookup, no revision note. Callers that never heard of
//      `operation_id` are unaffected (this is the compatibility floor).
//   2. LOGICAL ID, no bead carrying the key yet -> create once, stamp
//      `opkey:<hash>`, record revision 1.
//   3. LOGICAL ID, bead exists -> NEVER create. Reconcile onto the canonical
//      bead and record a revision note.
//
// Reconciliation policy (deliberate, not implied):
//   - TITLE: the later submission is authoritative. A re-stated title
//     replaces the old one; titles are short and always re-sent whole.
//   - BODY: additive by default. ChatGPT's continuation turn typically
//     carries only the NEWLY spoken scope, so a replacing write would
//     silently drop what was already captured. When the later body
//     SUPERSETS the earlier one (caller re-sent the accumulated text plus
//     more) the merge collapses to the later body — authoritative without
//     being asked. Body text never shrinks.
//   - LABELS: additive union. A revision can add scope to a bead's label
//     set, never retract it.
//   - MATERIALLY DISTINCT ADDED SCOPE: promoted to a CHILD bead, but only
//     when the caller says so (`promote: true`). Automatic promotion on a
//     similarity heuristic would re-create the very duplicate-bead failure
//     this path exists to prevent, in a new dress. Explicit opt-in keeps
//     the "one logical action = one bead" invariant unconditional.
//
// Concurrency: the whole sequence runs under the per-operation lock, so two
// concurrent submissions of ONE operation cannot both observe "no bead yet"
// and both create. Ordering of revisions is (sequence number, content hash)
// — see idempotency.ts.
import { execStdout } from './exec'
import { createBead, type CreateInput } from './create'
import { editBead } from './edit'
import { closeBead, labelBead, noteBead } from './mutate'
import { verifyBead } from './mutate'
import {
  childOperationKey,
  contentHash,
  formatReconciliation,
  mergeLabels,
  nextSeq,
  normalizeOperationId,
  operationKey,
  orderRevisions,
  parseRevisions,
  renderRevision,
  withOperationKey,
  withOperationLock,
  type Revision,
} from './idempotency'

export interface OperationCreateInput extends CreateInput {
  /** Client-generated logical operation/request id. Same id = one action. */
  operationId?: string
  /** Caller declares the added scope materially distinct -> child bead. */
  promote?: boolean
}

export type Disposition = 'created' | 'revision' | 'duplicate' | 'promoted'

export interface OperationCreateResult {
  id: string
  store: string
  disposition: Disposition
  /** Revision number recorded (0 when no logical id was supplied). */
  revision: number
  operationKey: string
  applied: string[]
  childId?: string
  verified: boolean
  detail: string
  /** Beads closed as duplicates of the canonical one (cross-process race). */
  collapsed?: string[]
}

interface StoreRow {
  id: string
  title?: string
  description?: string
  labels?: string[]
  created_at?: string
}

const LIST_TIMEOUT = 20000
const SHOW_TIMEOUT = 15000

// Beads carrying this operation key. The key is a sha256 digest, so an
// existing hit is the SAME logical action, not a similar one.
export async function findByOperationKey(store: string, key: string): Promise<StoreRow[]> {
  const out = await execStdout(store, ['list', '--all', '--json', '--limit', '100', '--label', key], LIST_TIMEOUT).catch(() => '[]')
  try {
    const rows: unknown = JSON.parse(out || '[]')
    return (Array.isArray(rows) ? rows : [])
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map((r) => ({
        id: String(r.id ?? ''),
        title: typeof r.title === 'string' ? r.title : undefined,
        description: typeof r.description === 'string' ? r.description : undefined,
        labels: Array.isArray(r.labels) ? r.labels.map(String) : [],
        created_at: typeof r.created_at === 'string' ? r.created_at : undefined,
      }))
      .filter((r) => r.id)
  } catch {
    return []
  }
}

// Canonical bead for an operation: earliest created_at, ties broken by
// lexicographic id. Total and clock-independent, so a cross-process race
// that slipped two beads past the lock still resolves to ONE winner that
// every process agrees on.
export function canonicalOf(rows: StoreRow[]): StoreRow {
  return [...rows].sort((a, b) => {
    const at = Date.parse(a.created_at ?? '') || 0
    const bt = Date.parse(b.created_at ?? '') || 0
    return (at - bt) || a.id.localeCompare(b.id)
  })[0]
}

function notesFromShow(stdout: string): string {
  try {
    const parsed: unknown = JSON.parse(stdout || 'null')
    const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null
    if (obj && typeof obj === 'object') {
      const parts: string[] = []
      for (const field of ['notes', 'comments']) {
        const v = obj[field]
        if (typeof v === 'string') parts.push(v)
        else if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === 'string') parts.push(item)
            else if (item && typeof item === 'object') {
              const body = (item as Record<string, unknown>).body ?? (item as Record<string, unknown>).text
              if (typeof body === 'string') parts.push(body)
            }
          }
        }
      }
      if (parts.length) return parts.join('\n')
    }
  } catch {
    // not JSON — fall through to the text scan
  }
  return stdout || ''
}

// Durable revision history for a bead, ordered by (seq, hash). Reads the
// JSON projection first (notes arrive properly unescaped there) and falls
// back to scanning plain text, so a bead whose notes live outside the JSON
// projection still reports its history.
export async function readRevisionHistory(store: string, id: string): Promise<Revision[]> {
  const json = await execStdout(store, ['show', id, '--json'], SHOW_TIMEOUT).catch(() => null)
  if (json) {
    const parsed = parseRevisions(notesFromShow(json))
    if (parsed.length) return orderRevisions(parsed)
  }
  const text = await execStdout(store, ['show', id], SHOW_TIMEOUT).catch(() => '')
  return orderRevisions(parseRevisions(text))
}

export interface BeadState {
  title: string
  description: string
  labels: string[]
}

export async function readBeadState(store: string, id: string): Promise<BeadState> {
  const empty: BeadState = { title: '', description: '', labels: [] }
  const out = await execStdout(store, ['show', id, '--json'], SHOW_TIMEOUT).catch(() => null)
  if (!out) return empty
  try {
    const parsed: unknown = JSON.parse(out || 'null')
    const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null
    if (!obj || typeof obj !== 'object') return empty
    return {
      title: typeof obj.title === 'string' ? obj.title : '',
      description: typeof obj.description === 'string' ? obj.description : '',
      labels: Array.isArray(obj.labels) ? obj.labels.map(String) : [],
    }
  } catch {
    return empty
  }
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

async function recordRevision(
  store: string,
  id: string,
  rev: Revision,
): Promise<boolean> {
  const r = await noteBead(store, id, renderRevision(clipPayload(rev))).catch(() => null)
  return r?.verified === true
}

// Revision notes are durable history, not the body of record — the bead's
// own description stays the merged document. Past this size the note keeps
// the head of the payload and says so; the content hash still identifies the
// exact submission, and the bead holds the merged text in full.
export const MAX_REVISION_NOTE_CHARS = 20000

function clipPayload(rev: Revision): Revision {
  const d = rev.payload.description
  if (!d || d.length <= MAX_REVISION_NOTE_CHARS) return rev
  return {
    ...rev,
    payload: {
      ...rev.payload,
      description: `${d.slice(0, MAX_REVISION_NOTE_CHARS)}\n[bb-rev truncated payload: ${d.length} chars, full hash ${rev.hash}]`,
    },
  }
}

// Close a bead that lost a cross-process race for the same operation key.
// Closing (not deleting) keeps the losing bead auditable, and the note says
// which bead is canonical, so a human reading the store sees why.
async function collapseDuplicate(store: string, loser: string, canonicalId: string, opKey: string): Promise<void> {
  await noteBead(store, loser, `[bb-dup] operation ${opKey} is carried by canonical bead ${canonicalId}; this bead is a duplicate of the same logical action and was closed, not deleted.`).catch(() => null)
  await closeBead(store, loser).catch(() => null)
}

export async function createOperationBead(input: OperationCreateInput): Promise<OperationCreateResult> {
  const store = input.store
  const opId = normalizeOperationId(input.operationId)

  // Floor: no logical id -> exactly the pre-existing create behaviour.
  if (!opId) {
    const created = await createBead(input)
    return {
      id: created.id,
      store,
      disposition: 'created',
      revision: 0,
      operationKey: '',
      applied: ['created (no logical operation id — single-create behaviour)'],
      verified: created.verified,
      detail: created.detail,
    }
  }

  const opKey = operationKey(store, opId)
  return withOperationLock(`${store} ${opKey}`, () => runOperation(input, opKey, opId))
}

async function runOperation(input: OperationCreateInput, opKey: string, opId: string): Promise<OperationCreateResult> {
  const store = input.store
  const rows = await findByOperationKey(store, opKey)
  const hash = contentHash({
    title: input.title,
    description: input.description,
    labels: input.labels,
    parent: input.parent,
  })

  // First submission of this logical action.
  if (!rows.length) {
    const created = await createBead({ ...input, labels: withOperationKey(input.labels ?? [], opKey) })
    const rev: Revision = {
      seq: 1,
      hash,
      mode: 'create',
      at: new Date().toISOString(),
      operationKey: opKey,
      payload: {
        title: input.title,
        description: input.description,
        labels: input.labels,
        ...(input.parent ? { parent: input.parent } : {}),
        applied: ['created'],
      },
    }
    const recorded = await recordRevision(store, created.id, rev)
    return {
      id: created.id,
      store,
      disposition: 'created',
      revision: 1,
      operationKey: opKey,
      applied: recorded ? ['created', 'revision 1 recorded'] : ['created', `revision 1 NOT recorded: ${created.id}`],
      verified: created.verified,
      detail: created.detail,
    }
  }

  const canonical = canonicalOf(rows)
  const losers = rows.map((r) => r.id).filter((id) => id !== canonical.id)
  const collapsed: string[] = []
  for (const loser of losers) {
    await collapseDuplicate(store, loser, canonical.id, opKey)
    collapsed.push(loser)
  }

  const history = await readRevisionHistory(store, canonical.id)
  const seq = nextSeq(history)

  // Byte-identical replay (network retry, duplicate tool call, a second
  // runtime replaying the same request): already recorded -> no write at
  // all. This is what makes replay a no-op instead of revision noise.
  if (history.some((r) => r.hash === hash)) {
    const existing = history.find((r) => r.hash === hash) as Revision
    const shown = (await verifyBead(store, canonical.id)) ?? 'unreadable'
    return {
      id: canonical.id,
      store,
      disposition: 'duplicate',
      revision: existing.seq,
      operationKey: opKey,
      applied: collapsed.length ? [`collapsed duplicate bead(s) ${collapsed.join(', ')}`] : [],
      verified: shown !== 'unreadable',
      detail: shown,
      ...(collapsed.length ? { collapsed } : {}),
    }
  }

  const state = await readBeadState(store, canonical.id)
  const applied: string[] = collapsed.length ? [`collapsed duplicate bead(s) ${collapsed.join(', ')}`] : []

  // Materially distinct added scope, declared by the caller -> child bead.
  if (input.promote) {
    const childKey = childOperationKey(opKey, seq)
    const childRows = await findByOperationKey(store, childKey)
    let childId = childRows.length ? canonicalOf(childRows).id : ''
    if (!childId) {
      const child = await createBead({
        store,
        title: input.title,
        description: input.description,
        labels: withOperationKey(input.labels ?? [], childKey),
        parent: canonical.id,
        provenance: input.provenance,
      })
      childId = child.id
    }
    applied.push(`promoted added scope to child bead ${childId} (${childKey})`)
    const rev: Revision = {
      seq,
      hash,
      mode: 'child',
      at: new Date().toISOString(),
      operationKey: opKey,
      payload: {
        title: input.title,
        description: input.description,
        labels: input.labels,
        child: childId,
        applied: [...applied],
      },
    }
    const recorded = await recordRevision(store, canonical.id, rev)
    if (!recorded) applied.push(`revision ${seq} NOT recorded on ${canonical.id}`)
    return {
      id: canonical.id,
      store,
      disposition: 'promoted',
      revision: seq,
      operationKey: opKey,
      applied,
      childId,
      verified: (await verifyBead(store, canonical.id)) !== null,
      detail: (await verifyBead(store, canonical.id)) ?? 'unreadable',
      ...(collapsed.length ? { collapsed } : {}),
    }
  }

  // Merge onto the canonical bead. Title authoritative, body additive,
  // labels additive — see the policy block at the top of this file.
  const nextTitle = input.title.trim().slice(0, 200)
  const titleChanged = Boolean(nextTitle) && nextTitle !== state.title.trim()
  const bodyNext = mergeBody(state.description, input.description ?? '', seq, opKey)
  const bodyChanged = bodyNext !== state.description
  if (titleChanged || bodyChanged) {
    await editBead({
      store,
      id: canonical.id,
      ...(titleChanged ? { title: nextTitle } : {}),
      ...(bodyChanged ? { description: bodyNext } : {}),
    })
    if (titleChanged) applied.push(`title superseded by revision ${seq}`)
    if (bodyChanged) {
      applied.push(
        state.description.includes((input.description ?? '').trim()) || !(input.description ?? '').trim()
          ? 'body already contained the submitted text'
          : 'body merged additively',
      )
    }
  } else {
    applied.push('no field-level change (submission adds nothing new)')
  }

  const newLabels = mergeLabels(state.labels, input.labels ?? [])
  const toAdd = newLabels.filter((l) => !state.labels.includes(l))
  if (toAdd.length) {
    await labelBead(store, canonical.id, { add: toAdd.join(',') })
    applied.push(`labels added: ${toAdd.join(', ')}`)
  }

  const rev: Revision = {
    seq,
    hash,
    mode: 'revision',
    at: new Date().toISOString(),
    operationKey: opKey,
    payload: {
      title: input.title,
      description: input.description,
      labels: input.labels,
      applied: [...applied],
    },
  }
  const recorded = await recordRevision(store, canonical.id, rev)
  if (!recorded) applied.push(`revision ${seq} NOT recorded on ${canonical.id}`)

  const detail = (await verifyBead(store, canonical.id)) ?? 'unreadable after revision'
  return {
    id: canonical.id,
    store,
    disposition: 'revision',
    revision: seq,
    operationKey: opKey,
    applied,
    verified: detail !== 'unreadable after revision',
    detail,
    ...(collapsed.length ? { collapsed } : {}),
  }
}

export { formatReconciliation }