// LIVE round-trip: long durable reports must survive the bridge's own
// write path end to end — the exact functions the bead_create, bead_edit,
// and bead_batch_create MCP tools call (createBead, editBead, runBatch via
// src/lib/create.ts, src/lib/edit.ts, src/lib/batch.ts) against the live
// `task` store through the same CLIs every route shells out to.
//
// This test would have caught BOTH failure modes of the 4,000-char limit:
// the schema rejection (a 5,200-char description must be accepted, not
// throw) and the silent slice (the tail marker 5,200 chars in must read
// back — a cut at 4,000 chars drops it with no error).
//
// Scratch beads are force-deleted afterwards (and asserted gone) so the
// store is left as found. Requires the `task` CLI + store to be
// reachable; FUNNEL_BASE must still be set so src/config.ts imports.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createBead } from './create'
import { editBead } from './edit'
import { runBatch } from './batch'
import { showBeadAsync } from '../routes/query/store'
import { execStdout } from './exec'

const STORE = 'task'
const TAG = 'bb-live-longdesc'

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
