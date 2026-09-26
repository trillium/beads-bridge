// Follow-on mechanism tests (brain-5eq4n design answers): triggers,
// conditions, deterministic ordering, context/result passing, failure
// handling, loop prevention, request scoping. Unit tests: bun test
// src/lib/followons.test.ts (node:test, no new deps).
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  FOLLOWON_MAX_CHARS,
  clearFollowons,
  currentScope,
  listFollowons,
  registerFollowon,
  runFollowons,
  runWithScope,
  withFollowonScope,
  withResponseFooter,
  type FollowonContext,
} from './followons'

const CTX = (tool: string, outcome: 'ok' | 'error' = 'ok'): FollowonContext => ({
  tool, outcome, caller: 'test-caller', at: 1000,
})

beforeEach(() => {
  clearFollowons()
})

describe('triggers and conditions', () => {
  it('fires per-tool matches, all-tools default, and outcome filters', () => {
    registerFollowon({ name: 'only-a', priority: 1, tools: ['tool_a'], run: () => ['A'] })
    registerFollowon({ name: 'errors', priority: 2, outcomes: ['error'], run: () => ['E'] })
    registerFollowon({ name: 'all', priority: 3, run: () => ['*'] })
    assert.deepEqual(runFollowons(CTX('tool_a')).lines, ['A', '*'])
    assert.deepEqual(runFollowons(CTX('tool_b')).lines, ['*'])
    assert.deepEqual(runFollowons(CTX('tool_b', 'error')).lines, ['E', '*'])
    assert.deepEqual(runFollowons(CTX('tool_a', 'error')).lines, ['A', 'E', '*'])
  })
  it('excludeTools denies even when tools[] would match', () => {
    registerFollowon({ name: 'x', priority: 1, excludeTools: ['nope'], run: () => ['X'] })
    assert.deepEqual(runFollowons(CTX('nope')).lines, [])
    assert.deepEqual(runFollowons(CTX('yep')).lines, ['X'])
  })
})

describe('deterministic ordering', () => {
  it('sorts by priority asc, ties by name asc; registry is inspectable', () => {
    registerFollowon({ name: 'zeta', priority: 1, run: () => ['z'] })
    registerFollowon({ name: 'alpha', priority: 1, run: () => ['a'] })
    registerFollowon({ name: 'mid', priority: 5, run: () => ['m'] })
    assert.deepEqual(listFollowons().map((s) => s.name), ['alpha', 'zeta', 'mid'])
    assert.deepEqual(runFollowons(CTX('t')).lines, ['a', 'z', 'm'])
  })
  it('re-registration replaces by name', () => {
    registerFollowon({ name: 's', priority: 1, run: () => ['one'] })
    registerFollowon({ name: 's', priority: 1, run: () => ['two'] })
    assert.deepEqual(runFollowons(CTX('t')).lines, ['two'])
  })
})

describe('context and results', () => {
  it('passes tool/outcome/caller/at forward without re-deriving', () => {
    let seen: FollowonContext | null = null
    registerFollowon({
      name: 'echo', priority: 1,
      run: (ctx) => { seen = ctx; return `${ctx.tool}|${ctx.outcome}|${ctx.caller}|${ctx.at}` },
    })
    const r = runFollowons({ tool: 'bead_show', outcome: 'error', caller: 'cli-7', at: 4242 })
    assert.deepEqual(r.lines, ['bead_show|error|cli-7|4242'])
    assert.deepEqual(seen, { tool: 'bead_show', outcome: 'error', caller: 'cli-7', at: 4242 })
  })
  it('accepts string, string[], and null results; drops blank lines', () => {
    registerFollowon({ name: 's', priority: 1, run: () => 'one' })
    registerFollowon({ name: 'a', priority: 2, run: () => ['two', '  ', 'three'] })
    registerFollowon({ name: 'n', priority: 3, run: () => null })
    assert.deepEqual(runFollowons(CTX('t')).lines, ['one', 'two', 'three'])
  })
})

describe('failure handling', () => {
  it('a throwing follow-on is recorded; the result still lands intact', () => {
    registerFollowon({ name: 'good', priority: 1, run: () => ['fine'] })
    registerFollowon({ name: 'bad', priority: 2, run: () => { throw new Error('boom') } })
    registerFollowon({ name: 'after', priority: 3, run: () => ['still-here'] })
    const r = runFollowons(CTX('t'))
    assert.deepEqual(r.lines, ['fine', 'still-here'])
    assert.deepEqual(r.failed, ['bad'])
  })
})

describe('loop prevention', () => {
  it('re-entrant runs return empty instead of recursing', () => {
    let inner: { lines: string[]; failed: string[] } | null = null
    registerFollowon({
      name: 're', priority: 1,
      run: (ctx) => { inner = runFollowons(ctx); return ['outer'] },
    })
    const r = runFollowons(CTX('t'))
    assert.deepEqual(r.lines, ['outer'])
    assert.deepEqual(inner, { lines: [], failed: [] })
  })
})

describe('request scope', () => {
  it('parses the tools/call name off a request clone without consuming it', async () => {
    let observed = ''
    const inner = async (req: globalThis.Request) => {
      const body = (await req.json()) as { params: { name: string } }
      observed = `${currentScope()?.tool}|${currentScope()?.caller}|${body.params.name}`
      return new globalThis.Response('ok')
    }
    const wrapped = withFollowonScope(inner, (b) => (b ? `client:${b}` : 'anonymous'))
    const req = new globalThis.Request('http://x/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    })
    const res = await wrapped(req)
    assert.equal(await res.text(), 'ok')
    assert.equal(observed, 'whoami|client:tok-1|whoami')
  })
  it('falls back safely on GET and unparseable bodies', async () => {
    const inner = async () => new globalThis.Response(currentScope() === null ? 'none' : `${currentScope()?.tool}|${currentScope()?.caller}`)
    const wrapped = withFollowonScope(inner)
    const get = await wrapped(new globalThis.Request('http://x/mcp'))
    assert.equal(await get.text(), 'unknown|anonymous')
    const bad = await wrapped(new globalThis.Request('http://x/mcp', { method: 'POST', body: 'not-json{{{' }))
    assert.equal(await bad.text(), 'unknown|anonymous')
  })
  it('runWithScope brackets non-MCP entry points', () => {
    assert.equal(currentScope(), null)
    const v = runWithScope({ tool: 'script', caller: 'c' }, () => currentScope()?.tool)
    assert.equal(v, 'script')
    assert.equal(currentScope(), null)
  })
})

describe('footer composition', () => {
  it('keeps body parseable, appends relay block, caps follow-on text, ends with the triple', () => {
    registerFollowon({ name: 'verbose', priority: 200, run: () => ['v'.repeat(5000)] })
    const out = runWithScope({ tool: 'bead_show', caller: 'c' }, () => withResponseFooter('# created task-x', 'ok'))
    assert.ok(out.startsWith('# created task-x\n\n'))
    assert.match(out, /## relay-status/)
    assert.match(out, /^staleness: backend v\S+ \/ manifest v\S+ \/ commit \S+ \/ schema [0-9a-f]{16}$/m)
    const extra = out.split('## relay-status')[1]
    assert.ok(extra.length <= 1500 + FOLLOWON_MAX_CHARS + 200, `footer len ${extra.length}`)
  })
  it('never throws, even with an empty registry', () => {
    const out = withResponseFooter('body', 'error')
    assert.ok(out.startsWith('body\n\n'))
    assert.match(out, /staleness:/)
  })
})
