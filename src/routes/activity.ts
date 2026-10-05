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
import { currentViewFrame, sseViewFrame } from '../lib/view-state'
import {
  HEARTBEAT_STALE_AFTER_MS,
  currentHeartbeatFrame,
  latestHeartbeat,
  sseHeartbeatFrame,
} from '../lib/heartbeat-latest'
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

// ---- Live MCP Activity UI (project-s1rf.1.1.2, drawer project-s1rf.1.1) ------
// Observational live UI over the activity ring (src/lib/activity.ts): activity
// cards + resolved content on desktop, an off-canvas navigation drawer over the
// live body on a phone. GET-only: the page, its config, recent JSON, the shared
// view state, and the SSE stream. Nothing here mutates beads or creates work —
// bead content in the detail pane is resolved client-side through the existing
// read-only GET /:id route.
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

/**
 * Current shared view state (read-only; same frame shape as the SSE event).
 * The session is the bridge instance — see src/lib/view-state.ts.
 */
liveRouter.get('/live/view', (_req: Request, res: Response) => {
  try {
    res.json(currentViewFrame())
  } catch {
    res.status(500).json({ error: 'view unavailable' })
  }
})

/**
 * Latest observed heartbeat (read-only; null before any heartbeat observed).
 * The persistent status surface: the most recently composed heartbeat block
 * (footer peek or explicit `heartbeat` tool read), with its composition time
 * and caller, so the page can show it in place instead of only transiently
 * beside individual activity. Observational, bounded (cap 1), GET-only.
 */
liveRouter.get('/live/heartbeat', (_req: Request, res: Response) => {
  try {
    res.json({ heartbeat: latestHeartbeat(), staleAfterMs: HEARTBEAT_STALE_AFTER_MS })
  } catch {
    res.status(500).json({ error: 'heartbeat unavailable' })
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

/**
 * SSE stream of activity frames + shared view frames; replays ?limit= recent
 * activity first. Activity frames keep their original unnamed shape; view
 * state arrives as named `event: view` frames on the same fan-out.
 */
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
    // Subscribed before the replay so no live frame is dropped in between: the
    // client dedupes activity by seq and view frames by revision, so replay and
    // live frames may interleave safely.
    for (const ev of recentEvents(limit).slice().reverse()) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`)
    }
    // Current shared view state, so a connecting or reconnecting viewer lands
    // on it instead of holding a stale local guess.
    res.write(sseViewFrame(currentViewFrame()))
    // Latest heartbeat when one has been observed, so a connecting or
    // reconnecting viewer lands on the persistent status surface too.
    // (Absent before any heartbeat: the page then shows its placeholder.)
    try {
      const hb = currentHeartbeatFrame()
      if (hb) res.write(sseHeartbeatFrame(hb))
    } catch {
      /* replay degrades, the stream stays up */
    }
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

/**
 * The canonical page markup. Exported so `/live/v1` (the comparison baseline
 * for the candidate visualization surfaces in src/routes/live-variants.ts) can
 * serve the SAME page rather than a copy — the two cannot drift, and the
 * canonical `/live` route itself is unchanged.
 */
export function renderLivePage(
  autoFollow: boolean,
  viewFrameJson: string,
  heartbeatJson: string,
  staleAfterMs: number,
): string {
  const auto = autoFollow ? 'true' : 'false'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Beads Bridge — Live MCP Activity</title>
<style>
:root {
  color-scheme: light dark;
  /* Light palette (default). Dark scheme overrides below via prefers-color-scheme. */
  --bg: #f7f5f1;
  --surface: #fffdf9;
  --ink: #211e19;
  --muted: #6b6459;
  --edge: #d8d2c7;
  --accent: #0b5bd3;
  --accent-ink: #ffffff;
  --ok: #1e7e34;
  --ok-soft: #ddefe0;
  --err: #b3261e;
  --err-soft: #f9dedc;
  --chip-bg: #e9e4d9;
  --pre-bg: #efece4;
  --scrim: rgba(20, 16, 10, .45);
  --shadow: rgba(30, 25, 15, .25);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14120e;
    --surface: #1e1b16;
    --ink: #ece6d9;
    --muted: #a89e8d;
    --edge: #3d382e;
    --accent: #7aa7ff;
    --accent-ink: #0d1526;
    --ok: #6fcf8b;
    --ok-soft: #1d3a28;
    --err: #ff8a80;
    --err-soft: #4a2320;
    --chip-bg: #2c2820;
    --pre-bg: #24211b;
    --scrim: rgba(0, 0, 0, .6);
    --shadow: rgba(0, 0, 0, .55);
  }
}
* { box-sizing: border-box; }
html, body { max-width: 100%; overflow-x: hidden; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--ink); }
header { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--edge); background: var(--surface); }
header h1 { font-size: 15px; margin: 0; }
#dot { width: 10px; height: 10px; border-radius: 50%; background: var(--err); flex: 0 0 auto; }
#dot.on { background: var(--ok); }
/* Inline-SVG icon set: stroke inherits the control color, sized in em so it
   scales with text and never needs a font download. Decorative instances are
   marked aria-hidden in the markup. */
.icon { width: 1.15em; height: 1.15em; flex: 0 0 auto; vertical-align: -0.22em; }
.st { width: 1em; height: 1em; flex: 0 0 auto; vertical-align: -0.15em; }
button.ctl { display: inline-flex; align-items: center; gap: .45em; padding: 5px 11px; min-height: 32px; border-radius: 8px; border: 1px solid var(--edge); background: var(--surface); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
button.ctl.icon-only { padding: 5px 8px; }
.follow { display: inline-flex; align-items: center; gap: .35em; font-size: 13px; color: var(--muted); }
#count { font-size: 12px; opacity: .7; margin-left: auto; }
/* Persistent heartbeat surface: always-visible latest bridge/agent status,
   updated in place — never pushed out by activity elsewhere in the UI. */
#heartbeat { display: flex; gap: 10px; align-items: flex-start; padding: 8px 12px; border-bottom: 1px solid var(--edge); background: var(--surface); font-size: 13px; }
#hbDot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); margin-top: 3px; flex: 0 0 auto; }
#hbDot.fresh { background: var(--ok); }
#hbDot.stale { background: var(--err); }
#hbBody { flex: 1; min-width: 0; }
#hbBody .hbline { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
#hbBody .hbage { font-weight: 700; }
#hbBody pre { margin: 6px 0 0; max-height: 120px; overflow-y: auto; }
main { display: block; }
/* Mobile-first: the live content IS the document body; navigation is a drawer. */
#panel { position: fixed; top: 0; bottom: 0; left: 0; z-index: 30; width: min(88vw, 360px); max-width: 100%; padding: 8px; padding-top: calc(8px + env(safe-area-inset-top)); padding-bottom: calc(8px + env(safe-area-inset-bottom)); overflow-y: auto; overflow-x: hidden; background: var(--surface); color: var(--ink); border-right: 1px solid var(--edge); box-shadow: 0 0 24px var(--shadow); transform: translateX(-105%); transition: transform .2s ease; }
body.drawer-open #panel { transform: none; }
body:not(.drawer-open) #panel { pointer-events: none; }
#scrim { position: fixed; inset: 0; z-index: 25; background: var(--scrim); opacity: 0; pointer-events: none; transition: opacity .2s ease; }
body.drawer-open #scrim { opacity: 1; pointer-events: auto; }
.panelhead { display: flex; align-items: center; justify-content: space-between; padding: 2px 2px 8px; font-size: 13px; opacity: .8; }
#detail { padding: 12px 14px calc(28px + env(safe-area-inset-bottom)); overflow-x: hidden; }
.card { border: 1px solid var(--edge); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; cursor: pointer; background: var(--surface); }
.card.sel { border-color: var(--accent); border-width: 2px; }
.card .row1 { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.card .tool { font-weight: 700; overflow-wrap: anywhere; display: inline-flex; align-items: center; gap: .35em; }
.chip { display: inline-flex; align-items: center; gap: .3em; font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--chip-bg); color: var(--ink); }
.chip.ok { background: var(--ok-soft); color: var(--ok); } .chip.error { background: var(--err-soft); color: var(--err); }
.card .meta { font-size: 12px; opacity: .75; margin-top: 2px; overflow-wrap: anywhere; }
.card .sum { font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; max-width: 100%; }
.tabs button { padding: 4px 10px; border-radius: 12px; border: 1px solid var(--edge); background: var(--surface); color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.tabs button.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
h2 { font-size: 17px; overflow-wrap: anywhere; }
.meta { overflow-wrap: anywhere; }
/* Anything wide scrolls inside its own box; the page body never goes sideways. */
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; background: var(--pre-bg); color: var(--ink); padding: 10px; border-radius: 8px; max-width: 100%; }
@media (min-width: 900px) {
  #menu, #scrim, .panelhead { display: none; }
  main { display: flex; height: calc(100vh - 53px); }
  #panel { position: static; transform: none; pointer-events: auto; width: 42%; min-width: 320px; max-width: 46%; padding: 8px; border-right: 1px solid var(--edge); box-shadow: none; overflow-y: auto; overflow-x: hidden; background: var(--surface); }
  #detail { flex: 1; overflow-y: auto; }
}
</style>
</head>
<body>
<header>
<button class="ctl icon-only" id="menu" aria-controls="panel" aria-expanded="false" aria-label="Show activity navigation"><svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg></button>
<span id="dot"></span>
<h1>Live MCP Activity</h1>
<label class="follow"><svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><path d="M8 1.5v2.4M8 12.1v2.4M1.5 8h2.4M12.1 8h2.4" stroke-linecap="round"/></svg><input type="checkbox" id="follow"> auto-follow</label>
<button class="ctl" id="pause"><svg class="icon" id="iconPause" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5.5 3v10M10.5 3v10"/></svg><svg class="icon" id="iconPlay" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" style="display:none"><path d="M5 3.2l7.5 4.8L5 12.8z" stroke-linejoin="round"/></svg><span id="pauseLabel">Pause</span></button>
<span id="count"></span>
</header>
<section id="heartbeat" aria-label="Latest heartbeat" aria-live="polite">
<span id="hbDot"></span>
<div id="hbBody"><p>Waiting for a heartbeat… trigger any tool call and the latest bridge status lands here.</p></div>
</section>
<main>
<div id="scrim"></div>
<nav id="panel" aria-label="Activity navigation">
<div class="panelhead"><span>Activity</span><button class="ctl" id="closeNav" aria-label="Hide activity navigation"><svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg><span>Close</span></button></div>
<div id="left"><p>No events yet.</p></div>
</nav>
<section id="detail"><div id="right"><p>Waiting for MCP activity… trigger any tool call and it appears here.</p></div></section>
</main>
<script>
// Shared view state is server-authoritative for this bridge instance: one
// drawer + selected-activity state for every viewer of this session, sent as
// named 'event: view' SSE frames and replayed on connect.
var sharedView = VIEW_JSON;
// Latest observed heartbeat, baked at load (null before any heartbeat).
// Updated in place by GET /live/heartbeat + named SSE 'event: heartbeat'
// frames — never appended as another transient card, never pushed out by
// activity. Frames carry a monotonic rev; last-write-wins.
var sharedHeartbeat = HB_JSON;
var heartbeatStaleAfterMs = STALE_TOKEN;
var state = { events: [], bySeq: {}, selected: null, autoFollow: AUTO_TOKEN, paused: false, cache: {}, viewRevision: 0, drawerLocal: false, heartbeat: null, heartbeatRev: 0 };
var leftEl = document.getElementById('left');
var rightEl = document.getElementById('right');
var dotEl = document.getElementById('dot');
var followEl = document.getElementById('follow');
var pauseEl = document.getElementById('pause');
var pauseLabelEl = document.getElementById('pauseLabel');
var iconPauseEl = document.getElementById('iconPause');
var iconPlayEl = document.getElementById('iconPlay');
var countEl = document.getElementById('count');
var hbDotEl = document.getElementById('hbDot');
var hbBodyEl = document.getElementById('hbBody');
var menuEl = document.getElementById('menu');
var scrimEl = document.getElementById('scrim');
var closeNavEl = document.getElementById('closeNav');
followEl.checked = state.autoFollow;
// ---- drawer + shared view ------------------------------------------------
// A local tap owns the drawer from then on: it cannot be posted back (the
// /live surface is GET-only by design), so server frames bring a viewer to
// the shared state on load and reconnect but never fight a local toggle.
// See docs/live-activity.md "Drawer sync".
function drawerOpen() { return document.body.classList.contains('drawer-open'); }
function setDrawer(open, local) {
  if (local) state.drawerLocal = true;
  document.body.classList.toggle('drawer-open', !!open);
  if (menuEl) menuEl.setAttribute('aria-expanded', open ? 'true' : 'false');
}
// Apply shared state; a lower-or-equal revision is a stale frame and is ignored.
function applyView(frame) {
  if (!frame || typeof frame.revision !== 'number' || frame.revision <= state.viewRevision) return;
  state.viewRevision = frame.revision;
  if (!state.drawerLocal && (frame.drawer === 'open' || frame.drawer === 'closed')) setDrawer(frame.drawer === 'open', false);
  if (state.autoFollow && !state.paused && typeof frame.selectedSeq === 'number' && state.bySeq[frame.selectedSeq]) {
    state.selected = frame.selectedSeq;
    render();
  }
}
function refreshView() {
  fetch('/live/view').then(function (r) { return r.json(); }).then(applyView).catch(function () {});
}
// ---- persistent heartbeat --------------------------------------------------
// One always-visible status surface: the most recently composed heartbeat
// block, refreshed in place. Age ticks locally so a stale heartbeat reads
// as stale rather than as current.
function ageStr(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's ago';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
}
function renderHeartbeat() {
  if (!hbDotEl || !hbBodyEl) return;
  var hb = state.heartbeat;
  if (!hb) {
    hbDotEl.className = '';
    hbBodyEl.innerHTML = '<p>Waiting for a heartbeat… trigger any tool call and the latest bridge status lands here.</p>';
    return;
  }
  var age = Date.now() - hb.atMs;
  var stale = age > heartbeatStaleAfterMs;
  hbDotEl.className = stale ? 'stale' : 'fresh';
  hbBodyEl.innerHTML = '<div class="hbline"><span class="hbage">heartbeat ' + esc(ageStr(age)) + '</span>'
    + (stale ? '<span class="chip error">stale</span>' : '<span class="chip ok">live</span>')
    + '<span class="meta">' + esc(hb.caller) + ' · via ' + esc(hb.origin) + ' · ' + esc(hb.at) + '</span></div>'
    + '<pre>' + esc(hb.text || '(empty heartbeat)') + '</pre>';
}
// Apply one heartbeat frame; a lower-or-equal rev is a stale frame and is ignored.
function applyHeartbeat(frame) {
  if (!frame || typeof frame.rev !== 'number' || frame.rev <= state.heartbeatRev) return;
  state.heartbeatRev = frame.rev;
  state.heartbeat = frame;
  renderHeartbeat();
}
function refreshHeartbeat() {
  fetch('/live/heartbeat').then(function (r) { return r.json(); }).then(function (d) {
    if (d && typeof d.staleAfterMs === 'number' && isFinite(d.staleAfterMs) && d.staleAfterMs > 0) heartbeatStaleAfterMs = d.staleAfterMs;
    if (d) applyHeartbeat(d.heartbeat);
  }).catch(function () {});
}
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
function stIcon(outcome) {
  var open = '<svg class="st" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  if (outcome === 'ok') return open + '<circle cx="8" cy="8" r="6.2"/><path d="M5.4 8.2l1.9 1.9 3.3-3.8"/></svg>';
  if (outcome === 'error') return open + '<circle cx="8" cy="8" r="6.2"/><path d="M6 6l4 4M10 6l-4 4"/></svg>';
  return open + '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.8V8l2.2 1.4"/></svg>';
}
function render() {
  var h = '';
  for (var i = 0; i < state.events.length; i++) {
    var e = state.events[i];
    var cls = e.seq === state.selected ? 'card sel' : 'card';
    h += '<div class="' + cls + '" data-seq="' + e.seq + '">'
      + '<div class="row1"><span class="tool">' + stIcon(e.outcome) + esc(e.tool) + '</span>'
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
    cards[j].addEventListener('click', function () {
      select(Number(this.getAttribute('data-seq')), false);
      if (drawerOpen()) setDrawer(false, true); // reveal what the card points at
    });
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
  if (pauseLabelEl) pauseLabelEl.textContent = state.paused ? 'Resume' : 'Pause';
  if (iconPauseEl) iconPauseEl.style.display = state.paused ? 'none' : '';
  if (iconPlayEl) iconPlayEl.style.display = state.paused ? '' : 'none';
});
menuEl.addEventListener('click', function () { setDrawer(!drawerOpen(), true); });
closeNavEl.addEventListener('click', function () { setDrawer(false, true); });
scrimEl.addEventListener('click', function () { setDrawer(false, true); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawerOpen()) setDrawer(false, true); });
// Baked state first (no flash on a phone), then the live read + stream.
applyView(sharedView);
refreshView();
applyHeartbeat(sharedHeartbeat);
refreshHeartbeat();
setInterval(renderHeartbeat, 5000); // age ticker: stale reads as stale
fetch('/live/config').then(function (r) { return r.json(); }).then(function (c) {
  if (c && typeof c.autoFollowDefault === 'boolean') { state.autoFollow = c.autoFollowDefault; followEl.checked = c.autoFollowDefault; }
}).catch(function () {});
var es = null;
try {
  es = new EventSource('/live/events?limit=30');
  es.onopen = function () { setLive(true); };
  es.onmessage = function (m) { try { onEvent(JSON.parse(m.data)); setLive(true); } catch (e) {} };
  es.addEventListener('view', function (m) { try { applyView(JSON.parse(m.data)); } catch (e) {} });
  es.addEventListener('heartbeat', function (m) { try { applyHeartbeat(JSON.parse(m.data)); } catch (e) {} });
  es.onerror = function () { setLive(false); startPoll(); };
} catch (e) { startPoll(); }
var polling = false;
function startPoll() {
  if (polling || (es && es.readyState !== 2)) return;
  polling = true;
  refreshView();
  setInterval(function () {
    refreshView();
    refreshHeartbeat();
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
    .join(auto)
    .split('VIEW_JSON')
    .join(viewFrameJson)
    .split('HB_JSON')
    .join(heartbeatJson)
    .split('STALE_TOKEN')
    .join(String(staleAfterMs));
}

/** The responsive page: drawer on a phone, two panels on desktop. */
liveRouter.get('/live', (_req: Request, res: Response) => {
  try {
    // Escaped for an inline <script> block: JSON is valid JS, but a literal
    // `<` from a future origin value must not be able to close the tag.
    const frame = JSON.stringify(currentViewFrame()).replace(/</g, '\\u003c')
    const hb = JSON.stringify(currentHeartbeatFrame()).replace(/</g, '\\u003c')
    res
      .type('text/html')
      .send(renderLivePage(activityAutoFollowDefault(), frame, hb, HEARTBEAT_STALE_AFTER_MS))
  } catch {
    res.status(500).type('text/plain').send('live UI unavailable')
  }
})
