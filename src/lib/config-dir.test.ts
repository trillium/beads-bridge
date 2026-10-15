// Unit tests: FUNNEL_BASE=https://example.test bun test src/lib/config-dir.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFile, configFileReadOnly } from './config-dir'

function withHome<T>(fn: (home: string) => T): T {
  const prev = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), 'cfgdir-'))
  process.env.HOME = home
  try { return fn(home) } finally { process.env.HOME = prev }
}

test('absent everywhere resolves to the new path without creating it', () => withHome(home => {
  const p = configFile('x.json')
  assert.equal(p, join(home, '.config', 'beads-bridge', 'x.json'))
  assert.equal(existsSync(p), false)
}))

test('legacy-only file is copied forward with its mode', () => withHome(home => {
  mkdirSync(join(home, '.config', 'pai'), { recursive: true })
  writeFileSync(join(home, '.config', 'pai', 'k'), 'secret', { mode: 0o600 })
  const p = configFile('k')
  assert.equal(p, join(home, '.config', 'beads-bridge', 'k'))
  assert.equal(readFileSync(p, 'utf8'), 'secret')
  assert.equal(statSync(p).mode & 0o777, 0o600)
}))

test('new file wins over legacy', () => withHome(home => {
  mkdirSync(join(home, '.config', 'pai'), { recursive: true })
  mkdirSync(join(home, '.config', 'beads-bridge'), { recursive: true })
  writeFileSync(join(home, '.config', 'pai', 'k'), 'old')
  writeFileSync(join(home, '.config', 'beads-bridge', 'k'), 'new')
  assert.equal(readFileSync(configFile('k'), 'utf8'), 'new')
}))

test('read-only variant falls back without copying', () => withHome(home => {
  mkdirSync(join(home, '.config', 'pai'), { recursive: true })
  writeFileSync(join(home, '.config', 'pai', 'stores.yaml'), 'stores: {}')
  assert.equal(configFileReadOnly('stores.yaml'), join(home, '.config', 'pai', 'stores.yaml'))
  assert.equal(existsSync(join(home, '.config', 'beads-bridge', 'stores.yaml')), false)
}))
