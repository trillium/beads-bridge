import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aliasTexts,
  captureStoreFor,
  dispatchLabels,
  duplicateScore,
  findDuplicate,
  formatProjectEdit,
  lifecycleLabels,
  lifecycleState,
  normalize,
  planProjectEdit,
  projectState,
  rankProjects,
  scoreRow,
  slugOf,
  slugify,
  tokens,
} from './relay'

describe('normalize/tokens', () => {
  it('normalizes punctuation and case', () => {
    assert.equal(normalize('Gas-City! MVP'), 'gas city mvp')
  })
  it('dedupes short tokens', () => {
    assert.deepEqual(tokens('a bb bb cc'), ['bb', 'cc'])
  })
})

describe('slugOf/projectState', () => {
  it('prefers project: label over title', () => {
    assert.equal(slugOf(['project:gas-city', 'sys:resume'], 'Whatever'), 'gas-city')
  })
  it('slugifies title without a label', () => {
    assert.equal(slugOf([], 'My Cool Thing'), 'my-cool-thing')
  })
  it('defaults to backlog, foreground on label', () => {
    assert.equal(projectState([]), 'backlog')
    assert.equal(projectState(['state:foreground']), 'foreground')
  })
  it('reads alias labels', () => {
    assert.deepEqual(aliasTexts(['alias:gas-town', 'aka:gt', 'other']), ['gas town', 'gt'])
  })
})

describe('scoreRow/rankProjects', () => {
  const rows = [
    { id: 'project-aaa', title: 'Gas City cross-machine', labels: ['project:gas-city'] },
    { id: 'project-bbb', title: 'Talon voice tooling', labels: ['project:talon-voice'] },
    { id: 'project-ccc', title: 'Parlay agent router', labels: ['project:parlay', 'state:foreground'] },
  ]
  it('exact title wins', () => {
    const ranked = rankProjects('parlay agent router', rows, 3)
    assert.equal(ranked[0].id, 'project-ccc')
    assert.equal(ranked[0].state, 'foreground')
    assert.equal(ranked[0].backlog, false)
  })
  it('slug match flags backlog', () => {
    const ranked = rankProjects('gas city', rows, 3)
    assert.equal(ranked[0].id, 'project-aaa')
    assert.equal(ranked[0].backlog, true)
  })
  it('no tokens means no candidates', () => {
    assert.deepEqual(rankProjects('!!!', rows), [])
  })
  it('scoreRow exact beats partial', () => {
    const e = scoreRow(tokens('talon voice tooling'), rows[1])
    const p = scoreRow(tokens('talon'), rows[1])
    assert.ok(e.score > p.score)
  })
})

describe('captureStoreFor', () => {
  it('routes kinds to stores', () => {
    assert.equal(captureStoreFor('idea'), 'ideas')
    assert.equal(captureStoreFor('friction'), 'friction')
    assert.equal(captureStoreFor('observation'), 'brain')
    assert.equal(captureStoreFor('correction'), 'brain')
    assert.equal(captureStoreFor('knowledge'), 'brain')
  })
  it('rejects unknown kinds', () => {
    assert.equal(captureStoreFor('todo'), null)
  })
})

describe('duplicateScore/findDuplicate', () => {
  it('exact and containment score high', () => {
    assert.equal(duplicateScore('Fix login', 'fix login'), 1)
    assert.ok(duplicateScore('Fix login bug', 'Fix login') >= 0.85)
  })
  it('unrelated titles score low', () => {
    assert.ok(duplicateScore('Fix login', 'Bake bread') < 0.6)
  })
  it('finds the best duplicate above threshold', () => {
    const rows = [
      { id: 'task-aaa', title: 'Bake bread', labels: [] as string[] },
      { id: 'task-bbb', title: 'Fix login redirect', labels: [] as string[] },
    ]
    assert.equal(findDuplicate('fix login redirect loop', rows)?.id, 'task-bbb')
    assert.equal(findDuplicate('something entirely different here', rows), null)
  })
})

describe('dispatchLabels/slugify', () => {
  it('always requests dispatch, adds project when known', () => {
    assert.deepEqual(dispatchLabels(undefined), ['dispatch:requested'])
    assert.deepEqual(dispatchLabels('gas-city'), ['dispatch:requested', 'project:gas-city'])
  })
  it('slugifies titles', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world')
  })
})

describe('lifecycleState/lifecycleLabels', () => {
  it('defaults active, deprecated on the lifecycle label', () => {
    assert.equal(lifecycleState([]), 'active')
    assert.equal(lifecycleState(['state:foreground']), 'active')
    assert.equal(lifecycleState(['state:deprecated']), 'deprecated')
    assert.equal(lifecycleState(['state:deprecated', 'state:foreground']), 'deprecated')
  })
  it('maps deprecated to add state:deprecated, active to remove it', () => {
    assert.deepEqual(lifecycleLabels('deprecated'), { add: 'state:deprecated' })
    assert.deepEqual(lifecycleLabels('active'), { remove: 'state:deprecated' })
  })
})

describe('planProjectEdit', () => {
  it('requires a project reference', () => {
    assert.throws(() => planProjectEdit({ project: '   ' }), /project is required/)
  })
  it('requires at least one editable field', () => {
    assert.throws(() => planProjectEdit({ project: 'parlay' }), /give title, description, note, and\/or lifecycle/)
  })
  it('trims title and note, keeps empty description (clears)', () => {
    assert.deepEqual(planProjectEdit({ project: 'gas-city', title: '  T  ', description: '', note: '  n  ' }), {
      ref: 'gas-city',
      title: 'T',
      description: '',
      note: 'n',
      lifecycle: undefined,
    })
  })
  it('rejects unknown lifecycle values', () => {
    assert.throws(
      () => planProjectEdit({ project: 'parlay', lifecycle: 'archived' as 'active' }),
      /unknown lifecycle: archived/,
    )
  })
  it('accepts every single-field combo', () => {
    const base = { project: 'cv-generator' }
    assert.deepEqual(planProjectEdit({ ...base, description: 'D' }).description, 'D')
    assert.deepEqual(planProjectEdit({ ...base, note: 'N' }).note, 'N')
    assert.deepEqual(planProjectEdit({ ...base, lifecycle: 'deprecated' }).lifecycle, 'deprecated')
    assert.deepEqual(planProjectEdit({ ...base, title: 'x' }).title, 'x')
  })
})

describe('formatProjectEdit', () => {
  const result = {
    id: 'project-9d5',
    slug: 'cv-generator',
    title: 'cv-generator',
    state: 'backlog' as const,
    lifecycle: 'deprecated' as const,
    steps: [
      { name: 'update', ok: true, detail: 'title + description updated (verified)' },
      { name: 'note', ok: true, detail: 'note appended (verified)' },
      { name: 'lifecycle', ok: true, detail: 'set deprecated — state:deprecated added (verified)' },
    ],
    complete: true,
  }
  it('shows the project heading, resolved refs, and verified steps on success', () => {
    const out = formatProjectEdit(result)
    assert.match(out, /# project updated project-9d5 \(STORE: projects\)/)
    assert.match(out, /project: cv-generator/)
    assert.match(out, /state: backlog · lifecycle: deprecated \(state:deprecated\)/)
    assert.match(out, /- update: ok/)
    assert.match(out, /All steps verified — project reads back\./)
  })
  it('flags partial failure with a re-read warning', () => {
    const partial = { ...result, complete: false, steps: [{ name: 'note', ok: false, detail: 'boom' }] }
    const out = formatProjectEdit(partial)
    assert.match(out, /Partial: 1 step\(s\) failed — re-read project-9d5 before reporting success\./)
  })
})
