# MCPJungle gateway → Beads Bridge wiring (S2)

Jungle fronts the bridge on loopback only. ChatGPT connects to jungle;
jungle authenticates to the bridge with a server-side bearer. The bearer
never appears in ChatGPT-side config.

## Server entry (jungle registry, SQLite `~/.local/share/mcpjungle/mcpjungle.db`)

- `name`: `beads-bridge`
- `transport`: `streamable_http` (config-file spelling; CLI `--url` implies it)
- `url`: `http://127.0.0.1:3737/mcp`
- `bearer_token`: dedicated bridge OAuth access token, client
  `mcpjungle-gateway`, scope `mcp` (value lives only in the jungle DB and
  the 0600 registration config at `/tmp/jungle-beads-bridge.json` — never
  in this repo or ChatGPT config)
- `session_mode`: default (`stateless`)
- Registration command: `mcpjungle register -c /tmp/jungle-beads-bridge.json
  --registry http://127.0.0.1:8338`

Schema source: MCPJungle `docs/guides/register-http-servers.mdx`
(`transport`/`url`/`bearer_token`/`session_mode`/`headers`) and
`pkg/types/mcp_server.go` (`TransportStreamableHTTP = "streamable_http"`).

## Tool prefix

Always-on in jungle, not a toggle: every tool is exposed as
`<server>__<tool>` (`internal/service/mcp/util.go`: `mergeServerToolNames`,
separator constant `serverToolNameSep = "__"`; split on first `__`).
Server names may not contain `__` or end with `_`. Bridge tools arrive as
`beads-bridge__<name>`.

## Bearer handling

- The bridge `/mcp` gate is OAuth (`withMcpAuth` + `lookupAccess` in
  `src/routes/mcp.ts`); jungle's static `bearer_token` carries a bridge
  OAuth access token minted for client `mcpjungle-gateway`.
- Access TTL 24h, refresh TTL 30d (`ACCESS_TTL_MS`/`REFRESH_TTL_MS` in
  `src/lib/oauth.ts`). Token state lives in the bridge OAuth store
  `~/.config/pai/beads-bridge-oauth.json` (0600, survives bridge restarts).
- Rotation (no `update server` in the jungle CLI): mint a fresh pair
  (`mintTokenPair('mcpjungle-gateway', ['mcp'], mcpResource(BASE))` or
  `rotateRefresh`), rewrite `/tmp/jungle-beads-bridge.json`, then
  `mcpjungle register --force -c …` (deregister + re-register).
- Gateway whoami proof shows `you are: OAuth client mcpjungle-gateway`.

## Counts (2026-09-16, verified)

- Bridge-direct `tools/list` on `http://127.0.0.1:3737/mcp`: **36**
- Jungle gateway `tools/list` on `http://127.0.0.1:8338/mcp`: **36**,
  every name `beads-bridge__`-prefixed
- `mcpjungle list tools --server beads-bridge`: **36**
- Live call `beads-bridge__whoami` through jungle returns bridge output.

## S3 end-to-end proof (2026-09-16, task-622kl.3)

Gateway started manually per S1 (`mcpjungle start --host 127.0.0.1
--port 8338`, SQLite `~/.local/share/mcpjungle/mcpjungle.db`);
all probes below are fresh MCP sessions over Streamable HTTP on
`http://127.0.0.1:8338/mcp`:

- Read: `initialize` → `MCPJungle Proxy MCP Server
  v0.0.0-local+12648be`; `tools/list` → **36**, all
  `beads-bridge__`-prefixed, zero unprefixed.
- `bridge_info` through jungle → backend **v1.2.0** (commit db952ef,
  manifest v1); `capability_status(bead_create)` → LIVE since 1.0.0;
  `whoami` → `OAuth client mcpjungle-gateway`.
- Write: `bead_create` (store `dump`) → verified receipt `dump-xen`;
  `bead_show` reads back; `bead_decision(close)` → verified CLOSED.
  Scratch bead, closed immediately.
- Registration: `deregister beads-bridge` → fresh session sees **0**
  tools (CLI: server not found); `register -c
  /tmp/jungle-beads-bridge.json` → **36** again; `register --force`
  (the update/rotation path) → **36**, bearer still valid.
  Registry changes are visible to new sessions with no gateway restart
  — staleness lives in the client session.
- Bridge intact: direct `http://127.0.0.1:3737/mcp` (same bearer) →
  **36** unprefixed tools, same backend/commit/manifest; repo
  `mcp-compat` + `capabilities` + `mutate` suites green (26 pass).
- ChatGPT refresh runbook: `docs/jungle-gateway-refresh.md`.

## Boundaries

- Loopback only: bridge `127.0.0.1:3737`, jungle `127.0.0.1:8338`. Nothing
  off-loopback exposed.
- Bridge launchd service (`com.beads-bridge.server`) untouched.
- Jungle process here is a manual foreground/background start for S2
  verification; launchd persistence is S4 (task-622kl.4).
