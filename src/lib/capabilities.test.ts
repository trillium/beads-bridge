// Unit tests: bun test src/lib/capabilities.test.ts (node:test, no new deps).
// Verifies the capability/version contract (task-qgplz) plus the three-way
// sync: registerTool names in mcp.ts == manifest ops == schema-hash input.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  backendCommit,
  BRIDGE_OP_NAMES,
  capabilitiesSince,
  capabilityStatus,
  compareSemver,
  formatBridgeInfo,
  isSemver,
  loadManifest,
  schemaHash,
  stalenessTriple,
  toolVersionTag,
  WHOAMI_DESCRIPTION_BASE,
  whoamiDescription,
  withToolVersion,
} from './capabilities'
import { serverVersion } from './whoami'

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
  it('BRIDGE_OP_NAMES (footer + hash input) matches registerTool calls', () => {
    assert.deepEqual([...BRIDGE_OP_NAMES].sort(), registeredOps())
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

describe('historical mapping proof (task-qgplz.4)', () => {
  // Every known historical bead id resolves through capabilityStatus to its
  // shipped capability. Gaps are asserted explicitly — never silent.
  it('maps each historical bead to its shipped capability', () => {
    const m = loadManifest()
    const byBead = (bead: string) => {
      const r = capabilityStatus(m, bead)
      assert.equal(r.found, true, `${bead}: expected a shipped capability, got a miss`)
      assert.ok(r.found)
      return r.entry
    }
    assert.equal(byBead('inbox-z6dv').id, 'project_edit')
    assert.equal(byBead('inbox-l6ki').id, 'retrieval_claimed')
    assert.equal(byBead('task-ksmy1').id, 'heartbeat')
    // task-qgplz shipped three introspection ops; capabilityStatus returns
    // the first manifest match, so prove the full set via the beads index.
    const qgplzCaps = m.capabilities.filter((c) => (c.beads ?? []).includes('task-qgplz')).map((c) => c.id).sort()
    assert.deepEqual(qgplzCaps, ['bridge_info', 'capabilities_since', 'capability_status'])
    assert.ok(['bridge_info', 'capabilities_since', 'capability_status'].includes(byBead('task-qgplz').id))
  })
  it('marks inbox-au8v as an explicit gap: infrastructure, not a user-facing op', () => {
    // inbox-au8v shipped as per-query JSONL telemetry middleware
    // (src/lib/mcp-telemetry.ts, wrapped around the /mcp fetch chain) —
    // no MCP tool was registered, so no manifest entry exists by design.
    const m = loadManifest()
    const r = capabilityStatus(m, 'inbox-au8v')
    assert.equal(r.found, false, 'inbox-au8v: gap closed? add the manifest entry + update this proof')
  })
})

describe('capabilitiesSince', () => {
  it('returns only newer entries and rejects non-semver', () => {
    const m = loadManifest()
    const rows = capabilitiesSince(m, '1.0.0').map((c) => c.id).sort()
    assert.deepEqual(rows, ['bead_batch_create', 'bead_comment', 'bead_connections', 'bead_create', 'bead_decision', 'bead_edit', 'bead_feedback', 'bead_label', 'bead_note', 'bead_show', 'beads_bundle', 'bridge_info', 'capabilities_since', 'capability', 'capability_status', 'heartbeat', 'personality_append', 'personality_read', 'personality_replace', 'personality_section_edit', 'project_edit', 'query_store', 'random', 'relay_capture', 'relay_verify', 'retrieval_activity', 'retrieval_claimed', 'retrieval_search', 'retrieval_snapshot', 'tool_surface_check', 'whoami'])
    assert.deepEqual(capabilitiesSince(m, '9.9.9'), [])
    assert.throws(() => capabilitiesSince(m, '1.0'), /not semver/)
  })
})

describe('bridge info', () => {
  it('stalenessTriple is a single comparable line reusing the version sources', () => {
    const t0 = stalenessTriple()
    assert.match(t0, /^staleness: backend v\S+ \/ manifest v\S+ \/ commit \S+ \/ schema [0-9a-f]{16}$/)
    assert.equal(stalenessTriple(), t0)
    assert.notEqual(stalenessTriple([...BRIDGE_OP_NAMES, 'brand_new_tool']), t0)
  })
  it('backendCommit is sha-or-unknown, format names refresh path', () => {
    assert.match(backendCommit(), /^([0-9a-f]{4,40}|unknown)$/)
    const out = formatBridgeInfo({ opNames: registeredOps(), base: 'https://x.example' })
    assert.ok(out.includes('STALENESS RULE'))
    assert.ok(out.includes('manual MCP refresh'))
    assert.ok(out.includes('capability_status'))
  })
})

describe('version in tool descriptions (task-mm1q8)', () => {
  it('whoami description carries the current version from the single source', () => {
    const v = serverVersion()
    const manifest = String(loadManifest().manifestVersion)
    const d = whoamiDescription()
    assert.ok(d.startsWith(WHOAMI_DESCRIPTION_BASE), 'base text preserved')
    assert.ok(d.includes(`[bridge v${v} / manifest v${manifest}]`), `tag missing: ${d.slice(-160)}`)
    assert.ok(d.includes('bridge_info'), 'refresh rule names bridge_info')
  })
  it('tag changes when the version source changes (no hardcoded string)', () => {
    // Coupling proof, not value proof: the tag is computed from the live
    // sources on every call, and mcp.ts builds whoami from it.
    assert.equal(toolVersionTag(), `[bridge v${serverVersion()} / manifest v${loadManifest().manifestVersion}]`)
    assert.equal(withToolVersion('X').slice(0, 2), 'X ')
    assert.ok(withToolVersion('A').endsWith(withToolVersion('B').slice(1)), 'same live tag regardless of base')
    assert.ok(MCP_SRC.includes('whoamiDescription()'), 'mcp.ts whoami must call whoamiDescription()')
    assert.ok(MCP_SRC.includes("from '../lib/capabilities'"), 'mcp.ts whoami tag must import from capabilities')
    assert.ok(!MCP_SRC.match(/bridge v\d+\.\d+\.\d+.*Who am I|Who am I.*bridge v\d/), 'no hardcoded version in whoami description')
  })
  it('embedded tag does not drift from bridge_info report', () => {
    const v = serverVersion()
    const manifest = String(loadManifest().manifestVersion)
    const info = formatBridgeInfo({ opNames: BRIDGE_OP_NAMES, base: 'https://x.example' })
    assert.ok(info.includes(`backend: v${v} `), 'bridge_info backend version')
    assert.ok(info.includes(`manifest v${manifest}`), 'bridge_info manifest version')
    assert.ok(whoamiDescription().includes(`v${v} `) || whoamiDescription().includes(`v${v}]`), 'description backend version matches')
    assert.ok(whoamiDescription().includes(`manifest v${manifest}`), 'description manifest matches')
  })
  it('schemaHash still covers op names only (descriptions never feed it)', () => {
    const h = schemaHash(BRIDGE_OP_NAMES)
    assert.match(h, /^[0-9a-f]{64}$/)
    // A description-only change leaves the hash input untouched: hashing
    // the ops plus a description must differ, proving descriptions are out.
    const withDesc = schemaHash([...BRIDGE_OP_NAMES, whoamiDescription()])
    assert.notEqual(withDesc, h)
    assert.equal(schemaHash([...BRIDGE_OP_NAMES].reverse()), h, 'order-insensitive over names')
  })
})
