// Resume voice-loop routes: /fetch/{resumeId}/{mode} + /resume assistance page.
// MUST be mounted before the /:store and /:id routes (Express matches in order).
import { Router, Request, Response } from 'express'
import { readFileSync } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { BASE, RESUME_DOCX_DIR, FETCH_MODES } from '../config'
import { pstr } from '../util'
import { wrap } from '../wrap'
import { guideEntries } from './guide'

export const resumeRouter = Router()

// ?debug=1 appends output-wrapping guidance: instructs the consumer to return
// its markdown inside one copyable fenced block (one-tap lift on the phone).
const F = String.fromCharCode(96).repeat(3)
const DEBUG_BLOCK = [
  ``,
  `## debug — we are in a debug state`,
  `Wrap your COMPLETE output for this turn in one single markdown block:`,
  ``,
  `${F}markdown`,
  `## steps taken`,
  `- (what you did, in order)`,
  `## expected`,
  `- (what you expected each step to do)`,
  `## results`,
  `- worked: ...`,
  `- did not work: ...`,
  `## improvements / questions`,
  `- (anything you observed, plus any questions — always include this section, even if empty)`,
  `## agreed changes (if any)`,
  `## {bead-id}`,
  `new bead text here`,
  `${F}`,
  ``,
  `One fenced block total, language tag markdown, nothing outside it except a one-line summary before it.`,
].join('\n')
const withDebug = (req: { query: unknown }, body: string) =>
  (req.query as Record<string, unknown>).debug !== undefined ? body + DEBUG_BLOCK : body



const execFileAsync = promisify(execFile)

// Stale-while-revalidate: a fetch fans out to ~50 bead subprocess calls
// (~60-120s), so every hit serves the cache immediately (even stale) while a
// background refresh keeps it fresh. Bead state changes on human timescales.
// ?fresh=1 forces a refresh-and-wait instead.
const fetchCache = new Map<string, { at: number; body: string }>()
const FETCH_TTL_MS = 90_000
const inflight = new Set<string>()

// Roster cache (bead URL lists for the index + blurb): same SWR pattern.
// The urls fan-out costs as much as a mode fetch, so it gets the same treatment.
const rosterCache = new Map<string, { at: number; urls: string[] }>()
const rosterInflight = new Set<string>()

async function refreshRoster(id: string): Promise<string[]> {
  const { stdout } = await execFileAsync('bun',
    [`${RESUME_DOCX_DIR}/bin/fetch.ts`, id, 'urls'],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
  const urls = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
  rosterCache.set(id, { at: Date.now(), urls })
  return urls
}

/** Serve the roster instantly (even stale); refresh in background. Null = none yet. */
function staleRoster(id: string, fresh: boolean): string[] | null {
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

async function refreshFetch(key: string, id: string, mode: string): Promise<string> {
  const { stdout } = await execFileAsync('bun',
    [`${RESUME_DOCX_DIR}/bin/fetch.ts`, id, mode],
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
  const indexBody = [coaching, ``,
      `Pick a view — fetch its URL exactly as written:`, ``,
      ...modes.map(([m, d]) => `${BASE}/fetch/${id}/${m}  — ${d}`),
      ``, `Guidance — doctrine for this loop (fetch any literal):`, ``,
      ...guideEntries().map(([u, d]) => `${u}  — ${d}`),
      ...(beadUrls.length ? [``, `Deeper context — full beads (fetch any literal):`, ``,
        `${BASE}/beads/${beadUrls.map(u => u.split('/').pop()).join('+')}  — everything at once`,
        ``, ...beadUrls] : [])].join('\n')
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — views`,
    noNext: true,
    body: withDebug(req, indexBody),
    meta: { id },
    actions: modes.map(([m]) => `GET ${BASE}/fetch/${id}/${m}`),
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
  body = withDebug(req, body)
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — ${mode}`,
    noNext: true,
    body,
    meta: { id },
    actions: [
      `GET ${BASE}/fetch/${id}/unconfirmed      — pending bullets + workExperience context`,
      `GET ${BASE}/fetch/${id}/complete         — full markdown with green/orange ledger`,
      `GET ${BASE}/fetch/${id}/job-description  — posting job bead verbatim`,
    ],
  }))
})

// GET /resume — user-facing assistance page for the resume voice loop.
// Flow: user opens this page, copies the blurb, pastes it into ChatGPT.
// The blurb contains exact literal fetch URLs (the model cannot compose URLs
// on its own — it can only fetch literals it was given), so ChatGPT can then
// safely fetch the session's pages itself and talk through them.
resumeRouter.get('/resume', async (req: Request, res: Response) => {
  const q = String(req.query.resume ?? '')
  const resume = /^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(q) ? q : 'resumes-zak'
  const urls = [`${BASE}/fetch/${resume}/unconfirmed`, `${BASE}/fetch/${resume}/complete`, `${BASE}/fetch/${resume}/job-description`, `${BASE}/fetch/${resume}/done`]
  // Full bead roster: every URL ChatGPT may query must appear verbatim in this
  // blurb (the model can only fetch literals it was given — it cannot compose them).
  // Served stale-while-revalidate like the index: instant blurb, fresh roster behind.
  let beadUrls = staleRoster(resume, req.query.fresh === '1')
  if (!beadUrls) {
    try { beadUrls = await refreshRoster(resume) }
    catch { beadUrls = [] }
    finally { rosterInflight.delete(resume) }
  }
  const blurb = [
    `# Resume working session — ${resume}`,
    ``,
    `Fetch these four pages EXACTLY as written below. Do not modify, shorten,`,
    `or compose these URLs — fetch each literal:`,
    ``,
    ...urls.map((u, i) => `${i + 1}. ${u}`),
    ``,
    `Guidance doctrine for this loop (fetch any literal when you need it):`,
    ``,
    ...guideEntries().map(([u, d]) => `${u}  — ${d}`),
    ``,
    `What they are:`,
    `- unconfirmed — pending bullets only, each with its workExperience context (frame + role + siblings). This is what needs work.`,
    `- complete — full resume markdown with a green/orange ledger plus a directions block listing the orange items.`,
    `- job-description — the posting job bead verbatim (role, duties, requirements).`,
    `- done — the exact output format to use when returning agreed changes.`,
    ``,
    `Then talk me through the orange (pending) bullets one at a time by voice.`,
    `When we agree on new wording for a bullet, output it as a markdown section`,
    `headed exactly ## {bead-id} (for example ## resume_bullets-bqk) with the new`,
    `bead text as the section body. Omit unchanged bullets entirely.`,
    ...(beadUrls.length ? [
      ``,
      `Deeper context — full beads. Fetch any of these literals to query that bead.`,
      `For everything at once, fetch this single literal:`,
      ``,
      `${BASE}/beads/${beadUrls.map(u => u.split('/').pop()).join('+')}`,
      ``,
      ...beadUrls,
    ] : [
      ``,
      `(Bead roster unavailable — ask the user for the bead id, or fetch the complete view.)`,
    ]),
  ].join('\n')
  const esc = blurb.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  res.type('text/html').send(
    `<!doctype html><html><head><meta charset=utf-8><title>Resume session blurb</title>` +
    `<style>body{font-family:system-ui;margin:2em;max-width:60em}pre{background:#f4f4f4;padding:1em;white-space:pre-wrap}button{font-size:1.1em;padding:.5em 1em}</style></head><body>` +
    `<h1>Resume working session — ${resume}</h1>` +
    `<p>Copy the blurb, switch to ChatGPT, paste it. ChatGPT fetches the listed pages itself.</p>` +
    `<button onclick="navigator.clipboard.writeText(document.getElementById('b').innerText).then(()=>{this.innerText='Copied!'})">Copy blurb</button>` +
    `<pre id="b">${esc}</pre></body></html>`)
})

