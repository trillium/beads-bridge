// whoami: the bridge's answer to "who am I here". Server identity plus
// the caller's auth context (client id, scopes, token expiry), the stored
// operator profile (editable via identity_update), and the environment
// summary — everything an agent needs to orient, nothing secret (token
// VALUES are never echoed).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scratchpadPath } from './scratchpad'

// Who Am I resume context: bounded tail of the operator's scratchpad so a
// fresh session receives current working state without a separate lookup.
// Caps: at most WHOAMI_NOTES_MAX_ENTRIES newest entries plus up to
// WHOAMI_NOTES_MAX_RESUME older resume-marker entries, and never more than
// WHOAMI_NOTES_MAX_BYTES total — so the block stays ~2KB no matter how long
// the scratchpad gets (one scratchpad entry is itself capped at 2000 chars,
// so the byte cap alone bounds even a single huge note).
export const WHOAMI_NOTES_MAX_ENTRIES = 5
export const WHOAMI_NOTES_MAX_RESUME = 2
export const WHOAMI_NOTES_MAX_BYTES = 2000
// Recall over cleverness: a missed PAUSED note is the failure mode that
// matters. Strong markers are explicit resume state (bonus slot AND last to
// be evicted); weak markers are likely edit/decision/next-step context
// (bonus slot when there is room, first to go under byte pressure).
export const WHOAMI_RESUME_STRONG_RE = /\b(paused|resume|resumed|resuming)\b/i
export const WHOAMI_RESUME_WEAK_RE = /\b(next|decision|decided|edits?|edited)\b/i

export interface WhoamiNote {
  // 1-based line ordinal within the scratchpad — labelled as an ordinal,
  // not a durable id (entries today have no ids; ordinals shift on clear).
  ordinal: number
  // Raw scratchpad line (`- <ISO timestamp> <text>`).
  line: string
}

export interface WhoamiAuth {
  clientId: string
  scopes: string[]
  expiresAt?: number
  audience?: string
}

export interface WhoamiInfo {
  server: string
  version: string
  base: string
  auth?: WhoamiAuth
  operator?: OperatorProfile
  stores: string[]
  // Durable personality document (task-xqj24): the complete operator-
  // controlled bootstrap record. Rendered in full — this is the point.
  personalityDoc?: string
  // Bounded scratchpad tail (attached only for authenticated callers —
  // never populated on the unauthenticated path, so no new leak surface).
  recentNotes?: WhoamiNote[]
  scratchTotal?: number
}

export interface OperatorProfile {
  name?: string
  role?: string
  timezone?: string
  notes?: string
  // Structured agent posture: how the agent presents and operates, kept as
  // plain strings (same 500-char cap as the base fields) so the existing
  // string-only sanitizer/update path applies unchanged — a principles list
  // is newline/semicolon-separated text, not an array, to avoid silent
  // flatten/drop and keep every-whoami parsing cheap.
  // Legacy canonical home (task-xqj24): notes + posture migrate verbatim
  // into the personality document, which clears them here; the fields stay
  // writable for compatibility and still render when set.
  personality?: string
  communication?: string
  principles?: string
  relationship?: string
  relay_stance?: string
}

const PROFILE_FIELDS = [
  'name',
  'role',
  'timezone',
  'notes',
  'personality',
  'communication',
  'principles',
  'relationship',
  'relay_stance',
] as const

export function identityPath(): string {
  return process.env.IDENTITY_PATH ??
    join(process.env.HOME ?? tmpdir(), '.config', 'pai', 'beads-bridge-identity.json')
}

export function loadProfile(): OperatorProfile {
  try {
    if (!existsSync(identityPath())) return {}
    const d = JSON.parse(readFileSync(identityPath(), 'utf8')) as Record<string, unknown>
    const out: OperatorProfile = {}
    for (const f of PROFILE_FIELDS) if (typeof d[f] === 'string' && d[f]) out[f] = (d[f] as string).slice(0, 500)
    return out
  } catch {
    return {}
  }
}

// Merge provided fields (empty string clears); unknown fields rejected.
export function updateProfile(patch: Record<string, unknown>): { profile: OperatorProfile; bad: string[] } {
  const current = loadProfile()
  const bad = Object.keys(patch).filter((k) => !(PROFILE_FIELDS as readonly string[]).includes(k))
  const next: OperatorProfile = { ...current }
  for (const f of PROFILE_FIELDS) {
    if (!(f in patch)) continue
    const v = patch[f]
    if (typeof v !== 'string') continue
    const t = v.trim().slice(0, 500)
    if (t) next[f] = t
    else delete next[f]
  }
  const p = identityPath()
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 })
  return { profile: next, bad }
}

export function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'dev'
  } catch {
    return 'dev'
  }
}

// Newest N entries plus up to M older resume-marker extras, chronological.
// Pure over caller-supplied lines (ordinals are 1-based positions in that
// array). Strong extras are never evicted by the byte cap while any other
// entry remains; weak extras go first; routine entries go oldest-first.
export function selectWhoamiNotes(all: string[]): WhoamiNote[] {
  if (!all.length) return []
  const withOrd = all.map((line, i) => ({ ordinal: i + 1, line }))
  const newest = withOrd.slice(-WHOAMI_NOTES_MAX_ENTRIES)
  const inNewest = new Set(newest.map((n) => n.ordinal))
  const older = withOrd.filter((n) => !inNewest.has(n.ordinal))
  const strong = older.filter((n) => WHOAMI_RESUME_STRONG_RE.test(n.line)).slice(-WHOAMI_NOTES_MAX_RESUME)
  const strongSet = new Set(strong.map((n) => n.ordinal))
  const weakRoom = WHOAMI_NOTES_MAX_RESUME - strong.length
  const weak = weakRoom > 0
    ? older.filter((n) => !strongSet.has(n.ordinal) && WHOAMI_RESUME_WEAK_RE.test(n.line)).slice(-weakRoom)
    : []
  const weakSet = new Set(weak.map((n) => n.ordinal))
  const sel = [...newest, ...strong, ...weak].sort((a, b) => a.ordinal - b.ordinal)
  const bytes = () => sel.map((n) => n.line).join('\n').length
  while (sel.length > 1 && bytes() > WHOAMI_NOTES_MAX_BYTES) {
    let idx = sel.findIndex((n) => weakSet.has(n.ordinal))
    if (idx === -1) idx = sel.findIndex((n) => !strongSet.has(n.ordinal))
    sel.splice(idx === -1 ? 0 : idx, 1)
  }
  if (bytes() > WHOAMI_NOTES_MAX_BYTES) {
    // One entry alone exceeds the cap: truncate its text (timestamp intact)
    // rather than drop resume state.
    sel[0].line = `${sel[0].line.slice(0, WHOAMI_NOTES_MAX_BYTES - 4)} […]`
  }
  return sel
}

export function formatWhoamiNotes(notes: WhoamiNote[], total: number): string {
  if (!notes.length) return ''
  const lines = notes.map((n) => `- [#${n.ordinal}] ${n.line.replace(/^-\s*/, '')}`)
  return [`recent notes (scratchpad, ${notes.length} of ${total}):`, ...lines].join('\n')
}

// Read-only tail for Who Am I: absent/empty/unreadable degrades to [].
// Reads the file directly (no ensure/create side effect — a read must not
// create the operator's scratchpad as a side effect of asking whoami).
export function readWhoamiNotes(): { notes: WhoamiNote[]; total: number } {
  try {
    const raw = readFileSync(scratchpadPath(), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
    return { notes: selectWhoamiNotes(raw), total: raw.length }
  } catch {
    return { notes: [], total: 0 }
  }
}

export function formatWhoami(info: WhoamiInfo): string {
  const lines = [
    `# whoami — ${info.server}`,
    ``,
    `server: ${info.server} v${info.version} (streamable http, ${info.base}/mcp)`,
  ]
  if (info.auth) {
    lines.push(
      `you are: OAuth client ${info.auth.clientId} (scopes: ${info.auth.scopes.join(' ') || '(none)'})`,
      `token: ${info.auth.expiresAt ? `expires ${new Date(info.auth.expiresAt).toISOString()}` : 'no expiry on file'}` +
        (info.auth.audience ? `, audience ${info.auth.audience}` : ''),
    )
  } else {
    lines.push(`you are: unauthenticated (auth is required, so you should not see this)`)
  }
  const op = info.operator ?? {}
  const opBits = [`name: ${op.name ?? '(unset)'}`, `role: ${op.role ?? '(unset)'}` +
    (op.timezone ? `, timezone: ${op.timezone}` : '')]
  lines.push(`operator: ${opBits.join(' | ')}` + (op.notes ? `\noperator notes: ${op.notes}` : ''))
  // Posture renders only when set: old files (or profiles without posture)
  // render exactly as before, and empty posture adds zero context bloat.
  const posture: Array<[string, string | undefined]> = [
    ['personality', op.personality],
    ['communication', op.communication],
    ['principles', op.principles],
    ['relationship', op.relationship],
    ['relay_stance', op.relay_stance],
  ]
  for (const [k, v] of posture) if (v) lines.push(`posture ${k}: ${v}`)
  // The personality document is the canonical operating record: always the
  // complete text, never truncated or capped.
  if (info.personalityDoc) {
    lines.push(
      `operator document (personality, ${info.personalityDoc.length} chars, full text):`,
      info.personalityDoc,
    )
  }
  // Resume context renders only when notes are attached (authenticated
  // callers): absent/empty degrades to nothing — no heading, no error.
  if (info.recentNotes?.length) lines.push(formatWhoamiNotes(info.recentNotes, info.scratchTotal ?? info.recentNotes.length))
  lines.push(
    ``,
    `stores: ${info.stores.length} queryable (${info.stores.join(', ')})`,
    `you can: read (show, bundle, query, connections), write (comment, note, label, decision, create, feedback), relay (resolve/list projects, capture, upsert task, dispatch request, verify, flow)`,
    `tool catalog: your tools/list snapshot — this server re-serves it fresh every request`,
  )
  return lines.join('\n')
}
