// Paste routes: user pastes agent output blocks into a form (or POSTs JSON),
// each paste lands as a bead in the chosen store for later AI integration.
import { Router, Request, Response } from 'express'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { BASE } from '../config'
import { withCb, shortCode } from '../util'
import { isWebAgent } from '../agent-detect'

export const pasteRouter = Router()

// Stores the paste form may target (CLI wrapper must exist in PATH).
const PASTE_STORES = ['inbox', 'task', 'resume_bullets', 'stories'] as const

// Exact-text dedupe: sha256(text) -> bead id, persisted as an internal cache.
// The inbox was receiving the same block multiple times; resubmits now resolve
// to the original bead instead of creating a duplicate.
const HASH_CACHE = join(homedir(), 'data', 'inbox', '.paste-hashes.json')
const loadHashes = (): Record<string, string> => {
  try { return JSON.parse(readFileSync(HASH_CACHE, 'utf8')) } catch { return {} }
}
const saveHash = (hash: string, id: string): void => {
  const cache = loadHashes()
  cache[hash] = id
  mkdirSync(dirname(HASH_CACHE), { recursive: true })
  writeFileSync(HASH_CACHE, JSON.stringify(cache, null, 1))
}
const textHash = (text: string): string =>
  createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)

interface InboxItem { id: string; title: string; open: boolean }

async function inboxItems(): Promise<InboxItem[]> {
  try {
    const out = await run('inbox', ['list', '--json'])
    const rows = JSON.parse(out)
    const list = Array.isArray(rows) ? rows : (rows?.issues ?? rows?.rows ?? [])
    return list.map((r: any) => ({
      id: String(r.id ?? r.bead_id ?? ''),
      title: String(r.title ?? '(untitled)'),
      open: String(r.status ?? r.state ?? 'open').toLowerCase() === 'open',
    })).filter((r: InboxItem) => r.id)
  } catch { return [] }
}

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

pasteRouter.get('/paste', async (req: Request, res: Response) => {
  // Agents get the contract as text; browsers get the form UI.
  if (isWebAgent(req.get('user-agent'), req.get('accept'))) {
    const items = await inboxItems()
    return void res.type('text').send([
      `# paste endpoint (agent contract)`,
      ``,
      `POST /paste as JSON {text} (+ optional title) to save a paste as an inbox bead.`,
      `Response: {id, store, url}. Exact-text resubmits return {duplicate: true}.`,
      `GET /paste/list — inbox items as JSON. GET /paste/inbox/{id} — raw bead text.`,
      ``,
      `## inbox (${items.filter(i => i.open).length} open)`,
      ...items.map(i => `- ${i.open ? '○' : '●'} ${i.id} — ${i.title.slice(0, 60)}`),
    ].join('\n'))
  }
  return void res.redirect('/#/paste')
})

pasteRouter.post('/paste', async (req: Request, res: Response) => {
  try {
    // Store is fixed: everything lands in inbox untriaged. The integrator
    // discovers target store, title, and labels from the content itself.
    const store = 'inbox'
    const text = String(req.body?.text ?? '')
    if (!text.trim()) return void res.status(400).json({ error: 'nothing to save — paste text first' })
    const hash = textHash(text)
    const seen = loadHashes()[hash]
    if (seen)
      return void res.json({ id: seen, store, url: `${BASE}/paste/inbox/${seen}`, duplicate: true })
    const title = String(req.body?.title ?? '').trim().slice(0, 120) || deriveTitle(text)
    const args = ['create', title, '--description', text, '--label', 'source:paste', '--label', 'paste:untriaged']
    const out = await run(store, args)
    const id = (out.match(/([a-z_]+-[a-z0-9]+)/) || [])[1] ?? 'unknown'
    if (id !== 'unknown') saveHash(hash, id)
    return void res.json({ id, store, url: `${BASE}/paste/${store}/${id}` })
  } catch (e) {
    res.status(500).type('text').send(`paste failed: ${(e as Error).message}`)
  }
})

// JSON inbox list for live panel refresh.
pasteRouter.get('/paste/list', async (_req: Request, res: Response) => {
  res.json(await inboxItems())
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
