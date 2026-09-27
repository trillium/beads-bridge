// Creation provenance: every bead-create path stamps its origin so a bead's
// origin is recoverable after the fact (task-mm2zq). History records only
// the store actor (`beads`), never the calling agent — without a stamp, a
// bead made by ChatGPT over the MCP tool is indistinguishable from one made
// by the paste form, a batch, or the automatic relay.
//
// Scheme: extend the existing `source:` label convention (the paste route
// already lands `source:paste`) rather than inventing a competing one.
// Labels are the right carrier, not description metadata or comments:
// they are bounded, queryable (`inbox list -l source:mcp`), and read back
// identically on every store's `show`. A second `by:<caller>` label names
// the caller where one is known (the OAuth clientId / caller key already
// used for heartbeat cursors). The caller key is an identity, never a
// bearer — no tokens or payload bodies ever land in a label.
//
// Budget: at most 2 short labels, each matching LABEL_RE and capped at 64
// chars. Provenance prepends and the total caps at MAX_LABELS, so callers
// who pass 9-10 labels may lose the tail — supply <=8 to keep them all.
// An explicit caller-supplied `source:*` / `by:*` label always wins over
// the automatic stamp (existing labels are load-bearing; never renamed).
import { MAX_LABELS, cleanLabel } from '../routes/query/params'
import { currentScope } from './followons'

export const CREATE_SOURCES = ['mcp', 'paste', 'batch', 'relay'] as const
export type CreateSource = (typeof CREATE_SOURCES)[number]

export interface Provenance {
  source: CreateSource
  caller?: string
}

// The paste route's existing markers, spelled once so the route and the
// scheme cannot drift apart (paste.ts imports these; the preservation test
// pins them).
export const PASTE_SOURCE_LABEL = 'source:paste'
export const PASTE_UNTRIAGED_LABEL = 'paste:untriaged'

export function sourceLabel(source: CreateSource): string {
  return `source:${source}`
}

// Caller key → label-safe `by:<caller>`, or null when there is nothing
// worth stamping. Sanitized to LABEL_RE, lowercased for stable queries,
// capped so the label never exceeds 64 chars. Hostile input (spaces,
// bearer-shaped strings, punctuation runs) collapses to dashes — the raw
// value never lands verbatim.
export function callerLabel(caller: string | undefined): string | null {
  const raw = (caller ?? '').trim().toLowerCase()
  if (!raw || raw === 'unknown') return null
  const safe = raw
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
  if (!safe) return null
  const label = `by:${safe}`
  return cleanLabel(label)
}

// Caller key of the in-flight MCP request (OAuth clientId, `loopback-local`
// on the gateway path, `anonymous` fallback), or undefined outside one
// (unit tests, relay-internal calls). Relay paths pass no caller —
// `source:relay` alone says the bridge itself created the bead.
export function currentRequestCaller(): string | undefined {
  return currentScope()?.caller
}

const hasPrefix = (labels: string[], prefix: string): boolean =>
  labels.some((l) => l.toLowerCase().startsWith(prefix))

// Merge the automatic stamp into a caller label list. Provenance leads so
// it survives the MAX_LABELS cap; caller dimensions already present are
// respected, never duplicated.
export function withProvenance(labels: string[], provenance?: Provenance): string[] {
  if (!provenance) return labels
  const extra: string[] = []
  if (!hasPrefix(labels, 'source:')) extra.push(sourceLabel(provenance.source))
  const by = callerLabel(provenance.caller)
  if (by && !hasPrefix(labels, 'by:')) extra.push(by)
  return [...extra, ...labels].slice(0, MAX_LABELS)
}
