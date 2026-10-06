# MCPJungle gateway → Beads Bridge wiring (S2)

Jungle fronts the bridge on loopback only. ChatGPT connects to jungle;
jungle authenticates to the bridge with a server-side bearer. The bearer
never appears in ChatGPT-side config.

## Server entry (jungle registry, SQLite `~/.local/share/mcpjungle/mcpjungle.db`)

- `name`: `beads-bridge`
- `transport`: `streamable_http` (config-file spelling; CLI `--url` implies it)
- `url`: `http://127.0.0.1:3737/mcp`
- `bearer_token`: the bridge's own service key (`toolKey` — minted once,
  0600 file at `~/.config/pai/beads-bridge-toolkey`, never expires).
  The bridge accepts it on `/mcp` only from true direct-loopback
  sockets (socket peer is loopback AND no proxy forwarding headers —
  see `isLoopbackServiceCall` in `src/routes/mcp.ts`), so it is
  unusable off-host even if leaked. Value lives only in the jungle DB
  (written by `ops/jungle-register-bearer.sh`) — never in this repo
  or ChatGPT config.
- `session_mode`: default (`stateless`)
- Registration command: `ops/jungle-register-bearer.sh` (reads the live
  service key, registers, verifies; idempotent, safe to re-run)

Schema source: MCPJungle `docs/guides/register-http-servers.mdx`
(`transport`/`url`/`bearer_token`/`session_mode`/`headers`) and
`pkg/types/mcp_server.go` (`TransportStreamableHTTP = "streamable_http"`).

## Tool prefix

Always-on in jungle, not a toggle: every tool is exposed as
`<server>__<tool>` (`internal/service/mcp/util.go`: `mergeServerToolNames`,
separator constant `serverToolNameSep = "__"`; split on first `__`).
Server names may not contain `__` or end with `_`. Bridge tools arrive as
`beads-bridge__<name>`.

## Bearer handling (task-y1i3e, 2026-09-19 — durable service bearer)

History: the S2 wiring stored a bridge OAuth **access token**
(`bb_at_…`, client `mcpjungle-gateway`) as the static bearer. Access
tokens lived 24h at the time (then `ACCESS_TTL_MS` in `src/lib/oauth.ts`; granted tokens are now never-expiring until revoked) and the gateway
holds no refresh logic, so the bearer expired silently and the gateway's
`/mcp` calls 401'd from 2026-09-18T08:05Z while direct ChatGPT stayed
200 (bridge log: `ALLOW:mcp 401 POST /mcp … ua=Go-http-client/1.1`).
This was expiry, not a regression from the Sep 18 ingress hardening
(`7809762` never touched `src/routes/mcp.ts`; first 401 predates the
18:25 redeploy by ~17h).

Since task-y1i3e the bearer is the bridge service key instead:

- The bridge `/mcp` gate is OAuth (`withMcpAuth` + `lookupAccess`, exact
  `/mcp` audience) for everyone else, PLUS the service key on the
  loopback-only path (`isLoopbackServiceCall` in `src/routes/mcp.ts`).
- The service key never expires, so there is no expiry clock to miss.
- Rotation (no `update server` in the jungle CLI): run
  `ops/jungle-register-bearer.sh` (deregister + re-register via
  `register --force`, no restarts needed). Re-run it any time the
  registry and the bridge desync.
- Failure is loud: a rejected loopback bearer logs a
  `jungle-bearer-mismatch` marker line in the bridge log
  (`~/.local/share/beads-bridge/server.out.log`) — grep for that
  string instead of diagnosing a bare 401.
- Gateway whoami proof now reports no OAuth client (the service path
  carries no OAuth authInfo); bridge-direct OAuth callers are unchanged.

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

## S7 scoped ChatGPT doorway: `/chatgpt/mcp` (2026-10-05)

Sharing the full jungle surface was too broad, so the bridge grew a second,
scoped front door: `src/routes/chatgpt.ts` proxies `https://<funnel-host>/chatgpt/mcp`
to the loopback `chatgpt` tool group (`http://127.0.0.1:8338/v0/groups/chatgpt/mcp`,
`included_servers: ["beads-bridge"]` — verify with `mcpjungle get group chatgpt`).
Same streaming-proxy shape as `/jungle/mcp`, own OAuth audience
(`chatgptResource(BASE)` = `<BASE>/chatgpt/mcp`, discovery at the
`/chatgpt/mcp`-suffixed well-known paths), exact-audience equality across all
three gates, bearer stripped at the gate. Public connector URL for scoped
sharing: `https://<funnel-host>/chatgpt/mcp`. Regression tests in
`src/routes/chatgpt.test.ts` (gate matrix incl. wrong-audience refusal +
`JUNGLE_LIVE=1` proof asserting every tool is `beads-bridge__`-prefixed with
zero leakage from sibling servers).

## S8/S9 scoped Grok and Gemini doorways (2026-10-06)

Two more scoped group doors, same shape as S7: `/grok/mcp`
(`src/routes/grok.ts`) and `/gemini/mcp` (`src/routes/gemini.ts`), each
proxying to its own loopback group endpoint
(`http://127.0.0.1:8338/v0/groups/{grok,gemini}/mcp`, both
`included_servers: ["beads-bridge"]` — verify with `mcpjungle get group
<name>`). Groups are created from the registry side
(`mcpjungle --registry http://127.0.0.1:8338 create group --conf <file>`;
the CLI defaults to port 8080 and refuses there, so the flag is required and
no gateway restart is involved — new groups are visible to new sessions
immediately).

Why one door per assistant rather than sharing ChatGPT's:

- **Grok** (xAI) uses the same OAuth 2.1 machinery as ChatGPT's connector —
  RFC 9728 protected-resource metadata, RFC 8414 auth-server metadata, PKCE,
  Streamable HTTP, DCR — so a bridge that satisfies the ChatGPT connector
  satisfies Grok's. The same endpoint serves the consumer connector surface
  (grok.com/connectors → New Connector → Custom) and the Responses API
  remote-MCP tool.
- **Gemini** takes a remote HTTPS MCP server URL with OAuth on both surfaces
  Google documents: the consumer Gemini app (Settings → Connected apps →
  Custom apps) and Gemini Enterprise (Connected apps → Add MCP Server, or
  Cloud Console → Data Stores → Custom MCP Server).

Audience isolation is per-door and unchanged in kind: a token minted for
`/grok/mcp` never opens `/gemini/mcp`, `/chatgpt/mcp`, `/mcp` or
`/jungle/mcp`, and vice versa. The mechanism (gate, loopback hop, streaming
sender) lives once in `src/lib/scoped-door.ts`; that factory asserts its
upstream hostname is `127.0.0.1` at module load, so the loopback boundary is
mechanical rather than editorial. `src/routes/jungle.ts` deliberately keeps
its own copy of the mechanism: it aims at the whole gateway (`/mcp`) rather
than one tool group, it predates the helper, and task scope excluded
`/jungle/mcp` from refactoring.

### Operator prerequisites a reader will actually hit

- **Gemini Enterprise additionally requires egress allowlisting** of the
  FQDNs of the MCP server URL, the authorization URL and the token URL. On a
  funnel host all three are the same hostname
  (`macbook.hippo-tilapia.ts.net`), so one entry covers them — but the entry
  must exist before the connector will work, and no route change can supply
  it. The consumer Gemini app is also eligibility-gated (Gemini Spark, 18+,
  US) as of this writing.
- **Gemini CLI is deliberately not wired.** `~/.gemini/settings.json`
  `mcpServers.<name>.httpUrl` plus optional static `headers` runs no OAuth
  flow, so it would need a long-lived bearer pasted into a config file rather
  than the connector flow. If that is ever wanted, mint a dedicated audience
  and store the token outside the repo.
- **Registering the connector itself needs a human** in grok.com/connectors
  or the Gemini app. This document proves the server side (endpoint, auth
  challenge, discovery, audience separation); it cannot prove the client
  side.

Regression tests: `src/routes/scoped-doors.test.ts` (table-driven over all
three doors — gate matrix incl. the all-pairs audience refusal, loopback pin,
discovery served for real, all-pairs source contract) plus
`JUNGLE_LIVE=1` parity for the `grok` and `gemini` groups in
`src/routes/jungle-parity.test.ts`.
