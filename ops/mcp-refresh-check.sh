#!/bin/bash
# mcp-refresh-check.sh - read-only: is a loaded Beads Bridge MCP surface stale?
#
# Prints the LIVE bridge version/tool surface next to every LOADED surface it
# can actually observe on this machine, and says whether a manual refresh is
# still required. Changes nothing: no register, no restart, no writes.
#
# Surfaces compared against live (the bridge on 127.0.0.1:3737):
#   1. gateway  - the MCPJungle catalog (what ChatGPT/Grok/Gemini connectors and
#                 any gateway client get). Read from the registry DB, read-only.
#   2. client   - optional, for the session you are worried about, because a
#                 server cannot see a client's loaded tools/list:
#                   --client-version X.Y.Z      version tag the session shows
#                   --client-tools FILE         one tool name per line
#                 (get either from the session: whoami description's
#                 "[bridge vX.Y.Z / manifest vN]" tag, or its tool list)
#
# Exit: 0 = everything observed is current; 1 = refresh required;
#       2 = could not determine (live bridge unreachable / nothing to compare).
#
# Read-only; see docs/jungle-gateway-refresh.md (protocol A-D). Never prints the service key. Uses python3 + curl (+ sqlite3 if present).
set -uo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:3737/mcp}"
TOOLKEY_PATH="${TOOLKEY_PATH:-$HOME/.config/beads-bridge/beads-bridge-toolkey}"
JUNGLE_DB="${JUNGLE_DB:-$HOME/.local/share/mcpjungle/mcpjungle.db}"
JUNGLE_SERVER="${JUNGLE_SERVER:-beads-bridge}"
CLIENT_VERSION=""
CLIENT_TOOLS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client-version) CLIENT_VERSION="${2:-}"; shift 2 ;;
    --client-tools)   CLIENT_TOOLS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (see --help)" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcp-refresh-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

[[ -r "$TOOLKEY_PATH" ]] || { echo "UNKNOWN: no service key at $TOOLKEY_PATH" >&2; exit 2; }
KEY="$(tr -d '[:space:]' < "$TOOLKEY_PATH")"

# --- (a) live server: tools/list over the loopback service door -------------
hdr=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
if ! curl -sf -m 10 "$BRIDGE_URL" -H "Authorization: Bearer $KEY" "${hdr[@]}" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' > "$WORK/live.raw"; then
  echo "UNKNOWN: live bridge not answering at $BRIDGE_URL (launchd com.beads-bridge.server)" >&2
  exit 2
fi
KEY=""

python3 - "$WORK/live.raw" "$WORK" <<'PY' || { echo "UNKNOWN: live tools/list unparseable" >&2; exit 2; }
import json, re, sys
raw = open(sys.argv[1]).read()
body = "\n".join(l[6:] for l in raw.splitlines() if l.startswith("data: ")) or raw
tools = json.loads(body)["result"]["tools"]
names = sorted(t["name"] for t in tools)
open(sys.argv[2] + "/live.names", "w").write("\n".join(names) + "\n")
who = next((t["description"] for t in tools if t["name"] == "whoami"), "")
m = re.search(r"\[bridge v(\d+\.\d+\.\d+) / manifest v(\d+)\]", who)
open(sys.argv[2] + "/live.tag", "w").write(f"{m.group(1)} {m.group(2)}\n" if m else "? ?\n")
PY
read -r LIVE_V LIVE_M < "$WORK/live.tag"
LIVE_N="$(wc -l < "$WORK/live.names" | tr -d ' ')"

# process facts (read-only): which checkout is serving :3737, and what it says
PID="$(lsof -nP -iTCP:3737 -sTCP:LISTEN -t 2>/dev/null | head -1)"
APPDIR=""; STARTED=""
if [[ -n "$PID" ]]; then
  APPDIR="$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  STARTED="$(ps -o lstart= -p "$PID" 2>/dev/null)"
fi
DISK_V=""; DISK_COMMIT=""
if [[ -n "$APPDIR" ]]; then
  DISK_V="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APPDIR/package.json" 2>/dev/null | head -1)"
  DISK_COMMIT="$(git -C "$APPDIR" rev-parse --short HEAD 2>/dev/null)"
fi

echo "== LIVE bridge ($BRIDGE_URL)"
echo "   version v$LIVE_V / manifest v$LIVE_M / $LIVE_N tools (from whoami tag + tools/list)"
echo "   process pid=${PID:-?} started ${STARTED:-?}"
echo "   serving checkout ${APPDIR:-?} @ ${DISK_COMMIT:-?} (package.json v${DISK_V:-?})"
if [[ -n "$DISK_V" && "$DISK_V" != "$LIVE_V" ]]; then
  echo "   NOTE: package.json on disk (v$DISK_V) differs from the running process (v$LIVE_V): the checkout was changed after boot - process restart pending."
fi
echo "   NOTE: from v1.8.1 the initialize reply's serverInfo is {beads-bridge, <package version>}; older servers report the SDK default (0.1.0) - use the whoami tag, not serverInfo, to compare across versions."

REFRESH=0; OBSERVED=0

compare_names() { # $1 = label, $2 = file of loaded names
  local added removed
  added="$(comm -23 "$WORK/live.names" <(sort "$2"))"
  removed="$(comm -13 "$WORK/live.names" <(sort "$2"))"
  if [[ -z "$added$removed" ]]; then echo "   tool names: identical to live ($LIVE_N)"; return 0; fi
  [[ -n "$added" ]]   && echo "   missing from $1 (live has them): $(echo $added)"
  [[ -n "$removed" ]] && echo "   extra in $1 (live dropped them): $(echo $removed)"
  return 1
}

# --- (b) gateway catalog -----------------------------------------------------
echo
echo "== LOADED: MCPJungle gateway catalog (server '$JUNGLE_SERVER')"
if command -v sqlite3 >/dev/null 2>&1 && [[ -r "$JUNGLE_DB" ]]; then
  OBSERVED=1
  sqlite3 -readonly "$JUNGLE_DB" "select t.name from tools t join mcp_servers s on s.id=t.server_id where s.name='$JUNGLE_SERVER' and t.deleted_at is null order by t.name;" > "$WORK/gw.names" 2>/dev/null
  GW_TAG="$(sqlite3 -readonly "$JUNGLE_DB" "select t.description from tools t join mcp_servers s on s.id=t.server_id where s.name='$JUNGLE_SERVER' and t.name like '%whoami';" 2>/dev/null | grep -o 'bridge v[0-9.]* / manifest v[0-9]*' | head -1)"
  GW_AT="$(sqlite3 -readonly "$JUNGLE_DB" "select max(t.updated_at) from tools t join mcp_servers s on s.id=t.server_id where s.name='$JUNGLE_SERVER';" 2>/dev/null)"
  # gateway rows are stored with the server prefix stripped or not; normalise
  sed -i.bak "s/^${JUNGLE_SERVER}__//" "$WORK/gw.names"
  GW_V="$(echo "$GW_TAG" | sed -n 's/bridge v\([0-9.]*\) .*/\1/p')"
  echo "   registered ${GW_AT:-?}; whoami tag: ${GW_TAG:-<none>}; $(wc -l < "$WORK/gw.names" | tr -d ' ') tools"
  gw_stale=0
  [[ -n "$GW_V" && "$GW_V" != "$LIVE_V" ]] && { echo "   VERSION STALE: gateway tag v$GW_V != live v$LIVE_V"; gw_stale=1; }
  compare_names "gateway" "$WORK/gw.names" || gw_stale=1
  if [[ "$gw_stale" -eq 1 ]]; then
    REFRESH=1
    echo "   -> REFRESH REQUIRED at the gateway. Operator (firstmate owns this; shared service):"
    echo "        ops/jungle-register-bearer.sh      # from the beads-bridge deploy checkout; deregister+register --force, no restart"
    echo "      then every gateway client must reconnect (see protocol step C)."
  else
    echo "   -> gateway catalog is current."
  fi
else
  echo "   not observable (need sqlite3 and $JUNGLE_DB); skipping"
fi

# --- (c) operator-supplied client session -------------------------------------
if [[ -n "$CLIENT_VERSION" || -n "$CLIENT_TOOLS" ]]; then
  echo
  echo "== LOADED: client session (operator-supplied)"
  OBSERVED=1
  cl_stale=0
  if [[ -n "$CLIENT_VERSION" ]]; then
    CV="${CLIENT_VERSION#v}"
    if [[ "$CV" != "$LIVE_V" ]]; then echo "   VERSION STALE: session shows v$CV, live is v$LIVE_V"; cl_stale=1
    else echo "   version tag matches live (v$LIVE_V)"; fi
  fi
  if [[ -n "$CLIENT_TOOLS" ]]; then
    if [[ -r "$CLIENT_TOOLS" ]]; then
      sed 's/^[0-9]*\. //; s/^[A-Za-z0-9_-]*__//' "$CLIENT_TOOLS" | grep -v '^$' > "$WORK/cl.names"
      compare_names "client session" "$WORK/cl.names" || cl_stale=1
    else echo "   cannot read $CLIENT_TOOLS"; fi
  fi
  if [[ "$cl_stale" -eq 1 ]]; then
    REFRESH=1
    echo "   -> REFRESH REQUIRED in that session: fix the gateway first if it is stale, then reconnect the MCP server in that harness"
    echo "      (Claude Code: /mcp -> reconnect, or restart session; pi: /mcp-adapter reconnect <server>; ChatGPT/Grok/Gemini: toggle the connector)."
  else
    echo "   -> that session matches live."
  fi
fi

echo
if [[ "$REFRESH" -eq 1 ]]; then
  echo "RESULT: MANUAL REFRESH REQUIRED (live v$LIVE_V). The bridge emits no tools/list_changed to stateless clients; loaded schemas never update themselves."
  exit 1
elif [[ "$OBSERVED" -eq 0 ]]; then
  echo "RESULT: UNKNOWN - nothing observable to compare. Re-run with --client-version / --client-tools from the session in question."
  exit 2
else
  [[ -z "$CLIENT_VERSION$CLIENT_TOOLS" ]] && echo "caveat: no --client-version/--client-tools given, so no individual session was checked."
  echo "RESULT: observed surfaces are current (live v$LIVE_V)."
  exit 0
fi
