// start_session: FUNNEL_BASE=https://example.test bun test src/lib/start-session.test.ts
// Synthetic only: temp identity/personality/scratchpad paths, loopback service key.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { toolKey } from '../config'
import { mcpRouter } from '../routes/mcp'
import { type CapabilityManifest, liveToolSurface, loadManifest, startSessionDescription, schemaHash } from './capabilities'
import { defaultPersonality } from './personality'
import { capabilitiesDelta, formatCapabilitiesSummary, START_SESSION_RULE } from './start-session'
import { serverVersion } from './whoami'

beforeEach(() => {
  const d = mkdtempSync(join(tmpdir(), 'start-session-'))
  process.env.IDENTITY_PATH = join(d, 'identity.json')
  process.env.PERSONALITY_PATH = join(d, 'personality.md')
  process.env.SCRATCHPAD_PATH = join(d, 'scratch.md')
  process.env.OAUTH_STORE_PATH = join(d, 'store.json')
  process.env.MCP_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), 'start-session-tel-'))
})

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
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
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${toolKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const text = await res.text()
    const line = text.split('\n').find((l) => l.startsWith('data:'))
    const json = line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text)
    return json.result.content[0].text as string
  } finally {
    server.close()
  }
}

// The response footer (relay status, heartbeat) varies per call; compare the body only.
const body = (t: string) => t.split('\n\n## relay-status')[0]

const SYNTH: CapabilityManifest = {
  manifestVersion: 1,
  capabilities: [
    { id: 'old', title: 'o', op: 'old_tool', introduced: '1.0.0' },
    { id: 'edited', title: 'e', op: 'edited_tool', introduced: '1.0.0', changed: '1.5.0' },
    { id: 'new', title: 'n', op: 'new_tool', introduced: '1.6.0' },
    { id: 'gone', title: 'g', op: 'gone_tool', introduced: '1.0.0', removed: '1.7.0' },
    { id: 'newgone', title: 'ng', op: 'newgone_tool', introduced: '1.6.0', removed: '1.7.0' },
  ],
}

describe('capabilitiesDelta', () => {
  it('reports added, removed, changed and refresh_required', () => {
    const d = capabilitiesDelta(SYNTH, '1.4.0', '1.9.0')
    assert.equal(d.status, 'delta')
    assert.deepEqual(d.added, ['new_tool'])
    assert.deepEqual(d.removed, ['gone_tool'])
    assert.deepEqual(d.changed, ['edited_tool'])
    assert.equal(d.refreshRequired, true)
  })
  it('is empty and refresh-free at the live version', () => {
    const d = capabilitiesDelta(SYNTH, '1.9.0', '1.9.0')
    assert.deepEqual([d.added, d.removed, d.changed], [[], [], []])
    assert.equal(d.refreshRequired, false)
  })
  it('says plainly when history is absent or the version is malformed', () => {
    const early = capabilitiesDelta(SYNTH, '0.2.0', '1.9.0')
    assert.equal(early.status, 'unknown')
    assert.match(early.reason!, /history starts at 1\.0\.0/)
    const bad = capabilitiesDelta(SYNTH, 'banana', '1.9.0')
    assert.equal(bad.status, 'unknown')
    assert.match(bad.reason!, /not semver/)
  })
})

describe('start_session tool', () => {
  it('no args = whoami block plus capabilities summary, no delta section', { timeout: 30000 }, async () => {
    const who = body(await callTool('whoami'))
    const ss = body(await callTool('start_session'))
    const m = loadManifest()
    assert.ok(ss.startsWith(who), 'start_session begins with the exact whoami block')
    const tail = ss.slice(who.length)
    assert.ok(tail.includes(`capabilities: bridge v${serverVersion()}, manifest v${m.manifestVersion}, ${liveToolSurface().length} tools`))
    assert.ok(tail.includes('call `start_session` first, automatically'))
    assert.ok(!tail.includes('refresh_required'))
  })
  it('is idempotent and read-only', { timeout: 30000 }, async () => {
    const a = body(await callTool('start_session'))
    const b = body(await callTool('start_session'))
    assert.equal(a, b)
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(process.env.SCRATCHPAD_PATH!), false, 'scratchpad not created')
  })
  it('whoami output is unchanged by the new tool', { timeout: 30000 }, async () => {
    const who = body(await callTool('whoami'))
    assert.ok(who.startsWith('# whoami — beads-bridge'))
    assert.ok(!who.includes('capabilities: bridge v'))
    assert.ok(!who.includes('refresh_required'))
  })
  it('adds the delta for a stale client and names unknown history', { timeout: 30000 }, async () => {
    const stale = await callTool('start_session', { client_capabilities_version: '1.8.0' })
    assert.match(stale, /delta since client v1\.8\.0 \(live v/)
    assert.match(stale, /added: .*start_session/)
    assert.match(stale, /refresh_required: yes/)
    const same = await callTool('start_session', { client_capabilities_version: serverVersion() })
    assert.match(same, /refresh_required: no/)
    const unknown = await callTool('start_session', { client_capabilities_version: '0.1.0' })
    assert.match(unknown, /unknown: manifest history starts at/)
  })
})

describe('contract text and surface', () => {
  it('description is under 1200 chars and carries the rule', () => {
    const d = startSessionDescription()
    assert.ok(d.length < 1200, `${d.length} chars`)
    for (const s of ['automatically', "let's get started", 'idempotent', 'compaction', 'already began']) assert.ok(d.includes(s), s)
  })
  it('personality bootstrap document opens with the rule', () => {
    assert.ok(defaultPersonality().includes(START_SESSION_RULE))
  })
  it('live tool surface includes start_session with its optional input', () => {
    const t = liveToolSurface().find((e) => e.name === 'start_session')
    assert.ok(t, 'registered')
    assert.ok(JSON.stringify(t!.inputSchema).includes('client_capabilities_version'))
    assert.notEqual(schemaHash(liveToolSurface()), schemaHash(liveToolSurface().filter((e) => e.name !== 'start_session')))
  })
  it('summary without a client version has no delta', () => {
    assert.ok(!formatCapabilitiesSummary({ version: '1.9.0', manifestVersion: 7, toolCount: 3 }).includes('delta'))
  })
})
