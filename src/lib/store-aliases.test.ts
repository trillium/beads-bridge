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
  it('gives mass nouns ending in -ss no alias', () => {
    assert.deepEqual(aliasesForStore('staleness'), [])
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
})
