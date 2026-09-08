// Unit tests: bun test src/lib/analytics.test.ts (node:test, no new deps).
// Analytics is a no-op without POSTHOG_KEY, so these never touch the network.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { actionName, trackAction, resetAnalyticsForTests } from './analytics'

describe('actionName', () => {
  it('keeps the root and single segments', () => {
    assert.equal(actionName('GET', '/'), 'GET /')
    assert.equal(actionName('GET', '/help'), 'GET /help')
    assert.equal(actionName('GET', '/mcp'), 'GET /mcp')
  })
  it('drops query strings (cache tags must not explode cardinality)', () => {
    assert.equal(actionName('GET', '/next?cache=abc123'), 'GET /next')
  })
  it('keeps known namespaces specific, collapses bead paths', () => {
    assert.equal(actionName('GET', '/q/brain?label=x'), 'GET /q/brain')
    assert.equal(actionName('GET', '/fetch/resumes-zak/complete'), 'GET /fetch/resumes-zak/*')
    assert.equal(actionName('GET', '/review-3y3/approve'), 'GET /review-3y3/*')
    assert.equal(actionName('GET', '/beads/task-1a2+task-3b4'), 'GET /beads/task-1a2')
  })
})

describe('trackAction', () => {
  beforeEach(() => {
    delete process.env.POSTHOG_KEY
    resetAnalyticsForTests()
  })
  it('is a silent no-op without POSTHOG_KEY', () => {
    assert.doesNotThrow(() =>
      trackAction({ method: 'GET', originalUrl: '/help', status: 200, ms: 3, client: 'localhost' })
    )
  })
})
