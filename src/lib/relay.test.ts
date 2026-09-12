import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aliasTexts,
  captureStoreFor,
  dispatchLabels,
  duplicateScore,
  findDuplicate,
  normalize,
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
