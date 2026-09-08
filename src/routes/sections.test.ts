import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readSection, withSections } from './sections'

describe('readSection', () => {
  it('reads a known section with vars filled and frontmatter stripped', () => {
    const out = readSection('retro')
    assert.ok(out.startsWith('## retro'))
    assert.ok(!out.startsWith('---'))
    assert.ok(!out.includes('vars:'))
  })
  it('fills {BASE} and {RESUME}', () => {
    const out = readSection('done-pointer', 'resumes-zak')
    assert.ok(!out.includes('{BASE}'))
    assert.ok(!out.includes('{RESUME}'))
    assert.ok(out.includes('/fetch/resumes-zak/done'))
  })
  it('returns empty for unknown sections', () => {
    assert.equal(readSection('no-such-section'), '')
  })
  it('rejects path traversal', () => {
    assert.equal(readSection('../../secret'), '')
    assert.equal(readSection('a/b'), '')
  })
})

describe('withSections', () => {
  it('appends sections separated by rules', () => {
    const out = withSections('body', 'resumes-zak', 'retro', 'done-pointer')
    assert.ok(out.startsWith('body\n\n---\n\n## retro'))
    assert.ok(out.includes('## when decided'))
  })
  it('skips missing sections silently', () => {
    assert.equal(withSections('body', 'r', 'no-such-section'), 'body')
  })
  it('returns the body unchanged with no sections', () => {
    assert.equal(withSections('body', 'r'), 'body')
  })
})
