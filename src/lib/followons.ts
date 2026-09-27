// Generalized post-action hook / action-chain mechanism (brain-5eq4n,
// task-ksmy1): any MCP tool action can trigger configurable follow-on
// actions. Answers the design questions from brain-5eq4n:
//
// - Triggers: per-tool-name match (tools[]) or all-tools default, plus an
//   excludeTools[] deny-list. Declarative data, not code per tool.
// - Conditions: outcome filter (outcomes: ok and/or error).
// - Ordering: deterministic — priority ascending, ties broken by name.
//   Inspectable via listFollowons().
// - Context passing: every follow-on receives FollowonContext
//   { tool, outcome, caller, at } — no re-deriving state.
// - Failure handling: each follow-on runs isolated in try/catch. A throw
//   records the spec name in `failed` and the original result is returned
//   unchanged — a broken follow-on never alters the tool outcome.
// - Loop prevention (explicit, layered):
//   1. Follow-ons return footer TEXT, never tool calls — chains are
//      terminal by construction (max depth 1).
//   2. Re-entrancy guard: runFollowons refuses to run while a run is
//      active (a follow-on composing a footer gets an empty result).
//   3. Bare responses (heartbeat, relay_status, timeout_probe) skip
//      footer composition entirely, so footer output can never fire a
//      follow-on (see HEARTBEAT_EXCLUDED_TOOLS in heartbeat.ts).
import { AsyncLocalStorage } from 'node:async_hooks'
import { formatRelayBody } from './relay-status'
import { stalenessTriple } from './capabilities'
import { renderHeartbeatBlock } from './heartbeat'

export type FollowonOutcome = 'ok' | 'error'

export interface FollowonContext {
  /** MCP op name, or 'unknown' when the request envelope was unparseable. */
  tool: string
  outcome: FollowonOutcome
  /** Heartbeat cursor key: OAuth clientId | loopback-local | anonymous. */
  caller: string
  /** Composition start, ms epoch (the cursor advance for acknowledging reads). */
  at: number
}

export interface FollowonSpec {
  name: string
  /** Lower runs first; ties broken by name. Deterministic + inspectable. */
  priority: number
  /** Match these ops; omitted = every tool. */
  tools?: string[]
  /** Never fire for these ops (loop-prevention surface). */
  excludeTools?: string[]
  /** Omitted = fire on both ok and error outcomes. */
  outcomes?: FollowonOutcome[]
  /** Footer lines (sync + pure: read-only, never mutates stores). */
  run: (ctx: FollowonContext) => string[] | string | null
}

export interface FollowonResult {
  lines: string[]
  failed: string[]
}

const registry = new Map<string, FollowonSpec>()

/** Register (or replace) a follow-on spec. Last registration wins per name. */
export function registerFollowon(spec: FollowonSpec): void {
  registry.set(spec.name, spec)
}

/** Deterministic registry snapshot: priority asc, then name asc. */
export function listFollowons(): FollowonSpec[] {
  return [...registry.values()].sort(
    (a, b) => a.priority - b.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

/** Test seam: drop all specs (heartbeat re-registers itself in mcp.ts). */
export function clearFollowons(): void {
  registry.clear()
}

function matches(spec: FollowonSpec, ctx: FollowonContext): boolean {
  if (spec.excludeTools?.includes(ctx.tool)) return false
  if (spec.tools && !spec.tools.includes(ctx.tool)) return false
  if (spec.outcomes && !spec.outcomes.includes(ctx.outcome)) return false
  return true
}

let active = false

/** Run matching follow-ons in deterministic order; failures isolated. */
export function runFollowons(ctx: FollowonContext): FollowonResult {
  if (active) return { lines: [], failed: [] } // re-entrancy guard
  const lines: string[] = []
  const failed: string[] = []
  active = true
  try {
    for (const spec of listFollowons()) {
      if (!matches(spec, ctx)) continue
      try {
        const out = spec.run(ctx)
        if (typeof out === 'string') {
          if (out.trim()) lines.push(out)
        } else if (Array.isArray(out)) {
          for (const l of out) if (l.trim()) lines.push(l)
        }
      } catch {
        failed.push(spec.name) // original result unchanged, always
      }
    }
  } finally {
    active = false
  }
  return { lines, failed }
}

// ---- per-request scope (tool + caller) ------------------------------------
// Tool callbacks compose footers via ok()/err() with no knowledge of the
// request envelope, so the envelope facts (tool name, caller key) travel in
// an AsyncLocalStorage scope installed once at the fetch boundary — zero
// changes to the ~40 tool callbacks, minimal rebase surface for siblings.

export interface RequestScope {
  tool: string
  caller: string
}

const scopeStore = new AsyncLocalStorage<RequestScope>()

/** Scope of the in-flight MCP request, or null outside one (unit tests). */
export function currentScope(): RequestScope | null {
  return scopeStore.getStore() ?? null
}

/** Run fn inside a request scope (tests, scripts, non-MCP entry points). */
export function runWithScope<T>(scope: RequestScope, fn: () => T): T {
  return scopeStore.run(scope, fn)
}

function toolNameOfBody(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'unknown'
  const rec = body as Record<string, unknown>
  if (rec.method !== 'tools/call') return 'unknown'
  const params = rec.params
  if (typeof params !== 'object' || params === null) return 'unknown'
  const name = (params as Record<string, unknown>).name
  return typeof name === 'string' && name ? name : 'unknown'
}

function bearerOf(req: globalThis.Request): string | null {
  const raw = req.headers.get('authorization')
  if (!raw) return null
  const m = raw.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

/** Cap on the combined follow-on footer contribution (heartbeat caps itself). */
export const FOLLOWON_MAX_CHARS = 800

/**
 * Full tool-response footer: relay-status body + follow-on lines
 * (heartbeat delta first — it registers at priority 100; other specs
 * order deterministically after) + the staleness triple last.
 * Total footer is absolutely bounded; never throws.
 */
export function withResponseFooter(body: string, outcome: FollowonOutcome): string {
  try {
    const scope = currentScope() ?? { tool: 'unknown', caller: 'anonymous' }
    const at = Date.now()
    const { lines } = runFollowons({ tool: scope.tool, outcome, caller: scope.caller, at })
    let extra = lines.join('\n')
    if (extra.length > FOLLOWON_MAX_CHARS) extra = `${extra.slice(0, FOLLOWON_MAX_CHARS - 1)}…`
    const relay = formatRelayBody()
    return `${body}\n\n${relay}${extra ? `\n${extra}` : ''}\n${stalenessTriple()}`
  } catch {
    return body // the boundary never fails a response
  }
}

export type FetchLike = (req: globalThis.Request) => Promise<globalThis.Response>

/**
 * Fetch middleware: parses the tools/call envelope off a request CLONE
 * (never consumes the original — same pattern as withTelemetry), resolves
 * the caller key via the injected resolver, and runs the inner chain in
 * scope. Never throws: on any parse failure the chain runs unscopped and
 * footers fall back to tool='unknown' / caller='anonymous'.
 */
export function withFollowonScope(
  next: FetchLike,
  resolveCaller: (bearer: string | null) => string = () => 'anonymous',
): FetchLike {
  return async (fetchReq: globalThis.Request): Promise<globalThis.Response> => {
    let scope: RequestScope = { tool: 'unknown', caller: 'anonymous' }
    try {
      if ((fetchReq.method ?? 'GET') !== 'GET') {
        scope = {
          tool: toolNameOfBody(await fetchReq.clone().json()),
          caller: resolveCaller(bearerOf(fetchReq)),
        }
      }
    } catch {
      // keep the fallback scope — logging/telemetry precedent: the
      // boundary never fails a response.
    }
    return scopeStore.run(scope, () => next(fetchReq))
  }
}
