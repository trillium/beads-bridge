// /resume — user-facing assistance page (copyable ChatGPT blurb).
import { Router, Request, Response } from 'express'
import { readFileSync } from 'fs'
import path from 'path'
import { BASE } from '../config'
import { staleRoster, refreshRoster, rosterInflight } from '../resume-cache'
import { withCb, shortCode } from '../util'
import { guideEntries } from './guide'

export const resumeBlurbRouter = Router()

// GET /resume — user-facing assistance page for the resume voice loop.
// Flow: user opens this page, copies the blurb, pastes it into ChatGPT.
// The blurb contains exact literal fetch URLs (the model cannot compose URLs
// on its own — it can only fetch literals it was given), so ChatGPT can then
// safely fetch the session's pages itself and talk through them.
resumeBlurbRouter.get('/resume', async (req: Request, res: Response) => {
  const q = String(req.query.resume ?? '')
  const resume = /^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(q) ? q : 'resumes-zak'
  const urls = [`${BASE}/fetch/${resume}/unconfirmed`, `${BASE}/fetch/${resume}/complete`, `${BASE}/fetch/${resume}/job-description`, `${BASE}/fetch/${resume}/done`, `${BASE}/fetch/${resume}/findings`, `${BASE}/fetch/${resume}/debug`, `${BASE}/fetch/${resume}/stories`]
  // Full bead roster: every URL ChatGPT may query must appear verbatim in this
  // blurb (the model can only fetch literals it was given — it cannot compose them).
  // Served stale-while-revalidate like the index: instant blurb, fresh roster behind.
  let beadUrls = staleRoster(resume, req.query.fresh === '1')
  if (!beadUrls) {
    try { beadUrls = await refreshRoster(resume) }
    catch { beadUrls = [] }
    finally { rosterInflight.delete(resume) }
  }
  const cbStamp = shortCode()
  const cb = (x: string) => withCb(x, cbStamp)
  const urlsList = urls.map((u, i) => `${i + 1}. ${cb(u)}`).join('\n')
  const refreshList = ['unconfirmed', 'complete', 'findings'].map((m, i) => `${i + 7}. ${BASE}/fetch/${resume}/${m}?fresh=1`).join('\n')
  const guidesList = guideEntries().map(([u, d]) => `${cb(u)}  — ${d}`).join('\n')
  const rosterBlock = beadUrls.length ? [
    `Deeper context — full beads. Fetch any of these literals to query that bead.`,
    `For everything at once, fetch this single literal:`,
    ``,
    `${cb(`${BASE}/beads/${beadUrls.map(u => u.split('/').pop()).join('+')}`)}`,
    ``,
    ...beadUrls.map(u => cb(u)),
  ].join('\n') : `(Bead roster unavailable — ask the user for the bead id, or fetch the complete view.)`
  const template = readFileSync(path.join(__dirname, '..', '..', 'blurbs', 'resume-session.md'), 'utf8')
  const blurb = template
    .replace('{{RESUME}}', resume)
    .replace('{{URLS}}', urlsList)
    .replace('{{REFRESH}}', refreshList)
    .replace('{{GUIDES}}', guidesList)
    .replace('{{ROSTER}}', rosterBlock)
  const esc = blurb.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  res.type('text/html').send(
    `<!doctype html><html><head><meta charset=utf-8><title>Resume session blurb</title>` +
    `<style>body{font-family:system-ui;margin:2em;max-width:60em}pre{background:#f4f4f4;padding:1em;white-space:pre-wrap}button{font-size:1.1em;padding:.5em 1em}</style></head><body>` +
    `<h1>Resume working session — ${resume}</h1>` +
    `<p>Copy the blurb, switch to ChatGPT, paste it. ChatGPT fetches the listed pages itself.</p>` +
    `<button onclick="navigator.clipboard.writeText(document.getElementById('b').innerText).then(()=>{this.innerText='Copied!'})">Copy blurb</button>` +
    `<pre id="b">${esc}</pre></body></html>`)
})

