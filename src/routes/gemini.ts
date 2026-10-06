// Scoped Gemini front door: OAuth-gated proxy to the loopback MCPJungle
// `gemini` tool group (beads-bridge server only — see `mcpjungle get group
// gemini`), NOT the full gateway surface.
//
// Gemini connects here (https://<funnel-host>/gemini/mcp) with a bridge OAuth
// token minted for the gemini audience (`geminiResource(BASE)`). Both surfaces
// Google documents take a remote HTTPS MCP server URL with OAuth — the
// consumer Gemini app (Settings → Connected apps → Custom apps) and Gemini
// Enterprise (Connected apps → Add MCP Server / Cloud Console Data Stores →
// Custom MCP Server) — so the same door serves them; the bridge verifies the
// gemini audience, strips the client bearer, and forwards to the group
// endpoint on loopback. Gemini Enterprise additionally requires the FQDNs of
// the MCP server URL, the authorization URL and the token URL to be
// allowlisted for egress — an operator prerequisite, not something this route
// can satisfy; see docs/jungle-gateway.md "S9". Gemini CLI
// (`~/.gemini/settings.json` `httpUrl`) has no OAuth flow and would need a
// static header instead — deliberately not wired here (see the same doc).
//
// Same boundaries as ./chatgpt.ts — mechanism shared via
// `../lib/scoped-door`, boundary declared here:
// - Upstream is a loopback constant, never configurable off-loopback (the
//   shared factory asserts it on load).
// - Unauthenticated callers get the RFC 9728 challenge, never proxy traffic.
// - A token minted for any other door never opens /gemini/mcp and vice versa
//   (exact-audience equality).
// - Hot path is cheap: no JSON parsing, no body buffering — bytes stream
//   straight through (SSE GET streams included).
import { BASE } from '../config'
import { geminiResource } from '../lib/oauth'
import { createScopedDoor } from '../lib/scoped-door'

export const mountOrder = -16

// Loopback only by construction: a const, not config, so no deployment can
// aim the front door at a remote gateway. Group endpoint shape is
// /v0/groups/{name}/mcp (see `mcpjungle create group --help`).
export const GEMINI_UPSTREAM = 'http://127.0.0.1:8338/v0/groups/gemini/mcp'

const door = createScopedDoor({
  label: 'gemini',
  path: '/gemini/mcp',
  discoveryPath: '/.well-known/oauth-protected-resource/gemini/mcp',
  upstream: GEMINI_UPSTREAM,
  // Exact-audience equality: the whole rule, readable here.
  accepts: (rec) => rec.resource === geminiResource(BASE),
})

export const geminiRouter = door.router

// Exported for the auth-gate regression tests (see gemini.test.ts).
export const verifyGeminiToken = door.verify
