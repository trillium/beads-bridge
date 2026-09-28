// Route-level tests for the persistent /live heartbeat surface.
//
// The unit under test is the WIRE: GET /live/heartbeat stays read-only, a
// connecting SSE viewer is replayed the latest heartbeat, live compositions
// arrive as named `event: heartbeat` frames on the existing fan-out (activity
// frames keep their unnamed shape), and the page carries the persistent
// region that updates in place.
//
// Route tests: FUNNEL_BASE=https://example.test bun test src/routes/live-heartbeat.test.ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { liveRouter } from './activity'
import { resetActivity } from '../lib/activity'
import { resetViewState, type SidecarViewFrame } from '../lib/view-state'
import {
  HEARTBEAT_STALE_AFTER_MS,
  currentHeartbeatFrame,
  latestHeartbeat,
  recordLatestHeartbeat,
  resetLatestHeartbeat,
  type HeartbeatFrame,
} from '../lib/heartbeat-latest'

interface Viewer {
  heartbeats: HeartbeatFrame[]
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
  const heartbeats: HeartbeatFrame[] = []
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
              const parsed = JSON.parse(data[1])
              if (named) {
                namedEvents.push(named[1])
                if (named[1] === 'heartbeat') heartbeats.push(parsed as HeartbeatFrame)
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
    heartbeats,
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

describe('/live persistent heartbeat', () => {
  beforeEach(() => {
    resetActivity()
    resetViewState()
    resetLatestHeartbeat()
  })

  it('serves null before any heartbeat, then the latest snapshot read-only', async () => {
    await withApp(async (base) => {
      const empty = await (await fetch(`${base}/live/heartbeat`)).json()
      assert.equal(empty.heartbeat, null)
      assert.equal(empty.staleAfterMs, HEARTBEAT_STALE_AFTER_MS)

      recordLatestHeartbeat({ caller: 'loopback-local', origin: 'footer', text: 'first' })
      recordLatestHeartbeat({ caller: 'loopback-local', origin: 'heartbeat', text: 'second' })
      const full = await (await fetch(`${base}/live/heartbeat`)).json()
      // Cap 1: only the latest snapshot is retained, never a history.
      assert.equal(full.heartbeat.text, 'second')
      assert.equal(full.heartbeat.origin, 'heartbeat')
      assert.equal(full.heartbeat.rev, 2)
      assert.ok(full.heartbeat.atMs > 0)
      assert.equal(latestHeartbeat()?.text, 'second')
    })
  })

  it('bounds the stored text and sanitizes the caller', async () => {
    const frame = recordLatestHeartbeat({
      caller: 'loopback-local',
      origin: 'footer',
      text: 'x'.repeat(5000),
    })
    assert.ok(frame.text.length <= 600, `text must stay bounded, got ${frame.text.length}`)
    const anon = recordLatestHeartbeat({ caller: '', origin: 'footer', text: 't' })
    assert.equal(anon.caller, 'anonymous')
    assert.equal(currentHeartbeatFrame()?.event, 'heartbeat:current')
    assert.equal(currentHeartbeatFrame()?.kind, 'heartbeat')
  })

  it('adds no write route: /live/heartbeat stays GET-only', async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/live/heartbeat`, { method: 'POST' })
      assert.equal(res.status, 404)
    })
  })

  it('replays the current heartbeat to a connecting viewer, then streams updates', async () => {
    await withApp(async (base) => {
      const first = recordLatestHeartbeat({ caller: 'loopback-local', origin: 'footer', text: 'one' })
      const viewer = await openViewer(base)
      try {
        await until('replay frame', () => viewer.heartbeats.length >= 1)
        assert.equal(viewer.heartbeats[0].event, 'heartbeat:current')
        assert.equal(viewer.heartbeats[0].rev, first.rev)
        assert.equal(viewer.heartbeats[0].text, 'one')

        const second = recordLatestHeartbeat({ caller: 'anon', origin: 'heartbeat', text: 'two' })
        await until('live update', () => viewer.heartbeats.some((h) => h.rev === second.rev))
        const update = viewer.heartbeats.find((h) => h.rev === second.rev)
        assert.equal(update?.event, 'heartbeat:update')
        assert.equal(update?.text, 'two')
        // Revisions are monotonic: the viewer can apply last-write-wins.
        const revs = viewer.heartbeats.map((h) => h.rev)
        assert.deepEqual(revs, [...revs].sort((a, b) => a - b))
      } finally {
        await viewer.close()
      }
    })
  })

  it('keeps activity frames unnamed when heartbeats flow on the same fan-out', async () => {
    await withApp(async (base) => {
      const viewer = await openViewer(base)
      try {
        recordLatestHeartbeat({ caller: 'loopback-local', origin: 'footer', text: 'hb' })
        await until('heartbeat frame', () => viewer.heartbeats.length >= 1)
        assert.deepEqual(
          [...new Set(viewer.namedEvents)].sort(),
          ['heartbeat', 'view'],
          'only view + heartbeat are named events',
        )
        assert.equal(viewer.activities.length, 0, 'heartbeat must never enter the activity ring')
      } finally {
        await viewer.close()
      }
    })
  })

  it('serves the page with the persistent heartbeat region baked in', async () => {
    recordLatestHeartbeat({ caller: 'loopback-local', origin: 'heartbeat', text: 'hello-status' })
    await withApp(async (base) => {
      const res = await fetch(`${base}/live`)
      assert.equal(res.status, 200)
      const html = await res.text()
      for (const needle of [
        'id="heartbeat"',
        'aria-label="Latest heartbeat"',
        'id="hbBody"',
        "fetch('/live/heartbeat')",
        "addEventListener('heartbeat'",
        'applyHeartbeat(sharedHeartbeat)',
        'renderHeartbeat',
        '"kind":"heartbeat"',
        'hello-status',
      ]) {
        assert.ok(html.includes(needle), `page is missing heartbeat contract ${needle}`)
      }
      assert.ok(!html.includes('HB_JSON'), 'heartbeat placeholder must be filled')
      assert.ok(!html.includes('STALE_TOKEN'), 'stale placeholder must be filled')
    })
  })

  it('serves the page placeholder before any heartbeat is observed', async () => {
    await withApp(async (base) => {
      const html = await (await fetch(`${base}/live`)).text()
      assert.ok(html.includes('id="heartbeat"'), 'region must exist even with no heartbeat yet')
      assert.ok(html.includes('Waiting for a heartbeat'), 'placeholder must explain the empty state')
    })
  })

  it('view frames still decode for a viewer that only knows view + activity', async () => {
    await withApp(async (base) => {
      const viewer = await openViewer(base)
      try {
        await until('initial frames settle', () => viewer.namedEvents.includes('view'))
        recordLatestHeartbeat({ caller: 'loopback-local', origin: 'footer', text: 'hb' })
        await until('heartbeat arrives', () => viewer.heartbeats.length >= 1)
        // A page that only applies view frames is unaffected by the new event.
        const views = viewer.namedEvents.filter((n) => n === 'view')
        assert.ok(views.length >= 1)
        const hb = viewer.heartbeats[0] as SidecarViewFrame & { kind?: string }
        assert.equal(hb.kind, 'heartbeat', 'heartbeat frames are typed, activity frames stay untyped')
      } finally {
        await viewer.close()
      }
    })
  })
})
