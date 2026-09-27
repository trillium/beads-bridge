// Unit tests: bun test src/lib/create.test.ts (node:test, no new deps).
// Pure builders/validators only — no subprocesses, no stores touched.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCreateArgs, parseCreatedId, validateCreateLabels } from './create'

describe('buildCreateArgs', () => {
  it('builds minimal argv', () => {
    assert.deepEqual(buildCreateArgs({ store: 'task', title: 'Fix it' }), ['create', 'Fix it'])
  })
  it('passes a 5,200-char durable report through verbatim (no silent slice)', () => {
    const long = 'x'.repeat(5200)
    assert.deepEqual(
      buildCreateArgs({ store: 'task', title: 'T', description: long }),
      ['create', 'T', '-d', long],
    )
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
  it('returns null only when output holds no bead id at all', () => {
    assert.equal(parseCreatedId('task', 'see nothing id shaped here'), null)
    assert.equal(parseCreatedId('projects', 'created ok'), null)
  })
  it('falls back to the emitted id when the prefix is store-external (assert-)', () => {
    // assertions emits assert-* (wrapper BD_NAME=assert): neither the store
    // name nor its mechanical singular. The CLI is authoritative for its own
    // prefix; createBead's read-back `show` decides ownership (task-d8ipc).
    assert.equal(parseCreatedId('assertions', 'Created assert-0ke — open'), 'assert-0ke')
    assert.equal(parseCreatedId('task', 'see brain-abc12 and nope'), 'brain-abc12')
  })
  it('takes the last id on fallback so a --parent echo never shadows the bead', () => {
    assert.equal(parseCreatedId('assertions', 'parent assert-aaa then Created assert-bbb'), 'assert-bbb')
  })
  it('matches dotted child ids whole, not the parent prefix (task-r11aa)', () => {
    assert.equal(parseCreatedId('task', '✓ Created issue: task-fuk0c.1 — probe child'), 'task-fuk0c.1')
    assert.equal(parseCreatedId('task', '✓ Created issue: task-abc12.1.2 — nested'), 'task-abc12.1.2')
  })
  it('does not swallow trailing non-numeric dot segments', () => {
    assert.equal(parseCreatedId('task', 'see task-abc.5x here'), 'task-abc')
  })
})
describe('parseCreatedId across name != prefix stores (task-d8ipc)', () => {
  it('resolves the real prefix, not the store name', () => {
    assert.equal(parseCreatedId('projects', 'Created project-abc12 — open'), 'project-abc12')
    assert.equal(parseCreatedId('tasks', 'Created task-9omwr — open'), 'task-9omwr')
    assert.equal(parseCreatedId('ideas', 'Created idea-0n8 — open'), 'idea-0n8')
    assert.equal(parseCreatedId('questions', 'Created question-s9l — open'), 'question-s9l')
    assert.equal(parseCreatedId('companies', 'Created companies-7xq — open'), 'companies-7xq')
  })
  it('handles the reported case: hierarchical child in projects (project-s1rf.1.1)', () => {
    assert.equal(parseCreatedId('projects', 'Created project-s1rf.1.1 — child'), 'project-s1rf.1.1')
    assert.equal(parseCreatedId('tasks', '✓ Created issue: task-fuk0c.1 — probe child'), 'task-fuk0c.1')
  })
  it('stays correct when the caller passes an alias (project for projects)', () => {
    assert.equal(parseCreatedId('project', 'Created project-s1rf — open'), 'project-s1rf')
    assert.equal(parseCreatedId('idea', 'Created idea-0n8 — open'), 'idea-0n8')
    assert.equal(parseCreatedId('task', 'Created task-9omwr — open'), 'task-9omwr')
  })
  it('a successful create can never fail receipt parsing: every emitted id parses', () => {
    const cases: Array<[string, string]> = [
      ['projects', 'project-s1rf.1.1'],
      ['projects', 'project-abc12'],
      ['tasks', 'task-9omwr'],
      ['tasks', 'task-fuk0c.1.2'],
      ['ideas', 'idea-0n8'],
      ['assertions', 'assert-0ke'],
      ['questions', 'question-s9l'],
      ['companies', 'companies-7xq'],
      ['brain', 'brain-ow1w'],
      ['inbox', 'inbox-0v94'],
      ['stories', 'stories-x1y'],
    ]
    for (const [store, id] of cases) {
      assert.equal(parseCreatedId(store, `Created ${id}`), id, `${store} emitted ${id}`)
    }
  })
})

describe('validateCreateLabels', () => {
  it('splits good and bad, caps at 10', () => {
    const { ok, bad } = validateCreateLabels(['project:parlay', 'has space', 'a'.repeat(70), 'resume:resumes-zak'])
    assert.deepEqual(ok, ['project:parlay', 'resume:resumes-zak'])
    assert.deepEqual(bad, ['has space', 'a'.repeat(70)])
  })
})
