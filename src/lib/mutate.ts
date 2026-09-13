// Shell-free bead mutations with verify-after-write receipts.
//
// Every mutation here runs over execFile argv (never a shell string, so
// $, backticks, quotes, and newlines in user text pass through literally)
// and throws on failure (never returns error text as success). Callers get
// a receipt carrying the canonical id, store, operation, and whether the
// bead read back afterwards — the guardrail against false-success reports.
import { execFileSync } from 'child_process'
import { execStdout } from './exec'

export interface MutationReceipt {
  operation: string
  id: string
  store: string
  verified: boolean
  detail: string
}

export function formatReceipt(r: MutationReceipt, extra?: string): string {
  return [
    `# ${r.operation} ${r.id} (STORE: ${r.store})`,
    ``,
    r.verified ? `Verified: yes — bead reads back` : `Verified: NO — read-back failed; re-read before reporting success`,
    ...(extra ? [``, extra] : []),
    ``,
    r.detail,
  ].join('\n')
}

function failureMessage(store: string, args: string[], e: unknown): string {
  const err = e as { stderr?: unknown; stdout?: unknown; message?: string }
  const tail = (v: unknown): string => {
    const s = typeof v === 'string' ? v : v instanceof Buffer ? v.toString('utf8') : ''
    return s.trim()
  }
  // Prefer the CLI's own stderr; never echo the full argv back (it can
  // carry long user text and previously leaked the constructed command).
  return tail(err.stderr) || tail(err.stdout) || (err.message || `${store} mutation failed`).split('\n')[0]
}

// Sync variant for sync route handlers (same shell-free, throw-on-failure
// contract as runMutation).
export function runMutationSync(store: string, args: string[], timeoutMs = 15000): string {
  try {
    return execFileSync(store, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }).trim()
  } catch (e) {
    throw new Error(failureMessage(store, args, e).slice(0, 300))
  }
}

// One mutation argv. Resolves trimmed stdout; throws Error on failure.
export async function runMutation(store: string, args: string[], timeoutMs = 15000): Promise<string> {
  try {
    return await execStdout(store, args, timeoutMs)
  } catch (e) {
    throw new Error(failureMessage(store, args, e).slice(0, 300))
  }
}

// Read-after-write: bead show, or null when the bead does not read back.
export async function verifyBead(store: string, id: string): Promise<string | null> {
  try {
    const shown = await execStdout(store, ['show', id], 10000)
    return shown.slice(0, 1200) || null
  } catch {
    return null
  }
}

async function receipt(operation: string, store: string, id: string, detail?: string): Promise<MutationReceipt> {
  const shown = await verifyBead(store, id)
  return { operation, id, store, verified: shown !== null, detail: (detail ?? shown ?? 'unreadable after write').slice(0, 1200) }
}

export async function commentBead(store: string, id: string, text: string): Promise<MutationReceipt> {
  const clean = id.trim()
  if (!text.trim()) throw new Error('Missing text.')
  await runMutation(store, ['comment', clean, text])
  return receipt(`comment added`, store, clean)
}

export async function noteBead(store: string, id: string, text: string): Promise<MutationReceipt> {
  const clean = id.trim()
  if (!text.trim()) throw new Error('Missing text.')
  await runMutation(store, ['note', clean, text])
  return receipt(`note added`, store, clean)
}

export async function closeBead(store: string, id: string): Promise<MutationReceipt> {
  const clean = id.trim()
  await runMutation(store, ['close', clean])
  return receipt(`closed`, store, clean)
}

export async function labelBead(
  store: string,
  id: string,
  opts: { add?: string; remove?: string },
): Promise<MutationReceipt> {
  const clean = id.trim()
  if (!opts.add && !opts.remove) throw new Error('Give add and/or remove.')
  const steps: string[] = []
  if (opts.add) steps.push(await runMutation(store, ['label', 'add', clean, opts.add]))
  if (opts.remove) steps.push(await runMutation(store, ['label', 'remove', clean, opts.remove]))
  return receipt(`labels updated`, store, clean, steps.join('\n') || undefined)
}
