// Paste routes: user pastes agent output blocks into a form (or POSTs JSON),
// each paste lands as a bead in the chosen store for later AI integration.
import { Router, Request, Response } from 'express'
import { execFile } from 'child_process'
import { BASE } from '../config'
import { withCb, shortCode } from '../util'

export const pasteRouter = Router()

// Stores the paste form may target (CLI wrapper must exist in PATH).
const PASTE_STORES = ['inbox', 'task', 'resume_bullets', 'stories'] as const

const FORM = (msg: string) => `<!doctype html><html><body>
<h2>Paste → bead</h2>
${msg ? `<p><b>${msg}</b></p>` : ``}
<p>Paste the block and submit — nothing else to fill in. The integrator tool discovers
store, title, and labels from the content itself.</p>
<form method="post" action="/paste">
<textarea name="text" rows="20" cols="90" placeholder="paste the agent block here"></textarea><br><br>
<button type="submit">Save paste</button>
</form></body></html>`

// Title is derived, never asked: first non-empty line, truncated.
const deriveTitle = (text: string): string => {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  const clean = line.replace(/^#+\s*/, '').slice(0, 80)
  return clean || `pasted block ${new Date().toISOString().slice(0, 10)}`
}

const run = (store: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(store, args, { timeout: 30000 }, (e, so, se) =>
      e ? reject(new Error(String(se || e.message))) : resolve(so)))

pasteRouter.get('/paste', (_req: Request, res: Response) => {
  res.type('html').send(FORM(''))
})

pasteRouter.post('/paste', async (req: Request, res: Response) => {
  try {
    // Store is fixed: everything lands in inbox untriaged. The integrator
    // discovers target store, title, and labels from the content itself.
    const store = 'inbox'
    const text = String(req.body?.text ?? '')
    if (!text.trim()) return void res.type('html').send(FORM('nothing to save — paste text first'))
    const title = String(req.body?.title ?? '').trim().slice(0, 120) || deriveTitle(text)
    const args = ['create', title, '--description', text, '--label', 'source:paste', '--label', 'paste:untriaged']
    const out = await run(store, args)
    const id = (out.match(/([a-z_]+-[a-z0-9]+)/) || [])[1] ?? 'unknown'
    if ((req.headers.accept ?? '').includes('application/json'))
      return void res.json({ id, store, url: `${BASE}/paste/${store}/${id}` })
    res.type('html').send(FORM(`saved bead ${id} — retrieve at <a href="/paste/${store}/${id}">${store}/${id}</a>`))
  } catch (e) {
    res.status(500).type('text').send(`paste failed: ${(e as Error).message}`)
  }
})

// Raw bead text for the integrator agent.
pasteRouter.get('/paste/:store/:id', async (req: Request, res: Response) => {
  try {
    const store = String(req.params.store); const id = String(req.params.id)
    if (!PASTE_STORES.includes(store as typeof PASTE_STORES[number]))
      return void res.status(404).type('text').send('unknown store')
    res.type('text').send(await run(store, ['show', id]))
  } catch (e) {
    res.status(500).type('text').send(`retrieve failed: ${(e as Error).message}`)
  }
})

export const pasteUrl = () => withCb(`${BASE}/paste`, shortCode())
