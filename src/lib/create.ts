// Bead creation over the same CLIs the routes shell out to — but with
// shell-free argv (no quoting/injection surface) and a verify-after-write.
// Labels come from the caller (ChatGPT) and pass the same cleanLabel gate
// as queries; bad labels fail fast with the full list named.
import { createHash } from 'crypto'
import { execStdout } from './exec'
import { aliasesForStore } from './store-spellings'
import { cleanLabel } from '../routes/query/params'
import { withProvenance, type Provenance } from './provenance'

export interface CreateInput {
  store: string
  title: string
  description?: string
  labels?: string[]
  parent?: string
  // Origin stamp (task-mm2zq): which creation path made this bead, plus
  // the caller where one is known. Merged into labels by buildCreateArgs
  // so every createBead caller stamps uniformly — MCP tool, batch, relay.
  provenance?: Provenance
  // Client-generated logical operation id (beads-bridge idempotent create).
  // Carried on the input for provenance parity, but the KEYING itself lives
  // in idempotent-create.ts — createBead stays the raw single-create path so
  // a caller with no operation id keeps exactly the old behaviour.
  operationId?: string
}

export function buildCreateArgs(input: CreateInput): string[] {
  const args = ['create', input.title]
  if (input.description) args.push('-d', input.description)
  const labels = withProvenance(input.labels ?? [], input.provenance)
  if (labels.length) args.push('-l', labels.join(','))
  if (input.parent) args.push('--parent', input.parent)
  return args
}

// Dotted child ids (task-fuk0c.1, .1.2, ...) must match whole — a bare
// prefix match returns the PARENT instead of the new child (task-r11aa).
const ID_RE = /\b([A-Za-z][A-Za-z0-9]+-[A-Za-z0-9]{3,}(?:\.\d+)*)\b/

// Candidate bead-id prefixes for a store, given its canonical OR alias name
// (alias symmetry is exact: 'projects' <-> 'project' derive each other).
// A store's id prefix is NOT its name — projects emits project-*,
// tasks emits task-*, ideas emits idea-* — and the registry carries no
// prefix field, so derive candidates mechanically (task-d8ipc).
export function expectedIdPrefixes(store: string): string[] {
  const base = (store ?? '').trim().toLowerCase()
  if (!base) return []
  return [base, ...aliasesForStore(base)].map((s) => `${s}-`)
}

// First store-prefixed bead id in CLI output, or null.
export function parseCreatedId(store: string, stdout: string): string | null {
  const ids = [...stdout.matchAll(new RegExp(ID_RE, 'g'))].map((m) => m[1])
  if (!ids.length) return null
  const want = expectedIdPrefixes(store)
  const hit = ids.find((id) => want.some((p) => id.toLowerCase().startsWith(p)))
  if (hit) return hit
  // Fallback: the creating CLI is authoritative for its own prefix.
  // assertions emits assert-* (wrapper BD_NAME=assert) — neither the store
  // name nor its mechanical singular — so an output with no candidate match
  // still holds the created bead. The new bead is emitted last, so take the
  // last id: a --parent echo can never shadow it. createBead's read-back
  // `show` on the same store then decides ownership; null now means only
  // "no bead id in output", never a receipt failure on success.
  return ids[ids.length - 1]
}

export function validateCreateLabels(labels: string[] | undefined): { ok: string[]; bad: string[] } {
  const ok: string[] = []
  const bad: string[] = []
  for (const l of (labels ?? []).slice(0, 10)) {
    const clean = cleanLabel(l)
    if (clean) ok.push(clean)
    else bad.push(l)
  }
  return { ok, bad }
}

// Write budget. Writes queue behind a shared Dolt lock and took 18-37 s under
// load (scout report, robots-u1u8); the old 15 s cap killed the wrapper AFTER
// bd had committed, so callers saw a failure for a bead that existed.
export const CREATE_TIMEOUT_MS = 75000

// Default idempotency key for creates that carry no client operation id:
// store + title + description + labels + parent. A retry of the same request
// maps to the bead the timed-out attempt already made instead of a duplicate.
export const CREATE_KEY_PREFIX = 'ckey:'
const CREATE_KEY_WINDOW_MS = 60 * 60 * 1000

export function createKey(input: CreateInput): string {
  const digest = createHash('sha256')
    .update([input.store.trim().toLowerCase(), input.title, input.description ?? '', (input.labels ?? []).join(','), input.parent ?? ''].join('\u0000'))
    .digest('hex')
  return `${CREATE_KEY_PREFIX}${digest.slice(0, 16)}`
}

export class CreateTimeoutError extends Error {
  constructor(public store: string, public timeoutMs: number, public key: string) {
    super(
      `${store} create timed out after ${Math.round(timeoutMs / 1000)}s and no bead carrying ${key} was found yet. ` +
        `The write may still commit (the store call is slow, not necessarily failed): check ${store} for label ${key} before retrying. ` +
        `Retrying the identical create is safe — it reuses the bead if it landed.`,
    )
    this.name = 'CreateTimeoutError'
  }
}

export interface CreateDeps {
  exec: (store: string, args: string[], timeoutMs: number) => Promise<string>
  now: () => number
}
const realDeps: CreateDeps = { exec: execStdout, now: () => Date.now() }

function isTimeout(e: unknown): boolean {
  const err = e as { killed?: boolean; signal?: string; code?: unknown }
  return err?.killed === true || err?.signal === 'SIGTERM'
}

// Recent open bead carrying the key, or null. Lookup failures read as "none".
async function findByCreateKey(deps: CreateDeps, store: string, key: string): Promise<string | null> {
  const out = await deps.exec(store, ['list', '--json', '--limit', '20', '--label', key], 20000).catch(() => '[]')
  try {
    const rows: unknown = JSON.parse(out || '[]')
    const fresh = (Array.isArray(rows) ? rows : [])
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && typeof r.id === 'string')
      .filter((r) => {
        const t = Date.parse(String(r.created_at ?? ''))
        return !t || deps.now() - t < CREATE_KEY_WINDOW_MS
      })
      .sort((a, b) => (Date.parse(String(a.created_at ?? '')) || 0) - (Date.parse(String(b.created_at ?? '')) || 0))
    return fresh.length ? String(fresh[0].id) : null
  } catch {
    return null
  }
}

export async function createBead(
  input: CreateInput,
  deps: CreateDeps = realDeps,
): Promise<{ id: string; detail: string; verified: boolean; reused?: boolean }> {
  const title = input.title.trim().slice(0, 200)
  if (!title) throw new Error('title is required')
  // Callers with their own key (opkey:, idempotent-create.ts) keep it; every
  // other create gets the default content key.
  const keyed = !(input.labels ?? []).some((l) => l.startsWith('opkey:'))
  const key = keyed ? createKey({ ...input, title }) : ''
  const args = buildCreateArgs({
    ...input,
    title,
    // No slice: body text passes through verbatim. The MCP zod schema
    // (MAX_BODY_CHARS) is the single loud enforcement point — truncating
    // here would turn a loud rejection into silent data loss.
    description: input.description,
    labels: key ? [...(input.labels ?? []), key] : input.labels,
  })
  const readBack = async (id: string, reused: boolean) => {
    // Closed loop: confirm the bead reads back.
    const shown = await deps.exec(input.store, ['show', id], 10000).catch(() => null)
    return { id, detail: (shown ?? 'unreadable after create').slice(0, 1200), verified: shown !== null, ...(reused ? { reused } : {}) }
  }
  if (key) {
    const existing = await findByCreateKey(deps, input.store, key)
    if (existing) return readBack(existing, true)
  }
  let stdout: string
  try {
    stdout = await deps.exec(input.store, args, CREATE_TIMEOUT_MS)
  } catch (e) {
    if (isTimeout(e)) {
      // The kill hits the wrapper, not the orphaned bd: the bead may exist.
      const landed = key ? await findByCreateKey(deps, input.store, key) : null
      if (landed) return readBack(landed, true)
      throw new CreateTimeoutError(input.store, CREATE_TIMEOUT_MS, key || '(unkeyed)')
    }
    const err = e as { stdout?: unknown; message?: string }
    throw new Error((typeof err.stdout === 'string' && err.stdout.trim()) || err.message || 'create failed')
  }
  const id = parseCreatedId(input.store, stdout)
  if (!id) throw new Error(`created but no bead id found in output: ${stdout.slice(0, 200)}`)
  return readBack(id, false)
}
