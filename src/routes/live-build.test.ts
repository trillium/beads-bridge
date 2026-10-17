// /live auto-reload on deploy (task-4u4ah): boot id on the wire, baked into
// both page runtimes, and the client guard reloads once per new id.
//
// FUNNEL_BASE=https://example.test bun test src/routes/live-build.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import express from 'express'
import { liveRouter, renderLivePage } from './activity'
import { liveClientJs } from '../lib/live-variants'
import { BOOT_ID, BUILD_COMMIT, buildGuardJs, sseBuildFrame } from '../lib/build-id'

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(liveRouter)
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const addr = server.address() as import('node:net').AddressInfo
  const closer = server as import('node:http').Server & { closeAllConnections?: () => void }
  try {
    await fn(`http://127.0.0.1:${addr.port}`)
  } finally {
    closer.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** Run the client guard in a sandbox with a fake location/sessionStorage. */
function sandbox(opts: { storage?: boolean } = {}) {
  const store: Record<string, string> = {}
  const ctx: Record<string, unknown> = {
    reloads: 0,
    resets: 0,
    location: { reload() { ctx.reloads = (ctx.reloads as number) + 1 } },
    sessionStorage: opts.storage === false
      ? { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
      : { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } },
  }
  vm.createContext(ctx)
  vm.runInContext(buildGuardJs('function () { resets++; }') + '\nthis.checkBuild = checkBuild;', ctx)
  return ctx as { reloads: number; resets: number; checkBuild: (b: unknown) => void }
}

describe('build id', () => {
  it('is computed once and has the expected shape', () => {
    assert.match(BOOT_ID, /^[0-9a-z]{8,}$/)
    assert.match(BUILD_COMMIT, /^([0-9a-f]{4,40}|unknown)$/)
    assert.equal(sseBuildFrame(), sseBuildFrame())
  })

  it('serves the build in /live/config and as a named SSE frame on connect', async () => {
    await withApp(async (base) => {
      const cfg = (await (await fetch(`${base}/live/config`)).json()) as { build: { bootId: string; commit: string } }
      assert.equal(cfg.build.bootId, BOOT_ID)
      assert.equal(cfg.build.commit, BUILD_COMMIT)
      const res = await fetch(`${base}/live/events?limit=0`, { headers: { accept: 'text/event-stream' } })
      const reader = res.body!.getReader()
      let text = ''
      const dec = new TextDecoder()
      while (!text.includes('event: build')) {
        const { value, done } = await reader.read()
        if (done) break
        text += dec.decode(value)
      }
      await reader.cancel()
      assert.match(text, new RegExp(`event: build\\ndata: .*"bootId":"${BOOT_ID}"`))
    })
  })

  it('adds no new route and stays GET-only', async () => {
    await withApp(async (base) => {
      for (const p of ['/live/build', '/live/version']) {
        assert.equal((await fetch(`${base}${p}`)).status, 404)
      }
    })
  })
})

describe('page runtimes bake the boot id', () => {
  it('canonical page and variants runtime carry it and listen for build frames', () => {
    const page = renderLivePage(true, 'null', 'null', 1000)
    assert.ok(page.includes(JSON.stringify(BOOT_ID)))
    assert.ok(page.includes("addEventListener('build'"))
    assert.ok(!page.includes('BUILD_GUARD_JS'))
    const rt = liveClientJs()
    assert.ok(rt.includes(JSON.stringify(BOOT_ID)))
    assert.ok(rt.includes("addEventListener('build'"))
  })

  it('both runtimes reset highest-seen revisions on a boot change', () => {
    assert.ok(renderLivePage(true, 'null', 'null', 1000).includes('state.viewRevision = 0; state.heartbeatRev = 0;'))
    assert.ok(liveClientJs().includes('state.viewRevision = 0; state.heartbeatRev = 0;'))
  })
})

describe('client reload guard', () => {
  it('ignores the same boot id', () => {
    const c = sandbox()
    c.checkBuild({ bootId: BOOT_ID })
    assert.equal(c.reloads, 0)
    assert.equal(c.resets, 0)
  })

  it('reloads once per distinct new id and resets revisions', () => {
    const c = sandbox()
    c.checkBuild({ bootId: 'newer' })
    c.checkBuild({ bootId: 'newer' })
    assert.equal(c.reloads, 1)
    assert.equal(c.resets, 2)
    c.checkBuild({ bootId: 'newest' })
    assert.equal(c.reloads, 2)
  })

  it('falls back to memory when sessionStorage throws', () => {
    const c = sandbox({ storage: false })
    c.checkBuild({ bootId: 'newer' })
    c.checkBuild({ bootId: 'newer' })
    assert.equal(c.reloads, 1)
  })

  it('ignores malformed builds', () => {
    const c = sandbox()
    c.checkBuild(null)
    c.checkBuild({})
    c.checkBuild({ bootId: 5 })
    assert.equal(c.reloads, 0)
  })
})
