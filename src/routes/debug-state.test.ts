import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { debugBlock, withDebug, failureDebug } from './debug-state'

const req = (debug: boolean) => ({ query: debug ? { debug: '1' } : {} })

describe('withDebug', () => {
  it('leaves healthy pages alone without ?debug', () => {
    assert.equal(withDebug(req(false), 'body'), 'body')
  })
  it('appends the protocol with ?debug=1', () => {
    assert.ok(withDebug(req(true), 'body').startsWith('body\n'))
    assert.ok(withDebug(req(true), 'body').length > 'body'.length + 10)
  })
})

describe('debugBlock', () => {
  it('loads the protocol, not the fallback', () => {
    // Fallback is one line; the real blurb is a full page.
    assert.ok(debugBlock().split('\n').length > 5)
  })
})

describe('failureDebug', () => {
  const attempts = [
    { label: 'GET https://x/a', ok: true, detail: '2 beads' },
    { label: 'GET https://x/b', ok: false, detail: 'timeout' },
  ]
  const out = failureDebug(attempts, ['https://x/a', 'https://x/b'])

  it('marks every attempt ✅/❌ in log and block', () => {
    assert.ok(out.includes('- ✅ GET https://x/a'))
    assert.ok(out.includes('- ❌ GET https://x/b'))
  })
  it('splits results into worked / did-not-work', () => {
    assert.ok(out.includes('- worked: GET https://x/a'))
    assert.ok(out.includes('- did not work: GET https://x/b — timeout'))
  })
  it('fills every placeholder (none leak)', () => {
    for (const ph of ['{ATTEMPTS}', '{STEPS}', '{RESULTS}', '{RETRY}']) {
      assert.ok(!out.includes(ph), `${ph} leaked`)
    }
  })
  it('lists retry literals and ends with the protocol', () => {
    assert.ok(out.includes('- https://x/a\n- https://x/b'))
    assert.ok(out.split('\n').length > 20)
  })
  it('handles all-failed attempts (no worked section entries)', () => {
    const allFail = failureDebug([{ label: 'GET https://x', ok: false, detail: '' }], [])
    assert.ok(allFail.includes('- ❌ GET https://x'))
    assert.ok(allFail.includes('did not work'))
  })
})
