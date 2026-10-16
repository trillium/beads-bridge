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
  it('preserves a 5,200-char report body in full (no silent slice)', () => {
    const long = 'y'.repeat(5200)
    const { doc } = buildFeedbackDoc({ text: long }, NOW)
    assert.ok(doc.includes(long), 'the complete body must survive into the filed doc')
    assert.ok(doc.endsWith(`${long}\n`))
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

// ---- feedback_edit (feedback mwfd) ----------------------------------------
import { existsSync, writeFileSync as writeFileSyncX } from 'node:fs'
import { editFeedback, FEEDBACK_HISTORY_DIR, formatFeedbackEdit, resolveFeedbackFile } from './feedback'

describe('editFeedback', () => {
  let dir = ''
  let filename = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'feedback-edit-test-'))
    process.env.FEEDBACK_DIR = dir
    filename = writeFeedback({ text: 'original text', kind: 'idea' }, NOW).filename
  })

  const short = () => filename.replace(/\.md$/, '').split('-feedback-')[1]
  const read = () => readFileSync(join(dir, filename), 'utf8')

  it('resolves by short id, filename, and filename without .md', () => {
    assert.equal(resolveFeedbackFile(dir, short()), filename)
    assert.equal(resolveFeedbackFile(dir, filename), filename)
    assert.equal(resolveFeedbackFile(dir, filename.replace(/\.md$/, '')), filename)
  })

  it('rejects unknown ids, path traversal and non-ids', () => {
    assert.throws(() => resolveFeedbackFile(dir, 'zzzz'), /no feedback record with id 'zzzz'/)
    assert.throws(() => resolveFeedbackFile(dir, '../etc/passwd'), /bad feedback reference/)
    assert.throws(() => resolveFeedbackFile(dir, 'a/b'), /bad feedback reference/)
    assert.throws(() => resolveFeedbackFile(dir, 'NOT AN ID'), /neither a feedback filename nor a short id/)
    assert.throws(() => resolveFeedbackFile(dir, '2026-01-01T00-00-00-000Z-feedback-none.md'), /no feedback record named/)
    assert.throws(() => resolveFeedbackFile(dir, ''), /id is required/)
  })

  it('reports an ambiguous short id and asks for the full filename', () => {
    writeFileSyncX(join(dir, '2026-09-09T00-00-00-000Z-feedback-dup1.md'), '---\n---\n\nx\n')
    writeFileSyncX(join(dir, '2026-09-10T00-00-00-000Z-feedback-dup1.md'), '---\n---\n\ny\n')
    assert.throws(() => resolveFeedbackFile(dir, 'dup1'), /ambiguous/)
  })

  it('replace: swaps the body, bumps revision, records reason, keeps the original as a read-only snapshot', () => {
    const before = read()
    const later = new Date('2026-10-16T12:00:00.000Z')
    const r = editFeedback({ id: short(), text: 'rewritten text', reason: 'fix typo' }, later)
    assert.equal(r.verified, true)
    assert.equal(r.revision, 1)
    assert.equal(r.previousRevision, 0)
    const now = read()
    assert.match(now, /revision: 1\n/)
    assert.match(now, /updated_at: 2026-10-16T12:00:00.000Z/)
    assert.match(now, /last_edit_reason: "fix typo"/)
    assert.ok(now.endsWith('\nrewritten text\n'))
    assert.ok(!now.includes('original text'))
    assert.match(now, /created_at: 2026-09-08T19:30:00.000Z/, 'creation time is preserved')
    assert.ok(existsSync(r.historyPath))
    assert.equal(readFileSync(r.historyPath, 'utf8'), before, 'snapshot is the exact previous version')
    assert.match(r.historyPath, new RegExp(`${FEEDBACK_HISTORY_DIR}/.*\\.r0\\.md$`))
    assert.match(formatFeedbackEdit(r), /revision 0 -> 1/)
  })

  it('append: keeps the original text and adds a dated amendment', () => {
    const r = editFeedback({ id: filename, text: 'follow-up detail', mode: 'append' }, new Date('2026-10-16T12:00:00.000Z'))
    const now = read()
    assert.ok(now.includes('original text'))
    assert.ok(now.includes('**Amendment (2026-10-16T12:00:00.000Z):**\nfollow-up detail'))
    assert.equal(r.mode, 'append')
  })

  it('a second edit archives revision 1 as .r1.md and the first snapshot is untouched', () => {
    const a = editFeedback({ id: short(), text: 'v1' })
    const afterFirst = read()
    const b = editFeedback({ id: short(), text: 'v2' })
    assert.equal(b.revision, 2)
    assert.ok(a.historyPath.endsWith('.r0.md') && b.historyPath.endsWith('.r1.md'))
    assert.equal(readFileSync(b.historyPath, 'utf8'), afterFirst)
    assert.ok(readFileSync(a.historyPath, 'utf8').includes('original text'))
  })

  it('a concurrent edit (revision already archived) is an error, never an overwrite', () => {
    editFeedback({ id: short(), text: 'v1' })
    // Simulate a racing editor having archived revision 1 already.
    writeFileSyncX(join(dir, FEEDBACK_HISTORY_DIR, `${filename.replace(/\.md$/, '')}.r1.md`), 'other editor')
    assert.throws(() => editFeedback({ id: short(), text: 'v2' }), /edited concurrently/)
    assert.ok(read().endsWith('\nv1\n'), 'record is unchanged by the refused edit')
  })

  it('rejects empty text, bad mode, and records without frontmatter', () => {
    assert.throws(() => editFeedback({ id: short(), text: '   ' }), /text is required/)
    assert.throws(() => editFeedback({ id: short(), text: 'x', mode: 'nope' as never }), /mode must be/)
    writeFileSyncX(join(dir, filename), 'no frontmatter here')
    assert.throws(() => editFeedback({ id: short(), text: 'x' }), /no frontmatter/)
  })

  it('edits never create a second top-level record', () => {
    editFeedback({ id: short(), text: 'v1' })
    assert.deepEqual(readdirSync(dir).filter((n) => !n.startsWith('.')), [filename])
  })
})
