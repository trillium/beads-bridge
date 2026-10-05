// Candidate visualization endpoints for the live MCP activity sidecar
// (project-s1rf.1.1, captain direction 2026-10-05).
//
// These are ADDITIONS. The canonical `GET /live` page in ./activity.ts is
// untouched: same route, same bytes, same behaviour. Each variant below is an
// independently reachable comparison surface, reachable by its own URL, and is
// an experiment until the captain explicitly promotes one to canonical `/live`.
//
// GET-ONLY, by construction and by intent: this router registers only `get`
// handlers, so every variant path answers POST/PUT/DELETE with 404 exactly like
// the rest of the `/live` surface. That is what stops the UI from re-triggering
// itself, and it is a safety boundary — do not add a write route here.
//
// ONE shared event model (see src/lib/live-variants.ts for the full rationale):
// every variant page consumes the existing `/live/config`, `/live/recent`,
// `/live/view`, `/live/heartbeat` and the single `GET /live/events` SSE stream.
// No variant adds a transport, a ring, or server-side state. The client runtime
// is one implementation, inlined per page.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { HEARTBEAT_STALE_AFTER_MS, currentHeartbeatFrame } from '../lib/heartbeat-latest'
import {
  LIVE_VARIANTS,
  VARIANT_PROVENANCE_NOTE,
  inlineJson,
  renderVariantPage,
  type LiveVariant,
} from '../lib/live-variants'
import { currentViewFrame } from '../lib/view-state'
import { activityAutoFollowDefault } from '../lib/activity'
import { renderLivePage } from './activity'

export const mountOrder = -14
export const liveVariantRouter = Router()

const INDEX_CSS = `
:root { color-scheme: light dark; --bg:#f7f5f1; --surface:#fffdf9; --ink:#211e19; --muted:#6b6459; --edge:#d8d2c7; --accent:#0b5bd3; }
@media (prefers-color-scheme: dark) { :root { --bg:#14120e; --surface:#1e1b16; --ink:#ece6d9; --muted:#a89e8d; --edge:#3d382e; --accent:#7aa7ff; } }
* { box-sizing: border-box; }
html, body { max-width: 100%; overflow-x: hidden; }
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--ink); }
main { padding: 14px; }
h1 { font-size: 17px; }
ul { padding-left: 18px; }
li { margin-bottom: 14px; }
.meta { color: var(--muted); font-size: 12.5px; }
`

const BOOT: Record<string, string> = {
  jumbotron: `<div class="jb">
<div class="top"><span class="live idle" id="live">connecting</span>
<div class="stats">
<div class="stat"><b id="statCalls">0</b><span>calls in ring</span></div>
<div class="stat err"><b id="statErrors">0</b><span>errors</span></div>
<div class="stat"><b id="statTools">0</b><span>tools</span></div>
</div></div>
<div class="now" id="now"></div>
<div class="hb" id="hb"></div>
<div class="tape" id="tape"></div>
</div>`,
  timeline: `<div class="tl-wrap">
<div class="tl-axis" id="axis" role="img" aria-label="activity marks over time"></div>
<div class="tl-ticks" id="ticks"></div>
<div class="tl-grid">
<div class="tl-card"><h2>Calls by tool (window)</h2><div id="tools"></div></div>
<div class="tl-card"><h2>Calls by caller (window)</h2><div id="callers"></div></div>
<div class="tl-card"><h2>Window health</h2><div id="latency"></div></div>
</div>
</div>`,
  log: `<div class="lg" id="log" aria-label="activity log tail"></div>`,
  stats: `<div class="st-grid">
<div class="st-card"><h2>Totals (current ring)</h2><div id="totals"></div></div>
<div class="st-card"><h2>Latency distribution</h2><div id="lat"></div></div>
<div class="st-card"><h2>Calls per minute (30 min)</h2><div class="st-buckets" id="buckets"></div><div class="st-legend" id="bucketLegend"></div></div>
</div>
<div class="st-grid" style="margin-top:10px">
<div class="st-card"><h2>By tool</h2><div id="tools"></div></div>
<div class="st-card"><h2>By caller, then client class</h2><div id="callers"></div></div>
</div>`,
}

function variantBySlug(slug: string): LiveVariant | undefined {
  return LIVE_VARIANTS.find((v) => v.slug === slug)
}

/**
 * Index of the comparison surfaces. Deliberately states where each shape comes
 * from, so "candidate" is a claim the reader can audit rather than take on
 * trust — including which shapes were deliberately NOT proposed for this
 * surface.
 */
function renderIndex(): string {
  const rows = LIVE_VARIANTS.map(
    (v) =>
      `<li><a href="/live/${v.slug}"><b>${v.title}</b></a> — <code>/live/${v.slug}</code><br>` +
      `<span class="meta">${v.tagline}</span><br>` +
      `<span class="meta">${v.trade}</span><br>` +
      `<span class="meta">Provenance: ${VARIANT_PROVENANCE_NOTE[v.provenance]}</span></li>`,
  ).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Beads Bridge — Live MCP Activity variants</title>
<style>${INDEX_CSS}</style>
</head>
<body>
<main>
<h1>Live MCP Activity — candidate visualization surfaces</h1>
<p class="meta">Comparison and experimental surfaces for the Beads Bridge live activity sidecar (project-s1rf.1.1). The canonical page at <a href="/live">/live</a> is unchanged and stays canonical until the captain explicitly promotes one of these. All of them read the same in-memory activity ring over the same single <code>GET /live/events</code> stream: one shared event model, no duplicated transport. Every surface is GET-only and observational — no bead mutation, no work creation, no MCP calls driven by display.</p>
<ul>
${rows}
</ul>
<p class="meta">Not included, deliberately: the six displayd <em>beads overview</em> directions (proportional parade, funnel, unblock chains, captain-first, store treemap, stale watch). Those are proposed for displayd's beads overview renderer — a different surface with different data — so reusing them here would be an analogy rather than an implementation of a proposal recorded for this sidecar.</p>
</main>
</body>
</html>`
}

liveVariantRouter.get('/live/variants', (_req: Request, res: Response) => {
  try {
    res.type('text/html').send(renderIndex())
  } catch {
    res.status(500).type('text/plain').send('variant index unavailable')
  }
})

/**
 * `/live/v1` — the canonical page, byte-identical to `GET /live`, reachable
 * under a variant path so the baseline sits beside the candidates. This calls
 * the SAME renderer as the canonical route rather than copying it, so the two
 * cannot drift and canonical behaviour cannot change.
 */
liveVariantRouter.get('/live/v1', (_req: Request, res: Response) => {
  try {
    // Escaped for the inline <script> block exactly as the canonical route does.
    const frame = inlineJson(currentViewFrame())
    const hb = inlineJson(currentHeartbeatFrame())
    res
      .type('text/html')
      .send(renderLivePage(activityAutoFollowDefault(), frame, hb, HEARTBEAT_STALE_AFTER_MS))
  } catch {
    res.status(500).type('text/plain').send('variant unavailable')
  }
})

/** Every other candidate: one page per shape, sharing the one client runtime. */
for (const variant of LIVE_VARIANTS) {
  if (variant.slug === 'v1') continue
  liveVariantRouter.get(`/live/${variant.slug}`, (_req: Request, res: Response) => {
    try {
      res
        .type('text/html')
        .send(renderVariantPage(variant, { boot: BOOT[variant.slug] ?? '<p class="empty">no body</p>' }))
    } catch {
      res.status(500).type('text/plain').send('variant unavailable')
    }
  })
}

/** Test/diagnostic seam: the variant slug list this router serves. */
export function liveVariantSlugs(): string[] {
  return LIVE_VARIANTS.map((v) => v.slug)
}

/** Test/diagnostic seam: read-only look up of one variant definition. */
export function liveVariant(slug: string): LiveVariant | undefined {
  return variantBySlug(slug)
}