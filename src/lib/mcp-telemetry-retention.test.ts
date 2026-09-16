// Retention + durability tests: bun test src/lib/mcp-telemetry-retention.test.ts
// Proves: persistent default outside tmp, 10k synthetic round-trip + queries,
// size rotation shards the active file, prune bounds disk (age + size cap).
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTelemetry,
  pruneTelemetry,
  readTelemetry,
  retentionConfig,
  telemetryDir,
  type McpQueryEntry,
} from './mcp-telemetry'

function entry(i: number): McpQueryEntry {
  return {
    ts: new Date(Date.now() + i).toISOString(),
    durationMs: i % 100,
    method: 'tools/call',
    msgId: i,
    tool: i % 2 === 0 ? 'bead_show' : 'whoami',
    argNames: ['id'],
    argBytes: 12,
    sessionId: `sess-${i % 10}`,
    protocolVersion: null,
    clientName: null,
    clientVersion: null,
    clientCapabilities: [],
    mcpProtocolHeader: null,
    client: 'test',
    authPresent: false,
    status: 200,
    backendVersion: 'test',
    manifestVersion: null,
  }
}

function dirBytes(dir: string): number {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .reduce((s, f) => s + statSync(join(dir, f)).size, 0)
}

describe('telemetry durability', () => {
  it('defaults outside OS tmp, honors MCP_TELEMETRY_DIR', () => {
    delete process.env.MCP_TELEMETRY_DIR
    const d = telemetryDir()
    assert.ok(!d.startsWith(tmpdir()), `default must not be tmp, got ${d}`)
    process.env.MCP_TELEMETRY_DIR = '/tmp/custom-override'
    assert.equal(telemetryDir(), '/tmp/custom-override')
  })

  it('retentionConfig honors env with sane defaults', () => {
    delete process.env.MCP_TELEMETRY_RETENTION_DAYS
    delete process.env.MCP_TELEMETRY_MAX_BYTES
    const c = retentionConfig()
    assert.ok(c.retentionDays > 0 && c.maxTotalBytes > 0 && c.maxFileBytes > 0)
    process.env.MCP_TELEMETRY_RETENTION_DAYS = '7'
    assert.equal(retentionConfig().retentionDays, 7)
    delete process.env.MCP_TELEMETRY_RETENTION_DAYS
  })
})

describe('telemetry retention under synthetic load', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'telemetry-retention-'))
    process.env.MCP_TELEMETRY_DIR = dir
    // Tiny file cap so 10k rows force size rotation into shards.
    process.env.MCP_TELEMETRY_MAX_FILE_BYTES = String(32 * 1024)
    process.env.MCP_TELEMETRY_MAX_BYTES = String(10 * 1024 * 1024)
    process.env.MCP_TELEMETRY_RETENTION_DAYS = '30'
  })

  it('10k records round-trip write + queries; rotation shards; prune bounds disk', { timeout: 60_000 }, () => {
    const N = 10_000
    for (let i = 0; i < N; i++) appendTelemetry(entry(i))
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    assert.ok(files.length > 1, `size rotation should shard, got ${files.length} file(s)`)
    const rows = readTelemetry(dir)
    assert.equal(rows.length, N)
    // Query recipes: per-tool + per-session slices round-trip.
    assert.equal(rows.filter((r) => r.tool === 'bead_show').length, N / 2)
    assert.equal(readTelemetry(dir, (r) => r.sessionId === 'sess-3').length, N / 10)
    // Disk is bounded by the size cap after an explicit prune sweep.
    const before = dirBytes(dir)
    const res = pruneTelemetry(dir)
    const after = dirBytes(dir)
    assert.ok(after <= Number(process.env.MCP_TELEMETRY_MAX_BYTES), `disk ${after} over cap`)
    assert.ok(after <= before, 'prune must not grow disk')
    assert.equal(res.keptBytes, after)
    delete process.env.MCP_TELEMETRY_MAX_FILE_BYTES
    delete process.env.MCP_TELEMETRY_MAX_BYTES
    delete process.env.MCP_TELEMETRY_RETENTION_DAYS
  })

  it('prunes files older than retentionDays', () => {
    appendTelemetry(entry(0))
    const stale = join(dir, 'mcp-queries-2020-01-01.jsonl')
    writeFileSync(stale, '{"ts":"stale"}\n')
    const old = Date.now() - 40 * 86400 * 1000
    utimesSync(stale, new Date(old), new Date(old))
    const res = pruneTelemetry(dir, { retentionDays: 30 })
    assert.ok(res.deleted.includes('mcp-queries-2020-01-01.jsonl'))
    assert.ok(!readdirSync(dir).includes('mcp-queries-2020-01-01.jsonl'))
  })

  it('enforces total size cap oldest-first', () => {
    for (let i = 0; i < 5; i++) {
      const f = join(dir, `mcp-queries-2026-09-0${i + 1}.jsonl`)
      writeFileSync(f, 'x'.repeat(1000))
      const t = new Date(Date.now() - (5 - i) * 3600 * 1000)
      utimesSync(f, t, t)
    }
    const res = pruneTelemetry(dir, { retentionDays: 365, maxTotalBytes: 2500 })
    assert.ok(res.deleted.length >= 2, 'should drop oldest files to fit cap')
    assert.ok(dirBytes(dir) <= 2500)
  })
})
