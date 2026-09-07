// /resume — user-facing assistance page (copyable ChatGPT blurb).
import { Router, Request, Response } from 'express'
import { readFileSync } from 'fs'
import path from 'path'
import { BASE } from '../config'
import { staleRoster, refreshRoster, rosterInflight } from '../resume-cache'
import { withCb, shortCode } from '../util'
import { guideEntries } from './guide'
import { isWebAgent } from '../agent-detect'

export const mountOrder = -20
export const resumeBlurbRouter = Router()

// GET /resume — user-facing assistance page for the resume voice loop.
// Flow: user opens this page, copies the blurb, pastes it into ChatGPT.
// The blurb contains exact literal fetch URLs (the model cannot compose URLs
// on its own — it can only fetch literals it was given), so ChatGPT can then
// safely fetch the session's pages itself and talk through them.
// Single path: /resume/:id. The ?resume= query variant is dismantled —
// one way to address the blurb, matching /fetch/:id convention.
const resumeIdFrom = (req: Request): string => {
  const q = String(req.params.id ?? '')
  return /^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(q) ? q : 'resumes-zak'
}
resumeBlurbRouter.get('/resume/:id', async (req: Request, res: Response) => {
  const resume = resumeIdFrom(req)
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
  // Agents get the raw blurb as text; browsers use the SPA copy page.
  if (isWebAgent(req.get('user-agent'), req.get('accept')))
    return void res.type('text/plain').send(blurb)
  return void res.redirect(`/#/resume?resume=${resume}`)
})

