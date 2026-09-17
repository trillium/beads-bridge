// Capability/version contract (task-qgplz): machine-readable manifest,
// backend schema hash, staleness introspection. Pure functions + tiny IO.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverVersion } from './whoami'

export type CapabilityEntry = {
  id: string
  title: string
  op: string
  introduced: string
  changed?: string
  deprecated?: string
  removed?: string
  beads?: string[]
}

export type CapabilityManifest = {
  manifestVersion: number
  note?: string
  capabilities: CapabilityEntry[]
}

const SEMVER = /^\d+\.\d+\.\d+$/

// Single source for the registered MCP tool surface (task-qgplz.2): the
// per-response staleness footer (relay-status.ts) and bridge_info (mcp.ts)
// both hash THIS list. Must name every registerTool in mcp.ts —
// capabilities.test.ts enforces the sync against the manifest ops.
export const BRIDGE_OP_NAMES = [
  'bead_show', 'beads_bundle', 'query_store', 'bead_comment', 'bead_note',
  'bead_decision', 'bead_label', 'bead_create', 'bead_batch_create',
  'bead_connections', 'bead_edit', 'bead_feedback', 'whoami', 'identity_update',
  'scratchpad', 'random', 'timeout_probe', 'relay_resolve_project',
  'relay_list_projects', 'relay_capture', 'project_edit', 'relay_upsert_task',
  'relay_dispatch_request', 'relay_verify', 'relay_flow', 'relay_catchup',
  'relay_attention_next', 'relay_inspect', 'retrieval_search', 'retrieval_activity',
  'retrieval_claimed', 'retrieval_snapshot', 'relay_status', 'bridge_info', 'capability_status',
  'capabilities_since',
]

export function loadManifest(): CapabilityManifest {
  const raw = readFileSync(join(__dirname, '..', '..', 'capabilities.json'), 'utf8')
  const m = JSON.parse(raw) as CapabilityManifest
  if (typeof m.manifestVersion !== 'number' || !Array.isArray(m.capabilities)) {
    throw new Error('capabilities.json: bad shape (need manifestVersion + capabilities[])')
  }
  return m
}

/** Backend commit id (short SHA) or 'unknown' when git is unavailable. Never throws. */
export function backendCommit(): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: join(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
    return /^[0-9a-f]{4,40}$/.test(out) ? out : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Stable hash of the registered MCP tool surface (sorted op names). */
export function schemaHash(opNames: string[]): string {
  return createHash('sha256').update([...opNames].sort().join('\n')).digest('hex')
}

export function isSemver(v: string): boolean {
  return SEMVER.test(v)
}

/** -1 | 0 | 1 semver compare (numeric per segment, missing segments = 0). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export type CapabilityStatus =
  | { found: true; entry: CapabilityEntry; liveInBackend: string }
  | { found: false; id: string; liveInBackend: string }

/** Is capability id (or originating bead) live in this backend version? */
export function capabilityStatus(m: CapabilityManifest, idOrBead: string): CapabilityStatus {
  const live = serverVersion()
  const entry = m.capabilities.find(
    (c) => c.id === idOrBead || (c.beads ?? []).includes(idOrBead),
  )
  if (!entry) return { found: false, id: idOrBead, liveInBackend: live }
  return { found: true, entry, liveInBackend: live }
}

/** Capabilities introduced/changed after the given version (exclusive). */
export function capabilitiesSince(m: CapabilityManifest, version: string): CapabilityEntry[] {
  if (!isSemver(version)) throw new Error(`capabilities_since: '${version}' is not semver X.Y.Z`)
  return m.capabilities.filter(
    (c) =>
      compareSemver(c.introduced, version) > 0 ||
      (c.changed != null && compareSemver(c.changed, version) > 0),
  )
}

export function formatBridgeInfo(opts: {
  opNames: string[]
  base: string
}): string {
  const m = loadManifest()
  const version = serverVersion()
  const lines = [
    `# bridge_info — beads-bridge`,
    ``,
    `backend: v${version} (commit ${backendCommit()}, manifest v${m.manifestVersion})`,
    `tool surface: ${opts.opNames.length} ops, schema hash ${schemaHash(opts.opNames).slice(0, 16)}…`,
    `base: ${opts.base}/mcp`,
    ``,
    `STALENESS RULE: your loaded MCP tool schema is frozen at connection time.`,
    `If backend v${version} / manifest v${m.manifestVersion} / schema hash differ from`,
    `what you were told at connect, the backend has advanced past your loaded schema:`,
    `ask the user for a manual MCP refresh (disconnect + reconnect). New tools alone`,
    `cannot reach you — an old connection cannot see newly registered tools.`,
    ``,
    `Next: capability_status(id|bead) to check one feature,`,
    `capabilities_since(X.Y.Z) to list what changed since a version.`,
  ]
  return lines.join('\n')
}

/**
 * Per-response staleness triple (task-qgplz.2): the version/commit/hash line
 * appended to every MCP response footer via formatRelayStatus. Single-line,
 * machine-comparable: record it at connect (T0); any backend advance
 * (package.json version, capabilities.json manifest, tool surface, commit)
 * changes the string. Never throws — degrades to 'unknown' segments so a
 * broken manifest/commit lookup can never fail a tool response.
 */
export function stalenessTriple(opNames: string[] = BRIDGE_OP_NAMES): string {
  let version = 'unknown'
  let manifest = 'unknown'
  let commit = 'unknown'
  let hash = 'unknown'
  try {
    version = serverVersion()
  } catch { /* keep unknown */ }
  try {
    manifest = String(loadManifest().manifestVersion)
  } catch { /* keep unknown */ }
  try {
    commit = backendCommit()
  } catch { /* keep unknown */ }
  try {
    hash = schemaHash(opNames).slice(0, 16)
  } catch { /* keep unknown */ }
  return `staleness: backend v${version} / manifest v${manifest} / commit ${commit} / schema ${hash}`
}
