# Session MCP update protocol — refreshing a stale Beads Bridge surface

A loaded MCP tool list is frozen when the client connects. The bridge cannot
push a change: the transport is stateless (no session, `GET /mcp` is 405) and
it does not advertise `tools.listChanged`, so a client on an old surface never
learns about a new one by itself. Staleness is detected by comparing three
signals, then fixed by a manual refresh.

Numbers below are as of v1.8.1 (46 tools, manifest v6); read the live values
with step A rather than trusting this page.

## The signals

- `whoami` description tag `[bridge vX.Y.Z / manifest vN]` and the
  `staleness: backend vX / manifest vN / commit … / schema …` footer on every
  response. The schema hash covers each tool's name, description and input
  schema, so a same-name edit moves it.
- `initialize` `serverInfo` = `{ name: "beads-bridge", version: <package.json> }`.
  Servers before v1.8.1 report mcp-handler's default (`0.1.0`); do not compare
  against that.
- `bridge_info` / `tool_surface_check` (`docs/tool-surface-check.md`).

## Protocol

Run from the bridge host. A, B, D are read-only; only C changes anything, and
the gateway is a shared service (firstmate owns it).

**A. Confirm live.** Checkpoint: version, manifest, tool count, serving commit.

```bash
ops/mcp-refresh-check.sh
```

If the serving checkout is behind `origin/main`, run `ops/deploy.sh` first
(it restarts the shared bridge, so it is a captain/firstmate decision). Deploy
before C so the gateway registers once against the final surface. `deploy.sh`
now also re-registers the gateway when the catalog differs from live.

**B. Confirm loaded.** Checkpoint: loaded version tag + tool names.

- In the session: read the `whoami` tag and the `staleness:` footer, or call
  `tool_surface_check` with `client_tools` set to the session's tool names.
- Gateway catalog (the script's second section):
  `sqlite3 -readonly ~/.local/share/mcpjungle/mcpjungle.db "select max(t.updated_at) from tools t join mcp_servers s on s.id=t.server_id where s.name='beads-bridge';"`
- Mismatch in tag, names or count → C. Equal → D (the session may only need
  its own reconnect).

**C. Minimal refresh** (stop as soon as D passes).

1. Gateway: `ops/jungle-register-bearer.sh` from the deploy checkout
   (`mcpjungle register --force`: deregister + register; a brand-new session
   sees 0 tools for a moment; no gateway or bridge restart). Skip if the
   gateway already matches live.
2. Client reconnect, per harness (a registry change reaches only *new*
   connections):
   - Claude Code: `/mcp` → the server → reconnect; else restart the session.
   - pi: `/mcp-adapter reconnect <server>`.
   - ChatGPT / Grok / Gemini connectors: toggle the connector off/on (or
     remove and re-add) — this forces a fresh `initialize` + `tools/list`.
   - claude.ai-hosted connector (direct to the Funnel `/mcp`): disconnect and
     reconnect it in claude.ai settings.

**D. Verify.** Checkpoint: loaded == live.

```bash
ops/mcp-refresh-check.sh --client-version <tag from the session's whoami> [--client-tools <file of its tool names>]
```

Exit 0 = current, 1 = refresh still required, 2 = unknown. In-session, the
`whoami` tag and `staleness:` footer must equal what A printed. If it still
differs after C, the client did not actually reconnect: restart that harness
session. A manual client refresh is always required for a session that loaded
an older surface.

## What does NOT need a refresh

- Gateway restart alone (the registry persists in
  `~/.local/share/mcpjungle/mcpjungle.db`).
- Bridge bearer rotation (server-side only; see `ops/jungle-register-bearer.sh`).

## Fast checks

- `curl -s http://127.0.0.1:8338/health` → `{"status":"ok"}`
- `mcpjungle list servers --registry http://127.0.0.1:8338` → `beads-bridge`
  (`streamable_http`, `http://127.0.0.1:3737/mcp`)
- `curl -s 'http://127.0.0.1:8338/api/v0/tools?server=beads-bridge' | python3 ops/gateway-tools.py names - | wc -l`
  must match the live count (`mcpjungle list tools` is unreliable: it printed
  0 while the API held 46; `ops/jungle-register-bearer.sh` and
  `ops/mcp-refresh-check.sh` use the API).
- Use a new `initialize` per check when testing registry changes; never reuse
  a session (see `docs/jungle-gateway.md`).

## Boundaries

Loopback only (`127.0.0.1:3737` bridge, `127.0.0.1:8338` gateway). The gateway
runs under launchd (`com.mcpjungle.gateway`, `ops/launchd/com.mcpjungle.gateway.plist`;
logs `~/.local/share/mcpjungle/gateway.{out,err}.log`). The direct bridge URL
stays the documented fallback. The scripts never print the service key.
