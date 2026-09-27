// Hermetic live-test stores (task-8hmyn).
//
// The *-live.test.ts suites prove the bridge end to end against REAL code
// (routes + lib) and a REAL bead store (real `bd` binary over embedded
// Dolt) — but they must never touch the captain's production stores. Past
// runs wrote scratch beads into the live inbox/projects/task stores; any
// interrupted run (timeout, kill, crash) orphaned them in the open state.
//
// Two isolation mechanisms, chosen per wrapper capability:
//   - env redirect: the `inbox` wrapper honors a preset BEADS_DIR ("FLEXIBLE
//     STORE PINS" — temp store runs embedded), so setting BEADS_DIR to a
//     scratch store keeps the store name `inbox` (receipts, id prefixes,
//     retrieval_activity all unchanged) while the bytes land in temp.
//   - `bd`-router shim: the `projects`/`task` wrappers hard-pin BEADS_DIR
//     (`exec env BEADS_DIR=...`), ignoring the environment — and Bun
//     resolves bare names for spawnSync against the process-start PATH,
//     so same-named wrapper shims are invisible to sync calls. Instead a
//     temp bin dir containing a `bd` shim is prepended to PATH: the real
//     wrappers resolve as usual, and their own `exec bd` re-resolves
//     through the live PATH in a real child process, landing every read
//     and write, sync and async, in the scratch store.
//
// In both cases the test still exercises the genuine live path: real MCP
// route or lib function -> real store CLI -> real Dolt. Only the database
// is scratch. Each suite ALSO sweeps its legacy TAG prefix against the
// real store at START (before isolation is installed), so beads orphaned
// by pre-fix interrupted runs self-heal on the next run instead of
// accumulating.
//
// `bd init` notes: it must run with BEADS_DIR/BD_NAME unset (a preset
// BD_NAME breaks workspace resolution), and its output must be consumed in
// full — piping through `head` SIGPIPEs it mid-init and leaves a
// half-initialized store.
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execStdout } from './exec'

const execFileAsync = promisify(execFile)

// (d) Run-derived tag: unique per run, never a hardcoded task id.
export function liveRunTag(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

// Create an isolated scratch store: temp dir + `bd init -p <issuePrefix>`
// (so created ids carry the same prefix shape as the real store:
// `-p inbox` -> inbox-*, `-p project` -> project-*, `-p task` -> task-*).
// Returns the store root dir (the .beads dir is `<dir>/.beads`).
export async function initScratchStore(issuePrefix: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `bb-live-${issuePrefix}-`))
  const env = { ...process.env, BD_NON_INTERACTIVE: '1' } as Record<string, string>
  delete env.BEADS_DIR
  delete env.BD_NAME
  await execFileAsync('bd', ['init', '-p', issuePrefix], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: dir,
    env,
  })
  return dir
}

interface ScratchRow {
  id?: unknown
  title?: unknown
  created_at?: unknown
}

// (c) Sweep scratch beads by title prefix. Used at suite START (against the
// real store, before isolation) so an interrupted run's orphans are deleted
// by the next run, and covered by live-test-store.test.ts. Returns the ids
// it deleted. `olderThanMs` restricts the sweep to beads created before the
// cutoff — the real-store legacy sweep uses it so a concurrent old-code
// run's in-flight scratch beads (seconds old) are never reaped, only true
// orphans from runs that died long ago.
export async function sweepScratchBeads(store: string, tag: string, olderThanMs?: number): Promise<string[]> {
  const out = await execStdout(store, ['list', '--all', '--json', '--limit', '2000'], 30000).catch(() => '[]')
  const cutoff = olderThanMs ? Date.now() - olderThanMs : 0
  let ids: string[]
  try {
    const rows = JSON.parse(out || '[]') as ScratchRow[]
    ids = (Array.isArray(rows) ? rows : [])
      .filter((r) => typeof r?.title === 'string' && (r.title as string).startsWith(tag) && typeof r?.id === 'string')
      .filter((r) => {
        if (!cutoff) return true
        const t = typeof r?.created_at === 'string' ? Date.parse(r.created_at as string) : NaN
        return !Number.isNaN(t) && t < cutoff
      })
      .map((r) => r.id as string)
  } catch {
    return []
  }
  for (const id of ids) {
    await execStdout(store, ['delete', id, '--force'], 20000).catch(() => {})
  }
  return ids
}

// Env-redirect isolation for flexibly-pinned wrappers (`inbox` honors a
// preset BEADS_DIR). Saves + restores every variable it touches, and pins
// the create-emit events file into temp so the real events stream is
// never appended to.
export function redirectStoreEnv(beadsDir: string): () => void {
  const saved = {
    BEADS_DIR: process.env.BEADS_DIR,
    BRAIN_KNOWLEDGE_ROOT: process.env.BRAIN_KNOWLEDGE_ROOT,
    BRAIN_EXFIL_FLAT: process.env.BRAIN_EXFIL_FLAT,
    INBOX_EVENTS_FILE: process.env.INBOX_EVENTS_FILE,
  }
  const root = dirname(beadsDir)
  process.env.BEADS_DIR = beadsDir
  process.env.BRAIN_KNOWLEDGE_ROOT = root
  process.env.BRAIN_EXFIL_FLAT = '1'
  process.env.INBOX_EVENTS_FILE = join(root, 'events.jsonl')
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// `bd`-router isolation for hard-pinned wrappers (`projects`, `task`
// ignore a preset BEADS_DIR, so redirecting the environment cannot work).
//
// WHY NOT SHIM THE WRAPPER NAMES: Bun resolves bare command names for
// spawnSync against the process-start PATH snapshot and ignores runtime
// process.env.PATH changes (verified: a same-named shim in a prepended
// dir is invisible to spawnSync while execFile sees it), so a `projects`
// shim would split the suite — async calls hit scratch, sync calls
// (runList via lookupProject) hit the REAL store. Instead this prepends a
// dir containing a `bd` shim: Bun still resolves the wrapper names via the
// original PATH (real wrappers, unchanged behavior), and the wrapper's own
// `exec bd` re-resolves through the live PATH inside a real child process
// — which DOES see the prepend — landing every read and write, sync and
// async, in the scratch store. `routes` maps wrapper BD_NAME to scratch
// root; anything else passes through to the real bd untouched.
export function shimBdRouter(routes: Record<string, string>): () => void {
  // Synchronous (see note below): resolves the real bd BEFORE prepending,
  // so the router delegates to the genuine binary.
  const realBd = execFileSync('/bin/sh', ['-c', 'command -v bd'], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env },
  }).trim()
  if (!realBd) throw new Error('shimBdRouter: cannot resolve the real bd binary')
  const binDir = mkdtempSync(join(tmpdir(), 'bb-live-bin-'))
  const cases = Object.entries(routes)
    .map(([bdName, root]) => {
      const beadsDir = `${root}/.beads`
      const flat = bdName === 'task' ? '\n    export BRAIN_EXFIL_FLAT=1' : ''
      return `    ${bdName}) export BEADS_DIR="${beadsDir}" BRAIN_KNOWLEDGE_ROOT="${root}"${flat} ;;`
    })
    .join('\n')
  writeFileSync(
    join(binDir, 'bd'),
    `#!/bin/sh\n` +
      `# bb-live test router: steer routed stores to scratch, else passthrough.\n` +
      `export BD_NON_INTERACTIVE=1\n` +
      `case "\${BD_NAME:-}" in\n${cases}\n` +
      `esac\n` +
      `export BEADS_DIR BD_NAME BRAIN_KNOWLEDGE_ROOT\n` +
      `exec "${realBd}" "$@"\n`,
    { mode: 0o755 },
  )
  const prevPath = process.env.PATH ?? ''
  process.env.PATH = `${binDir}:${prevPath}`
  let restored = false
  return () => {
    if (restored) return
    restored = true
    process.env.PATH = prevPath
    rmSync(binDir, { recursive: true, force: true })
  }
}

// Synchronous variants for suite setup at module top level. The package is
// type:commonjs, so top-level await is rejected by tsc; and the runner's
// 5s hook budget cannot cover sweep + `bd init` (~10-15s), so setup runs
// as plain blocking statements during import (no hook timer applies).
export function initScratchStoreSync(issuePrefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bb-live-${issuePrefix}-`))
  const env = { ...process.env, BD_NON_INTERACTIVE: '1' } as Record<string, string>
  delete env.BEADS_DIR
  delete env.BD_NAME
  execFileSync('bd', ['init', '-p', issuePrefix], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: dir,
    env,
  })
  return dir
}

export function sweepScratchBeadsSync(store: string, tag: string, olderThanMs?: number): string[] {
  const cutoff = olderThanMs ? Date.now() - olderThanMs : 0
  const r = spawnSync(store, ['list', '--all', '--json', '--limit', '2000'], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  })
  let ids: string[]
  try {
    const rows = JSON.parse(r.stdout || '[]') as ScratchRow[]
    ids = (Array.isArray(rows) ? rows : [])
      .filter((x) => typeof x?.title === 'string' && (x.title as string).startsWith(tag) && typeof x?.id === 'string')
      .filter((x) => {
        if (!cutoff) return true
        const t = typeof x?.created_at === 'string' ? Date.parse(x.created_at as string) : NaN
        return !Number.isNaN(t) && t < cutoff
      })
      .map((x) => x.id as string)
  } catch {
    return []
  }
  for (const id of ids) {
    spawnSync(store, ['delete', id, '--force'], { encoding: 'utf8', timeout: 20000 })
  }
  return ids
}

// Remove a scratch store dir (best-effort; a leftover temp dir holds no
// production data, unlike a leftover scratch bead).
export function removeScratchStore(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
