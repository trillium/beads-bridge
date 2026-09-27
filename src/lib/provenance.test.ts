// Unit tests: bun test src/lib/provenance.test.ts (node:test, no new deps).
// Pure label helpers only — no subprocesses, no stores touched.
// (Importing routes/paste pulls config, so run with FUNNEL_BASE set,
// same as batch.test.ts.)
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PASTE_SOURCE_LABEL,
  PASTE_UNTRIAGED_LABEL,
  callerLabel,
  currentRequestCaller,
  sourceLabel,
  withProvenance,
  type CreateSource,
} from './provenance'
import { MAX_LABELS, cleanLabel } from '../routes/query/params'
import { runWithScope } from './followons'
import { buildCreateArgs } from './create'
import { buildPasteArgs } from '../routes/paste'

describe('sourceLabel', () => {
  it('spells every path in the existing source: convention', () => {
    const sources: CreateSource[] = ['mcp', 'paste', 'batch', 'relay']
    assert.deepEqual(sources.map(sourceLabel), ['source:mcp', 'source:paste', 'source:batch', 'source:relay'])
    for (const s of sources) assert.ok(cleanLabel(sourceLabel(s)), `${s} must pass the label gate`)
  })
  it('reproduces the paste route marker byte-for-byte (no competing scheme)', () => {
    assert.equal(sourceLabel('paste'), PASTE_SOURCE_LABEL)
    assert.equal(PASTE_SOURCE_LABEL, 'source:paste')
    assert.equal(PASTE_UNTRIAGED_LABEL, 'paste:untriaged')
  })
})

describe('callerLabel', () => {
  it('names OAuth clientIds and the loopback caller', () => {
    assert.equal(callerLabel('chatgpt-abc123'), 'by:chatgpt-abc123')
    assert.equal(callerLabel('loopback-local'), 'by:loopback-local')
    assert.equal(callerLabel('anonymous'), 'by:anonymous')
  })
  it('is empty-safe: undefined, blank, and unknown stamp nothing', () => {
    assert.equal(callerLabel(undefined), null)
    assert.equal(callerLabel(''), null)
    assert.equal(callerLabel('   '), null)
    assert.equal(callerLabel('unknown'), null)
  })
  it('sanitizes hostile input and never lands it verbatim (no token leak)', () => {
    // A bearer-shaped secret must not survive: spaces/punctuation collapse,
    // and the raw value never appears in the label.
    const hostile = 'Bearer sk-abc DEF.ghi/jkl+mno='
    const out = callerLabel(hostile)!
    assert.ok(out.startsWith('by:'), 'keeps the by: dimension')
    assert.ok(cleanLabel(out), 'stays inside the label gate')
    assert.ok(!out.includes(' '), 'no spaces survive')
    assert.ok(!out.includes('sk-abc DEF'), 'raw secret text never lands verbatim')
  })
  it('stays bounded: labels never exceed 64 chars', () => {
    const out = callerLabel(`client-${'x'.repeat(200)}`)!
    assert.ok(out.length <= 64, `bounded, got ${out.length}`)
    assert.ok(cleanLabel(out))
  })
})

describe('withProvenance', () => {
  it('leaves labels untouched when no provenance is given (backward compat)', () => {
    assert.deepEqual(withProvenance(['a', 'project:x']), ['a', 'project:x'])
    assert.deepEqual(withProvenance([]), [])
  })
  it('stamps path + caller for the MCP tool path', () => {
    assert.deepEqual(
      withProvenance(['project:parlay'], { source: 'mcp', caller: 'chatgpt-abc' }),
      ['source:mcp', 'by:chatgpt-abc', 'project:parlay'],
    )
  })
  it('stamps the relay path with no caller (the bridge itself)', () => {
    assert.deepEqual(withProvenance(['project:x'], { source: 'relay' }), ['source:relay', 'project:x'])
  })
  it('never duplicates a caller-supplied source: or by: label', () => {
    assert.deepEqual(
      withProvenance(['source:custom', 'by:human'], { source: 'mcp', caller: 'chatgpt-x' }),
      ['source:custom', 'by:human'],
    )
  })
  it('provenance survives the label cap (supply <=8 to keep them all)', () => {
    const many = Array.from({ length: 10 }, (_, i) => `k${i}`)
    const out = withProvenance(many, { source: 'batch', caller: 'c1' })
    assert.equal(out.length, MAX_LABELS)
    assert.ok(out.includes('source:batch'), 'path stamp survives the cap')
    assert.ok(out.includes('by:c1'), 'caller stamp survives the cap')
  })
})

describe('currentRequestCaller', () => {
  it('reads the in-flight MCP caller key off the request scope', () => {
    assert.equal(currentRequestCaller(), undefined)
    const seen = runWithScope({ tool: 'bead_create', caller: 'chatgpt-abc' }, () => currentRequestCaller())
    assert.equal(seen, 'chatgpt-abc')
  })
})

describe('buildCreateArgs provenance (create.ts wiring)', () => {
  it('stamps the MCP path: source:mcp + caller', () => {
    assert.deepEqual(
      buildCreateArgs({ store: 'task', title: 'T', provenance: { source: 'mcp', caller: 'chatgpt-abc' } }),
      ['create', 'T', '-l', 'source:mcp,by:chatgpt-abc'],
    )
  })
  it('stamps the relay path with no caller', () => {
    assert.deepEqual(
      buildCreateArgs({ store: 'task', title: 'T', labels: ['project:x'], provenance: { source: 'relay' } }),
      ['create', 'T', '-l', 'source:relay,project:x'],
    )
  })
  it('stamps the batch path alongside caller labels', () => {
    assert.deepEqual(
      buildCreateArgs({ store: 'task', title: 'T', labels: ['a'], provenance: { source: 'batch', caller: 'loopback-local' } }),
      ['create', 'T', '-l', 'source:batch,by:loopback-local,a'],
    )
  })
  it('omits -l entirely when there are no labels and no provenance', () => {
    assert.deepEqual(buildCreateArgs({ store: 'task', title: 'T' }), ['create', 'T'])
  })
})

describe('paste route preservation', () => {
  it('buildPasteArgs emits the exact historical argv (source:paste + untriaged)', () => {
    assert.deepEqual(buildPasteArgs('My title', 'body text'), [
      'create', 'My title', '--description', 'body text',
      '--label', 'source:paste', '--label', 'paste:untriaged',
    ])
  })
  it('the paste stamp matches the shared scheme (sourceLabel(paste))', () => {
    const args = buildPasteArgs('T', 'body')
    assert.ok(args.includes(sourceLabel('paste')), 'paste argv carries the scheme marker')
  })
})
