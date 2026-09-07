// Resume voice-loop routes: /fetch/{resumeId}/{mode} + /resume assistance page.
// MUST be mounted before the /:store and /:id routes (Express matches in order).
import { Router, Request, Response } from 'express'
import { readFileSync } from 'fs'
import path from 'path'
import { BASE, FETCH_MODES } from '../config'
import { fetchCache, FETCH_TTL_MS, inflight, refreshFetch, staleRoster, refreshRoster, rosterInflight } from '../resume-cache'
import { pstr, withCb } from '../util'
import { wrap } from '../wrap'
import { guideEntries } from './guide'

export const resumeRouter = Router()

// ?debug=1 appends the debug-state protocol from blurbs/fetch-debug.md
// (read per-hit so edits apply without a restart).
function debugBlock(): string {
  try {
    return "\n" + readFileSync(path.join(__dirname, '..', '..', 'blurbs', 'fetch-debug.md'), 'utf8').trim()
  } catch { return "\n## debug — wrap your complete output in one fenced markdown block." }
}
const withDebug = (req: { query: unknown }, body: string) =>
  (req.query as Record<string, unknown>).debug !== undefined ? body + debugBlock() : body



// GET /fetch/{resumeId} — index for one resume: every mode URL as literals.
// Landing here means something omitted the mode; hand back the full map.
resumeRouter.get('/fetch/:id', async (req: Request, res: Response) => {
  const id = String(pstr(req.params.id))
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(id)) {
    return res.type('text/plain').status(400).send(`unknown resume id: ${id}`)
  }
  const fresh = req.query.fresh === '1'
  let beadUrls = staleRoster(id, fresh)
  if (!beadUrls) {
    try { beadUrls = await refreshRoster(id) }
    catch { beadUrls = [] }
    finally { rosterInflight.delete(id) }
  }
  const modes: [string, string][] = [
    ['unconfirmed', 'pending bullets + workExperience context (what needs work)'],
    ['complete', 'full markdown with green/orange ledger + directions block'],
    ['job-description', 'posting job bead verbatim'],
    ['done', 'exact output format for returning agreed changes'],
  ]
  // Coaching blurb lives in blurbs/resume-index.md (read per-hit so edits
  // apply without a restart); {BASE} and {RESUME} are filled in here.
  let coaching: string
  try {
    coaching = readFileSync(path.join(__dirname, '..', '..', 'blurbs', 'resume-index.md'), 'utf8')
      .split('\n').filter(l => !l.startsWith('Placeholders') && !l.startsWith('- {'))
      .join('\n').trim()
      .replaceAll('{BASE}', BASE).replaceAll('{RESUME}', id)
  } catch { coaching = `Work the ${id} resume: fetch job-description, then unconfirmed, one bullet at a time.` }
  const cbStamp = Date.now()
  const cb = (u: string) => withCb(u, cbStamp)
  const indexBody = [coaching, ``,
      `Pick a view — fetch its URL exactly as written:`, ``,
      ...modes.map(([m, d]) => `${cb(`${BASE}/fetch/${id}/${m}`)}  — ${d}`),
      ``, `Guidance — doctrine for this loop (fetch any literal):`, ``,
      ...guideEntries().map(([u, d]) => `${cb(u)}  — ${d}`),
      ...(beadUrls.length ? [``, `Deeper context — full beads (fetch any literal):`, ``,
        `${cb(`${BASE}/beads/${beadUrls.map(u => u.split('/').pop()).join('+')}`)}  — everything at once`,
        ``, ...beadUrls.map(u => cb(u))] : [])].join('\n')
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — views`,
    noNext: true,
    body: withDebug(req, indexBody),
    meta: { id },
    actions: modes.map(([m]) => `GET ${cb(`${BASE}/fetch/${id}/${m}`)}`),
  }))
})

resumeRouter.get('/fetch/:id/:mode', async (req: Request, res: Response) => {
  const id = pstr(req.params.id)
  const mode = pstr(req.params.mode)
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(id)) {
    return res.type('text/plain').status(400).send(`unknown resume id: ${id}`)
  }
  if (!(FETCH_MODES as readonly string[]).includes(mode)) {
    return res.type('text/plain').status(400)
      .send(`unknown mode: ${mode} (want ${FETCH_MODES.join('|')})`)
  }
  const key = `${id}/${mode}`
  const hit = fetchCache.get(key)
  const fresh = req.query.fresh === '1'
  const fail = (e: unknown) => {
    const err = e as { stdout?: string; message?: string }
    return `# fetch failed: ${id}/${mode}\n\n${String(err.stdout ?? '').trim() || err.message || 'error'}`
  }
  const stamp = (at: number, body: string) =>
    `${body}\n\ndata last updated at ${new Date(at).toISOString()}${Date.now() - at > FETCH_TTL_MS ? ' (stale — refresh running)' : ''}`
  if (hit && !fresh) {
    // Serve stale immediately; revalidate in the background (once per key).
    if (!inflight.has(key)) {
      inflight.add(key)
      refreshFetch(key, id, mode).catch(() => {}).finally(() => inflight.delete(key))
    }
    var body = stamp(hit.at, hit.body)
  } else {
    try {
      inflight.add(key)
      const freshBody = await refreshFetch(key, id, mode)
      var body = stamp(Date.now(), freshBody)
    } catch (e: unknown) {
      // Serve stale on failure rather than nothing, when we have it.
      if (hit) var body = stamp(hit.at, hit.body)
      else return res.type('text/plain').status(502).send(fail(e))
    } finally {
      inflight.delete(key)
    }
  }
  const cbStamp = Date.now()
  // Bust downstream caches: every literal URL in this body gets ?cb=<page-ms>.
  body = body.replace(/(https:\/\/[^\s)'"<>]+)/g, (u) =>
    /[?&]cb=/.test(u) ? u : withCb(u, cbStamp))
  body = withDebug(req, body)
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — ${mode}`,
    noNext: true,
    body,
    meta: { id },
    actions: [
      `GET ${withCb(`${BASE}/fetch/${id}/unconfirmed`, cbStamp)}      — pending bullets + workExperience context`,
      `GET ${withCb(`${BASE}/fetch/${id}/complete`, cbStamp)}         — full markdown with green/orange ledger`,
      `GET ${withCb(`${BASE}/fetch/${id}/job-description`, cbStamp)}  — posting job bead verbatim`,
    ],
  }))
})

