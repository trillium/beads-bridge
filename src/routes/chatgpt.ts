// Scoped ChatGPT front door: OAuth-gated proxy to the loopback MCPJungle
// `chatgpt` tool group (beads-bridge server only — see `mcpjungle get group
// chatgpt`), NOT the full gateway surface.
//
// ChatGPT connects here (https://<funnel-host>/chatgpt/mcp) with a bridge
// OAuth token minted for the chatgpt audience (`chatgptResource(BASE)`).
// The bridge verifies that audience, strips the client bearer, and forwards
// the MCP request to the group endpoint on loopback. The gateway fans out
// with its own server-side bearer (lives only in the jungle SQLite
// registry — never in ChatGPT config, never forwarded from the client).
//
// Boundaries (same as the jungle front door in ./jungle.ts):
// - Upstream is a loopback constant, never configurable off-loopback.
//   Public exposure (tailscale funnel flip) is a separate explicit step —
//   this route only serves wherever the bridge already serves.
// - Unauthenticated callers get the RFC 9728 challenge, never proxy traffic.
// - A token minted for /mcp or /jungle/mcp never opens /chatgpt/mcp and
//   vice versa (exact-audience equality).
// - Hot path is cheap: no JSON parsing, no body buffering — bytes stream
//   straight through (SSE GET streams included).
import { Router } from 'express'
import type { Request, Response } from 'express'
import { withMcpAuth } from 'mcp-handler'
import { BASE } from '../config'
import { toFetchRequest } from '../lib/express-fetch'
import { chatgptResource, lookupAccess } from '../lib/oauth'
import { withCompatRequest } from '../lib/mcp-compat'
import { withTelemetry } from '../lib/mcp-telemetry'

export const mountOrder = -18
export const chatgptRouter = Router()

// Loopback only by construction: a const, not config, so no deployment can
// aim the front door at a remote gateway. Group endpoint shape is
// /v0/groups/{name}/mcp (see `mcpjungle create group --help`).
export const CHATGPT_UPSTREAM = 'http://127.0.0.1:8338/v0/groups/chatgpt/mcp'

// Headers that cross the loopback hop. Authorization is deliberately absent:
// the client's chatgpt-audience bearer stops at this gate; the gateway's
// downstream auth is its own stored bearer.
const FORWARD_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
]

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
  return fetch(CHATGPT_UPSTREAM, init)
}

// Bearer gate: same OAuth server as /mcp, distinct audience. withMcpAuth
// answers 401/403 with RFC 9728 challenges itself — unauthenticated callers
// get discovery instead of proxy traffic. Exported for the auth-gate
// regression tests (see chatgpt.test.ts).
export function verifyChatgptToken(bearerToken?: string):
  | { token: string; clientId: string; scopes: string[] }
  | undefined {
  if (!bearerToken) return undefined
  const rec = lookupAccess(bearerToken)
  if (!rec || rec.resource !== chatgptResource(BASE)) return undefined
  return { token: rec.token, clientId: rec.clientId, scopes: rec.scope }
}

const authedProxy = withMcpAuth(proxyHandler, (_req, bearerToken) => verifyChatgptToken(bearerToken), {
  required: true,
  resourceMetadataPath: '/.well-known/oauth-protected-resource/chatgpt/mcp',
  // Origin only: withMcpAuth appends resourceMetadataPath to build the
  // challenge URL (passing the full resource would double the path).
  resourceUrl: BASE,
})

// Same chain shape as /mcp (compat backfill + telemetry), different gate +
// different backend. Sparse 2026 envelopes (ChatGPT) are backfilled before
// the proxy so the gateway sees what bridge-direct clients send.
const telemetryProxy = withTelemetry((fetchReq) => withCompatRequest(fetchReq).then((r) => authedProxy(r)))

// Streaming sender: unlike mountFetch (which buffers the whole body — right
// for mcp-handler's complete responses, fatal for the gateway's long-lived
// SSE streams), this pumps upstream chunks straight to the client.
chatgptRouter.all('/chatgpt/mcp', async (req: Request, res: Response) => {
  let out: globalThis.Response
  try {
    out = await telemetryProxy(toFetchRequest(req))
  } catch {
    res.status(500).json({ error: 'chatgpt proxy failed' })
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
