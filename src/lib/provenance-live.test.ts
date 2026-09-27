// LIVE round-trip: creation provenance (task-mm2zq) must survive the
// bridge's own write path end to end — the exact functions each creation
// path calls — against live stores through the same CLIs every route shells
// out to. One scratch bead per path (MCP tool args, paste argv, batch via
// runBatch, relay via requestDispatch), each asserting its `source:*` stamp
// reads back on `show`, then force-deleted (and asserted gone) so the
// stores are left as found. Requires the store CLIs to be reachable;
// FUNNEL_BASE must still be set so src/config.ts imports.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCreateArgs, createBead, parseCreatedId } from './create'
import { runBatch } from './batch'
import { requestDispatch } from './relay'
import { buildPasteArgs } from '../routes/paste'
import { showBeadAsync } from '../routes/query/store'
import { execStdout } from './exec'

const TAG = 'bb-live-prov'

function scratchTitle(path: string): string {
  return `${TAG}-${path} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function shownText(store: string, id: string): Promise<string> {
  const shown = await showBeadAsync(store, id)
  assert.ok(shown, `bead ${id} must read back after write`)
  return shown
}

async function cleanup(store: string, id: string): Promise<void> {
  await execStdout(store, ['delete', id, '--force'], 20000).catch(() => {})
  assert.equal(await showBeadAsync(store, id), null, `scratch bead ${id} must be gone after cleanup`)
}

describe('creation provenance live round-trip', () => {
  it('mcp path: source:mcp + caller read back on show', { timeout: 60000 }, async (t) => {
    // Same argv the bead_create MCP tool builds (provenance via createBead).
    const args = buildCreateArgs({ store: 'task', title: scratchTitle('mcp'), provenance: { source: 'mcp', caller: 'bb-live-caller' } })
    assert.ok(args.join(' ').includes('source:mcp'))
    const { id, verified } = await createBead({
      store: 'task', title: scratchTitle('mcp'),
      provenance: { source: 'mcp', caller: 'bb-live-caller' },
    })
    assert.equal(verified, true)
    t.after(() => cleanup('task', id))
    const shown = await shownText('task', id)
    assert.ok(shown.includes('source:mcp'), 'path stamp reads back')
    assert.ok(shown.includes('by:bb-live-caller'), 'caller stamp reads back')
  })

  it('paste path: historical argv still lands source:paste + untriaged', { timeout: 60000 }, async (t) => {
    const title = scratchTitle('paste')
    const out = await execStdout('inbox', buildPasteArgs(title, `${TAG} body ${Date.now()}`), 15000)
    const id = parseCreatedId('inbox', out)
    assert.ok(id, `no inbox id in output: ${out.slice(0, 200)}`)
    t.after(() => cleanup('inbox', id!))
    const shown = await shownText('inbox', id!)
    assert.ok(shown.includes('source:paste'), 'paste path stamp reads back')
    assert.ok(shown.includes('paste:untriaged'), 'untriaged marker reads back')
  })

  it('batch path: every bead lands source:batch', { timeout: 120000 }, async (t) => {
    const r = await runBatch({
      beads: [
        { name: 'a', store: 'task', title: scratchTitle('batch-a') },
        { name: 'b', store: 'task', title: scratchTitle('batch-b'), depends_on: ['a'] },
      ],
    }, undefined, { caller: 'bb-live-caller' })
    assert.equal(r.complete, true)
    assert.equal(r.beads.length, 2)
    for (const b of r.beads) t.after(() => cleanup(b.store, b.id))
    for (const b of r.beads) {
      const shown = await shownText(b.store, b.id)
      assert.ok(shown.includes('source:batch'), `batch stamp reads back on ${b.id}`)
      assert.ok(shown.includes('by:bb-live-caller'), `caller stamp reads back on ${b.id}`)
    }
  })

  it('relay path: requestDispatch lands source:relay with no caller', { timeout: 60000 }, async (t) => {
    const d = await requestDispatch({ instruction: `${TAG} relay probe ${Date.now()}` })
    t.after(() => cleanup('task', d.id))
    const shown = await shownText('task', d.id)
    assert.ok(shown.includes('source:relay'), 'relay path stamp reads back')
  })
})
