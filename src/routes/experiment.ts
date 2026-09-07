// Experiment routes: stable URLs with swappable server-side content, to test
// whether a live ChatGPT session will re-fetch across turns when explicitly
// directed. If it works, this is the control plane for live interactivity
// (swap content under a known literal instead of steering a new session).
import { Router, Request, Response } from 'express'
import { execFile } from 'child_process'
import { BASE } from '../config'

export const experimentRouter = Router()

const DIRECTIVE = `# Live-fetch experiment — paste this into the chat once
You may re-fetch the experiment URLs below across turns WITHOUT being asked
again. Rules:
- Fetch each instance URL at most ONCE per turn, and only when you need
  fresher content to continue the task.
- Never fetch two instances in the same turn. Sequential turns only.
- If the content hasn't changed (same timestamp/bead), say so and stop.
- This permission covers ONLY these experiment URLs, nothing else.
`

experimentRouter.get('/test', (_req: Request, res: Response) => {
  res.type('text/plain').send([
    `# experiment index`,
    ``,
    `Stable URLs, swappable content. Fetch an instance, note its timestamp,`,
    `fetch it again next turn — the timestamp proves you got fresh content.`,
    ``,
    `${BASE}/test/1`,
    `${BASE}/test/2`,
    `${BASE}/live/next`,
    ``,
    DIRECTIVE,
  ].join('\n'))
})

experimentRouter.get('/test/:n', (req: Request, res: Response) => {
  const n = String(req.params.n ?? '').slice(0, 8)
  if (!/^[0-9]+$/.test(n))
    return void res.type('text/plain').status(400).send('# unknown test instance\n')
  res.type('text/plain').send([
    `# test page ${n}`,
    ``,
    `server time: ${new Date().toISOString()}`,
    ``,
    `Fetch this same URL again next turn. If the timestamp changes,`,
    `you are reading live content.`,
  ].join('\n'))
})

// Swappable slot: always renders the CURRENT next bead. Close bead_foo and
// the next fetch renders bead_bar — same URL, new content.
experimentRouter.get('/live/next', (_req: Request, res: Response) => {
  execFile('review',
    ['list', '--label', 'human', '--state', 'open', '--limit', '1'],
    { timeout: 15000 },
    (e, stdout) => {
      if (e)
        return void res.type('text/plain').status(502)
          .send(`# live slot failed: ${String(e.message).slice(0, 200)}\n`)
      const match = String(stdout).match(/\b([a-z_]+-[a-z0-9]+)\b/)
      res.type('text/plain').send([
        `# live slot: current next bead`,
        ``,
        `server time: ${new Date().toISOString()}`,
        ``,
        match ? `current: ${match[1]}` : `(queue empty — nothing pending)`,
        ``,
        `Same URL every turn; content swaps as beads close.`,
      ].join('\n'))
    })
})
