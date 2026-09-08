// Unit tests: bun test src/lib/mcp-compat.test.ts (node:test, no new deps).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { backfillModernEnvelope, withCompatRequest } from './mcp-compat'

const sparse = (extra: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 'openai-mcp-discover',
  method: 'server/discover',
  params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }, ...extra },
})

describe('backfillModernEnvelope', () => {
  it('fills caps + info on sparse 2026 envelopes, input untouched', () => {
    const input = sparse()
    const out = backfillModernEnvelope(input) as Record<string, Record<string, Record<string, unknown>>>
    assert.deepEqual(out.params._meta['io.modelcontextprotocol/clientCapabilities'], {})
    assert.deepEqual(out.params._meta['io.modelcontextprotocol/clientInfo'], { name: 'unknown', version: '0' })
    assert.equal(out.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28')
    // input not mutated
    assert.equal(Object.keys((input.params._meta as Record<string, unknown>)).length, 1)
  })
  it('leaves complete envelopes alone (same reference)', () => {
    const full = sparse()
    ;(full.params._meta as Record<string, unknown>)['io.modelcontextprotocol/clientCapabilities'] = { sampling: {} }
    ;(full.params._meta as Record<string, unknown>)['io.modelcontextprotocol/clientInfo'] = { name: 'c', version: '1' }
    assert.equal(backfillModernEnvelope(full), full)
  })
  it('ignores legacy (2025 / envelope-less) traffic', () => {
    const legacy = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    assert.equal(backfillModernEnvelope(legacy), legacy)
    const old = sparse()
    ;(old.params._meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] = '2025-11-25'
    assert.equal(backfillModernEnvelope(old), old)
  })
  it('passes through non-objects', () => {
    assert.equal(backfillModernEnvelope(null), null)
    assert.equal(backfillModernEnvelope('x'), 'x')
  })
})

describe('withCompatRequest', () => {
  const sparsePost = (method: string, params: Record<string, unknown> = {}) =>
    new Request('https://x.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }, ...params },
      }),
    })
  it('adds a missing Mcp-Method header on modern posts', async () => {
    const out = await withCompatRequest(sparsePost('tools/list'))
    assert.equal(out.headers.get('mcp-method'), 'tools/list')
    const body = await out.json() as Record<string, Record<string, Record<string, unknown>>>
    assert.deepEqual(body.params._meta['io.modelcontextprotocol/clientCapabilities'], {})
  })
  it('leaves legacy posts untouched (same reference)', async () => {
    const r = new Request('https://x.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(await withCompatRequest(r), r)
  })
  it('mirrors params.name into Mcp-Name for tools/call', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'bead_show',
        arguments: { id: 'x' },
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
    })
    const r = new Request('https://x.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const out = await withCompatRequest(r)
    assert.equal(out.headers.get('mcp-method'), 'tools/call')
    assert.equal(out.headers.get('mcp-name'), 'bead_show')
  })
  it('never overrides present headers', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    })
    const preset = new Request('https://x.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-method': 'ping' },
      body,
    })
    const out = await withCompatRequest(preset)
    assert.equal(out.headers.get('mcp-method'), 'ping')
  })
})
