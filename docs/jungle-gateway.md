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

## Boundaries

- Loopback only: bridge `127.0.0.1:3737`, jungle `127.0.0.1:8338`. Nothing
  off-loopback exposed.
- Bridge launchd service (`com.beads-bridge.server`) untouched.
- Jungle process here is a manual foreground/background start for S2
  verification; launchd persistence is S4 (task-622kl.4).
