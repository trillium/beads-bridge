// Unit tests: bun test src/lib/store-aliases.test.ts (node:test, no new deps).
// Federated store-name aliases (task-4lb3r): singular/plural both
// directions, unknown refusal, ambiguity with candidates, id prefixes.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aliasesForStore,
  ambiguousBeadIdError,
  ambiguousStoreError,
  resolveBeadStore,
  resolveStoreName,
  unknownStoreError,
} from './store-aliases'
import { pickStores } from './random'
import { pickRetrievalStores } from './retrieval'
import { STORES } from '../config'

// Mirror of the live registry shape (hermetic — no registry dependency).
const STORES_LIKE = [
  'applications', 'companies', 'decisions', 'ideas', 'inbox', 'person',
  'projects', 'questions', 'resume_bullets', 'resumes', 'review', 'staleness',
  'stories', 'task', 'workflows', 'brain',
]

describe('aliasesForStore', () => {
  it('strips/adds trailing -s', () => {
    assert.deepEqual(aliasesForStore('ideas'), ['idea'])
    assert.deepEqual(aliasesForStore('projects'), ['project'])
    assert.deepEqual(aliasesForStore('task'), ['tasks'])
    assert.deepEqual(aliasesForStore('brain'), ['brains'])
  })
  it('handles -ies/-y both directions', () => {
    assert.deepEqual(aliasesForStore('stories'), ['story'])
    assert.deepEqual(aliasesForStore('companies'), ['company'])
  })
  it('handles -es for s/x/z/ch/sh stems', () => {
    assert.deepEqual(aliasesForStore('inbox'), ['inboxes'])
  })
  // task-7pqcz: the mapping used to be one-way — the singular of a REGISTERED
  // -es plural did not resolve. Both directions are now derived from the same
  // word, so a store registered as `inboxes` accepts `inbox`.
  it('resolves a registered -es plural back to its singular (task-7pqcz)', () => {
    assert.ok(aliasesForStore('inboxes').includes('inbox'), 'inboxes -> inbox')
    assert.ok(aliasesForStore('batches').includes('batch'), 'batches -> batch')
    assert.ok(aliasesForStore('dishes').includes('dish'), 'dishes -> dish')
  })
  it('carries both readings when -es and trailing -s disagree', () => {
    // `cases` is the +s plural of the word `case` AND the +es plural of the
    // non-word `cas`; `boxes` likewise. The registry decides which reading
    // exists (exact wins; two claimants fail loudly as ambiguous) — the rule
    // never guesses which spelling is the real word.
    assert.deepEqual(aliasesForStore('cases').sort(), ['cas', 'case'])
    assert.deepEqual(aliasesForStore('boxes').sort(), ['box', 'boxe'])
  })
  it('is symmetric: every documented pair resolves both ways (task-7pqcz)', () => {
    const PAIRS: ReadonlyArray<readonly [string, string]> = [
      ['ideas', 'idea'], ['projects', 'project'], ['stories', 'story'],
      ['companies', 'company'], ['task', 'tasks'], ['brain', 'brains'],
      ['inbox', 'inboxes'], ['batch', 'batches'], ['box', 'boxes'],
      ['dish', 'dishes'], ['case', 'cases'], ['resumes', 'resume'],
    ]
    for (const [a, b] of PAIRS) {
      assert.ok(aliasesForStore(a).includes(b), `${a} must alias ${b}`)
      assert.ok(aliasesForStore(b).includes(a), `${b} must alias ${a}`)
    }
  })
  it('gives mass nouns ending in -ss no alias', () => {
    assert.deepEqual(aliasesForStore('staleness'), [])
  })
  it('leaves a trailing-s SINGULAR to its mechanical -s reading only', () => {
    // `status` is a singular that ends in -s; the rule cannot tell it from
    // `ideas` (both vowel+s), so it keeps the trailing-s reading and never
    // invents `statuses` (inventing that would also invent `ideases`).
    assert.deepEqual(aliasesForStore('status'), ['statu'])
    assert.ok(!aliasesForStore('status').includes('statuses'))
  })
  it('never crosses separators', () => {
    assert.ok(!aliasesForStore('resume_bullets').includes('resume-bullets'))
  })
})

describe('resolveStoreName', () => {
  it('resolves singular requests to plural stores', () => {
    for (const [req, want] of [
      ['idea', 'ideas'], ['project', 'projects'], ['story', 'stories'],
      ['company', 'companies'], ['resume', 'resumes'], ['question', 'questions'],
      ['decision', 'decisions'], ['application', 'applications'], ['workflow', 'workflows'],
    ] as const) {
      const r = resolveStoreName(req, STORES_LIKE)
      assert.equal(r.kind, 'alias', req)
      assert.equal((r as { store: string }).store, want, req)
    }
  })
  it('resolves plural requests to singular stores', () => {
    for (const [req, want] of [
      ['tasks', 'task'], ['brains', 'brain'], ['persons', 'person'],
      ['inboxes', 'inbox'], ['reviews', 'review'],
    ] as const) {
      const r = resolveStoreName(req, STORES_LIKE)
      assert.equal(r.kind, 'alias', req)
      assert.equal((r as { store: string }).store, want, req)
    }
  })
  // task-7pqcz: singular-in/plural-registered and plural-in/singular-registered
  // for the SAME store — both spellings name one store, so both must resolve.
  it('accepts either direction for a store registered as a plural (task-7pqcz)', () => {
    for (const [req, want] of [
      ['idea', 'ideas'], ['inbox', 'inboxes'], ['batch', 'batches'],
      ['box', 'boxes'], ['story', 'stories'],
    ] as const) {
      const r = resolveStoreName(req, [want])
      assert.deepEqual(r, { kind: 'alias', store: want, requested: req }, `${req} -> ${want}`)
    }
  })
  it('accepts either direction for a store registered as a singular (task-7pqcz)', () => {
    for (const [req, want] of [
      ['ideas', 'idea'], ['inboxes', 'inbox'], ['boxes', 'box'],
      ['batches', 'batch'], ['tasks', 'task'], ['brains', 'brain'],
    ] as const) {
      const r = resolveStoreName(req, [want])
      assert.deepEqual(r, { kind: 'alias', store: want, requested: req }, `${req} -> ${want}`)
    }
  })
  it('prefers exact matches and trims/case-folds', () => {
    assert.deepEqual(resolveStoreName('ideas', STORES_LIKE), { kind: 'exact', store: 'ideas' })
    assert.deepEqual(resolveStoreName('  IDEA ', STORES_LIKE), {
      kind: 'alias', store: 'ideas', requested: 'IDEA',
    })
    // resume_bullets is exact even though 'resume' aliases 'resumes'
    assert.deepEqual(resolveStoreName('resume_bullets', STORES_LIKE), {
      kind: 'exact', store: 'resume_bullets',
    })
  })
  it('refuses unknown names with the known list, never guessing', () => {
    const r = resolveStoreName('nope', STORES_LIKE)
    assert.equal(r.kind, 'unknown')
    const msg = unknownStoreError('nope', STORES_LIKE)
    assert.match(msg, /unknown store: nope/)
    assert.match(msg, /never guessed/)
    // separators are significant — no cross-separator guess
    assert.equal(resolveStoreName('nightshift_tasks', ['nightshift-tasks']).kind, 'unknown')
    assert.equal(resolveStoreName('', STORES_LIKE).kind, 'unknown')
    // a near miss stays a clean failure in both directions (no fuzzy match)
    assert.equal(resolveStoreName('ideaas', ['ideas']).kind, 'unknown')
    assert.equal(resolveStoreName('inboxez', ['inbox']).kind, 'unknown')
    assert.equal(resolveStoreName('inboxes', ['idea']).kind, 'unknown')
  })
  it('fails loudly on ambiguity, naming candidates', () => {
    // 'boxes' is the +es plural of both 'box' and 'boxe', exact of neither
    const r = resolveStoreName('boxes', ['box', 'boxe'])
    assert.deepEqual(r, { kind: 'ambiguous', requested: 'boxes', candidates: ['box', 'boxe'] })
    assert.match(ambiguousStoreError('boxes', ['box', 'boxe']), /candidates: box, boxe/)
  })
  it('exact always wins over alias, so coexisting spellings never clash', () => {
    assert.deepEqual(resolveStoreName('boxes', ['box', 'boxes']), { kind: 'exact', store: 'boxes' })
    assert.deepEqual(resolveStoreName('box', ['box', 'boxes']), { kind: 'exact', store: 'box' })
  })
})

describe('resolveBeadStore', () => {
  it('resolves id prefixes in either spelling', () => {
    assert.deepEqual(resolveBeadStore('idea-a1b', STORES_LIKE), { kind: 'ok', store: 'ideas', viaAlias: true })
    assert.deepEqual(resolveBeadStore('ideas-a1b', STORES_LIKE), { kind: 'ok', store: 'ideas', viaAlias: false })
    assert.deepEqual(resolveBeadStore('project-u0v', STORES_LIKE), { kind: 'ok', store: 'projects', viaAlias: true })
    assert.deepEqual(resolveBeadStore('tasks-9x1', STORES_LIKE), { kind: 'ok', store: 'task', viaAlias: true })
    assert.deepEqual(resolveBeadStore('task-9x1.2', STORES_LIKE), { kind: 'ok', store: 'task', viaAlias: false })
  })
  it('reports unknown and ambiguous prefixes distinctly', () => {
    assert.deepEqual(resolveBeadStore('nope-123', STORES_LIKE), { kind: 'unknown', prefix: 'nope' })
    assert.deepEqual(resolveBeadStore('nodash', STORES_LIKE), { kind: 'unknown', prefix: '' })
    assert.deepEqual(resolveBeadStore('boxes-1', ['box', 'boxe']), {
      kind: 'ambiguous', prefix: 'boxes', candidates: ['box', 'boxe'],
    })
    assert.match(ambiguousBeadIdError('boxes-1', 'boxes', ['box', 'boxe']), /matches box, boxe/)
  })
})

describe('integrations', () => {
  it('pickStores resolves aliases and keeps unknown/ambiguous errors', () => {
    assert.deepEqual(pickStores('idea', STORES_LIKE), ['ideas'])
    assert.deepEqual(pickStores('tasks', STORES_LIKE), ['task'])
    assert.deepEqual(pickStores(undefined, STORES_LIKE), ['task', 'stories', 'resume_bullets', 'inbox', 'workflows'])
    const bad = pickStores('nope', STORES_LIKE) as { error: string }
    assert.match(bad.error, /unknown store: nope/)
    const amb = pickStores('boxes', ['box', 'boxe']) as { error: string }
    assert.match(amb.error, /ambiguous store name: boxes \(candidates: box, boxe\)/)
  })
  it('pickRetrievalStores resolves aliases, annotating ambiguous entries', () => {
    const r = pickRetrievalStores(['idea', 'tasks', 'nope'], STORES_LIKE)
    assert.deepEqual(r.stores, ['ideas', 'task'])
    assert.deepEqual(r.unknown, ['nope'])
    const amb = pickRetrievalStores(['boxes'], ['box', 'boxe'])
    assert.deepEqual(amb.stores, [])
    assert.deepEqual(amb.unknown, ['boxes (ambiguous: box, boxe)'])
  })
  it('live registry resolves the headline pairs', () => {
    for (const s of ['ideas', 'projects', 'task', 'stories']) {
      assert.ok(STORES.includes(s), `live registry lacks ${s}`)
    }
    assert.equal(resolveStoreName('idea').kind, 'alias')
    assert.equal(resolveStoreName('tasks').kind, 'alias')
    const r = resolveBeadStore('idea-x1')
    assert.equal(r.kind, 'ok')
  })
  // task-7pqcz guard: the bidirectional rule must not make a live registry
  // name ambiguous, and every live alias must point back at its own store.
  it('live registry: every registered store and every one of its spellings resolves (task-7pqcz)', () => {
    for (const s of STORES) {
      assert.deepEqual(resolveStoreName(s), { kind: 'exact', store: s }, s)
      for (const alias of aliasesForStore(s)) {
        const r = resolveStoreName(alias)
        assert.ok(r.kind === 'alias' || r.kind === 'exact', `${alias} must resolve, got ${r.kind}`)
        assert.equal((r as { store: string }).store, s, `${alias} must resolve to ${s}`)
      }
    }
  })
})
