// Unit tests: bun test src/lib/feedback.test.ts (node:test, no new deps).
// Writes go to a temp dir via FEEDBACK_DIR — never the real one.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFeedbackDoc, feedbackFilename, writeFeedback } from './feedback'

const NOW = new Date('2026-09-08T19:30:00.000Z')

describe('feedbackFilename', () => {
  it('is filesystem-safe and unique', () => {
    const a = feedbackFilename(NOW)
    const b = feedbackFilename(NOW)
    assert.ok(a.endsWith('.md') && !a.includes(':'))
    assert.notEqual(a, b)
  })
})

describe('buildFeedbackDoc', () => {
  it('renders frontmatter with time, kind, bead context', () => {
    const { filename, doc } = buildFeedbackDoc(
      { text: 'hello', kind: 'bug', bead: 'task-9omwr', query: 'label query' }, NOW,
    )
    assert.ok(filename.endsWith('.md'))
    assert.ok(doc.includes('created_at: 2026-09-08T19:30:00.000Z'))
    assert.ok(doc.includes('kind: "bug"'))
    assert.ok(doc.includes('bead: "task-9omwr"'))
    assert.ok(doc.includes('store: "task"'))
    assert.ok(doc.includes('query: "label query"'))
    assert.ok(doc.endsWith('hello\n'))
  })
  it('omits absent context, rejects empty text and bad beads', () => {
    const { doc } = buildFeedbackDoc({ text: 't' }, NOW)
    assert.ok(!doc.includes('bead:'))
    assert.throws(() => buildFeedbackDoc({ text: '  ' }, NOW), /text is required/)
    assert.throws(() => buildFeedbackDoc({ text: 't', bead: 'nope' }, NOW), /unknown bead id/)
  })
})

describe('writeFeedback', () => {
  beforeEach(() => {
    process.env.FEEDBACK_DIR = mkdtempSync(join(tmpdir(), 'feedback-test-'))
  })
  it('writes exactly one file with the doc', () => {
    const { path } = writeFeedback({ text: 'filed', kind: 'praise' }, NOW)
    assert.deepEqual(readdirSync(process.env.FEEDBACK_DIR!), [path.split('/').pop()!])
    assert.ok(readFileSync(path, 'utf8').includes('kind: "praise"'))
  })
})
