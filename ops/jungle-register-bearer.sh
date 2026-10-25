#!/bin/bash
# Re-register the MCPJungle gateway's beads-bridge bearer from the bridge's
# live service key (task-y1i3e).
#
# WHEN TO RUN: after any event that desyncs the gateway's stored bearer
# from what the bridge accepts — e.g. a toolKey rotation, a registry
# rebuild, or a `jungle-bearer-mismatch` line in the bridge log
# (~/.local/share/beads-bridge/server.out.log). No gateway or bridge
# restart is needed: registry changes are visible to new MCP sessions
# immediately (see docs/jungle-gateway-refresh.md).
#
# WHAT IT DOES: reads the live service key
# (~/.config/beads-bridge/beads-bridge-toolkey, never printed, never committed),
# writes a 0600 registration config to a temp file, force-registers it
# (deregister + re-register, the only update path the jungle CLI offers),
# shreds the temp file, then verifies the server entry and tool count.
#
# SAFE TO RE-RUN any time: registering the current key is idempotent.
set -euo pipefail
umask 077

REGISTRY="${JUNGLE_REGISTRY:-http://127.0.0.1:8338}"
BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:3737/mcp}"
TOOLKEY_PATH="${TOOLKEY_PATH:-$HOME/.config/beads-bridge/beads-bridge-toolkey}"
# Legacy location (pre-migration) until the bridge has copied the key forward.
[[ -f "$TOOLKEY_PATH" ]] || TOOLKEY_PATH="$HOME/.config/pai/beads-bridge-toolkey"

if ! command -v mcpjungle >/dev/null 2>&1; then
  echo "error: mcpjungle not on PATH" >&2
  exit 1
fi
if [[ ! -f "$TOOLKEY_PATH" ]]; then
  echo "error: no service key at $TOOLKEY_PATH" >&2
  exit 1
fi
if ! curl -sf "$REGISTRY/health" >/dev/null 2>&1; then
  echo "error: jungle gateway not healthy at $REGISTRY" >&2
  exit 1
fi

# Shell-read the key without ever echoing it (set -x stays off; the value
# only ever travels via the temp config file into `mcpjungle register`).
TOOLKEY="$(cat "$TOOLKEY_PATH")"
# Trim trailing whitespace/newlines without printing.
TOOLKEY="${TOOLKEY%"${TOOLKEY##*[![:space:]]}"}"
if [[ -z "$TOOLKEY" ]]; then
  echo "error: service key at $TOOLKEY_PATH is empty" >&2
  exit 1
fi

CONF="$(mktemp "${TMPDIR:-/tmp}/jungle-beads-bridge.XXXXXX.json")"
trap 'rm -f "$CONF"' EXIT
chmod 600 "$CONF"
# JSON-encode the key without printing it (python reads env, writes file).
TOOLKEY="$TOOLKEY" BRIDGE_URL="$BRIDGE_URL" python3 - "$CONF" <<'EOF'
import json, os, sys
with open(sys.argv[1], 'w') as f:
    json.dump({
        "name": "beads-bridge",
        "transport": "streamable_http",
        "url": os.environ["BRIDGE_URL"],
        "bearer_token": os.environ["TOOLKEY"],
        "session_mode": "stateless",
    }, f)
EOF

mcpjungle register --force -c "$CONF" --registry "$REGISTRY"
rm -f "$CONF"
trap - EXIT

echo "--- verify ---"
mcpjungle list servers --registry "$REGISTRY" | head -5
# Count from the gateway HTTP API, not the unreliable `mcpjungle list tools`
# listing (it printed 0 right after a good register, 2026-10-25), and compare
# with the live bridge tools/list. The key reaches curl via stdin config only.
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/jungle-verify.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
curl -sf -m 10 "$REGISTRY/api/v0/tools?server=beads-bridge" > "$WORK/gw.json" \
  || { echo "error: gateway tools API unreachable at $REGISTRY" >&2; exit 1; }
printf 'header = "Authorization: Bearer %s"\n' "$TOOLKEY" | curl -sf -m 10 -K - "$BRIDGE_URL" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' > "$WORK/live.raw" \
  || { echo "error: live bridge tools/list failed at $BRIDGE_URL" >&2; exit 1; }
TOOLKEY=""
LIVE="$(python3 -c '
import json,sys
raw=open(sys.argv[1]).read()
body="\n".join(l[6:] for l in raw.splitlines() if l.startswith("data: ")) or raw
print(len(json.loads(body)["result"]["tools"]))' "$WORK/live.raw")" \
  || { echo "error: live tools/list unparseable" >&2; exit 1; }
python3 "$HERE/gateway-tools.py" report "$WORK/gw.json" "$LIVE" \
  || { echo "error: gateway tool count differs from live bridge" >&2; exit 1; }
