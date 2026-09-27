# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Tests touching stores/config need `FUNNEL_BASE` set (e.g. `FUNNEL_BASE=https://example.test bun test ...`); without it those tests fail at import — see `src/config.ts`.
- Project foreground/backlog is label-based: `state:foreground` on a `projects` bead means foreground, everything else is backlog; promotion adds the label plus a when/why comment, demotion is never automatic — see `src/lib/relay.ts`. Lifecycle is separate: `state:deprecated` means closed/superseded (absence = active) and is set/cleared only through the `project_edit` MCP op.
- MCP tools live in `src/routes/mcp.ts` with logic in `src/lib/`; register new tools there and add the test file to the `test` script in `package.json`.
- A server cannot observe a client's loaded tools/list: staleness tools (`tool_surface_check`, `bridge_info`) compare caller-supplied snapshots or feedback-recorded triples vs live and return explicit unknown when there is no reference — never guess (see `docs/tool-surface-check.md`).
- All bead mutations (create/edit/comment/note/close/label) must go through `src/lib/mutate.ts`: shell-free argv, throw-on-failure, verify-after-write receipts. Never build shell strings for writes; `bd()` in `src/util.ts` is reads-only by convention.
- False-success guardrail (`src/lib/receipts.ts`): unverified mutations are errors naming operation/id/store (`requireVerified`/`unverifiedError`), never success — routes return MCP isError / GET 500, batches report partial failure.
- ChatGPT probes OAuth discovery at bare AND `/mcp`-suffixed well-known paths — every discovery doc must be mounted at both (see `src/routes/oauth.ts` Discovery + `src/routes/discovery.test.ts`).
- Live rounds-trip tests (`src/lib/relay-live.test.ts` is the template): a store's bead-id prefix comes from its bd config (`issue-prefix`/`BD_NAME`), never the store name (projects emits `project-*`, assertions emits `assert-*`) — receipt parsing derives candidates mechanically plus a CLI-authoritative fallback, see `src/lib/create.ts` (`expectedIdPrefixes`); shell `projects create` directly and parse the emitted `project-<id>`. Clean up with `projects delete <id> --force` + verify `show` returns null. Tests that spawn several store calls need a per-test `{ timeout }` — bun's 5s default is too tight.
- Public-ingress auth lives in `src/lib/access-gate.ts`, not `src/server.ts`: Funnel forwards onto the loopback socket so `req.ip`/localhost can never separate public from local — the gate splits them by socket peer + Funnel forwarding headers (presence only withholds the localhost bypass, never grants) and requires an OAuth/toolKey bearer on every data/action route. Never re-add an address or User-Agent allow.
- `/mcp` has two gates, both in `src/routes/mcp.ts`: OAuth (exact `/mcp` audience) for remote callers, plus the never-expiring service key (`toolKey`) for the loopback MCPJungle gateway only (`isLoopbackServiceCall` — socket peer + no-forwarding-headers, same rule as the access gate). Never store an expiring OAuth access token as the gateway's static bearer again (2026-09-18 outage); re-register with `ops/jungle-register-bearer.sh`. A rejected loopback bearer logs a `jungle-bearer-mismatch` marker — grep that string first.
- Response footers compose in `src/lib/followons.ts` (`withResponseFooter`: relay-status body + follow-on lines + staleness triple, `heartbeat` registered as the default follow-on) with per-request tool/caller scope installed at the fetch boundary (`withFollowonScope`) — tool callbacks stay untouched. Heartbeat cursor/template rules live in `src/lib/heartbeat.ts` + `config/heartbeat.md`, documented in `docs/heartbeat.md`. `heartbeat`/`relay_status`/`timeout_probe` answer bare (loop prevention); footers are observational-only and bounded.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
