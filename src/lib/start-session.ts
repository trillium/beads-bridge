// start_session: the semantic entrypoint for the human's persistent
// interactive companion (task-vog0d, task-lwckw, task-hdiyo, task-wrsf4).
// It returns the whoami block (identity, operating instructions, durable
// context, current work) plus a capabilities summary and, when the client
// says which version it has loaded, the delta to the live manifest. Pure
// over its inputs: reads nothing but the manifest and never writes.
import {
  type CapabilityEntry,
  type CapabilityManifest,
  compareSemver,
  isSemver,
} from './capabilities'

// Agent-facing contract (task-lwckw / task-hdiyo). Keep the whole
// description, with the version tag appended, under 1200 characters.
export const START_SESSION_DESCRIPTION_BASE =
  'Activates the human\'s persistent interactive companion: loads identity, operating instructions, durable context, available capabilities, current work and compatibility state. ' +
  'Call this first, automatically, whenever the human greets you, says let\'s get started, begins with "I\'m working on…", or starts work that may depend on durable context; they never need to name MCP or this tool. ' +
  'It is idempotent, cheap and read-only: call it again after compaction, summarization, a handoff, or whenever you are not certain it ran in the current context. ' +
  'If substantive conversation already began without it, call it now and reconcile with what it returns before continuing. ' +
  'Optional client_capabilities_version (X.Y.Z, the bridge version your tool schema was loaded at) adds what changed since.'

// One short paragraph, same rule, for clients that load instructions from
// the personality/bootstrap document instead of tool descriptions.
export const START_SESSION_RULE =
  'Session start rule: call `start_session` first, automatically, whenever the human greets you, says let\'s get started, begins with "I\'m working on…", or starts work that may depend on durable context. They never need to name MCP or the tool. It is idempotent and cheap: call it again after compaction, summarization, a handoff, or whenever you are not certain it ran in this context. If substantive conversation already began without it, call it now and reconcile before continuing.'

export interface CapabilitiesDelta {
  /** 'delta' = computed from the manifest; 'unknown' = no history for the supplied version. */
  status: 'delta' | 'unknown'
  reason?: string
  added: string[]
  removed: string[]
  changed: string[]
  refreshRequired: boolean
}

const ids = (rows: CapabilityEntry[]) => rows.map((c) => c.op).sort()

/**
 * Delta between the client's loaded version and the live manifest. The
 * manifest records, per tool, the version it was introduced / changed /
 * removed — it does not record which of signature or description changed,
 * so both are reported together as "changed". Absent history is stated, not
 * guessed. A client version that differs from live always requires refresh:
 * the whoami-family descriptions embed the live version and the schema hash
 * covers every description.
 */
export function capabilitiesDelta(m: CapabilityManifest, clientVersion: string, liveVersion: string): CapabilitiesDelta {
  const v = clientVersion.trim()
  const empty = { added: [], removed: [], changed: [] }
  if (!isSemver(v)) {
    return { status: 'unknown', reason: `'${v}' is not semver X.Y.Z`, ...empty, refreshRequired: false }
  }
  const earliest = m.capabilities.map((c) => c.introduced).filter(isSemver).sort(compareSemver)[0]
  if (earliest && compareSemver(v, earliest) < 0) {
    return { status: 'unknown', reason: `manifest history starts at ${earliest}; nothing recorded for ${v}`, ...empty, refreshRequired: compareSemver(v, liveVersion) !== 0 }
  }
  const newer = (x: string | undefined) => x != null && compareSemver(x, v) > 0
  const removed = m.capabilities.filter((c) => newer(c.removed) && !newer(c.introduced))
  const added = m.capabilities.filter((c) => newer(c.introduced) && !c.removed)
  const changed = m.capabilities.filter((c) => newer(c.changed) && !newer(c.introduced) && !c.removed)
  const differs = compareSemver(v, liveVersion) !== 0
  return { status: 'delta', added: ids(added), removed: ids(removed), changed: ids(changed), refreshRequired: differs }
}

export function formatCapabilitiesSummary(opts: {
  version: string
  manifestVersion: number
  toolCount: number
  clientVersion?: string
  manifest?: CapabilityManifest
}): string {
  const lines = [
    ``,
    `capabilities: bridge v${opts.version}, manifest v${opts.manifestVersion}, ${opts.toolCount} tools`,
    START_SESSION_RULE,
  ]
  if (opts.clientVersion != null && opts.manifest) {
    const d = capabilitiesDelta(opts.manifest, opts.clientVersion, opts.version)
    lines.push(``, `delta since client v${opts.clientVersion.trim()} (live v${opts.version}):`)
    if (d.status === 'unknown') {
      lines.push(`  unknown: ${d.reason} — cannot say what is missing; no guess made`)
    } else {
      lines.push(
        `  added: ${d.added.join(', ') || '(none)'}`,
        `  removed: ${d.removed.join(', ') || '(none)'}`,
        `  changed (signature and/or description; the manifest does not say which): ${d.changed.join(', ') || '(none)'}`,
      )
    }
    lines.push(`refresh_required: ${d.refreshRequired ? 'yes' : 'no'}`)
  }
  return lines.join('\n')
}
