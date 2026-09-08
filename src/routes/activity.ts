// Last-turn memory: what the previous agent requested + what got resolved.
// Requests come from a bounded in-memory ring filled by server.ts on every
// response finish (restart clears it — stated on the page). Resolves come
// from live store queries (created/closed since T), so they survive restarts.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { BASE, STORES } from '../config'
import { pstr, withCb, shortCode } from '../util'
import { wrap } from '../wrap'
import { withDebug, failureDebug } from './debug-state'
import { discoverScopeLabels } from './query/scope'
import { mapLimit } from '../lib/exec'

const execFileAsync = promisify(execFile)

export const mountOrder = -14
export const activityRouter = Router()

export interface Hit { at: number; method: string; path: string; status: number; ms: number }
const hits: Hit[] = []
const MAX_HITS = 300

// Called from server.ts when each response finishes. Drops the per-page
// cache-buster so repeated fetches of one literal group together.
export function recordHit(method: string, originalUrl: string, status: number, ms: number): void {
  const path = originalUrl.replace(/([?&])cb=[^&]*/g, '$1').replace(/[?&]$/, '')
  hits.push({ at: Date.now(), method, path, status, ms })
  if (hits.length > MAX_HITS) hits.splice(0, hits.length - MAX_HITS)
}

function recentHits(n: number): Hit[] {
  return hits.slice(-n).reverse()
}

const RESUME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,64}$/

interface BeadRow { id: string; title: string; labels: string[]; close_reason?: string }

// One store list as parsed rows; [] on any failure (endpoint degrades, not 500s).
async function listSinceAsync(store: string, sinceIso: string, closed: boolean): Promise<BeadRow[]> {
  try {
    const args = ['list', '--json', '--limit', '50', closed ? '--closed-after' : '--created-after', sinceIso]
    const { stdout } = await execFileAsync(store, args, { encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024 })
    const d = JSON.parse(stdout as string)
    const arr: unknown[] = Array.isArray(d) ? d : []
    return arr
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        id: String(x.id ?? x.bead_id ?? '?'),
        title: String(x.title ?? '').slice(0, 100),
        labels: Array.isArray(x.labels) ? (x.labels as unknown[]).map(String) : [],
        close_reason: typeof x.close_reason === 'string' ? x.close_reason.slice(0, 160) : undefined,
      }))
      .filter((x) => x.id !== '?')
  } catch {
    return []
  }
}

// GET /resume/:id/last-turn — previous turn: requests + resolves since ?hours= (default 24, max 168).
activityRouter.get('/resume/:id/last-turn', async (req: Request, res: Response) => {
  const id = pstr(req.params.id)
  const selfUrl = `${BASE}${req.originalUrl}`
  if (!RESUME_RE.test(id)) {
    return res.type('text/plain').status(400).send(wrap({
      title: 'Last turn failed',
      noNext: true,
      body: `unknown resume id: ${id}` + failureDebug(
        [{ label: `GET ${selfUrl}`, ok: false, detail: `unknown resume id: ${id}` }],
        [selfUrl],
      ),
    }))
  }
  const hours = Math.min(168, Math.max(1, parseInt(String(req.query.hours ?? '24'), 10) || 24))
  const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString()
  const scopeTag = `resume:${id}`
  const slugs = new Set(discoverScopeLabels(id))

  const lines = [
    `# last turn — ${id} (since ${sinceIso})`,
    ``,
    `Requests below are this server's memory (restart clears it). Resolves are live store state (survive restarts).`,
    ``,
    `## requests (newest first, last ${Math.min(recentHits(50).length, 50)})`,
    ``,
  ]
  const seen = recentHits(50)
  if (!seen.length) {
    lines.push(`- none recorded (server restarted recently, or no traffic yet)`, ``)
  } else {
    for (const h of seen) {
      const mine = h.path.includes(id) ? ' ★' : ''
      lines.push(`- ${new Date(h.at).toISOString()} ${h.status} ${h.ms}ms ${h.method} ${h.path}${mine}`)
    }
    lines.push(``)
  }
  lines.push(`## resolves since ${sinceIso}`, ``)
  const inScope = (r: BeadRow) =>
    r.labels.includes(scopeTag) || r.labels.some((l) => l.startsWith('project:') && slugs.has(l))
  const fmt = (r: BeadRow) => `- ${r.id} — ${r.title}${r.close_reason ? ` (receipt: ${r.close_reason})` : ''}`
  let anyResolve = false
  const created: BeadRow[] = []
  const closed: BeadRow[] = []
  const pairs: { store: string; closed: boolean }[] = []
  for (const store of ['stories', 'task', 'resume_bullets', 'projects'] as const) {
    if (!STORES.includes(store)) continue
    pairs.push({ store, closed: false }, { store, closed: true })
  }
  pairs.push({ store: 'inbox', closed: true })
  let fetched: { store: string; closed: boolean; rows: BeadRow[] }[] = []
  try {
    fetched = await mapLimit(pairs, 5, async ({ store, closed }) => ({
      store, closed, rows: await listSinceAsync(store, sinceIso, closed),
    }))
  } catch {
    fetched = []
  }
  for (const { store, closed: wasClosed, rows } of fetched) {
    for (const r of rows) {
      // Inbox receipts are global but are the worker-resolve record — include closed ones with their receipts.
      const scoped = store === 'inbox'
        ? true
        : store === 'stories' || store === 'task'
          ? r.labels.includes(scopeTag)
          : inScope(r)
      if (!scoped) continue
      if (wasClosed) closed.push({ ...r, title: `[${store}] ${r.title}` })
      else created.push({ ...r, title: `[${store}] ${r.title}` })
    }
  }
  lines.push(`Created (${created.length}):`)
  if (!created.length) lines.push(`- none`)
  else for (const r of created.slice(0, 20)) lines.push(fmt(r))
  lines.push(``)
  lines.push(`Closed (${closed.length}):`)
  if (!closed.length) lines.push(`- none`)
  else for (const r of closed.slice(0, 20)) lines.push(fmt(r))
  lines.push(``)
  anyResolve = created.length + closed.length > 0
  if (!anyResolve) lines.push(`Nothing created or closed in scope — see still-open work instead:`, ``)
  lines.push(
    `Still open: ${BASE}/resume/${id}/scope-refinement (stale dependencies lead),`,
    `${BASE}/resume/${id}/followups (live deltas),`,
    ``,
  )
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — last turn`,
    noNext: true,
    body: withDebug(req, lines.join('\n')),
    meta: { id },
    actions: [
      `GET ${withCb(`${BASE}/resume/${id}/scope-refinement`, shortCode())} — current scope + stale set`,
      `GET ${withCb(`${BASE}/resume/${id}/followups`, shortCode())} — live deltas`,
    ],
  }))
})
