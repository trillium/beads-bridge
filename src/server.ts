import express, { Request, Response, NextFunction, RequestHandler } from 'express'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import { PORT, BASE, toolKey, STORES, storeAbout } from './config'
import { qstr, pstr, cacheTag, bd, storeFromId } from './util'
import { wrap } from './wrap'
import { resumeRouter } from './routes/resume'
import { readRouter } from './routes/read'

const app = express()

app.use((req: Request, _res: Response, next: NextFunction) => {
  const ua = req.get('user-agent')?.slice(0, 120) ?? '-'
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} UA:${ua}`)
  next()
})

// Resume voice-loop routes first: /fetch/* and /resume must win over /:store.
app.use(resumeRouter)
app.use(readRouter)

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /{bead-id}/comment
app.get('/:id/comment', (req: Request, res: Response, next: NextFunction) => {
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
app.get('/:id/note', (req: Request, res: Response, next: NextFunction) => {
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
app.get('/:id/approve', (req: Request, res: Response, next: NextFunction) => {
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
app.get('/:id/reject', (req: Request, res: Response, next: NextFunction) => {
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
app.get('/:id/done', (req: Request, res: Response, next: NextFunction) => {
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
app.get('/:id/close', (req: Request, res: Response, next: NextFunction) => {
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
app.get('/:id/label', (req: Request, res: Response, next: NextFunction) => {
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

// ── Probe harness — empirically test web-fetch fidelity ───────────────────────

const P = (id: string, body: string) =>
  (req: Request, res: Response) => res.type('text/plain').send(`${body}\nprobe:${id}`)

app.get('/probe', (_req: Request, res: Response) => {
  res.type('text/plain').send(
`FETCH FIDELITY PROBE

Every test below is its own self-contained sub-route. Fetch the test URL
EXACTLY, read the directions printed on that page, and run the steps.
Report per item: fetched=yes|no token=<returned-token> note=<any refusal reason>.

Eligibility tests (T1–T9):
  T1 exact-URL baseline:     ${BASE}/probe/t1
  T2 query-value substitution: ${BASE}/probe/t2
  T3 path substitution:      ${BASE}/probe/t3
  T4 link following:         ${BASE}/probe/t4
  T5 server-generated param: ${BASE}/probe/t5
  T6 encoding/normalization: ${BASE}/probe/t6
  T7 redirect:               ${BASE}/probe/t7
  T8 cross-domain (deferred): ${BASE}/probe/t8
  T9 fragment control:       ${BASE}/probe/t9

Legacy single-token targets (also live):
  A: ${BASE}/probe/a   B: ${BASE}/probe/b   C: ${BASE}/probe/c
  D: ${BASE}/probe/d   E: ${BASE}/probe/e   F: ${BASE}/probe/f

Search-results eligibility:
  S1: ${BASE}/probe/s1`
  )
})

app.get('/probe/a', P('A', 'PROBE-A-OK'))
app.get('/probe/b', P('B', 'PROBE-B-OK'))
app.get('/probe/c', (_req: Request, res: Response) => {
  res.type('text/plain').send('PROBE-C-OK\n\nFollow this link:\n\n    ' +
    `${BASE}/probe/d\nprobe:C`)
})
app.get('/probe/d', P('D', 'PROBE-D-OK'))
app.get('/probe/e', (req: Request, res: Response) => {
  res.type('text/plain').send(`PROBE-E-OK tag=${req.query.tag ?? '(none)'} probe:E`)
})

// F — differential: was E's refusal because the URL was on-page, or because
// composition itself is ineligible? User pastes the exact /probe/f?tag=URLBASE
// URL verbatim, then instructs ChatGPT to substitute {:RAWTAG:} with a random
// word and fetch it. If refused here too, composition is dead regardless of
// the URL's provenance.
app.get('/probe/f', (req: Request, res: Response) => {
  res.type('text/plain').send(`PROBE-F-OK tag=${req.query.tag ?? '(none)'} probe:F`)
})

// ── Discriminating tests — one self-contained sub-route each ─────────────────
// Each /probe/tN is BOTH the test page and (where the design needs it) the
// target; nested paths belong to that test only. Paired, URL-held-constant.

// T1 — exact-URL baseline (H1)
app.get('/probe/t1', (_req, res) => {
  res.type('text/plain').send(
`TEST 1 — EXACT-URL BASELINE (H1)

Fetch these two URLs EXACTLY as written and report each returned token.
Do not modify either literal.

    ${BASE}/probe/t1/a
    ${BASE}/probe/t1/b?x=1

Report per item: fetched=yes|no token=<token> note=<any refusal reason>`
  )
})
app.get('/probe/t1/a', P('T1A', 'T1-A probe:t1a'))
app.get('/probe/t1/b', (req, res) => {
  res.type('text/plain').send(`T1-B x=${req.query.x ?? '(none)'} probe:t1b`)
})

// T2 — query-value substitution (H3): same URL, only the value changes
app.get('/probe/t2', (req, res) => {
  if (req.query.value) {
    res.type('text/plain').send(`T2 value=${req.query.value} probe:t2`)
  } else {
    res.type('text/plain').send(
`TEST 2 — QUERY-VALUE SUBSTITUTION (H3)

Step 1: the user pastes this EXACT literal and ChatGPT fetches it:
    ${BASE}/probe/t2?value=ALPHA
Step 2: ChatGPT CONSTRUCTS the same URL with value=BETA and fetches:
    ${BASE}/probe/t2?value=BETA

The only difference between the two is the query value; report which fetches.`
    )
  }
})

// T3 — path substitution (H3): same-format URLs, only the final path segment changes
app.get('/probe/t3', (_req, res) => {
  res.type('text/plain').send(
`TEST 3 — PATH SUBSTITUTION (H3)

Step 1: the user pastes this EXACT literal and ChatGPT fetches it:
    ${BASE}/probe/t3/a
Step 2: ChatGPT CONSTRUCTS the sibling path and fetches:
    ${BASE}/probe/t3/b

Destinations differ only in the final segment; report which fetches.`
  )
})
app.get('/probe/t3/a', P('T3A', 'T3-A probe:t3a'))
app.get('/probe/t3/b', P('T3B', 'T3-B probe:t3b'))

// T4 — link following (H2): the page emits a link; compare following it
//       against the user pasting that same URL directly.
app.get('/probe/t4', (_req, res) => {
  res.type('text/plain').send(
`T4 CHAIN probe:t4

Link on this page:
    ${BASE}/probe/t4/next
probe:t4`
  )
})
app.get('/probe/t4/next', P('T4NEXT', 'T4-NEXT probe:t4next'))

// T5 — server-generated parameter (H2/H3, identical strings as test)
app.get('/probe/t5', (req, res) => {
  if (req.query.tag) {
    res.type('text/plain').send(`T5 tag=${req.query.tag} probe:t5`)
  } else {
    const t = cacheTag()
    res.type('text/plain').send(
`TEST 5 — SERVER-GENERATED PARAMETER (H2 ∩ H3)

Fetch this EXACT literal:
    ${BASE}/probe/t5

The page above returns a link whose query tag was minted by the server:

Case B — try to fetch the EXACT link the page returned. It is identical to a
         literal for this run, but it originates from the server response.
Case A — have the user paste that same URL EXACTLY into the message, then
         ChatGPT fetches it.

The URL string in A and B is byte-identical for the same run; only the
provenance differs. Report both outcomes.

The server-generated link for THIS run is:
    ${BASE}/probe/t5?tag=${t}
probe:t5`
    )
  }
})

// T6 — encoding / normalization (H5)
app.get('/probe/t6', (_req, res) => {
  res.type('text/plain').send(
`TEST 6 — ENCODING / NORMALIZATION (H5)

Fetch BOTH of these EXACT literals and report each token:
    ${BASE}/probe/t6/hello+world
    ${BASE}/probe/t6/hello%20world

If they normalize to the same request, the fetched body is identical; the
question is whether the fetcher accepts or drops either form.`
  )
})
app.get('/probe/t6/hello\\+world', P('T6PLUS', 'T6-PLUS probe:t6plus'))
app.get('/probe/t6/hello%2Bworld', P('T6PLUS', 'T6-PLUS probe:t6plus'))
app.get('/probe/t6/hello%20world', P('T6PCT', 'T6-PCT probe:t6pct'))

// T7 — redirect (H5): does the destination arrive via 302 and directly?
app.get('/probe/t7', (_req, res) => {
  res.type('text/plain').send(
`TEST 7 — REDIRECT (H5)

Step 1: the user pastes this EXACT literal and ChatGPT fetches it:
    ${BASE}/probe/t7/redirect
It returns a 302 to /probe/t7/dest. If the fetcher follows it, the body is
the destination's.

Step 2: the user pastes this EXACT literal directly:
    ${BASE}/probe/t7/dest

Compare the two: does the destination arrive via redirect AND directly?`
  )
})
app.get('/probe/t7/redirect', (_req, res) => {
  res.redirect(302, '/probe/t7/dest')
})
app.get('/probe/t7/dest', P('T7DEST', 'T7-DEST probe:t7dest'))

// T8 — cross-domain control (H4): deferred until a second controlled host exists
app.get('/probe/t8', (_req, res) => {
  res.type('text/plain').send(
`TEST 8 — CROSS-DOMAIN CONTROL (H4)

Deferred: requires a second controlled host to render the same probe pages on a
second, distinct domain and compare outcomes. Currently the bridge is published
on exactly one host:
    ${BASE}

Design: republish this bridge (or a mirror of T1–T7) on a second funnel hostname
and rerun the same experiments there. Eligibility that follows URL provenance
should reproduce the same outcomes on both hosts; eligibility that follows the
host would diverge.`
  )
})

// T9 — fragment control (H5): identical request, differing fragment
app.get('/probe/t9', (_req, res) => {
  res.type('text/plain').send(
`TEST 9 — FRAGMENT CONTROL (H5)

Fetch this EXACT literal twice, changing only the fragment:
    ${BASE}/probe/t9#A
    ${BASE}/probe/t9#B

A fragment never reaches the server, so any fetched body is identical for both;
the question is whether the fetcher fetches, ignores, or drops based on it.
Report fetched=yes|no for each.`
  )
})

// S1 — search-results eligibility (guard claims "prior search results" are
// fetchable). This URL will be embedded ONLY in an externally indexed page
// (gist), never in a user message. A log hit with the ChatGPT UA proves the
// fetcher retrieved a URL discovered via search results.
app.get('/probe/s1', (req, res) => {
  res.type('text/plain').send(`PROBE-S1-OK tag=${req.query.tag ?? '(none)'} probe:S1`)
})

// ── Tool bridge — structured writes for GPT Actions/Assistants ────────────────
// The web-fetch URL-eligibility rule disappears when the platform calls these
// endpoints directly with structured JSON (no URL is composed by the model).

app.use(express.json())

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

app.get('/action/next', requireToolKey, (_req: Request, res: Response) => {
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

app.get('/action/bead', requireToolKey, (req: Request, res: Response) => {
  const store = toolTarget(res, req.query.bead_id)
  if (typeof store !== 'string') return
  res.json({ ok: true, ...actionSummary(store, String(req.query.bead_id)) })
})

app.post('/action/comment', requireToolKey, (req: Request, res: Response) => {
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

app.post('/action/note', requireToolKey, (req: Request, res: Response) => {
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

app.post('/action/approve', requireToolKey, (req: Request, res: Response) => stateTransition(req, res, 'Approved', true))
app.post('/action/reject', requireToolKey, (req: Request, res: Response) => stateTransition(req, res, 'Rejected', false))
app.post('/action/done', requireToolKey, (req: Request, res: Response) => stateTransition(req, res, 'Handled', true))

app.post('/action/label', requireToolKey, (req: Request, res: Response) => {
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

app.get('/actions/openapi.json', (_req: Request, res: Response) => {
  res.type('application/json').send(
    readFileSync(path.join(__dirname, '..', 'actions', 'openapi.json'), 'utf8')
  )
})

// 404
app.use((req: Request, res: Response) => {
  res.type('text/plain').status(404).send(
    `# Not found: ${req.path}\n\nFetch / for the store index.\nFetch /next for the next queued item.`
  )
})

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`beads-bridge on all interfaces :${PORT}`)
  console.log(`  local:   http://localhost:${PORT}`)
  console.log(`  tailnet: http://__TAILNET_IP__:${PORT}`)
  console.log(`  funnel:  ${BASE} (public; use this in ChatGPT blurbs)`)
})
