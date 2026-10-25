// initialize handshake identity: serverInfo is the real bridge (name +
// package.json version, not mcp-handler's "mcp-typescript server on vercel
// 0.1.0" default) and tools.listChanged is not advertised — the transport is
// stateless, so notifications/tools/list_changed can never be delivered.
// Unit test: FUNNEL_BASE=https://example.test bun test src/routes/mcp-initialize.test.ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { toolKey } from '../config'
import { serverVersion } from '../lib/whoami'
import { mcpRouter } from './mcp'

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'mcp-init-test-')), 'store.json')
  process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'mcp-init-tel-'))
})

describe('initialize', () => {
  it('reports the real serverInfo and does not advertise tools.listChanged', { timeout: 30000 }, async () => {
    const app = express()
    app.use(express.json({ limit: '2mb' }))
    app.use(mcpRouter)
    const server = await new Promise<import('node:http').Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s))
    })
    try {
      const { port } = server.address() as import('node:net').AddressInfo
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${toolKey}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
        }),
      })
      const text = await res.text()
      const line = text.split('\n').find((l) => l.startsWith('data:'))
      const json = line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text)
      assert.equal(json.result.serverInfo.name, 'beads-bridge')
      assert.equal(json.result.serverInfo.version, serverVersion())
      assert.ok(json.result.capabilities.tools, 'tools capability still advertised')
      assert.notEqual(json.result.capabilities.tools.listChanged, true)
    } finally {
      server.close()
    }
  })
})
