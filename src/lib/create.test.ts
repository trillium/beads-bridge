// Unit tests: bun test src/lib/create.test.ts (node:test, no new deps).
// Pure builders/validators only — no subprocesses, no stores touched.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCreateArgs, parseCreatedId, validateCreateLabels } from './create'

describe('buildCreateArgs', () => {
  it('builds minimal argv', () => {
    assert.deepEqual(buildCreateArgs({ store: 'task', title: 'Fix it' }), ['create', 'Fix it'])
  })
  it('adds description, labels, parent only when present', () => {
    assert.deepEqual(
      buildCreateArgs({ store: 'stories', title: 'T', description: 'D', labels: ['a', 'project:x'], parent: 'stories-abc' }),
      ['create', 'T', '-d', 'D', '-l', 'a,project:x', '--parent', 'stories-abc'],
    )
  })
})

describe('parseCreatedId', () => {
  it('finds the store-prefixed id in prose', () => {
    assert.equal(parseCreatedId('task', 'Created task-9omwr — open'), 'task-9omwr')
  })
  it('ignores other stores and junk', () => {
    assert.equal(parseCreatedId('task', 'see brain-abc12 and nope'), null)
  })
  it('matches dotted child ids whole, not the parent prefix (task-r11aa)', () => {
    assert.equal(parseCreatedId('task', '✓ Created issue: task-fuk0c.1 — probe child'), 'task-fuk0c.1')
    assert.equal(parseCreatedId('task', '✓ Created issue: task-abc12.1.2 — nested'), 'task-abc12.1.2')
  })
  it('does not swallow trailing non-numeric dot segments', () => {
    assert.equal(parseCreatedId('task', 'see task-abc.5x here'), 'task-abc')
  })
})

describe('validateCreateLabels', () => {
  it('splits good and bad, caps at 10', () => {
    const { ok, bad } = validateCreateLabels(['project:parlay', 'has space', 'a'.repeat(70), 'resume:resumes-zak'])
    assert.deepEqual(ok, ['project:parlay', 'resume:resumes-zak'])
    assert.deepEqual(bad, ['has space', 'a'.repeat(70)])
  })
})
