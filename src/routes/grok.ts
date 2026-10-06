// Scoped Grok front door: OAuth-gated proxy to the loopback MCPJungle `grok`
// tool group (beads-bridge server only — see `mcpjungle get group grok`),
// NOT the full gateway surface.
//
// Grok connects here (https://<funnel-host>/grok/mcp) with a bridge OAuth
// token minted for the grok audience (`grokResource(BASE)`). xAI's remote-MCP
// connector uses the same OAuth 2.1 machinery as ChatGPT's — RFC 9728
// protected-resource metadata, RFC 8414 auth-server metadata, PKCE,
// Streamable HTTP, DCR — so the same door shape serves both the consumer
// connector surface and the Responses API remote-MCP tool. The bridge
// verifies the grok audience, strips the client bearer, and forwards to the
// group endpoint on loopback; the gateway fans out with its own stored
// bearer (lives only in the jungle SQLite registry — never in Grok config,
// never forwarded from the client).
//
// Same boundaries as ./chatgpt.ts — mechanism shared via
// `../lib/scoped-door`, boundary declared here:
// - Upstream is a loopback constant, never configurable off-loopback (the
//   shared factory asserts it on load).
// - Unauthenticated callers get the RFC 9728 challenge, never proxy traffic.
// - A token minted for any other door never opens /grok/mcp and vice versa
//   (exact-audience equality).
// - Hot path is cheap: no JSON parsing, no body buffering — bytes stream
//   straight through (SSE GET streams included).
import { BASE } from '../config'
import { grokResource } from '../lib/oauth'
import { createScopedDoor } from '../lib/scoped-door'

export const mountOrder = -17

// Loopback only by construction: a const, not config, so no deployment can
// aim the front door at a remote gateway. Group endpoint shape is
// /v0/groups/{name}/mcp (see `mcpjungle create group --help`).
export const GROK_UPSTREAM = 'http://127.0.0.1:8338/v0/groups/grok/mcp'

const door = createScopedDoor({
  label: 'grok',
  path: '/grok/mcp',
  discoveryPath: '/.well-known/oauth-protected-resource/grok/mcp',
  upstream: GROK_UPSTREAM,
  // Exact-audience equality: the whole rule, readable here.
  accepts: (rec) => rec.resource === grokResource(BASE),
})

export const grokRouter = door.router

// Exported for the auth-gate regression tests (see grok.test.ts).
export const verifyGrokToken = door.verify
