# MCP telemetry: storage, retention, and query recipes

Durable per-query JSONL log at the bridge MCP boundary (`src/lib/mcp-telemetry.ts`).
One row per request; privacy-safe by construction (arg names + byte length only,
auth presence boolean only, coarse client class only).

## Storage

- Default dir (persistent, survives reboots): `$XDG_DATA_HOME/beads-bridge/telemetry`,
  else `~/.local/share/beads-bridge/telemetry`.
- Override: `MCP_TELEMETRY_DIR` (tests and ephemeral setups use this).
- Files: `mcp-queries-YYYY-MM-DD.jsonl`, sharded to
  `mcp-queries-YYYY-MM-DD-N.jsonl` when the active file exceeds the file cap.

## Retention knobs (env, with defaults)

| Env | Default | Meaning |
|---|---|---|
| `MCP_TELEMETRY_RETENTION_DAYS` | `30` | delete daily files older than N days |
| `MCP_TELEMETRY_MAX_BYTES` | `104857600` (100 MiB) | total size cap, oldest files deleted first |
| `MCP_TELEMETRY_MAX_FILE_BYTES` | `10485760` (10 MiB) | active-file size cap → shard rotation |

`appendTelemetry` triggers a best-effort prune sweep (throttled to once per
minute per process); `pruneTelemetry(dir?, opts?)` runs a sweep on demand and
returns `{ deleted, keptFiles, keptBytes }`. `readTelemetry(dir?, filter?)`
reads rows back, skipping corrupt lines.

## Query recipes (lifecycle questions)

All recipes assume `DIR` = the telemetry dir, `jq` available.

```bash
DIR=~/.local/share/beads-bridge/telemetry

# Rows per day (traffic volume)
cat $DIR/mcp-queries-*.jsonl | jq -s 'group_by(.ts[0:10]) | map({day: .[0].ts[0:10], n: length})'

# Conversations vs reconnects: distinct sessions per day
cat $DIR/mcp-queries-*.jsonl | jq -s '
  group_by(.ts[0:10]) | map({day: .[0].ts[0:10], sessions: (map(.sessionId) | unique | length)})'

# Refresh loops: sessions with abnormally high request counts
cat $DIR/mcp-queries-*.jsonl | jq -s '
  group_by(.sessionId) | map({session: .[0].sessionId, n: length}) | sort_by(-.n) | .[0:10]'

# Tool mix (what clients actually call)
cat $DIR/mcp-queries-*.jsonl | jq -s 'group_by(.tool) | map({tool: .[0].tool, n: length}) | sort_by(-.n)'

# Error rate per tool
cat $DIR/mcp-queries-*.jsonl | jq -s '
  group_by(.tool) | map({tool: .[0].tool,
    total: length, errors: (map(select(.status >= 500)) | length)})'

# Latency p50/p95 per tool (ms)
cat $DIR/mcp-queries-*.jsonl | jq -s '
  group_by(.tool) | map({tool: .[0].tool,
    p50: (map(.durationMs) | sort | .[(length/2 | floor)]),
    p95: (map(.durationMs) | sort | .[(length*0.95 | floor)])})'

# Client classes over time (who connects: chatgpt/curl/python/node/other)
cat $DIR/mcp-queries-*.jsonl | jq -s 'group_by(.client) | map({client: .[0].client, n: length})'

# Programmatic (TypeScript): filtered read-back
# import { readTelemetry } from './src/lib/mcp-telemetry'
# readTelemetry(dir, r => r.sessionId === 'sess-abc' && r.tool === 'bead_show')
```
