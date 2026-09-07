// Shared SWR caches for the resume voice-loop routes.
// A fetch fans out to bead subprocess calls; every hit serves instantly
// (even stale) while a background refresh keeps data fresh.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { RESUME_DOCX_DIR, FETCH_MODES } from './config'

export const execFileAsync = promisify(execFile)

// Stale-while-revalidate: a fetch fans out to ~50 bead subprocess calls
// (~60-120s), so every hit serves the cache immediately (even stale) while a
// background refresh keeps it fresh. Bead state changes on human timescales.
// ?fresh=1 forces a refresh-and-wait instead.
export const fetchCache = new Map<string, { at: number; body: string }>()
export const FETCH_TTL_MS = 90_000

// Boot warmup: fill caches in the background so the first external hit is
// instant instead of a cold fan-out. Fire-and-forget; failures just mean
// the first hit warms normally.
export function warmResume(id: string): void {
  for (const mode of [...FETCH_MODES, 'urls'] as const) {
    const key = mode === 'urls' ? `roster:${id}` : `${id}/${mode}`
    if (inflight.has(key) || fetchCache.has(key) || rosterCache.has(id)) continue
    inflight.add(key)
    const isRoster = mode === 'urls'
    execFileAsync('bun', [`${RESUME_DOCX_DIR}/bin/fetch.ts`, id, mode],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
      .then(({ stdout }) => {
        if (isRoster) {
          rosterCache.set(id, { at: Date.now(), urls: stdout.trim().split('\n').map(l => l.trim()).filter(Boolean) })
          rosterInflight.delete(id)
        } else fetchCache.set(key, { at: Date.now(), body: stdout.trim() })
      })
      .catch(() => {})
      .finally(() => inflight.delete(key))
  }
}
export const inflight = new Set<string>()

// Roster cache (bead URL lists for the index + blurb): same SWR pattern.
// The urls fan-out costs as much as a mode fetch, so it gets the same treatment.
const rosterCache = new Map<string, { at: number; urls: string[] }>()
export const rosterInflight = new Set<string>()

export async function refreshRoster(id: string): Promise<string[]> {
  const { stdout } = await execFileAsync('bun',
    [`${RESUME_DOCX_DIR}/bin/fetch.ts`, id, 'urls'],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
  const urls = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
  rosterCache.set(id, { at: Date.now(), urls })
  return urls
}

/** Serve the roster instantly (even stale); refresh in background. Null = none yet. */
export function staleRoster(id: string, fresh: boolean): string[] | null {
  const hit = rosterCache.get(id)
  if (hit && !fresh) {
    if (!rosterInflight.has(id)) {
      rosterInflight.add(id)
      refreshRoster(id).catch(() => {}).finally(() => rosterInflight.delete(id))
    }
    return hit.urls
  }
  return null
}

export async function refreshFetch(key: string, id: string, mode: string, extra?: string): Promise<string> {
  const { stdout } = await execFileAsync('bun',
    [`${RESUME_DOCX_DIR}/bin/fetch.ts`, id, mode, ...(extra ? [extra] : [])],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
  const body = stdout.trim()
  fetchCache.set(key, { at: Date.now(), body })
  return body
}

// GET /fetch/{resumeId}/{mode} — deterministic resume views for the voice loop.
// Served from resume-docx get_resume_content() (src/fetch.ts via bin/fetch.ts):
// bead-id in, plain-text out. Modes: unconfirmed (pending bullets +
// workExperience context), complete (full markdown with green/orange ledger +
// directions block), job-description (posting_ref job bead verbatim).

