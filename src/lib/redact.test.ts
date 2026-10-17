// Secret redaction for the /live event stream (task-7y3fm).
// bun test src/lib/redact.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { REDACTED, clip, displayArgs, redactString, redactValue } from './redact'
import { OTHER_FAMILY, TOOL_FAMILIES, toolFamily } from './tool-family'

// Secret-shaped fixtures are assembled at runtime so no scanner-detectable
// literal exists in the source (GitGuardian); the redactor sees the full string.
const j = (...parts: string[]) => parts.join('')
const GH = j('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123')
const SK = j('s', 'k-', 'abcdefghijklmnopqrstuvwx')
const PAT = j('github', '_pat_', '11ABCDEFG0abcdefghijklmnopqrstuv')
const SLACK = j('xo', 'xb-', '1234567890-abcdefghij')
const AWS = j('AK', 'IA', 'ABCDEFGHIJKLMNOP')
const JWT = j('ey', 'JhbGciOiJIUzI1NiJ9.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0.', 'sig_nature-xx')
const PEM = j('-----BEGIN RSA PRIV', 'ATE KEY-----\nMIIabc\n-----END RSA PRIV', 'ATE KEY-----')
const BEARER = j('Bear', 'er ', 'abcdefgh12345678')
const BASIC = j('Bas', 'ic ', 'dXNlcjpwYXNzd29yZA==')

describe('redactValue — by key', () => {
  it('hides the value of any secret-looking key, at any depth, in any casing', () => {
    const out = redactValue({
      token: 't',
      Password: 'p',
      api_key: 'a',
      apiKey: 'b',
      'X-Api-Key': 'c',
      Authorization: j('Bear', 'er q'),
      client_secret: 's',
      accessToken: 'x',
      private_key: 'k',
      cookie: 'c',
      nested: { list: [{ passwd: 'z' }], key: 'plain' },
    }) as Record<string, unknown>
    assert.equal(JSON.stringify(out).includes('"t"'), false)
    for (const k of ['token', 'Password', 'api_key', 'apiKey', 'X-Api-Key', 'Authorization', 'client_secret', 'accessToken', 'private_key', 'cookie']) {
      assert.equal(out[k], REDACTED, k)
    }
    assert.deepEqual(out.nested, { list: [{ passwd: REDACTED }], key: REDACTED })
  })

  it('leaves ordinary keys alone, including ones that merely contain "auth" or "key"', () => {
    const v = { id: 'task-1', author: 'a', keyword: 'k', monkey: 1, title: 'T', n: 3, ok: true, none: null }
    assert.deepEqual(redactValue(v), v)
  })

  it('does not mutate its input', () => {
    const v = { token: 'abc', a: [{ password: 'x' }] }
    redactValue(v)
    assert.deepEqual(v, { token: 'abc', a: [{ password: 'x' }] })
  })

  it('survives cycles and absurd depth without throwing', () => {
    const a: Record<string, unknown> = { x: 1 }
    a.self = a
    assert.doesNotThrow(() => redactValue(a))
  })
})

describe('redactString — by shape', () => {
  const cases: Array<[string, string]> = [
    [`Authorization: ${BEARER}`, 'abcdefgh12345678'],
    [`curl -H "Authorization: ${BASIC}"`, 'dXNlcjpwYXNzd29yZA'],
    [`key ${SK}`, SK.slice(0, 19)],
    [`gh ${GH}`, GH.slice(0, 14)],
    [PAT, PAT.slice(0, 16)],
    [`slack ${SLACK}`, SLACK.slice(0, 15)],
    [`aws ${AWS}`, AWS.slice(0, 12)],
    [`jwt ${JWT}`, JWT.slice(0, 20)],
    [j('https://x.test/cb?access_', 'token=', 'abc123def456&state=ok'), 'abc123def456'],
    [j('pass', 'word: "hunter2 hunter3"'), 'hunter2'],
    [PEM, 'MIIabc'],
  ]
  for (const [input, secret] of cases) {
    it(`hides ${secret.slice(0, 14)}…`, () => {
      const out = redactString(input)
      assert.ok(!out.includes(secret), `leaked: ${out}`)
      assert.ok(out.includes(REDACTED), `no marker: ${out}`)
    })
  }

  it('keeps surrounding context and plain text', () => {
    assert.equal(redactString('show task-f89c9 in brain'), 'show task-f89c9 in brain')
    assert.ok(redactString(`${BEARER} for x`).endsWith('for x'))
  })
})

describe('displayArgs / clip — truncation is explicit', () => {
  it('renders exact JSON when it fits', () => {
    assert.deepEqual(displayArgs({ id: 'task-1', n: 2 }, 100), { text: '{"id":"task-1","n":2}', omitted: 0 })
  })

  it('reports exactly how many chars were cut', () => {
    const full = JSON.stringify({ text: 'a'.repeat(300) })
    const r = displayArgs({ text: 'a'.repeat(300) }, 100)
    assert.equal(r.text.length, 100)
    assert.equal(r.omitted, full.length - 100)
    assert.equal(r.text, full.slice(0, 100))
  })

  it('redacts BEFORE cutting so a secret straddling the limit is not half-shown', () => {
    const r = displayArgs({ note: 'x'.repeat(20) + ' ' + GH }, 40)
    assert.ok(!r.text.includes(GH.slice(0, 4)))
  })

  it('treats absent or empty arguments as nothing to show', () => {
    for (const v of [undefined, null, {}]) assert.deepEqual(displayArgs(v, 50), { text: '', omitted: 0 })
  })

  it('clip leaves short text untouched', () => {
    assert.deepEqual(clip('abc', 3), { text: 'abc', omitted: 0 })
    assert.deepEqual(clip('abcd', 3), { text: 'abc', omitted: 1 })
  })
})

describe('toolFamily', () => {
  it('maps every family, with prefixes and a fallback', () => {
    assert.equal(toolFamily('bead_show').key, 'read')
    assert.equal(toolFamily('retrieval_search').key, 'read')
    assert.equal(toolFamily('bead_comment').key, 'write')
    assert.equal(toolFamily('relay_status').key, 'relay')
    assert.equal(toolFamily('bead_feedback').key, 'feedback')
    assert.equal(toolFamily('personality_read').key, 'memory')
    assert.equal(toolFamily('whoami').key, 'system')
    assert.equal(toolFamily('brand_new_tool'), OTHER_FAMILY)
  })

  it('never assigns a tool to two families', () => {
    const seen = new Map<string, string>()
    for (const f of TOOL_FAMILIES) for (const t of f.tools) {
      assert.ok(!seen.has(t), `${t} in ${seen.get(t)} and ${f.key}`)
      seen.set(t, f.key)
    }
  })
})
