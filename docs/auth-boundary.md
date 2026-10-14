# Credential-failure boundary (MCP doors)

Test: `src/routes/auth-boundary.test.ts` (`FUNNEL_BASE=https://example.test bun test src/routes/auth-boundary.test.ts`;
opt-in live read-only probe with `AUTH_BOUNDARY_LIVE=1`).

Trigger: a ChatGPT MCP client failed with `INVALID_ARGUMENT McpServerError: Session terminated`,
which does not tell the user their credential is the problem. Nothing in this repo emits that
string; the bridge answers a bad credential with an HTTP 401 challenge (below), so the
translation to "Session terminated" happens in the client or a hop we do not own (unproven).

## Where the boundary is

The bridge doors (`/mcp`, `/chatgpt/mcp`, `/jungle/mcp`, `/grok/mcp`, `/gemini/mcp`) are the only
credential check. MCPJungle (`127.0.0.1:8338`) and the session proxy (`127.0.0.1:8337`) accept any
bearer or none on loopback (captured 2026-10-14: `initialize` with no token, `not-a-token` and a
well-formed unknown token all returned `200` + a fresh `Mcp-Session-Id`; a `tools/list` with a
made-up `Mcp-Session-Id` also returned `200` — the gateway is stateless, so a stale session is not
a failure there either). The test therefore asserts at the bridge door.

## Contract vs reality (live bridge, `127.0.0.1:3737`, same bytes on `/mcp` and `/chatgpt/mcp`)

| Case | Status | `error` | `error_description` today | Meets contract? |
|---|---|---|---|---|
| valid token | `200` | — | initialize result, no challenge | yes |
| no token | `401` + `WWW-Authenticate: Bearer … resource_metadata=…` | `invalid_token` | `No authorization provided` | yes |
| malformed token (`not-a-token`) | `401` + same challenge | `invalid_token` | `No authorization provided` | **no** |
| well-formed expired/unknown (`bb_at_…`) | `401` + same challenge | `invalid_token` | `No authorization provided` | **no** |

What exists: a stable status (401), a Bearer challenge with discovery metadata, and a
machine-readable code (`invalid_token`) — distinct from any 200/5xx/session error.

What does not exist (the finding):

1. A rejected-but-present credential is reported as `No authorization provided`, which is false
   and gives no re-authenticate instruction. Contract: the description says the credential is
   invalid/malformed/expired and tells the client to re-authenticate.
2. The three failure cases are byte-identical, so a client cannot tell "you sent nothing" from
   "your token is bad" from "your token expired".
3. Expiry cannot be told apart from never-issued: `prune()` in `src/lib/oauth.ts` deletes dead
   records on read, so the gate sees an unknown token. (Granted tokens no longer expire, so a
   client's "expired" credential is in practice revoked/pruned/unknown.)

The test pins the full contract. Items 1–3 are `knownGap` ("KNOWN GAP"): they pass while the
gap exists and fail as soon as the boundary meets the contract, prompting a swap of `knownGap` for `it`.
No assertion was weakened to get a green run.
