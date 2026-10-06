// Shared mechanism for the scoped group front doors (`/chatgpt/mcp`,
// `/grok/mcp`, `/gemini/mcp`): an OAuth-gated streaming proxy to one
// loopback MCPJungle tool group.
//
// The split of responsibilities is deliberate. This module owns the
// *mechanism* — the bearer gate, the loopback hop, the streaming sender, the
// cheap hot path. Each door file owns its *boundary*: which audience it
// accepts, as one exact-equality predicate written in that file, and the
// loopback group const it aims at. Two consequences worth stating:
//
// - The loopback boundary is mechanical, not editorial: `createScopedDoor`
//   asserts the upstream hostname is 127.0.0.1 at module load, so no door can
//   be aimed off-loopback by editing a URL, and four doors cannot drift into
//   four different interpretations of "loopback only by construction".
// - Audience isolation stays per-door and reviewable: widening a door means
//   changing the `accepts` line in that door's own file, which is exactly
//   the line its regression test reads.
//
// Boundaries (identical to the hand-written doors this replaces):
// - Upstream is loopback by construction and asserted, never configurable.
//   Public exposure (tailscale funnel flip) is a separate explicit step —
//   these routes only serve wherever the bridge already serves.
// - Unauthenticated callers get the RFC 9728 challenge, never proxy traffic.
// - Exact-audience equality: a token minted for one door never opens another,
//   and never opens /mcp or /jungle/mcp.
// - Hot path is cheap: no JSON parsing, no body buffering — bytes stream
//   straight through (SSE GET streams included).
//
// Not covered here: `src/routes/jungle.ts`, the older full-gateway front door.
// It shares the shape but aims at the whole gateway (`/mcp`) rather than one
// tool group, and it predates this helper; it is deliberately left as the
// original so a refactor of the new doors cannot move its bytes.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { withMcpAuth } from 'mcp-handler'
import { BASE } from '../config'
import { toFetchRequest } from './express-fetch'
import { lookupAccess, type TokenRec } from './oauth'
import { withCompatRequest } from './mcp-compat'
import { withTelemetry } from './mcp-telemetry'

/** A token record as the gate sees it: the stored record plus its own key. */
export type ScopedTokenRecord = TokenRec & { token: string }

export interface ScopedDoorSpec {
  /** Router label used in the 500 body, e.g. 'grok' → `{ error: 'grok proxy failed' }`. */
  label: string
  /** Public path served, e.g. '/grok/mcp'. */
  path: string
  /** RFC 9728 protected-resource metadata path for this audience. */
  discoveryPath: string
  /** Loopback MCPJungle group endpoint; asserted 127.0.0.1 on load. */
  upstream: string
  /** Exact-audience predicate — equality only, never a prefix match. */
  accepts: (rec: ScopedTokenRecord) => boolean
}

export interface ScopedDoor {
  router: Router
  verify(bearerToken?: string): { token: string; clientId: string; scopes: string[] } | undefined
}

// The only host a scoped front door may aim at. Exported so the regression
// tests assert the same rule the factory does rather than restating it.
export const LOOPBACK_HOST = '127.0.0.1'

export function assertLoopbackUpstream(upstream: string): void {
  const host = new URL(upstream).hostname
  if (host !== LOOPBACK_HOST) {
    throw new Error(`scoped front door upstream must be ${LOOPBACK_HOST}, got ${host}`)
  }
}

// Headers that cross the loopback hop. Authorization is deliberately absent:
// the client's audience bearer stops at this gate; the gateway's downstream
// auth is its own stored bearer (see docs/jungle-gateway.md).
const FORWARD_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
]

export function createScopedDoor(spec: ScopedDoorSpec): ScopedDoor {
  assertLoopbackUpstream(spec.upstream)

  const proxyHandler = async (fetchReq: globalThis.Request): Promise<globalThis.Response> => {
    const headers = new Headers()
    for (const h of FORWARD_HEADERS) {
      const v = fetchReq.headers.get(h)
      if (v) headers.set(h, v)
    }
    const init: RequestInit = { method: fetchReq.method, headers }
    if (fetchReq.method !== 'GET' && fetchReq.method !== 'HEAD') {
      const buf = await fetchReq.arrayBuffer()
      if (buf.byteLength) init.body = buf
    }
    // Undici streams the upstream body; the express sender below pumps it
    // chunk-by-chunk so SSE GET streams stay live.
    return fetch(spec.upstream, init)
  }

  // Bearer gate: same OAuth server as /mcp, distinct audience. withMcpAuth
  // answers 401/403 with RFC 9728 challenges itself — unauthenticated callers
  // get discovery instead of proxy traffic. `spec.accepts` is the whole
  // audience rule, and it is exact equality: a token minted for another door
  // is refused here.
  const verify = (bearerToken?: string):
    | { token: string; clientId: string; scopes: string[] }
    | undefined => {
    if (!bearerToken) return undefined
    const rec = lookupAccess(bearerToken)
    if (!rec || !spec.accepts(rec)) return undefined
    return { token: rec.token, clientId: rec.clientId, scopes: rec.scope }
  }

  const authedProxy = withMcpAuth(proxyHandler, (_req, bearerToken) => verify(bearerToken), {
    required: true,
    resourceMetadataPath: spec.discoveryPath,
    // Origin only: withMcpAuth appends resourceMetadataPath to build the
    // challenge URL (passing the full resource would double the path).
    resourceUrl: BASE,
  })

  // Same chain shape as /mcp (compat backfill + telemetry), different gate +
  // different backend. Sparse 2026 envelopes (ChatGPT) are backfilled before
  // the proxy so the gateway sees what bridge-direct clients send.
  const telemetryProxy = withTelemetry((fetchReq) => withCompatRequest(fetchReq).then((r) => authedProxy(r)))

  const router = Router()

  // Streaming sender: unlike mountFetch (which buffers the whole body — right
  // for mcp-handler's complete responses, fatal for the gateway's long-lived
  // SSE streams), this pumps upstream chunks straight to the client.
  router.all(spec.path, async (req: Request, res: Response) => {
    let out: globalThis.Response
    try {
      out = await telemetryProxy(toFetchRequest(req))
    } catch {
      res.status(500).json({ error: `${spec.label} proxy failed` })
      return
    }
    res.status(out.status)
    out.headers.forEach((v, k) => {
      if (!['content-length', 'connection', 'transfer-encoding'].includes(k.toLowerCase())) res.setHeader(k, v)
    })
    try {
      if (!out.body) {
        res.end()
        return
      }
      const reader = out.body.getReader()
      req.on('close', () => {
        reader.cancel().catch(() => { /* client went away — drop the hop */ })
      })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(value)) await new Promise<void>((r) => res.once('drain', r))
      }
      res.end()
    } catch {
      // Upstream died mid-stream or the client hung up: end it, don't 500
      // over a half-written body.
      try { res.end() } catch { /* already gone */ }
    }
  })

  return { router, verify }
}
