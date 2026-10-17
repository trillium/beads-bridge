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
  matchProject,
  ambiguousProjectError,
  unresolvedProjectError,
  PROJECT_ID_RE,
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
    assert.throws(() => planProjectEdit({ project: 'parlay' }), /give title, description, note, lifecycle, and\/or priority/)
  })
  it('trims title and note, keeps empty description (clears)', () => {
    assert.deepEqual(planProjectEdit({ project: 'gas-city', title: '  T  ', description: '', note: '  n  ' }), {
      ref: 'gas-city',
      title: 'T',
      description: '',
      note: 'n',
      lifecycle: undefined,
      priority: undefined,
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

describe('planProjectEdit priority', () => {
  it('priority alone is a valid edit and parses P-forms', () => {
    assert.equal(planProjectEdit({ project: 'project-yg4v', priority: 'P0' }).priority, 0)
    assert.equal(planProjectEdit({ project: 'project-yg4v', priority: 3 }).priority, 3)
  })
  it('rejects out-of-range or malformed priority instead of guessing', () => {
    assert.throws(() => planProjectEdit({ project: 'project-yg4v', priority: 'P9' }), /invalid priority/)
    assert.throws(() => planProjectEdit({ project: 'project-yg4v', priority: 'urgent' }), /invalid priority/)
  })
})

describe('matchProject (exact-or-fail)', () => {
  const filler = Array.from({ length: 700 }, (_, i) => ({ id: `project-f${i}`, title: `Filler ${i}`, labels: [] as string[] }))
  const a4t = { id: 'project-a4t', title: 'displayd — API-driven display server for the lnx-server jumbotron', labels: [] as string[] }
  const wesk = { id: 'project-wesk', title: 'thejobhackers — repo and content project', labels: ['state:foreground'] }
  const sidecar = { id: 'project-yg4v', title: 'Sidecar', labels: ['priority:P0'] }
  const resume = { id: 'project-nuj9.1', title: 'Sidecar', labels: ['career-ops', 'resume'] }

  it('an exact id wins even when other projects share its tokens', () => {
    // "project-a4t" token-overlaps "...-content-project"; the id must win.
    const m = matchProject('project-a4t', [wesk, ...filler, a4t])
    assert.equal(m.kind, 'exact')
    assert.equal((m as { row: { id: string } }).row.id, 'project-a4t')
  })
  it('ids match case-insensitively', () => {
    assert.equal(matchProject('PROJECT-A4T', [a4t]).kind, 'exact')
  })
  it('an id-shaped ref that matches nothing is none, never a fuzzy pick', () => {
    assert.equal(matchProject('project-a4x', [wesk, a4t, sidecar]).kind, 'none')
    assert.equal(matchProject('project-a4', [wesk, a4t]).kind, 'none')
  })
  it('two projects titled Sidecar are ambiguous and both are listed', () => {
    const m = matchProject('Sidecar', [sidecar, resume])
    assert.equal(m.kind, 'ambiguous')
    const err = ambiguousProjectError('Sidecar', (m as { rows: { id: string; title: string; labels: string[] }[] }).rows, 'slug')
    assert.match(err.message, /ambiguous project "Sidecar"/)
    assert.match(err.message, /project-yg4v/)
    assert.match(err.message, /project-nuj9\.1/)
    assert.match(err.message, /nothing was written/)
  })
  it('a fuzzy token hit is NOT a match (slug merely containing "sidecar")', () => {
    const bind = { id: 'project-nuj9.1', title: 'Bind payload refs to beads (explicit sidecar)', labels: [] as string[] }
    assert.equal(matchProject('Sidecar', [bind, wesk]).kind, 'none')
  })
  it('slug, whole-title and alias each match exactly one project', () => {
    const rows = [{ id: 'project-1', title: 'Gas City', labels: ['project:gas-city', 'alias:gas-town'] }, wesk]
    assert.equal(matchProject('gas-city', rows).kind, 'exact')
    assert.equal(matchProject('project:gas-city', rows).kind, 'exact')
    assert.equal(matchProject('gas town', rows).kind, 'exact')
    assert.equal((matchProject('Gas City', rows) as { via: string }).via, 'title')
  })
  it('unresolved errors list nearest candidates but say they were not matched', () => {
    const bind = { id: 'project-nuj9.1', title: 'Bind payload refs to beads (explicit sidecar)', labels: [] as string[] }
    const err = unresolvedProjectError('Sidecar', [bind, wesk])
    assert.match(err.message, /unknown project "Sidecar"/)
    assert.match(err.message, /nothing was written/)
    assert.match(err.message, /NOT matched/)
    assert.match(err.message, /project-nuj9\.1/)
  })
  it('unresolved id-shaped refs state that ids are never fuzzy', () => {
    assert.match(unresolvedProjectError('project-zzzz', [sidecar]).message, /an id is never fuzzy-matched/)
  })
})

describe('PROJECT_ID_RE', () => {
  it('matches ids and dotted children, not names', () => {
    for (const ok of ['project-a4t', 'project-yg4v', 'project-nuj9.1', 'project-a4t.12.1']) assert.ok(PROJECT_ID_RE.test(ok), ok)
    for (const no of ['Sidecar', 'project:x', 'task-abc', 'project-', 'my project']) assert.ok(!PROJECT_ID_RE.test(no), no)
  })
})
