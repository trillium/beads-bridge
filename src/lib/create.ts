// Bead creation over the same CLIs the routes shell out to — but with
// shell-free argv (no quoting/injection surface) and a verify-after-write.
// Labels come from the caller (ChatGPT) and pass the same cleanLabel gate
// as queries; bad labels fail fast with the full list named.
import { execStdout } from './exec'
import { aliasesForStore } from './store-spellings'
import { cleanLabel } from '../routes/query/params'

export interface CreateInput {
  store: string
  title: string
  description?: string
  labels?: string[]
  parent?: string
}

export function buildCreateArgs(input: CreateInput): string[] {
  const args = ['create', input.title]
  if (input.description) args.push('-d', input.description)
  if (input.labels?.length) args.push('-l', input.labels.join(','))
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

export async function createBead(input: CreateInput): Promise<{ id: string; detail: string; verified: boolean }> {
  const title = input.title.trim().slice(0, 200)
  if (!title) throw new Error('title is required')
  const args = buildCreateArgs({
    ...input,
    title,
    description: input.description?.slice(0, 4000),
  })
  let stdout: string
  try {
    stdout = await execStdout(input.store, args, 15000)
  } catch (e) {
    const err = e as { stdout?: unknown; message?: string }
    throw new Error((typeof err.stdout === 'string' && err.stdout.trim()) || err.message || 'create failed')
  }
  const id = parseCreatedId(input.store, stdout)
  if (!id) throw new Error(`created but no bead id found in output: ${stdout.slice(0, 200)}`)
  // Closed loop: confirm the bead reads back.
  const shown = await execStdout(input.store, ['show', id], 10000).catch(() => null)
  return { id, detail: (shown ?? 'unreadable after create').slice(0, 1200), verified: shown !== null }
}
