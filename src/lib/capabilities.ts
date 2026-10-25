// Capability/version contract (task-qgplz): machine-readable manifest,
// backend schema hash, staleness introspection. Pure functions + tiny IO.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
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
  /** Parameters this op accepts beyond the basics; registered here so the manifest names every input. */
  params?: { name: string; type: string; description: string }[]
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
  'bead_connections', 'bead_edit', 'bead_feedback', 'feedback_edit', 'store_health', 'whoami', 'identity_update',
  'personality_read', 'personality_replace', 'personality_append', 'personality_section_edit',
  'scratchpad', 'random', 'timeout_probe', 'relay_resolve_project',
  'relay_list_projects', 'relay_capture', 'project_edit', 'relay_upsert_task',
  'relay_dispatch_request', 'relay_verify', 'relay_flow', 'relay_catchup',
  'relay_attention_next', 'relay_inspect', 'retrieval_search', 'retrieval_activity',
  'retrieval_claimed', 'retrieval_snapshot', 'relay_status', 'heartbeat', 'bridge_info', 'capability_status',
  'capabilities_since', 'capability', 'tool_surface_check', 'agent_presence',
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

/** One registered tool as a client sees it in tools/list. */
export type ToolSurfaceEntry = { name: string; description?: string; inputSchema?: unknown }

/** Deterministic JSON: object keys sorted so the hash never depends on authoring order. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/**
 * Stable hash of the registered MCP tool surface: each tool's name,
 * description and input schema (sorted by name), so a same-name edit — a new
 * parameter, a reworded description — changes it. Bare strings count as
 * name-only entries. 64 hex chars; callers print the first 16.
 */
export function schemaHash(surface: (string | ToolSurfaceEntry)[]): string {
  const entries = surface
    .map((e) => (typeof e === 'string' ? { name: e } : e))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => [e.name, e.description ?? null, e.inputSchema ?? null])
  return createHash('sha256').update(canonicalJson(entries)).digest('hex')
}

type ToolRegistrar = (server: {
  registerTool: (name: string, config: { description?: string; inputSchema?: unknown }, cb: unknown) => unknown
}) => void

/** Run a registration callback against a recording server: the tools/list surface without a transport. */
export function captureToolSurface(register: ToolRegistrar): ToolSurfaceEntry[] {
  const out: ToolSurfaceEntry[] = []
  register({
    registerTool(name, config) {
      let inputSchema: unknown = null
      try {
        inputSchema = z.toJSONSchema(config.inputSchema as z.ZodType)
      } catch {
        inputSchema = String(config.inputSchema)
      }
      out.push({ name, description: config.description, inputSchema })
      return undefined
    },
  })
  return out
}

let liveSurface: ToolSurfaceEntry[] | null = null

/** mcp.ts installs the captured surface once its tools are defined. */
export function setLiveToolSurface(entries: ToolSurfaceEntry[]): void {
  liveSurface = entries
}

/** The live surface to hash: captured entries, else name-only until mcp.ts has loaded. */
export function liveToolSurface(): ToolSurfaceEntry[] {
  return liveSurface ?? BRIDGE_OP_NAMES.map((name) => ({ name }))
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
  opNames: (string | ToolSurfaceEntry)[]
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
    `The schema hash covers every tool's name, description and input schema.`,
    `This bridge is stateless: it never sends notifications/tools/list_changed`,
    `(tools.listChanged is advertised false), so a changed surface is only`,
    `ever visible by comparing these values.`,
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
export function stalenessTriple(opNames: (string | ToolSurfaceEntry)[] = liveToolSurface()): string {
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

// Version-in-tool-description (task-mm1q8): the whoami description carries
// the version it was generated at, so a stale loaded schema is
// self-evidently stale — compare the embedded tag against live bridge_info.
// Single source: serverVersion() (package.json, same as bridge_info) +
// loadManifest().manifestVersion (capabilities.json, same as bridge_info and
// the staleness line). No hardcoded version string anywhere in descriptions.
//
// SCOPE: whoami only. whoami runs at every session start so its description
// is near-certainly in the client's loaded schema; annotating all ~40 tools
// would bloat every tools/list payload for no extra signal.
//
// SCHEMA HASH: schemaHash() covers each tool's name, description and input
// schema, so a description edit moves the hash as well as the version tag.
export const WHOAMI_DESCRIPTION_BASE =
  'Your identity on this bridge: the server, your OAuth client id and scopes, the operator profile, the complete operator personality document (startup/bootstrap context, read it fully), and what you can do.'

/** Short tag naming the backend that generated a tool description. Never throws. */
export function toolVersionTag(): string {
  let version = 'unknown'
  let manifest = 'unknown'
  try {
    version = serverVersion()
  } catch { /* keep unknown */ }
  try {
    manifest = String(loadManifest().manifestVersion)
  } catch { /* keep unknown */ }
  return `[bridge v${version} / manifest v${manifest}]`
}

/** Append the live version tag plus the refresh rule to a base description. */
export function withToolVersion(base: string): string {
  return `${base} ${toolVersionTag()} If bridge_info reports a newer backend/manifest, your loaded schema is stale: ask the user for a manual MCP refresh.`
}

/** whoami tool description with the live version embedded (single source). */
export function whoamiDescription(): string {
  return withToolVersion(WHOAMI_DESCRIPTION_BASE)
}
