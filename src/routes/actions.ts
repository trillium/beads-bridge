// Tool bridge — structured JSON writes for GPT Actions/Assistants
// (bearer-token auth, idempotent mutations, closed label vocabulary).
import express, { Router } from 'express'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import { toolKey, STORES, fillTokens } from '../config'
import { bd, storeFromId } from '../util'

export const actionsRouter = Router()
actionsRouter.use(express.json())

// ── Tool bridge — structured writes for GPT Actions/Assistants ────────────────
// The web-fetch URL-eligibility rule disappears when the platform calls these
// endpoints directly with structured JSON (no URL is composed by the model).

const requireToolKey: RequestHandler =
  (req: Request, res: Response, next: NextFunction) => {
    const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (auth === toolKey) return next()
    res.status(401).json({ ok: false, error: 'unauthorized' })
  }

// Closed label vocabulary — the Action enum is the source of truth for clients.
const LABEL_VOCAB = ['triaged', 'ready', 'human']

// Resolve {bead_id} → store route; 400 if unknown/unparseable.
const toolTarget = (res: Response, id: unknown): string | null => {
  const bead = typeof id === 'string' ? id : ''
  const store = storeFromId(bead)
  if (!bead || !store) {
    res.status(400).json({ ok: false, error: `unknown bead id: ${bead || '(missing)'}` })
    return null
  }
  return store
}

// Idempotency: mutating calls may carry {idempotency_key}; replays get the
// original response back instead of re-running the mutation.
const idemStore = new Map<string, { at: number; body: unknown }>()
const idempotent = (res: Response, key: unknown, build: () => unknown): unknown => {
  const k = typeof key === 'string' && key.length >= 4 && key.length <= 128 ? key : ''
  if (!k) return build()
  const hit = idemStore.get(k)
  if (hit) { res.json(hit.body); return null }
  const body = build()
  idemStore.set(k, { at: Date.now(), body })
  return body
}
setInterval(() => { // prune entries older than 24h
  const cutoff = Date.now() - 86_400_000
  for (const [k, v] of idemStore) if (v.at < cutoff) idemStore.delete(k)
}, 3_600_000).unref()

// One-line heading: "○ review-fmt · …   [● P1 · OPEN]" → {title, priority, state}
function beadStatus(header: string): { title: string; priority: string; state: string } {
  const m = header.match(/^\S+\s+\S+\s+([\s\S]*?)\s+\[●\s*(P\d)\s*·\s*([A-Z]+)\s*\]$/)
  if (m) return { title: m[1].replace(/^·\s+/, ''), priority: m[2], state: m[3] }
  const c = header.match(/^\S+\s+\S+\s+([\s\S]*?)\s+\[●\s*([A-Z]+)\s*\]$/)
  if (c) return { title: c[1].replace(/^·\s+/, ''), priority: '', state: c[2] }
  return { title: header.replace(/^·\s+/, ''), priority: '', state: 'OPEN' }
}

const WRITE_ACTIONS = ['comment', 'note', 'approve', 'reject', 'done', 'label']

function actionSummary(storeId: string, id: string): {
  bead_id: string; store: string; title: string; state: string; priority: string
  labels: string[]; comments: string; available_actions: string[]
} {
  const show = bd(storeId, `show ${id}`)
  const head = show.split('\n', 1)[0] ?? ''
  const { title, priority, state } = beadStatus(head)
  const labelRaw = bd(storeId, `label list ${id}`)
  const labels = [...labelRaw.matchAll(/^\s*-\s*(.+)$/gm)].map(m => m[1].trim())
  const comments = bd(storeId, `comments ${id}`)
  const open = state.toUpperCase() === 'OPEN'
  return {
    bead_id: id, store: storeId, title, state: state.toLowerCase(), priority,
    labels, comments,
    available_actions: open ? WRITE_ACTIONS : ['comment', 'note'],
  }
}

interface ToolBody { bead_id?: unknown; text?: unknown; add?: unknown; remove?: unknown; idempotency_key?: unknown }

actionsRouter.get('/action/next', requireToolKey, (_req: Request, res: Response) => {
  const queueOrder = ['review', ...STORES.filter(s => s !== 'review')]
  for (const store of queueOrder) {
    try {
      const raw = execSync(
        `${store} list --label human --state open --limit 10 --priority P0 --exclude-label triaged --exclude-label ready 2>/dev/null`,
        { encoding: 'utf8', timeout: 8000 }
      ).trim()
      if (!raw) continue
      const id = raw.match(/\b([a-z_]+-[a-z0-9]+)\b/)?.[1]
      if (!id) continue
      return res.json({ ok: true, ...actionSummary(store, id) })
    } catch { continue }
  }
  res.json({ ok: true, bead_id: null, state: 'none', available_actions: [] })
})

actionsRouter.get('/action/bead', requireToolKey, (req: Request, res: Response) => {
  const store = toolTarget(res, req.query.bead_id)
  if (typeof store !== 'string') return
  res.json({ ok: true, ...actionSummary(store, String(req.query.bead_id)) })
})

actionsRouter.post('/action/comment', requireToolKey, (req: Request, res: Response) => {
  const b = req.body as ToolBody
  const store = toolTarget(res, b.bead_id)
  if (!store) return
  const text = typeof b.text === 'string' ? b.text : ''
  if (!text) return res.status(400).json({ ok: false, error: 'missing text' })
  const run = () => {
    bd(store, `comment ${b.bead_id} "${text.replace(/"/g, '\\"')}"`)
    return { ok: true, ...actionSummary(store, String(b.bead_id)), wrote: 'comment' }
  }
  const out = idempotent(res, b.idempotency_key, run)
  if (out) res.json(out)
})

actionsRouter.post('/action/note', requireToolKey, (req: Request, res: Response) => {
  const b = req.body as ToolBody
  const store = toolTarget(res, b.bead_id)
  if (!store) return
  const text = typeof b.text === 'string' ? b.text : ''
  if (!text) return res.status(400).json({ ok: false, error: 'missing text' })
  const run = () => {
    bd(store, `note ${b.bead_id} "${text.replace(/"/g, '\\"')}"`)
    return { ok: true, ...actionSummary(store, String(b.bead_id)), wrote: 'note' }
  }
  const out = idempotent(res, b.idempotency_key, run)
  if (out) res.json(out)
})

function stateTransition(req: Request, res: Response, verb: string, close: boolean) {
  const b = req.body as ToolBody
  const store = toolTarget(res, b.bead_id)
  if (!store) return
  const id = String(b.bead_id)
  const before = actionSummary(store, id)
  if (before.state !== 'open') {
    return res.status(409).json({ ok: false, error: `bead is ${before.state}, not open`, ...before })
  }
  const run = () => {
    const ts = new Date().toISOString()
    bd(store, `comment ${id} "${verb} via tool bridge ${ts}"`)
    if (close) bd(store, `close ${id}`)
    return { ok: true, ...actionSummary(store, id), transitioned: verb }
  }
  const out = idempotent(res, b.idempotency_key, run)
  if (out) res.json(out)
}

actionsRouter.post('/action/approve', requireToolKey, (req: Request, res: Response) => stateTransition(req, res, 'Approved', true))
actionsRouter.post('/action/reject', requireToolKey, (req: Request, res: Response) => stateTransition(req, res, 'Rejected', false))
actionsRouter.post('/action/done', requireToolKey, (req: Request, res: Response) => stateTransition(req, res, 'Handled', true))

actionsRouter.post('/action/label', requireToolKey, (req: Request, res: Response) => {
  const b = req.body as ToolBody
  const store = toolTarget(res, b.bead_id)
  if (!store) return
  const id = String(b.bead_id)
  const add = typeof b.add === 'string' ? b.add : ''
  const remove = typeof b.remove === 'string' ? b.remove : ''
  if (!add && !remove) return res.status(400).json({ ok: false, error: 'missing add or remove' })
  for (const l of [add, remove]) {
    if (l && !LABEL_VOCAB.includes(l)) {
      return res.status(400).json({ ok: false, error: `label '${l}' not in vocabulary: ${LABEL_VOCAB.join(', ')}` })
    }
  }
  const run = () => {
    if (add)    bd(store, `label add ${id} ${add}`)
    if (remove) bd(store, `label remove ${id} ${remove}`)
    return { ok: true, ...actionSummary(store, id), wrote: `label ${add ? 'add:' + add : ''} ${remove ? 'remove:' + remove : ''}`.trim() }
  }
  const out = idempotent(res, b.idempotency_key, run)
  if (out) res.json(out)
})

actionsRouter.get('/actions/openapi.json', (_req: Request, res: Response) => {
  res.type('application/json').send(fillTokens(
    readFileSync(path.join(__dirname, '..', '..', 'actions', 'openapi.json'), 'utf8')
  ))
})

// 404
