// Follow-up bank: voice-triggered refresh without copy/paste. The bank
// snapshots the stale id-set as baseline; each follow-up recomputes LIVE
// and diffs (newly resolved / newly stale / still stale). Numbering never
// runs out — any N ≥ 1 works, every literal is distinct and cache-busted.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { BASE } from '../config'
import { pstr, withCb, shortCode } from '../util'
import { wrap } from '../wrap'
import { withDebug, failureDebug } from './debug-state'
import { RESUME_RE, type Row } from './query/params'
import { runListAsync } from './query/store'
import { discoverScopeLabels } from './query/scope'

export const mountOrder = -15
export const followupsQueryRouter = Router()

const followupBase = new Map<string, { at: number; titles: Record<string, string> }>()

interface StaleSet { labels: string[]; unconf: Row[]; unver: Row[]; open: Row[] }

async function currentStale(id: string): Promise<StaleSet> {
  const labels = discoverScopeLabels(id)
  const listOpts = { exclude: [], status: undefined as string | undefined, limit: 50, allStates: false }
  const [b, s, t] = await Promise.all([
    runListAsync('resume_bullets', [], labels, listOpts),
    runListAsync('stories', [], labels, listOpts),
    runListAsync('task', [], labels, listOpts),
  ])
  return {
    labels,
    unconf: b.rows.filter((r) => !r.labels.some((l) => l.startsWith('confirmed:'))),
    unver: s.rows.filter((r) => !r.labels.includes('verification:verified')),
    open: t.rows,
  }
}

followupsQueryRouter.get('/resume/:id/followups', async (req: Request, res: Response) => {
  const id = pstr(req.params.id)
  const selfUrl = `${BASE}${req.originalUrl}`
  const failed = (detail: string) => res.type('text/plain').status(400).send(wrap({
    title: 'Follow-ups failed',
    noNext: true,
    body: detail + failureDebug(
      [{ label: `GET ${selfUrl}`, ok: false, detail }],
      [selfUrl],
    ),
  }))
  if (!RESUME_RE.test(id)) {
    return failed(`unknown resume id: ${id}`)
  }
  try {
    const st = await currentStale(id)
  const titles: Record<string, string> = {}
  for (const r of [...st.unconf, ...st.unver, ...st.open]) titles[r.id] = r.title
  followupBase.set(id, { at: Date.now(), titles })
  const lines = [
    `# follow-ups — ${id}`,
    ``,
    `Voice trigger: say "query follow-up N" (any N ≥ 1 — numbering never runs out).`,
    `Each literal below is distinct and cache-busted; every follow-up recomputes LIVE state, never a stale reread.`,
    ``,
    `Baseline recorded at ${new Date().toISOString()} — ${Object.keys(titles).length} stale item(s).`,
    `Follow-ups report newly resolved / newly stale / still stale against this baseline.`,
    ``,
    ...Array.from({ length: 10 }, (_, i) =>
      `${i + 1}. ${withCb(`${BASE}/resume/${id}/followup/${i + 1}`, shortCode())}`),
    ``,
    `Full refresh views (same content, whole page):`,
    `${BASE}/fetch/${id}/unconfirmed?fresh=1`,
    `${BASE}/fetch/${id}/findings?fresh=1`,
    `${BASE}/fetch/${id}/stories?fresh=1`,
  ]
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — follow-ups`,
    noNext: true,
    body: withDebug(req, lines.join('\n')),
    meta: { id },
    actions: [`GET ${withCb(`${BASE}/resume/${id}/followup/1`, shortCode())} — follow-up 1`],
  }))
  } catch (e: unknown) {
    failed(`internal error: ${((e as Error)?.message ?? String(e)).slice(0, 200)}`)
  }
})

followupsQueryRouter.get('/resume/:id/followup/:n', async (req: Request, res: Response) => {
  const id = pstr(req.params.id)
  const selfUrl = `${BASE}${req.originalUrl}`
  const n = pstr(req.params.n)
  const failed = (detail: string, retry: string[]) => res.type('text/plain').status(400).send(wrap({
    title: 'Follow-up failed',
    noNext: true,
    body: `# bad follow-up request (want /resume/{id}/followup/{N ≥ 1})` + failureDebug(
      [{ label: `GET ${selfUrl}`, ok: false, detail }],
      retry,
    ),
    meta: { id },
  }))
  if (!RESUME_RE.test(id) || !/^\d+$/.test(n) || parseInt(n, 10) < 1) {
    return failed('bad resume id or follow-up number', [selfUrl, `${BASE}/resume/${id}/followups`])
  }
  try {
    const st = await currentStale(id)
  const now = new Map<string, string>()
  for (const r of [...st.unconf, ...st.unver, ...st.open]) now.set(r.id, r.title)
  const base = followupBase.get(id)
  const lines = [
    `# follow-up ${n} — ${id} (live at ${new Date().toISOString()})`,
    ``,
  ]
  if (!base) {
    lines.push(`No baseline recorded — fetch ${BASE}/resume/${id}/followups first to start deltas. Reporting full current state:`, ``)
  } else {
    const resolved = Object.keys(base.titles).filter((x) => !now.has(x))
    const fresh = [...now.keys()].filter((x) => !(x in base.titles))
    const still = [...now.keys()].filter((x) => (x in base.titles))
    lines.push(`Since baseline (${new Date(base.at).toISOString()}): ${resolved.length} resolved, ${fresh.length} newly stale, ${still.length} still stale.`, ``)
    if (resolved.length) {
      lines.push(`Newly resolved:`)
      for (const x of resolved.slice(0, 10)) lines.push(`- ✅ ${x} — ${base.titles[x]}`)
      lines.push(``)
    }
    if (fresh.length) {
      lines.push(`Newly stale:`)
      for (const x of fresh.slice(0, 10)) lines.push(`- 🟠 ${x} — ${now.get(x)}`)
      lines.push(``)
    }
    if (!resolved.length && !fresh.length) lines.push(`No changes since baseline.`, ``)
  }
  const show = (title: string, rows: Row[]) => {
    lines.push(`${title} (${rows.length}):`)
    for (const r of rows.slice(0, 10)) lines.push(`- ${r.id} — ${r.title}`)
    if (!rows.length) lines.push(`- none`)
    lines.push(``)
  }
  show('Unconfirmed bullets now', st.unconf)
  show('Unverified stories now', st.unver)
  show('Open verification tasks now', st.open)
  lines.push(
    `Full refresh views:`,
    `${BASE}/fetch/${id}/unconfirmed?fresh=1`,
    `${BASE}/fetch/${id}/findings?fresh=1`,
    `${BASE}/fetch/${id}/stories?fresh=1`,
  )
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — follow-up ${n}`,
    noNext: true,
    body: withDebug(req, lines.join('\n')),
    meta: { id },
    actions: [`GET ${withCb(`${BASE}/resume/${id}/followup/${parseInt(n, 10) + 1}`, shortCode())} — follow-up ${parseInt(n, 10) + 1} (the next one)`],
  }))
  } catch (e: unknown) {
    failed(`internal error: ${((e as Error)?.message ?? String(e)).slice(0, 200)}`, [selfUrl, `${BASE}/resume/${id}/followups`])
  }
})
