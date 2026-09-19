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
# (~/.config/pai/beads-bridge-toolkey, never printed, never committed),
# writes a 0600 registration config to a temp file, force-registers it
# (deregister + re-register, the only update path the jungle CLI offers),
# shreds the temp file, then verifies the server entry and tool count.
#
# SAFE TO RE-RUN any time: registering the current key is idempotent.
set -euo pipefail
umask 077

REGISTRY="${JUNGLE_REGISTRY:-http://127.0.0.1:8338}"
BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:3737/mcp}"
TOOLKEY_PATH="${TOOLKEY_PATH:-$HOME/.config/pai/beads-bridge-toolkey}"

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
COUNT="$(mcpjungle list tools --server beads-bridge --registry "$REGISTRY" 2>/dev/null | grep -c . || true)"
echo "beads-bridge tools via gateway: $COUNT"
