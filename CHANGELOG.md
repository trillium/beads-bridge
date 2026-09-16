# Changelog

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
