// Unit tests: bun test src/lib/whoami.test.ts (node:test, no new deps).
// Profile IO points at a temp dir via IDENTITY_PATH — never the real one.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatWhoami, loadProfile, updateProfile } from './whoami'

beforeEach(() => {
  process.env.IDENTITY_PATH = join(mkdtempSync(join(tmpdir(), 'identity-test-')), 'identity.json')
})

describe('updateProfile/loadProfile', () => {
  it('merges fields, rejects unknown ones', () => {
    assert.deepEqual(loadProfile(), {})
    const r1 = updateProfile({ name: 'Trillium', bogus: 1 })
    assert.deepEqual(r1.bad, ['bogus'])
    assert.equal(loadProfile().name, 'Trillium')
    const r2 = updateProfile({ role: 'captain', name: '' })
    assert.deepEqual(r2.bad, [])
    assert.deepEqual(loadProfile(), { role: 'captain' }) // empty clears
  })
  it('caps field length', () => {
    const { profile } = updateProfile({ notes: 'x'.repeat(900) })
    assert.equal(profile.notes?.length, 500)
  })
})

describe('formatWhoami', () => {
  it('renders server, caller, operator, stores without secrets', () => {
    const out = formatWhoami({
      server: 'beads-bridge',
      version: '1.0.0',
      base: 'https://bridge.example.net',
      auth: { clientId: 'bbcid_x', scopes: ['mcp'], expiresAt: 0, audience: 'https://bridge.example.net/mcp' },
      operator: { name: 'Trillium' },
      stores: ['task', 'brain'],
    })
    assert.ok(out.includes('beads-bridge v1.0.0'))
    assert.ok(out.includes('bbcid_x'))
    assert.ok(out.includes('Trillium'))
    assert.ok(out.includes('task, brain'))
    assert.ok(!out.includes('bb_at_'))
  })
  it('handles missing auth and operator', () => {
    const out = formatWhoami({ server: 'b', version: 'dev', base: 'https://x.example', stores: [] })
    assert.ok(out.includes('unauthenticated'))
    assert.ok(out.includes('(unset)'))
  })
})
