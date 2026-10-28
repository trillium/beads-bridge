// Voice-misrecognition guard (feature-n7e) — one block per acceptance test.
// Unit tests: FUNNEL_BASE=https://example.test bun test src/lib/voice-guard.test.ts
// Rules come from an injected source; the live glossary store is never read.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { runWithScope } from './followons'
import { relayStatus } from './relay-status'
import {
  PENDING_TTL_MS,
  RESUBMIT_WINDOW_MS,
  applySuggestions,
  findMisrecognitions,
  loadRules,
  parseMisrecognitions,
  resetVoiceGuard,
  rulesFromListJson,
  voiceFooterLine,
  withVoiceGuard,
  type Misrecognition,
  type ToolResult,
} from './voice-guard'

// The operator's real glossary-jgv description (verbatim shape) — the parser
// must read it without any edit to the glossary entry.
const GLOSSARY_JGV = [
  'Operator-confirmed voice recognition misrecognitions:',
  "- 'feed' (F) may mean 'bead' (B), particularly for Beads task records, inbox beads, or bead stores.",
  "- 'beat' may mean 'bead' in the same contexts.",
  "Do not automatically substitute when 'feed' or 'beat' is genuinely intended. Use context and ask for clarification when the distinction affects an action. This entry can grow with further operator-confirmed speech misrecognitions.",
].join('\n')

const RULES = parseMisrecognitions(GLOSSARY_JGV, 'glossary-jgv')

// ---- harness: a fake MCP server + recording tool handlers ---------------------

const hooks = {
  ok: (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] }),
  err: (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true }),
}

type Handler = (args: any, extra: unknown) => Promise<ToolResult>

function harness(rules: Misrecognition[] | (() => Promise<Misrecognition[]>) = RULES) {
  resetVoiceGuard(typeof rules === 'function' ? rules : async () => rules)
  const tools = new Map<string, Handler>()
  const fake = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler)
    },
  }
  const { server, confirm } = withVoiceGuard(fake, hooks)
  const writes: { tool: string; args: any }[] = []
  const reg = (name: string, schema?: unknown) =>
    (server as typeof fake).registerTool(
      name,
      { inputSchema: schema },
      (async (args: any) => {
        writes.push({ tool: name, args })
        return { content: [{ type: 'text', text: `receipt for ${name} #${writes.length}` }] }
      }) as Handler,
    )
  return { tools, writes, reg, confirm, call: (name: string, args: unknown) => tools.get(name)!(args, {}) }
}

const textOf = (r: ToolResult): string => r.content.map((c) => c.text).join('\n')
const tokenOf = (r: ToolResult): string => /"token":"(vg_[0-9a-f]+)"/.exec(textOf(r))![1]
const as = <T>(caller: string, fn: () => Promise<T>): Promise<T> => runWithScope({ tool: 't', caller }, fn)

let realNow: () => number
beforeEach(() => { realNow = Date.now })
afterEach(() => { Date.now = realNow; delete process.env.BEADS_BRIDGE_VOICE_GUARD; delete process.env.BEADS_BRIDGE_VOICE_RULES_TTL_MS })

// ---- rule format --------------------------------------------------------------

describe('glossary rule format', () => {
  it('reads the operator\'s glossary-jgv prose as-is: feed and beat mean bead', () => {
    assert.deepEqual(RULES.map((r) => [r.heard, r.meant, r.source]), [
      ['feed', 'bead', 'glossary-jgv'],
      ['beat', 'bead', 'glossary-jgv'],
    ])
  })
  it('ignores prose, blanks, identity rules; reads a keep: clause', () => {
    const rules = parseMisrecognitions([
      'Some intro.',
      "- 'beat' may mean 'beat'",
      "* 'feed' may also mean 'bead'; keep: status feed, inbox feed",
      '“cheep” may mean “jeep”',
    ].join('\n'), 'g-1')
    assert.deepEqual(rules.map((r) => [r.heard, r.meant, r.keep]), [
      ['feed', 'bead', ['status feed', 'inbox feed']],
      ['cheep', 'jeep', []],
    ])
  })
  it('builds rules from `list --json` output, skipping beads with no description', () => {
    const rules = rulesFromListJson(JSON.stringify([
      { id: 'glossary-jgv', description: GLOSSARY_JGV },
      { id: 'glossary-zzz' },
      { id: 'glossary-new', description: "- 'cue' may mean 'queue'" },
    ]))
    assert.deepEqual(rules.map((r) => `${r.source}:${r.heard}>${r.meant}`), [
      'glossary-jgv:feed>bead', 'glossary-jgv:beat>bead', 'glossary-new:cue>queue',
    ])
    assert.throws(() => rulesFromListJson('{"not":"an array"}'))
  })
})

// ---- detection ----------------------------------------------------------------

describe('detection', () => {
  it('flags the heard word in free-text arguments only', () => {
    const f = findMisrecognitions({ store: 'feed', id: 'feed-1', labels: ['feed'], title: 'Fix the feed', description: 'two beats and a Feed' }, RULES)
    assert.deepEqual(f.map((x) => [x.path, x.heard, x.meant]), [
      ['title', 'feed', 'bead'],
      ['description', 'beats', 'beads'],
      ['description', 'Feed', 'Bead'],
    ], 'argument order, then position in the field')
  })
  it('matches whole words: feedback, feeding, defeat are untouched', () => {
    assert.deepEqual(findMisrecognitions({ title: 'feedback on feeding the defeat' }, RULES), [])
  })
  it('walks nested batches with indexed paths', () => {
    const f = findMisrecognitions({ beads: [{ title: 'ok' }, { title: 'a feed', description: 'x' }] }, RULES)
    assert.deepEqual(f.map((x) => x.path), ['beads[1].title'])
  })
  it('keep: phrases are legitimate "feed" contexts and are not flagged', () => {
    const rules = parseMisrecognitions("- 'feed' may mean 'bead'; keep: status feed, inbox feed", 'g')
    assert.deepEqual(findMisrecognitions({ title: 'Redesign the status feed' }, rules), [])
    assert.deepEqual(findMisrecognitions({ title: 'Inbox  Feed polling' }, rules), [])
    const mixed = findMisrecognitions({ title: 'status feed and a new feed' }, rules)
    assert.equal(mixed.length, 1)
    assert.equal(mixed[0].index, 22)
  })
  it('applySuggestions substitutes only flagged spans and leaves the input untouched', () => {
    const args = { id: 'task-1', text: 'Feeds and the feed, not feedback' }
    const out = applySuggestions(args, findMisrecognitions(args, RULES)) as typeof args
    assert.equal(out.text, 'Beads and the bead, not feedback')
    assert.equal(out.id, 'task-1')
    assert.equal(args.text, 'Feeds and the feed, not feedback')
  })
})

// ---- acceptance 1: clean calls execute in one step ------------------------------

describe('acceptance: clean calls execute in one step', () => {
  it('runs the tool once, untouched, with no pause and no pending record', async () => {
    const h = harness()
    h.reg('bead_create')
    const r = await h.call('bead_create', { store: 'task', title: 'Write the docs', description: 'plain text' })
    assert.equal(h.writes.length, 1)
    assert.deepEqual(h.writes[0].args, { store: 'task', title: 'Write the docs', description: 'plain text' })
    assert.equal(textOf(r), 'receipt for bead_create #1')
  })
  it('an empty glossary never pauses anything', async () => {
    const h = harness([])
    h.reg('bead_comment')
    await h.call('bead_comment', { id: 'task-1', text: 'the feed' })
    assert.equal(h.writes.length, 1)
  })
  it('tools outside the guarded set pass straight through, handler identity intact', () => {
    const h = harness()
    h.reg('bead_show')
    h.reg('query_store')
    assert.equal(h.tools.size, 2)
    assert.ok(h.tools.has('bead_show'))
  })
  it('BEADS_BRIDGE_VOICE_GUARD=off disables the check', async () => {
    const h = harness()
    h.reg('bead_comment')
    process.env.BEADS_BRIDGE_VOICE_GUARD = 'off'
    await h.call('bead_comment', { id: 'task-1', text: 'a feed' })
    assert.equal(h.writes.length, 1)
  })
})

// ---- acceptance 2: 'feed' triggers a pre-execution confirmation -----------------

describe('acceptance: possible misrecognition pauses BEFORE side effects', () => {
  it('returns the proposal, a token and the decision menu; the tool does not run', async () => {
    const h = harness()
    h.reg('bead_create')
    const r = await as('c1', () => h.call('bead_create', { store: 'task', title: 'Triage the inbox feed' }))
    assert.equal(h.writes.length, 0, 'no side effect before confirmation')
    const t = textOf(r)
    assert.match(t, /PAUSED — bead_create was NOT executed; nothing was written/)
    assert.match(t, /title: "feed" may mean "bead" \(glossary-jgv\)/)
    assert.match(t, /voice_confirm \{ token: "vg_[0-9a-f]{12}"/)
    for (const d of ['accept', 'original', 'correct', 'cancel']) assert.match(t, new RegExp(`\\b${d}\\b`))
    assert.ok(!r.isError, 'a pause is not a failure')
    const json = JSON.parse(/voice_guard \(JSON\): (.*)$/m.exec(t)![1])
    assert.equal(json.status, 'needs_confirmation')
    assert.equal(json.findings[0].suggested, 'bead')
  })
  it('surfaces the pending confirmation to the heartbeat/relay tracker, cleared once settled', async () => {
    const h = harness()
    h.reg('bead_comment')
    const r = await as('c-hb', () => h.call('bead_comment', { id: 'task-1', text: 'the feed' }))
    const token = tokenOf(r)
    const row = () => relayStatus.list().find((x) => x.item.id === `voice:${token}`)
    assert.equal(row()?.item.needsVerify, true)
    assert.match(row()!.item.title, /voice check pending \(bead_comment\)/)
    await as('c-hb', () => h.confirm({ token, decision: 'cancel' }, {}))
    assert.equal(row()?.item.needsVerify, false)
    assert.equal(row()?.state, 'done')
  })
})

// ---- acceptance 3: accept / correct / cancel (and keep original) -----------------

describe('acceptance: accept, correct, original and cancel paths', () => {
  async function paused(args: any = { id: 'task-9', text: 'The feed is broken' }) {
    const h = harness()
    h.reg('bead_comment', undefined)
    const r = await as('c1', () => h.call('bead_comment', args))
    return { h, token: tokenOf(r) }
  }
  it('accept runs once with the suggested wording', async () => {
    const { h, token } = await paused()
    const r = await as('c1', () => h.confirm({ token, decision: 'accept' }, {}))
    assert.equal(h.writes.length, 1)
    assert.deepEqual(h.writes[0].args, { id: 'task-9', text: 'The bead is broken' })
    assert.match(textOf(r), /executed bead_comment once \(accept/)
    assert.match(textOf(r), /receipt for bead_comment #1/)
  })
  it('original runs once with the exact original arguments (a real feed is preserved)', async () => {
    const { h, token } = await paused({ id: 'task-9', text: 'The RSS feed is broken' })
    await as('c1', () => h.confirm({ token, decision: 'original' }, {}))
    assert.deepEqual(h.writes.map((w) => w.args), [{ id: 'task-9', text: 'The RSS feed is broken' }])
  })
  it('correct runs once with the caller-supplied arguments', async () => {
    const { h, token } = await paused()
    await as('c1', () => h.confirm({ token, decision: 'correct', arguments: { id: 'task-9', text: 'The beat is broken' } }, {}))
    assert.deepEqual(h.writes.map((w) => w.args), [{ id: 'task-9', text: 'The beat is broken' }])
  })
  it('correct without arguments, or with schema-invalid ones, executes nothing and stays pending', async () => {
    resetVoiceGuard(async () => RULES)
    const tools = new Map<string, Handler>()
    const { server, confirm } = withVoiceGuard({ registerTool: (n: string, _c: unknown, hd: Handler) => void tools.set(n, hd) }, hooks)
    let runs = 0
    const schema = { safeParse: (v: any) => (typeof v?.text === 'string' ? { success: true, data: v } : { success: false, error: { message: 'text: required' } }) }
    server.registerTool('bead_comment', { inputSchema: schema }, async () => { runs++; return hooks.ok('done') })
    const token = tokenOf(await as('c1', () => tools.get('bead_comment')!({ text: 'a feed' }, {})))
    const noArgs = await as('c1', () => confirm({ token, decision: 'correct' }, {}))
    const bad = await as('c1', () => confirm({ token, decision: 'correct', arguments: { nope: 1 } }, {}))
    assert.equal(runs, 0)
    assert.ok(noArgs.isError && bad.isError)
    assert.match(textOf(bad), /invalid for bead_comment.*still pending/s)
    await as('c1', () => confirm({ token, decision: 'correct', arguments: { text: 'a bead' } }, {}))
    assert.equal(runs, 1)
  })
  it('cancel executes nothing and says so', async () => {
    const { h, token } = await paused()
    const r = await as('c1', () => h.confirm({ token, decision: 'cancel' }, {}))
    assert.equal(h.writes.length, 0)
    assert.match(textOf(r), /cancelled .*nothing was written/)
  })
  it('re-sending a cancelled call asks again (the "no" was for that attempt)', async () => {
    const { h, token } = await paused()
    await as('c1', () => h.confirm({ token, decision: 'cancel' }, {}))
    const again = await as('c1', () => h.call('bead_comment', { id: 'task-9', text: 'The feed is broken' }))
    assert.match(textOf(again), /PAUSED/)
    assert.equal(tokenOf(again), token)
  })
  it('a tool error leaves the request confirmable; a later success runs it once', async () => {
    resetVoiceGuard(async () => RULES)
    const tools = new Map<string, Handler>()
    const { server, confirm } = withVoiceGuard({ registerTool: (n: string, _c: unknown, hd: Handler) => void tools.set(n, hd) }, hooks)
    let attempts = 0
    server.registerTool('bead_note', {}, async () => (++attempts === 1 ? hooks.err('store down') : hooks.ok('landed')))
    const token = tokenOf(await as('c1', () => tools.get('bead_note')!({ text: 'a feed' }, {})))
    const first = await as('c1', () => confirm({ token, decision: 'original' }, {}))
    assert.ok(first.isError)
    assert.match(textOf(first), /still pending and can be confirmed again/)
    const second = await as('c1', () => confirm({ token, decision: 'original' }, {}))
    assert.ok(!second.isError)
    assert.equal(attempts, 2)
  })
})

// ---- acceptance 4: no duplicate writes on retry -----------------------------------

describe('acceptance: no duplicate writes on retry', () => {
  it('re-sending the paused call returns the same token, never a second request', async () => {
    const h = harness()
    h.reg('bead_create')
    const args = { store: 'task', title: 'the feed' }
    const a = await as('c1', () => h.call('bead_create', args))
    const b = await as('c1', () => h.call('bead_create', { ...args }))
    assert.equal(tokenOf(a), tokenOf(b))
    assert.equal(h.writes.length, 0)
    const pendingRows = relayStatus.list().filter((x) => x.item.id === `voice:${tokenOf(a)}`)
    assert.equal(pendingRows.length, 1)
  })
  it('a repeated confirm returns the first result and does not write again', async () => {
    const h = harness()
    h.reg('bead_create')
    const token = tokenOf(await as('c1', () => h.call('bead_create', { store: 'task', title: 'the feed' })))
    const first = await as('c1', () => h.confirm({ token, decision: 'accept' }, {}))
    const retry = await as('c1', () => h.confirm({ token, decision: 'accept' }, {}))
    assert.equal(h.writes.length, 1)
    assert.match(textOf(retry), /NOT run again/)
    assert.match(textOf(retry), /receipt for bead_create #1/)
    assert.match(textOf(first), /receipt for bead_create #1/)
  })
  it('simultaneous confirms share one execution', async () => {
    const h = harness()
    h.reg('bead_create')
    const token = tokenOf(await as('c1', () => h.call('bead_create', { store: 'task', title: 'the feed' })))
    await as('c1', () => Promise.all([
      h.confirm({ token, decision: 'accept' }, {}),
      h.confirm({ token, decision: 'accept' }, {}),
      h.confirm({ token, decision: 'accept' }, {}),
    ]))
    assert.equal(h.writes.length, 1)
  })
  it('a different decision after settling is refused, not executed', async () => {
    const h = harness()
    h.reg('bead_create')
    const token = tokenOf(await as('c1', () => h.call('bead_create', { store: 'task', title: 'the feed' })))
    await as('c1', () => h.confirm({ token, decision: 'accept' }, {}))
    const other = await as('c1', () => h.confirm({ token, decision: 'original' }, {}))
    assert.ok(other.isError)
    assert.equal(h.writes.length, 1)
  })
  it('re-sending the original right after it ran is a retry: no re-prompt, no re-run', async () => {
    const h = harness()
    h.reg('bead_create')
    const args = { store: 'task', title: 'the feed' }
    const token = tokenOf(await as('c1', () => h.call('bead_create', args)))
    await as('c1', () => h.confirm({ token, decision: 'original' }, {}))
    const again = await as('c1', () => h.call('bead_create', args))
    assert.equal(h.writes.length, 1)
    assert.match(textOf(again), /NOT run again/)
    // …but long after, the same words are new work and are checked again.
    const t0 = realNow()
    Date.now = () => t0 + RESUBMIT_WINDOW_MS + 1000
    const later = await as('c1', () => h.call('bead_create', args))
    assert.match(textOf(later), /PAUSED/)
    assert.equal(h.writes.length, 1)
  })
  it('tokens are caller-bound: another caller cannot settle them', async () => {
    const h = harness()
    h.reg('bead_create')
    const token = tokenOf(await as('alice', () => h.call('bead_create', { store: 'task', title: 'the feed' })))
    const r = await as('mallory', () => h.confirm({ token, decision: 'original' }, {}))
    assert.ok(r.isError)
    assert.equal(h.writes.length, 0)
    // The same words from a different caller are a separate request.
    const bob = tokenOf(await as('bob', () => h.call('bead_create', { store: 'task', title: 'the feed' })))
    assert.notEqual(bob, token)
  })
  it('unknown and expired tokens execute nothing', async () => {
    const h = harness()
    h.reg('bead_create')
    const unknown = await as('c1', () => h.confirm({ token: 'vg_000000000000', decision: 'original' }, {}))
    assert.ok(unknown.isError)
    const token = tokenOf(await as('c1', () => h.call('bead_create', { store: 'task', title: 'the feed' })))
    const t0 = realNow()
    Date.now = () => t0 + PENDING_TTL_MS + 1000
    const expired = await as('c1', () => h.confirm({ token, decision: 'original' }, {}))
    assert.ok(expired.isError)
    assert.match(textOf(expired), /expired/)
    assert.equal(h.writes.length, 0)
  })
})

// ---- acceptance 5: new glossary entries are picked up ------------------------------

describe('acceptance: newly added glossary misrecognitions are picked up', () => {
  it('a rule added to the glossary is enforced after the cache window, with no code change', async () => {
    let glossary: Misrecognition[] = parseMisrecognitions("- 'feed' may mean 'bead'", 'g-1')
    const h = harness(async () => glossary)
    h.reg('bead_comment')
    const t0 = realNow()
    Date.now = () => t0
    await as('c1', () => h.call('bead_comment', { id: 'task-1', text: 'move the cue along' }))
    assert.equal(h.writes.length, 1, 'unknown word runs')
    glossary = [...glossary, ...parseMisrecognitions("- 'cue' may mean 'queue'", 'g-2')]
    Date.now = () => t0 + 1000 // inside the cache window: old rules still in force
    await as('c1', () => h.call('bead_comment', { id: 'task-1', text: 'move the cue along' }))
    assert.equal(h.writes.length, 2)
    Date.now = () => t0 + 31_000 // past the 30 s window
    const r = await as('c1', () => h.call('bead_comment', { id: 'task-1', text: 'move the cue along' }))
    assert.match(textOf(r), /"cue" may mean "queue" \(g-2\)/)
    assert.equal(h.writes.length, 2)
  })
  it('the cache window is configurable and 0 re-reads every call', async () => {
    process.env.BEADS_BRIDGE_VOICE_RULES_TTL_MS = '0'
    let reads = 0
    resetVoiceGuard(async () => { reads++; return RULES })
    await loadRules(1000)
    await loadRules(1000)
    assert.equal(reads, 2)
  })
  it('concurrent first calls share a single glossary read', async () => {
    let reads = 0
    resetVoiceGuard(async () => { reads++; await new Promise((r) => setTimeout(r, 5)); return RULES })
    await Promise.all([loadRules(), loadRules(), loadRules()])
    assert.equal(reads, 1)
  })
})

// ---- acceptance 6: legitimate 'feed' contexts are preserved -------------------------

describe('acceptance: legitimate "feed" contexts are preserved', () => {
  it('"status feed" is never rewritten unless confirmed, and "original" keeps it byte-for-byte', async () => {
    const h = harness()
    h.reg('bead_create')
    const args = { store: 'task', title: 'Add a status feed', description: 'Show the feed on the dashboard' }
    const r = await as('c1', () => h.call('bead_create', args))
    assert.equal(h.writes.length, 0, 'never silently rewritten, never silently run')
    await as('c1', () => h.confirm({ token: tokenOf(r), decision: 'original' }, {}))
    assert.deepEqual(h.writes[0].args, args)
  })
  it('keep: phrases from the glossary run straight through in one step', async () => {
    const h = harness(parseMisrecognitions("- 'feed' may mean 'bead'; keep: status feed", 'g-1'))
    h.reg('bead_create')
    await h.call('bead_create', { store: 'task', title: 'Add a status feed' })
    assert.equal(h.writes.length, 1)
  })
  it('the stores, ids and labels are never a reason to pause', async () => {
    const h = harness()
    h.reg('bead_create')
    await h.call('bead_create', { store: 'feed', title: 'ok', labels: ['feed'], parent: 'feed-1' })
    assert.equal(h.writes.length, 1)
  })
})

// ---- failure behaviour ----------------------------------------------------------------

describe('fail-open when the glossary cannot be read', () => {
  it('runs the call, and the footer line says it was not checked', async () => {
    const h = harness(async () => { throw new Error('glossary: no beads database found') })
    h.reg('bead_comment')
    await h.call('bead_comment', { id: 'task-1', text: 'a feed' })
    assert.equal(h.writes.length, 1)
    assert.match(voiceFooterLine('bead_comment')!, /glossary rules unavailable \(glossary: no beads database found\).*not checked/)
    assert.equal(voiceFooterLine('bead_show'), null, 'only guarded tools carry the line')
  })
  it('no footer line while the glossary is healthy', async () => {
    const h = harness()
    h.reg('bead_comment')
    await h.call('bead_comment', { id: 'task-1', text: 'clean' })
    assert.equal(voiceFooterLine('bead_comment'), null)
  })
})
