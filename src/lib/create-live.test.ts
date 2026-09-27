// LIVE round-trip: long durable reports must survive the bridge's own
// write path end to end — the exact functions the bead_create, bead_edit,
// and bead_batch_create MCP tools call (createBead, editBead, runBatch via
// src/lib/create.ts, src/lib/edit.ts, src/lib/batch.ts) against a REAL
// store that is SCRATCH, not the captain's task store (task-8hmyn):
// per-run temp Dolt store via `bd init -p task`, reached through a
// `bd`-router shim that steers the hard-pinned `task` wrapper's leaf `bd`
// calls to scratch. Real lib + real CLI + real Dolt — only the database
// is throwaway.
//
// This test would have caught BOTH failure modes of the 4,000-char limit:
// the schema rejection (a 5,200-char description must be accepted, not
// throw) and the silent slice (the tail marker 5,200 chars in must read
// back — a cut at 4,000 chars drops it with no error).
//
// Scratch beads are force-deleted afterwards (and asserted gone). Requires
// the `bd` binary to be reachable; FUNNEL_BASE must still be set so
// src/config.ts imports.
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createBead } from './create'
import { editBead } from './edit'
import { runBatch } from './batch'
import { showBeadAsync } from '../routes/query/store'
import { execStdout } from './exec'
import {
  liveRunTag,
  initScratchStoreSync,
  sweepScratchBeadsSync,
  shimBdRouter,
  removeScratchStore,
} from './live-test-store'

const STORE = 'task'
// Run-derived tag (task-8hmyn): unique per run, never a hardcoded string.
// LEGACY_TAG is swept on the REAL store at suite start (with an age guard
// so a concurrent old-code run's in-flight beads are never reaped).
const TAG = liveRunTag('bb-live-ld')
const LEGACY_TAG = 'bb-live-longdesc'

// Suite setup at import time as blocking sync statements, NOT in before()
// (hook budget is 5s; the package is type:commonjs so no top-level await).
// Sweep BEFORE the router is installed, so it hits the real store
// (legacy-orphan hygiene with a 30-minute age guard); a setup failure
// throws here and fails the file loudly. Isolation is a `bd`-router shim
// (see live-test-store.ts): it steers the task wrapper's leaf `bd` calls
// to scratch while keeping the wrapper's own pins (BD_NAME, knowledge
// root, exfil flat) intact.
let scratchDir = ''
let restoreShim: (() => void) | null = null
try {
  sweepScratchBeadsSync(STORE, `${LEGACY_TAG} `, 30 * 60 * 1000)
  scratchDir = initScratchStoreSync('task')
  restoreShim = shimBdRouter({ task: scratchDir })
} catch (e) {
  throw new Error(`create-live setup failed (isolation not installed): ${(e as Error)?.message ?? e}`)
}

after(() => {
  restoreShim?.()
  restoreShim = null
  if (scratchDir) removeScratchStore(scratchDir)
  scratchDir = ''
})

function scratchTitle(): string {
  return `${TAG} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// A body sized like the fleet's durable reports: 5,200 chars of payload
// between unique head/tail markers. The tail marker is the assertion that
// matters — any silent cut at 4,000 chars drops it.
function longBody(tag: string): { body: string; head: string; tail: string } {
  const head = `LONG-HEAD-${tag}`
  const tail = `LONG-TAIL-${tag}`
  return { body: `${head} ${'x'.repeat(5200)} ${tail}`, head, tail }
}

async function shownText(id: string): Promise<string> {
  const shown = await showBeadAsync(STORE, id)
  assert.ok(shown, `bead ${id} must read back after write`)
  return shown
}

async function cleanup(id: string): Promise<void> {
  await execStdout(STORE, ['delete', id, '--force'], 20000).catch(() => {})
  assert.equal(await showBeadAsync(STORE, id), null, `scratch bead ${id} must be gone after cleanup`)
}

describe('long-description live round-trip', () => {
  it('createBead stores a 5,200-char description whole and reads it back', { timeout: 120000 }, async (t) => {
    const { body, head, tail } = longBody(`create-${Date.now()}`)
    assert.ok(body.length > 5200)
    const { id, verified } = await createBead({ store: STORE, title: scratchTitle(), description: body })
    t.after(() => cleanup(id))
    assert.equal(verified, true, 'create must verify read-after-write')
    const shown = await shownText(id)
    assert.ok(shown.includes(head), 'head marker reads back')
    assert.ok(shown.includes(tail), 'tail marker 5,200 chars in reads back — no silent truncation')
  })

  it('editBead replaces a description with a long one, whole', { timeout: 120000 }, async (t) => {
    const seed = await createBead({ store: STORE, title: scratchTitle(), description: 'seed' })
    t.after(() => cleanup(seed.id))
    const { body, head, tail } = longBody(`edit-${Date.now()}`)
    const r = await editBead({ store: STORE, id: seed.id, description: body })
    assert.equal(r.verified, true, 'edit must verify read-after-write')
    const shown = await shownText(seed.id)
    assert.ok(shown.includes(head), 'edited head marker reads back')
    assert.ok(shown.includes(tail), 'edited tail marker reads back — no silent truncation')
  })

  it('runBatch stores a long bead description whole', { timeout: 120000 }, async (t) => {
    const { body, head, tail } = longBody(`batch-${Date.now()}`)
    const r = await runBatch({
      beads: [{ name: 'report', store: STORE, title: scratchTitle(), description: body }],
    })
    assert.equal(r.complete, true, `batch must land completely: ${JSON.stringify(r.failures)}`)
    const id = r.beads[0].id
    t.after(() => cleanup(id))
    const shown = await shownText(id)
    assert.ok(shown.includes(head), 'batch head marker reads back')
    assert.ok(shown.includes(tail), 'batch tail marker reads back — no silent truncation')
  })
})
