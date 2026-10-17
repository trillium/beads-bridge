// Unit tests: FUNNEL_BASE=https://example.test bun test src/lib/intent.test.ts
// The implicit-intent create path against an in-memory fake store (no
// subprocesses): overlapping turns, retries after a timeout, partial
// completion, and the rule that distinct tasks stay distinct.
//
// Incident fixture: task-i6nzy / task-p4pu8, created 3 s apart with the same
// title and different bodies (see docs/idempotent-create.md).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createBead, type CreateDeps, type CreateInput } from './create'
import { mergeBody, parseRevisions } from './idempotency'
import {
  IntentRegistry,
  bodiesRelated,
  createIntentBead,
  formatIntentReconciliation,
  intentKey,
  normalizeTitle,
  type IntentDeps,
  type IntentRow,
} from './intent'

const TITLE = 'Verify localStorage support and persistence in Tesla browser'
const TURN1 =
  'Confirm whether the Tesla built-in browser supports the Web Storage API (localStorage), and distinguish confirmed facts from assumptions or anecdotal reports. Find the open-source project that documents saving settings in localStorage, verify it targets the Tesla browser, and report persistence across reload, close/reopen and sleep/wake. Include source links and exact evidence.'
const TURN2 =
  'Confirm empirically whether the Tesla built-in browser supports localStorage for an HTTPS site, and whether stored values persist across reload, close/reopen, sleep/wake. Record vehicle model and software version, test procedure and observed results. Distinguish API availability from durable persistence. Include a minimal safe test page. Do not store passwords or tokens in localStorage.'

interface FakeBead extends IntentRow {
  notes: string[]
  description: string
  labels: string[]
  title: string
  status: string
  created_at: string
}

class FakeStore {
  beads = new Map<string, FakeBead>()
  clock = Date.parse('2026-10-17T06:49:54Z')
  seq = 0
  createCalls = 0
  /** step name -> remaining failures to inject */
  fail: Record<string, number> = {}
  /** Delay (ms of real time) inside create to force overlap. */
  createDelay = 0
  /** Make create commit then throw, like a timeout after the commit. */
  timeoutAfterCommit = 0

  private trip(step: string): void {
    if ((this.fail[step] ?? 0) > 0) {
      this.fail[step]--
      throw new Error(`injected ${step} failure`)
    }
  }

  deps(): IntentDeps {
    return {
      create: async (input: CreateInput) => {
        this.createCalls++
        if (this.createDelay) await new Promise((r) => setTimeout(r, this.createDelay))
        const id = `task-t${++this.seq}`
        this.beads.set(id, {
          id,
          title: input.title,
          description: input.description ?? '',
          labels: [...(input.labels ?? [])],
          status: 'open',
          created_at: new Date(this.clock).toISOString(),
          notes: [],
        })
        if (this.timeoutAfterCommit > 0) {
          this.timeoutAfterCommit--
          throw new Error('create timed out')
        }
        return { id, detail: `shown ${id}`, verified: true }
      },
      findByLabel: async (_s, label) => [...this.beads.values()].filter((b) => b.labels.includes(label)),
      readState: async (_s, id) => {
        const b = this.beads.get(id)
        return b ? { title: b.title, description: b.description, labels: [...b.labels], status: b.status } : { title: '', description: '', labels: [] }
      },
      history: async (_s, id) => parseRevisions((this.beads.get(id)?.notes ?? []).join('\n')),
      edit: async (_s, id, patch) => {
        this.trip('edit')
        const b = this.beads.get(id)!
        if (patch.title !== undefined) b.title = patch.title
        if (patch.description !== undefined) b.description = patch.description
      },
      addLabels: async (_s, id, labels) => {
        this.trip('labels')
        const b = this.beads.get(id)!
        for (const l of labels) if (!b.labels.includes(l)) b.labels.push(l)
      },
      note: async (_s, id, text) => {
        this.trip('note')
        this.beads.get(id)!.notes.push(text)
        return true
      },
      verify: async (_s, id) => (this.beads.has(id) ? `shown ${id}` : null),
      now: () => this.clock,
    }
  }
  advance(ms: number): void {
    this.clock += ms
  }
  open(): FakeBead[] {
    return [...this.beads.values()].filter((b) => b.status === 'open')
  }
}

const ask = (over: Partial<CreateInput & { distinct?: boolean }> = {}) => ({
  store: 'task',
  title: TITLE,
  description: TURN1,
  labels: [],
  provenance: { source: 'mcp' as const, caller: 'loopback-local' },
  ...over,
})

// Registries read the injected clock through the store, so tests that move
// time pass a clock-bound registry too.
const registryFor = (st: FakeStore) => new IntentRegistry(() => st.clock)

describe('intent key and gate primitives', () => {
  it('ignores case/punctuation/whitespace in titles, never the body', () => {
    assert.equal(normalizeTitle('  Verify   LocalStorage, support!  '), 'verify localstorage support')
    const a = intentKey({ store: 'task', caller: 'c', title: TITLE })
    assert.equal(a, intentKey({ store: 'task', caller: 'c', title: TITLE.toUpperCase() + '.' }))
    assert.match(a, /^ikey:[0-9a-f]{12}$/)
  })
  it('separates store, caller and parent', () => {
    const base = { store: 'task', caller: 'c', title: TITLE }
    assert.notEqual(intentKey(base), intentKey({ ...base, store: 'brain' }))
    assert.notEqual(intentKey(base), intentKey({ ...base, caller: 'd' }))
    assert.notEqual(intentKey(base), intentKey({ ...base, parent: 'task-abc' }))
  })
  it('treats the two real incident bodies as related, unrelated prose as not', () => {
    assert.equal(bodiesRelated(TURN1, TURN2), true)
    assert.equal(bodiesRelated(TURN1, 'Renew the quarterly insurance paperwork and email the broker about premiums.'), false)
    assert.equal(bodiesRelated('', 'anything'), true)
    assert.equal(bodiesRelated('short body here', 'short body here and more'), true)
  })
})

describe('the incident: overlapping turns of one request', () => {
  it('two near-simultaneous creates (different bodies) converge on ONE bead', async () => {
    const st = new FakeStore()
    st.createDelay = 25 // the first create is still running when the second arrives
    const reg = registryFor(st)
    const [a, b] = await Promise.all([
      createIntentBead(ask({ description: TURN1 }), st.deps(), reg),
      createIntentBead(ask({ description: TURN2 }), st.deps(), reg),
    ])
    assert.equal(st.createCalls, 1, 'exactly one create reached the store')
    assert.equal(st.beads.size, 1)
    assert.equal(a.id, b.id)
    assert.equal(a.disposition, 'created')
    assert.equal(b.disposition, 'revision')
    const bead = st.beads.get(a.id)!
    assert.ok(bead.description.includes('Web Storage API'), 'first turn kept')
    assert.ok(bead.description.includes('minimal safe test page'), 'follow-up information merged in')
    assert.equal(b.verified, true, 'read-after-write: follow-up landed on the bead')
    assert.deepEqual(parseRevisions(bead.notes.join('\n')).map((r) => [r.seq, r.mode]), [[1, 'create'], [2, 'revision']])
  })

  it('a follow-up after the first finished (3 s later) updates the canonical bead', async () => {
    const st = new FakeStore()
    const reg = registryFor(st)
    const a = await createIntentBead(ask({ description: TURN1 }), st.deps(), reg)
    st.advance(3000)
    const b = await createIntentBead(ask({ description: TURN2 }), st.deps(), reg)
    assert.equal(b.id, a.id)
    assert.equal(st.beads.size, 1)
    assert.match(formatIntentReconciliation(b), /same intent as task-t1/)
  })

  it('five concurrent identical creates are one bead', async () => {
    const st = new FakeStore()
    st.createDelay = 10
    const reg = registryFor(st)
    const rs = await Promise.all(Array.from({ length: 5 }, () => createIntentBead(ask(), st.deps(), reg)))
    assert.equal(new Set(rs.map((r) => r.id)).size, 1)
    assert.equal(st.createCalls, 1)
    assert.equal(rs.filter((r) => r.disposition === 'created').length, 1)
    assert.equal(st.beads.get(rs[0].id)!.description, TURN1, 'identical replays never rewrite the body')
  })

  it('finds the bead through the store ikey label when the registry is cold (restart / other process)', async () => {
    const st = new FakeStore()
    const a = await createIntentBead(ask(), st.deps(), registryFor(st))
    st.advance(5000)
    const b = await createIntentBead(ask({ description: TURN2 }), st.deps(), registryFor(st))
    assert.equal(b.id, a.id)
    assert.equal(st.beads.size, 1)
  })
})

describe('retries', () => {
  it('retry after a timeout that committed converges on the bead that landed', async () => {
    const st = new FakeStore()
    st.timeoutAfterCommit = 1
    const reg = registryFor(st)
    await assert.rejects(createIntentBead(ask(), st.deps(), reg), /timed out/)
    assert.equal(st.beads.size, 1, 'the write landed despite the error')
    st.advance(20_000)
    const retry = await createIntentBead(ask(), st.deps(), reg)
    assert.equal(st.beads.size, 1, 'retry reused it')
    assert.equal(retry.id, 'task-t1')
    assert.equal(st.createCalls, 1)
    assert.equal(retry.disposition, 'duplicate')
  })

  it('retry after a timeout that did NOT commit creates exactly one', async () => {
    const st = new FakeStore()
    const deps = st.deps()
    let first = true
    const flaky: IntentDeps = { ...deps, create: async (i) => { if (first) { first = false; throw new Error('create timed out') } return deps.create(i) } }
    const reg = registryFor(st)
    await assert.rejects(createIntentBead(ask(), flaky, reg), /timed out/)
    await createIntentBead(ask(), flaky, reg)
    assert.equal(st.beads.size, 1)
  })
})

describe('partial completion reconciles', () => {
  it('create ok but revision note fails: reported incomplete, retry converges on the same bead', async () => {
    const st = new FakeStore()
    const reg = registryFor(st)
    st.fail.note = 1
    const a = await createIntentBead(ask(), st.deps(), reg)
    assert.equal(a.disposition, 'created')
    assert.equal(a.incomplete.length, 1)
    assert.match(formatIntentReconciliation({ ...a, disposition: 'created' }), /INCOMPLETE/)
    const b = await createIntentBead(ask(), st.deps(), reg)
    assert.equal(b.id, a.id)
    assert.equal(st.beads.size, 1)
    assert.deepEqual(b.incomplete, [])
    assert.equal(parseRevisions(st.beads.get(a.id)!.notes.join('\n')).length, 1)
  })

  it('follow-up edit lands but label step fails: bead has the body, retry adds the label once', async () => {
    const st = new FakeStore()
    const reg = registryFor(st)
    const a = await createIntentBead(ask({ labels: ['ops'] }), st.deps(), reg)
    st.fail.labels = 1
    const b = await createIntentBead(ask({ description: TURN2, labels: ['ops', 'tesla'] }), st.deps(), reg)
    assert.equal(b.id, a.id)
    assert.equal(b.incomplete.length, 1)
    assert.ok(st.beads.get(a.id)!.description.includes('minimal safe test page'), 'body step still landed')
    assert.ok(!st.beads.get(a.id)!.labels.includes('tesla'))
    const c = await createIntentBead(ask({ description: TURN2, labels: ['ops', 'tesla'] }), st.deps(), reg)
    assert.equal(c.id, a.id)
    assert.deepEqual(c.incomplete, [])
    assert.ok(st.beads.get(a.id)!.labels.includes('tesla'))
    assert.equal(st.beads.size, 1)
    const body = st.beads.get(a.id)!.description
    assert.equal(body.split('minimal safe test page').length - 1, 1, 'retry did not append the follow-up twice')
  })

  it('edit step fails: reported incomplete and unverified, retry repairs it', async () => {
    const st = new FakeStore()
    const reg = registryFor(st)
    const a = await createIntentBead(ask(), st.deps(), reg)
    st.fail.edit = 1
    const b = await createIntentBead(ask({ description: TURN2 }), st.deps(), reg)
    assert.ok(b.incomplete.some((m) => m.includes('edit')))
    assert.equal(b.verified, false, 'read-after-write caught that the follow-up did not land')
    const c = await createIntentBead(ask({ description: TURN2 }), st.deps(), reg)
    assert.equal(c.id, a.id)
    assert.equal(c.verified, true)
    assert.ok(st.beads.get(a.id)!.description.includes('minimal safe test page'))
  })
})

describe('distinct tasks stay distinct', () => {
  it('same title, unrelated body: separate beads', async () => {
    const st = new FakeStore()
    const reg = registryFor(st)
    const a = await createIntentBead(ask(), st.deps(), reg)
    const b = await createIntentBead(ask({ description: 'Renew the quarterly insurance paperwork and email the broker about premiums.' }), st.deps(), reg)
    assert.notEqual(a.id, b.id)
    assert.equal(st.beads.size, 2)
  })
  it('same title and body but beyond the window: separate beads', async () => {
    const st = new FakeStore()
    const reg = registryFor(st)
    const a = await createIntentBead(ask(), st.deps(), reg)
    st.advance(10 * 60 * 1000)
    const b = await createIntentBead(ask(), st.deps(), reg)
    assert.notEqual(a.id, b.id)
  })
  it('predecessor already closed: new bead', async () => {
    const st = new FakeStore()
    const reg = registryFor(st)
    const a = await createIntentBead(ask(), st.deps(), reg)
    st.beads.get(a.id)!.status = 'closed'
    st.advance(1000)
    const b = await createIntentBead(ask(), st.deps(), reg)
    assert.notEqual(a.id, b.id)
  })
  it('different caller, store or parent: separate beads', async () => {
    const st = new FakeStore()
    const reg = registryFor(st)
    const a = await createIntentBead(ask(), st.deps(), reg)
    const other = await createIntentBead(ask({ provenance: { source: 'mcp', caller: 'someone-else' } }), st.deps(), reg)
    const child = await createIntentBead(ask({ parent: 'task-parent' }), st.deps(), reg)
    assert.equal(new Set([a.id, other.id, child.id]).size, 3)
  })
  it('explicit distinct: true forces a separate bead even for a related body', async () => {
    const st = new FakeStore()
    const reg = registryFor(st)
    const a = await createIntentBead(ask(), st.deps(), reg)
    const b = await createIntentBead(ask({ description: TURN2, distinct: true }), st.deps(), reg)
    assert.notEqual(a.id, b.id)
    assert.equal(st.open().length, 2)
  })
})

describe('mergeBody (shared with operation_id revisions)', () => {
  it('is still exported from idempotency.ts and unchanged in behaviour', () => {
    assert.equal(mergeBody('a b c', 'a b c', 2, 'k'), 'a b c')
    assert.equal(mergeBody('x', 'x and more', 2, 'k'), 'x and more')
    assert.match(mergeBody('x', 'y', 2, 'ikey:1'), /\[bb-rev 2 · ikey:1\]\ny$/)
  })
})

// REPRODUCTION of the incident on the pre-existing path (createBead with its
// content-hash ckey). This documents WHY the old detection missed it; if
// createBead ever gains intent awareness this test should be deleted, not
// loosened.
describe('baseline: why the old ckey path made two beads', () => {
  function fakeCli() {
    const rows: { id: string; labels: string[]; created_at: string }[] = []
    let n = 0
    const deps: CreateDeps = {
      now: () => Date.now(),
      exec: async (_store, args) => {
        if (args[0] === 'list') {
          const label = args[args.indexOf('--label') + 1]
          await new Promise((r) => setTimeout(r, 5))
          return JSON.stringify(rows.filter((r) => r.labels.includes(label)))
        }
        if (args[0] === 'create') {
          await new Promise((r) => setTimeout(r, 20))
          const id = `task-bx${++n}`
          rows.push({ id, labels: (args[args.indexOf('-l') + 1] ?? '').split(','), created_at: new Date().toISOString() })
          return `Created ${id}`
        }
        return `shown ${args[1]}`
      },
    }
    return { rows, deps }
  }
  const input = (description: string): CreateInput => ({ store: 'task', title: TITLE, description, labels: [], provenance: { source: 'mcp', caller: 'loopback-local' } })

  it('follow-up with added information hashes to a different ckey -> two beads', async () => {
    const { rows, deps } = fakeCli()
    await createBead(input(TURN1), deps)
    await createBead(input(TURN2), deps)
    assert.equal(rows.length, 2)
    const keys = rows.map((r) => r.labels.find((l) => l.startsWith('ckey:')))
    assert.notEqual(keys[0], keys[1])
  })
  it('two overlapping IDENTICAL creates both miss the lookup (no process lock) -> two beads', async () => {
    const { rows, deps } = fakeCli()
    await Promise.all([createBead(input(TURN1), deps), createBead(input(TURN1), deps)])
    assert.equal(rows.length, 2)
  })
})
