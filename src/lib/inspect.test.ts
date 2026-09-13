import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inspectTree, inspectSearch, inspectRead, inspectReadMany } from './inspect'

describe('inspectTree', () => {
  it('lists Bridge sources, skips node_modules and .git', () => {
    const out = inspectTree('.', 2, 200)
    assert.match(out, /src\/lib\/inspect\.ts/)
    assert.doesNotMatch(out, /node_modules/)
  })
  it('denies escape from the checkout', () => {
    assert.match(inspectTree('../..', 1), /denied/)
  })
})

describe('inspectSearch', () => {
  it('finds a known string in sources', () => {
    const out = inspectSearch('inspectTree', 'src/lib', 10)
    assert.match(out, /inspect\.ts:\d+:/)
  })
  it('reports no match cleanly', () => {
    assert.match(inspectSearch('zzz-no-such-token-zzz', 'src/lib', 5), /no match/)
  })
  it('rejects empty patterns', () => {
    assert.match(inspectSearch('   '), /denied/)
  })
})

describe('inspectRead', () => {
  it('reads a source file with line paging', () => {
    const out = inspectRead('package.json', 1, 10)
    assert.match(out, /# inspect read — package\.json/)
  })
  it('denies traversal, logs, and locks', () => {
    assert.match(inspectRead('../../etc/passwd'), /denied/)
    assert.match(inspectRead('debug.log'), /denied/)
    assert.match(inspectRead('bun.lock'), /denied/)
  })
  it('reports missing files', () => {
    assert.match(inspectRead('src/lib/nope-missing.ts'), /missing/)
  })
})

describe('inspectReadMany', () => {
  it('reads several files with per-file headers', () => {
    const out = inspectReadMany(['package.json', 'src/lib/inspect.ts'])
    assert.match(out, /# inspect read-many \(2 files\)/)
    assert.match(out, /## package\.json/)
  })
  it('denies traversal per file but still reads the valid ones', () => {
    const out = inspectReadMany(['../../etc/passwd', 'package.json'])
    assert.match(out, /denied \(escapes the Bridge checkout\)/)
    assert.match(out, /## package\.json/)
  })
  it('caps file count and rejects empties', () => {
    assert.match(inspectReadMany([]), /denied/)
    const many = ['package.json', 'package.json', 'package.json', 'package.json', 'package.json', 'package.json', 'package.json']
    assert.match(inspectReadMany(many), /# inspect read-many \(5 files\)/)
  })
})
