# Changelog

## 1.2.0

- `retrieval_claimed` MCP op + federated claimed-bead query (inbox-l6ki):
  in_progress beads across all stores with claimant, claim timestamp
  (started_at) + computed age, oldest first. Claim evidence only — never
  completion or freshness. RetrievalRow gains assignee/startedAt.

## 1.2.0

- Durable per-query MCP telemetry (inbox-au8v): every /mcp request appended
  as JSONL (timestamps, op/tool, session + protocol metadata, client class,
  versions, correlation ids, timing/status). Secrets never recorded
  (auth presence only, arg names+sizes not values, coarse client class).
  Wrapped around the full fetch chain; logging never fails a response.
  Complements the task-qgplz staleness contract with empirical lifecycle data.

## 1.1.0

- Capability/version contract (task-qgplz): new `bridge_info`,
  `capability_status`, `capabilities_since` MCP operations backed by
  `capabilities.json` (manifest v1, 35 capabilities). Backend reports semver +
  commit + schema hash; stale loaded schemas are detectable with a manual MCP
  refresh path. Shipping invariant: implementation + tests + manifest entry +
  version/changelog land coherently.
- `project_edit`: direct project bead edits — title, description, note,
  lifecycle active/deprecated (inbox-z6dv).

## 1.0.0

- Initial MCP bridge surface: bead CRUD/notes/labels/decisions, whoami,
  scratchpad, relay project/task/dispatch/verify flows, retrieval search.
