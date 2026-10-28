// Voice-misrecognition guard (feature-n7e): conditional two-step confirmation.
//
// Dictated requests sometimes carry a speech-to-text slip ("feed" for
// "bead"). The operator records confirmed slips in the glossary store; this
// module checks a guarded tool call's free-text arguments against that list
// BEFORE the tool runs. A clean call executes in one step, untouched. A
// flagged call is paused with nothing written: the caller gets the proposed
// correction and a token, then finishes with `voice_confirm` (accept the
// suggestion, keep the original wording, supply corrected arguments, or
// cancel). The confirmed call executes exactly once.
//
// WHERE IT HOOKS: `withVoiceGuard` wraps `server.registerTool` inside
// registerBridgeTools (mcp.ts) — the one place every tool callback is
// registered — so the SDK's own input validation has already run and no
// tool callback changes. Pause/confirm outcomes ride the existing response
// footer (ok()/err()) and the relay-status tracker the heartbeat reads.
//
// RULE SOURCE (documented in docs/voice-guard.md): open beads in the
// `glossary` store labelled `voice-transcription`. One rule per description
// line shaped like the operator's own phrasing:
//
//   - 'feed' (F) may mean 'bead' (B), particularly for Beads task records
//   - 'beat' may mean 'bead' in the same contexts.
//   - 'feed' may mean 'bead'; keep: status feed, inbox feed
//
// An optional `; keep: a, b` clause lists legitimate phrases that contain the
// heard word and must never be flagged. Everything else on a line (and every
// line that is not a rule) is prose and ignored. Rules are re-read at most
// every rulesTtlMs() (30 s), so a new glossary entry is live without a deploy.
//
// SAFETY: detection only ever PAUSES — it never rewrites a call by itself.
// A glossary read failure fails OPEN (the call runs; the footer says so):
// a broken glossary must not take down the bridge's write path.
import { createHash } from 'node:crypto'
import { relayStatus } from './relay-status'
import { currentScope } from './followons'
import { execStdout } from './exec'

export const VOICE_RULE_STORE = process.env.BEADS_BRIDGE_VOICE_STORE?.trim() || 'glossary'
export const VOICE_RULE_LABEL = 'voice-transcription'
export const DEFAULT_RULES_TTL_MS = 30_000
/** How long loaded rules are reused before the glossary is read again. */
export const rulesTtlMs = (): number => {
  const raw = process.env.BEADS_BRIDGE_VOICE_RULES_TTL_MS
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RULES_TTL_MS
}
/** An unanswered pause stays confirmable this long. */
export const PENDING_TTL_MS = 15 * 60_000
/** A settled request answers confirm retries (with the cached result) this long. */
export const SETTLED_RETAIN_MS = 10 * 60_000
/** Re-sending the identical original call this soon after it settled is a retry, not new work. */
export const RESUBMIT_WINDOW_MS = 2 * 60_000
const MAX_ENTRIES = 200
const MAX_RULES = 200

/** Tools whose arguments are checked: the ones that write bead text. */
export const VOICE_GUARDED_TOOLS = [
  'bead_comment', 'bead_note', 'bead_create', 'bead_batch_create', 'bead_edit',
  'project_edit', 'relay_capture', 'relay_upsert_task', 'relay_dispatch_request', 'relay_flow',
]
/** Argument names that carry free text. Ids, stores, labels and enums are never scanned. */
const TEXT_KEYS = new Set([
  'title', 'description', 'text', 'note', 'instruction',
  'task_title', 'task_description', 'dispatch_instruction',
])

export const voiceGuardEnabled = (): boolean => (process.env.BEADS_BRIDGE_VOICE_GUARD ?? '').trim().toLowerCase() !== 'off'

// ---- rules -----------------------------------------------------------------

export interface Misrecognition {
  heard: string
  meant: string
  keep: string[]
  /** Glossary bead id the rule came from. */
  source: string
}

const QUOTE = `["'‘’“”]`
const RULE_LINE = new RegExp(
  `^\\s*(?:[-*•]\\s*)?${QUOTE}([^"'‘’“”]{1,40})${QUOTE}(?:\\s*\\([^)]*\\))?\\s+may\\s+(?:also\\s+)?mean\\s+${QUOTE}([^"'‘’“”]{1,40})${QUOTE}(.*)$`,
  'i',
)
const KEEP_CLAUSE = /;\s*keep\s*:\s*(.+)$/i

/** Parse the rule lines out of one glossary description. */
export function parseMisrecognitions(description: string, source: string): Misrecognition[] {
  const out: Misrecognition[] = []
  for (const line of description.split(/\r?\n/)) {
    const m = RULE_LINE.exec(line)
    if (!m) continue
    const heard = m[1].trim()
    const meant = m[2].trim()
    if (!heard || !meant || heard.toLowerCase() === meant.toLowerCase()) continue
    const k = KEEP_CLAUSE.exec(m[3] ?? '')
    const keep = k ? k[1].split(',').map((s) => s.trim()).filter(Boolean) : []
    out.push({ heard, meant, keep, source })
  }
  return out
}

export type RuleSource = () => Promise<Misrecognition[]>

/** Rules from `<store> list --json` output (one description per bead). */
export function rulesFromListJson(stdout: string): Misrecognition[] {
  const rows = JSON.parse(stdout || '[]') as unknown
  if (!Array.isArray(rows)) throw new Error('glossary list was not a JSON array')
  const rules: Misrecognition[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (typeof r.description !== 'string') continue
    rules.push(...parseMisrecognitions(r.description, String(r.id ?? VOICE_RULE_STORE)))
  }
  return rules.slice(0, MAX_RULES)
}

/** Default source: open `voice-transcription` beads in the glossary store. */
export const glossaryRuleSource: RuleSource = async () =>
  rulesFromListJson(await execStdout(
    VOICE_RULE_STORE,
    ['list', '--json', '--limit', '0', '--label', VOICE_RULE_LABEL],
    5000,
  ))

let ruleSource: RuleSource = glossaryRuleSource
let ruleCache: { at: number; rules: Misrecognition[]; error?: string } | null = null
let ruleFlight: Promise<void> | null = null

/** Last rule-load failure, or null when the last load worked (footer + tests). */
export function voiceRulesError(): string | null {
  return ruleCache?.error ?? null
}

/** Rules, re-read at most every rulesTtlMs() (30 s); failure fails open with `error` set. */
export async function loadRules(now: number = Date.now()): Promise<{ rules: Misrecognition[]; error?: string }> {
  if (!ruleCache || now - ruleCache.at >= rulesTtlMs()) {
    ruleFlight ??= ruleSource()
      .then((rules) => { ruleCache = { at: now, rules } })
      .catch((e: unknown) => {
        const error = (e instanceof Error ? e.message : String(e)).slice(0, 160)
        ruleCache = { at: now, rules: [], error }
      })
      .finally(() => { ruleFlight = null })
    await ruleFlight
  }
  return { rules: ruleCache?.rules ?? [], ...(ruleCache?.error ? { error: ruleCache.error } : {}) }
}

/** Test seam: swap the rule source (null restores the glossary) and drop all state. */
export function resetVoiceGuard(source: RuleSource | null = null): void {
  ruleSource = source ?? glossaryRuleSource
  ruleCache = null
  ruleFlight = null
  entries.clear()
}

// ---- detection -------------------------------------------------------------

export interface Finding {
  /** Argument path, e.g. `title` or `beads[1].description`. */
  path: string
  /** The words as sent (original case). */
  heard: string
  /** The proposed replacement, case/plural-adapted. */
  meant: string
  source: string
  /** Where in the field value the match starts/ends. */
  index: number
  length: number
  /** A short quote around the match, for the caller to show the operator. */
  snippet: string
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')

function adaptCase(matched: string, meant: string): string {
  let out = meant
  if (/s$/i.test(matched) && !/s$/i.test(meant)) out = `${meant}s`
  const letters = matched.replace(/[^A-Za-z]/g, '')
  if (letters.length > 1 && letters === letters.toUpperCase()) return out.toUpperCase()
  if (/^[A-Z]/.test(matched)) return out.charAt(0).toUpperCase() + out.slice(1)
  return out
}

function scanText(path: string, value: string, rules: Misrecognition[]): Finding[] {
  const out: Finding[] = []
  for (const rule of rules) {
    // Mask `keep` phrases with same-length filler so match indexes stay true.
    let masked = value
    for (const phrase of rule.keep) {
      masked = masked.replace(new RegExp(`\\b${escapeRe(phrase)}\\b`, 'gi'), (s) => '\u0000'.repeat(s.length))
    }
    for (const m of masked.matchAll(new RegExp(`\\b${escapeRe(rule.heard)}(?:s)?\\b`, 'gi'))) {
      const index = m.index ?? 0
      const matched = value.slice(index, index + m[0].length)
      const from = Math.max(0, index - 24)
      out.push({
        path,
        heard: matched,
        meant: adaptCase(matched, rule.meant),
        source: rule.source,
        index,
        length: matched.length,
        snippet: `${from > 0 ? '…' : ''}${value.slice(from, index + matched.length + 24)}${index + matched.length + 24 < value.length ? '…' : ''}`,
      })
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.index - b.index))
}

/** Scan the free-text arguments of a call; empty = clean. */
export function findMisrecognitions(args: unknown, rules: Misrecognition[], path = ''): Finding[] {
  if (!rules.length) return []
  if (Array.isArray(args)) return args.flatMap((v, i) => findMisrecognitions(v, rules, `${path}[${i}]`))
  if (typeof args !== 'object' || args === null) return []
  const out: Finding[] = []
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k
    if (typeof v === 'string') {
      if (TEXT_KEYS.has(k)) out.push(...scanText(p, v, rules))
    } else if (typeof v === 'object' && v !== null) {
      out.push(...findMisrecognitions(v, rules, p))
    }
  }
  return out
}

function setAtPath(root: unknown, path: string, fn: (s: string) => string): void {
  const parts = path.match(/[^.[\]]+/g) ?? []
  let cur = root as Record<string, unknown>
  for (const part of parts.slice(0, -1)) cur = cur[part] as Record<string, unknown>
  const last = parts[parts.length - 1]
  cur[last] = fn(String(cur[last]))
}

/** A deep copy of `args` with every finding replaced by its suggestion. */
export function applySuggestions(args: unknown, findings: Finding[]): unknown {
  const copy = JSON.parse(JSON.stringify(args)) as unknown
  // Right-to-left per field so earlier indexes stay valid.
  for (const f of [...findings].sort((a, b) => b.index - a.index)) {
    setAtPath(copy, f.path, (s) => s.slice(0, f.index) + f.meant + s.slice(f.index + f.length))
  }
  return copy
}

// ---- pending confirmations --------------------------------------------------

export type VoiceDecision = 'accept' | 'original' | 'correct' | 'cancel'
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

interface Entry {
  token: string
  tool: string
  caller: string
  args: unknown
  findings: Finding[]
  createdAt: number
  state: 'pending' | 'executing' | 'done' | 'cancelled'
  decision?: VoiceDecision
  /** Hash of the arguments a `correct` decision ran with (retry equality). */
  correctedHash?: string
  settledAt?: number
  flight?: Promise<ToolResult>
  result?: ToolResult
}

const entries = new Map<string, Entry>()

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x)
const digest = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Deterministic token: the same caller re-sending the same call gets the same pending request. */
export function voiceToken(caller: string, tool: string, args: unknown): string {
  return `vg_${digest(`${caller}\u0000${tool}\u0000${stable(args)}`).slice(0, 12)}`
}

function prune(now: number): void {
  for (const [k, e] of entries) {
    const limit = e.state === 'pending' || e.state === 'executing' ? PENDING_TTL_MS : SETTLED_RETAIN_MS
    if (now - (e.settledAt ?? e.createdAt) > limit) entries.delete(k)
  }
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string)
}

const relayId = (token: string): string => `voice:${token}`

function open(tool: string, caller: string, args: unknown, findings: Finding[], now: number): Entry {
  prune(now)
  const token = voiceToken(caller, tool, args)
  const prev = entries.get(token)
  if (prev) {
    // A cancelled request is the operator's "no": re-sending it is a fresh ask.
    const live = prev.state === 'pending' || prev.state === 'executing'
    if (live || (prev.state === 'done' && now - (prev.settledAt ?? 0) < RESUBMIT_WINDOW_MS)) return prev
  }
  const entry: Entry = { token, tool, caller, args, findings, createdAt: now, state: 'pending' }
  entries.set(token, entry)
  const first = findings[0]
  relayStatus.touch({
    id: relayId(token),
    kind: 'verify',
    title: `voice check pending (${tool}): "${first.heard}" may mean "${first.meant}"`,
    needsVerify: true,
    now,
  })
  return entry
}

// ---- rendering ---------------------------------------------------------------

const text = (t: string): { type: 'text'; text: string } => ({ type: 'text', text: t })

function describeFinding(f: Finding): string {
  return `  - ${f.path}: "${f.heard}" may mean "${f.meant}" (${f.source}) — …${f.snippet}…`
}

export function renderPaused(e: Entry, now: number = Date.now()): ToolResult & { json: unknown } {
  const mins = Math.max(0, Math.ceil((e.createdAt + PENDING_TTL_MS - now) / 60_000))
  const lines = [
    `PAUSED — ${e.tool} was NOT executed; nothing was written. Possible voice misrecognition:`,
    ...e.findings.map(describeFinding),
    '',
    `Finish with voice_confirm { token: "${e.token}", decision: ... }:`,
    '  accept   — run with the suggested wording above',
    '  original — run exactly as sent (the flagged word is really intended)',
    '  correct  — run with your own `arguments` (full corrected argument object)',
    '  cancel   — drop it',
    `Re-sending the same ${e.tool} call returns this same pending request, never a second one. Expires in ~${mins} min.`,
  ]
  const json = {
    status: 'needs_confirmation',
    token: e.token,
    tool: e.tool,
    decisions: ['accept', 'original', 'correct', 'cancel'],
    findings: e.findings.map((f) => ({ path: f.path, heard: f.heard, suggested: f.meant, source: f.source, snippet: f.snippet })),
    expiresInMinutes: mins,
  }
  return { content: [text(lines.join('\n')), text(`voice_guard (JSON): ${JSON.stringify(json)}`)], json }
}

function renderSettled(e: Entry): string {
  if (e.state === 'cancelled') return `voice_confirm: ${e.token} was cancelled; ${e.tool} was not executed.`
  if (e.state === 'executing') return `voice_confirm: ${e.token} is already executing (${e.decision}); not re-run.`
  return `voice_confirm: ${e.token} already ${e.decision === 'original' ? 'executed as sent' : `executed (${e.decision})`}; ${e.tool} was NOT run again. Result of the first execution follows.`
}

// ---- the guard ---------------------------------------------------------------

type Handler = (args: unknown, extra: unknown) => Promise<ToolResult> | ToolResult
interface Registered { handler: Handler; schema: unknown }

export interface VoiceGuardHooks {
  /** Wrap plain text as a footered MCP result (mcp.ts ok()/err()). */
  ok: (t: string) => ToolResult
  err: (t: string) => ToolResult
}

export interface VoiceGuard<S> {
  /** The server to register tools on: guarded tools are wrapped, the rest pass through. */
  server: S
  /** The `voice_confirm` callback body. */
  confirm: (args: { token: string; decision: VoiceDecision; arguments?: unknown }, extra: unknown) => Promise<ToolResult>
}

export function withVoiceGuard<S extends object>(server: S, hooks: VoiceGuardHooks): VoiceGuard<S> {
  const registered = new Map<string, Registered>()
  const real = (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool.bind(server)

  const wrapped = {
    ...server,
    registerTool(name: string, config: { inputSchema?: unknown }, handler: Handler) {
      if (!VOICE_GUARDED_TOOLS.includes(name)) return real(name, config, handler)
      registered.set(name, { handler, schema: config.inputSchema })
      const guarded: Handler = async (args, extra) => {
        if (!voiceGuardEnabled()) return handler(args, extra)
        const { rules } = await loadRules()
        const findings = findMisrecognitions(args, rules)
        if (!findings.length) return handler(args, extra)
        const caller = currentScope()?.caller ?? 'anonymous'
        const entry = open(name, caller, args, findings, Date.now())
        if (entry.state === 'pending') {
          const p = renderPaused(entry)
          return { content: p.content.map((c, i) => (i === 0 ? text(hooks.ok(c.text).content[0].text) : c)) }
        }
        // Identical original re-sent right after it settled: a retry, not new work.
        const cached = entry.flight ? await entry.flight : entry.result
        return { content: [text(renderSettled(entry)), ...(cached?.content ?? [])], ...(cached?.isError ? { isError: true } : {}) }
      }
      return real(name, config, guarded)
    },
  } as unknown as S
  // `...server` copies own props only; keep prototype methods (connect, etc.) reachable.
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(server))

  async function confirm(
    args: { token: string; decision: VoiceDecision; arguments?: unknown },
    extra: unknown,
  ): Promise<ToolResult> {
    const now = Date.now()
    prune(now)
    const caller = currentScope()?.caller ?? 'anonymous'
    const e = entries.get(args.token)
    if (!e || e.caller !== caller) {
      return hooks.err(`voice_confirm: no pending request for token "${args.token}" (unknown, expired, or not yours). Nothing was executed — re-send the original call.`)
    }
    const correctedHash = args.decision === 'correct' ? digest(stable(args.arguments ?? null)) : undefined

    // Settled or in flight: answer a retry with the cached outcome, never run twice.
    if (e.state !== 'pending') {
      const same = e.decision === args.decision && e.correctedHash === correctedHash
      if (!same) {
        return hooks.err(`voice_confirm: ${args.token} is already ${e.state} as "${e.decision}"; "${args.decision}" was ignored and nothing was re-executed.`)
      }
      const cached = e.flight ? await e.flight : e.result
      return { content: [text(renderSettled(e)), ...(cached?.content ?? [])], ...(cached?.isError ? { isError: true } : {}) }
    }

    if (args.decision === 'cancel') {
      e.state = 'cancelled'
      e.decision = 'cancel'
      e.settledAt = now
      relayStatus.markDone(relayId(e.token), now)
      return hooks.ok(`voice_confirm: cancelled ${e.token}; ${e.tool} was not executed and nothing was written.`)
    }

    const reg = registered.get(e.tool)
    if (!reg) return hooks.err(`voice_confirm: tool ${e.tool} is no longer available; nothing was executed.`)

    let candidate: unknown
    if (args.decision === 'original') candidate = e.args
    else if (args.decision === 'accept') candidate = applySuggestions(e.args, e.findings)
    else {
      if (typeof args.arguments !== 'object' || args.arguments === null || Array.isArray(args.arguments)) {
        return hooks.err(`voice_confirm: decision "correct" needs \`arguments\` — the full corrected argument object for ${e.tool}. Nothing was executed; ${e.token} is still pending.`)
      }
      candidate = args.arguments
    }
    // The SDK validated the ORIGINAL args; corrected/substituted ones have not been.
    let run = candidate
    const schema = reg.schema as { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } } } | undefined
    if (schema?.safeParse && args.decision !== 'original') {
      const parsed = schema.safeParse(candidate)
      if (!parsed.success) {
        return hooks.err(`voice_confirm: the ${args.decision === 'accept' ? 'suggested' : 'corrected'} arguments are invalid for ${e.tool}: ${(parsed.error?.message ?? 'schema mismatch').slice(0, 300)}. Nothing was executed; ${e.token} is still pending.`)
      }
      run = parsed.data
    }

    e.state = 'executing'
    e.decision = args.decision
    e.correctedHash = correctedHash
    // Executed exactly once: concurrent/retried confirms await this same flight.
    e.flight = Promise.resolve().then(() => reg.handler(run, extra))
    let result: ToolResult
    try {
      result = await e.flight
    } catch (err) {
      // The tool threw: nothing is known to have landed, so the request stays confirmable.
      e.state = 'pending'
      e.decision = undefined
      e.correctedHash = undefined
      e.flight = undefined
      throw err
    }
    if (result.isError) {
      // A failed execution may be retried with the same confirm (the tools' own
      // idempotency — operation_id, ikey — converges a partial write).
      e.state = 'pending'
      e.decision = undefined
      e.correctedHash = undefined
      e.flight = undefined
      return { ...result, content: [text(`voice_confirm: ${e.tool} reported an error; ${e.token} is still pending and can be confirmed again.`), ...result.content] }
    }
    e.state = 'done'
    e.result = result
    e.settledAt = Date.now()
    relayStatus.markDone(relayId(e.token), e.settledAt)
    return {
      ...result,
      content: [text(`voice_confirm: executed ${e.tool} once (${args.decision}; ${e.token}).`), ...result.content],
    }
  }

  return { server: wrapped, confirm }
}

/** One footer line when the glossary could not be read (fail-open must be visible). */
export function voiceFooterLine(tool: string): string | null {
  const error = voiceRulesError()
  if (!error || !VOICE_GUARDED_TOOLS.includes(tool) || !voiceGuardEnabled()) return null
  return `voice-guard: glossary rules unavailable (${error}) — this call was not checked for misrecognitions.`
}
