// Unit + real-CLI tests: bun test src/lib/store-health.test.ts (node:test).
// Fake store CLIs are tiny shell scripts in a temp dir (absolute path as the
// "store"); the final suite probes the REAL `task` CLI read-only.
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertStoreReadable,
  assertStoreWritable,
  assertStoreWritableSync,
  classifyWhere,
  isWriteVerb,
  probeStore,
  readFailureNote,
  resetStoreProbeCache,
  StoreUnavailableError,
} from './store-health'
import { beadText, execStdout } from './exec'
import { runMutation, runMutationSync } from './mutate'
import { formatRoundTrip, storeRoundTrip } from './store-roundtrip'

const CLIENT = { remoteClient: true, registryPath: '/Users/me/data/tasks/.beads' }
const WHERE_OK = '/Users/mini1/data/tasks/.beads\n  prefix: task\n  database: /Users/mini1/data/tasks/.beads/dolt\n'

describe('classifyWhere', () => {
  it('ok: remote path, prefix and database parsed', () => {
    const p = classifyWhere('task', { code: 0, stdout: WHERE_OK, stderr: '' }, CLIENT)
    assert.equal(p.status, 'ok')
    assert.equal(p.path, '/Users/mini1/data/tasks/.beads')
    assert.equal(p.prefix, 'task')
    assert.equal(p.database, '/Users/mini1/data/tasks/.beads/dolt')
    assert.equal(p.command, 'task where')
  })
  it('no-database: the 82t1 symptom', () => {
    const p = classifyWhere('projects', { code: 1, stdout: '', stderr: 'Error: no beads database found\nHint: ...' }, CLIENT)
    assert.equal(p.status, 'no-database')
  })
  it('fallback-local: wrapper warns it is using the local copy', () => {
    const p = classifyWhere('task', { code: 0, stdout: WHERE_OK, stderr: 'beads: remote x unreachable, using local (reconcile later)' }, CLIENT)
    assert.equal(p.status, 'fallback-local')
  })
  it('local-shadow: a remote-client host resolving to its own registry path', () => {
    const p = classifyWhere('task', { code: 0, stdout: '/Users/me/data/tasks/.beads\n  prefix: task\n', stderr: '' }, CLIENT)
    assert.equal(p.status, 'local-shadow')
    // the same path on a host that holds the stores is healthy
    assert.equal(classifyWhere('task', { code: 0, stdout: '/Users/me/data/tasks/.beads\n', stderr: '' }, { ...CLIENT, remoteClient: false }).status, 'ok')
  })
  it("misrouted: a store's CLI that lands in another store's workspace (scratch -> brain)", () => {
    const p = classifyWhere('scratch', { code: 0, stdout: '/Users/mini1/data/brain/.beads\n  prefix: brain\n', stderr: '' }, { remoteClient: true, registryPath: '/Users/me/data/scratch/.beads' })
    assert.equal(p.status, 'misrouted')
    assert.match(p.detail, /wrong store/)
  })
  it('registry paths without /.beads still compare by workspace name', () => {
    const p = classifyWhere('education', { code: 0, stdout: '/Users/mini1/data/education/.beads\n', stderr: '' }, { remoteClient: true, registryPath: '/Users/me/data/education' })
    assert.equal(p.status, 'ok')
  })
  it('unreachable on timeout/ssh errors; unknown (non-blocking) on unrecognised output', () => {
    assert.equal(classifyWhere('t', { code: null, stdout: '', stderr: '', timedOut: true }, CLIENT).status, 'unreachable')
    assert.equal(classifyWhere('t', { code: 255, stdout: '', stderr: 'ssh: connect to host x port 22: Connection refused' }, CLIENT).status, 'unreachable')
    assert.equal(classifyWhere('t', { code: 2, stdout: 'huh', stderr: '' }, CLIENT).status, 'unknown')
  })
  it('write verbs: comment is a write, comments is a read', () => {
    assert.ok(isWriteVerb('create') && isWriteVerb('comment') && isWriteVerb('close'))
    assert.ok(!isWriteVerb('comments') && !isWriteVerb('show') && !isWriteVerb('list') && !isWriteVerb(undefined))
  })
  it('readFailureNote names the store for a bare "no beads database found"', () => {
    const n = readFailureNote('projects', 'Error: no beads database found')
    assert.match(n!, /store 'projects' is not reachable/)
    assert.equal(readFailureNote('projects', 'some other error'), null)
  })
})

// Fake store CLIs: `<script> where` prints a canned answer; every other verb
// appends its argv to a log file so tests can prove nothing was written.
const dir = mkdtempSync(join(tmpdir(), 'store-health-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const logFile = join(dir, 'calls.log')
function fakeStore(name: string, whereOut: string, whereErr = '', whereCode = 0): string {
  const path = join(dir, name)
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = where ]; then\n  printf '%s' '${whereOut}'\n  [ -n '${whereErr}' ] && echo '${whereErr}' >&2\n  exit ${whereCode}\nfi\necho "$@" >> '${logFile}'\necho ran\n`,
  )
  chmodSync(path, 0o755)
  return path
}
const calls = (): string => {
  const r = spawnSync('/bin/sh', ['-c', `cat '${logFile}' 2>/dev/null || true`], { encoding: 'utf8' })
  return r.stdout
}

describe('write/read guards (fake store CLIs)', () => {
  beforeEach(() => {
    resetStoreProbeCache()
    spawnSync('/bin/sh', ['-c', `rm -f '${logFile}'`])
  })

  it('refuses writes to a no-database store and never runs the write verb', async () => {
    const s = fakeStore('nodb', '', 'Error: no beads database found', 1)
    await assert.rejects(() => assertStoreWritable(s), StoreUnavailableError)
    await assert.rejects(() => runMutation(s, ['create', 'x']), /not reachable at its authoritative location/)
    await assert.rejects(() => execStdout(s, ['close', 'x-1'], 5000), StoreUnavailableError)
    assert.throws(() => runMutationSync(s, ['comment', 'x-1', 'hi']), /no fallback store is used/)
    assert.equal(calls(), '', 'no write verb may reach a refused store')
  })

  it('refuses writes to a fallback-local store', async () => {
    const s = fakeStore('fallback', WHERE_OK, 'beads: remote h unreachable, using local (reconcile later)')
    assert.throws(() => assertStoreWritableSync(s), StoreUnavailableError)
    await assert.rejects(() => runMutation(s, ['note', 'x-1', 'n']), /fallback-local/)
    assert.equal(calls(), '')
  })

  it('reads of a fallback-local store are refused; a no-database read degrades to a named diagnosis', async () => {
    const fb = fakeStore('fb2', WHERE_OK, 'beads: remote h unreachable, using local')
    await assert.rejects(() => assertStoreReadable(fb), StoreUnavailableError)
    const text = await beadText(fb, ['show', 'x-1'])
    assert.match(text, /not reachable at its authoritative location/)
  })

  it('an ok store passes through: write verbs run', async () => {
    const s = fakeStore('good', WHERE_OK)
    assert.equal((await probeStore(s)).status, 'ok')
    assert.equal(await runMutation(s, ['close', 'task-1']), 'ran')
    assert.equal(runMutationSync(s, ['comment', 'task-1', 'hi']), 'ran')
    assert.match(calls(), /close task-1/)
  })

  it('an unrecognised probe is not blocking (the mutation fails or succeeds on its own)', async () => {
    const s = fakeStore('weird', 'what is this')
    assert.equal((await probeStore(s)).status, 'unknown')
    assert.equal(await runMutation(s, ['close', 'x-1']), 'ran')
  })

  it('BEADS_BRIDGE_STORE_GUARD=off disables the guard', async () => {
    const s = fakeStore('off', '', 'Error: no beads database found', 1)
    process.env.BEADS_BRIDGE_STORE_GUARD = 'off'
    try {
      assert.equal(await runMutation(s, ['close', 'x-1']), 'ran')
    } finally {
      delete process.env.BEADS_BRIDGE_STORE_GUARD
    }
  })

  it('probe results are cached (one `where` per window)', async () => {
    const s = fakeStore('cached', WHERE_OK)
    const a = await probeStore(s)
    const b = await probeStore(s)
    assert.equal(a.checkedAt, b.checkedAt)
    const c = await probeStore(s, { force: true })
    assert.ok(c.checkedAt >= a.checkedAt)
  })
})

describe('storeRoundTrip refusals (fake store CLIs)', () => {
  beforeEach(() => {
    resetStoreProbeCache()
    spawnSync('/bin/sh', ['-c', `rm -f '${logFile}'`])
  })
  it('a broken store fails at identify and never attempts a write', async () => {
    const s = fakeStore('rt-nodb', '', 'Error: no beads database found', 1)
    const r = await storeRoundTrip(s, { write: true })
    assert.equal(r.ok, false)
    assert.equal(r.testBeadId, undefined)
    assert.equal(r.steps.length, 1)
    assert.match(formatRoundTrip(r), /FAIL .*identify/)
    assert.equal(calls(), '', 'no CLI verb ran against the broken store')
  })
  it('a misrouted store (e.g. scratch -> brain) is refused the same way', async () => {
    const s = fakeStore('rt-mis', '/Users/mini1/data/brain/.beads\n  prefix: brain\n')
    // registry path for an absolute-path "store" is unknown, so classification is ok;
    // assert the refusal path through an explicit registry mismatch instead
    const p = await probeStore(s, { force: true, registryPath: '/Users/me/data/scratch/.beads' })
    assert.equal(p.status, 'misrouted')
  })
})

// REAL CLI: read-only. Skipped when the `task` wrapper is not installed.
const haveTask = spawnSync('/bin/sh', ['-c', 'command -v task'], { encoding: 'utf8' }).status === 0
describe('real store CLI (read-only)', { skip: !haveTask }, () => {
  it('`task where` resolves, parses and is not a blocking status', async () => {
    resetStoreProbeCache()
    const p = await probeStore('task', { force: true })
    assert.ok(p.path && p.path.endsWith('/tasks/.beads'), `unexpected task path: ${p.path} (${p.status}: ${p.detail})`)
    assert.equal(p.prefix, 'task')
    assert.ok(!['no-database', 'fallback-local', 'local-shadow', 'misrouted'].includes(p.status), `${p.status}: ${p.detail}`)
  })
  it('reads through the guarded funnel return real records', async () => {
    const out = await execStdout('task', ['list', '--limit', '1'], 20000)
    assert.match(out, /task-[a-z0-9]+/)
  })
})
