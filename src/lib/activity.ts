// Live MCP Activity UI event bus (project-s1rf.1.1.2) — observational only.
//
// Every completed MCP tools/call publishes one bounded ActivityEvent to an
// in-memory ring (restart clears it — same ephemeral posture as the
// heartbeat cursors and the relay-status projection). The /live routes
// serve the ring as JSON + SSE; a static page renders the two-panel UI.
//
// REUSED, never re-implemented (task-ksmy1 foundation):
// - Session/caller identity: recorded INSIDE the follow-on request scope,
//   so `tool` + `caller` come from currentScope() — the exact caller key
//   (OAuth clientId | loopback-local | anonymous) heartbeat uses. No new
//   identity model.
// - Loop prevention: tools in HEARTBEAT_EXCLUDED_TOOLS (heartbeat,
//   relay_status, timeout_probe) are never recorded, and the /live
//   endpoints are GET-only so the UI can never re-trigger itself.
// - Request shape privacy: arg NAMES only (clientClass/parseMcpBody from
//   mcp-telemetry) — values never leave the request.
// SAFETY: pure reads + ring push. No store reads, no writes, no agent
// requests. Recording never throws and never alters the response — every
// step is guarded, the boundary always returns the original response.
import { currentScope } from './followons'
import { HEARTBEAT_EXCLUDED_TOOLS } from './heartbeat'
import { clientClass, parseMcpBody } from './mcp-telemetry'
import { storeFromId } from '../util'

// ---- config (backend-configurable auto-follow etc.) -------------------------

function numEnv(name: string, dflt: number, min: number, max: number): number {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** Max retained events (ring cap). */
export function activityMaxEvents(): number {
  return numEnv('ACTIVITY_MAX_EVENTS', 200, 10, 1000)
}

/** Max chars of result summary per event. */
export function activitySummaryChars(): number {
  return numEnv('ACTIVITY_SUMMARY_CHARS', 300, 40, 1000)
}

/** Max bead refs extracted per event. */
export function activityMaxBeadRefs(): number {
  return numEnv('ACTIVITY_MAX_BEADREFS', 10, 1, 40)
}

/** Default auto-follow state the UI adopts on load (toggle overrides). */
export function activityAutoFollowDefault(): boolean {
  const raw = (process.env.ACTIVITY_AUTOFOLLOW_DEFAULT ?? '1').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off'
}

// ---- event schema ------------------------------------------------------------

export interface ActivityEvent {
  /** Monotonic per-process sequence (ordering = completion order). */
  seq: number
  /** Completion time, ISO. */
  at: string
  /** MCP op name (e.g. bead_show, query_store). */
  tool: string
  /** Tool outcome: ok, or error (isError / HTTP 5xx). */
  outcome: 'ok' | 'error'
  /** Follow-on caller key: OAuth clientId | loopback-local | anonymous. */
  caller: string
  /** MCP session id header, when the client sent one. */
  sessionId: string | null
  /** Coarse client class (never the raw User-Agent). */
  client: string
  /** True when an Authorization header was present (value never recorded). */
  authed: boolean
  /** Wall time of the inner chain, ms. */
  durationMs: number
  /** Tool argument NAMES only, sorted. Values never recorded. */
  argNames: string[]
  /** Validated bead ids referenced by the result (bounded). */
  beadRefs: string[]
  /** Bounded head of the result text, footer stripped. */
  summary: string
}

// ---- ring ---------------------------------------------------------------------

const ring: ActivityEvent[] = []
let seq = 0

/** Test seam: drop all events and reset the sequence. */
export function resetActivity(): void {
  ring.length = 0
  seq = 0
}

/** Newest-first snapshot (bounded copy; cap covers the whole ring). */
export function recentEvents(limit = 50): ActivityEvent[] {
  const n = Math.min(500, Math.max(1, Math.floor(limit) || 50))
  return ring.slice(-n).reverse()
}

/** Direct record (tests, scripts). Applies bounds; never throws. */
export function recordEvent(input: Omit<ActivityEvent, 'seq'>): ActivityEvent {
  const ev: ActivityEvent = { ...input, seq: ++seq }
  try {
    ring.push(ev)
    while (ring.length > activityMaxEvents()) ring.shift()
    publish(ev)
  } catch {
    /* the boundary never fails */
  }
  return ev
}

// ---- SSE fan-out ---------------------------------------------------------------

type Subscriber = (line: string) => boolean

const subscribers = new Set<Subscriber>()
const MAX_SUBSCRIBERS = 100

/** Push one already-framed SSE message to every live stream; drops bad sinks. */
function deliverFrame(line: string): void {
  for (const sub of [...subscribers]) {
    try {
      if (!sub(line)) subscribers.delete(sub)
    } catch {
      subscribers.delete(sub)
    }
  }
}

/**
 * Push a framed SSE message onto the SAME fan-out as activity events, for a
 * co-located projection that shares the transport (see ./view-state, which
 * sends named `event: view` frames). One fan-out, not a second channel.
 * Never throws.
 */
export function broadcastSseFrame(line: string): void {
  try {
    deliverFrame(line)
  } catch {
    /* the boundary never fails */
  }
}

// ---- in-process observers ---------------------------------------------------
//
// Distinct from `subscribeActivity`: that is the wire (one sink per open
// stream, frame strings). An observer is a co-located module that needs each
// recorded event for its own projection and never touches the wire. Observers
// fire for every recorded event, including with no stream open, so a
// projection is already current for the next viewer that connects.

type Observer = (ev: ActivityEvent) => void

const observers = new Set<Observer>()

/** Register a co-located observer; returns an unsubscribe. Never throws. */
export function observeActivity(obs: Observer): () => void {
  try {
    observers.add(obs)
  } catch {
    /* ignore */
  }
  return () => {
    try {
      observers.delete(obs)
    } catch {
      /* ignore */
    }
  }
}

function notifyObservers(ev: ActivityEvent): void {
  for (const obs of [...observers]) {
    try {
      obs(ev)
    } catch {
      /* observation never fails a record */
    }
  }
}

function publish(ev: ActivityEvent): void {
  deliverFrame(`data: ${JSON.stringify(ev)}\n\n`)
  notifyObservers(ev)
}

/** Register a push sink; the sink returns false to unsubscribe. Never throws. */
export function subscribeActivity(sub: Subscriber): () => void {
  try {
    if (subscribers.size >= MAX_SUBSCRIBERS) {
      const oldest = subscribers.values().next().value
      if (oldest) subscribers.delete(oldest)
    }
    subscribers.add(sub)
  } catch {
    /* ignore */
  }
  return () => {
    subscribers.delete(sub)
  }
}

/** Test seam: current subscriber count. */
export function subscriberCount(): number {
  return subscribers.size
}

// ---- extraction (bounded, validated, pure) --------------------------------------

// Same id shape as extractLinks (util.ts), plus dotted sub-ids
// (project-s1rf.1.1.2). Every candidate is validated through storeFromId
// so free-text hyphenations (follow-on, end-to-end) never become refs.
const ID_RE = /\b([a-z][a-z0-9]+-[a-z0-9]{3,}(?:\.[0-9]+)*)\b/g

/** Validated bead ids referenced in text, order of first appearance. */
export function extractBeadRefs(text: string, max = activityMaxBeadRefs()): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  try {
    ID_RE.lastIndex = 0
    for (const m of text.slice(0, 8192).matchAll(ID_RE)) {
      const id = m[1]
      if (seen.has(id)) continue
      seen.add(id)
      if (storeFromId(id)) {
        out.push(id)
        if (out.length >= max) break
      }
    }
  } catch {
    /* extraction never fails */
  }
  return out
}

function walkText(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node)
  } else if (Array.isArray(node)) {
    for (const v of node) walkText(v, out)
  } else if (typeof node === 'object' && node !== null) {
    const rec = node as Record<string, unknown>
    // JSON-RPC MCP result content blocks first (the actual result text),
    // then any other string leaves in key order as a fallback.
    if (Array.isArray(rec.content)) {
      for (const b of rec.content) {
        if (typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>).text === 'string') {
          out.push((b as Record<string, unknown>).text as string)
        }
      }
    } else {
      for (const v of Object.values(rec)) walkText(v, out)
    }
  }
}

/**
 * Bounded result summary: inner MCP result text (footer stripped), else
 * the raw head. Collapsed whitespace, capped at activitySummaryChars().
 */
export function summarizeResult(bodyText: string, max = activitySummaryChars()): string {
  try {
    // SSE-framed answers (event: message / data: {...}) unwrap to the
    // data payload first so summaries hold result text, not framing.
    let json = bodyText.trim()
    const sse = json.match(/^event:\s*\S+\s*\ndata:\s*([\s\S]*)$/)
    if (sse) json = sse[1].trim()
    let head = json
    const cut = head.indexOf('\n## relay-status')
    if (cut !== -1) head = head.slice(0, cut)
    let candidate = head
    try {
      const parsed: unknown = JSON.parse(json)
      const parts: string[] = []
      const root = (parsed as Record<string, unknown>)?.result ?? parsed
      walkText(root, parts)
      const joined = parts.join('\n').trim()
      if (joined) {
        const c2 = joined.indexOf('\n## relay-status')
        candidate = c2 !== -1 ? joined.slice(0, c2) : joined
      }
    } catch {
      /* not JSON — use the raw head */
    }
    return candidate.replace(/\s+/g, ' ').trim().slice(0, max)
  } catch {
    return ''
  }
}

function isErrorBody(status: number, bodyText: string): boolean {
  if (status >= 500) return true
  try {
    return /"isError"\s*:\s*true/.test(bodyText.slice(0, 8192))
  } catch {
    return false
  }
}

// ---- fetch wrapper ---------------------------------------------------------------

export type FetchLike = (req: globalThis.Request) => Promise<globalThis.Response>

/**
 * Record one ActivityEvent per completed MCP tools/call, inside the
 * follow-on scope (so tool/caller are the canonical scoped values).
 * Never delays failure, never alters the response: body reads go through
 * a clone in try/catch and recording itself cannot throw.
 */
export function withActivity(next: FetchLike): FetchLike {
  return async (fetchReq: globalThis.Request): Promise<globalThis.Response> => {
    const start = Date.now()
    let parsed = { tool: 'unknown' as string, argNames: [] as string[] }
    let sessionId: string | null = null
    let client = 'none'
    let authed = false
    try {
      if ((fetchReq.method ?? 'GET') !== 'GET') {
        const body: unknown = await fetchReq.clone().json()
        const p = parseMcpBody(body)
        parsed = { tool: p.tool ?? 'unknown', argNames: p.argNames }
      }
      const h = fetchReq.headers
      sessionId = h.get('mcp-session-id')
      client = clientClass(h.get('user-agent'))
      authed = h.has('authorization')
    } catch {
      /* fall back to defaults — recording never fails a request */
    }
    let res: globalThis.Response
    try {
      res = await next(fetchReq)
    } catch (e) {
      try {
        const scope = currentScope()
        recordEvent({
          at: new Date(Date.now()).toISOString(),
          tool: scope?.tool ?? parsed.tool,
          outcome: 'error',
          caller: scope?.caller ?? 'anonymous',
          sessionId,
          client,
          authed,
          durationMs: Date.now() - start,
          argNames: parsed.argNames,
          beadRefs: [],
          summary: 'handler failed',
        })
      } catch {
        /* ignore */
      }
      throw e
    }
    try {
      const scope = currentScope()
      const tool = scope?.tool ?? parsed.tool
      if (tool === 'unknown') return res
      const caller = scope?.caller ?? 'anonymous'
      // Bare tools answer bare: their output must never re-trigger
      // anything, including this ring (same exclusion list as footers).
      const excluded = (() => {
        try {
          return (HEARTBEAT_EXCLUDED_TOOLS as readonly string[]).includes(tool)
        } catch {
          return false
        }
      })()
      if (excluded) return res
      let bodyText = ''
      try {
        bodyText = await res.clone().text()
      } catch {
        bodyText = ''
      }
      recordEvent({
        at: new Date(Date.now()).toISOString(),
        tool,
        outcome: isErrorBody(res.status, bodyText) ? 'error' : 'ok',
        caller,
        sessionId,
        client,
        authed,
        durationMs: Date.now() - start,
        argNames: parsed.argNames,
        beadRefs: extractBeadRefs(bodyText),
        summary: summarizeResult(bodyText),
      })
    } catch {
      /* recording never alters the response */
    }
    return res
  }
}
