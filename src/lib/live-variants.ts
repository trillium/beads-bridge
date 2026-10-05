// Candidate visualization surfaces for the live MCP activity sidecar.
//
// CAPTAIN DIRECTION (project-s1rf.1.1, 2026-10-05): the canonical `GET /live`
// page stays exactly as it is; every other viable visualization of the SAME
// activity stream is built beside it as its own independently reachable
// `/live/<variant>` endpoint. They are comparison/experimental surfaces until
// the captain explicitly promotes one to canonical `/live` — so nothing here
// replaces anything, and nothing here is a claim about which one wins.
//
// ONE SHARED EVENT/STATE MODEL (the deterministic default, chosen here rather
// than escalated):
//
//   Every variant consumes the EXISTING sidecar contract verbatim —
//   `GET /live/config`, `GET /live/recent?limit=`, `GET /live/view`,
//   `GET /live/heartbeat`, and the ONE SSE stream `GET /live/events` with its
//   unnamed `data:` activity frames plus named `event: view` /
//   `event: heartbeat` frames. There is no second transport, no per-variant
//   ring, no per-variant state and no per-variant push channel; the client
//   runtime below (`liveClientJs`) is the single implementation of those
//   semantics, inlined into every variant page.
//
//   Why that is deterministic rather than a choice to escalate: it is the
//   contract the canonical page already obeys. Determinism rules that every
//   variant inherits, unchanged:
//     - ordering: by `seq` (monotonic per-process completion order), ascending
//       in every variant, deduped by seq so a replayed frame and a live frame
//       of the same event are one event;
//     - view/heartbeat state: whole-state frames with a monotonic revision /
//       `rev`, applied last-write-wins, a stale frame ignored;
//     - reconnection: `/live/events` replays recent activity and the current
//       view + heartbeat frame on every connect, so a (re)connecting variant
//       lands on current state instead of an empty page;
//     - boundedness: client ring capped by `/live/config`'s `maxEvents` (hard
//       cap 500) — a variant can never grow an unbounded buffer;
//     - failure isolation: a throwing render callback cannot break ingest, and
//       a dead stream degrades to polling the same two GET endpoints.
//
// SAFETY (inherited from docs/live-activity.md — do not weaken): observational
// only, GET-only, no store reads, no bead mutation, no work creation, no agent
// requests, no argument values (names only, as the ring already records) and no
// second transport that could re-trigger the bridge.

/** Where a variant's shape comes from, so the comparison is honest. */
export type VariantProvenance = 'canonical' | 'record' | 'derived'

export interface LiveVariant {
  /** URL segment under /live (also the page title slug). */
  slug: string
  /** Human name shown on the page and in the index. */
  title: string
  /** One line: what this surface is for. */
  tagline: string
  provenance: VariantProvenance
  /** What the shape optimizes for (and what it gives up), one line. */
  trade: string
  /** Variant-only CSS, inlined into the page (shared tokens are separate). */
  css: string
  /** Variant-only JS body; runs with `window.LiveUI` available. */
  script: string
}

/** Ring cap the client may never exceed regardless of server config. */
export const VARIANT_MAX_EVENTS = 500

/** Shared tokens + resets. Same palette discipline as the canonical page. */
export const VARIANT_CSS = `
:root {
  color-scheme: light dark;
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
  }
}
* { box-sizing: border-box; }
html, body { max-width: 100%; overflow-x: hidden; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--ink); }
a { color: var(--accent); }
.vhead { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--edge); background: var(--surface); }
.vhead h1 { font-size: 15px; margin: 0; }
.vhead .tag { font-size: 12px; color: var(--muted); }
.vnav { display: flex; gap: 8px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--edge); background: var(--surface); font-size: 12.5px; }
.vnav a { text-decoration: none; border: 1px solid var(--edge); border-radius: 12px; padding: 2px 9px; }
.vnav a.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
#dot { width: 10px; height: 10px; border-radius: 50%; background: var(--err); flex: 0 0 auto; }
#dot.on { background: var(--ok); }
.chip { display: inline-flex; align-items: center; gap: .3em; font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--chip-bg); color: var(--ink); }
.chip.ok { background: var(--ok-soft); color: var(--ok); }
.chip.error { background: var(--err-soft); color: var(--err); }
.meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
main { padding: 12px; }
.empty { color: var(--muted); }
`

/**
 * The single client runtime every variant shares. One implementation of the
 * sidecar event model, inlined per page (self-contained: no external asset).
 * Variants only supply a render callback; they never touch the transport.
 */
export function liveClientJs(): string {
  return `(function () {
  var MAX = ${VARIANT_MAX_EVENTS};
  var state = {
    events: [], bySeq: {},
    config: { autoFollowDefault: true, maxEvents: 200 },
    view: null, viewRevision: 0,
    heartbeat: null, heartbeatRev: 0, staleAfterMs: 300000,
    connected: false, frames: 0
  };
  var listeners = { activity: [], view: [], heartbeat: [], status: [] };

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tstr(iso) { try { return new Date(iso).toLocaleTimeString(); } catch (e) { return String(iso || ''); } }
  function hms(iso) {
    try {
      var d = new Date(iso);
      var p = function (n, w) { return String(n).padStart(w || 2, '0'); };
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
    } catch (e) { return String(iso || ''); }
  }
  function dur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '-';
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
  }
  function ageStr(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's ago';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
  }
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    var i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[i];
  }
  function emit(kind, arg) {
    var ls = listeners[kind] || [];
    for (var i = 0; i < ls.length; i++) {
      try { ls[i](arg); } catch (e) { /* a broken render never breaks ingest */ }
    }
  }
  function setConnected(on) {
    state.connected = !!on;
    var dot = document.getElementById('dot');
    if (dot) dot.className = on ? 'on' : '';
    emit('status', on);
  }
  // One event, one slot: dedupe by seq, order by seq ascending (completion
  // order), and keep the ring bounded by the server-configured cap.
  function ingest(ev) {
    if (!ev || typeof ev.seq !== 'number' || state.bySeq[ev.seq]) return false;
    state.bySeq[ev.seq] = ev;
    state.events.push(ev);
    state.events.sort(function (a, b) { return a.seq - b.seq; });
    var cap = Math.min(MAX, Number(state.config.maxEvents) || 200);
    while (state.events.length > cap) {
      var drop = state.events.shift();
      delete state.bySeq[drop.seq];
    }
    state.frames++;
    emit('activity', ev);
    return true;
  }
  // Whole-state frames, monotonic revision: last-write-wins, stale ignored.
  function applyView(frame) {
    if (!frame || typeof frame.revision !== 'number' || frame.revision <= state.viewRevision) return;
    state.viewRevision = frame.revision;
    state.view = frame;
    emit('view', frame);
  }
  function applyHeartbeat(frame) {
    if (!frame || typeof frame.rev !== 'number' || frame.rev <= state.heartbeatRev) return;
    state.heartbeatRev = frame.rev;
    state.heartbeat = frame;
    emit('heartbeat', frame);
  }
  function pollOnce() {
    fetch('/live/recent?limit=50').then(function (r) { return r.json(); }).then(function (d) {
      var arr = (d && d.events) || [];
      for (var i = arr.length - 1; i >= 0; i--) ingest(arr[i]);
      setConnected(true);
    }).catch(function () { setConnected(false); });
  }
  function start(opts) {
    opts = opts || {};
    var limit = Math.min(200, Math.max(1, Number(opts.limit) || 60));
    fetch('/live/config').then(function (r) { return r.json(); }).then(function (c) {
      if (c && typeof c.maxEvents === 'number') state.config.maxEvents = c.maxEvents;
      emit('status', state.connected);
    }).catch(function () {});
    fetch('/live/view').then(function (r) { return r.json(); }).then(applyView).catch(function () {});
    fetch('/live/heartbeat').then(function (r) { return r.json(); }).then(function (d) {
      if (d && typeof d.staleAfterMs === 'number' && d.staleAfterMs > 0) state.staleAfterMs = d.staleAfterMs;
      if (d) applyHeartbeat(d.heartbeat);
    }).catch(function () {});
    pollOnce();
    var es = null;
    try {
      // The ONE stream. Replay + current view + current heartbeat arrive on
      // every connect, so a reconnect lands on current state.
      es = new EventSource('/live/events?limit=' + limit);
      es.onopen = function () { setConnected(true); };
      es.onmessage = function (m) { try { ingest(JSON.parse(m.data)); setConnected(true); } catch (e) {} };
      es.addEventListener('view', function (m) { try { applyView(JSON.parse(m.data)); } catch (e) {} });
      es.addEventListener('heartbeat', function (m) { try { applyHeartbeat(JSON.parse(m.data)); } catch (e) {} });
      es.onerror = function () { setConnected(false); startPolling(); };
    } catch (e) { startPolling(); }
    var polling = false;
    function startPolling() {
      if (polling) return;
      polling = true;
      // Same two read-only GETs — not a second transport, just a fallback.
      setInterval(function () {
        fetch('/live/view').then(function (r) { return r.json(); }).then(applyView).catch(function () {});
        pollOnce();
      }, 3000);
    }
  }
  window.LiveUI = {
    state: state,
    start: start,
    ingest: ingest,
    esc: esc, tstr: tstr, hms: hms, dur: dur, ageStr: ageStr, quantile: quantile,
    on: function (kind, fn) { if (listeners[kind]) listeners[kind].push(fn); }
  };
})();`
}

/** Escape JSON for an inline <script> block (`<` can never close the tag). */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value).replace(/</g, '\\u003c')
}

// ---- the variants -------------------------------------------------------------

const JUMBOTRON_CSS = `
.jb { min-height: 92vh; display: flex; flex-direction: column; gap: 2.2vh; }
.jb .top { display: flex; flex-wrap: wrap; gap: 2vh; align-items: baseline; }
.jb .live { font-size: clamp(28px, 6vh, 76px); font-weight: 800; letter-spacing: .04em; }
.jb .live.idle { color: var(--muted); }
.jb .stats { display: flex; flex-wrap: wrap; gap: 2.5vh; margin-left: auto; }
.jb .stat { text-align: right; }
.jb .stat b { display: block; font-size: clamp(22px, 4.4vh, 60px); line-height: 1.05; }
.jb .stat span { font-size: clamp(11px, 1.7vh, 20px); text-transform: uppercase; letter-spacing: .09em; color: var(--muted); }
.jb .stat.err b { color: var(--err); }
.jb .now { border-top: 2px solid var(--edge); border-bottom: 2px solid var(--edge); padding: 1.6vh 0; }
.jb .now .tool { font-size: clamp(30px, 7.5vh, 104px); font-weight: 800; line-height: 1.02; overflow-wrap: anywhere; }
.jb .now .outcome { font-size: clamp(18px, 4vh, 54px); font-weight: 700; }
.jb .now .outcome.ok { color: var(--ok); }
.jb .now .outcome.error { color: var(--err); }
.jb .now .line2 { font-size: clamp(14px, 2.6vh, 34px); color: var(--muted); margin-top: .5vh; }
.jb .hb { font-size: clamp(12px, 2.1vh, 26px); color: var(--muted); }
.jb .hb b { color: var(--ink); }
.jb .tape { margin-top: auto; border-top: 2px solid var(--edge); padding-top: 1vh; }
.jb .row { display: flex; gap: 1.4vh; align-items: baseline; font-size: clamp(13px, 2.3vh, 30px); padding: .25vh 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jb .row .t { color: var(--muted); font-variant-numeric: tabular-nums; }
.jb .row .o { width: 3.4em; font-weight: 700; }
.jb .row .o.error { color: var(--err); }
.jb .row .o.ok { color: var(--ok); }
.jb .row .n { font-weight: 700; }
@media (max-width: 640px) { .jb .stats { margin-left: 0; } .jb .stat { text-align: left; } }
`

const JUMBOTRON_SCRIPT = `
var el = function (id) { return document.getElementById(id); };
var tapeEl = el('tape');
function render() {
  var s = LiveUI.state, evs = s.events;
  var newest = evs.length ? evs[evs.length - 1] : null;
  var errors = 0;
  for (var i = 0; i < evs.length; i++) if (evs[i].outcome === 'error') errors++;
  var age = newest ? Date.now() - new Date(newest.at).getTime() : Infinity;
  var live = s.connected && isFinite(age) && age < 60000;
  el('live').textContent = s.connected ? (live ? 'LIVE' : 'IDLE') : 'RECONNECTING';
  el('live').className = 'live' + (live ? '' : ' idle');
  el('statCalls').textContent = String(evs.length);
  el('statErrors').textContent = String(errors);
  el('statTools').textContent = String(Object.keys(counts()).length);
  if (newest) {
    el('now').innerHTML =
      '<div class="line2">' + LiveUI.esc(LiveUI.hms(newest.at)) + ' · ' + LiveUI.dur(newest.durationMs) + ' · caller '
      + LiveUI.esc(newest.caller) + '</div>'
      + '<div class="tool">' + LiveUI.esc(newest.tool) + ' <span class="outcome ' + LiveUI.esc(newest.outcome) + '">'
      + LiveUI.esc(newest.outcome) + '</span></div>'
      + '<div class="line2">' + LiveUI.esc((newest.summary || '').slice(0, 220)) + '</div>';
  } else {
    el('now').innerHTML = '<div class="tool">Waiting for MCP activity</div><div class="line2">Trigger any tool call and it lands here within a frame or two.</div>';
  }
  var hb = s.heartbeat;
  el('hb').innerHTML = hb
    ? 'heartbeat <b>' + LiveUI.esc(LiveUI.ageStr(Date.now() - hb.atMs)) + '</b> from ' + LiveUI.esc(hb.caller)
      + ' via ' + LiveUI.esc(hb.origin) + (Date.now() - hb.atMs > s.staleAfterMs ? ' · <b>stale</b>' : '')
    : 'no heartbeat observed yet';
  var rows = '';
  var start = Math.max(0, evs.length - 9);
  for (var j = evs.length - 1; j >= start; j--) {
    var e = evs[j];
    rows += '<div class="row"><span class="t">' + LiveUI.esc(LiveUI.hms(e.at)) + '</span>'
      + '<span class="o ' + LiveUI.esc(e.outcome) + '">' + LiveUI.esc(e.outcome) + '</span>'
      + '<span class="n">' + LiveUI.esc(e.tool) + '</span>'
      + '<span class="t">' + LiveUI.dur(e.durationMs) + '</span></div>';
  }
  tapeEl.innerHTML = rows;
}
function counts() {
  var out = {};
  var evs = LiveUI.state.events;
  for (var i = 0; i < evs.length; i++) out[evs[i].tool] = (out[evs[i].tool] || 0) + 1;
  return out;
}
LiveUI.on('activity', render);
LiveUI.on('view', render);
LiveUI.on('heartbeat', render);
LiveUI.on('status', render);
LiveUI.start({ limit: 60 });
render();
setInterval(render, 1000);
`

const TIMELINE_CSS = `
.tl-wrap { display: block; }
.tl-axis { position: relative; height: clamp(90px, 22vh, 190px); border: 1px solid var(--edge); border-radius: 10px; background: var(--surface); overflow: hidden; }
.tl-now { position: absolute; top: 0; bottom: 0; right: 0; width: 2px; background: var(--accent); }
.tl-mark { position: absolute; bottom: 0; border-radius: 2px 2px 0 0; background: var(--ok); }
.tl-mark.error { background: var(--err); }
.tl-mark.selected { outline: 2px solid var(--accent); outline-offset: 1px; }
.tl-ticks { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 4px; }
.tl-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-top: 14px; }
.tl-card { border: 1px solid var(--edge); border-radius: 10px; background: var(--surface); padding: 10px 12px; }
.tl-card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 8px; }
.tl-bar { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; font-size: 12.5px; padding: 2px 0; }
.tl-bar .n { color: var(--muted); }
.tl-bar .track { grid-column: 1 / -1; height: 6px; border-radius: 3px; background: var(--chip-bg); overflow: hidden; }
.tl-bar .fill { height: 100%; background: var(--accent); }
.tl-bar .fill.err { background: var(--err); }
.tl-kv { display: flex; justify-content: space-between; font-size: 12.5px; padding: 1px 0; }
.tl-kv b { font-variant-numeric: tabular-nums; }
.tl-empty { color: var(--muted); font-size: 12.5px; }
`

const TIMELINE_SCRIPT = `
var axis = document.getElementById('axis');
function pct(t, start, span) { return Math.max(0, Math.min(100, ((t - start) / span) * 100)); }
function render() {
  var s = LiveUI.state, evs = s.events;
  var now = Date.now();
  var span = Math.max(60000, 120000);
  var first = null;
  for (var i = 0; i < evs.length; i++) {
    var t = new Date(evs[i].at).getTime();
    if (t < now - span) continue;
    if (first === null || t < first) first = t;
  }
  if (first !== null && now - first < span) span = now - first;
  var start = now - span;
  var marks = '';
  var tools = {}, callers = {}, errs = 0, durs = [];
  for (var j = 0; j < evs.length; j++) {
    var e = evs[j], t = new Date(e.at).getTime();
    if (t < start) continue;
    tools[e.tool] = (tools[e.tool] || 0) + 1;
    callers[e.caller] = (callers[e.caller] || 0) + 1;
    if (e.outcome === 'error') errs++;
    if (typeof e.durationMs === 'number') durs.push(e.durationMs);
    var w = Math.max(0.6, Math.min(6, (e.durationMs || 0) / 250));
    var sel = s.view && s.view.selectedSeq === e.seq ? ' selected' : '';
    marks += '<div class="tl-mark' + (e.outcome === 'error' ? ' error' : '') + sel + '" style="left:' + pct(t, start, span)
      + '%;width:' + w + '%;height:' + (e.outcome === 'error' ? 100 : 40 + Math.min(55, (e.durationMs || 0) / 40)) + '%" title="'
      + LiveUI.esc(LiveUI.hms(e.at) + ' ' + e.tool + ' ' + e.outcome + ' ' + LiveUI.dur(e.durationMs)) + '"></div>';
  }
  axis.innerHTML = marks + '<div class="tl-now"></div>';
  var tk = document.getElementById('ticks');
  tk.innerHTML = '<span>' + LiveUI.esc(LiveUI.tstr(new Date(start).toISOString())) + '</span><span>window '
    + LiveUI.dur(span) + '</span><span>now</span>';
  var rows = '';
  var names = Object.keys(tools).sort(function (a, b) { return tools[b] - tools[a] || (a < b ? -1 : 1); });
  var max = names.length ? tools[names[0]] : 1;
  for (var k = 0; k < names.length && k < 12; k++) {
    rows += '<div class="tl-bar"><span>' + LiveUI.esc(names[k]) + '</span><span class="n">' + tools[names[k]] + '</span>'
      + '<span class="track"><span class="fill" style="width:' + (100 * tools[names[k]] / max).toFixed(1) + '%"></span></span></div>';
  }
  document.getElementById('tools').innerHTML = rows || '<div class="tl-empty">no calls in this window yet</div>';
  var crows = '';
  var cnames = Object.keys(callers).sort(function (a, b) { return callers[b] - callers[a] || (a < b ? -1 : 1); });
  for (var m = 0; m < cnames.length && m < 10; m++) {
    crows += '<div class="tl-bar"><span>' + LiveUI.esc(cnames[m]) + '</span><span class="n">' + callers[cnames[m]] + '</span></div>';
  }
  document.getElementById('callers').innerHTML = crows || '<div class="tl-empty">no callers yet</div>';
  durs.sort(function (a, b) { return a - b; });
  var n = durs.length;
  document.getElementById('latency').innerHTML =
    '<div class="tl-kv"><span>calls in window</span><b>' + n + '</b></div>'
    + '<div class="tl-kv"><span>errors</span><b>' + errs + '</b></div>'
    + '<div class="tl-kv"><span>error rate</span><b>' + (n ? ((100 * errs / n).toFixed(0) + '%') : '0%') + '</b></div>'
    + '<div class="tl-kv"><span>p50 latency</span><b>' + LiveUI.dur(LiveUI.quantile(durs, 0.5)) + '</b></div>'
    + '<div class="tl-kv"><span>p95 latency</span><b>' + LiveUI.dur(LiveUI.quantile(durs, 0.95)) + '</b></div>'
    + '<div class="tl-kv"><span>slowest</span><b>' + LiveUI.dur(durs.length ? durs[durs.length - 1] : 0) + '</b></div>'
    + '<div class="tl-kv"><span>newest call</span><b>' + (n ? LiveUI.esc(LiveUI.ageStr(now - new Date(evs[evs.length - 1].at).getTime())) : 'none') + '</b></div>';
}
LiveUI.on('activity', render);
LiveUI.on('view', render);
LiveUI.on('status', render);
LiveUI.start({ limit: 100 });
render();
setInterval(render, 1000);
`

const LOG_CSS = `
.lg { background: var(--pre-bg); border: 1px solid var(--edge); border-radius: 10px; padding: 8px 10px; max-height: 72vh; overflow: auto; }
.lg .line { display: grid; grid-template-columns: 12.5em 4.5em 4em 13em 6em 9em 1fr; gap: 8px; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
.lg .line .o.error { color: var(--err); font-weight: 700; }
.lg .line .o.ok { color: var(--ok); }
.lg .line .s { color: var(--muted); }
.lg .line .t { overflow: hidden; text-overflow: ellipsis; }
.lg .head { color: var(--muted); border-bottom: 1px solid var(--edge); position: sticky; top: -8px; background: var(--pre-bg); }
@media (max-width: 700px) {
  .lg .line { grid-template-columns: 8.5em 3.6em 1fr; }
  .lg .line .hidesm { display: none; }
}
`

const LOG_SCRIPT = `
function render() {
  var evs = LiveUI.state.events, h = '';
  h += '<div class="line head"><span>time</span><span>seq</span><span>outcome</span><span>tool</span>'
    + '<span class="hidesm">dur</span><span class="hidesm">caller</span><span class="hidesm">detail</span></div>';
  if (!evs.length) h += '<div class="line"><span class="s">no events yet — this log fills from the same stream as every other /live surface</span></div>';
  for (var i = evs.length - 1; i >= 0; i--) {
    var e = evs[i];
    var detail = (e.argNames && e.argNames.length ? 'args=' + e.argNames.join(',') : '') + (e.beadRefs && e.beadRefs.length ? ' beads=' + e.beadRefs.length : '');
    h += '<div class="line"><span>' + LiveUI.esc(LiveUI.hms(e.at)) + '</span><span class="s">' + e.seq + '</span>'
      + '<span class="o ' + LiveUI.esc(e.outcome) + '">' + LiveUI.esc(e.outcome) + '</span>'
      + '<span class="t">' + LiveUI.esc(e.tool) + '</span>'
      + '<span class="hidesm">' + LiveUI.dur(e.durationMs) + '</span>'
      + '<span class="hidesm s">' + LiveUI.esc(e.caller) + '</span>'
      + '<span class="t s">' + LiveUI.esc(detail || (e.summary || '').slice(0, 90)) + '</span></div>';
  }
  document.getElementById('log').innerHTML = h;
}
LiveUI.on('activity', render);
LiveUI.on('status', render);
LiveUI.start({ limit: 200 });
render();
`

const STATS_CSS = `
.st-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.st-card { border: 1px solid var(--edge); border-radius: 10px; background: var(--surface); padding: 10px 12px; }
.st-card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 8px; }
.st-kv { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; padding: 2px 0; }
.st-kv b { font-variant-numeric: tabular-nums; }
.st-kv b.err { color: var(--err); }
.st-buckets { display: flex; align-items: flex-end; gap: 2px; height: 90px; margin-top: 6px; }
.st-buckets .b { flex: 1 1 auto; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 1px; position: relative; }
.st-buckets .b.zero { background: var(--chip-bg); }
.st-buckets .b .e { position: absolute; left: 0; right: 0; bottom: 0; background: var(--err); border-radius: 0 0 2px 2px; }
.st-legend { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 4px; }
.st-bar { height: 6px; border-radius: 3px; background: var(--chip-bg); overflow: hidden; margin-top: 2px; }
.st-bar .fill { display: block; height: 100%; background: var(--accent); }
`

const STATS_SCRIPT = `
function tally(list, keyFn) {
  var out = {}, i, k;
  for (i = 0; i < list.length; i++) { k = keyFn(list[i]); out[k] = (out[k] || 0) + 1; }
  return out;
}
function bar(table, errTable, limit) {
  var names = Object.keys(table).sort(function (a, b) { return table[b] - table[a] || (a < b ? -1 : 1); });
  var max = names.length ? table[names[0]] : 1;
  var h = '';
  for (var i = 0; i < names.length && i < limit; i++) {
    var name = names[i], n = table[name], e = (errTable && errTable[name]) || 0;
    h += '<div class="st-buckets" style="height:auto"><div style="width:100%"><div class="st-kv"><span>' + LiveUI.esc(name)
      + '</span><span><b>' + n + '</b>' + (e ? ' <b class="err">' + e + ' err</b>' : '') + '</span></div>'
      + '<div class="st-bar"><span class="fill" style="width:' + (100 * n / max).toFixed(1) + '%"></span></div></div></div>';
  }
  return h || '<div class="meta">nothing recorded yet</div>';
}
function render() {
  var s = LiveUI.state, evs = s.events;
  var errors = 0, durs = [], sessions = {}, i;
  for (i = 0; i < evs.length; i++) {
    if (evs[i].outcome === 'error') errors++;
    if (typeof evs[i].durationMs === 'number') durs.push(evs[i].durationMs);
    if (evs[i].sessionId) sessions[evs[i].sessionId] = true;
  }
  durs.sort(function (a, b) { return a - b; });
  var toolT = tally(evs, function (e) { return e.tool; });
  var toolE = tally(evs.filter(function (e) { return e.outcome === 'error'; }), function (e) { return e.tool; });
  var callerT = tally(evs, function (e) { return e.caller; });
  var clientT = tally(evs, function (e) { return e.client; });
  var n = evs.length;
  document.getElementById('totals').innerHTML =
    '<div class="st-kv"><span>calls in ring</span><b>' + n + '</b></div>'
    + '<div class="st-kv"><span>errors</span><b class="' + (errors ? 'err' : '') + '">' + errors + '</b></div>'
    + '<div class="st-kv"><span>error rate</span><b>' + (n ? (100 * errors / n).toFixed(1) + '%' : '0%') + '</b></div>'
    + '<div class="st-kv"><span>distinct tools</span><b>' + Object.keys(toolT).length + '</b></div>'
    + '<div class="st-kv"><span>distinct callers</span><b>' + Object.keys(callerT).length + '</b></div>'
    + '<div class="st-kv"><span>distinct sessions</span><b>' + Object.keys(sessions).length + '</b></div>';
  document.getElementById('lat').innerHTML =
    '<div class="st-kv"><span>p50</span><b>' + LiveUI.dur(LiveUI.quantile(durs, 0.5)) + '</b></div>'
    + '<div class="st-kv"><span>p90</span><b>' + LiveUI.dur(LiveUI.quantile(durs, 0.9)) + '</b></div>'
    + '<div class="st-kv"><span>p99</span><b>' + LiveUI.dur(LiveUI.quantile(durs, 0.99)) + '</b></div>'
    + '<div class="st-kv"><span>max</span><b>' + LiveUI.dur(durs.length ? durs[durs.length - 1] : 0) + '</b></div>'
    + '<div class="st-kv"><span>total wall time</span><b>' + LiveUI.dur(durs.reduce(function (a, b) { return a + b; }, 0)) + '</b></div>';
  document.getElementById('tools').innerHTML = bar(toolT, toolE, 12);
  document.getElementById('callers').innerHTML = bar(callerT, null, 8) + bar(clientT, null, 8);
  var now = Date.now(), buckets = [], bi;
  for (bi = 0; bi < 30; bi++) buckets.push({ t: now - (29 - bi) * 60000, n: 0, e: 0 });
  for (i = 0; i < evs.length; i++) {
    var t = new Date(evs[i].at).getTime();
    var idx = Math.floor((t - (now - 30 * 60000)) / 60000);
    if (idx >= 0 && idx < 30) { buckets[idx].n++; if (evs[i].outcome === 'error') buckets[idx].e++; }
  }
  var maxN = buckets.reduce(function (a, b) { return Math.max(a, b.n); }, 0) || 1;
  var bh = '';
  for (bi = 0; bi < buckets.length; bi++) {
    var b = buckets[bi];
    bh += '<div class="b' + (b.n ? '' : ' zero') + '" style="height:' + Math.max(2, Math.round(100 * b.n / maxN)) + '%" title="'
      + LiveUI.esc(LiveUI.tstr(new Date(b.t).toISOString()) + ': ' + b.n + ' calls, ' + b.e + ' errors') + '">'
      + (b.e ? '<span class="e" style="height:' + Math.round(100 * b.e / Math.max(1, b.n)) + '%"></span>' : '') + '</div>';
  }
  document.getElementById('buckets').innerHTML = bh;
  document.getElementById('bucketLegend').innerHTML = '<span>30 min ago</span><span>peak ' + maxN + '/min</span><span>now</span>';
}
LiveUI.on('activity', render);
LiveUI.on('status', render);
LiveUI.start({ limit: 200 });
render();
`

/**
 * The candidate variants. `v1` is the canonical page itself — reached through
 * this router so the comparison baseline lives beside the candidates; the
 * canonical `/live` route is untouched and still renders the same bytes.
 */
export const LIVE_VARIANTS: LiveVariant[] = [
  {
    slug: 'v1',
    title: 'Canonical two-panel sidecar',
    tagline: 'The current /live page, reachable as a variant so every candidate can be compared against it side by side.',
    provenance: 'canonical',
    trade: 'Optimizes for: reading one call in full. Gives up: cross-call comparison, and glanceability from across a room.',
    css: '',
    script: '',
  },
  {
    slug: 'jumbotron',
    title: 'Jumbotron (glanceable wall panel)',
    tagline: 'Large-type, high-contrast, no-interaction rendering of the same stream, sized for a wall display across the room.',
    provenance: 'record',
    trade: 'Optimizes for: one glance — is it live, is anything failing, what ran last. Gives up: detail, history, and any way to inspect a call.',
    css: JUMBOTRON_CSS,
    script: JUMBOTRON_SCRIPT,
  },
  {
    slug: 'timeline',
    title: 'Timeline (live event window)',
    tagline: 'The stream as a time axis: one mark per call positioned by completion time, width by duration, colour by outcome, plus per-tool and per-caller roll-ups.',
    provenance: 'record',
    trade: 'Optimizes for: the shape of traffic — bursts, gaps, error clusters, slow calls. Gives up: any readable text of an individual result.',
    css: TIMELINE_CSS,
    script: TIMELINE_SCRIPT,
  },
  {
    slug: 'log',
    title: 'Log tail (dense monospace)',
    tagline: 'One fixed-width line per call, newest first — the highest-density reading of the same stream, for scanning rather than browsing.',
    provenance: 'derived',
    trade: 'Optimizes for: scanning many calls fast and seeing arg names/bead-ref counts. Gives up: visual grouping, result text, and any per-call detail pane.',
    css: LOG_CSS,
    script: LOG_SCRIPT,
  },
  {
    slug: 'stats',
    title: 'Roll-up (aggregate readouts)',
    tagline: 'No per-call surface at all: totals, error rate, latency percentiles, per-tool/caller/client counts and a 30-minute call histogram.',
    provenance: 'derived',
    trade: 'Optimizes for: "is the fleet healthy", answering from aggregates. Gives up: which specific call did what.',
    css: STATS_CSS,
    script: STATS_SCRIPT,
  },
]

/** Why each shape is in the comparison (provenance, kept honest on the index). */
export const VARIANT_PROVENANCE_NOTE: Record<VariantProvenance, string> = {
  canonical: 'The shipped canonical page (project-s1rf.1.1.2 MVP), exposed unchanged as the comparison baseline.',
  record: 'A shape proposed for this stream in the project record: the jumbotron wall view (firstmate data/displayd-activity-bridge) and the live MCP event window that displayd’s activity renderer owns (data/displayd-beads-variants/report.md).',
  derived: 'Not separately proposed in the record — added as a clearly-labelled comparison candidate so the captain has a genuinely different reading to compare against.',
}

/** Render one variant page shell: shared tokens + shared client + variant body. */
export function renderVariantPage(variant: LiveVariant, options: { boot: string }): string {
  const nav = LIVE_VARIANTS.map(
    (v) => `<a href="/live/${v.slug}" class="${v.slug === variant.slug ? 'on' : ''}">${v.title}</a>`,
  ).join('')
  const note = VARIANT_PROVENANCE_NOTE[variant.provenance]
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Beads Bridge — Live MCP Activity — ${variant.title}</title>
<style>${VARIANT_CSS}${variant.css}</style>
</head>
<body>
<header class="vhead">
<span id="dot" title="stream connected"></span>
<h1>${variant.title}</h1>
<span class="tag">candidate surface · not canonical</span>
<span class="tag"><a href="/live">canonical /live</a> · <a href="/live/variants">all variants</a></span>
</header>
<nav class="vnav" aria-label="Live visualization variants">${nav}</nav>
<main>${options.boot}<p class="meta">${variant.tagline} ${variant.trade}</p><p class="meta">Why this shape: ${note} Every surface here reads the same ring over the same <code>GET /live/events</code> stream — one shared event model, no duplicated transport.</p></main>
<script>${liveClientJs()}</script>
<script>${variant.script}</script>
</body>
</html>`
}