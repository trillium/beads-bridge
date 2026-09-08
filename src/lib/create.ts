// Bead creation over the same CLIs the routes shell out to — but with
// shell-free argv (no quoting/injection surface) and a verify-after-write.
// Labels come from the caller (ChatGPT) and pass the same cleanLabel gate
// as queries; bad labels fail fast with the full list named.
import { execStdout } from './exec'
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

const ID_RE = /\b([A-Za-z][A-Za-z0-9]+-[A-Za-z0-9]{3,})\b/

// First store-prefixed bead id in CLI output, or null.
export function parseCreatedId(store: string, stdout: string): string | null {
  for (const m of stdout.matchAll(new RegExp(ID_RE, 'g'))) {
    if (m[1].startsWith(`${store}-`)) return m[1]
  }
  return null
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

export async function createBead(input: CreateInput): Promise<{ id: string; detail: string }> {
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
  if (!id) throw new Error(`created but no ${input.store}-* id found in output: ${stdout.slice(0, 200)}`)
  // Closed loop: confirm the bead reads back.
  const shown = await execStdout(input.store, ['show', id], 10000).catch((e: unknown) =>
    (e as { message?: string }).message ?? 'unreadable after create')
  return { id, detail: shown.slice(0, 1200) }
}
