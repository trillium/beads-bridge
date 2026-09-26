// Unit tests: bun test src/lib/whoami.test.ts (node:test, no new deps).
// Profile IO points at a temp dir via IDENTITY_PATH — never the real one.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatWhoami, loadProfile, readWhoamiNotes, selectWhoamiNotes, updateProfile,
  WHOAMI_NOTES_MAX_BYTES, WHOAMI_NOTES_MAX_ENTRIES, WHOAMI_NOTES_MAX_RESUME } from './whoami'

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

describe('whoami resume context (scratchpad tail)', () => {
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  function scratchWith(lines: string[]): string {
    const p = join(mkdtempSync(join(tmpdir(), 'scratch-whoami-')), 'scratchpad.md')
    process.env.SCRATCHPAD_PATH = p
    writeFileSync(p, '# scratchpad\n' + lines.map((l) => `- ${l}`).join('\n') + '\n')
    return p
  }
  const base = { server: 'b', version: 'dev', base: 'https://x.example', stores: [] as string[] }

  it('populated scratchpad yields a bounded section with timestamps', () => {
    scratchWith([
      '2026-09-20T10:00:00.000Z first note',
      '2026-09-21T10:00:00.000Z second note',
    ])
    const { notes, total } = readWhoamiNotes()
    assert.equal(total, 2)
    assert.equal(notes.length, 2)
    const out = formatWhoami({ ...base, recentNotes: notes, scratchTotal: total })
    assert.ok(out.includes('recent notes (scratchpad, 2 of 2):'))
    assert.ok(out.includes('2026-09-20T10:00:00.000Z first note'))
    assert.ok(out.includes('[#1]') && out.includes('[#2]'))
  })
  it('a PAUSED entry older than the cap still surfaces', () => {
    const lines = ['2026-09-10T00:00:00.000Z PAUSED 2026-09-10 - big review. Resume here later.']
    for (let i = 2; i <= WHOAMI_NOTES_MAX_ENTRIES + 3; i++) lines.push(`2026-09-${10 + i}T00:00:00.000Z routine note ${i}`)
    scratchWith(lines)
    const { notes, total } = readWhoamiNotes()
    assert.equal(total, WHOAMI_NOTES_MAX_ENTRIES + 3)
    assert.ok(notes.length <= WHOAMI_NOTES_MAX_ENTRIES + WHOAMI_NOTES_MAX_RESUME)
    assert.equal(notes[0].ordinal, 1) // the old PAUSED note is prioritised first, chronological
    assert.ok(notes[0].line.includes('PAUSED'))
    const out = formatWhoami({ ...base, recentNotes: notes, scratchTotal: total })
    assert.ok(out.includes('PAUSED 2026-09-10'))
  })
  it('an oversized scratchpad stays within the caps', () => {
    const lines = [`2026-09-01T00:00:00.000Z PAUSED old but important. Resume later.`]
    for (let i = 2; i <= 40; i++) lines.push(`2026-09-02T00:00:00.000Z ${'x'.repeat(400)} ${i}`)
    scratchWith(lines)
    const { notes } = readWhoamiNotes()
    assert.ok(notes.length <= WHOAMI_NOTES_MAX_ENTRIES + WHOAMI_NOTES_MAX_RESUME)
    const bytes = notes.map((n) => n.line).join('\n').length
    assert.ok(bytes <= WHOAMI_NOTES_MAX_BYTES, `bytes ${bytes} exceed cap`)
    // newest entry always survives truncation
    assert.equal(notes[notes.length - 1].ordinal, 40)
  })
  it('absent/empty scratchpad adds nothing and does not throw', () => {
    process.env.SCRATCHPAD_PATH = join(mkdtempSync(join(tmpdir(), 'scratch-whoami-')), 'missing.md')
    assert.deepEqual(readWhoamiNotes(), { notes: [], total: 0 })
    scratchWith([])
    // header-only file: zero entries
    const { writeFileSync: w } = require('node:fs') as typeof import('node:fs')
    w(process.env.SCRATCHPAD_PATH!, '# scratchpad\n')
    assert.deepEqual(readWhoamiNotes(), { notes: [], total: 0 })
    const out = formatWhoami({ ...base, recentNotes: [], scratchTotal: 0 })
    assert.ok(!out.includes('recent notes'))
    const out2 = formatWhoami({ ...base })
    assert.ok(!out2.includes('recent notes'))
  })
  it('selectWhoamiNotes is pure and chronological without IO', () => {
    const all = ['- 2026-09-01T00:00:00.000Z a', '- 2026-09-02T00:00:00.000Z NEXT b']
    const sel = selectWhoamiNotes(all)
    assert.deepEqual(sel.map((n) => n.ordinal), [1, 2])
  })
})

describe('whoami resume tiers', () => {
  it('weak extras are evicted before fresh entries under byte pressure', () => {
    const lines = [
      '2026-09-01T00:00:00.000Z a decision was made long ago',
      '2026-09-02T00:00:00.000Z another old decision here',
    ]
    for (let i = 3; i <= WHOAMI_NOTES_MAX_ENTRIES + 2; i++) lines.push(`2026-09-03T00:00:00.000Z ${'y'.repeat(380)} ${i}`)
    const sel = selectWhoamiNotes(lines.map((l) => `- ${l}`))
    const bytes = sel.map((n) => n.line).join('\n').length
    assert.ok(bytes <= WHOAMI_NOTES_MAX_BYTES, `bytes ${bytes} exceed cap`)
    // newest entry always survives; weak incidental matches do not crowd it out
    assert.equal(sel[sel.length - 1].ordinal, lines.length)
    assert.ok(!sel.some((n) => n.ordinal <= 2), 'weak extras evicted first')
  })
  it('a single entry larger than the byte cap is truncated, never dropped', () => {
    const sel = selectWhoamiNotes([`- 2026-09-26T00:00:00.000Z PAUSED ${'z'.repeat(3000)}`])
    assert.equal(sel.length, 1)
    assert.ok(sel[0].line.includes('2026-09-26T00:00:00.000Z'))
    assert.ok(sel[0].line.includes('PAUSED'))
    assert.ok(sel[0].line.length <= WHOAMI_NOTES_MAX_BYTES)
  })
})
