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
- Jungle process was a manual start for S2/S3 verification; launchd
  persistence is S4 (task-622kl.4, below).

## S4 launchd persistence (2026-09-17, task-622kl.4)

- Plist template: `ops/launchd/com.mcpjungle.gateway.plist`, installed at
  `~/Library/LaunchAgents/com.mcpjungle.gateway.plist`. Mirrors the
  bridge pattern (`KeepAlive`, `RunAtLoad`, `WorkingDirectory`,
  `StandardOut/ErrorPath`); loopback-only, no Tailnet/funnel.
- Config location pin (S1 note resolved): **mcpjungle has no config file
  — `~/.config/mcpjungle` does not exist and is not read.** All gateway
  state is the SQLite registry
  `~/.local/share/mcpjungle/mcpjungle.db`; bind address/port come from
  CLI flags. Both are pinned in the plist: `--sqlite-db-path
  ~/.local/share/mcpjungle/mcpjungle.db` (plus `SQLITE_DB_PATH` env
  belt-and-suspenders), `--host 127.0.0.1 --port 8338`,
  `WorkingDirectory ~/.local/share/mcpjungle`, logs to
  `~/.local/share/mcpjungle/gateway.{out,err}.log`.
- Verified: `launchctl bootstrap`, health `{"status":"ok"}`, 36 tools
  all `beads-bridge__`-prefixed via a fresh MCP session, then
  `launchctl kickstart -k` → health + registration + 36 tools back with
  zero manual steps (registry lives in SQLite, survives restarts).
- Bridge service untouched (still running, own plist unchanged).

## S5a: firstmate_mcp onboarded (2026-09-17, task-o8q1z)

Second downstream behind the same loopback gateway. ChatGPT connects
to jungle; jungle spawns the Python server as a local stdio child.
No bearer involved (stdio has no HTTP surface); no secrets in repo
or ChatGPT config.

## Server entry (jungle registry, SQLite `~/.local/share/mcpjungle/mcpjungle.db`)

- `name`: `firstmate_mcp` (single underscores only — names may not
  contain `__` or end with `_`)
- `transport`: `stdio` (config-file registration is required for
  stdio; CLI flags only cover streamable HTTP)
- `command`: `/usr/bin/python3`, `args`:
  `[/Users/trilliumsmith/code/firstmate/projects/firstmate_mcp/fm_mcp_server.py]`
- `env`: `FM_HOME=/Users/trilliumsmith/code/firstmate`
- `session_mode`: default (`stateless` — fresh process per tool call)
- Registration config (0600): `/tmp/jungle-firstmate-mcp.json`
- Registration command: `mcpjungle register -c
  /tmp/jungle-firstmate-mcp.json --registry http://127.0.0.1:8338`

Schema source: MCPJungle `docs/guides/register-stdio-servers.mdx`
(`transport`/`command`/`args`/`session_mode`/`env`).

## Tool prefix

Same always-on `__` rule: firstmate tools arrive as
`firstmate_mcp__<name>`. Verified zero cross-server suffix
collisions with `beads-bridge__` tools.

## Counts (2026-09-17, verified over fresh Streamable HTTP sessions on `http://127.0.0.1:8338/mcp`)

- Gateway `tools/list`: **55** = **36** `beads-bridge__` + **19**
  `firstmate_mcp__`, zero unprefixed
- `mcpjungle list tools --server firstmate_mcp`: **19**, all ENABLED
- Live call `firstmate_mcp__status_tail` through jungle returns real
  server output (wake events from firstmate state).
- Direct stdio smoke (pre-registration): `initialize` →
  `firstmate-mcp-poc v0.3.0`, `tools/list` → **19**.

## Known limitation (firstmate_mcp-owned)

- `firstmate_mcp__fleet_snapshot` / `__backlog` time out through the
gateway (`fm-fleet-snapshot.sh` exceeds the server's 180s subprocess
cap in this environment). Every other tool responds fast. Flagged to
the firstmate side; not a jungle wiring issue.

## TS sibling: follow-up, not onboarded

- `projects/firstmate_mcp/ts` (dist/ built) has stdio parity with the
Python server — same 19 tool names. Registering it under a distinct
name would duplicate every suffix and break the zero-collision rule,
so it stays out until the tool sets diverge or namespacing per
server is explicitly accepted. See task-622kl.5.

## Boundaries (unchanged)

- Loopback only (jungle `127.0.0.1:8338`; stdio child is a local
process, no port at all). No Tailnet/funnel.
- Direct-server fallback: run the Python server on stdio directly
(`FM_HOME=/Users/trilliumsmith/code/firstmate /usr/bin/python3
.../fm_mcp_server.py`, newline-delimited JSON-RPC).
- ChatGPT refresh runbook: `docs/jungle-gateway-refresh.md`
(post-refresh expectation is now **55** tools, both prefixes).

## S6 front door: bridge OAuth fronts the gateway (2026-09-17, task-jhdil)

ChatGPT reaches the gateway through the bridge, not directly: the bridge
serves `https://<funnel-host>/jungle/mcp` (`src/routes/jungle.ts`), verifies
a bridge OAuth token minted for the **jungle audience**
(`jungleResource(BASE)` = `<BASE>/jungle/mcp`, `src/lib/oauth.ts`), strips
the client bearer, and streams the MCP request to the loopback gateway
(`http://127.0.0.1:8338/mcp`). No new credential system — the bridge OAuth
(register/authorize + setup-key approval, PKCE, refresh rotation) is the auth.

- Audience isolation: a token minted for `/mcp` never opens `/jungle/mcp`
  and vice versa (exact-audience equality in both gates). Discovery serves
  the jungle audience at
  `/.well-known/oauth-protected-resource/jungle/mcp` and
  `/.well-known/oauth-authorization-server/jungle/mcp`.
- Unauthenticated calls are refused with the RFC 9728 challenge (401 +
  `WWW-Authenticate` pointing at the jungle metadata) — proxy traffic never
  flows without a token.
- The loopback hop carries no client bearer (stripped at the gate); the
  gateway's downstream auth stays its own stored bearer
  (`mcpjungle-gateway`, `/mcp` audience). Prefixing is untouched:
  `beads-bridge__` (36) + `firstmate_mcp__` (19) = **55**, zero unprefixed.
- Hot path is cheap: no JSON parsing, no body buffering — bytes (including
  SSE GET streams) pump straight through via a streaming sender.
  (`mountFetch` buffers, which is right for mcp-handler but fatal for
  long-lived gateway streams — hence the custom sender.)

## Funnel mapping (implemented, NOT exposed)

The mapping is a path on the existing funnel host: `/jungle/mcp` rides the
current `/ → 127.0.0.1:3737` funnel proxy, since the bridge itself serves
the front door. No `tailscale serve`/`funnel` change was made in this task —
aiming the funnel and flipping it live stays a separate explicit step.
Until then the front door is loopback-reachable only (verified via a local
listener mounting the same router, never via the public host).

## Regression tests

- `src/routes/jungle.test.ts`: gate unit tests (no-token/garbage refused,
  `/mcp`-audience token refused, jungle-audience token accepted), wiring
  contract (loopback pin, discovery mounts, both gates' audiences, access
  gate), plus a live proof (`JUNGLE_LIVE=1`): 401 without token, then
  initialize + `tools/list` through the real gateway → **36**
  `beads-bridge__` tools, every tool prefixed.
