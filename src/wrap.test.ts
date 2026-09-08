import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { wrap } from './wrap'

describe('wrap', () => {
  it('renders title, store/bead meta, and body', () => {
    const out = wrap({ title: 'T', body: 'hello', meta: { store: 'task', id: 'task-1a2' } })
    assert.ok(out.startsWith('# T\n'))
    assert.ok(out.includes('STORE: task'))
    assert.ok(out.includes('BEAD: task-1a2'))
    assert.ok(out.includes('hello'))
  })
  it('adds the paste block only with store+id meta', () => {
    const withMeta = wrap({ title: 'T', body: 'b', meta: { store: 'task', id: 'task-1a2' } })
    assert.ok(withMeta.includes('Paste block'))
    const withoutMeta = wrap({ title: 'T', body: 'b' })
    assert.ok(!withoutMeta.includes('Paste block'))
  })
  it('noNext suppresses the queue footer', () => {
    assert.ok(!wrap({ title: 'T', body: 'b', noNext: true }).includes('next item'))
    assert.ok(wrap({ title: 'T', body: 'b' }).includes('/next?cache='))
  })
  it('lists research links found in the body (with meta)', () => {
    const out = wrap({ title: 'T', body: 'see https://example.com/a', meta: { store: 's', id: 's-1a2' } })
    assert.ok(out.includes('Research links'))
    assert.ok(out.includes('https://example.com/a'))
  })
  it('renders actions under Next', () => {
    const out = wrap({ title: 'T', body: 'b', actions: ['GET /x — y'] })
    assert.ok(out.includes('## Next'))
    assert.ok(out.includes('GET /x — y'))
  })
})
