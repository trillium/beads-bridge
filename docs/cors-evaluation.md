# CORS evaluation — beads-bridge

Scope: every bridge, MCP, and HTTP endpoint exposed by `src/server.ts` plus
the independent support hatch. No live stores or real service ports were
touched.

## Summary

beads-bridge ships **no application-level CORS policy**. No route sets
`Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`,
`Access-Control-Allow-Methods`, or `Access-Control-Allow-Headers`, and no
global CORS middleware is registered in `src/server.ts` or `src/routes/*`.

Consequence: a browser enforcing the same-origin policy cannot read any
bridge response cross-origin. Preflight (`OPTIONS`) requests receive no
CORS headers, so the browser blocks the follow-up request before it is
sent. This is the desired posture for this service — the web UI is
same-origin (`web/dist` served by the bridge itself), and every legitimate
API client (ChatGPT connector, MCPJungle gateway, tailnet CLI) is either
server-side or same-origin.

The one exception is the OAuth **protected-resource metadata** endpoint
family, which is implemented by `mcp-handler`'s `protectedResourceHandler`
and intentionally returns `Access-Control-Allow-Origin: *` (no
credentials) so browser-based OAuth clients can discover the authorization
server. That endpoint is public metadata and carries no secret, so the
wildcard is acceptable.

No endpoint returns `Access-Control-Allow-Credentials: true`. No endpoint
is reachable cross-origin with credentials.

## Methodology

- Static inspection of `src/server.ts`, `src/routes/*.ts`,
  `src/support-hatch/*.ts`, and `src/lib/access-gate.ts` for any
  `Access-Control-*`, `Origin`, or `OPTIONS` handling.
- Runtime probing of an ephemeral in-process Express app (no real stores,
  no real service ports beyond an ephemeral `listen(0)`) mounting the real
  routers, recording status + CORS headers for `OPTIONS` and `GET` with an
  `Origin: https://evil.example` request.
- Comparison against `mcp-handler@2.1.1` source for the metadata handler.

## Endpoint table

| Endpoint (group) | Methods | CORS headers today | Preflight (`OPTIONS`) | Credentials | Notes |
|---|---|---|---|---|---|
| `/`, `/help`, `/:store`, `/:id`, verbs (`/:id/*`), `/beads/*`, `/sections*`, `/resume*`, `/fetch/*`, `/paste*`, `/probe*`, `/retrieval/*`, `/guide*`, `/actions/*`, `/live*`, `/query/*` | GET (some POST) | none | Express auto-answer, `200`, no ACAO, browser blocks | none | Default-deny cross-origin. |
| `/mcp`, `/jungle/mcp`, `/chatgpt/mcp`, `/grok/mcp`, `/gemini/mcp` | ALL (POST primary) | none | Hits handler, `401` (no bearer on preflight) + `WWW-Authenticate`, no ACAO, browser blocks | none | `router.all`; preflight cannot carry the bearer, so it fails closed. Correct for server-side clients. |
| `/.well-known/oauth-protected-resource` and `/*` | GET, OPTIONS | `Access-Control-Allow-Origin: *`, `Allow-Methods: GET, OPTIONS`, `Allow-Headers: *`, `Max-Age: 86400` (from `mcp-handler`) | `200` with the same headers | none (`*` implies no credentials) | Public OAuth discovery metadata only. |
| `/.well-known/oauth-authorization-server` and `/*` | GET | none | Express auto-answer, `200`, no ACAO | none | Authorization-server metadata; not CORS-enabled by the library. |
| `/oauth/register`, `/oauth/authorize`, `/oauth/token` | POST (authorize GET) | none | Express auto-answer where applicable, no ACAO | cookie `SameSite=Lax; Secure; HttpOnly` | OAuth ceremony; browser navigates top-level, so CORS is not required. |
| `/live`, `/live/*`, `/live/events` (SSE) | GET | none | Express auto-answer, `200`, no ACAO | none | Same-origin UI only. |
| Static `web/dist` assets | GET | none | Express auto-answer, `200/404`, no ACAO | none | Same-origin. |
| Support hatch `/mcp`, `/health` | ALL / GET | none | `/mcp`: handler `401` without bearer, no ACAO; `/health`: `200`, no ACAO | none | Independent service, same posture. |

## Current behaviour

1. **No CORS grant anywhere in application code.** `grep` over `src/` finds no
   `Access-Control-*` assignment except the library-provided metadata handler.
2. **Browser cross-origin reads are blocked** for every data/action route
   because no response carries `Access-Control-Allow-Origin`.
3. **Preflight fails closed.** For ordinary routes Express answers `OPTIONS`
   with `200` but no CORS headers, so the browser never sends the real
   request. For `/mcp*` the preflight is treated as an MCP request and returns
   `401` with a `WWW-Authenticate` challenge; again no CORS headers.
4. **No credentialed cross-origin mode exists.** No route sets
   `Access-Control-Allow-Credentials: true`, so cookies/bearers cannot be
   sent cross-origin by a browser.
5. **OAuth discovery metadata is deliberately public-CORS.** The protected-resource
   metadata endpoint sets `Access-Control-Allow-Origin: *` (credentials not
   allowed), which is standard for OAuth 2.1 resource metadata and matches
   RFC 9728 expectations for browser clients.

## Allowed / exposed headers and methods

- No route sets `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`,
  `Access-Control-Expose-Headers`, or `Access-Control-Max-Age` in application
  code.
- The only values for those headers anywhere in the service come from
  `mcp-handler`'s protected-resource metadata handler:
  `Access-Control-Allow-Methods: GET, OPTIONS`,
  `Access-Control-Allow-Headers: *`,
  `Access-Control-Max-Age: 86400`. They apply only to the
  `/.well-known/oauth-protected-resource*` family.
- No endpoint sets `Access-Control-Expose-Headers`, so no response header is
  readable cross-origin even where `ACAO: *` is present.
- Express's automatic `OPTIONS` answer carries an `Allow: GET, HEAD` (or the
  route's declared methods) header but no `Access-Control-*` headers, so it is
  not a CORS grant.

## Risks

- **Accidental CORS grant in a future change.** A single
  `res.set('Access-Control-Allow-Origin', '*')` or a global `cors()`
  middleware would silently open every data route (including bead content
  and write verbs) to any website. There is no test guarding against this
  today beyond the new suite added with this report.
- **`/mcp` preflight returns `401`.** Browser-based MCP clients will see an
  auth failure on preflight rather than a clean CORS denial. This is harmless
  for the current server-side clients but should be revisited if a browser
  MCP client is ever supported.
- **Metadata endpoint wildcard.** `Access-Control-Allow-Origin: *` on
  `/.well-known/oauth-protected-resource*` is broader than strictly
  necessary. It is acceptable because the payload is public metadata and
  credentials are not allowed, but a stricter deployment could pin the
  known client origins.
- **No `Vary: Origin`.** Because no route varies its response on `Origin`,
  caches are not at risk of cross-origin leakage, but any future
  origin-dependent CORS response must add `Vary: Origin` to avoid cache
  poisoning.

## Recommendations

1. **Keep the default-deny posture.** Do not add a global CORS middleware
   or wildcard origin to data/action routes.
2. **If browser access is ever required**, implement an explicit origin
   allowlist (never `*` with credentials), set `Vary: Origin`, handle
   `OPTIONS` preflight deliberately, and gate credentials on the allowlist.
   Add tests before shipping.
3. **Pin the current behaviour with tests** (see `src/routes/cors.test.ts`):
   preflight on `/mcp`, disallowed-origin request on a normal route, and the
   absence of `Access-Control-Allow-Credentials: true` everywhere tested. The
   protected-resource metadata endpoint is pinned as `ACAO: *` without
   credentials.
4. **Review any new route** that calls `res.set('Access-Control-*', ...)` or
   imports a CORS library in code review; treat it as a security-sensitive
   change.
5. **Consider normalising `/mcp` preflight** to a CORS-aware `401`/`204`
   only if a browser MCP client is adopted; not needed today.

## Verification

- Automated: `FUNNEL_BASE=https://example.test bun test src/routes/cors.test.ts`
  - Covers preflight (`OPTIONS`) and disallowed-origin requests on `/`, `/help`,
    `/live`, `/mcp` and all scoped doors (`/jungle/mcp`, `/chatgpt/mcp`,
    `/grok/mcp`, `/gemini/mcp`), authorization-server and OAuth ceremony
    endpoints, the support hatch (`/mcp`, `/health`), and every
    protected-resource metadata door.
  - Adds a full-surface default-deny smoke pass over the real app (via
    `loadRoutes`) covering `/`, `/help`, `/live`, `/live/config`,
    `/live/variants`, `/live/v1`, `/probe`, `/guide`, `/actions/openapi.json`,
    and `/experiment/test`.
  - Pins `Access-Control-Allow-Origin: *` without credentials on the metadata
    family, plus its `Access-Control-Allow-Methods: GET, OPTIONS`,
    `Access-Control-Allow-Headers: *`, `Access-Control-Max-Age: 86400`, and the
    absence of `Access-Control-Expose-Headers`.
  - Pins the absence of `Access-Control-Allow-Credentials: true`,
    `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, and
    `Access-Control-Expose-Headers` on default-deny routes.
  - Adds a static guard asserting no non-test source file under `src/`
    references `Access-Control`, preventing accidental CORS grants.
- Typecheck: `bun run typecheck`
- No live stores or real service ports were touched.
