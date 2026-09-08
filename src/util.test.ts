// Unit tests: tsx --test "src/**/*.test.ts" (node:test, no new deps).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripFrontmatter,
  withCb,
  shortCode,
  qstr,
  pstr,
  storeFromId,
  extractLinks,
} from './util'

describe('stripFrontmatter', () => {
  it('strips a leading frontmatter block', () => {
    const out = stripFrontmatter('---\nvars:\n  A: string\n---\n# Title\nbody\n')
    assert.equal(out, '# Title\nbody\n')
  })
  it('leaves files without frontmatter untouched', () => {
    assert.equal(stripFrontmatter('# Title\nbody\n'), '# Title\nbody\n')
  })
  it('leaves --- elsewhere untouched (only leading counts)', () => {
    const md = '# T\n---\nbody\n'
    assert.equal(stripFrontmatter(md), md)
  })
  it('leaves unclosed fences untouched', () => {
    const md = '---\nvars:\n  A: string\n# Title\n'
    assert.equal(stripFrontmatter(md), md)
  })
  it('handles empty input', () => {
    assert.equal(stripFrontmatter(''), '')
  })
})

describe('withCb / shortCode', () => {
  it('appends ?cb= without a query string', () => {
    assert.equal(withCb('https://x/y', 'AB12'), 'https://x/y?cb=AB12')
  })
  it('appends &cb= with a query string', () => {
    assert.equal(withCb('https://x/y?fresh=1', 'AB12'), 'https://x/y?fresh=1&cb=AB12')
  })
  it('mints 4-char alphanumeric codes by default', () => {
    assert.match(shortCode(), /^[A-Za-z0-9]{4}$/)
    assert.notEqual(shortCode(), shortCode())
  })
})

describe('coercions', () => {
  it('qstr takes a single string or first array element', () => {
    assert.equal(qstr('a'), 'a')
    assert.equal(qstr(['a', 'b']), 'a')
    assert.equal(qstr(undefined), undefined)
  })
  it('pstr coerces express params', () => {
    assert.equal(pstr('a'), 'a')
    assert.equal(pstr(['a', 'b']), 'a')
    assert.equal(pstr(undefined), '')
  })
})

describe('storeFromId', () => {
  it('resolves bead prefixes to stores', () => {
    assert.equal(storeFromId('resume_bullets-xxx'), 'resume_bullets')
    assert.equal(storeFromId('resumes-zak'), 'resumes')
    assert.equal(storeFromId('task-9omwr'), 'task')
  })
  it('returns null for unknown prefixes', () => {
    assert.equal(storeFromId('nope-123'), null)
    assert.equal(storeFromId(''), null)
  })
})

describe('extractLinks', () => {
  it('finds urls and bead ids, drops bare BASE', () => {
    const out = extractLinks('see https://example.com/a and review-3y3 plus https://bridge.example.net/next?cache=x')
    assert.ok(out.includes('https://example.com/a'))
    assert.ok(out.some((l) => l.endsWith('/review-3y3')))
  })
})
