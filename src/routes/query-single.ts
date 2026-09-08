// Single-store label query: GET /q/:store. Mounted before readRouter's
// /:store catchall. AND labels via repeated ?label=, OR via ?any=.
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { BASE, STORES } from '../config'
import { pstr, withCb, shortCode } from '../util'
import { wrap } from '../wrap'
import { withDebug, failureDebug } from './debug-state'
import { warmBundle } from './beads'
import { LABEL_RE, MAX_LABELS, strParam, listParam, cleanLabel } from './query/params'
import { runList } from './query/store'
import { formatSection } from './query/format'

export const mountOrder = -15
export const singleQueryRouter = Router()

// GET /q/:store — single-store label query.
singleQueryRouter.get('/q/:store', (req: Request, res: Response, next: NextFunction) => {
  const store = pstr(req.params.store)
  if (!STORES.includes(store)) return next()

  const all = listParam(req.query.label).map(cleanLabel).filter((x): x is string => !!x).slice(0, MAX_LABELS)
  const any = listParam(req.query.any).map(cleanLabel).filter((x): x is string => !!x).slice(0, MAX_LABELS)
  const exclude = listParam(req.query.exclude).map(cleanLabel).filter((x): x is string => !!x).slice(0, MAX_LABELS)
  const badLabels = listParam([req.query.label, req.query.any, req.query.exclude]).filter((l) => !cleanLabel(l))
  const selfUrl = `${BASE}${req.originalUrl}`
  if (badLabels.length) {
    const msg = `# bad label: ${badLabels.slice(0, 3).join(', ')}\n\nLabels match ${LABEL_RE} (max 64 chars).`
    return res.type('text/plain').status(400).send(wrap({
      title: `Query failed — ${store}`,
      noNext: true,
      body: msg + failureDebug(
        [{ label: `GET ${selfUrl}`, ok: false, detail: `bad label: ${badLabels.slice(0, 3).join(', ')}` }],
        [selfUrl, `${BASE}/${store}`],
      ),
      meta: { store },
    }))
  }
  // No filters means list-all (up to limit) — store discovery is a feature.
  const limit = Math.min(50, Math.max(1, parseInt(strParam(req.query.limit) ?? '20', 10) || 20))
  const status = strParam(req.query.status)?.slice(0, 64)
  const { rows, error } = runList(store, all, any, {
    exclude,
    title: strParam(req.query.title)?.slice(0, 120),
    desc: strParam(req.query.desc)?.slice(0, 120),
    notes: strParam(req.query.notes)?.slice(0, 120),
    status,
    limit,
    allStates: req.query.all !== undefined,
  })
  const cb = shortCode()
  const ids = rows.map((r) => r.id).slice(0, 40)
  if (ids.length) warmBundle(ids) // the agent fetches the bundle next
  const body = [
    `# label query — ${store}`,
    ``,
    ...formatSection(store, [...all.map((l) => `label:${l}`), ...any.map((l) => `any:${l}`)], rows, error),
    ``,
    ...(ids.length ? [`Everything at once:`, ``, withCb(`${BASE}/beads/${ids.join('+')}`, cb), ``] : []),
    `Re-fetch this literal to re-run the query (add &fresh=1 is not needed — queries run live).`,
  ].join('\n')
  const failed = error !== undefined
  const out = body + (failed
    ? failureDebug(
      [{ label: `GET ${selfUrl}`, ok: false, detail: error ?? 'store query failed' }],
      [selfUrl, `${BASE}/${store}`],
    )
    : '')
  res.type('text/plain').send(wrap({
    title: failed ? `Query failed — ${store}` : `Query: ${store} (${rows.length})`,
    noNext: true,
    body: failed ? out : withDebug(req, out),
    meta: { store },
    actions: ids.length ? [`GET ${withCb(`${BASE}/beads/${ids.join('+')}`, shortCode())} — everything at once`] : [],
  }))
})
