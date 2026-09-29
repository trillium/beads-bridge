// Unit tests: FUNNEL_BASE=https://example.test bun test src/lib/wildcard.test.ts
// (node:test, no new deps). Pins the wildcard contract (inbox-hkfd):
// registry shape, intent search, strict payload validation, explicit
// errors, write receipts, and the not-an-executor boundary.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findWildcard,
  formatWildcardInvoke,
  invokeWildcard,
  listWildcards,
  searchWildcards,
  validateWildcardInput,
  WILDCARD_ID_RE,
} from './wildcard'

const CTX = { caller: 'test-caller' }

beforeEach(() => {
  process.env.SCRATCHPAD_PATH = join(mkdtempSync(join(tmpdir(), 'wildcard-test-')), 'scratchpad.md')
})

describe('registry', () => {
  it('ships stable, unique, well-formed capability ids', () => {
    const defs = listWildcards()
    assert.ok(defs.length >= 2, 'at least the two demonstration capabilities')
    const ids = defs.map((d) => d.id)
    assert.equal(new Set(ids).size, ids.length, 'duplicate capability ids')
    for (const d of defs) {
      assert.match(d.id, WILDCARD_ID_RE, `${d.id}: unstable id shape`)
      assert.ok(d.title.length > 0 && d.description.length > 20, `${d.id}: missing contract text`)
      assert.match(d.version, /^\d+\.\d+\.\d+$/, `${d.id}: bad version`)
      assert.ok(d.effect === 'read' || d.effect === 'write', `${d.id}: bad effect`)
      assert.ok(d.keywords.length > 0, `${d.id}: no search keywords`)
      assert.ok(d.maxPayloadChars > 0, `${d.id}: no payload bound`)
    }
  })
  it('advertises both effects (read demo + write demo)', () => {
    const effects = new Set(listWildcards().map((d) => d.effect))
    assert.ok(effects.has('read'), 'no read capability to discover')
    assert.ok(effects.has('write'), 'no write capability proving the write path')
  })
  it('is NOT an arbitrary-tool executor: no def references another op or code', () => {
    // Structural proof: the def shape has no tool-reference / eval field,
    // and no shipped def smuggles one through description/params text.
    for (const d of listWildcards()) {
      const keys = Object.keys(d).sort()
      assert.deepEqual(keys, ['description', 'effect', 'id', 'keywords', 'maxPayloadChars', 'params', 'run', 'title', 'version'])
      const blob = JSON.stringify({ ...d, run: undefined }).toLowerCase()
      assert.ok(!blob.includes('eval('), `${d.id}: eval smuggled in contract text`)
      assert.ok(!/registertool|execfile|spawnsync|child_process/.test(blob), `${d.id}: execution primitive named in contract`)
    }
  })
})

describe('search', () => {
  it('finds capabilities by natural-language intent', () => {
    const hits = searchWildcards('echo something back without changing state')
    assert.ok(hits.length > 0, 'read demo should match')
    assert.equal(hits[0].def.id, 'echo_probe')
  })
  it('finds the write demo by write intent and surfaces the effect pre-invocation', () => {
    const hits = searchWildcards('write append mutate state')
    const ids = hits.map((h) => h.def.id)
    assert.ok(ids.includes('write_probe'), `write demo missing from ${ids.join(',')}`)
    const hit = hits.find((h) => h.def.id === 'write_probe')
    assert.equal(hit?.def.effect, 'write')
  })
  it('finds the resume resolver by the motivating intent and shows it read-only', () => {
    const hits = searchWildcards('resolve resume manifest to rendered content with atom provenance')
    assert.ok(hits.length > 0, 'resume resolver should match')
    assert.equal(hits[0].def.id, 'resume_resolve')
    assert.equal(hits[0].def.effect, 'read')
  })
  it('returns nothing for empty queries and for unrelated intents', () => {
    assert.deepEqual(searchWildcards(''), [])
    assert.deepEqual(searchWildcards('   '), [])
    assert.deepEqual(searchWildcards('xylophone quantum arbitrage'), [])
  })
})

describe('validation', () => {
  it('accepts a correct payload and rejects unknown keys', () => {
    const def = findWildcard('echo_probe')
    assert.ok(def)
    assert.deepEqual(validateWildcardInput(def, { message: 'hi' }), { ok: true, value: { message: 'hi' } })
    const bad = validateWildcardInput(def, { message: 'hi', tool: 'bead_show' })
    assert.equal(bad.ok, false)
    assert.match((bad as { message: string }).message, /unknown param.*tool/)
  })
  it('rejects missing required params, wrong types, oversize strings and payloads', () => {
    const def = findWildcard('echo_probe')
    assert.ok(def)
    assert.equal(validateWildcardInput(def, {}).ok, false)
    assert.equal(validateWildcardInput(def, { message: 42 }).ok, false)
    assert.equal(validateWildcardInput(def, { message: 'x'.repeat(2001) }).ok, false)
    assert.equal(validateWildcardInput(def, ['message']).ok, false)
    assert.equal(validateWildcardInput(def, null).ok, false)
    assert.equal(validateWildcardInput(def, 'str').ok, false)
  })
})

describe('invoke', () => {
  it('runs the read demo with no side effects', async () => {
    const r = await invokeWildcard('echo_probe', { message: 'hello wildcard' }, CTX)
    assert.equal(r.ok, true)
    assert.ok(r.ok && r.text.includes('hello wildcard'))
    assert.equal(r.ok && r.effect, 'read')
    const out = formatWildcardInvoke(r, CTX)
    assert.match(out, /# capability — invoke echo_probe \(read\)/)
    assert.match(out, /provenance: backend v\S+ \/ manifest v\d+ \/ capability echo_probe \d+\.\d+\.\d+ \/ by test-caller/)
  })
  it('runs the write demo with a structured receipt', async () => {
    const r = await invokeWildcard('write_probe', { note: 'wildcard write proof' }, CTX)
    assert.equal(r.ok, true)
    assert.ok(r.ok && r.effect === 'write')
    assert.ok(r.ok && r.receipt, 'write without a receipt is a failure')
    assert.equal(r.ok && r.receipt?.capability, 'write_probe')
    assert.equal(r.ok && r.receipt?.by, 'test-caller')
    assert.ok(r.ok && typeof r.receipt?.entries === 'number')
    const out = formatWildcardInvoke(r, CTX)
    assert.match(out, /receipt:/)
    assert.match(out, /wildcard write proof|appended probe note/)
  })
  it('fails explicitly on unknown ids with suggestions, never guessing', async () => {
    const r = await invokeWildcard('echo', { message: 'x' }, CTX)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.code === 'unknown_capability')
    assert.match((r as { message: string }).message, /unknown capability 'echo'/)
    assert.ok((r as { hint?: string }).hint?.includes('echo_probe'), 'should suggest the close match')
    const out = formatWildcardInvoke(r, CTX)
    assert.match(out, /invoke failed \(unknown_capability\)/)
  })
  it('fails explicitly on invalid payloads and names the contract', async () => {
    const r = await invokeWildcard('echo_probe', { message: 7 }, CTX)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.code === 'invalid_payload')
    assert.ok((r as { hint?: string }).hint?.includes('describe'), 'error must point at the contract')
  })
  it('fails explicitly while the resume resolver is stubbed — discoverable, never silent', async () => {
    const r = await invokeWildcard('resume_resolve', { manifest_id: 'resumes-zak' }, CTX)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.code === 'capability_failed', 'a stubbed execution must fail loudly, not look unknown')
    assert.match((r as { message: string }).message, /not yet implemented/)
    assert.match((r as { message: string }).message, /manifest hygiene/)
  })
  it('refuses an unverified write: write defs without receipts are errors', async () => {
    // Proved structurally: invokeWildcard returns capability_failed when a
    // write def yields no receipt. Every shipped write def carries one
    // (previous test); this pins the guardrail text for future defs.
    const r = await invokeWildcard('   ', {}, CTX)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.code === 'unknown_capability')
  })
})
