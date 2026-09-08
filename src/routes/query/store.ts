// Bead-store reads for label queries: argv building, row parsing, and
// sync/async list + single-bead show. Errors come back as data
// ({rows, error?}) so pages degrade per-store instead of 500ing.
import { spawnSync } from 'child_process'
import { execStdout } from '../../lib/exec'
import { cleanLabel, type Row } from './params'

export interface ListOpts {
  exclude: string[]
  title?: string
  desc?: string
  notes?: string
  status?: string
  limit: number
  allStates: boolean
}

export function listArgs(all: string[], any: string[], opts: ListOpts): string[] {
  const args = ['list', '--json', '--limit', String(opts.limit)]
  for (const l of all) args.push('--label', l)
  if (any.length) {
    // --label-any takes comma-separated or repeatable; one flag with CSV is fine
    args.push('--label-any', any.join(','))
  }
  for (const l of opts.exclude) args.push('--exclude-label', l)
  if (opts.title) args.push('--title-contains', opts.title)
  if (opts.desc) args.push('--desc-contains', opts.desc)
  if (opts.notes) args.push('--notes-contains', opts.notes)
  if (opts.status) args.push('--status', opts.status)
  if (opts.allStates) args.push('--all')
  return args
}

export function parseRows(stdout: string): Row[] {
  const d = JSON.parse(stdout || 'null')
  const arr: unknown[] = Array.isArray(d) ? d : []
  return arr
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      id: String(x.id ?? x.bead_id ?? '?'),
      title: String(x.title ?? '').slice(0, 120),
      labels: Array.isArray(x.labels) ? (x.labels as unknown[]).map(String) : [],
    }))
    .filter((x) => x.id !== '?')
}

export function runList(
  store: string,
  all: string[],
  any: string[],
  opts: ListOpts,
): { rows: Row[]; error?: string } {
  const r = spawnSync(store, listArgs(all, any, opts), { encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024 })
  if (r.error) return { rows: [], error: String(r.error).slice(0, 160) }
  if (r.status !== 0 && !r.stdout) {
    return { rows: [], error: (r.stderr ?? `exit ${r.status}`).trim().slice(0, 200) || `exit ${r.status}` }
  }
  try {
    return { rows: parseRows(r.stdout || '') }
  } catch {
    return { rows: [], error: 'unparseable store output' }
  }
}

export async function runListAsync(
  store: string,
  all: string[],
  any: string[],
  opts: ListOpts,
): Promise<{ rows: Row[]; error?: string }> {
  try {
    return { rows: parseRows(await execStdout(store, listArgs(all, any, opts), 12000)) }
  } catch (e: unknown) {
    const err = e as { stdout?: unknown; message?: string }
    if (typeof err.stdout === 'string' && err.stdout.trim()) {
      try { return { rows: parseRows(err.stdout) } } catch { /* fall through to error */ }
    }
    return { rows: [], error: (err.message ?? 'store query failed').slice(0, 200) }
  }
}

export async function showBeadAsync(store: string, id: string): Promise<string | null> {
  try {
    const t = await execStdout(store, ['show', id], 12000)
    return t || null
  } catch {
    return null
  }
}

// The resume manifest's posting_ref → job bead id (e.g. job-5u5).
export function resolvePostingRef(resumeId: string): string | null {
  try {
    const r = spawnSync('resumes', ['show', resumeId, '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
    if (r.error || r.status !== 0 || !r.stdout) return null
    const d = JSON.parse(r.stdout as string)
    const row = Array.isArray(d) ? d[0] : d
    const desc = JSON.parse(row?.description ?? '{}')
    return typeof desc?.posting_ref === 'string' && desc.posting_ref ? desc.posting_ref : null
  } catch {
    return null
  }
}
