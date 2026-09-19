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

describe('agent posture fields', () => {
  const POSTURE = {
    personality: 'dry, direct, a little wry',
    communication: 'short updates, flag blockers early',
    principles: 'verify before claiming; never fake success',
    relationship: 'thought partner, not order-taker',
    relay_stance: 'announce handoffs, leave clean state',
  } as const
  it('round-trips each new field end to end', () => {
    for (const [k, v] of Object.entries(POSTURE)) {
      const r = updateProfile({ [k]: v })
      assert.deepEqual(r.bad, [])
      assert.equal(loadProfile()[k as keyof typeof POSTURE], v)
    }
    assert.deepEqual(loadProfile(), { ...POSTURE })
  })
  it('loads an old file with only the original four fields', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(process.env.IDENTITY_PATH!, JSON.stringify({ name: 'T', role: 'captain', timezone: 'UTC', notes: 'hi' }))
    assert.deepEqual(loadProfile(), { name: 'T', role: 'captain', timezone: 'UTC', notes: 'hi' })
    const out = formatWhoami({ server: 'b', version: 'dev', base: 'https://x.example', operator: loadProfile(), stores: [] })
    assert.ok(!out.includes('posture ')) // no bloat when posture unset
  })
  it('still rejects genuinely unknown fields while accepting each new one', () => {
    for (const k of Object.keys(POSTURE)) {
      const r = updateProfile({ [k]: 'x' })
      assert.deepEqual(r.bad, [])
    }
    const r = updateProfile({ ...POSTURE, bogus_field: 'nope' })
    assert.deepEqual(r.bad, ['bogus_field'])
  })
  it('drops non-string posture values and clears with empty string', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(
      process.env.IDENTITY_PATH!,
      JSON.stringify({ name: 'T', personality: ['not', 'a', 'string'], principles: { rule: 1 }, communication: 'ok' }),
    )
    assert.deepEqual(loadProfile(), { name: 'T', communication: 'ok' })
    updateProfile({ personality: 'set' })
    assert.equal(loadProfile().personality, 'set')
    const r = updateProfile({ personality: '   ' })
    assert.deepEqual(r.bad, [])
    assert.equal(loadProfile().personality, undefined)
  })
  it('caps new-field length at 500 like the base fields', () => {
    const { profile } = updateProfile({ principles: 'y'.repeat(900) })
    assert.equal(profile.principles?.length, 500)
  })
  it('renders set posture lines compactly', () => {
    const out = formatWhoami({
      server: 'b',
      version: 'dev',
      base: 'https://x.example',
      operator: { name: 'T', personality: 'dry', relay_stance: 'clean handoffs' },
      stores: [],
    })
    assert.ok(out.includes('posture personality: dry'))
    assert.ok(out.includes('posture relay_stance: clean handoffs'))
    assert.ok(!out.includes('posture communication'))
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
