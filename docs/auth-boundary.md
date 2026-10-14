# Credential-failure boundary (MCP doors)

Test: `src/routes/auth-boundary.test.ts` (`FUNNEL_BASE=https://example.test bun test src/routes/auth-boundary.test.ts`;
opt-in live read-only probe with `AUTH_BOUNDARY_LIVE=1`). History: PR #36 pinned the gap (every
rejection said "No authorization provided"); this change closes it.

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

## Contract (live-verified shape; wording shipped in this change)

Stable for every credential failure, on `/mcp`, `/chatgpt/mcp`, `/jungle/mcp` (and the `/grok`,
`/gemini` doors that share `scoped-door.ts`): HTTP `401`, `WWW-Authenticate: Bearer error="invalid_token",
error_description="…", resource_metadata="…"`, JSON body `{error: "invalid_token", error_description}`.
Only `error_description` varies; the header and body carry the same text.

| Case | `error_description` (from `src/lib/auth-diagnosis.ts`) | Re-authenticate hint |
|---|---|---|
| valid token | — (`200`, no challenge) | — |
| no `Authorization` header | `No authorization provided: send an Authorization: Bearer access token.` | n/a (nothing was sent) |
| present but not a `Bearer bb_at_…` token (`not-a-token`) | `Authorization is present but is not a valid bridge access token (malformed). Re-authenticate …` | yes |
| well-formed, never issued / revoked / long-pruned | `Access token is invalid: not recognized by this bridge (never issued, revoked, or removed). Re-authenticate …` | yes |
| well-formed, expired (tombstoned) | `Access token has expired. Re-authenticate …` | yes |
| valid token minted for another door's audience | `Access token is valid but was issued for a different endpoint than this one. Re-authenticate …` | yes |

A client should treat `error="invalid_token"` + a description that says to re-authenticate as
"drop the stored token and re-run the OAuth flow".

## How it works

- `withMcpAuth` (mcp-handler) hardcodes `No authorization provided` for every rejection.
  `withCredentialDiagnosis` (`src/lib/auth-diagnosis.ts`) wraps each gated door, lets the library
  decide, and — only when the library rejected with that exact text — rewrites `error_description`
  in the header and body. The verdict, status, `error` code and `resource_metadata` are untouched,
  so diagnosis can only change wording, never grant or deny access.
- Expired vs unknown: `prune()` in `src/lib/oauth.ts` still deletes a dead access record on read,
  but now leaves a tombstone in `store.expired` keyed by `sha256(token)` (no second copy of the
  credential on disk), kept 30 days (`EXPIRED_TOMBSTONE_TTL_MS`). `accessTokenState()` reads it;
  `lookupAccess()` never does, so a tombstone authorizes nothing. After 30 days an expired token
  reads as "invalid / not recognized", which carries the same re-authenticate instruction.
  (Granted tokens no longer expire, so in practice expiry only hits legacy/seeded records; a
  client that lost its token to revocation or a wiped store sees the "not recognized" text.)
- Token values are never logged or echoed in the response; the test asserts this.

## Tests

`src/routes/auth-boundary.test.ts` asserts the table above on every door, header/body agreement,
no token echo, persistence of the tombstone across a store save, and that the doors agree
byte-for-byte per case. `src/lib/oauth.test.ts` covers `accessTokenState` and tombstone expiry.
The opt-in live probe (`AUTH_BOUNDARY_LIVE=1`) only passes against a bridge process running this
build; an older process still answers `No authorization provided` until it is redeployed.

## Out of scope / still unproven

MCPJungle and the session proxy still accept any bearer on loopback; the client-side
`Session terminated` translation is untouched.
