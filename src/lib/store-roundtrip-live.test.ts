// LIVE round-trip of store_health's roundtrip check (feedback k3az) against a
// SCRATCH store — never a production one. Same isolation as create-live.test.ts:
// per-run temp Dolt store reached through the `bd`-router shim, so the real
// `task` wrapper + real bd + real Dolt run and only the database is throwaway.
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createBead } from './create'
import { execStdout } from './exec'
import { formatRoundTrip, ROUNDTRIP_REFUSED_STORES, storeRoundTrip } from './store-roundtrip'
import { showBeadAsync } from '../routes/query/store'
import { initScratchStoreSync, liveRunTag, removeScratchStore, shimBdRouter } from './live-test-store'

const STORE = 'task'
const TAG = liveRunTag('bb-rt')

// Skips (loudly, with the reason) when this host's bd cannot init an isolated
// scratch store — e.g. a global bd config that pins every workspace to a shared
// server makes `bd init` refuse. Nothing is written to a production store either way.
let scratchDir = ''
let restoreShim: (() => void) | null = null
let skipReason: string | false = false
try {
  scratchDir = initScratchStoreSync('task')
  restoreShim = shimBdRouter({ task: scratchDir })
} catch (e) {
  skipReason = `scratch store unavailable on this host: ${((e as Error)?.message ?? String(e)).split('\n')[0].slice(0, 160)}`
}
after(() => {
  restoreShim?.()
  restoreShim = null
  if (scratchDir) removeScratchStore(scratchDir)
})

describe('storeRoundTrip (scratch store)', () => {
  it('read-only run reads a known record; write run creates, reads back and closes a test bead', { timeout: 180000, skip: skipReason }, async (t) => {
    const seed = await createBead({ store: STORE, title: `${TAG} seed`, description: 'seed record to read' })
    t.after(() => execStdout(STORE, ['delete', seed.id, '--force'], 20000).catch(() => {}))

    const ro = await storeRoundTrip(STORE)
    assert.equal(ro.ok, true, formatRoundTrip(ro))
    assert.equal(ro.testBeadId, undefined, 'read-only run must not create anything')

    const rw = await storeRoundTrip(STORE, { write: true })
    assert.equal(rw.ok, true, formatRoundTrip(rw))
    assert.ok(rw.testBeadId, 'write run reports the test bead id')
    t.after(() => execStdout(STORE, ['delete', rw.testBeadId!, '--force'], 20000).catch(() => {}))
    assert.deepEqual(rw.steps.map((s) => s.step), ['identify', 'read known record', 'create test bead', 'close test bead'])
    const shown = await showBeadAsync(STORE, rw.testBeadId!)
    assert.ok(shown && /closed/i.test(shown), 'test bead is closed afterwards, not left open')
    assert.match(formatRoundTrip(rw), /PASS/)
  })

  it('inbox is refused for the write round-trip (its create emits dispatch events)', () => {
    assert.ok(ROUNDTRIP_REFUSED_STORES.includes('inbox'))
  })
})
