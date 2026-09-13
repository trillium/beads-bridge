// Bead decision verbs over GET (pass web-fetch safety filters):
// comment, note, approve, reject, done, close, label. Mutations run over
// shell-free argv (see lib/mutate) and failures answer 500 — never 200
// with error text mistaken for success.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { BASE } from '../config'
import { qstr, pstr, storeFromId } from '../util'
import { closeBead, commentBead, formatReceipt, labelBead, noteBead } from '../lib/mutate'
import { wrap } from '../wrap'

export const mountOrder = 10
export const verbsRouter = Router()

const failed = (res: Response, title: string, e: unknown, meta: { store: string; id: string }) =>
  res.type('text/plain').status(500).send(wrap({
    title,
    body: `FAILED: ${e instanceof Error ? e.message : String(e)}`,
    meta,
  }))

// GET /{bead-id}/comment
verbsRouter.get('/:id/comment', async (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const payload = qstr(req.query.text ?? req.query.t)
  if (!payload) return res.type('text/plain').status(400).send('Missing ?text= (or ?t=) param')

  try {
    const r = await commentBead(store, id, payload)
    res.type('text/plain').send(wrap({
      title: `Commented on ${id}`,
      body: formatReceipt(r),
      meta: { store, id },
      actions: [`GET ${BASE}/next?cache=<server-issued-tag> — continue to next item`]
    }))
  } catch (e) {
    failed(res, `Comment failed — ${id}`, e, { store, id })
  }
})

// GET /{bead-id}/note
verbsRouter.get('/:id/note', async (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const payload = qstr(req.query.text ?? req.query.t)
  if (!payload) return res.type('text/plain').status(400).send('Missing ?text= (or ?t=) param')

  try {
    const r = await noteBead(store, id, payload)
    res.type('text/plain').send(wrap({
      title: `Note added to ${id}`,
      body: formatReceipt(r),
      meta: { store, id },
      actions: [`GET ${BASE}/next?cache=<server-issued-tag> — continue to next item`]
    }))
  } catch (e) {
    failed(res, `Note failed — ${id}`, e, { store, id })
  }
})

// No-payload decision verbs — clean URLs that pass web-fetch safety filters.
// GET /{bead-id}/approve — comment + close
verbsRouter.get('/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const ts = new Date().toISOString()
  try {
    await commentBead(store, id, `Approved via beads-bridge ${ts}`)
    const r = await closeBead(store, id)
    res.type('text/plain').send(wrap({
      title: `Approved + closed ${id}`,
      body: formatReceipt({ ...r, operation: 'approved + closed' }),
      meta: { store, id },
    }))
  } catch (e) {
    failed(res, `Approve failed — ${id}`, e, { store, id })
  }
})

// GET /{bead-id}/reject — comment, stays open
verbsRouter.get('/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const ts = new Date().toISOString()
  try {
    const r = await commentBead(store, id, `Rejected via beads-bridge ${ts}`)
    res.type('text/plain').send(wrap({
      title: `Rejected ${id}`,
      body: formatReceipt({ ...r, operation: 'rejected' }),
      meta: { store, id },
    }))
  } catch (e) {
    failed(res, `Reject failed — ${id}`, e, { store, id })
  }
})

// GET /{bead-id}/done — comment + close (generic handled)
verbsRouter.get('/:id/done', async (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const ts = new Date().toISOString()
  try {
    await commentBead(store, id, `Handled via beads-bridge ${ts}`)
    const r = await closeBead(store, id)
    res.type('text/plain').send(wrap({
      title: `Handled + closed ${id}`,
      body: formatReceipt({ ...r, operation: 'handled + closed' }),
      meta: { store, id },
    }))
  } catch (e) {
    failed(res, `Done failed — ${id}`, e, { store, id })
  }
})

// GET /{bead-id}/close
verbsRouter.get('/:id/close', async (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  try {
    const r = await closeBead(store, id)
    res.type('text/plain').send(wrap({
      title: `Closed ${id}`,
      body: formatReceipt(r),
      meta: { store, id },
      actions: [`GET ${BASE}/next?cache=<server-issued-tag> — continue to next item`]
    }))
  } catch (e) {
    failed(res, `Close failed — ${id}`, e, { store, id })
  }
})

// GET /{bead-id}/label
verbsRouter.get('/:id/label', async (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const add = qstr(req.query.add)
  const remove = qstr(req.query.remove)
  if (!add && !remove) return res.type('text/plain').status(400).send('Missing ?add= or ?remove= param')

  try {
    const r = await labelBead(store, id, { add, remove })
    res.type('text/plain').send(wrap({
      title: `Labels updated on ${id}`,
      body: formatReceipt(r),
      meta: { store, id },
      actions: [`GET ${BASE}/next?cache=<server-issued-tag> — continue to next item`]
    }))
  } catch (e) {
    failed(res, `Label failed — ${id}`, e, { store, id })
  }
})

