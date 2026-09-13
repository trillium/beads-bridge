// Bead content revision via the scriptable `update` command (the `edit`
// command is $EDITOR-interactive and unusable here). Shell-free argv,
// verify-after-write. At least one of title/description is required.
import { execStdout } from './exec'

export interface EditInput {
  store: string
  id: string
  title?: string
  description?: string
}

export function buildEditArgs(id: string, input: Pick<EditInput, 'title' | 'description'>): string[] | null {
  const args = ['update', id]
  if (input.title?.trim()) args.push('--title', input.title.trim().slice(0, 200))
  if (input.description !== undefined) args.push('-d', input.description.slice(0, 4000))
  return args.length > 2 ? args : null
}

export async function editBead(input: EditInput): Promise<{ id: string; detail: string; verified: boolean }> {
  const args = buildEditArgs(input.id, input)
  if (!args) throw new Error('give title and/or description to change')
  try {
    await execStdout(input.store, args, 15000)
  } catch (e) {
    const err = e as { stdout?: unknown; message?: string }
    throw new Error((typeof err.stdout === 'string' && err.stdout.trim()) || err.message || 'update failed')
  }
  const shown = await execStdout(input.store, ['show', input.id], 10000).catch(() => null)
  return { id: input.id, detail: (shown ?? 'unreadable after update').slice(0, 1200), verified: shown !== null }
}
