// LIVE round-trip: exercises the real project_edit path — src/lib/relay.ts
// editProject, the exact function the project_edit MCP tool calls (see
// src/routes/mcp.ts:669) — against the live `projects` store through the
// same CLIs every route shells out to. Creates a uniquely-named scratch
// project bead, edits it, verifies read-after-write, then force-deletes the
// scratch bead (and asserts it no longer reads back) so the store is left
// as found. Requires the `projects` CLI + store to be reachable; FUNNEL_BASE
// must still be set so src/config.ts imports.
//
// Partial-failure behavior this test settles explicitly: a blocked write on
// ONE step (here: a note whose argv is rejected by execFile before spawn,
// so nothing touches the store) does NOT abort the edit — the other steps
// still apply and verify, the blocked step comes back ok:false, and
// editProject returns complete:false so the MCP tool answers err() with
// `Partial: N step(s) failed — re-read <id> before reporting success.` An
// unverified write (wrote but did not read back) would instead rethrow —
// never a partial success.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { editProject } from './relay'
import { showBeadAsync } from '../routes/query/store'
import { execStdout } from './exec'

const STORE = 'projects'
const TAG = 'bb-live-roundtrip'

function scratchTitle(): string {
  return `${TAG} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Projects store bead prefix is `project-` (see src/util.ts PREFIX_OVERRIDES);
// createBead's parser keys off `projects-`, so the scratch item is created
// straight over the CLI instead.
async function createScratch(): Promise<string> {
  const out = await execStdout(STORE, ['create', scratchTitle(), '-d', 'created by the live round-trip test', '-l', 'project:bb-live-rt-probe'], 15000)
  const id = out.match(/\b(project-[A-Za-z0-9]+)\b/)?.[1]
  assert.ok(id, `no project-id in create output: ${out.slice(0, 200)}`)
  return id
}

async function cleanup(id: string): Promise<void> {
  await execStdout(STORE, ['delete', id, '--force'], 20000).catch(() => {})
  assert.equal(await showBeadAsync(STORE, id), null, `scratch bead ${id} must be gone after cleanup`)
}

describe('project_edit live round-trip', () => {
  it('applies title/description/note/lifecycle, reads the edit back, then cleans up', { timeout: 120000 }, async (t) => {
    const id = await createScratch()
    t.after(() => cleanup(id))

    const newTitle = `${scratchTitle()} - edited`
    const newDesc = `edited description ${Date.now()}`
    const noteText = `rt-note ${Date.now()}`
    const r = await editProject({ project: id, title: newTitle, description: newDesc, note: noteText, lifecycle: 'deprecated' })

    assert.equal(r.id, id)
    assert.equal(r.complete, true, 'all steps verified on the happy path')
    assert.deepEqual(r.steps.map((s) => s.ok), [true, true, true])
    assert.equal(r.title, newTitle)
    assert.equal(r.lifecycle, 'deprecated')
    for (const s of r.steps) assert.match(s.detail, /verified/)

    const shown = await showBeadAsync(STORE, id)
    assert.ok(shown, 'bead must read back after edit')
    assert.ok(shown.includes(newTitle), 'title read-back')
    assert.ok(shown.includes(newDesc), 'description read-back')
    assert.ok(shown.includes(noteText), 'note read-back')
    assert.ok(shown.includes('state:deprecated'), 'lifecycle label read-back')
  })

  it('reports partial failure (blocked note) with other steps still applied, then cleans up', { timeout: 120000 }, async (t) => {
    const id = await createScratch()
    t.after(() => cleanup(id))

    const newTitle = `${scratchTitle()} - partial`
    const r = await editProject({
      project: id,
      title: newTitle,
      note: 'valid prefix \u0000 rejected before spawn',
      lifecycle: 'deprecated',
    })

    assert.equal(r.complete, false, 'a blocked step must never report full success')
    assert.deepEqual(r.steps.map((s) => [s.name, s.ok]), [
      ['update', true],
      ['note', false],
      ['lifecycle', true],
    ])

    const shown = await showBeadAsync(STORE, id)
    assert.ok(shown, 'bead must still read back after a partial edit')
    assert.ok(shown.includes(newTitle), 'successful steps still applied')
    assert.ok(shown.includes('state:deprecated'), 'successful lifecycle still applied')
    assert.ok(!shown.includes('valid prefix'), 'the blocked write left no partial note behind')
  })
})