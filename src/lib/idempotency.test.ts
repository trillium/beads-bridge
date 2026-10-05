// Unit tests: bun test src/lib/idempotency.test.ts
// Pure revision algebra only — no subprocesses, no stores touched.
// The live round-trip (real store, real incidents) is idempotency-live.test.ts.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPKEY_PREFIX,
  childOperationKey,
  contentHash,
  formatReconciliation,
  mergeLabels,
  nextSeq,
  normalizeOperationId,
  operationKey,
  orderRevisions,
  parseRevisions,
  renderRevision,
  withOperationKey,
  withOperationLock,
  type Revision,
} from './idempotency'

describe('normalizeOperationId', () => {
  it('keeps a client id, trimmed', () => {
    assert.equal(normalizeOperationId('  mac-mini-provision-2026-10-05  '), 'mac-mini-provision-2026-10-05')
  })
  it('treats absent/blank/non-string as no logical id (single-create floor)', () => {
    assert.equal(normalizeOperationId(undefined), null)
    assert.equal(normalizeOperationId('   '), null)
    assert.equal(normalizeOperationId(42), null)
  })
  it('bounds an absurd id rather than hashing a megabyte', () => {
    assert.equal(normalizeOperationId('x'.repeat(5000))!.length, 200)
  })
})

describe('operationKey', () => {
  it('is deterministic and label-shaped', () => {
    const k = operationKey('task', 'mac-mini-provision')
    assert.match(k, new RegExp(`^${OPKEY_PREFIX}[0-9a-f]{12}$`))
    assert.equal(k, operationKey('task', 'mac-mini-provision'))
  })
  it('never leaks the raw client id into the key', () => {
    assert.ok(!operationKey('task', 'secret-tenant-token-abc').includes('secret'))
  })
  it('scopes by store: same client id, two stores, two operations', () => {
    assert.notEqual(operationKey('task', 'op-1'), operationKey('inbox', 'op-1'))
  })
  it('is case/whitespace stable on the store half', () => {
    assert.equal(operationKey(' Task ', 'op-1'), operationKey('task', 'op-1'))
  })
  it('different logical ids do not collide', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `op-${i}`)
    assert.equal(new Set(ids.map((id) => operationKey('task', id))).size, 500)
  })
  it('derives a per-revision child key under the parent key', () => {
    const parent = operationKey('task', 'op-1')
    assert.equal(childOperationKey(parent, 3), `${parent}.r3`)
  })
})

describe('contentHash', () => {
  it('ignores label order and label duplication', () => {
    const a = contentHash({ title: 'T', labels: ['b', 'a'] })
    const b = contentHash({ title: 'T', labels: ['a', 'b', 'a'] })
    assert.equal(a, b)
  })
  it('normalizes title whitespace (a re-stated title is the same submission)', () => {
    assert.equal(contentHash({ title: 'Provision   mini' }), contentHash({ title: ' Provision mini ' }))
  })
  it('treats a byte-different body as a DIFFERENT submission', () => {
    assert.notEqual(contentHash({ description: 'provision mac mini' }), contentHash({ description: 'provision mac mini 2' }))
  })
  it('changes when the body, title, labels, or parent change', () => {
    const base = contentHash({ title: 'T', description: 'd', labels: ['a'], parent: 'task-1' })
    assert.notEqual(base, contentHash({ title: 'T2', description: 'd', labels: ['a'], parent: 'task-1' }))
    assert.notEqual(base, contentHash({ title: 'T', description: 'd2', labels: ['a'], parent: 'task-1' }))
    assert.notEqual(base, contentHash({ title: 'T', description: 'd', labels: ['z'], parent: 'task-1' }))
    assert.notEqual(base, contentHash({ title: 'T', description: 'd', labels: ['a'], parent: 'task-2' }))
  })
})

describe('withOperationKey', () => {
  it('leaves labels untouched when there is no logical id', () => {
    assert.deepEqual(withOperationKey(['a', 'b'], undefined), ['a', 'b'])
  })
  it('puts the key FIRST so the MAX_LABELS cap can never drop it', () => {
    const k = operationKey('task', 'op-1')
    assert.deepEqual(withOperationKey(['a'], k), [k, 'a'])
  })
  it('does not duplicate a key the caller already supplied', () => {
    const k = operationKey('task', 'op-1')
    assert.deepEqual(withOperationKey([k, 'a'], k), [k, 'a'])
  })
})

describe('mergeLabels', () => {
  it('is additive: union, caller order preserved, nothing dropped', () => {
    assert.deepEqual(mergeLabels(['keep', 'a'], ['a', 'new']), ['keep', 'a', 'new'])
  })
  it('an empty incoming set never retracts', () => {
    assert.deepEqual(mergeLabels(['a'], []), ['a'])
  })
})

describe('revision envelopes', () => {
  const rev: Revision = {
    seq: 2,
    hash: 'abcdef0123456789',
    mode: 'revision',
    at: '2026-10-05T19:20:19Z',
    operationKey: operationKey('task', 'op-1'),
    payload: { title: 'Provision mac mini', description: 'also install tailscale', labels: ['urgent'], applied: ['body merged additively'] },
  }
  it('round-trips through render/parse', () => {
    const parsed = parseRevisions(renderRevision(rev))
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].seq, 2)
    assert.equal(parsed[0].hash, 'abcdef0123456789')
    assert.equal(parsed[0].mode, 'revision')
    assert.equal(parsed[0].operationKey, rev.operationKey)
    assert.deepEqual(parsed[0].payload, rev.payload)
  })
  it('reads every envelope out of a notes blob holding other notes too', () => {
    const blob = ['human note, unrelated', renderRevision({ ...rev, seq: 1 }), renderRevision(rev)].join('\n')
    assert.deepEqual(parseRevisions(blob).map((r) => r.seq), [1, 2])
  })
  it('degrades to no revisions on junk rather than throwing', () => {
    assert.deepEqual(parseRevisions(''), [])
    assert.deepEqual(parseRevisions('[bb-rev] seq=x hash=zz'), [])
    assert.deepEqual(parseRevisions('[bb-rev] seq=1 hash=aa mode=create op=k\n{not json'), [])
  })
  it('survives a description containing braces, quotes, and newlines', () => {
    const gnarly = 'line one {"a": 1}\nline two "quoted" \\ backslash'
    const parsed = parseRevisions(renderRevision({ ...rev, payload: { description: gnarly } }))
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].payload.description, gnarly)
  })
})

describe('ordering rule', () => {
  const mk = (seq: number, hash: string, at: string): Revision => ({ seq, hash, mode: 'revision', at, operationKey: 'opkey:x', payload: {} })
  it('orders by sequence number, NOT by arrival time', () => {
    const ordered = orderRevisions([mk(2, 'bbb', '2026-10-05T19:00:00Z'), mk(1, 'aaa', '2026-10-05T23:59:59Z')])
    assert.deepEqual(ordered.map((r) => r.seq), [1, 2])
  })
  it('breaks a sequence tie on content hash — a total, replay-invariant order', () => {
    const ordered = orderRevisions([mk(1, 'ffff', ''), mk(1, '0000', '')])
    assert.deepEqual(ordered.map((r) => r.hash), ['0000', 'ffff'])
    assert.deepEqual(orderRevisions(ordered), ordered)
  })
  it('nextSeq continues durable numbering after a restart (max+1, never reused)', () => {
    assert.equal(nextSeq([]), 1)
    assert.equal(nextSeq([mk(1, 'a', ''), mk(7, 'b', ''), mk(3, 'c', '')]), 8)
  })
})

describe('withOperationLock', () => {
  it('serializes concurrent submissions of ONE operation (no interleaved create)', async () => {
    const events: string[] = []
    let live = 0
    const body = async (tag: string) => {
      live++
      assert.equal(live, 1, 'two submissions of one operation ran concurrently')
      events.push(`enter:${tag}`)
      await new Promise((r) => setTimeout(r, 5))
      events.push(`exit:${tag}`)
      live--
      return tag
    }
    const results = await Promise.all([
      withOperationLock('task opkey:x', () => body('a')),
      withOperationLock('task opkey:x', () => body('b')),
    ])
    assert.deepEqual(results, ['a', 'b'])
    assert.deepEqual(events, ['enter:a', 'exit:a', 'enter:b', 'exit:b'])
  })
  it('does not let a rejected holder poison the queue', async () => {
    await assert.rejects(withOperationLock('task opkey:y', async () => {
      throw new Error('boom')
    }))
    assert.equal(await withOperationLock('task opkey:y', async () => 'ran anyway'), 'ran anyway')
  })
  it('does not serialize unrelated operations', async () => {
    const order: string[] = []
    await Promise.all([
      withOperationLock('task opkey:a', async () => {
        order.push('a-in')
        await new Promise((r) => setTimeout(r, 10))
        order.push('a-out')
      }),
      withOperationLock('task opkey:b', async () => {
        order.push('b-in')
        order.push('b-out')
      }),
    ])
    assert.deepEqual(order, ['a-in', 'b-in', 'b-out', 'a-out'])
  })
})

describe('formatReconciliation', () => {
  it('tells the caller WHY there is no new bead', () => {
    const out = formatReconciliation({
      disposition: 'revision',
      id: 'task-abc12',
      operationKey: 'opkey:aaaabbbbcccc',
      revision: 2,
      applied: ['body merged additively'],
    })
    assert.match(out, /opkey:aaaabbbbcccc/)
    assert.match(out, /no duplicate created/)
    assert.match(out, /body merged additively/)
  })
  it('names the promoted child', () => {
    const out = formatReconciliation({
      disposition: 'promoted',
      id: 'task-abc12',
      operationKey: 'opkey:aaaabbbbcccc',
      revision: 3,
      applied: ['promoted added scope to child bead task-def45'],
      childId: 'task-def45',
    })
    assert.match(out, /Promoted child: task-def45/)
  })
})