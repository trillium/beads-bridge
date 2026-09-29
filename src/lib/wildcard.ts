// Wildcard capability interface (inbox-hkfd): one stable MCP outer tool
// (`capability`) backed by a registry of named, contract-bearing
// sub-capabilities. Adding a sub-capability never changes the MCP tool
// schema ChatGPT loads — discovery (search/list/describe) + invocation
// (invoke) both flow through the single outer tool.
//
// What this is NOT: a general arbitrary-tool or arbitrary-code execution
// endpoint. The registry below is a static, compiled-in allowlist — each
// entry names a TypeScript handler in this module, never another MCP tool
// and never caller-supplied code. New abilities land here only via code
// review + deploy, exactly like a new top-level MCP tool; the difference
// is the client's loaded schema stays frozen. There is no capability type
// that references an op name, a shell command, or an eval string, so one
// cannot be registered even by accident.
//
// Authorization: the `capability` tool is registered inside the same
// createMcpHandler server as every other tool, behind the same
// withMcpAuth(required: true) bearer gate and the public-ingress access
// gate (src/lib/access-gate.ts). No new route, no gate change, no caller
// escalation — handlers receive the authenticated caller name for
// attribution (provenance in results) and run with the ambient server
// authority of any other tool handler. Pure functions + tiny IO.
import { serverVersion } from './whoami'
import { loadManifest } from './capabilities'
import { scratchAppend } from './scratchpad'

export type WildcardEffect = 'read' | 'write'

export type WildcardParamType = 'string' | 'integer' | 'number' | 'boolean'

export type WildcardParam = {
  name: string
  type: WildcardParamType
  required: boolean
  description: string
  maxLength?: number
  minimum?: number
  maximum?: number
}

export type WildcardContext = {
  /** Authenticated caller name (for attribution in receipts/provenance). */
  caller: string
}

export type WildcardRunResult = {
  /** Rendered markdown body of the result. */
  text: string
  /** Structured receipt — required when effect is 'write'. */
  receipt?: Record<string, string | number | boolean>
}

export type WildcardDef = {
  /** Stable identifier: ^[a-z][a-z0-9_]{2,49}$, never renamed once shipped. */
  id: string
  title: string
  description: string
  /** Semver the capability shipped in (inner growth versions independently). */
  version: string
  /** 'read' = no side effects; 'write' = mutates state, returns a receipt. */
  effect: WildcardEffect
  keywords: string[]
  params: WildcardParam[]
  maxPayloadChars: number
  run: (input: Record<string, string | number | boolean>, ctx: WildcardContext) => Promise<WildcardRunResult> | WildcardRunResult
}

export const WILDCARD_ID_RE = /^[a-z][a-z0-9_]{2,49}$/
export const WILDCARD_MAX_RESULTS = 10
const ERROR_CHAR_CAP = 2000

function provenanceLine(def: WildcardDef, ctx: WildcardContext): string {
  let manifest = 'unknown'
  try {
    manifest = String(loadManifest().manifestVersion)
  } catch { /* keep unknown */ }
  return `provenance: backend v${serverVersion()} / manifest v${manifest} / capability ${def.id} ${def.version} / by ${ctx.caller}`
}

const wildcardRegistry: WildcardDef[] = [
  {
    id: 'resume_resolve',
    title: 'Resolve resume manifest to rendered content with atom provenance',
    description:
      'Resolves a resume manifest (e.g. resumes-zak) to the exact rendered/sent resume ' +
      'with atom provenance: resolved content per section/bullet, the bead ID and store per ' +
      'fragment, confirmation status per bead, an explicitly COMPUTED unresolved[] list, and ' +
      'the sent artefact filename plus content hash. Takes only the manifest id and resolves ' +
      'internally (thin wrapper over gate_lib.resolve_used() plus restyled-JSON bead ' +
      'extraction) — the caller must NOT supply bead ids, because manifest refs are YAML ' +
      'atom paths / external_ref suffixes, never bead titles, so title search cannot perform ' +
      'the lookup. Read-only. STATUS: contract registered, execution not yet implemented — ' +
      'the resolver needs manifest hygiene first (point the manifest at the sent beads, ' +
      'correct the stale education resolved flag, record the sent artefact pointer); see ' +
      'the resume-resolved-provenance investigation report. Invoking now fails explicitly.',
    version: '1.6.0',
    effect: 'read',
    keywords: ['resume', 'resumes-zak', 'manifest', 'resolve', 'rendered', 'sent', 'atom', 'provenance', 'bead', 'confirmation', 'artefact', 'coder', 'content', 'hash'],
    params: [
      {
        name: 'manifest_id',
        type: 'string',
        required: true,
        description: 'Resume manifest id, e.g. resumes-zak (max 120 chars)',
        maxLength: 120,
      },
    ],
    maxPayloadChars: 500,
    run: () => {
      throw new Error(
        'resume_resolve is not yet implemented: pending the manifest hygiene work in the ' +
        'resume-resolved-provenance report (manifest refs do not equal sent beads, one ' +
        'resolved flag is stale, no artefact pointer is recorded). Building the execution ' +
        'now would resolve the wrong content. Contract is final; execution follows that work.',
      )
    },
  },
  {
    id: 'echo_probe',
    title: 'Echo probe (read-only demonstration)',
    description:
      'Demonstration read capability: echoes a bounded message back with bridge provenance. ' +
      'Use it to prove discovery + invocation work end to end without touching any state. ' +
      'The intended first real capability is the resume resolver (resolves a resume manifest ' +
      'to rendered content with atom provenance), pending the resume-resolved-provenance investigation.',
    version: '1.6.0',
    effect: 'read',
    keywords: ['echo', 'probe', 'demo', 'test', 'ping', 'read'],
    params: [
      {
        name: 'message',
        type: 'string',
        required: true,
        description: 'Message to echo back (max 2000 chars)',
        maxLength: 2000,
      },
    ],
    maxPayloadChars: 4000,
    run: (input) => ({ text: `echo: ${String(input.message)}` }),
  },
  {
    id: 'write_probe',
    title: 'Write probe (namespaced scratchpad demonstration)',
    description:
      'Demonstration WRITE capability: appends one namespaced, caller-attributed probe line ' +
      'to the operator scratchpad (same sink as the scratchpad tool, reversible with it). ' +
      'Use it to prove the write classification + structured receipts work end to end. ' +
      'Effect is write: invoking it mutates state.',
    version: '1.6.0',
    effect: 'write',
    keywords: ['write', 'probe', 'demo', 'test', 'scratchpad', 'append', 'mutate'],
    params: [
      {
        name: 'note',
        type: 'string',
        required: true,
        description: 'Probe note to append (max 500 chars)',
        maxLength: 500,
      },
    ],
    maxPayloadChars: 2000,
    run: (input, ctx) => {
      const at = new Date().toISOString()
      const r = scratchAppend(`[capability write_probe by ${ctx.caller}] ${String(input.note)}`)
      return {
        text: `appended probe note to the scratchpad (${r.entries} entries total).`,
        receipt: { path: r.path, entries: r.entries, at, capability: 'write_probe', by: ctx.caller },
      }
    },
  },
]

/** The full registry (a copy — callers must not mutate the allowlist). */
export function listWildcards(): WildcardDef[] {
  return [...wildcardRegistry]
}

/** Exact id lookup (invocation path: never fuzzy — ids are stable). */
export function findWildcard(id: string): WildcardDef | undefined {
  return wildcardRegistry.find((d) => d.id === id)
}

export type WildcardHit = {
  def: WildcardDef
  score: number
  matchedOn: string[]
}

function tokensOf(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 0)
}

/**
 * Intent search over the registry: token overlap against id / title /
 * description / keywords, highest score first, capped. Empty query yields
 * no hits (use list instead) — never an error, never everything.
 */
export function searchWildcards(query: string): WildcardHit[] {
  const tokens = tokensOf(query)
  if (!tokens.length) return []
  const hits: WildcardHit[] = []
  for (const def of wildcardRegistry) {
    let score = 0
    const matchedOn: string[] = []
    const idTokens = tokensOf(def.id)
    const titleTokens = new Set(tokensOf(def.title))
    const descTokens = new Set(tokensOf(def.description))
    const kwSet = new Set(def.keywords.map((k) => k.toLowerCase()))
    for (const t of tokens) {
      if (def.id === t) { score += 100; matchedOn.push(`id:${t}`); continue }
      if (def.id.includes(t)) { score += 10; matchedOn.push(`id:${t}`); continue }
      if (kwSet.has(t)) { score += 8; matchedOn.push(`keyword:${t}`); continue }
      if (idTokens.includes(t)) { score += 6; matchedOn.push(`id:${t}`); continue }
      if (titleTokens.has(t)) { score += 5; matchedOn.push(`title:${t}`); continue }
      if ([...kwSet].some((k) => k.includes(t) && t.length >= 3)) { score += 3; matchedOn.push(`keyword~:${t}`); continue }
      if (descTokens.has(t)) { score += 2; matchedOn.push(`description:${t}`); continue }
    }
    if (score > 0) hits.push({ def, score, matchedOn: [...new Set(matchedOn)] })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, WILDCARD_MAX_RESULTS)
}

export type WildcardInputError = { ok: false; message: string }
export type WildcardInputOk = { ok: true; value: Record<string, string | number | boolean> }

/**
 * Strict per-capability payload validation: plain object only, required
 * params present, declared types honored, unknown keys REJECTED (the
 * payload is validated against the selected capability's own contract,
 * never a free-for-all).
 */
export function validateWildcardInput(def: WildcardDef, payload: unknown): WildcardInputOk | WildcardInputError {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: `invoke ${def.id}: payload must be a JSON object, got ${Array.isArray(payload) ? 'array' : String(payload === null ? 'null' : typeof payload)}` }
  }
  let size = 0
  try {
    size = JSON.stringify(payload).length
  } catch {
    return { ok: false, message: `invoke ${def.id}: payload is not JSON-serializable` }
  }
  if (size > def.maxPayloadChars) {
    return { ok: false, message: `invoke ${def.id}: payload is ${size} chars, max ${def.maxPayloadChars}` }
  }
  const obj = payload as Record<string, unknown>
  const byName = new Map(def.params.map((p) => [p.name, p]))
  const unknownKeys = Object.keys(obj).filter((k) => !byName.has(k))
  if (unknownKeys.length) {
    return { ok: false, message: `invoke ${def.id}: unknown param(s): ${unknownKeys.join(', ')} (contract: ${def.params.map((p) => p.name).join(', ') || '(none)'})` }
  }
  const value: Record<string, string | number | boolean> = {}
  for (const p of def.params) {
    const v = obj[p.name]
    if (v === undefined) {
      if (p.required) return { ok: false, message: `invoke ${def.id}: missing required param '${p.name}' (${p.type})` }
      continue
    }
    switch (p.type) {
      case 'string':
        if (typeof v !== 'string') return { ok: false, message: `invoke ${def.id}: param '${p.name}' must be a string` }
        if (p.maxLength != null && v.length > p.maxLength) {
          return { ok: false, message: `invoke ${def.id}: param '${p.name}' is ${v.length} chars, max ${p.maxLength}` }
        }
        value[p.name] = v
        break
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, message: `invoke ${def.id}: param '${p.name}' must be an integer` }
        if (p.minimum != null && v < p.minimum) return { ok: false, message: `invoke ${def.id}: param '${p.name}' below minimum ${p.minimum}` }
        if (p.maximum != null && v > p.maximum) return { ok: false, message: `invoke ${def.id}: param '${p.name}' above maximum ${p.maximum}` }
        value[p.name] = v
        break
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, message: `invoke ${def.id}: param '${p.name}' must be a finite number` }
        if (p.minimum != null && v < p.minimum) return { ok: false, message: `invoke ${def.id}: param '${p.name}' below minimum ${p.minimum}` }
        if (p.maximum != null && v > p.maximum) return { ok: false, message: `invoke ${def.id}: param '${p.name}' above maximum ${p.maximum}` }
        value[p.name] = v
        break
      case 'boolean':
        if (typeof v !== 'boolean') return { ok: false, message: `invoke ${def.id}: param '${p.name}' must be a boolean` }
        value[p.name] = v
        break
    }
  }
  return { ok: true, value }
}

export type WildcardInvokeOk = {
  ok: true
  id: string
  effect: WildcardEffect
  text: string
  receipt?: Record<string, string | number | boolean>
}

export type WildcardInvokeErr = {
  ok: false
  code: 'unknown_capability' | 'invalid_payload' | 'payload_too_large' | 'capability_failed'
  message: string
  hint?: string
}

/** Invoke a registered capability by stable id with a structured payload. */
export async function invokeWildcard(
  id: string,
  payload: unknown,
  ctx: WildcardContext,
): Promise<WildcardInvokeOk | WildcardInvokeErr> {
  const clean = id.trim()
  if (!clean) {
    return { ok: false, code: 'unknown_capability', message: 'invoke: empty capability id', hint: 'capability action=list shows every registered id' }
  }
  const def = findWildcard(clean)
  if (!def) {
    const sug = wildcardRegistry.filter((d) => d.id.includes(clean) || clean.includes(d.id)).map((d) => d.id).slice(0, 3)
    return {
      ok: false,
      code: 'unknown_capability',
      message: `invoke: unknown capability '${clean}' (${wildcardRegistry.length} registered)`,
      hint: sug.length ? `did you mean: ${sug.join(', ')}?` : 'capability action=search with a natural-language intent finds the right id',
    }
  }
  const validated = validateWildcardInput(def, payload)
  if (!validated.ok) {
    const tooLarge = validated.message.includes('max') && validated.message.includes('payload is')
    return {
      ok: false,
      code: tooLarge ? 'payload_too_large' : 'invalid_payload',
      message: validated.message,
      hint: `capability action=describe id=${def.id} shows the contract`,
    }
  }
  try {
    const r = await def.run(validated.value, ctx)
    if (def.effect === 'write' && !r.receipt) {
      return { ok: false, code: 'capability_failed', message: `invoke ${def.id}: write capability returned no receipt — refusing an unverified write` }
    }
    return { ok: true, id: def.id, effect: def.effect, text: r.text, receipt: r.receipt }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, code: 'capability_failed', message: `invoke ${def.id} failed: ${msg.slice(0, ERROR_CHAR_CAP)}` }
  }
}

function effectLine(def: WildcardDef): string {
  return def.effect === 'write'
    ? `effect: WRITE — invoking this mutates state and returns a structured receipt`
    : `effect: read-only — invoking this changes nothing`
}

function contractLines(def: WildcardDef): string[] {
  if (!def.params.length) return ['params: (none)']
  return [
    'params:',
    ...def.params.map(
      (p) =>
        `- ${p.name} (${p.type}${p.required ? ', required' : ', optional'}${p.maxLength != null ? `, max ${p.maxLength} chars` : ''}${p.minimum != null ? `, min ${p.minimum}` : ''}${p.maximum != null ? `, max ${p.maximum}` : ''}): ${p.description}`,
    ),
  ]
}

export function formatWildcardList(): string {
  const defs = listWildcards()
  return [
    `# capability — list (${defs.length} registered)`,
    ``,
    `New abilities appear here WITHOUT a client tool-schema refresh: re-run list or search to notice them.`,
    `Read each entry's effect line BEFORE invoking — write capabilities mutate state.`,
    ``,
    ...defs.map((d) => `- ${d.id} — ${d.title} [${d.effect}] (v${d.version})`),
    ``,
    `Next: capability action=describe id=<id> for the full contract, or action=search query="<intent>" to find one.`,
  ].join('\n')
}

export function formatWildcardSearch(query: string, hits: WildcardHit[]): string {
  if (!hits.length) {
    return [
      `# capability — search "${query}"`,
      ``,
      `No registered capability matches. Try fewer / different words, or action=list to browse all ${listWildcards().length}.`,
    ].join('\n')
  }
  return [
    `# capability — search "${query}" (${hits.length} match${hits.length === 1 ? '' : 'es'})`,
    ``,
    ...hits.flatMap((h) => [
      `- ${h.def.id} — ${h.def.title} [${h.def.effect}] (v${h.def.version}, matched: ${h.matchedOn.slice(0, 3).join(', ')})`,
      `  ${h.def.description.slice(0, 220)}${h.def.description.length > 220 ? '…' : ''}`,
    ]),
    ``,
    `Check the effect tag BEFORE invoking. Next: action=describe id=<id>, then action=invoke id=<id> payload={<…>}.`,
  ].join('\n')
}

export function formatWildcardDescribe(def: WildcardDef): string {
  return [
    `# capability — describe ${def.id}`,
    ``,
    `${def.title} (v${def.version})`,
    effectLine(def),
    ``,
    def.description,
    ``,
    ...contractLines(def),
    ``,
    `Invoke with: action=invoke id=${def.id} payload={<params as a JSON object>}. Unknown params are rejected; payloads over ${def.maxPayloadChars} chars are rejected.`,
  ].join('\n')
}

export function formatWildcardUnknownDescribe(id: string): string {
  const sug = wildcardRegistry.filter((d) => d.id.includes(id) || (id && id.includes(d.id))).map((d) => d.id).slice(0, 3)
  return [
    `# capability — describe ${id}`,
    ``,
    `Unknown capability id.`,
    sug.length ? `Did you mean: ${sug.join(', ')}?` : `Try action=search with a natural-language intent, or action=list to browse.`,
  ].join('\n')
}

export function formatWildcardInvoke(result: WildcardInvokeOk | WildcardInvokeErr, ctx: WildcardContext): string {
  if (!result.ok) {
    return [
      `# capability — invoke failed (${result.code})`,
      ``,
      result.message,
      ...(result.hint ? [``, result.hint] : []),
    ].join('\n')
  }
  const def = findWildcard(result.id)
  const lines = [
    `# capability — invoke ${result.id} (${result.effect})`,
    ``,
    result.text,
  ]
  if (result.receipt) {
    lines.push(
      ``,
      `receipt:`,
      ...Object.entries(result.receipt).map(([k, v]) => `- ${k}: ${String(v)}`),
    )
  }
  if (def) lines.push(``, provenanceLine(def, ctx))
  return lines.join('\n')
}
