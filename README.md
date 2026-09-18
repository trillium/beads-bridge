# beads-bridge

An MCP gateway and OAuth-gated front door over federated **bead stores** (issue-trackers-as-CLI-databases: one bead = one work item, grouped into named stores like `task`, `projects`, `brain`).

It serves three faces from one Express process:

- **Human/agent fetcher pages** — plain GET routes (`/`, `/next`, `/{bead-id}`, `/{store}`, `/{id}/done`, …) returning Markdown/text.
- **MCP server at `/mcp`** — 36 tools (show, create, edit, comment, label, search, retrieval, projects/relay ops, …) over the same operations as the GET routes.
- **OAuth 2.1 authorization server** — Dynamic Client Registration, human approval, auth-code + PKCE exchange, refresh rotation — co-hosted so MCP connectors (e.g. ChatGPT) can authenticate.
- **`/jungle/mcp` front door** — an OAuth-gated streaming proxy to the loopback MCPJungle gateway (`http://127.0.0.1:8338/mcp`), which fans out to its registered downstream servers.

## Architecture

```
ChatGPT / agents ──HTTPS (funnel)──▶ beads-bridge :3737 ──loopback──▶ MCPJungle :8338 ──▶ downstream servers
                                        │  │  │
                              /mcp ─────┘  │  └──── /jungle/mcp (OAuth-gated proxy, bearer stripped)
                         (36 tools,        │         (jungle audience; streams bytes incl. SSE)
                          mcp-handler)     │
                                    OAuth 2.1 server
                              (register/authorize/token,
                               setup-key approval, PKCE)
                                        │
                                        ▼
                              federated bead stores
                      (~/.config/pai/stores.yaml registry;
                       per-store CLIs via shell-free argv)
```

- **Gateway** (`src/server.ts`, `src/routes/load-routes.ts`): Express on `0.0.0.0:3737`. Routes are file-based — every `src/routes/*.ts` exporting a `*Router` auto-mounts (`mountOrder` controls precedence; MCP/OAuth mount first so parametric `/:id` routes can't swallow them).
- **Front door** (`src/routes/jungle.ts`): verifies a bridge OAuth token minted for the **jungle audience** (`<BASE>/jungle/mcp`), strips the client bearer, and streams the request to the loopback gateway. The upstream is a const, never configurable off-loopback. A token minted for `/mcp` never opens `/jungle/mcp` and vice versa (exact-audience equality). Unauthenticated callers get the RFC 9728 challenge, never proxy traffic.
- **OAuth** (`src/routes/oauth.ts`, `src/lib/oauth.ts`): authorization-server + protected-resource metadata served at both bare and `/mcp`-suffixed well-known paths (plus `/jungle/mcp` variants). Token/client state persists under `~/.config/pai/` so restarts don't revoke clients. Human approval is gated by a setup key (see Configuration).
- **Stores** (`src/config.ts`, `src/util.ts`, `src/lib/exec.ts`): the store registry is `~/.config/pai/stores.yaml` (name → path + `about`). All bead mutations go through `src/lib/mutate.ts` (shell-free argv, throw-on-failure, verify-after-write receipts — see `src/lib/receipts.ts`); reads go through `src/lib/exec.ts`.
- **Access gate** (`src/server.ts`): tailnet IPs and localhost always pass; off-tailnet passes only for approved agent fetchers. Everything else gets 403.
- **Tool namespaces**: the gateway prefixes every tool `<server>__<tool>`. Bridge tools arrive as `beads-bridge__<name>` (36); a second downstream, `firstmate_mcp`, arrives as `firstmate_mcp__<name>` (19) — gateway total 55. Wiring details: `docs/jungle-gateway.md`.

## Quickstart

Prerequisites: [Bun](https://bun.sh), the `bd` bead CLI on `PATH`, a store registry at `~/.config/pai/stores.yaml`.

```sh
git clone https://github.com/trillium/beads-bridge.git
cd beads-bridge
cp .env.example .env   # then fill in FUNNEL_BASE (and TAILNET_IP)
bun install
```

`.env` needs at minimum (see `.env.example`):

```
FUNNEL_BASE=https://<your-funnel-host>
TAILNET_IP=100.x.x.x
```

Run (from the repo root):

```sh
bun src/server.ts
```

First boot mints an OAuth setup key at `~/.config/pai/beads-bridge-oauth-setup` (0600) and prints its path — paste it into the browser approval page once (a cookie remembers it). Override with `OAUTH_SETUP_KEY` (or `OAUTH_SETUP_PATH`) if you prefer.

Expected boot output:

```
beads-bridge on all interfaces :3737
  local:   http://localhost:3737
  tailnet: http://<TAILNET_IP>:3737
  funnel:  https://<your-funnel-host> (public; use this in ChatGPT blurbs)
  oauth setup key: /Users/you/.config/pai/beads-bridge-oauth-setup (paste into the approval page once)
```

Ports: **3737** (this server) + **8338** (upstream MCPJungle gateway on loopback, which fronts this server's `/mcp` plus other downstreams).

## Configuration

| Source | What |
|---|---|
| `.env` (gitignored; see `.env.example`) | `FUNNEL_BASE` (required — public base URL), `TAILNET_IP`, optional `POSTHOG_KEY`/`POSTHOG_HOST`, `OAUTH_SETUP_KEY`, data-path overrides (`FEEDBACK_DIR`, `SCRATCHPAD_PATH`, `IDENTITY_PATH`, `OAUTH_STORE_PATH`), `MCP_DEBUG=1` |
| `~/.config/pai/stores.yaml` | Store registry (name → path + about). Managed by `brain stores`; the server reads it at boot |
| `~/.config/pai/beads-bridge-oauth-setup` | Minted OAuth approval key (0600) |
| `~/.config/pai/beads-bridge-oauth.json` | OAuth token/client state (0600). Delete to revoke all ChatGPT tokens |
| `~/.config/pai/beads-bridge-toolkey` | Tool-bridge bearer token (or `BEADS_BRIDGE_TOOLKEY` env) |
| Telemetry | JSONL under `$XDG_DATA_HOME/beads-bridge/telemetry` (else `~/.local/share/beads-bridge/telemetry`); caps via `MCP_TELEMETRY_RETENTION_DAYS` (30) / `MCP_TELEMETRY_MAX_BYTES` (100 MiB) |

## Tool namespaces

Tools registered in `src/routes/mcp.ts` (36 total), grouped:

- Beads: `bead_show`, `beads_bundle`, `bead_create`, `bead_batch_create`, `bead_edit`, `bead_comment`, `bead_note`, `bead_decision`, `bead_label`, `bead_connections`, `bead_feedback`
- Query/retrieval: `query_store`, `retrieval_search`, `retrieval_activity`, `retrieval_claimed`, `retrieval_snapshot`, `random`, `relay_inspect`
- Projects/relay: `relay_resolve_project`, `relay_list_projects`, `relay_capture`, `project_edit`, `relay_upsert_task`, `relay_dispatch_request`, `relay_verify`, `relay_flow`, `relay_catchup`, `relay_attention_next`, `relay_status`
- Meta: `whoami`, `bridge_info`, `capability_status`, `capabilities_since`, `identity_update`, `scratchpad`, `timeout_probe`

Shipped capabilities are also tracked in `capabilities.json` (manifest v1) — a capability lands only with implementation + tests + manifest entry + changelog/version together.

Behind the loopback gateway these appear as `beads-bridge__<name>`; the sibling `firstmate_mcp` server contributes `firstmate_mcp__<name>` (19 tools, owned by the firstmate repo).

## Testing

Tests need `FUNNEL_BASE` set (the config throws at import without it):

```sh
FUNNEL_BASE=https://example.test bun test <files...>
```

The canonical surface is the `test` script in `package.json` (32 files: unit tests per `src/lib/*` module plus route tests for `read`, `sections`, `entrypoints`, `debug-state`, `query/store`, `discovery`, `jungle`):

```sh
FUNNEL_BASE=https://example.test bun test src/util.test.ts src/wrap.test.ts src/lib/mcp-telemetry.test.ts ... # see "test" in package.json
```

Notes:

- `src/lib/relay-live.test.ts` is a live round-trip suite: it shells to real bead stores (`projects create` → `project-<id>`, cleaned up with `delete --force`) and is timing-sensitive — per-test timeouts apply and isolated re-runs are the norm.
- Running bare `bun test` (no file filter) is not the supported surface — verified: it fails. Always pass the `package.json` file list.
- `bun run typecheck` (`tsc --noEmit`) for types.

## Docs

- `docs/jungle-gateway.md` — MCPJungle ↔ bridge wiring (registration, prefixes, counts, boundaries)
- `docs/jungle-gateway-refresh.md` — ChatGPT connector refresh runbook (staleness lives in the client session)
- `docs/projects.md` — project-bead conventions and project MCP ops
- `docs/telemetry.md` — MCP telemetry storage, retention, query recipes
- `docs/timeout-trials.md` — timeout experiment notes
- `AGENTS.md` / `CLAUDE.md` — contributor notes (mutation/receipt guardrails, OAuth discovery paths, live-test patterns)
