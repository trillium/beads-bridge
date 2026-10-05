// LIVE round-trip for idempotent, revision-aware create — the exact
// function the bead_create MCP tool calls (createOperationBead in
// src/lib/idempotent-create.ts) against a REAL bead store that is SCRATCH,
// never the captain's task store: per-run temp store via `bd init -p task`,
// reached through a `bd`-router shim (live-test-store.ts) so the hard-pinned
// `task` wrapper's leaf `bd` calls land in the temp store. Real lib + real
// CLI + real Dolt; only the database is throwaway.
//
// This file is the executable form of the incident that motivated the whole
// path (errors-5uf): the same Mac mini provisioning request arrived TWICE
// over at-least-once ChatGPT delivery and was handled as two separate beads
// — a duplicate triage pass. Test 1 is that reproduction: two submissions,
// ONE logical operation id, ONE bead, TWO readable revisions.
//
// It also covers each failure mode the captain named: duplicate retries, a
// voice turn that pauses and continues with more scope, network replay of
// the same request, and several runtime/model executions of one request.
//
// `bd init` on some hosts completes its work and then hangs on a trailing
// `git commit` (the store is fully usable afterwards), so setup tolerates a
// timeout as long as the scratch store answers a real query — bounded, and
// verified rather than assumed.
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOperationBead, findByOperationKey, readRevisionHistory, type OperationCreateResult } from './idempotent-create'
import { operationKey } from './idempotency'
import { showBeadAsync } from '../routes/query/store'
import { execStdout } from './exec'
import { liveRunTag, removeScratchStore, shimBdRouter } from './live-test-store'

const STORE = 'task'
// Run-derived tag: unique per run, never a hardcoded string.
const TAG = liveRunTag('bb-live-idem')

// Setup at import time as blocking sync statements (type:commonjs rejects
// top-level await; the runner's 5s hook budget cannot cover `bd init`).
function initScratchStoreTolerant(issuePrefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bb-live-${issuePrefix}-`))
  const env = { ...process.env, BD_NON_INTERACTIVE: '1', GIT_EDITOR: ':', GIT_PAGER: 'cat' } as Record<string, string>
  delete env.BEADS_DIR
  delete env.BD_NAME
  try {
    execFileSync('bd', ['init', '-p', issuePrefix], { encoding: 'utf8', timeout: 90000, cwd: dir, env })
  } catch (e) {
    // A host where `bd init` hangs after finishing still leaves a usable
    // store; prove that rather than assume it.
    if (!existsSync(join(dir, '.beads'))) throw new Error(`scratch store init failed: ${(e as Error).message}`)
  }
  try {
    execFileSync('bd', ['list', '--json', '--limit', '1'], { encoding: 'utf8', timeout: 30000, cwd: dir, env })
  } catch (e) {
    throw new Error(`scratch store did not answer after init: ${(e as Error).message}`)
  }
  return dir
}

let scratchDir = ''
let restoreShim: (() => void) | null = null
try {
  scratchDir = initScratchStoreTolerant('task')
  restoreShim = shimBdRouter({ task: scratchDir })
} catch (e) {
  throw new Error(`idempotency-live setup failed (isolation not installed): ${(e as Error)?.message ?? e}`)
}

after(() => {
  restoreShim?.()
  restoreShim = null
  if (scratchDir) removeScratchStore(scratchDir)
  scratchDir = ''
})

function title(tag: string): string {
  return `${TAG} ${tag} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function cleanup(...ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!id) continue
    await execStdout(STORE, ['delete', id, '--force'], 20000).catch(() => {})
  }
}

// The exact request from the incident: one logical provisioning ask.
function provisioningAsk(tag: string, extra?: { description?: string; labels?: string[]; title?: string }) {
  return {
    store: STORE,
    title: extra?.title ?? title(tag),
    description: extra?.description ?? 'Provision a Mac mini for the fleet runner.',
    labels: extra?.labels ?? ['ops'],
  }
}

describe('the motivating incident: one logical request, submitted twice (errors-5uf)', () => {
  it('produces ONE bead with TWO revisions, never two beads', { timeout: 180000 }, async (t) => {
    const operationId = `${TAG}-mac-mini-provision`
    const key = operationKey(STORE, operationId)

    // ONE logical request — byte-identical on both deliveries, exactly as
    // an at-least-once transport resends it.
    const ask = provisioningAsk('incident')
    const first = await createOperationBead({ ...ask, operationId })
    t.after(() => cleanup(first.id))
    assert.equal(first.disposition, 'created')
    assert.equal(first.verified, true, 'the created bead must read back')

    // The duplicate delivery: same logical request, submitted again.
    const second = await createOperationBead({ ...ask, operationId })
    t.after(() => cleanup(second.childId ?? ''))

    assert.equal(second.id, first.id, 'the duplicate submission must land on the SAME bead')
    assert.notEqual(second.disposition, 'created', 'the second delivery is a revision, not a create')

    const beads = await findByOperationKey(STORE, key)
    assert.equal(beads.length, 1, `one logical action = one bead, got ${beads.map((b) => b.id).join(', ')}`)

    const history = await readRevisionHistory(STORE, first.id)
    assert.equal(history.length, 2, 'both submissions remain readable after the fact')
    assert.deepEqual(history.map((r) => r.seq), [1, 2], 'revisions order by sequence number')
    assert.equal(history[0].mode, 'create')
    // Byte-identical delivery: recorded, but the bead itself is unchanged.
    assert.equal(history[1].mode, 'duplicate')
    assert.equal(history[1].payload.description, 'Provision a Mac mini for the fleet runner.')

    const shown = (await showBeadAsync(STORE, first.id)) as string
    const occurrences = (shown.match(/Provision a Mac mini for the fleet runner\./g) ?? []).length
    assert.equal(occurrences, 1, 'a replayed submission must not re-append the same text to the bead')
  })
})

describe('failure mode: duplicate retries', () => {
  it('five identical retries make one bead and record each delivery', { timeout: 240000 }, async (t) => {
    const operationId = `${TAG}-retry-storm`
    const key = operationKey(STORE, operationId)
    const ask = provisioningAsk('retry')
    const results: OperationCreateResult[] = []
    for (let i = 0; i < 5; i++) {
      results.push(await createOperationBead({ ...ask, operationId }))
    }
    t.after(() => cleanup(...results.map((r) => r.id)))
    assert.deepEqual(results.map((r) => r.disposition), ['created', 'duplicate', 'duplicate', 'duplicate', 'duplicate'])
    assert.equal(new Set(results.map((r) => r.id)).size, 1, 'every retry resolves to the same bead')
    assert.equal((await findByOperationKey(STORE, key)).length, 1)
    const history = await readRevisionHistory(STORE, results[0].id)
    assert.equal(history.length, 5, 'five deliveries = five readable revisions of ONE bead')
    assert.deepEqual(history.map((r) => r.seq), [1, 2, 3, 4, 5], 'sequence numbers never repeat or reorder')
    assert.equal(history.filter((r) => r.mode === 'duplicate').length, 4, 'retries changed no field')
  })
})

describe('failure mode: a voice turn pauses, then continues with more scope', () => {
  it('keeps one bead; the continuation merges in and is readable as revision 2', { timeout: 180000 }, async (t) => {
    const operationId = `${TAG}-voice-turn`
    const key = operationKey(STORE, operationId)
    const ask = title('voice')

    const first = await createOperationBead({
      store: STORE,
      title: ask,
      description: 'User: provision a mac mini',
      labels: ['ops'],
      operationId,
    })
    t.after(() => cleanup(first.id))
    assert.equal(first.disposition, 'created')

    // The turn resumes and adds scope — same logical request, more content.
    const second = await createOperationBead({
      store: STORE,
      title: ask,
      description: 'and install tailscale on it',
      labels: ['urgent'],
      operationId,
    })

    assert.equal(second.id, first.id, 'the continuation is the same action')
    assert.equal(second.disposition, 'revision')
    assert.equal((await findByOperationKey(STORE, key)).length, 1, 'still exactly one bead')

    const shown = await showBeadAsync(STORE, first.id)
    assert.ok(shown, 'the bead reads back')
    assert.match(shown as string, /provision a mac mini/, 'the earlier spoken scope survives')
    assert.match(shown as string, /install tailscale/, 'the resumed scope is merged in')

    const history = await readRevisionHistory(STORE, first.id)
    assert.equal(history.length, 2)
    assert.deepEqual(history.map((r) => r.seq), [1, 2], 'ordering is sequence number, not arrival clock')
    assert.equal(history[1].payload.description, 'and install tailscale on it')
  })
})

describe('failure mode: network replay of the same request', () => {
  it('a replay that differs only in label order is still a no-op, not a revision', { timeout: 180000 }, async (t) => {
    const operationId = `${TAG}-network-replay`
    const key = operationKey(STORE, operationId)
    const ask = title('replay')
    const first = await createOperationBead({
      store: STORE,
      title: ask,
      description: 'check the relay queue',
      labels: ['ops', 'relay'],
      operationId,
    })
    t.after(() => cleanup(first.id))

    // The transport retried the same request: identical content, labels
    // serialized in a different order by the client stack.
    const replay = await createOperationBead({
      store: STORE,
      title: ask,
      description: 'check the relay queue',
      labels: ['relay', 'ops'],
      operationId,
    })
    assert.equal(replay.id, first.id)
    assert.equal(replay.disposition, 'duplicate', 'an identical replay changes no field')
    assert.equal((await findByOperationKey(STORE, key)).length, 1)
    const history = await readRevisionHistory(STORE, first.id)
    assert.equal(history.length, 2, 'the replay is still recorded — the delivery happened')
    assert.equal(history[1].mode, 'duplicate')
    const shown = (await showBeadAsync(STORE, first.id)) as string
    assert.equal((shown.match(/check the relay queue/g) ?? []).length, 1, 'the body was not re-appended')
  })
})

describe('failure mode: several runtime/model executions of one request', () => {
  it('concurrent executions of one operation create exactly one bead', { timeout: 300000 }, async (t) => {
    const operationId = `${TAG}-multi-runtime`
    const key = operationKey(STORE, operationId)
    const ask = title('runtime')

    // Five "runtimes" fire the same logical request at once, each with the
    // same content — the interleaving that used to produce duplicates.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createOperationBead({ store: STORE, title: ask, description: 'same request, five runtimes', labels: ['ops'], operationId }),
      ),
    )
    t.after(() => cleanup(...results.map((r) => r.id), ...results.map((r) => r.childId ?? '')))

    assert.equal(new Set(results.map((r) => r.id)).size, 1, 'all five land on one bead')
    assert.equal(results.filter((r) => r.disposition === 'created').length, 1, 'exactly one created')
    assert.equal((await findByOperationKey(STORE, key)).length, 1, 'the store holds one bead for the operation')
    const history = await readRevisionHistory(STORE, results[0].id)
    assert.equal(history.length, 5, 'each of the five executions is recorded against the one bead')
    assert.deepEqual(history.map((r) => r.seq), [1, 2, 3, 4, 5], 'concurrent deliveries still order deterministically')
  })
})

describe('a second process races the same operation', () => {
  it('collapses the later bead onto the canonical one instead of leaving a duplicate', { timeout: 180000 }, async (t) => {
    const operationId = `${TAG}-cross-process`
    const key = operationKey(STORE, operationId)
    const ask = title('crossproc')

    // Another bridge process created a bead for this operation before our
    // lookup ran, so the key already resolves to two beads.
    const squatter = await execStdout(
      STORE,
      ['create', ask, '-d', 'created elsewhere', '-l', `ops,${key}`],
      30000,
    )
    const squatterId = (squatter.match(/task-[A-Za-z0-9]+/) ?? [])[0]
    assert.ok(squatterId, `scratch create must emit an id, got: ${squatter}`)
    t.after(() => cleanup(squatterId))

    const mine = await createOperationBead({ store: STORE, title: ask, description: 'created here', labels: ['ops'], operationId })
    t.after(() => cleanup(mine.id, mine.childId ?? ''))

    assert.equal(mine.id, squatterId, 'the earliest bead for the operation is canonical')
    assert.deepEqual(mine.collapsed, [], 'nothing to collapse — the pre-existing bead is the canonical one')
    const rows = await findByOperationKey(STORE, key)
    assert.equal(rows.length, 1)
    const history = await readRevisionHistory(STORE, squatterId)
    assert.equal(history.length, 1, 'our submission is revision 1 of the operation')
    assert.match(history[0].payload.description as string, /created here/)
  })
})

describe('materially distinct added scope is promoted, not silently merged', () => {
  it('promote:true creates a child bead and records the promotion as a revision', { timeout: 180000 }, async (t) => {
    const operationId = `${TAG}-promote`
    const key = operationKey(STORE, operationId)
    const ask = title('promote')
    const first = await createOperationBead({ store: STORE, title: ask, description: 'provision the mini', labels: ['ops'], operationId })
    t.after(() => cleanup(first.id))

    const promoted = await createOperationBead({
      store: STORE,
      title: `${ask} — rotate its keys`,
      description: 'separate work: rotate the SSH keys',
      labels: ['ops'],
      operationId,
      promote: true,
    })
    t.after(() => cleanup(promoted.childId ?? ''))

    assert.equal(promoted.disposition, 'promoted')
    assert.ok(promoted.childId, 'a child bead id is returned')
    assert.notEqual(promoted.childId, first.id)
    const child = await showBeadAsync(STORE, promoted.childId as string)
    assert.match(child as string, /rotate the SSH keys/, 'the added scope reads back on the child')
    assert.equal((await findByOperationKey(STORE, key)).length, 1, 'the parent operation still holds one bead')

    const history = await readRevisionHistory(STORE, first.id)
    assert.equal(history.length, 2)
    assert.equal(history[1].mode, 'child')
    assert.equal(history[1].payload.child, promoted.childId)
  })
})

describe('compatibility floor: no logical id means old behaviour exactly', () => {
  it('two id-less creates still make two beads, neither carrying an opkey label', { timeout: 180000 }, async (t) => {
    const a = await createOperationBead(provisioningAsk('nokey-a'))
    const b = await createOperationBead(provisioningAsk('nokey-b'))
    t.after(() => cleanup(a.id, b.id))
    assert.equal(a.disposition, 'created')
    assert.equal(b.disposition, 'created')
    assert.equal(a.revision, 0, 'no logical id means no revision history')
    assert.notEqual(a.id, b.id, 'id-less callers keep one-bead-per-call semantics')
    const shown = (await showBeadAsync(STORE, a.id)) as string
    assert.ok(!shown.includes('opkey:'), 'no idempotency key is stamped when none was supplied')
  })
})