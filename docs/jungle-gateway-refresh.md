# ChatGPT connector refresh runbook — MCPJungle → Beads Bridge

Stale-cache rule (verified S3, 2026-09-16): **staleness lives in the
client session, not the gateway.** After a jungle deregister, a brand-new
MCP session on `http://127.0.0.1:8338/mcp` immediately saw **0** tools;
after re-register the next new session saw all **36**. No gateway restart
was needed at either step. So when ChatGPT shows wrong/old tools, refresh
the ChatGPT connection — don't restart jungle.

## What requires a ChatGPT refresh

- Bridge deploy that adds, removes, or changes tools (compare
  `bridge_info` backend version / manifest / schema hash against what
  ChatGPT was told at connect — the bridge prints this staleness rule
  itself).
- Jungle registry change: server deregistered / re-registered,
  `register --force` (the token-rotation path), tools enabled/disabled,
  new downstream server onboarded (S5).
- Anything where ChatGPT's `tools/list` count ≠ 36 or names lack the
  `beads-bridge__` prefix.

## What does NOT require a refresh

- Jungle gateway restart alone (registry persists in SQLite
  `~/.local/share/mcpjungle/mcpjungle.db`).
- Bridge bearer rotation (server-side only: `ops/jungle-register-bearer.sh`; the bearer never
  appears in ChatGPT config).

## Refresh steps (operator, in ChatGPT)

1. Through any live path, call `beads-bridge__bridge_info` and note
   backend version / manifest / schema hash. Expected now: **v1.2.0,
   manifest v1, 36 tools** (+ **19** `firstmate_mcp__` tools since
   S5a — gateway total **55**; see `docs/jungle-gateway.md`).
2. Disconnect and reconnect the jungle MCP connector in ChatGPT
   (remove/re-add or toggle off/on — this forces a fresh `initialize` +
   `tools/list`).
3. Re-check: `tools/list` must show **55** tools (**36** starting
   with `beads-bridge__`, **19** with `firstmate_mcp__`).
   (`beads-bridge__whoami` on the gateway path reports no OAuth client —
   service-bearer path; bridge-direct OAuth callers still show theirs.)
4. If the count is still wrong after reconnect, the problem is upstream
   of ChatGPT: check jungle health (`GET http://127.0.0.1:8338/health`
   → `{"status":"ok"}`), then `mcpjungle list tools --server
   beads-bridge --registry http://127.0.0.1:8338` (expect 36 ENABLED),
   then bridge-direct health.

## Fast checks from this machine

- `curl -s http://127.0.0.1:8338/health` → `{"status":"ok"}`
- `mcpjungle list servers --registry http://127.0.0.1:8338` → `beads-bridge`
  (`streamable_http`, `http://127.0.0.1:3737/mcp`)
- Fresh-session gateway probe = new `initialize` per check (see S3 record
  in `docs/jungle-gateway.md`); never reuse a session when testing
  registry changes.

## Boundaries (unchanged)

Loopback only (`127.0.0.1:3737` bridge, `127.0.0.1:8338` jungle). The
gateway now runs under launchd (`com.mcpjungle.gateway`, S4 —
`ops/launchd/com.mcpjungle.gateway.plist`; logs at
`~/.local/share/mcpjungle/gateway.{out,err}.log`). Direct bridge URL
stays the documented fallback.
