// Unit tests: bun test src/lib/delay-probe.test.ts (node:test, no new deps).
// Pure validation + injectable-sleep runner — no subprocesses, no stores.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DELAY_SECONDS,
  formatProbeResult,
  runDelayProbe,
  validateCorrelationId,
  validateDelaySeconds,
} from './delay-probe'

describe('validateDelaySeconds', () => {
  it('accepts the ladder endpoints', () => {
    for (const d of [0, 5, 15, 30, 60, 120, 180, MAX_DELAY_SECONDS]) {
      const r = validateDelaySeconds(d)
      assert.equal(r.ok, true, `delay ${d} should validate`)
    }
  })
  it('rejects over-cap, negative, and non-numeric', () => {
    assert.equal(validateDelaySeconds(MAX_DELAY_SECONDS + 1).ok, false)
    assert.equal(validateDelaySeconds(-1).ok, false)
    assert.equal(validateDelaySeconds(NaN).ok, false)
    assert.equal(validateDelaySeconds('30').ok, false)
    assert.equal(validateDelaySeconds(undefined).ok, false)
  })
})

describe('validateCorrelationId', () => {
  it('echoes a supplied id verbatim (trimmed)', () => {
    const r = validateCorrelationId('  trial-60-a  ')
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.id, 'trial-60-a')
  })
  it('mints when missing or blank', () => {
    for (const v of [undefined, '', '   ']) {
      const r = validateCorrelationId(v)
      assert.equal(r.ok, true)
      if (r.ok) assert.ok(r.id.startsWith('probe-'), `minted id for ${JSON.stringify(v)}`)
    }
  })
  it('rejects over-long and non-string ids', () => {
    assert.equal(validateCorrelationId('x'.repeat(129)).ok, false)
    assert.equal(validateCorrelationId(42).ok, false)
  })
})

describe('runDelayProbe', () => {
  it('honors delay within tolerance and echoes the id', async () => {
    let sleptMs = -1
    const r = await runDelayProbe(
      { delaySeconds: 0.05, correlationId: 'trial-5-a' },
      async (ms) => {
        sleptMs = ms
      },
    )
    assert.equal(sleptMs, 50)
    assert.equal(r.correlationId, 'trial-5-a')
    assert.equal(r.requestedDelaySeconds, 0.05)
  })
  it('issues a real short sleep end-to-end', async () => {
    const t0 = Date.now()
    const r = await runDelayProbe({ delaySeconds: 0.05, correlationId: 'trial-e2e' })
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= 40 && elapsed < 2000, `elapsed ${elapsed}ms out of tolerance`)
    assert.ok(r.actualDelayMs >= 40 && r.actualDelayMs < 2000)
  })
})

describe('formatProbeResult', () => {
  it('carries the correlation id and timings', () => {
    const out = formatProbeResult({
      correlationId: 'trial-30-a',
      requestedDelaySeconds: 30,
      actualDelayMs: 30012,
      startedAt: '2026-09-13T00:00:00.000Z',
      finishedAt: '2026-09-13T00:00:30.012Z',
    })
    assert.ok(out.includes('correlation_id: trial-30-a'))
    assert.ok(out.includes('requested_delay_s: 30'))
    assert.ok(out.includes('actual_delay_ms: 30012'))
  })
})
