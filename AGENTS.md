# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Tests touching stores/config need `FUNNEL_BASE` set (e.g. `FUNNEL_BASE=https://example.test bun test ...`); without it those tests fail at import — see `src/config.ts`.
- Project foreground/backlog is label-based: `state:foreground` on a `projects` bead means foreground, everything else is backlog; promotion adds the label plus a when/why comment, demotion is never automatic — see `src/lib/relay.ts`.
- MCP tools live in `src/routes/mcp.ts` with logic in `src/lib/`; register new tools there and add the test file to the `test` script in `package.json`.
- All bead mutations (create/edit/comment/note/close/label) must go through `src/lib/mutate.ts`: shell-free argv, throw-on-failure, verify-after-write receipts. Never build shell strings for writes; `bd()` in `src/util.ts` is reads-only by convention.
- False-success guardrail (`src/lib/receipts.ts`): unverified mutations are errors naming operation/id/store (`requireVerified`/`unverifiedError`), never success — routes return MCP isError / GET 500, batches report partial failure.
- ChatGPT probes OAuth discovery at bare AND `/mcp`-suffixed well-known paths — every discovery doc must be mounted at both (see `src/routes/oauth.ts` Discovery + `src/routes/discovery.test.ts`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
