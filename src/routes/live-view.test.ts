// Route-level tests for the /live sidecar surface (project-s1rf.1.1).
//
// The unit tests cover the view model; these cover the WIRE: the route stays
// GET-only, a connecting viewer is handed the current shared state, one change
// reaches TWO simultaneous viewers with the same revision (two devices on one
// bridge instance = one session), and activity frames keep their original
// shape so an older page is unaffected.
//
// Route tests: FUNNEL_BASE=https://example.test bun test src/routes/live-view.test.ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { liveRouter } from './activity'
import { recordEvent, resetActivity } from '../lib/activity'
import { DEFAULT_DRAWER, resetViewState, setView, type SidecarViewFrame } from '../lib/view-state'
import { resetLatestHeartbeat } from '../lib/heartbeat-latest'

interface Viewer {
  views: SidecarViewFrame[]
  activities: { seq?: number; tool?: string; kind?: string }[]
  namedEvents: string[]
  close: () => Promise<void>
}

/** Open a real SSE connection and decode its frames the way a page does. */
async function openViewer(base: string, limit = 0): Promise<Viewer> {
  const res = await fetch(`${base}/live/events?limit=${limit}`, {
    headers: { accept: 'text/event-stream' },
  })
  assert.equal(res.status, 200)
  assert.ok(res.body, 'SSE route returned no stream')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const views: SidecarViewFrame[] = []
  const activities: { seq?: number; tool?: string; kind?: string }[] = []
  const namedEvents: string[] = []
  let buffer = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut = buffer.indexOf('\n\n')
        while (cut !== -1) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const named = /^event: (.+)$/m.exec(block)
          const data = /^data: (.*)$/m.exec(block)
          if (data) {
            try {
              const parsed = JSON.parse(data[1]) as SidecarViewFrame
              if (named) {
                namedEvents.push(named[1])
                if (named[1] === 'view') views.push(parsed)
              } else {
                activities.push(parsed)
              }
            } catch {
              /* retry/ping blocks carry no JSON */
            }
          }
          cut = buffer.indexOf('\n\n')
        }
      }
    } catch {
      /* aborted by close() */
    }
  })()
  return {
    views,
    activities,
    namedEvents,
    close: async () => {
      await reader.cancel()
      await pump.catch(() => undefined)
    },
  }
}

async function until(what: string, pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(liveRouter)
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
    at: new Date(0).toISOString(),
    tool,
    outcome: 'ok' as const,
    caller: 'loopback-local',
    sessionId: null,
    client: 'curl',
    authed: false,
    durationMs: 2,
    argNames: ['id'],
    beadRefs: [],
    summary: 'x',
  }
}

describe('/live view state over HTTP', () => {
  beforeEach(() => {
    resetActivity()
    resetViewState()
    resetLatestHeartbeat()
  })

  it('serves the current shared state read-only', async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/live/view`)
      assert.equal(res.status, 200)
      const frame = (await res.json()) as SidecarViewFrame
      assert.equal(frame.kind, 'view')
      assert.equal(frame.event, 'view:current')
      assert.equal(frame.drawer, DEFAULT_DRAWER)
      assert.equal(frame.selectedSeq, null)
    })
  })

  it('adds no write route: the whole /live surface stays GET-only', async () => {
    await withApp(async (base) => {
      for (const path of ['/live', '/live/view', '/live/recent', '/live/config', '/live/events', '/live/heartbeat']) {
        const res = await fetch(`${base}${path}`, { method: 'POST' })
        assert.equal(res.status, 404, `POST ${path} should not exist`)
      }
    })
  })

  it('hands a connecting viewer the current state, not a stale guess', async () => {
    setView({ drawer: 'open' }, 'test')
    setView({ selectedSeq: 7 }, 'test')
    await withApp(async (base) => {
      const viewer = await openViewer(base)
      try {
        await until('initial view frame', () => viewer.views.length >= 1)
        assert.equal(viewer.views[0].event, 'view:current')
        assert.equal(viewer.views[0].drawer, 'open')
        assert.equal(viewer.views[0].selectedSeq, 7)
      } finally {
        await viewer.close()
      }
    })
  })

  it('broadcasts one change to two simultaneous viewers at the same revision', async () => {
    await withApp(async (base) => {
      const a = await openViewer(base)
      const b = await openViewer(base)
      try {
        await until('both initial frames', () => a.views.length >= 1 && b.views.length >= 1)
        const sent = setView({ drawer: 'open' }, 'test')
        await until('both change frames', () => a.views.length >= 2 && b.views.length >= 2)
        const lastA = a.views[a.views.length - 1]
        const lastB = b.views[b.views.length - 1]
        assert.deepEqual(lastA, lastB)
        assert.equal(lastA.revision, sent.revision)
        assert.equal(lastA.event, 'view:open')
        assert.equal(lastA.drawer, 'open')
      } finally {
        await a.close()
        await b.close()
      }
    })
  })

  it('moves both viewers to the same cursor when activity arrives', async () => {
    await withApp(async (base) => {
      const a = await openViewer(base)
      const b = await openViewer(base)
      try {
        await until('both initial frames', () => a.views.length >= 1 && b.views.length >= 1)
        const ev = recordEvent(anEvent())
        await until(
          'both cursor frames',
          () => a.views.some((v) => v.selectedSeq === ev.seq) && b.views.some((v) => v.selectedSeq === ev.seq),
        )
        for (const viewer of [a, b]) {
          const frame = viewer.views.find((v) => v.selectedSeq === ev.seq)
          assert.ok(frame)
          assert.equal(frame.event, 'view:select')
          assert.equal(frame.origin, 'activity')
          assert.ok(
            viewer.activities.some((e) => e.seq === ev.seq),
            'activity frame still delivered to the same connection',
          )
        }
      } finally {
        await a.close()
        await b.close()
      }
    })
  })

  it('keeps activity frames in their original unnamed shape (older page unaffected)', async () => {
    await withApp(async (base) => {
      const viewer = await openViewer(base)
      try {
        await until('initial view frame', () => viewer.views.length >= 1)
        const ev = recordEvent(anEvent('query_store'))
        await until('activity frame', () => viewer.activities.some((e) => e.seq === ev.seq))
        const frame = viewer.activities.find((e) => e.seq === ev.seq)
        assert.ok(frame)
        assert.equal(frame.tool, 'query_store')
        assert.equal(frame.kind, undefined, 'activity frames stay untyped on the wire')
        assert.deepEqual([...new Set(viewer.namedEvents)], ['view'], 'view is the only named event')
      } finally {
        await viewer.close()
      }
    })
  })

  it('serves the design system: token palette, both schemes, inline icons', async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/live`)
      assert.equal(res.status, 200)
      const html = await res.text()
      // Token palette on :root, OS-driven scheme, both palettes deliberate.
      for (const needle of [
        ':root',
        'color-scheme: light dark',
        'prefers-color-scheme: dark',
        '--bg',
        '--surface',
        '--ink',
        '--accent',
        '--ok-soft',
        '--err-soft',
      ]) {
        assert.ok(html.includes(needle), `page is missing palette token ${needle}`)
      }
      // Inline-SVG icon set, decorative instances hidden, controls still named.
      for (const needle of [
        '<svg',
        'aria-hidden="true"',
        'aria-label="Show activity navigation"',
        'aria-label="Hide activity navigation"',
        'id="pauseLabel"',
        'stIcon(e.outcome)',
      ]) {
        assert.ok(html.includes(needle), `page is missing icon contract ${needle}`)
      }
      // Scattered literals and the literal hamburger are gone (tokens only).
      for (const banned of ['☰', '#06c', '#c33', 'background: Canvas', 'background: none', 'color: #fff']) {
        assert.ok(!html.includes(banned), `page still contains design literal ${banned}`)
      }
      // Self-contained: no external stylesheet, font, or icon download.
      for (const banned of ['<link rel="stylesheet"', '@import', 'fonts.googleapis', 'font-awesome', 'cdn.']) {
        assert.ok(!html.includes(banned), `page must stay self-contained, found ${banned}`)
      }
    })
  })

  it('serves the page with the responsive drawer contract baked in', async () => {
    setView({ drawer: 'open' }, 'test')
    await withApp(async (base) => {
      const res = await fetch(`${base}/live`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/html/)
      const html = await res.text()
      for (const needle of [
        'width=device-width',
        'overflow-x: hidden', // the page body never scrolls sideways
        '@media (min-width: 900px)', // desktop keeps the two-panel layout
        'id="panel"',
        'aria-controls="panel"',
        'drawer-open',
        "addEventListener('view'",
        'fetch(\'/live/view\')',
        'applyView(sharedView)',
      ]) {
        assert.ok(html.includes(needle), `page is missing ${needle}`)
      }
      assert.ok(!html.includes('VIEW_JSON'), 'baked placeholder must be filled')
      assert.ok(html.includes(`"drawer":"open"`), 'current shared state must be baked in')
    })
  })
})
