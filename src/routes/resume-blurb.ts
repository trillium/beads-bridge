// /resume — user-facing assistance page (copyable ChatGPT blurb).
import { Router, Request, Response } from 'express'
import { readFileSync } from 'fs'
import path from 'path'
import { BASE } from '../config'
import { staleRoster, refreshRoster, rosterInflight } from '../resume-cache'
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
  const urls = [`${BASE}/fetch/${resume}/unconfirmed`, `${BASE}/fetch/${resume}/complete`, `${BASE}/fetch/${resume}/job-description`, `${BASE}/fetch/${resume}/done`, `${BASE}/fetch/${resume}/findings`, `${BASE}/fetch/${resume}/debug`]
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
    `Fetch these six pages EXACTLY as written below. Do not modify, shorten,`,
    `or compose these URLs — fetch each literal:`,
    ``,
    ...urls.map((u, i) => `${i + 1}. ${u}`),
    ``,
    `Stale check: every view ends with "data last updated at <iso>". If a stamp looks older than expected, fetch its refresh literal (same content, forced fresh):`,
    ``,
    ...['unconfirmed', 'complete', 'findings'].map((m, i) => `${i + 7}. ${BASE}/fetch/${resume}/${m}?fresh=1`),
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
    `- findings — open verification findings; check these FIRST before bullet work.`,
    `- debug — if ANY fetch fails, go here immediately and follow the debug state directions.`,
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

