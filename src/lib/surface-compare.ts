// Tool-surface comparison (task-trv5y): compare the MCP/tool surface
// described in a feedback record against the live surface, and report
// additions, removals, schema/capability changes plus a needs_refresh
// verdict. Pure functions + tiny IO; the MCP wrapper lives in
// src/routes/mcp.ts (tool_surface_check).
//
// Honesty contract: a server cannot observe the tool list a client
// currently holds. So the comparison measures exactly one of:
//   (a) caller-supplied client_tools/client_schema vs the live surface
//       (direct check — the caller's tools/list snapshot), or
//   (b) the tool mentions + recorded triple extracted from a feedback
//       record vs the live surface (feedback-era snapshot vs live).
// Where a fact is unobservable the verdict is an explicit unknown
// (needsRefresh null + reason), never a guess.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A check response is observational metadata, not data: keep it small.
export const SURFACE_CHECK_MAX_CHARS = 4000

const FEEDBACK_FILE_RE = /^\d{4}-\d{2}-\d{2}T[\d\-.]+Z-feedback-[a-z0-9]+\.md$/

/** Feedback filenames, oldest first. ISO-stamped names sort chronologically. */
export function listFeedbackRecords(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((n) => FEEDBACK_FILE_RE.test(n)).sort()
}

/** Newest feedback record by timestamp (filename order). Null when none. */
export function latestFeedbackFilename(dir: string): string | null {
  const names = listFeedbackRecords(dir)
  return names.length ? names[names.length - 1] : null
}

export function readFeedbackRecord(dir: string, filename: string): string {
  return readFileSync(join(dir, filename), 'utf8')
}

/** Tool/op names from vocabulary mentioned anywhere in free text. */
export function extractToolMentions(text: string, vocabulary: string[]): string[] {
  const vocab = new Set(vocabulary.map((v) => v.toLowerCase()))
  const seen = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/\b[a-z][a-z0-9_]*\b/g)) {
    if (vocab.has(m[0])) seen.add(m[0])
  }
  return [...seen].sort()
}

export interface RecordedTriple {
  version: string | null
  commit: string | null
  schema: string | null
}

/** Backend triple a feedback record claims (vX.Y.Z / commit / schema hash). */
export function extractRecordedTriple(text: string): RecordedTriple {
  const version = text.match(/\bv(\d+\.\d+\.\d+)\b/)?.[1] ?? null
  const commit = text.match(/commit\s+([0-9a-f]{4,40})\b/i)?.[1] ?? null
  const schema = text.match(/schema(?:\s+hash)?\s+([0-9a-f]{16,64})\b/i)?.[1] ?? null
  return { version, commit, schema }
}

/** Split caller-supplied tools/list text into normalized op names. */
export function parseClientTools(input: string): string[] {
  return [...new Set(
    input.split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean),
  )].sort()
}

export interface SurfaceDiff {
  additions: string[]
  removals: string[]
  common: string[]
}

export function diffOpSets(expected: string[], live: string[]): SurfaceDiff {
  const liveSet = new Set(live)
  const expSet = new Set(expected)
  return {
    additions: live.filter((o) => !expSet.has(o)).sort(),
    removals: expected.filter((o) => !liveSet.has(o)).sort(),
    common: live.filter((o) => expSet.has(o)).sort(),
  }
}

function hashMatches(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.startsWith(y) || y.startsWith(x)
}

export interface SurfaceVerdict {
  feedbackFile: string | null
  referenceLabel: string
  clientSurfaceKnown: boolean
  expectedOps: string[]
  liveOps: string[]
  diff: SurfaceDiff
  recorded: RecordedTriple
  liveTriple: { version: string; manifest: number; commit: string; schema: string }
  schemaChanged: boolean | null
  changedSince: string[]
  needsRefresh: boolean | null
  reasons: string[]
}

export function checkSurface(opts: {
  feedbackFile: string | null
  feedbackText: string
  vocabulary: string[]
  liveOps: string[]
  liveTriple: SurfaceVerdict['liveTriple']
  clientTools: string | null
  clientSchema: string | null
  changedSince: string[]
}): SurfaceVerdict {
  const expectedOps = extractToolMentions(opts.feedbackText, opts.vocabulary)
  const recorded = extractRecordedTriple(opts.feedbackText)
  const clientOps = opts.clientTools != null && opts.clientTools.trim()
    ? parseClientTools(opts.clientTools)
    : null
  const liveOps = [...opts.liveOps].sort()
  const clientSurfaceKnown = clientOps != null
  const reference = clientOps ?? expectedOps
  const referenceLabel = clientOps != null
    ? 'caller-supplied tools/list snapshot'
    : opts.feedbackFile != null
      ? `feedback ${opts.feedbackFile} snapshot`
      : 'no reference surface'
  const diff = diffOpSets(reference, liveOps)
  const schemaChanged = clientSurfaceKnown
    ? (opts.clientSchema?.trim() ? !hashMatches(opts.clientSchema.trim(), opts.liveTriple.schema) : null)
    : (recorded.schema ? !hashMatches(recorded.schema, opts.liveTriple.schema) : null)
  const reasons: string[] = []
  let needsRefresh: boolean | null = null
  if (!reference.length && schemaChanged == null) {
    reasons.push('no reference surface: feedback names no tools, records no schema hash, and no client_tools/client_schema was supplied — cannot determine; supply client_tools for a direct check')
  } else {
    if (diff.additions.length) reasons.push(`live adds ${diff.additions.length}: ${diff.additions.join(', ')}`)
    if (diff.removals.length) reasons.push(`live drops ${diff.removals.length}: ${diff.removals.join(', ')}`)
    if (schemaChanged === true) reasons.push('schema hash differs from the reference snapshot')
    if (schemaChanged === false) reasons.push('schema hash matches the reference snapshot')
    if (!diff.additions.length && !diff.removals.length && schemaChanged === false) {
      needsRefresh = false
      reasons.push('reference surface equals live — no manual MCP refresh needed')
    } else if (diff.additions.length || diff.removals.length || schemaChanged === true) {
      needsRefresh = true
      reasons.push('reference surface differs from live — ask the user for a manual MCP refresh (disconnect + reconnect)')
    } else {
      reasons.push('name sets match but no schema hash to compare — treat as unknown, supply client_schema for a firm verdict')
    }
  }
  if (!clientSurfaceKnown) {
    reasons.push('client tools/list is not observable from the server — verdict compares the feedback-era snapshot vs live, not your loaded tools')
  }
  return {
    feedbackFile: opts.feedbackFile,
    referenceLabel,
    clientSurfaceKnown,
    expectedOps,
    liveOps,
    diff,
    recorded,
    liveTriple: opts.liveTriple,
    schemaChanged,
    changedSince: opts.changedSince,
    needsRefresh,
    reasons,
  }
}

export function formatSurfaceCheck(v: SurfaceVerdict): string {
  const t = v.liveTriple
  const verdict = v.needsRefresh == null ? 'UNKNOWN' : v.needsRefresh ? 'YES' : 'NO'
  const lines = [
    `# tool_surface_check — needs_refresh: ${verdict}`,
    ``,
    `reference: ${v.referenceLabel}`,
    ...(v.feedbackFile ? [`feedback record: ${v.feedbackFile}`] : []),
    `recorded triple: backend ${v.recorded.version ? `v${v.recorded.version}` : '(unrecorded)'} / commit ${v.recorded.commit ?? '(unrecorded)'} / schema ${v.recorded.schema ?? '(unrecorded)'}`,
    `live triple: backend v${t.version} / manifest v${t.manifest} / commit ${t.commit} / schema ${t.schema.slice(0, 16)}`,
    ``,
    `additions (${v.diff.additions.length}): ${v.diff.additions.join(', ') || '(none)'}`,
    `removals (${v.diff.removals.length}): ${v.diff.removals.join(', ') || '(none)'}`,
    `unchanged: ${v.diff.common.length} ops`,
    v.changedSince.length
      ? `newer since recorded version: ${v.changedSince.join(', ')}`
      : `newer since recorded version: (none or version unrecorded)`,
    ``,
    ...v.reasons.map((r) => `- ${r}`),
  ]
  let out = lines.join('\n')
  if (out.length > SURFACE_CHECK_MAX_CHARS) out = `${out.slice(0, SURFACE_CHECK_MAX_CHARS - 1)}…`
  return out
}
