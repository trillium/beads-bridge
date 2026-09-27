// Last-turn memory: what the previous agent requested + what got resolved.
// Requests come from a bounded in-memory ring filled by server.ts on every
// response finish (restart clears it — stated on the page). Resolves come
// from live store queries (created/closed since T), so they survive restarts.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { BASE, STORES } from '../config'
import { pstr, withCb, shortCode } from '../util'
import { wrap } from '../wrap'
import {
  activityAutoFollowDefault,
  activityMaxEvents,
  recentEvents,
  subscribeActivity,
} from '../lib/activity'
import { withDebug, failureDebug } from './debug-state'
import { discoverScopeLabels } from './query/scope'
import { mapLimit } from '../lib/exec'

const execFileAsync = promisify(execFile)

export const mountOrder = -14
export const activityRouter = Router()
export const liveRouter = Router()

export interface Hit { at: number; method: string; path: string; status: number; ms: number }
const hits: Hit[] = []
const MAX_HITS = 300

// Called from server.ts when each response finishes. Drops the per-page
// cache-buster so repeated fetches of one literal group together.
export function recordHit(method: string, originalUrl: string, status: number, ms: number): void {
  const path = originalUrl.replace(/([?&])cb=[^&]*/g, '$1').replace(/[?&]$/, '')
  hits.push({ at: Date.now(), method, path, status, ms })
  if (hits.length > MAX_HITS) hits.splice(0, hits.length - MAX_HITS)
}

function recentHits(n: number): Hit[] {
  return hits.slice(-n).reverse()
}

const RESUME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,64}$/

interface BeadRow { id: string; title: string; labels: string[]; close_reason?: string }

// One store list as parsed rows; [] on any failure (endpoint degrades, not 500s).
async function listSinceAsync(store: string, sinceIso: string, closed: boolean): Promise<BeadRow[]> {
  try {
    const args = ['list', '--json', '--limit', '50', closed ? '--closed-after' : '--created-after', sinceIso]
    const { stdout } = await execFileAsync(store, args, { encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024 })
    const d = JSON.parse(stdout as string)
    const arr: unknown[] = Array.isArray(d) ? d : []
    return arr
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        id: String(x.id ?? x.bead_id ?? '?'),
        title: String(x.title ?? '').slice(0, 100),
        labels: Array.isArray(x.labels) ? (x.labels as unknown[]).map(String) : [],
        close_reason: typeof x.close_reason === 'string' ? x.close_reason.slice(0, 160) : undefined,
      }))
      .filter((x) => x.id !== '?')
  } catch {
    return []
  }
}

// GET /resume/:id/last-turn — previous turn: requests + resolves since ?hours= (default 24, max 168).
activityRouter.get('/resume/:id/last-turn', async (req: Request, res: Response) => {
  const id = pstr(req.params.id)
  const selfUrl = `${BASE}${req.originalUrl}`
  if (!RESUME_RE.test(id)) {
    return res.type('text/plain').status(400).send(wrap({
      title: 'Last turn failed',
      noNext: true,
      body: `unknown resume id: ${id}` + failureDebug(
        [{ label: `GET ${selfUrl}`, ok: false, detail: `unknown resume id: ${id}` }],
        [selfUrl],
      ),
    }))
  }
  const hours = Math.min(168, Math.max(1, parseInt(String(req.query.hours ?? '24'), 10) || 24))
  const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString()
  const scopeTag = `resume:${id}`
  const slugs = new Set(discoverScopeLabels(id))

  const lines = [
    `# last turn — ${id} (since ${sinceIso})`,
    ``,
    `Requests below are this server's memory (restart clears it). Resolves are live store state (survive restarts).`,
    ``,
    `## requests (newest first, last ${Math.min(recentHits(50).length, 50)})`,
    ``,
  ]
  const seen = recentHits(50)
  if (!seen.length) {
    lines.push(`- none recorded (server restarted recently, or no traffic yet)`, ``)
  } else {
    for (const h of seen) {
      const mine = h.path.includes(id) ? ' ★' : ''
      lines.push(`- ${new Date(h.at).toISOString()} ${h.status} ${h.ms}ms ${h.method} ${h.path}${mine}`)
    }
    lines.push(``)
  }
  lines.push(`## resolves since ${sinceIso}`, ``)
  const inScope = (r: BeadRow) =>
    r.labels.includes(scopeTag) || r.labels.some((l) => l.startsWith('project:') && slugs.has(l))
  const fmt = (r: BeadRow) => `- ${r.id} — ${r.title}${r.close_reason ? ` (receipt: ${r.close_reason})` : ''}`
  let anyResolve = false
  const created: BeadRow[] = []
  const closed: BeadRow[] = []
  const pairs: { store: string; closed: boolean }[] = []
  for (const store of ['stories', 'task', 'resume_bullets', 'projects'] as const) {
    if (!STORES.includes(store)) continue
    pairs.push({ store, closed: false }, { store, closed: true })
  }
  pairs.push({ store: 'inbox', closed: true })
  let fetched: { store: string; closed: boolean; rows: BeadRow[] }[] = []
  try {
    fetched = await mapLimit(pairs, 5, async ({ store, closed }) => ({
      store, closed, rows: await listSinceAsync(store, sinceIso, closed),
    }))
  } catch {
    fetched = []
  }
  for (const { store, closed: wasClosed, rows } of fetched) {
    for (const r of rows) {
      // Inbox receipts are global but are the worker-resolve record — include closed ones with their receipts.
      const scoped = store === 'inbox'
        ? true
        : store === 'stories' || store === 'task'
          ? r.labels.includes(scopeTag)
          : inScope(r)
      if (!scoped) continue
      if (wasClosed) closed.push({ ...r, title: `[${store}] ${r.title}` })
      else created.push({ ...r, title: `[${store}] ${r.title}` })
    }
  }
  lines.push(`Created (${created.length}):`)
  if (!created.length) lines.push(`- none`)
  else for (const r of created.slice(0, 20)) lines.push(fmt(r))
  lines.push(``)
  lines.push(`Closed (${closed.length}):`)
  if (!closed.length) lines.push(`- none`)
  else for (const r of closed.slice(0, 20)) lines.push(fmt(r))
  lines.push(``)
  anyResolve = created.length + closed.length > 0
  if (!anyResolve) lines.push(`Nothing created or closed in scope — see still-open work instead:`, ``)
  lines.push(
    `Still open: ${BASE}/resume/${id}/scope-refinement (stale dependencies lead),`,
    `${BASE}/resume/${id}/followups (live deltas),`,
    ``,
  )
  res.type('text/plain').send(wrap({
    title: `Resume ${id} — last turn`,
    noNext: true,
    body: withDebug(req, lines.join('\n')),
    meta: { id },
    actions: [
      `GET ${withCb(`${BASE}/resume/${id}/scope-refinement`, shortCode())} — current scope + stale set`,
      `GET ${withCb(`${BASE}/resume/${id}/followups`, shortCode())} — live deltas`,
    ],
  }))
})

// ---- Live MCP Activity UI (project-s1rf.1.1.2) --------------------------------
// Observational two-panel UI over the activity ring (src/lib/activity.ts).
// GET-only: the page, its config, recent JSON, and the SSE stream. Nothing
// here mutates beads or creates work — bead content in the detail pane is
// resolved client-side through the existing read-only GET /:id route.
// Mounted at order -14 (this file), ahead of the parametric /:store /:id
// read routes, so /live never falls through to a store lookup.

/** Backend-configurable UI defaults served to the page. */
liveRouter.get('/live/config', (_req: Request, res: Response) => {
  try {
    res.json({ autoFollowDefault: activityAutoFollowDefault(), maxEvents: activityMaxEvents() })
  } catch {
    res.status(500).json({ error: 'config unavailable' })
  }
})

/** Newest-first JSON snapshot of the ring. */
liveRouter.get('/live/recent', (req: Request, res: Response) => {
  try {
    const raw = parseInt(String(req.query.limit ?? '50'), 10)
    res.json({ events: recentEvents(Number.isFinite(raw) ? raw : 50) })
  } catch {
    res.status(500).json({ error: 'recent unavailable' })
  }
})

/** SSE stream of activity events; replays ?limit= recent first. */
liveRouter.get('/live/events', (req: Request, res: Response) => {
  try {
    const raw = parseInt(String(req.query.limit ?? '20'), 10)
    const limit = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 20
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 5000\n\n')
    for (const ev of recentEvents(limit).slice().reverse()) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`)
    }
    let open = true
    const unsub = subscribeActivity((line) => {
      if (!open) return false
      try {
        res.write(line)
        return true
      } catch {
        return false
      }
    })
    const ping = setInterval(() => {
      if (!open) return
      try {
        res.write(': ping\n\n')
      } catch {
        /* closed below */
      }
    }, 25000)
    req.on('close', () => {
      open = false
      clearInterval(ping)
      try {
        unsub()
      } catch {
        /* ignore */
      }
    })
  } catch {
    try {
      res.status(500).json({ error: 'stream unavailable' })
    } catch {
      /* ignore */
    }
  }
})

function renderLivePage(autoFollow: boolean): string {
  const auto = autoFollow ? 'true' : 'false'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beads Bridge — Live MCP Activity</title>
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; }
header { display: flex; gap: 12px; align-items: center; padding: 10px 14px; border-bottom: 1px solid #8884; }
header h1 { font-size: 16px; margin: 0; }
#dot { width: 10px; height: 10px; border-radius: 50%; background: #c33; }
#dot.on { background: #3a3; }
main { display: flex; height: calc(100vh - 53px); }
#left { width: 42%; min-width: 300px; overflow-y: auto; border-right: 1px solid #8884; padding: 8px; }
#right { flex: 1; overflow-y: auto; padding: 12px 16px; }
.card { border: 1px solid #8884; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; cursor: pointer; }
.card.sel { border-color: #06c; border-width: 2px; }
.card .row1 { display: flex; gap: 8px; align-items: baseline; }
.card .tool { font-weight: 700; }
.chip { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: #8883; }
.chip.ok { background: #3a32; } .chip.error { background: #c332; }
.card .meta { font-size: 12px; opacity: .75; margin-top: 2px; }
.card .sum { font-size: 13px; margin-top: 4px; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.tabs button { padding: 3px 10px; border-radius: 12px; border: 1px solid #8886; background: none; cursor: pointer; font-size: 12px; }
.tabs button.on { background: #06c; color: #fff; border-color: #06c; }
pre { white-space: pre-wrap; font-size: 12.5px; background: #8881; padding: 10px; border-radius: 8px; }
button.ctl { padding: 4px 12px; }
</style>
</head>
<body>
<header>
<span id="dot"></span>
<h1>Live MCP Activity</h1>
<label><input type="checkbox" id="follow"> auto-follow newest</label>
<button class="ctl" id="pause">Pause</button>
<span id="count"></span>
</header>
<main>
<div id="left"></div>
<div id="right"><p>Waiting for MCP activity… trigger any tool call and it appears here.</p></div>
</main>
<script>
var state = { events: [], bySeq: {}, selected: null, autoFollow: AUTO_TOKEN, paused: false, cache: {} };
var leftEl = document.getElementById('left');
var rightEl = document.getElementById('right');
var dotEl = document.getElementById('dot');
var followEl = document.getElementById('follow');
var pauseEl = document.getElementById('pause');
var countEl = document.getElementById('count');
followEl.checked = state.autoFollow;
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function tstr(iso) { try { return new Date(iso).toLocaleTimeString(); } catch (e) { return iso; } }
function ingest(ev) {
  if (!ev || typeof ev.seq !== 'number' || state.bySeq[ev.seq]) return false;
  state.bySeq[ev.seq] = ev;
  state.events.push(ev);
  state.events.sort(function (a, b) { return b.seq - a.seq; });
  if (state.events.length > 200) {
    var drop = state.events.pop();
    delete state.bySeq[drop.seq];
  }
  return true;
}
function render() {
  var h = '';
  for (var i = 0; i < state.events.length; i++) {
    var e = state.events[i];
    var cls = e.seq === state.selected ? 'card sel' : 'card';
    h += '<div class="' + cls + '" data-seq="' + e.seq + '">'
      + '<div class="row1"><span class="tool">' + esc(e.tool) + '</span>'
      + '<span class="chip ' + esc(e.outcome) + '">' + esc(e.outcome) + '</span>'
      + '<span class="meta">' + tstr(e.at) + ' · ' + e.durationMs + 'ms</span></div>'
      + '<div class="meta">' + esc(e.caller) + ' · ' + esc(e.client) + (e.sessionId ? ' · ' + esc(e.sessionId.slice(0, 8)) : '')
      + (e.argNames && e.argNames.length ? ' · args: ' + esc(e.argNames.join(',')) : '')
      + (e.beadRefs && e.beadRefs.length ? ' · ' + e.beadRefs.length + ' bead' + (e.beadRefs.length > 1 ? 's' : '') : '')
      + '</div>'
      + '<div class="sum">' + esc((e.summary || '').slice(0, 160)) + '</div>'
      + '</div>';
  }
  leftEl.innerHTML = h || '<p>No events yet.</p>';
  countEl.textContent = state.events.length + ' events';
  var cards = leftEl.querySelectorAll('.card');
  for (var j = 0; j < cards.length; j++) {
    cards[j].addEventListener('click', function () { select(Number(this.getAttribute('data-seq')), false); });
  }
  renderDetail();
}
function renderDetail() {
  var e = state.bySeq[state.selected];
  if (!e) { return; }
  var h = '<h2 style="margin-top:0">' + esc(e.tool) + ' <span class="chip ' + esc(e.outcome) + '">' + esc(e.outcome) + '</span></h2>'
    + '<div class="meta">seq ' + e.seq + ' · ' + esc(e.at) + ' · caller ' + esc(e.caller) + ' · client ' + esc(e.client)
    + ' · ' + e.durationMs + 'ms' + (e.sessionId ? ' · session ' + esc(e.sessionId) : '') + '</div>'
    + '<p>' + esc(e.summary || '(empty result)') + '</p>';
  if (e.beadRefs && e.beadRefs.length) {
    h += '<div class="tabs">';
    for (var i = 0; i < e.beadRefs.length; i++) {
      var id = e.beadRefs[i];
      var on = state.cache[e.seq + ':' + id] && state.cache[e.seq + ':on'] === id ? ' on' : (i === 0 && !state.cache[e.seq + ':on'] ? ' on' : '');
      h += '<button data-id="' + esc(id) + '" class="' + on + '">' + esc(id) + '</button>';
    }
    h += '</div><pre id="beadbody">loading…</pre>';
  } else {
    h += '<p><i>No bead references in this result.</i></p>';
  }
  rightEl.innerHTML = h;
  var btns = rightEl.querySelectorAll('.tabs button');
  for (var k = 0; k < btns.length; k++) {
    btns[k].addEventListener('click', function () { showBead(e, this.getAttribute('data-id')); });
  }
  if (e.beadRefs && e.beadRefs.length) {
    var first = state.cache[e.seq + ':on'] || e.beadRefs[0];
    showBead(e, first);
  }
}
function showBead(e, id) {
  state.cache[e.seq + ':on'] = id;
  var btns = rightEl.querySelectorAll('.tabs button');
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].getAttribute('data-id') === id) btns[i].className = 'on'; else btns[i].className = '';
  }
  var body = document.getElementById('beadbody');
  var key = e.seq + ':' + id;
  if (state.cache[key]) { if (body) body.textContent = state.cache[key]; return; }
  if (body) body.textContent = 'loading…';
  fetch('/' + encodeURIComponent(id), { headers: { 'Accept': 'text/plain' } }).then(function (r) {
    return r.text();
  }).then(function (t) {
    state.cache[key] = t.slice(0, 20000);
    var b = document.getElementById('beadbody');
    if (b && state.cache[e.seq + ':on'] === id) b.textContent = state.cache[key];
  }).catch(function (err) {
    var b = document.getElementById('beadbody');
    if (b) b.textContent = 'fetch failed: ' + err;
  });
}
function select(seq, auto) {
  if (state.paused && auto) return;
  state.selected = seq;
  render();
}
function onEvent(ev) {
  if (!ingest(ev)) return;
  if (state.autoFollow && !state.paused) state.selected = ev.seq;
  else if (!state.selected) state.selected = ev.seq;
  render();
}
function setLive(on) { if (on) dotEl.className = 'on'; else dotEl.className = ''; }
followEl.addEventListener('change', function () { state.autoFollow = followEl.checked; });
pauseEl.addEventListener('click', function () {
  state.paused = !state.paused;
  pauseEl.textContent = state.paused ? 'Resume' : 'Pause';
});
fetch('/live/config').then(function (r) { return r.json(); }).then(function (c) {
  if (c && typeof c.autoFollowDefault === 'boolean') { state.autoFollow = c.autoFollowDefault; followEl.checked = c.autoFollowDefault; }
}).catch(function () {});
var es = null;
try {
  es = new EventSource('/live/events?limit=30');
  es.onmessage = function (m) { try { onEvent(JSON.parse(m.data)); setLive(true); } catch (e) {} };
  es.onerror = function () { setLive(false); startPoll(); };
} catch (e) { startPoll(); }
var polling = false;
function startPoll() {
  if (polling || (es && es.readyState !== 2)) return;
  polling = true;
  setInterval(function () {
    fetch('/live/recent?limit=50').then(function (r) { return r.json(); }).then(function (d) {
      var arr = (d && d.events) || [];
      var changed = false;
      for (var i = arr.length - 1; i >= 0; i--) { if (ingest(arr[i])) changed = true; }
      if (changed) {
        if (state.autoFollow && !state.paused && state.events.length) state.selected = state.events[0].seq;
        render();
      }
      setLive(true);
    }).catch(function () { setLive(false); });
  }, 3000);
}
</script>
</body>
</html>`
    .split('AUTO_TOKEN')
    .join(auto);
}

/** The two-panel page. Auto-follow default comes from the backend config. */
liveRouter.get('/live', (_req: Request, res: Response) => {
  try {
    res.type('text/html').send(renderLivePage(activityAutoFollowDefault()))
  } catch {
    res.status(500).type('text/plain').send('live UI unavailable')
  }
})
