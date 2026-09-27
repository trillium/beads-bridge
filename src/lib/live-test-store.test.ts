// Regression coverage for hermetic live-test stores (task-8hmyn).
//
// Covers the interruption-proofing mechanism the *-live suites rely on:
// `sweepScratchBeads` must delete every bead whose title carries the run
// TAG (what an interrupted run orphans) and leave everything else alone.
// All scratch stores here are per-run temp dirs (`bd init -p ...`), so
// this file itself never touches a production store.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  liveRunTag,
  initScratchStore,
  sweepScratchBeads,
  redirectStoreEnv,
  shimBdRouter,
  removeScratchStore,
} from './live-test-store'
import { runList } from '../routes/query/store'
import { execStdout } from './exec'

const execFileAsync = promisify(execFile)

describe('live-test-store helper', () => {
  it('liveRunTag is unique per run and carries no hardcoded task id', () => {
    const a = liveRunTag('bb-hb')
    const b = liveRunTag('bb-hb')
    assert.ok(a.startsWith('bb-hb-'), `tag carries the prefix: ${a}`)
    assert.notEqual(a, b, 'two tags from the same process must differ')
    assert.doesNotMatch(a, /36na1|task-[a-z0-9]+/, 'tag must not embed a task id')
  })

  it('sweepScratchBeads deletes only TAG-titled beads (interrupted-run orphans)', { timeout: 120000 }, async () => {
    const dir = await initScratchStore('inbox')
    try {
      const TAG = liveRunTag('bb-sweep-probe')
      const env = {
        ...process.env,
        BEADS_DIR: `${dir}/.beads`,
        BD_NAME: 'inbox',
        BD_NON_INTERACTIVE: '1',
      } as Record<string, string>
      const run = (args: string[]) =>
        execFileAsync('bd', args, { encoding: 'utf8', timeout: 30000, env }).then((r) => (r.stdout as string).trim())
      // Two orphans simulating an interrupted run (created, never cleaned
      // up), plus one innocent bead that must survive the sweep.
      await run(['create', `${TAG} orphan-1`, '-d', 'x'])
      await run(['create', `${TAG} orphan-2`, '-d', 'x'])
      await run(['create', 'innocent bystander bead', '-d', 'x'])

      const swept = await (async () => {
        const restore = redirectStoreEnv(`${dir}/.beads`)
        try {
          return await sweepScratchBeads('inbox', TAG)
        } finally {
          restore()
        }
      })()
      assert.equal(swept.length, 2, `sweep must delete both orphans, got ${JSON.stringify(swept)}`)

      const remaining = await run(['list', '--all', '--json', '--limit', '100'])
      const rows = JSON.parse(remaining) as Array<{ id: string; title: string }>
      assert.ok(!rows.some((r) => r.title.startsWith(TAG)), 'no TAG-titled bead may remain after the sweep')
      assert.ok(rows.some((r) => r.title === 'innocent bystander bead'), 'untagged beads must survive the sweep')

      const resweep = await (async () => {
        const restore = redirectStoreEnv(`${dir}/.beads`)
        try {
          return await sweepScratchBeads('inbox', TAG)
        } finally {
          restore()
        }
      })()
      assert.deepEqual(resweep, [], 'a second sweep must be a no-op')
    } finally {
      removeScratchStore(dir)
    }
  })

  it('redirectStoreEnv points the inbox wrapper at scratch and restores', { timeout: 120000 }, async () => {
    const dir = await initScratchStore('inbox')
    try {
      const before = process.env.BEADS_DIR
      const restore = redirectStoreEnv(`${dir}/.beads`)
      try {
        assert.equal(process.env.BEADS_DIR, `${dir}/.beads`)
        const out = await execStdout('inbox', ['create', 'env-redirect probe', '-d', 'x'], 30000)
        assert.match(out, /inbox-[A-Za-z0-9]+/, 'scratch store issues inbox-prefixed ids')
      } finally {
        restore()
      }
      assert.equal(process.env.BEADS_DIR, before, 'BEADS_DIR must be restored')
    } finally {
      removeScratchStore(dir)
    }
  })

  it('shimBdRouter steers hard-pinned wrappers to scratch on every path', { timeout: 120000 }, async () => {
    const dir = await initScratchStore('task')
    let restore: (() => void) | null = null
    try {
      restore = shimBdRouter({ task: dir })
      const out = await execStdout('task', ['create', 'router probe', '-d', 'x'], 30000)
      assert.match(out, /task-[A-Za-z0-9]+/, 'scratch store issues task-prefixed ids')
      const list = await execStdout('task', ['list', '--json', '--limit', '10'], 30000)
      assert.match(list, /router probe/, 'the scratch bead reads back through the wrapper (async path)')
      // The sync path MUST agree: Bun's spawnSync without explicit env
      // reuses the process-start snapshot, so a wrapper-name shim is
      // invisible to it — routing the leaf `bd` plus runList's explicit
      // live env (Node parity) is what keeps sync reads (runList via
      // lookupProject) on the same scratch store.
      const { rows } = runList('task', [], [], { exclude: [], limit: 10, allStates: true })
      assert.ok(rows.some((r) => r.title.includes('router probe')), 'the SYNC path reads the same scratch store')
      // Passthrough: unrouted invocations still reach the real binary.
      const v = await execStdout('bd', ['--version'], 15000)
      assert.match(v, /bd version/, 'unrouted bd calls pass through the router')
    } finally {
      restore?.()
      removeScratchStore(dir)
    }
  })
})
