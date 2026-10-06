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
// The mechanism (gate, loopback hop, streaming sender) is shared with the
// grok and gemini doors in `../lib/scoped-door`; what stays here is this
// door's boundary — the exact audience it accepts and the loopback group it
// aims at. Boundaries in full:
// - Upstream is a loopback constant, never configurable off-loopback (the
//   shared factory asserts it on load).
// - Unauthenticated callers get the RFC 9728 challenge, never proxy traffic.
// - A token minted for /mcp, /jungle/mcp, /grok/mcp or /gemini/mcp never
//   opens /chatgpt/mcp and vice versa (exact-audience equality).
// - Hot path is cheap: no JSON parsing, no body buffering — bytes stream
//   straight through (SSE GET streams included).
import { BASE } from '../config'
import { chatgptResource } from '../lib/oauth'
import { createScopedDoor } from '../lib/scoped-door'

export const mountOrder = -18

// Loopback only by construction: a const, not config, so no deployment can
// aim the front door at a remote gateway. Group endpoint shape is
// /v0/groups/{name}/mcp (see `mcpjungle create group --help`).
export const CHATGPT_UPSTREAM = 'http://127.0.0.1:8338/v0/groups/chatgpt/mcp'

const door = createScopedDoor({
  label: 'chatgpt',
  path: '/chatgpt/mcp',
  discoveryPath: '/.well-known/oauth-protected-resource/chatgpt/mcp',
  upstream: CHATGPT_UPSTREAM,
  // Exact-audience equality: the whole rule, readable here.
  accepts: (rec) => rec.resource === chatgptResource(BASE),
})

export const chatgptRouter = door.router

// Exported for the auth-gate regression tests (see chatgpt.test.ts).
export const verifyChatgptToken = door.verify
