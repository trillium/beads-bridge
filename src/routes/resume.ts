// Resume voice-loop routes: /fetch/{resumeId}/{mode} + /resume assistance page.
// MUST be mounted before the /:store and /:id routes (Express matches in order).
import { Router, Request, Response } from 'express'
import { execSync } from 'child_process'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { BASE, RESUME_DOCX_DIR, FETCH_MODES } from '../config'
import { pstr } from '../util'
import { wrap } from '../wrap'

export const resumeRouter = Router()

const execFileAsync = promisify(execFile)

// Short-TTL cache: a fetch fans out to ~50 bead subprocess calls (~60-120s),
// so repeat hits (browser retries, ChatGPT re-fetch) must not re-run it.
// Bead state changes on human timescales; 90s stale is safe. Bypass with ?fresh=1.
const fetchCache = new Map<string, { at: number; body: string }>()
const FETCH_TTL_MS = 90_000

// GET /fetch/{resumeId}/{mode} — deterministic resume views for the voice loop.
// Served from resume-docx get_resume_content() (src/fetch.ts via bin/fetch.ts):
// bead-id in, plain-text out. Modes: unconfirmed (pending bullets +
// workExperience context), complete (full markdown with green/orange ledger +
// directions block), job-description (posting_ref job bead verbatim).

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
  let body: string
  if (hit && Date.now() - hit.at < FETCH_TTL_MS && req.query.fresh !== '1') {
    body = hit.body
  } else {
    try {
      // Async (not execSync): a slow fetch must not block the event loop.
      const { stdout } = await execFileAsync('bun',
        [`${RESUME_DOCX_DIR}/bin/fetch.ts`, id, mode],
        { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
      body = stdout.trim()
      fetchCache.set(key, { at: Date.now(), body })
    } catch (e: unknown) {
      const err = e as { stdout?: string; message?: string }
      return res.type('text/plain').status(502)
        .send(`# fetch failed: ${id}/${mode}\n\n${String(err.stdout ?? '').trim() || err.message || 'error'}`)
    }
  }
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — ${mode}`,
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
resumeRouter.get('/resume', (req: Request, res: Response) => {
  const q = String(req.query.resume ?? '')
  const resume = /^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(q) ? q : 'resumes-zak'
  const urls = [`${BASE}/fetch/${resume}/unconfirmed`, `${BASE}/fetch/${resume}/complete`, `${BASE}/fetch/${resume}/job-description`]
  // Full bead roster: every URL ChatGPT may query must appear verbatim in this
  // blurb (the model can only fetch literals it was given — it cannot compose them).
  let beadUrls: string[] = []
  try {
    const raw = execSync(`bun ${RESUME_DOCX_DIR}/bin/fetch.ts ${resume} urls`,
      { encoding: 'utf8', timeout: 120000 }).trim()
    beadUrls = raw.split('\n').map(l => l.trim()).filter(Boolean)
  } catch { beadUrls = [] }
  const blurb = [
    `# Resume working session — ${resume}`,
    ``,
    `Fetch these three pages EXACTLY as written below. Do not modify, shorten,`,
    `or compose these URLs — fetch each literal:`,
    ``,
    ...urls.map((u, i) => `${i + 1}. ${u}`),
    ``,
    `What they are:`,
    `- unconfirmed — pending bullets only, each with its workExperience context (frame + role + siblings). This is what needs work.`,
    `- complete — full resume markdown with a green/orange ledger plus a directions block listing the orange items.`,
    `- job-description — the posting job bead verbatim (role, duties, requirements).`,
    ``,
    `Then talk me through the orange (pending) bullets one at a time by voice.`,
    `When we agree on new wording for a bullet, output it as a markdown section`,
    `headed exactly ## {bead-id} (for example ## resume_bullets-bqk) with the new`,
    `bead text as the section body. Omit unchanged bullets entirely.`,
    ...(beadUrls.length ? [
      ``,
      `Deeper context — full beads. Fetch any of these literals to query that bead:`,
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

