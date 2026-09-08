// Unit tests: bun test src/lib/connections.test.ts (node:test, no new deps).
// Pure helpers only — no subprocesses, no stores touched.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parentOf, linkLabels, toConnection, formatConnections, type ConnectionSet } from './connections'

describe('parentOf', () => {
  it('derives dotted parents', () => {
    assert.equal(parentOf('task-2nwlw.1'), 'task-2nwlw')
    assert.equal(parentOf('task-2nwlw'), null)
    assert.equal(parentOf('resumes-zak'), null)
  })
})

describe('linkLabels', () => {
  it('keeps join-labels only, capped', () => {
    assert.deepEqual(
      linkLabels(['human', 'project:parlay', 'resume:resumes-zak', 'lifecycle:sent', 'project:x', 'project:y', 'project:z']),
      ['project:parlay', 'resume:resumes-zak', 'project:x', 'project:y'],
    )
  })
})

describe('toConnection', () => {
  it('maps typed dep records, tolerates junk', () => {
    assert.deepEqual(
      toConnection({ id: 'task-1', title: 'T', status: 'open', dependency_type: 'tracks' }, 'x'),
      { id: 'task-1', title: 'T', status: 'open', via: 'tracks' },
    )
    assert.equal(toConnection({ title: 'no id' }, 'x'), null)
    assert.equal(toConnection({ id: 'task-1' }, 'depends-on')?.via, 'depends-on')
  })
})

describe('formatConnections', () => {
  it('renders every section with none-markers', () => {
    const set: ConnectionSet = {
      bead: { id: 'task-1', title: 'T', store: 'task', labels: [] },
      dependsOn: [],
      dependedOnBy: [{ id: 'task-2', title: 'U', via: 'blocks' }],
      children: [],
      parent: null,
      sameLabels: [],
      mentioned: [],
    }
    const out = formatConnections(set)
    for (const h of ['depends on', 'depended on by', 'children', 'parent', 'mentioned in text']) {
      assert.ok(out.includes(`## ${h}`), h)
    }
    assert.ok(out.includes('task-2 (blocks)') || out.includes('- task-2 — U (blocks)'))
    assert.ok(out.includes('top-level'))
  })
})
