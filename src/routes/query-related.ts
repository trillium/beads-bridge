// Scope refinement: what should we include to back up experience for the
// job description (/resume/:id/scope-refinement, plus-separated labels, OR
// by default; /resume/:id/related* is the older alias). Bare (no labels)
// composes the set from resume scope with the JD leading. Mounted before
// readRouter's catchalls.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { BASE, STORES } from '../config'
import { pstr, withCb, shortCode, storeFromId } from '../util'
import { wrap } from '../wrap'
import { withDebug, failureDebug } from './debug-state'
import { warmBundle } from './beads'
import { mapLimit } from '../lib/exec'
import { withSections } from './sections'
import { RESUME_RE, LABEL_RE, MAX_LABELS, MAX_STORES, strParam, listParam, cleanLabel, type Row } from './query/params'
import { runListAsync, showBeadAsync, resolvePostingRef } from './query/store'
import { discoverScopeLabels } from './query/scope'
import { staleSection } from './query/stale'
import { formatSection } from './query/format'

export const mountOrder = -15
export const relatedQueryRouter = Router()

function scopeHandler(req: Request, res: Response) {
  void (async () => {
  const id = pstr(req.params.id)
  const selfUrl = `${BASE}${req.originalUrl}`
  const debugFor = (rid: string) => `${BASE}/fetch/${rid}/debug`
  if (!RESUME_RE.test(id)) {
    return res.type('text/plain').status(400).send(wrap({
      title: 'Related query failed',
      noNext: true,
      body: `unknown resume id: ${id}` + failureDebug(
        [{ label: `GET ${selfUrl}`, ok: false, detail: `unknown resume id: ${id}` }],
        [selfUrl],
      ),
    }))
  }
  const pathLabels = pstr(req.params.labels ?? '')
    .split('+')
    .map((s: string) => s.trim())
    .filter(Boolean)
  const queryLabels = [...listParam(req.query.label), ...listParam(req.query.labels)]
  const merged = [...new Set([...pathLabels, ...queryLabels])]
  let labels = merged.map(cleanLabel).filter((x): x is string => !!x).slice(0, MAX_LABELS)
  const bad = merged.filter((l) => !cleanLabel(l))
  if (bad.length) {
    return res.type('text/plain').status(400).send(wrap({
      title: `Related query failed — ${id}`,
      noNext: true,
      body: `# bad label: ${bad.slice(0, 3).join(', ')}\n\nLabels match ${LABEL_RE} (max 64 chars).` + failureDebug(
        [{ label: `GET ${selfUrl}`, ok: false, detail: `bad label: ${bad.slice(0, 3).join(', ')}` }],
        [selfUrl, debugFor(id)],
      ),
      meta: { id },
    }))
  }
  // Bare (no labels): compose for the user. Discover project: slugs from
  // what the resume already scopes, then run the wide OR over those. The
  // user just shows up; the URL does the thinking.
  let composed = false
  if (!labels.length) {
    // Tier 1 (this resume, deliberate) first, Tier 2 (any resume) fills —
    // see discoverScopeLabels. Tier 1 always wins the cap so scoped
    // evidence is never crowded out.
    labels = discoverScopeLabels(id)
    composed = true
    if (!labels.length) {
      return res.type('text/plain').status(400).send(wrap({
        title: `Related query failed — ${id}`,
        noNext: true,
        body: [
          `# related — ${id}: nothing resume-scoped to compose from`,
          ``,
          `No task/story carries \`resume:${id}\` and no project carries \`sys:resume\`.`,
          `Scope something first (label a verification task or story \`resume:${id}\`), or pass labels explicitly:`,
          `  ${BASE}/resume/${id}/scope-refinement/project:parlay+project:talon-voice`,
        ].join('\n') + failureDebug(
          [{ label: `GET ${selfUrl}`, ok: false, detail: 'nothing resume-scoped to compose from' }],
          [selfUrl, debugFor(id)],
        ),
        meta: { id },
      }))
    }
  }
  const wanted = listParam(req.query.stores)
  const defaults = ['resume_bullets', 'stories', 'task', 'projects']
  const stores = (wanted.length ? wanted : defaults).filter((s) => STORES.includes(s)).slice(0, MAX_STORES)
  const unknownStores = (wanted.length ? wanted : []).filter((s) => !STORES.includes(s))
  if (!stores.length) {
    return res.type('text/plain').status(400).send(wrap({
      title: `Related query failed — ${id}`,
      noNext: true,
      body: `# no known stores (want ${defaults.join(', ')})` + failureDebug(
        [{ label: `GET ${selfUrl}`, ok: false, detail: `unknown stores: ${unknownStores.slice(0, 3).join(', ')}` }],
        [selfUrl, debugFor(id)],
      ),
      meta: { id },
    }))
  }
  const mode = strParam(req.query.mode) === 'all' ? 'all' : 'any'
  const limit = Math.min(50, Math.max(1, parseInt(strParam(req.query.limit) ?? '20', 10) || 20))
  const allStates = req.query.all !== undefined

  const results = await mapLimit(stores, 4, (store) =>
    runListAsync(store, mode === 'all' ? labels : [], mode === 'any' ? labels : [], {
      exclude: [],
      status: undefined,
      limit,
      allStates,
    }).then(({ rows, error }) => ({ store, rows, error })),
  )
  const sections: string[][] = []
  const allIds: string[] = []
  const kept: Record<string, Row[]> = {}
  const storeAttempts: { label: string; ok: boolean; detail: string }[] = []
  for (const { store, rows, error } of results) {
    kept[store] = rows
    sections.push(formatSection(store, labels, rows, error))
    storeAttempts.push({
      label: `list ${store} (${mode === 'all' ? 'AND' : 'OR'}: ${labels.join(' + ')})`,
      ok: error === undefined,
      detail: error ?? `${rows.length} bead(s)`,
    })
    for (const r of rows) if (!allIds.includes(r.id)) allIds.push(r.id)
    if (allIds.length >= 40) break
  }
  const bundleIds = allIds.slice(0, 40)
  if (bundleIds.length) warmBundle(bundleIds) // the agent fetches the bundle next
  // Lead with the target: resume manifest + job description bead. The JD is
  // the culling criterion — related is composed WITH it, never without it.
  const leadIds: string[] = []
  if (storeFromId(id)) leadIds.push(id)
  const jobId = resolvePostingRef(id)
  if (jobId && storeFromId(jobId) && !leadIds.includes(jobId)) leadIds.push(jobId)
  const leadTexts = await Promise.all(leadIds.map((lid) => showBeadAsync(storeFromId(lid)!, lid)))
  const leadSections: string[][] = leadIds.map((lid, i) => [
    `## ${storeFromId(lid)} — ${lid === jobId ? 'target job description (read FIRST — cull against this)' : 'resume manifest'}`,
    leadTexts[i] ?? '- unavailable',
  ])
  const byLead = new Map<string, string[]>()
  leadSections.forEach((s, i) => byLead.set(leadIds[i], s))
  const ordered: string[][] = []
  if (jobId && byLead.has(jobId)) ordered.push(byLead.get(jobId)!)
  ordered.push(staleSection(kept, id))
  for (const lid of leadIds) if (lid !== jobId && byLead.has(lid)) ordered.push(byLead.get(lid)!)
  const leadSectionsOrdered = ordered
  const fullBundle = [...leadIds, ...bundleIds.filter((b) => !leadIds.includes(b))].slice(0, 40)
  if (fullBundle.length) warmBundle(fullBundle) // the agent fetches the bundle next
  const cb = shortCode()
  const lines = [
    `# scope refinement — ${id} — ${mode === 'any' ? 'OR' : 'AND'}: ${labels.join(' + ')}`,
    `Task: decide what to include to back up experience in the job description.`,
    ``,
    ...(composed ? [`Labels auto-composed from resume scope (resume:${id} tasks/stories + sys:resume projects) — you just show up; narrow with explicit labels any time.`, ``] : []),
    ...(jobId ? [`Target: ${jobId} (leads the bundle below — cull against it).`, ``] : [`No posting_ref on this resume manifest — no target JD to cull against.`, ``]),
    `Stores: ${stores.join(', ')} (limit ${limit}/store${allStates ? ', including closed' : ''}).`,
    ...(unknownStores.length ? [`Skipped unknown stores: ${unknownStores.join(', ')}`] : []),
    ``,
    ...leadSectionsOrdered.flatMap((s) => [...s, ``]),
    ...sections.flatMap((s) => [...s, ``]),
  ]
  if (fullBundle.length) {
    lines.push(`Everything at once — fetch this single literal:`, ``, withCb(`${BASE}/beads/${fullBundle.join('+')}`, cb), ``)
  } else {
    lines.push(`No beads matched — widen labels (mode=any) or add ?all=1 for closed work.`, ``)
  }
  lines.push(`Mid-session refresh by voice ("query follow-up N"): ${BASE}/resume/${id}/followups`, ``)
  lines.push(`Previous turn (requests + resolves): ${BASE}/resume/${id}/last-turn`, ``)
  lines.push(`Narrow or re-run: ${BASE}/resume/${id}/scope-refinement/${labels.join('+')}?mode=${mode === 'any' ? 'all' : 'any'}&limit=${limit}`)
  const content = withSections(lines.join('\n'), id, 'cull-procedure', 'retro', 'debug-pointer', 'done-pointer')
  const storeFailed = storeAttempts.some((a) => !a.ok)
  const out = content + (storeFailed ? failureDebug(storeAttempts, [selfUrl, debugFor(id)]) : '')
  res.type('text/plain').send(wrap({
    title: storeFailed ? `Scope refinement failed — ${id}` : `Resume ${id} — scope refinement (${labels.join(' + ')})`,
    noNext: true,
    body: storeFailed ? out : withDebug(req, out),
    meta: { id },
    actions: fullBundle.length
      ? [`GET ${withCb(`${BASE}/beads/${fullBundle.join('+')}`, shortCode())} — everything at once (${fullBundle.length} beads, JD first)`]
      : [],
  }))
  })().catch((e: unknown) => {
    // The handler runs async (parallel fan-out); Express only catches sync
    // throws, so async failures land here as a debug-state 500 instead of a hang.
    try {
      const rid = pstr(req.params.id)
      const url = `${BASE}${req.originalUrl}`
      res.type('text/plain').status(500).send(wrap({
        title: `Scope refinement failed — ${rid}`,
        noNext: true,
        body: `# internal error: ${((e as Error)?.message ?? String(e)).slice(0, 200)}` + failureDebug(
          [{ label: `GET ${url}`, ok: false, detail: 'internal error — see above' }],
          [url, `${BASE}/fetch/${rid}/debug`],
        ),
        meta: { id: rid },
      }))
    } catch { /* response already gone */ }
  })
}

relatedQueryRouter.get('/resume/:id/scope-refinement/:labels', scopeHandler)
relatedQueryRouter.get('/resume/:id/scope-refinement', scopeHandler)
relatedQueryRouter.get('/resume/:id/related/:labels', scopeHandler)
relatedQueryRouter.get('/resume/:id/related', scopeHandler)
