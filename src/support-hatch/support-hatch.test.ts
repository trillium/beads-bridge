import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { createSupportHatchApp } from './mcp'
import { retrieveReport, submitReport, type DiagnosticReport } from './store'

const root = __dirname
const outsideImports: string[] = []
for (const file of readdirSync(root).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
  const source = readFileSync(join(root, file), 'utf8')
  for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)) {
    const specifier = match[2]
    if (specifier.startsWith('.') && !specifier.startsWith('./')) outsideImports.push(`${file}: ${specifier}`)
    if (specifier.startsWith('../')) outsideImports.push(`${file}: ${specifier}`)
  }
}

describe('independent support hatch', () => {
  const originalDir = process.env.SUPPORT_HATCH_DIR
  const dir = mkdtempSync(join(tmpdir(), 'support-hatch-'))
  const token = 'test-token-that-is-at-least-24-chars'
  let server: Server
  let base: string

  before(async () => {
    process.env.SUPPORT_HATCH_DIR = dir
    server = createServer(createSupportHatchApp(token))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    base = `http://127.0.0.1:${address.port}/mcp`
  })

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (originalDir === undefined) delete process.env.SUPPORT_HATCH_DIR
    else process.env.SUPPORT_HATCH_DIR = originalDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('hatch modules import no Beads or bridge modules', () => {
    assert.deepEqual(outsideImports, [])
  })

  it('stores reports and independently verifies the receipt', () => {
    const report: DiagnosticReport = { user_description: 'tool fails', failing_operation: 'tools/call', exact_response: '{"error":"schema mismatch"}' }
    const receipt = submitReport(report, dir)
    const found = retrieveReport(receipt.report_id, dir)
    assert.equal(found?.verified, true)
    assert.deepEqual(found?.report, report)
    assert.equal(found?.receipt.sha256, createHash('sha256').update(JSON.stringify(report)).digest('hex'))

    writeFileSync(join(dir, `${receipt.report_id}.json`), '{"tampered":true}')
    assert.throws(() => retrieveReport(receipt.report_id, dir), /failed receipt verification/)
  })

  it('live standalone MCP endpoint submits and retrieves while bridge modules are absent', async () => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    const initialize = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) })
    assert.equal(initialize.status, 200)
    const session = initialize.headers.get('mcp-session-id')
    const sessionHeaders = { ...headers, ...(session ? { 'mcp-session-id': session } : {}) }
    const parse = async (response: Response) => {
      const body = await response.text()
      const dataLine = body.split('\n').find((line) => line.startsWith('data: '))
      return JSON.parse(dataLine ? dataLine.slice(6) : body)
    }
    const submit = await fetch(base, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'support_report_submit', arguments: { user_description: 'Bridge tool returned an invalid result', failing_operation: 'bead_show', exact_response: 'raw schema error', timestamp: '2026-09-30T00:00:00Z', manifest_schema_metadata: 'schema=v2', recent_call_context: 'initialize succeeded', client_identity: 'test-agent', reproduction_steps: 'Call bead_show with id x' } } }) })
    assert.equal(submit.status, 200)
    const submitted = await parse(submit)
    const receipt = JSON.parse(submitted.result.content[0].text).receipt
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/)

    const get = await fetch(base, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'support_report_get', arguments: { report_id: receipt.report_id } } }) })
    assert.equal(get.status, 200)
    const retrieved = await parse(get)
    assert.equal(JSON.parse(retrieved.result.content[0].text).verified, true)
    assert.deepEqual(JSON.parse(retrieved.result.content[0].text).receipt, receipt)
  })

  it('rejects requests without the independent hatch credential', async () => {
    const response = await fetch(base, { method: 'POST', body: '{}' })
    assert.equal(response.status, 401)
  })

  it('bounds raw MCP request size', async () => {
    const response = await fetch(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'x'.repeat(65 * 1024),
    })
    assert.equal(response.status, 413)
  })
})
