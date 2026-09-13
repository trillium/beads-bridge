// Unit tests: bun test src/routes/query/store.test.ts (node:test).
// Pure argv builders/parsers only — no subprocesses, no stores touched.
// Bare (filterless) listing is store discovery (task-mvth3): no label
// flags, just list --json --limit N.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { listArgs, parseRows } from './store'

const base = { exclude: [] as string[], limit: 20, allStates: false }

describe('listArgs', () => {
  it('builds a bare list-all argv when no filters are given', () => {
    assert.deepEqual(
      listArgs([], [], { ...base }),
      ['list', '--json', '--limit', '20'],
    )
  })
  it('adds label, any, exclude, title, status, all flags when present', () => {
    assert.deepEqual(
      listArgs(['a'], ['b', 'c'], { exclude: ['d'], title: 'T', status: 'open', limit: 5, allStates: true }),
      ['list', '--json', '--limit', '5', '--label', 'a', '--label-any', 'b,c',
        '--exclude-label', 'd', '--title-contains', 'T', '--status', 'open', '--all'],
    )
  })
})

describe('parseRows', () => {
  it('parses id/title/labels rows', () => {
    assert.deepEqual(
      parseRows(JSON.stringify([{ id: 'task-1', title: 'T', labels: ['a'] }])),
      [{ id: 'task-1', title: 'T', labels: ['a'] }],
    )
  })
  it('drops rows without ids and tolerates junk', () => {
    assert.deepEqual(parseRows('null'), [])
    assert.deepEqual(parseRows(JSON.stringify([{ title: 'no id' }])), [])
  })
})
