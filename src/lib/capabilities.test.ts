// Unit tests: bun test src/lib/capabilities.test.ts (node:test, no new deps).
// Verifies the capability/version contract (task-qgplz) plus the three-way
// sync: registerTool names in mcp.ts == manifest ops == schema-hash input.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  backendCommit,
  capabilitiesSince,
  capabilityStatus,
  compareSemver,
  formatBridgeInfo,
  isSemver,
  loadManifest,
  schemaHash,
} from './capabilities'

const MCP_SRC = readFileSync(join(__dirname, '..', 'routes', 'mcp.ts'), 'utf8')

function registeredOps(): string[] {
  const names = new Set<string>()
  for (const m of MCP_SRC.matchAll(/registerTool\(\s*'([^']+)'/g)) names.add(m[1])
  return [...names].sort()
}

describe('manifest', () => {
  it('loads with numeric version and unique semver-valid entries', () => {
    const m = loadManifest()
    assert.equal(typeof m.manifestVersion, 'number')
    const ids = m.capabilities.map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length, 'duplicate capability ids')
    for (const c of m.capabilities) {
      assert.ok(isSemver(c.introduced), `${c.id}: bad introduced ${c.introduced}`)
      assert.ok(c.op.length > 0, `${c.id}: empty op`)
    }
  })
  it('stays in sync with registerTool calls in mcp.ts', () => {
    const m = loadManifest()
    assert.deepEqual(registeredOps(), m.capabilities.map((c) => c.op).sort())
  })
})

describe('changelog coherence', () => {
  it('has a CHANGELOG.md version section for every introduced version', () => {
    const changelog = readFileSync(join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8')
    const sections = new Set(
      [...changelog.matchAll(/^##\s+(\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]),
    )
    const m = loadManifest()
    assert.ok(sections.size > 0, 'CHANGELOG.md has no version sections')
    for (const c of m.capabilities) {
      assert.ok(
        sections.has(c.introduced),
        `${c.id}: introduced ${c.introduced} has no ## ${c.introduced} section in CHANGELOG.md`,
      )
    }
  })
})

describe('semver helpers', () => {
  it('validates and compares', () => {
    assert.ok(isSemver('1.1.0') && !isSemver('1.1') && !isSemver('v1.2.3'))
    assert.equal(compareSemver('1.0.0', '1.1.0'), -1)
    assert.equal(compareSemver('1.1.0', '1.1.0'), 0)
    assert.equal(compareSemver('2.0.0', '1.9.9'), 1)
  })
})

describe('schemaHash', () => {
  it('is deterministic 64-hex and order-insensitive', () => {
    const a = schemaHash(['whoami', 'bridge_info'])
    const b = schemaHash(['bridge_info', 'whoami'])
    assert.equal(a, b)
    assert.match(a, /^[0-9a-f]{64}$/)
    assert.notEqual(a, schemaHash(['whoami']))
  })
})

describe('capabilityStatus', () => {
  it('finds by id and by originating bead, misses unknown', () => {
    const m = loadManifest()
    const hit = capabilityStatus(m, 'project_edit')
    assert.equal(hit.found, true)
    if (hit.found) assert.equal(hit.entry.op, 'project_edit')
    const byBead = capabilityStatus(m, 'inbox-z6dv')
    assert.equal(byBead.found, true)
    const miss = capabilityStatus(m, 'nope_nothing')
    assert.equal(miss.found, false)
  })
})

describe('capabilitiesSince', () => {
  it('returns only newer entries and rejects non-semver', () => {
    const m = loadManifest()
    const rows = capabilitiesSince(m, '1.0.0').map((c) => c.id).sort()
    assert.deepEqual(rows, ['bridge_info', 'capabilities_since', 'capability_status', 'project_edit', 'retrieval_claimed'])
    assert.deepEqual(capabilitiesSince(m, '9.9.9'), [])
    assert.throws(() => capabilitiesSince(m, '1.0'), /not semver/)
  })
})

describe('bridge info', () => {
  it('backendCommit is sha-or-unknown, format names refresh path', () => {
    assert.match(backendCommit(), /^([0-9a-f]{4,40}|unknown)$/)
    const out = formatBridgeInfo({ opNames: registeredOps(), base: 'https://x.example' })
    assert.ok(out.includes('STALENESS RULE'))
    assert.ok(out.includes('manual MCP refresh'))
    assert.ok(out.includes('capability_status'))
  })
})
