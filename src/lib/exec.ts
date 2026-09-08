// Shared subprocess + concurrency primitives: every bead-store call in
// every route goes through here. Shell-free argv (no injection surface),
// bounded parallelism preserving input order.
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// One bead-store call. Resolves trimmed stdout; throws an informative error
// otherwise (callers decide: degrade to text or fail the page).
export async function execStdout(store: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(store, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  })
  return (stdout as string).trim()
}

// One bead subprocess call that never throws: trimmed stdout, or the
// stderr/message as text (pages degrade per-bead instead of 500ing).
export async function beadText(store: string, args: string[]): Promise<string> {
  try {
    return await execStdout(store, args, 10000)
  } catch (e: unknown) {
    const err = e as { stdout?: unknown; message?: string }
    return (typeof err.stdout === 'string' && err.stdout.trim()) || err.message || 'error'
  }
}

// Bounded parallel fan-out preserving input order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}
