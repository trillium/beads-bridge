// Shell-injection contract for the legacy GET read routes: user text (?q=,
// path ids) must reach the store wrapper as inert argv, never a shell string.
// A fake `task` wrapper on PATH records its argv; a payload that was
// shell-interpreted would create the canary file or alter the recorded argv.
// Hermetic: FUNNEL_BASE=https://example.test bun test src/routes/read-injection.test.ts
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'

const dir = mkdtempSync(join(tmpdir(), 'read-injection-'))
const log = join(dir, 'argv.log')
const canary = join(dir, 'pwned')
writeFileSync(
  join(dir, 'task'),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nfor a in "$@"; do printf '[%s]' "$a" >> '${log}.raw'; done\nprintf '\\n' >> '${log}.raw'\necho ok\n`,
)
chmodSync(join(dir, 'task'), 0o755)
process.env.PATH = `${dir}:${process.env.PATH}`

let server: Server
let base = ''

before(async () => {
  const { readRouter } = await import('./read.js')
  const app = express()
  app.use(readRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })

const raw = () => (existsSync(`${log}.raw`) ? readFileSync(`${log}.raw`, 'utf8') : '')

describe('legacy GET reads are shell-free', () => {
  for (const payload of [`$(touch ${canary})`, `"; touch ${canary} #`, `\`touch ${canary}\``, `x"; touch ${canary}; echo "`]) {
    it(`?q=${payload} is passed as one argv element`, async () => {
      const res = await fetch(`${base}/task?q=${encodeURIComponent(payload)}`)
      assert.equal(res.status, 200)
      assert.equal(existsSync(canary), false, 'payload executed in a shell')
      assert.ok(raw().includes(`[search][${payload}]`), raw())
    })
  }

  it('rejects a bead id carrying shell metacharacters without spawning', async () => {
    const before = raw()
    const res = await fetch(`${base}/task-abc;touch%20${encodeURIComponent(canary)}`)
    assert.equal(existsSync(canary), false)
    assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}`)
    assert.equal(raw(), before)
  })

  it('a well-formed bead id is passed as argv', async () => {
    const res = await fetch(`${base}/task-abc12`)
    assert.equal(res.status, 200)
    assert.ok(raw().includes('[show][task-abc12]'), raw())
  })
})
