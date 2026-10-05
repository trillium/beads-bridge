// Route-level tests for the candidate visualization surfaces under /live
// (project-s1rf.1.1, captain direction 2026-10-05).
//
// What these hold down:
//  - every candidate is independently reachable at its own URL and renders;
//  - `/live/v1` is the canonical page byte-for-byte, so canonical /live is
//    stable and the baseline cannot drift from the candidates;
//  - all of them consume the ONE shared event model (/live/events + the
//    existing read-only /live/* reads) — no per-variant transport, no second
//    ring, no second EventSource;
//  - the observational/GET-only boundary is not weakened: no variant path
//    accepts a write verb;
//  - a real recorded activity event reaches a variant's transport.
//
// Route tests: FUNNEL_BASE=https://example.test bun test src/routes/live-variants.test.ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { liveRouter } from './activity'
import { liveVariantRouter, liveVariantSlugs } from './live-variants'
import { LIVE_VARIANTS } from '../lib/live-variants'
import { recordEvent, resetActivity } from '../lib/activity'
import { resetViewState } from '../lib/view-state'
import { resetLatestHeartbeat } from '../lib/heartbeat-latest'

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(liveRouter)
  app.use(liveVariantRouter)
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const base = `http://127.0.0.1:${(addr as import('node:net').AddressInfo).port}`
  const closer = server as import('node:http').Server & { closeAllConnections?: () => void }
  try {
    await fn(base)
  } finally {
    closer.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function anEvent(tool = 'bead_show') {
  return {
    at: new Date().toISOString(),
    tool,
    outcome: 'ok' as const,
    caller: 'loopback-local',
    sessionId: null,
    client: 'curl',
    authed: false,
    durationMs: 7,
    argNames: ['id'],
    beadRefs: [],
    summary: 'ok',
  }
}

describe('/live candidate visualization surfaces', () => {
  beforeEach(() => {
    resetActivity()
    resetViewState()
    resetLatestHeartbeat()
  })

  it('serves an index that names every variant and its provenance', async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/live/variants`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/html/)
      const html = await res.text()
      for (const v of LIVE_VARIANTS) {
        assert.ok(html.includes(`/live/${v.slug}`), `index must link /live/${v.slug}`)
        assert.ok(html.includes(v.title), `index must name ${v.title}`)
      }
      assert.ok(html.includes('Provenance:'), 'index must state where each shape comes from')
      assert.ok(html.includes('/live/events'), 'index must name the one shared stream')
    })
  })

  it('renders every candidate at its own endpoint', async () => {
    await withApp(async (base) => {
      assert.deepEqual(liveVariantSlugs(), LIVE_VARIANTS.map((v) => v.slug))
      for (const v of LIVE_VARIANTS) {
        const res = await fetch(`${base}/live/${v.slug}`)
        assert.equal(res.status, 200, `GET /live/${v.slug}`)
        assert.match(res.headers.get('content-type') ?? '', /text\/html/)
        const html = await res.text()
        assert.ok(html.includes(`<title>Beads Bridge`), `/live/${v.slug} renders a document`)
        // /live/v1 IS the canonical page, so it carries the canonical chrome
        // (and, deliberately, no variant nav — canonical stays untouched).
        if (v.slug === 'v1') continue
        assert.ok(html.includes('/live"'), `/live/${v.slug} keeps canonical /live reachable`)
        assert.ok(html.includes('/live/variants'), `/live/${v.slug} links the index`)
        assert.ok(html.includes('/live/v1'), `/live/${v.slug} links the baseline`)
      }
    })
  })

  it('keeps canonical /live byte-identical and reachable as /live/v1', async () => {
    await withApp(async (base) => {
      const canonical = await fetch(`${base}/live`)
      const v1 = await fetch(`${base}/live/v1`)
      assert.equal(canonical.status, 200)
      assert.equal(v1.status, 200)
      const a = await canonical.text()
      const b = await v1.text()
      assert.equal(b, a, '/live/v1 must be the canonical page, not a copy that can drift')
      // The canonical drawer contract is untouched.
      assert.ok(a.includes('nav id="panel"') || a.includes('id="panel"'))
      assert.ok(a.includes('aria-controls="panel"'))
      assert.ok(a.includes('@media (min-width: 900px)'))
    })
  })

  it('shares one event model: every candidate reads the existing /live contract only', async () => {
    await withApp(async (base) => {
      for (const v of LIVE_VARIANTS) {
        if (v.slug === 'v1') continue
        const html = await (await fetch(`${base}/live/${v.slug}`)).text()
        assert.ok(html.includes('window.LiveUI'), `${v.slug} uses the shared client runtime`)
        assert.ok(html.includes("EventSource('/live/events"), `${v.slug} consumes the one SSE stream`)
        assert.ok(html.includes("fetch('/live/recent"), `${v.slug} reads the existing recent snapshot`)
        assert.ok(html.includes("fetch('/live/view"), `${v.slug} reads the existing shared view state`)
        assert.ok(html.includes("fetch('/live/heartbeat"), `${v.slug} reads the existing heartbeat surface`)
        assert.ok(html.includes("fetch('/live/config"), `${v.slug} reads the existing config`)
        // Exactly one stream per page: no duplicated transport.
        assert.equal(
          html.split("EventSource('/live/events").length - 1,
          1,
          `${v.slug} must open the stream exactly once`,
        )
        // Observational: a candidate never asks the bridge to do anything.
        assert.ok(!/\bfetch\((['"`])\/(?!live\/)/.test(html), `${v.slug} must not fetch outside /live/*`)
        assert.ok(!html.includes("method: 'POST'") && !html.includes('method:"POST"'), `${v.slug} must not POST`)
      }
    })
  })

  it('bounds what a candidate keeps client-side', async () => {
    await withApp(async (base) => {
      const html = await (await fetch(`${base}/live/log`)).text()
      assert.ok(html.includes('var MAX = 500'), 'the shared client caps its ring')
      assert.ok(html.includes("Math.min(MAX, Number(state.config.maxEvents)"), 'the server cap wins when smaller')
      // Replay limits are bounded by the variant, not unbounded.
      const m = /EventSource\('\/live\/events\?limit=' \+ limit\)/.test(html)
      assert.ok(m, 'the stream is opened with a bounded limit')
    })
  })

  it('adds no write route: the candidate surface stays GET-only', async () => {
    await withApp(async (base) => {
      const paths = ['/live/variants', ...LIVE_VARIANTS.map((v) => `/live/${v.slug}`)]
      for (const path of paths) {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
          const res = await fetch(`${base}${path}`, { method })
          assert.equal(res.status, 404, `${method} ${path} must not exist`)
        }
      }
    })
  })

  it('delivers a recorded activity event on the stream the candidates read', async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/live/events?limit=0`, { headers: { accept: 'text/event-stream' } })
      assert.equal(res.status, 200)
      assert.ok(res.body)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const seen: { tool?: string }[] = []
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            for (const line of decoder.decode(value, { stream: true }).split('\n')) {
              if (!line.startsWith('data: ')) continue
              try {
                const parsed = JSON.parse(line.slice(6)) as { tool?: string }
                if (parsed.tool) seen.push(parsed)
              } catch {
                /* view/heartbeat frames carry no tool */
              }
            }
          }
        } catch {
          /* aborted below */
        }
      })()
      try {
        recordEvent(anEvent('bead_show'))
        const start = Date.now()
        while (!seen.some((e) => e.tool === 'bead_show') && Date.now() - start < 3000) {
          await new Promise((r) => setTimeout(r, 10))
        }
        assert.ok(seen.some((e) => e.tool === 'bead_show'), 'the shared stream carried the recorded event')
        // And the same event is readable from the JSON snapshot a variant polls.
        const recent = (await (await fetch(`${base}/live/recent?limit=5`)).json()) as {
          events: { tool: string }[]
        }
        assert.ok(recent.events.some((e) => e.tool === 'bead_show'))
      } finally {
        await reader.cancel()
        await pump.catch(() => undefined)
      }
    })
  })
})