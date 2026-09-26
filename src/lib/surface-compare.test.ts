// Unit tests: bun test src/lib/surface-compare.test.ts (node:test, no new deps).
// Covers task-trv5y acceptance: most-recent feedback selection, expected-
// surface extraction, add/remove/schema diffs, needs_refresh both ways.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SURFACE_CHECK_MAX_CHARS,
  checkSurface,
  diffOpSets,
  extractRecordedTriple,
  extractToolMentions,
  formatSurfaceCheck,
  latestFeedbackFilename,
  listFeedbackRecords,
  parseClientTools,
  type SurfaceVerdict,
} from './surface-compare'

const VOCAB = ['whoami', 'bridge_info', 'bead_show', 'personality_read', 'relay_status']
const LIVE = ['whoami', 'bridge_info', 'bead_show', 'personality_read', 'relay_status']
const TRIPLE = { version: '1.3.0', manifest: 1, commit: 'abc1234', schema: 'd52b60fa02892c42' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surface-test-'))
})

function seed(names: string[]): void {
  for (const n of names) writeFileSync(join(dir, n), 'x')
}

function verdict(over: Partial<Parameters<typeof checkSurface>[0]> = {}): SurfaceVerdict {
  return checkSurface({
    feedbackFile: null,
    feedbackText: '',
    vocabulary: VOCAB,
    liveOps: LIVE,
    liveTriple: TRIPLE,
    clientTools: null,
    clientSchema: null,
    changedSince: [],
    ...over,
  })
}

describe('latest feedback selection', () => {
  it('picks the newest timestamped record and ignores other files', () => {
    seed([
      '2026-09-26T19-11-41-920Z-feedback-wa60.md',
      'notes.txt',
      '2026-09-22T00-54-39-652Z-feedback-nkw0.md',
      '2026-09-26T09-42-12-231Z-feedback-b0ua.md',
    ])
    assert.deepEqual(listFeedbackRecords(dir), [
      '2026-09-22T00-54-39-652Z-feedback-nkw0.md',
      '2026-09-26T09-42-12-231Z-feedback-b0ua.md',
      '2026-09-26T19-11-41-920Z-feedback-wa60.md',
    ])
    assert.equal(latestFeedbackFilename(dir), '2026-09-26T19-11-41-920Z-feedback-wa60.md')
  })
  it('returns null on an empty or missing dir', () => {
    assert.equal(latestFeedbackFilename(dir), null)
    assert.equal(latestFeedbackFilename(join(dir, 'nope')), null)
  })
})

describe('expected-surface extraction', () => {
  it('extracts known ops, drops prose', () => {
    const text = 'Loaded tools include whoami, bead_show and relay_status. There is NO personality_read visible.'
    assert.deepEqual(extractToolMentions(text, VOCAB), ['bead_show', 'personality_read', 'relay_status', 'whoami'])
  })
  it('is empty for feedback with no tool snapshot', () => {
    assert.deepEqual(extractToolMentions('Routing error: relay_flow resolved wrong project.', VOCAB), [])
  })
  it('parses the recorded triple, nulls when absent', () => {
    const r = extractRecordedTriple('Backend v1.3.0 / commit 404050d / schema d52b60fa02892c42 but old.')
    assert.deepEqual(r, { version: '1.3.0', commit: '404050d', schema: 'd52b60fa02892c42' })
    assert.deepEqual(extractRecordedTriple('just prose'), { version: null, commit: null, schema: null })
  })
})

describe('diffOpSets', () => {
  it('reports additions, removals, common', () => {
    const d = diffOpSets(['whoami', 'bead_show', 'gone_tool'], ['whoami', 'bead_show', 'personality_read'])
    assert.deepEqual(d.additions, ['personality_read'])
    assert.deepEqual(d.removals, ['gone_tool'])
    assert.deepEqual(d.common, ['bead_show', 'whoami'])
  })
})

describe('needs_refresh verdict', () => {
  const snap = 'Loaded whoami, bead_show. Backend v1.3.0 / commit abc1234 / schema d52b60fa02892c42.'
  it('stale: feedback-era snapshot missing a live tool → YES', () => {
    const v = verdict({ feedbackFile: 'f.md', feedbackText: snap })
    assert.equal(v.needsRefresh, true)
    assert.ok(v.diff.additions.includes('personality_read'))
    assert.ok(v.reasons.some((r) => r.includes('manual MCP refresh')))
  })
  it('current: client supplies the full live surface → NO', () => {
    const v = verdict({
      feedbackFile: 'f.md',
      feedbackText: snap,
      clientTools: 'whoami, bridge_info bead_show personality_read relay_status',
      clientSchema: 'd52b60fa02892c42',
    })
    assert.equal(v.clientSurfaceKnown, true)
    assert.deepEqual(v.diff.additions, [])
    assert.deepEqual(v.diff.removals, [])
    assert.equal(v.needsRefresh, false)
  })
  it('stale client: client holds a dropped tool and misses a live one → YES', () => {
    const v = verdict({
      feedbackFile: 'f.md',
      feedbackText: snap,
      clientTools: 'whoami bead_show gone_tool',
      clientSchema: 'deadbeefdeadbeef',
    })
    assert.equal(v.needsRefresh, true)
    assert.deepEqual(v.diff.removals, ['gone_tool'])
    assert.ok(v.diff.additions.length > 0)
  })
  it('unknown: no tools, no hashes, no client surface → null, never a guess', () => {
    const v = verdict({ feedbackText: 'Routing error with no snapshot at all.' })
    assert.equal(v.needsRefresh, null)
    assert.ok(v.reasons.some((r) => r.includes('cannot determine')))
  })
  it('schema-only drift still verdicts YES', () => {
    const v = verdict({
      feedbackText: 'whoami bridge_info bead_show personality_read relay_status, schema aaaaaaaaaaaaaaaaa',
    })
    assert.equal(v.schemaChanged, true)
    assert.equal(v.needsRefresh, true)
  })
})

describe('parseClientTools + bounds', () => {
  it('normalizes separators and case, dedupes', () => {
    assert.deepEqual(parseClientTools('WhoAmI, bead_show\nbead_show;relay_status'), ['bead_show', 'relay_status', 'whoami'])
  })
  it('output stays bounded on huge feedback', () => {
    const v = verdict({ feedbackFile: 'f.md', feedbackText: `whoami ${'x '.repeat(20000)}` })
    assert.ok(formatSurfaceCheck(v).length <= SURFACE_CHECK_MAX_CHARS)
    assert.ok(formatSurfaceCheck(v).startsWith('# tool_surface_check — needs_refresh:'))
  })
})
