// Resume voice-loop routes: /fetch/{resumeId}/{mode} + /resume assistance page.
// MUST be mounted before the /:store and /:id routes (Express matches in order).
import { Router } from 'express'
import type { Request, Response } from 'express'
import { readFileSync } from 'fs'
import path from 'path'
import { BASE, FETCH_MODES } from '../config'
import { fetchCache, FETCH_TTL_MS, inflight, refreshFetch, staleRoster, refreshRoster, rosterInflight } from '../resume-cache'
import { pstr, withCb, shortCode } from '../util'
import { wrap } from '../wrap'
import { guideEntries } from './guide'
import { readSection } from './sections'
import { withDebug, debugBlock, failureDebug } from './debug-state'
import { warmBundle } from './beads'

export const mountOrder = -30
export const resumeRouter = Router()

// Failure helper: unknown ids/modes/slugs drop directly into the debug
// state with a prefilled copyable block — no second fetch needed.
const badRequest = (res: Response, title: string, msg: string, url: string, retry: string[], meta?: { id: string }) =>
  res.type('text/plain').status(400).send(wrap({
    title,
    noNext: true,
    body: msg + failureDebug([{ label: `GET ${url}`, ok: false, detail: msg }], [url, ...retry]),
    ...(meta ? { meta } : {}),
  }))



// GET /fetch/{resumeId}/debug — the debug state itself as a page.
// If any fetch fails, the turn guidance sends the agent here instead of
// guessing or blind-retrying.
resumeRouter.get('/fetch/:id/debug', (req: Request, res: Response) => {
  const id = String(pstr(req.params.id))
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(id)) {
    return badRequest(res, 'Fetch failed — debug', `unknown resume id: ${id}`, `${BASE}${req.originalUrl}`, [])
  }
  const proto = debugBlock().trim()
  const retry = [`unconfirmed`, `complete`, `job-description`, `done`, `findings`]
    .map(m => withCb(`${BASE}/fetch/${id}/${m}`, shortCode()))
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — debug state`,
    noNext: true,
    body: [`You are in a debug state because a fetch failed. Do not guess contents. Do not retry blindly more than once.`, ``,
      proto, ``,
      `Retry these literals one at a time, then follow the protocol above:`, ``,
      ...retry, ``,
      `Cache warning: bare URLs (no ?cb= tag) may be served from YOUR OWN fetch cache, not the server — always fetch the exact literal including its tag. A retry without it can return an older copy than the first fetch, which looks like the server going backward.`, ``,
      `Staleness check: every retried view ends with "data last updated at <iso>". Compare stamps across retries — if a stamp never advances, you are seeing a served copy, not a fresh read; say so in results.`, ``,
      `data last updated at ${new Date().toISOString()} (this debug page renders live on every hit)`].join('\n'),
    meta: { id },
    actions: retry.map(u => `GET ${withCb(u, shortCode())}`),
  }))
})

// GET /fetch/{resumeId} — index for one resume: every mode URL as literals.
// Landing here means something omitted the mode; hand back the full map.
resumeRouter.get('/fetch/:id', async (req: Request, res: Response) => {
  const id = String(pstr(req.params.id))
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(id)) {
    return badRequest(res, 'Fetch failed — views', `unknown resume id: ${id}`, `${BASE}${req.originalUrl}`, [])
  }
  const fresh = req.query.fresh === '1'
  let beadUrls = staleRoster(id, fresh)
  if (!beadUrls) {
    try { beadUrls = await refreshRoster(id) }
    catch { beadUrls = [] }
    finally { rosterInflight.delete(id) }
  }
  // [label, description, literal URL] — fetch views plus the resume step routes.
  const modes: [string, string, string][] = [
    ['unconfirmed', 'pending bullets + workExperience context (what needs work)', `${BASE}/fetch/${id}/unconfirmed`],
    ['complete', 'full markdown with green/orange ledger + directions block', `${BASE}/fetch/${id}/complete`],
    ['job-description', 'posting job bead verbatim', `${BASE}/fetch/${id}/job-description`],
    ['done', 'exact output format for returning agreed changes', `${BASE}/fetch/${id}/done`],
    ['debug', 'debug state — failed fetches drop into it themselves; go here if a page itself will not load', `${BASE}/fetch/${id}/debug`],
    ['findings', 'open verification findings (address first)', `${BASE}/fetch/${id}/findings`],
    ['stories', 'story records: evidence layer beneath bullets', `${BASE}/fetch/${id}/stories`],
    ['scope-refinement', 'project scope refinement: JD-first composed set + stale handoff — start here for promote/demote work', `${BASE}/resume/${id}/scope-refinement`],
    ['followups', 'mid-session refresh bank: "query follow-up N" for live deltas', `${BASE}/resume/${id}/followups`],
    ['last-turn', 'previous turn: requests the last agent made plus resolves provided', `${BASE}/resume/${id}/last-turn`],
    ['project/<slug>', 'per-project evidence pack (stories, tasks, bullets) — e.g. project/gas-town', `${BASE}/fetch/${id}/project/gas-town`],
  ]
  // Coaching blurb lives in blurbs/resume-index.md (read per-hit so edits
  // apply without a restart); {BASE} and {RESUME} are filled in here.
  let coaching: string
  try {
    coaching = readFileSync(path.join(__dirname, '..', '..', 'blurbs', 'resume-index.md'), 'utf8')
      .split('\n').filter(l => !l.startsWith('Placeholders') && !l.startsWith('- {'))
      .join('\n').trim()
            .replaceAll('{BASE}', BASE).replaceAll('{RESUME}', id).replaceAll('{{RETRO}}', readSection('retro')).replaceAll('{{DURABLE_EMIT}}', readSection('durable-emit'))
  } catch { coaching = `Work the ${id} resume: fetch job-description, then unconfirmed, one bullet at a time.` }
  const cbStamp = shortCode()
  const cb = (u: string) => withCb(u, cbStamp)
  const indexBody = [coaching, ``,
      `Pick a view — fetch its URL exactly as written:`, ``,
      ...modes.map(([, d, u]) => `${cb(u)}  — ${d}`),
      ``, `Refresh literals — same views, forced fresh (fetch if a stamp looks stale):`, ``,
      ...['unconfirmed', 'complete', 'findings'].map(m => `${BASE}/fetch/${id}/${m}?fresh=1  — refresh ${m}`),
      `${BASE}/print/${id}  — print page setup + layout verdict`,
      ``, `Guidance — doctrine for this loop (fetch any literal):`, ``,
      `If investigating stories, read ${cb(`${BASE}/guide/discovery`)}`, ``,
      ...guideEntries().map(([u, d]) => `${cb(u)}  — ${d}`),
      ...(beadUrls.length ? [``, `Deeper context — full beads (fetch any literal):`, ``,
        `${cb(`${BASE}/beads/${beadUrls.map(u => u.split('/').pop()).join('+')}`)}  — everything at once`,
        ``, ...beadUrls.map(u => cb(u))] : [])].join('\n')
  if (beadUrls.length) warmBundle(beadUrls.map(u => u.split('/').pop() ?? '')) // agent fetches the bundle next
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — views`,
    noNext: true,
    body: withDebug(req, indexBody),
    meta: { id },
    actions: modes.map(([, , u]) => `GET ${cb(u)}`),
  }))
})

resumeRouter.get('/fetch/:id/project/:slug', async (req: Request, res: Response) => {
  const id = pstr(req.params.id)
  const slug = pstr(req.params.slug)
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(id)) {
    return badRequest(res, 'Fetch failed — project', `unknown resume id: ${id}`, `${BASE}${req.originalUrl}`, [])
  }
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(slug)) {
    return badRequest(res, 'Fetch failed — project', `unknown project slug: ${slug}`, `${BASE}${req.originalUrl}`, [`${BASE}/fetch/${id}/debug`], { id })
  }
  const key = `${id}/project/${slug}`
  const hit = fetchCache.get(key)
  const fresh = req.query.fresh === '1'
  try {
    if (hit && !fresh) {
      if (!inflight.has(key)) {
        inflight.add(key)
        refreshFetch(key, id, 'project', slug).catch(() => {}).finally(() => inflight.delete(key))
      }
      const at = hit.at
      var body = `${hit.body}\n\ndata last updated at ${new Date(at).toISOString()}${Date.now() - at > FETCH_TTL_MS ? ' (stale — refresh running)' : ''}`
    } else {
      inflight.add(key)
      const freshBody = await refreshFetch(key, id, 'project', slug)
      var body = `${freshBody}\n\ndata last updated at ${new Date(Date.now()).toISOString()}`
    }
    res.type('text/plain').send(body)
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string }
    const detail = (String(err.stdout ?? '').trim() || err.message || 'error').slice(0, 200)
    if (hit) res.type('text/plain').send(`${hit.body}\n\ndata last updated at ${new Date(hit.at).toISOString()} (stale — refresh running)`)
    else {
      const selfUrl = `${BASE}${req.originalUrl}`
      res.type('text/plain').status(502).send(wrap({
        title: `Fetch failed: ${key}`,
        noNext: true,
        body: `# fetch failed: ${key}\n\n${detail}` + failureDebug(
          [{ label: `GET ${selfUrl}`, ok: false, detail }],
          [selfUrl, `${BASE}/fetch/${id}/debug`, `${BASE}/fetch/${id}/unconfirmed`, `${BASE}/fetch/${id}/complete`, `${BASE}/fetch/${id}/findings`],
        ),
        meta: { id },
        actions: [`GET ${withCb(`${BASE}/fetch/${id}/debug`, shortCode())} — debug state`],
      }))
    }
  }
})

resumeRouter.get('/fetch/:id/:mode', async (req: Request, res: Response) => {
  const id = pstr(req.params.id)
  const mode = pstr(req.params.mode)
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(id)) {
    return badRequest(res, 'Fetch failed — view', `unknown resume id: ${id}`, `${BASE}${req.originalUrl}`, [])
  }
  if (!(FETCH_MODES as readonly string[]).includes(mode)) {
    return badRequest(res, 'Fetch failed — view', `unknown mode: ${mode} (want ${FETCH_MODES.join('|')})`, `${BASE}${req.originalUrl}`, [`${BASE}/fetch/${id}/debug`], { id })
  }
  const key = `${id}/${mode}`
  const hit = fetchCache.get(key)
  const fresh = req.query.fresh === '1'
  const fail = (e: unknown) => {
    const err = e as { stdout?: string; message?: string }
    const detail = (String(err.stdout ?? '').trim() || err.message || 'error').slice(0, 200)
    const selfUrl = `${BASE}${req.originalUrl}`
    return wrap({
      title: `Fetch failed: ${id}/${mode}`,
      noNext: true,
      body: `# fetch failed: ${id}/${mode}\n\n${detail}` + failureDebug(
        [{ label: `GET ${selfUrl}`, ok: false, detail }],
        [selfUrl, `${BASE}/fetch/${id}/debug`, `${BASE}/fetch/${id}/unconfirmed`, `${BASE}/fetch/${id}/complete`, `${BASE}/fetch/${id}/findings`],
      ),
      meta: { id },
      actions: [`GET ${withCb(`${BASE}/fetch/${id}/debug`, shortCode())} — debug state`],
    })
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
  const cbStamp2 = shortCode()
  body = body.replace(/(https:\/\/[^\s)'"<>]+)/g, (u) =>
    /[?&]cb=/.test(u) ? u : withCb(u, cbStamp2))
  if (mode === 'findings') {
    // Findings doctrine rides along: constraints + job-fit rules, read per-hit.
    try {
      body += "\n\n---\n\n" + readFileSync(path.join(__dirname, '..', '..', 'blurbs', 'findings-doctrine.md'), 'utf8').trim()
    } catch { /* findings stand alone without doctrine */ }
  }
  body = withDebug(req, body)
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — ${mode}`,
    noNext: true,
    body,
    meta: { id },
    actions: [
      `GET ${withCb(`${BASE}/fetch/${id}/unconfirmed`, shortCode())}      — pending bullets + workExperience context`,
      `GET ${withCb(`${BASE}/fetch/${id}/complete`, shortCode())}         — full markdown with green/orange ledger`,
      `GET ${withCb(`${BASE}/fetch/${id}/job-description`, shortCode())}  — posting job bead verbatim`,
    ],
  }))
})

