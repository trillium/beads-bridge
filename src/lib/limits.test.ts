// Unit tests: bun test src/lib/limits.test.ts (node:test, no new deps).
// Pins the shared body-text bound both failure modes guard against:
// a 5,200-char durable report (the verified Beads round-trip size) must
// PASS schema validation, and input past the bound must FAIL loudly at
// the boundary — never slide through to a silent slice downstream.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BODY_CHARS, bodyText, requiredBodyText } from './limits'

const REPORT = 'x'.repeat(5200)

describe('MAX_BODY_CHARS', () => {
  it('covers the verified durable-report size with headroom', () => {
    assert.ok(MAX_BODY_CHARS >= REPORT.length, `bound ${MAX_BODY_CHARS} must accept a ${REPORT.length}-char report`)
  })
})

describe('bodyText', () => {
  const schema = bodyText('Body text')
  it('accepts a 5,200-char report (the bead_create rejection regression)', () => {
    assert.equal(schema.safeParse(REPORT).success, true)
  })
  it('accepts empty/omitted optionals the way the tools declare them', () => {
    assert.equal(bodyText('Body text').optional().safeParse(undefined).success, true)
  })
  it('rejects input past the bound LOUDLY instead of truncating', () => {
    const r = schema.safeParse('x'.repeat(MAX_BODY_CHARS + 1))
    assert.equal(r.success, false)
  })
})

describe('requiredBodyText', () => {
  const schema = requiredBodyText('The feedback itself')
  it('accepts a long body and rejects empty text', () => {
    assert.equal(schema.safeParse(REPORT).success, true)
    assert.equal(schema.safeParse('').success, false)
  })
  it('rejects input past the bound LOUDLY instead of truncating', () => {
    assert.equal(schema.safeParse('x'.repeat(MAX_BODY_CHARS + 1)).success, false)
  })
})
