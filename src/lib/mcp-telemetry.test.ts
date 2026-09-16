// Unit tests: bun test src/lib/mcp-telemetry.test.ts (node:test, no new deps).
// TELEMETRY_DIR is redirected per-test — never the real log dir.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTelemetry,
  argShape,
  clientClass,
  parseMcpBody,
  withTelemetry,
  type McpQueryEntry,
} from './mcp-telemetry'

beforeEach(() => {
  process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'telemetry-test-'))
})

function logged(): McpQueryEntry[] {
  const dir = process.env.MCP_TELEMETRY_DIR as string
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  assert.equal(files.length, 1)
  return readFileSync(join(dir, files[0]), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l) as McpQueryEntry)
}

describe('clientClass', () => {
  it('coarsens without leaking raw UA', () => {
    assert.equal(clientClass(null), 'none')
    assert.equal(clientClass('ChatGPT-User/1.0 extra-stuff-here'), 'chatgpt')
    assert.equal(clientClass('curl/8.0'), 'curl')
    assert.equal(clientClass('SomethingElse/2'), 'other')
  })
})

describe('argShape', () => {
  it('records names and size, never values', () => {
    const s = argShape({ project: 'secret-bead-id', note: 's3cr3t content here' })
    assert.deepEqual(s.names, ['note', 'project'])
    assert.ok(s.bytes > 0)
    assert.ok(!JSON.stringify(s).includes('s3cr3t'))
    assert.deepEqual(argShape('nope'), { names: [], bytes: 0 })
  })
})

describe('parseMcpBody', () => {
  it('extracts tools/call identity and envelope metadata', () => {
    const p = parseMcpBody({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        name: 'bead_show',
        arguments: { id: 'task-1' },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'chatgpt', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': { tools: {}, sampling: {} },
        },
      },
    })
    assert.equal(p.method, 'tools/call')
    assert.equal(p.msgId, 7)
    assert.equal(p.tool, 'bead_show')
    assert.deepEqual(p.argNames, ['id'])
    assert.equal(p.protocolVersion, '2026-07-28')
    assert.equal(p.clientName, 'chatgpt')
    assert.deepEqual(p.clientCapabilities, ['sampling', 'tools'])
  })
  it('tolerates junk bodies', () => {
    const p = parseMcpBody('garbage')
    assert.equal(p.method, null)
    assert.equal(p.tool, null)
  })
})

describe('withTelemetry', () => {
  it('logs one JSONL row per call with timing and status', async () => {
    const next = async (req: globalThis.Request): Promise<globalThis.Response> => {
      assert.ok(req.bodyUsed === false, 'must read a clone, never consume')
      return new globalThis.Response('{}', { status: 200 })
    };
    const wrapped = withTelemetry(next)
    const req = new globalThis.Request('http://x/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'sess-1',
        authorization: 'Bearer SUPERSECRET',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    })
    const res = await wrapped(req)
    assert.equal(res.status, 200)
    const rows = logged()
    assert.equal(rows.length, 1)
    const r = rows[0]
    assert.equal(r.tool, 'whoami')
    assert.equal(r.sessionId, 'sess-1')
    assert.equal(r.authPresent, true)
    assert.equal(r.status, 200)
    assert.ok(r.durationMs >= 0)
    assert.ok(typeof r.backendVersion === 'string')
    const raw = JSON.stringify(r)
    assert.ok(!raw.includes('SUPERSECRET'), 'token value must never land in telemetry')
  })
  it('logs 500 rows when downstream throws, then rethrows', async () => {
    const wrapped = withTelemetry(async () => { throw new Error('boom') })
    const req = new globalThis.Request('http://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    })
    await assert.rejects(wrapped(req), /boom/)
    assert.equal(logged()[0].status, 500)
  })
})
