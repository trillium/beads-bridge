// Guidance routes: agent-level resume doctrine as fetchable literals.
// The voice loop references these by URL (ChatGPT can only fetch literals
// it was given), so the doctrine ships as pages, not pasted prose.
import { Router, Request, Response } from 'express'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BASE } from '../config'
import { wrap } from '../wrap'
import { withCb, shortCode } from '../util'

export const guideRouter = Router()

const CV = join(homedir(), 'code', 'cv-generator', 'cv-generator')

// Allowlist only — never serve arbitrary paths.
const GUIDES: Record<string, { file: string; title: string; blurb: string }> = {
  'bullets': {
    file: join(CV, 'docs', 'resume-bullets.md'),
    title: 'How to structure good resume bullets',
    blurb: 'Action → Number → Method, quantification rules, weak styles to kill',
  },
  'questioning': {
    file: join(CV, '.claude', 'commands', 'improve-bullet.md'),
    title: 'How to question the user about work/projects',
    blurb: 'Clarifying-question workflow that extracts proof without fabricating',
  },
  'refine': {
    file: join(CV, '.claude', 'commands', 'evaluate.md'),
    title: 'Refinement rubric (KEEP/REWRITE/CUT verdicts)',
    blurb: 'X-Y-Z compliance, validity check, AI-slop flags, grandma test',
  },
}

export const guideUrls = () =>
  Object.keys(GUIDES).map(name => `${BASE}/guide/${name}`)

export const guideEntries = (): [string, string][] =>
  Object.entries(GUIDES).map(([name, g]) => [`${BASE}/guide/${name}`, `${g.title} — ${g.blurb}`])

// GET /guide — index of available guidance pages (literals only).
guideRouter.get('/guide', (_req: Request, res: Response) => {
  const lines = Object.entries(GUIDES).map(
    ([name, g]) => `${BASE}/guide/${name}  — ${g.title} (${g.blurb})`)
  const cbStamp = shortCode()
  res.type('text/plain').send(wrap({
    title: 'Guidance pages',
    noNext: true,
    body: [`Fetch any literal to load that doctrine:`, ``, ...lines.map(l => l.replace(/(https:\/\/[^\s]+)/, (u) => withCb(u, cbStamp)))].join('\n'),
    actions: Object.keys(GUIDES).map(name => `GET ${withCb(`${BASE}/guide/${name}`, cbStamp)}`),
  }))
})

// GET /guide/{name} — serve the allowlisted file verbatim.
guideRouter.get('/guide/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '')
  const g = GUIDES[name]
  if (!g) {
    return res.type('text/plain').status(404).send(
      `unknown guide: ${name} (want ${Object.keys(GUIDES).join('|')})`)
  }
  try {
    const body = readFileSync(g.file, 'utf8')
    res.type('text/plain').send(wrap({
      title: `Guide: ${g.title}`,
      noNext: true,
      body,
      actions: [`GET ${BASE}/guide  — all guidance pages`],
    }))
  } catch {
    res.type('text/plain').status(502).send(`# guide unavailable: ${name}`)
  }
})
