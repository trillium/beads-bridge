// Multi-bead bundle: GET /beads/{id1+id2+...} shows up to 40 beads on one
// page so a single literal URL carries a whole roster. 90s TTL cache on the
// id-set (?cb= busters bypass HTTP caches, so the server caches itself);
// pages that emit bundle literals warm it fire-and-forget because the agent
// fetches that literal next. Mounted before readRouter's /:store catchall.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { BASE } from '../config'
import { pstr, storeFromId } from '../util'
import { wrap } from '../wrap'
import { fetchBeadTexts, renderBeadBlock } from '../lib/bead-text'

export const mountOrder = -10
export const beadsRouter = Router()

const bundleCache = new Map<string, { at: number; body: string }>()
const BUNDLE_TTL_MS = 90_000
const bundleWarming = new Set<string>()
// Dotted numeric suffixes are child beads (task-2nwlw.1) — bundleable.
const BEAD_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{2,64}(\.\d+)?$/

export function bundleIds(raw: string[]): string[] {
  return [...new Set(raw.map((x) => x.trim()).filter(Boolean))]
    .filter((id) => BEAD_ID_RE.test(id) && storeFromId(id))
    .slice(0, 40)
}

async function fetchBundle(valid: string[]): Promise<string> {
  const texts = await fetchBeadTexts(valid.map((id) => ({ id, store: storeFromId(id)! })))
  const parts = valid.map((id) => renderBeadBlock(id, storeFromId(id)!, texts.get(id)!))
  return wrap({
    title: `Beads: ${valid.join(' + ')}`,
    body: parts.join('\n\n---\n\n'),
    actions: valid.map(id => `GET ${BASE}/${id} — view ${id} alone`),
  })
}

// Fire-and-forget: when a page hit emits a bundle literal, warm it — the
// agent fetches that literal next, and should get a cache hit (~20ms).
export function warmBundle(ids: string[]): void {
  const valid = bundleIds(ids)
  if (!valid.length) return
  const key = valid.join('+')
  const hit = bundleCache.get(key)
  if ((hit && Date.now() - hit.at < BUNDLE_TTL_MS) || bundleWarming.has(key)) return
  bundleWarming.add(key)
  fetchBundle(valid).then((body) => {
    bundleCache.set(key, { at: Date.now(), body })
  }).catch(() => {}).finally(() => bundleWarming.delete(key))
}

beadsRouter.get('/beads/:ids', async (req: Request, res: Response) => {
  const valid = bundleIds(String(pstr(req.params.ids)).split('+'))
  if (!valid.length) return res.type('text/plain').status(400).send('No valid bead ids in URL.')
  const key = valid.join('+')
  const hit = bundleCache.get(key)
  if (hit && Date.now() - hit.at < BUNDLE_TTL_MS) {
    return void res.type('text/plain').send(hit.body)
  }
  const out = await fetchBundle(valid)
  bundleCache.set(key, { at: Date.now(), body: out })
  res.type('text/plain').send(out)
})
