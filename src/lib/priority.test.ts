// Unit tests: FUNNEL_BASE=https://example.test bun test src/lib/priority.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePriority, priorityFromShow, priorityLabelError, priorityReadsBack } from './priority'

describe('parsePriority', () => {
  it('accepts 0-4, "0"-"4" and P0-P4 in any case', () => {
    assert.equal(parsePriority(0), 0)
    assert.equal(parsePriority('P0'), 0)
    assert.equal(parsePriority('p3'), 3)
    assert.equal(parsePriority('4'), 4)
    assert.equal(parsePriority(' P1 '), 1)
  })
  it('treats absent as undefined', () => {
    assert.equal(parsePriority(undefined), undefined)
    assert.equal(parsePriority(''), undefined)
  })
  it('throws on anything else — no clamping, no guessing', () => {
    for (const bad of [5, -1, 'P5', 'high', 'P', 1.5, 'priority:P0']) assert.throws(() => parsePriority(bad), /invalid priority/, String(bad))
  })
})

describe('priorityLabelError', () => {
  it('rejects priority labels and points at the field', () => {
    const e = priorityLabelError(['source:mcp', 'priority:P0'])
    assert.match(e ?? '', /priority:P0/)
    assert.match(e ?? '', /`priority` field/)
    assert.match(priorityLabelError(['Priority:P1']) ?? '', /Priority:P1/)
  })
  it('passes ordinary labels', () => {
    assert.equal(priorityLabelError(['project:sidecar', 'high-priority', 'prio']), null)
    assert.equal(priorityLabelError(undefined), null)
  })
})

describe('priorityFromShow / priorityReadsBack', () => {
  const show = (p: string, title = 'Sidecar') => `○ project-yg4v · ${title}   [● ${p} · OPEN]\nOwner: x\n\nLABELS: priority:P0\n`
  it('reads the P number from the header status group', () => {
    assert.equal(priorityFromShow(show('P2')), 2)
    assert.equal(priorityFromShow(show('P0')), 0)
  })
  it('the priority:P0 LABEL in the body never counts', () => {
    assert.equal(priorityReadsBack(show('P2'), 0), false)
    assert.equal(priorityReadsBack(show('P0'), 0), true)
  })
  it('a P-ish title cannot spoof the status group', () => {
    assert.equal(priorityFromShow(show('P3', 'Fix [P0] outage')), 3)
  })
  it('unreadable output is not confirmation', () => {
    assert.equal(priorityFromShow(null), null)
    assert.equal(priorityFromShow('no header here'), null)
    assert.equal(priorityReadsBack(null, 0), false)
  })
})
