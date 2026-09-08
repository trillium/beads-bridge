// Unit tests: bun test src/lib/scratchpad.test.ts (node:test, no new deps).
// File IO points at a temp dir via SCRATCHPAD_PATH — never the real one.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scratchAppend, scratchClear, scratchRead } from './scratchpad'

beforeEach(() => {
  process.env.SCRATCHPAD_PATH = join(mkdtempSync(join(tmpdir(), 'scratch-test-')), 'scratchpad.md')
})

describe('scratchpad', () => {
  it('appends, reads tail, clears', () => {
    assert.deepEqual(scratchRead(), { entries: [], total: 0 })
    scratchAppend('first')
    scratchAppend('second')
    const r = scratchRead(1)
    assert.equal(r.total, 2)
    assert.equal(r.entries.length, 1)
    assert.ok(r.entries[0].endsWith('second'))
    assert.deepEqual(scratchClear(), { cleared: 2 })
    assert.deepEqual(scratchRead(), { entries: [], total: 0 })
  })
  it('rejects empty text and folds newlines', () => {
    assert.throws(() => scratchAppend('  '), /text is required/)
    scratchAppend('a\nb')
    assert.ok(scratchRead().entries[0].includes('a / b'))
  })
})
