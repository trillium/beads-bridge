// Unit tests: bun test src/lib/personality.test.ts (node:test, no new deps).
// Personality IO points at temp dirs via PERSONALITY_PATH / IDENTITY_PATH.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendPersonality, defaultPersonality, editPersonalitySection,
  ensurePersonality, listSections, loadPersonality, migrationSection,
  PERSONALITY_MAX_CHARS, savePersonality,
} from './personality'
import { formatWhoami, loadProfile, updateProfile } from './whoami'

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'personality-test-'))
  process.env.PERSONALITY_PATH = join(dir, 'personality.md')
  process.env.IDENTITY_PATH = join(dir, 'identity.json')
})

describe('loadPersonality (missing document)', () => {
  it('returns the default without creating a file', () => {
    const { doc, existed } = loadPersonality()
    assert.equal(existed, false)
    assert.ok(!existsSync(process.env.PERSONALITY_PATH!))
    for (const h of ['Interaction rules', 'Beads / First Mate usage', 'Speaking preferences', 'Action repertoire']) {
      assert.ok(doc.includes(`## ${h}`), `default lacks ## ${h}`)
    }
  })
})

describe('migration (task-xqj24.4)', () => {
  it('moves notes + posture verbatim, clears them, keeps name/role/timezone', () => {
    updateProfile({
      name: 'Trillium', role: 'captain', timezone: 'UTC',
      notes: 'Speak directly, without meta-framing.',
      personality: 'dry, direct',
      principles: 'verify before claiming',
    })
    const { doc, migrated } = ensurePersonality(loadProfile())
    assert.equal(migrated, true)
    assert.ok(doc.includes('Speak directly, without meta-framing.'))
    assert.ok(doc.includes('### Personality\n\ndry, direct'))
    assert.ok(doc.includes('### Principles\n\nverify before claiming'))
    assert.deepEqual(loadProfile(), { name: 'Trillium', role: 'captain', timezone: 'UTC' })
    // Second call is a stable no-op.
    const again = ensurePersonality(loadProfile())
    assert.equal(again.migrated, false)
    assert.equal(again.doc, doc)
  })
  it('empty profile migrates nothing and leaves the profile alone', () => {
    const { doc, migrated } = ensurePersonality(loadProfile())
    assert.equal(migrated, false)
    assert.equal(doc, defaultPersonality())
    assert.deepEqual(loadProfile(), {})
  })
  it('migrationSection is empty when there is nothing to move', () => {
    assert.equal(migrationSection({}), '')
    assert.equal(migrationSection({ name: 'T', timezone: 'UTC' }), '')
  })
})

describe('savePersonality (replace)', () => {
  it('round-trips a large document: no 500-char cap', () => {
    const big = `# Big\n\n${'x'.repeat(5000)}\n`
    assert.equal(savePersonality(big).chars, big.length)
    assert.deepEqual(loadPersonality(), { doc: big, existed: true })
    assert.equal(loadPersonality().doc.length, big.length)
  })
  it('rejects empty and over-cap documents', () => {
    assert.throws(() => savePersonality('   '), /non-empty/)
    assert.throws(() => savePersonality('x'.repeat(PERSONALITY_MAX_CHARS + 1)), /max/)
  })
})

describe('appendPersonality', () => {
  it('appends after a blank line, preserving prior content', () => {
    savePersonality('# Doc\n\nFirst.\n')
    appendPersonality('## New rule\n\nSecond.')
    const { doc } = loadPersonality()
    assert.ok(doc.includes('First.'))
    assert.ok(doc.endsWith('## New rule\n\nSecond.\n'))
  })
  it('migrates first so profile content is the base, never dropped', () => {
    updateProfile({ notes: 'keep me' })
    appendPersonality('appended bit')
    const { doc } = loadPersonality()
    assert.ok(doc.includes('keep me'))
    assert.ok(doc.includes('appended bit'))
  })
  it('rejects empty text', () => {
    assert.throws(() => appendPersonality('  '), /needs text/)
  })
})

describe('editPersonalitySection', () => {
  it('rewrites only the targeted section', () => {
    savePersonality('# D\n\n## Alpha\n\nold alpha\n\n## Beta\n\nold beta\n')
    editPersonalitySection('alpha', 'new alpha')
    const { doc } = loadPersonality()
    assert.ok(doc.includes('## Alpha\n\nnew alpha'))
    assert.ok(doc.includes('## Beta\n\nold beta'))
    assert.ok(!doc.includes('old alpha'))
  })
  it('keeps sub-sections inside their parent', () => {
    savePersonality('# D\n\n## Parent\n\nintro\n\n### Child\n\nchild body\n\n## Next\n\nnext body\n')
    editPersonalitySection('Parent', 'replaced')
    const { doc } = loadPersonality()
    assert.ok(!doc.includes('### Child'))
    assert.ok(doc.includes('## Next\n\nnext body'))
  })
  it('unknown heading errors listing what exists', () => {
    savePersonality('# D\n\n## Alpha\n\nbody\n')
    assert.throws(() => editPersonalitySection('nope', 'x'), /no section 'nope'.*Alpha/)
  })
  it('edits the default template sections out of the box', () => {
    editPersonalitySection('Speaking preferences', 'short sentences.')
    assert.ok(loadPersonality().doc.includes('## Speaking preferences\n\nshort sentences.'))
  })
  it('listSections reports headings in order', () => {
    assert.deepEqual(listSections('# T\n\n## A\n\n### B\n'), ['T', 'A', 'B'])
  })
})

describe('whoami renders the complete document', () => {
  it('formatWhoami embeds the full personality text', () => {
    const big = `# Doc\n\n${'y'.repeat(3000)}\n`
    const out = formatWhoami({
      server: 'b', version: 'dev', base: 'https://x.example',
      operator: { name: 'T' }, personalityDoc: big, stores: [],
    })
    assert.ok(out.includes(big))
    assert.ok(out.includes('operator document (personality'))
  })
  it('omits the document block when unset', () => {
    const out = formatWhoami({ server: 'b', version: 'dev', base: 'https://x.example', stores: [] })
    assert.ok(!out.includes('operator document'))
  })
  it('live-shape migration preserves the real operator notes', () => {
    const notes = 'Retros: record problems as beads in robots. Speak directly.'
    updateProfile({ notes })
    const { doc } = ensurePersonality(loadProfile())
    writeFileSync(process.env.PERSONALITY_PATH!, doc)
    const out = formatWhoami({
      server: 'b', version: 'dev', base: 'https://x.example',
      operator: loadProfile(), personalityDoc: loadPersonality().doc, stores: [],
    })
    assert.ok(out.includes(notes))
  })
})
