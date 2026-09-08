// Bead decision verbs over GET (pass web-fetch safety filters):
// comment, note, approve, reject, done, close, label.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { BASE } from '../config'
import { qstr, pstr, bd, storeFromId } from '../util'
import { wrap } from '../wrap'

export const mountOrder = 10
export const verbsRouter = Router()

// GET /{bead-id}/comment
verbsRouter.get('/:id/comment', (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const payload = qstr(req.query.text ?? req.query.t)
  if (!payload) return res.type('text/plain').status(400).send('Missing ?text= (or ?t=) param')

  const out = bd(store, `comment ${id} "${payload.replace(/"/g, '\\"')}"`)
  res.type('text/plain').send(wrap({
    title: `Commented on ${id}`,
    body: out,
    meta: { store, id },
    actions: [`GET ${BASE}/next?cache=<server-issued-tag> — continue to next item`]
  }))
})

// GET /{bead-id}/note
verbsRouter.get('/:id/note', (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const payload = qstr(req.query.text ?? req.query.t)
  if (!payload) return res.type('text/plain').status(400).send('Missing ?text= (or ?t=) param')

  const out = bd(store, `note ${id} "${payload.replace(/"/g, '\\"')}"`)
  res.type('text/plain').send(wrap({
    title: `Note added to ${id}`,
    body: out,
    meta: { store, id },
    actions: [`GET ${BASE}/next?cache=<server-issued-tag> — continue to next item`]
  }))
})

// No-payload decision verbs — clean URLs that pass web-fetch safety filters.
// GET /{bead-id}/approve — comment + close
verbsRouter.get('/:id/approve', (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const ts = new Date().toISOString()
  const out = bd(store, `comment ${id} "Approved via beads-bridge ${ts}"`)
  bd(store, `close ${id}`)
  res.type('text/plain').send(wrap({
    title: `Approved + closed ${id}`,
    body: out,
    meta: { store, id },
  }))
})

// GET /{bead-id}/reject — comment, stays open
verbsRouter.get('/:id/reject', (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const ts = new Date().toISOString()
  const out = bd(store, `comment ${id} "Rejected via beads-bridge ${ts}"`)
  res.type('text/plain').send(wrap({
    title: `Rejected ${id}`,
    body: out,
    meta: { store, id },
  }))
})

// GET /{bead-id}/done — comment + close (generic handled)
verbsRouter.get('/:id/done', (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const ts = new Date().toISOString()
  const out = bd(store, `comment ${id} "Handled via beads-bridge ${ts}"`)
  bd(store, `close ${id}`)
  res.type('text/plain').send(wrap({
    title: `Handled + closed ${id}`,
    body: out,
    meta: { store, id },
  }))
})

// GET /{bead-id}/close
verbsRouter.get('/:id/close', (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const out = bd(store, `close ${id}`)
  res.type('text/plain').send(wrap({
    title: `Closed ${id}`,
    body: out,
    meta: { store, id },
    actions: [`GET ${BASE}/next?cache=<server-issued-tag> — continue to next item`]
  }))
})

// GET /{bead-id}/label
verbsRouter.get('/:id/label', (req: Request, res: Response, next: NextFunction) => {
  const id = pstr(req.params.id)
  const store = storeFromId(id)
  if (!store) return next()

  const add = qstr(req.query.add)
  const remove = qstr(req.query.remove)
  if (!add && !remove) return res.type('text/plain').status(400).send('Missing ?add= or ?remove= param')

  const results: string[] = []
  if (add)    results.push(bd(store, `label add ${id} ${add}`))
  if (remove) results.push(bd(store, `label remove ${id} ${remove}`))

  res.type('text/plain').send(wrap({
    title: `Labels updated on ${id}`,
    body: results.join('\n'),
    meta: { store, id },
    actions: [`GET ${BASE}/next?cache=<server-issued-tag> — continue to next item`]
  }))
})

