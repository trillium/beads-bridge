// The /live event stream page (task-7y3fm): display-only jumbotron records,
// newest first, family-coded, with explicit truncation markers. Behavioural
// client logic is exercised in a real browser (ops/live-shot.mjs); these pin
// the contract the server hands the page.
// Route tests: FUNNEL_BASE=https://example.test bun test src/routes/live-stream.test.ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { liveRouter } from './activity'
import { recordEvent, recentEvents, resetActivity } from '../lib/activity'
import { resetViewState } from '../lib/view-state'
import { TOOL_FAMILIES } from '../lib/tool-family'

async function withApp<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express()
  app.use(liveRouter)
  const server = app.listen(0)
  try {
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    return await fn(`http://127.0.0.1:${addr.port}`)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

const base = {
  at: new Date(0).toISOString(),
  outcome: 'ok' as const,
  caller: 'loopback-local',
  sessionId: null,
  client: 'curl',
  authed: false,
  durationMs: 4,
  argNames: [],
  beadRefs: [],
  summary: '',
}

describe('/live event stream', () => {
  beforeEach(() => {
    resetActivity()
    resetViewState()
  })

  it('serves the stream region with the family table and truncation marker baked in', async () => {
    await withApp(async (url) => {
      const html = await (await fetch(`${url}/live`)).text()
      for (const needle of ['id="stream"', 'class="rec-tool"', 'rec-args', 'class="trunc"', 'more char', 'not shown', 'function renderStream', '--fam-read', '--fam-write', 'prefers-reduced-motion']) {
        assert.ok(html.includes(needle), `page is missing ${needle}`)
      }
      assert.ok(!html.includes('FAMILY_JSON'), 'family placeholder must be filled')
      for (const f of TOOL_FAMILIES) assert.ok(html.includes(`"key":"${f.key}"`), `family ${f.key} not embedded`)
    })
  })

  it('adds only local view toggles: raw/expand/copy buttons, no new fetches or routes', async () => {
    await withApp(async (url) => {
      const html = await (await fetch(`${url}/live`)).text()
      for (const needle of ['data-raw=', 'data-expand=', 'id="copyAll"', 'function yamlHtml', 'function rawLine', 'rec-raw']) {
        assert.ok(html.includes(needle), `page is missing ${needle}`)
      }
      const js = html.slice(html.indexOf('function copyText'), html.indexOf('function select(seq'))
      assert.ok(!/fetch\(|method:\s*'(POST|PUT|DELETE)'/.test(js), 'toggle code makes no requests')
      assert.ok(!html.includes('YAML_LIB_JS'), 'yaml lib placeholder must be filled')
    })
  })

  it('outcome pills are icon+text and family colors avoid the outcome green/red', async () => {
    await withApp(async (url) => {
      const html = await (await fetch(`${url}/live`)).text()
      assert.ok(html.includes("pill(esc(e.outcome), stIcon(e.outcome)"), 'outcome pill carries an icon and text')
      const fams = [...html.matchAll(/--fam-(read|write|relay|feedback|system|memory|other): (#[0-9a-f]{6})/g)]
      assert.ok(fams.length >= 7)
      for (const [, , hex] of fams) assert.ok(!['#1e7e34', '#6fcf8b', '#b3261e', '#ff8a80'].includes(hex), `${hex} collides with outcome colors`)
    })
  })

  it('/live/recent hands the page newest-first records with redacted, bounded args', async () => {
    recordEvent({ ...base, tool: 'bead_show', args: '{"id":"task-1"}', argsOmitted: 0 })
    recordEvent({ ...base, tool: 'bead_note', args: '{"token":"[redacted]"}', argsOmitted: 12, summary: 'hi', summaryOmitted: 3 })
    assert.equal(recentEvents(5)[0].tool, 'bead_note')
    await withApp(async (url) => {
      const body = (await (await fetch(`${url}/live/recent?limit=10`)).json()) as { events: Array<Record<string, unknown>> }
      assert.deepEqual(body.events.map((e) => e.tool), ['bead_note', 'bead_show'])
      assert.equal(body.events[0].argsOmitted, 12)
      assert.equal(body.events[0].summaryOmitted, 3)
      assert.ok(!JSON.stringify(body).includes('hunter'))
    })
  })

  it('adds no route: write methods on /live still 404', async () => {
    await withApp(async (url) => {
      for (const m of ['POST', 'PUT', 'DELETE']) {
        assert.equal((await fetch(`${url}/live`, { method: m })).status, 404)
      }
    })
  })
})
