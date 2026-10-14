// Unit tests: bun test src/lib/create.test.ts (node:test, no new deps).
// Pure builders/validators only — no subprocesses, no stores touched.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCreateArgs, parseCreatedId, validateCreateLabels, createBead, createKey, CreateTimeoutError, CreateOutcomeUnknownError, storeErrorText } from './create'

describe('buildCreateArgs', () => {
  it('builds minimal argv', () => {
    assert.deepEqual(buildCreateArgs({ store: 'task', title: 'Fix it' }), ['create', 'Fix it'])
  })
  it('passes a 5,200-char durable report through verbatim (no silent slice)', () => {
    const long = 'x'.repeat(5200)
    assert.deepEqual(
      buildCreateArgs({ store: 'task', title: 'T', description: long }),
      ['create', 'T', '-d', long],
    )
  })
  it('adds description, labels, parent only when present', () => {
    assert.deepEqual(
      buildCreateArgs({ store: 'stories', title: 'T', description: 'D', labels: ['a', 'project:x'], parent: 'stories-abc' }),
      ['create', 'T', '-d', 'D', '-l', 'a,project:x', '--parent', 'stories-abc'],
    )
  })
})

describe('parseCreatedId', () => {
  it('finds the store-prefixed id in prose', () => {
    assert.equal(parseCreatedId('task', 'Created task-9omwr — open'), 'task-9omwr')
  })
  it('returns null only when output holds no bead id at all', () => {
    assert.equal(parseCreatedId('task', 'see nothing id shaped here'), null)
    assert.equal(parseCreatedId('projects', 'created ok'), null)
  })
  it('falls back to the emitted id when the prefix is store-external (assert-)', () => {
    // assertions emits assert-* (wrapper BD_NAME=assert): neither the store
    // name nor its mechanical singular. The CLI is authoritative for its own
    // prefix; createBead's read-back `show` decides ownership (task-d8ipc).
    assert.equal(parseCreatedId('assertions', 'Created assert-0ke — open'), 'assert-0ke')
    assert.equal(parseCreatedId('task', 'see brain-abc12 and nope'), 'brain-abc12')
  })
  it('takes the last id on fallback so a --parent echo never shadows the bead', () => {
    assert.equal(parseCreatedId('assertions', 'parent assert-aaa then Created assert-bbb'), 'assert-bbb')
  })
  it('matches dotted child ids whole, not the parent prefix (task-r11aa)', () => {
    assert.equal(parseCreatedId('task', '✓ Created issue: task-fuk0c.1 — probe child'), 'task-fuk0c.1')
    assert.equal(parseCreatedId('task', '✓ Created issue: task-abc12.1.2 — nested'), 'task-abc12.1.2')
  })
  it('does not swallow trailing non-numeric dot segments', () => {
    assert.equal(parseCreatedId('task', 'see task-abc.5x here'), 'task-abc')
  })
})
describe('parseCreatedId across name != prefix stores (task-d8ipc)', () => {
  it('resolves the real prefix, not the store name', () => {
    assert.equal(parseCreatedId('projects', 'Created project-abc12 — open'), 'project-abc12')
    assert.equal(parseCreatedId('tasks', 'Created task-9omwr — open'), 'task-9omwr')
    assert.equal(parseCreatedId('ideas', 'Created idea-0n8 — open'), 'idea-0n8')
    assert.equal(parseCreatedId('questions', 'Created question-s9l — open'), 'question-s9l')
    assert.equal(parseCreatedId('companies', 'Created companies-7xq — open'), 'companies-7xq')
  })
  it('handles the reported case: hierarchical child in projects (project-s1rf.1.1)', () => {
    assert.equal(parseCreatedId('projects', 'Created project-s1rf.1.1 — child'), 'project-s1rf.1.1')
    assert.equal(parseCreatedId('tasks', '✓ Created issue: task-fuk0c.1 — probe child'), 'task-fuk0c.1')
  })
  it('stays correct when the caller passes an alias (project for projects)', () => {
    assert.equal(parseCreatedId('project', 'Created project-s1rf — open'), 'project-s1rf')
    assert.equal(parseCreatedId('idea', 'Created idea-0n8 — open'), 'idea-0n8')
    assert.equal(parseCreatedId('task', 'Created task-9omwr — open'), 'task-9omwr')
  })
  it('a successful create can never fail receipt parsing: every emitted id parses', () => {
    const cases: Array<[string, string]> = [
      ['projects', 'project-s1rf.1.1'],
      ['projects', 'project-abc12'],
      ['tasks', 'task-9omwr'],
      ['tasks', 'task-fuk0c.1.2'],
      ['ideas', 'idea-0n8'],
      ['assertions', 'assert-0ke'],
      ['questions', 'question-s9l'],
      ['companies', 'companies-7xq'],
      ['brain', 'brain-ow1w'],
      ['inbox', 'inbox-0v94'],
      ['stories', 'stories-x1y'],
    ]
    for (const [store, id] of cases) {
      assert.equal(parseCreatedId(store, `Created ${id}`), id, `${store} emitted ${id}`)
    }
  })
})

describe('validateCreateLabels', () => {
  it('splits good and bad, caps at 10', () => {
    const { ok, bad } = validateCreateLabels(['project:parlay', 'has space', 'a'.repeat(70), 'resume:resumes-zak'])
    assert.deepEqual(ok, ['project:parlay', 'resume:resumes-zak'])
    assert.deepEqual(bad, ['has space', 'a'.repeat(70)])
  })
})

describe('createBead timeout + idempotency', () => {
  const timeoutErr = Object.assign(new Error('Command failed: inbox create x'), { killed: true, signal: 'SIGTERM', code: null, stderr: '' })
  const mk = (handler: (args: string[]) => Promise<string>) => {
    const calls: string[][] = []
    return { calls, deps: { now: () => Date.now(), exec: async (_s: string, a: string[]) => { calls.push(a); return handler(a) } } }
  }

  it('createKey is stable per content and differs by store/title/body', () => {
    const a = createKey({ store: 'inbox', title: 'T', description: 'D' })
    assert.equal(a, createKey({ store: 'INBOX', title: 'T', description: 'D' }))
    assert.notEqual(a, createKey({ store: 'inbox', title: 'T', description: 'E' }))
    assert.notEqual(a, createKey({ store: 'task', title: 'T', description: 'D' }))
  })

  it('stamps the ckey label on create', async () => {
    const { calls, deps } = mk(async (a) => (a[0] === 'list' ? '[]' : a[0] === 'show' ? 'shown' : 'Created inbox-abc1'))
    const r = await createBead({ store: 'inbox', title: 'T' }, deps)
    assert.equal(r.id, 'inbox-abc1')
    const create = calls.find((a) => a[0] === 'create')!
    assert.ok(create[create.indexOf('-l') + 1].startsWith('ckey:'))
  })

  it('timed out but landed: returns the bead instead of an error', async () => {
    let listed = 0
    const { deps } = mk(async (a) => {
      if (a[0] === 'list') return ++listed === 1 ? '[]' : JSON.stringify([{ id: 'inbox-dwgg', created_at: new Date().toISOString() }])
      if (a[0] === 'create') throw timeoutErr
      return 'shown'
    })
    const r = await createBead({ store: 'inbox', title: 'T' }, deps)
    assert.equal(r.id, 'inbox-dwgg')
    assert.equal(r.reused, true)
  })

  it('timed out and not found: explicit timeout error, not a plain failure', async () => {
    const { deps } = mk(async (a) => {
      if (a[0] === 'list') return '[]'
      throw timeoutErr
    })
    await assert.rejects(createBead({ store: 'inbox', title: 'T' }, deps), (e: Error) => {
      assert.ok(e instanceof CreateTimeoutError)
      assert.match(e.message, /timed out after 75s/)
      assert.match(e.message, /may still commit/)
      assert.ok(!e.message.includes('Command failed'))
      return true
    })
  })

  it('retry reuses an existing keyed bead and never calls create', async () => {
    const { calls, deps } = mk(async (a) => (a[0] === 'list' ? JSON.stringify([{ id: 'inbox-t0a3', created_at: new Date().toISOString() }]) : 'shown'))
    const r = await createBead({ store: 'inbox', title: 'T' }, deps)
    assert.equal(r.id, 'inbox-t0a3')
    assert.ok(!calls.some((a) => a[0] === 'create'))
  })

  it('a real (non-timeout) failure still throws its own message', async () => {
    const { deps } = mk(async (a) => { if (a[0] === 'list') return '[]'; throw Object.assign(new Error('boom'), { stdout: '' }) })
    await assert.rejects(createBead({ store: 'inbox', title: 'T' }, deps), /boom/)
  })

  it('opkey callers skip the default key', async () => {
    const { calls, deps } = mk(async (a) => (a[0] === 'show' ? 's' : 'Created inbox-zzz1'))
    await createBead({ store: 'inbox', title: 'T', labels: ['opkey:abc'] }, deps)
    assert.ok(!calls.some((a) => a[0] === 'list'))
  })
})

// Incident 2026-10-06 07:09:58Z (idea-tnz8): bd printed
// "failed to open database: schema skew check: context canceled" and exited
// non-zero. Not a timeout kill from the bridge, yet the bead had landed.
describe('createBead store-side canceled context', () => {
  const CANCELED = 'Error: failed to open database: schema skew check: context canceled'
  const canceledErr = () =>
    Object.assign(new Error(`Command failed: ideas create SECRET BODY -d more\n${CANCELED}`), { killed: false, signal: null, code: 1, stderr: `${CANCELED}\n`, stdout: '' })
  const mk = (handler: (args: string[], n: number) => Promise<string>) => {
    const calls: string[][] = []
    const sleeps: number[] = []
    return {
      calls,
      sleeps,
      deps: {
        now: () => Date.now(),
        sleep: async (ms: number) => { sleeps.push(ms) },
        exec: async (_s: string, a: string[]) => { calls.push(a); return handler(a, calls.length) },
      },
    }
  }

  it('canceled create that landed: returns the bead with a recovery note, not an error', async () => {
    let listed = 0
    const { deps } = mk(async (a) => {
      if (a[0] === 'list') return ++listed === 1 ? '[]' : JSON.stringify([{ id: 'idea-tnz8', created_at: new Date().toISOString() }])
      if (a[0] === 'create') throw canceledErr()
      return 'shown idea-tnz8'
    })
    const r = await createBead({ store: 'ideas', title: 'T' }, deps)
    assert.equal(r.id, 'idea-tnz8')
    assert.equal(r.verified, true)
    assert.equal(r.reused, true)
    assert.match(r.recovered ?? '', /context canceled/)
    assert.match(r.recovered ?? '', /bead landed/)
  })

  it('lookup that fails while the store is flapping is retried, not read as "absent"', async () => {
    let listed = 0
    const { deps, sleeps } = mk(async (a) => {
      if (a[0] === 'list') {
        listed++
        if (listed === 1) return '[]' // pre-create dedupe
        if (listed === 2) throw canceledErr() // store still flapping
        return JSON.stringify([{ id: 'idea-tnz8', created_at: new Date().toISOString() }])
      }
      if (a[0] === 'create') throw canceledErr()
      return 'shown'
    })
    const r = await createBead({ store: 'ideas', title: 'T' }, deps)
    assert.equal(r.id, 'idea-tnz8')
    assert.deepEqual(sleeps, [1000])
  })

  it('canceled create that did not land: clear error naming the cause and that it is safe to retry', async () => {
    const { deps } = mk(async (a) => {
      if (a[0] === 'list') return '[]'
      throw canceledErr()
    })
    await assert.rejects(createBead({ store: 'ideas', title: 'T' }, deps), (e: Error) => {
      assert.ok(e instanceof CreateOutcomeUnknownError)
      assert.match(e.message, /schema skew check: context canceled/)
      assert.match(e.message, /did not land/)
      assert.match(e.message, /Retrying the identical create is safe/)
      assert.ok(!e.message.includes('SECRET BODY'), 'never echoes the create argv')
      return true
    })
  })

  it('canceled create and the store cannot be asked: says the bead may have landed and how to check', async () => {
    const { deps, sleeps } = mk(async (a) => {
      if (a[0] === 'list' && a.includes('--label')) throw canceledErr()
      throw canceledErr()
    })
    await assert.rejects(createBead({ store: 'ideas', title: 'T' }, deps), (e: Error) => {
      assert.ok(e instanceof CreateOutcomeUnknownError)
      assert.match(e.message, /may have: look in ideas for label ckey:/)
      return true
    })
    assert.deepEqual(sleeps, [1000, 2000])
  })

  it('opkey callers recover by their opkey label', async () => {
    const { calls, deps } = mk(async (a) => {
      if (a[0] === 'create') throw canceledErr()
      if (a[0] === 'list') return JSON.stringify([{ id: 'idea-op01', created_at: new Date().toISOString() }])
      return 'shown'
    })
    const r = await createBead({ store: 'ideas', title: 'T', labels: ['opkey:abc'] }, deps)
    assert.equal(r.id, 'idea-op01')
    const list = calls.find((a) => a[0] === 'list')!
    assert.equal(list[list.indexOf('--label') + 1], 'opkey:abc')
  })

  it('a non-transient failure is not retried or masked', async () => {
    const { calls, deps } = mk(async (a) => {
      if (a[0] === 'list') return '[]'
      throw Object.assign(new Error('Command failed: ideas create x'), { stderr: 'Error: validation failed: title too long', stdout: '' })
    })
    await assert.rejects(createBead({ store: 'ideas', title: 'T' }, deps), (e: Error) => {
      assert.ok(!(e instanceof CreateOutcomeUnknownError))
      assert.equal(e.message, 'Error: validation failed: title too long')
      return true
    })
    assert.equal(calls.filter((a) => a[0] === 'list').length, 1)
  })

  it('read-back retries once when show hits the same flap', async () => {
    let shows = 0
    const { deps } = mk(async (a) => {
      if (a[0] === 'list') return '[]'
      if (a[0] === 'create') return 'Created idea-abc1'
      if (++shows === 1) throw canceledErr()
      return 'shown'
    })
    const r = await createBead({ store: 'ideas', title: 'T' }, deps)
    assert.equal(r.verified, true)
  })

  it('storeErrorText drops the "Command failed: <argv>" header', () => {
    assert.equal(storeErrorText('ideas', 'create', Object.assign(new Error('Command failed: ideas create BODY\nboom'), {})), 'boom')
    assert.equal(storeErrorText('ideas', 'create', new Error('Command failed: ideas create BODY')), 'ideas create exited with an error')
  })
})
