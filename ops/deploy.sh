#!/bin/sh
# Deploy beads-bridge to its own clean checkout and restart the launchd service.
#
# Why a deploy checkout instead of the dev clone: the service used to run from
# the working clone (~/code/beads-bridge), which meant every uncommitted
# experiment in that tree was silently part of the running server, and a
# fast-forward to origin/main was impossible while the tree was dirty. The
# deploy directory is a clean clone at origin/main; the dev clone stays a dev
# clone and its uncommitted work is never served.
#
# Usage:  ops/deploy.sh [git-ref]     (default: origin/main)
# Env:    DEPLOY_DIR   default $HOME/.local/share/beads-bridge/app
#         APP_NAME     default com.beads-bridge.server
set -eu

REF="${1:-origin/main}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/.local/share/beads-bridge/app}"
APP_NAME="${APP_NAME:-com.beads-bridge.server}"
PLIST="$HOME/Library/LaunchAgents/$APP_NAME.plist"
# mini1 runs the bridge as a system LaunchDaemon. The per-user agent there
# was renamed aside, so bootout/bootstrap in gui/<uid> fails EIO while the
# old process keeps answering the port. Override is for tests only.
SYSTEM_PLIST="${BEADS_BRIDGE_SYSTEM_PLIST:-/Library/LaunchDaemons/$APP_NAME.plist}"
PORT="${BEADS_BRIDGE_PORT:-3737}"

# system when that LaunchDaemon is installed or already loaded; otherwise the
# gui-domain LaunchAgent path (macbook, mini0) is unchanged.
service_domain() {
  if [ -f "$SYSTEM_PLIST" ] || launchctl print "system/$APP_NAME" >/dev/null 2>&1; then
    echo system
  else
    echo gui
  fi
}

# Pid of whatever is accepting TCP on $PORT. Empty when nothing is listening.
listener_pid() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

# Restart the system LaunchDaemon. sudo -n must work; a password prompt would
# hang a deploy, and continuing would let the old process pass the health check.
kickstart_system() {
  if err=$(sudo -n launchctl kickstart -k "system/$APP_NAME" 2>&1); then
    return 0
  fi
  case "$err" in
    *password*|*terminal*|*not\ permitted*)
      echo "!! sudo -n is not available, so $APP_NAME was not restarted." >&2
      ;;
    *)
      echo "!! launchctl kickstart failed: $err" >&2
      ;;
  esac
  echo "!! Run: sudo launchctl kickstart -k system/$APP_NAME" >&2
  return 1
}

case "${1:-}" in
  --restart-plan)
    printf 'domain=%s\n' "$(service_domain)"
    exit 0
    ;;
esac

# Test hook: exercise kickstart_system without touching a checkout or a live job
# beyond the sudo/launchctl commands on PATH. Unset in normal deploys.
if [ "${DEPLOY_RESTART_HOOK:-}" = 1 ]; then
  kickstart_system
  exit $?
fi

echo "==> deploying $REF to $DEPLOY_DIR"
mkdir -p "$(dirname "$DEPLOY_DIR")"
if [ ! -d "$DEPLOY_DIR/.git" ]; then
  git clone https://github.com/trillium/beads-bridge.git "$DEPLOY_DIR"
fi
cd "$DEPLOY_DIR"
git fetch origin --prune
# The deploy checkout is never edited, only fast-forwarded: refuse to clobber
# anything that would mean a deploy checkout was mutated in place.
if [ -n "$(git status --porcelain)" ]; then
  echo "!! $DEPLOY_DIR has local modifications; refusing to deploy over them" >&2
  git status --short >&2
  exit 1
fi
git checkout -q --detach "$REF"
git reset -q --hard "$REF"
git submodule update --init --recursive 2>/dev/null || true
pnpm install --frozen-lockfile
[ -f .env ] || { echo "!! $DEPLOY_DIR/.env is missing (FUNNEL_BASE etc.)" >&2; exit 1; }
echo "    now at $(git log --oneline -1)"

echo "==> restarting $APP_NAME"
# Recorded before the restart so a survivor of the old process cannot pass
# the health check below. Empty when the port was not taken.
OLD_LISTENER="$(listener_pid)"
DOMAIN_KIND="$(service_domain)"
if [ "$DOMAIN_KIND" = system ]; then
  echo "    domain system/$APP_NAME (listener before restart: ${OLD_LISTENER:-none})"
  kickstart_system
else
echo "    domain gui/$(id -u) (listener before restart: ${OLD_LISTENER:-none})"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$APP_NAME" 2>/dev/null || true

# bootout is asynchronous. Until it finishes, the job is still `print`-able
# (state: SIGTERMed, cleanup scheduled) and the OLD process is still answering
# :$PORT during its shutdown grace period. Observed on 2026-10-06: a deploy
# checked routes 200ms after bootout, got 200s from the dying process, and
# reported success while the service was in fact being removed — a false pass
# that left the bridge down. So wait for the job to genuinely disappear first.
i=0
while launchctl print "$DOMAIN/$APP_NAME" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "!! $APP_NAME did not unload within 30s" >&2
    exit 1
  fi
  sleep 0.5
done

# bootstrap can race the bootout that just finished and answer EIO
# ("Bootstrap failed: 5: Input/output error"). A deploy that leaves the service
# down is worse than a slow deploy, so retry a bounded number of times.
tries=0
while :; do
  if err=$(launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1); then break; fi
  tries=$((tries + 1))
  if [ "$tries" -ge 10 ]; then
    echo "!! launchctl bootstrap failed after $tries attempts: $err" >&2
    exit 1
  fi
  sleep 1
done
fi

# Wait for a NEW listener on $PORT, not merely an answered port. On the
# system-domain host the job is not in the user `launchctl list`, and an old
# process kept answering /live after a failed gui bootstrap (2026-10-31).
echo "==> waiting for :$PORT"
i=0
pid=""
while [ $i -lt 120 ]; do
  listen="$(listener_pid)"
  job_pid=""
  if [ "$DOMAIN_KIND" != system ]; then
    job_pid=$(launchctl list | awk -v n="$APP_NAME" '$3 == n { print $1 }')
  fi
  if [ -n "$listen" ] && [ "$listen" != "$OLD_LISTENER" ] \
    && { [ "$DOMAIN_KIND" = system ] || { [ -n "$job_pid" ] && [ "$job_pid" != "-" ]; }; } \
    && curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/live" 2>/dev/null; then
    pid="$listen"
    break
  fi
  pid=""
  i=$((i + 1))
  sleep 0.5
done
if [ -z "$pid" ]; then
  echo "!! $APP_NAME has no new listener on :$PORT after 60s (old pid ${OLD_LISTENER:-none})" >&2
  exit 1
fi
echo "    running as pid $pid"

echo "==> live route check"
rc=0
for p in /live /live/variants /live/v1 /live/jumbotron /live/timeline /live/log /live/stats; do
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p")
  printf '    %-16s %s\n' "$p" "$code"
  [ "$code" = 200 ] || rc=1
done

# OAuth approval boundary. Human approval is tailnet-only: a second listener
# bound to TAILNET_IP:APPROVAL_PORT (default PORT+1) serves /oauth/approve/*,
# and the public listener must not serve it at all. Both probes use an id that
# does not exist, so a healthy answer is a plain 404 on each; anything else is
# a broken boundary or a listener that never came up. Read TAILNET_IP and the
# port from the deploy .env (the same file the service loads). Skipped, loudly,
# when .env has no TAILNET_IP: the approval page then says approval is
# unconfigured and no new grant can be made on that host.
env_val() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"' "; }
TAILNET_IP_VAL="${TAILNET_IP:-$(env_val TAILNET_IP)}"
APPROVAL_PORT="${BEADS_BRIDGE_APPROVAL_PORT:-$(env_val BEADS_BRIDGE_APPROVAL_PORT)}"
APPROVAL_PORT="${APPROVAL_PORT:-$((PORT + 1))}"
echo "==> oauth approval boundary"
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/oauth/approve/deploy-probe" || true)
printf '    %-34s %s (want 404)\n' "public :$PORT /oauth/approve" "$code"
[ "$code" = 404 ] || rc=1
if [ -n "$TAILNET_IP_VAL" ]; then
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$TAILNET_IP_VAL:$APPROVAL_PORT/oauth/approve/deploy-probe" || true)
  printf '    %-34s %s (want 404 = listener up)\n' "tailnet $TAILNET_IP_VAL:$APPROVAL_PORT" "$code"
  [ "$code" = 404 ] || rc=1
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APPROVAL_PORT/oauth/approve/deploy-probe" || true)
  printf '    %-34s %s (want 000 = not bound to loopback)\n' "loopback :$APPROVAL_PORT" "$code"
  [ "$code" = 000 ] || rc=1
else
  echo "    !! no TAILNET_IP in $DEPLOY_DIR/.env: tailnet approval listener is OFF; new OAuth grants are impossible here" >&2
  rc=1
fi

# MCP smoke check. The /live routes above stayed green through the 2026-10-06
# outage in which every MCP call answered "Session terminated" because the
# deployed revision lacked the MCP/auth work — so the route gate alone cannot
# tell a working bridge from a dead MCP path. Probe the real path the clients
# use: a tools/list on /mcp with the service key over loopback.
KEY_FILE="$HOME/.config/beads-bridge/beads-bridge-toolkey"
[ -r "$KEY_FILE" ] || KEY_FILE="$HOME/.config/pai/beads-bridge-toolkey" # legacy, pre-migration
if [ -r "$KEY_FILE" ]; then
  body=$(curl -s -m 10 -X POST "http://127.0.0.1:$PORT/mcp" \
    -H "Authorization: Bearer $(cat "$KEY_FILE")" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' || true)
  if printf '%s' "$body" | grep -q '"tools":\[{'; then
    printf '    %-16s %s\n' 'MCP tools/list' "$(printf '%s' "$body" | grep -o '"name":"[a-z_]*"' | wc -l | tr -d ' ') tools"
  else
    printf '    %-16s %s\n' 'MCP tools/list' 'EMPTY OR UNREACHABLE'
    rc=1
  fi
else
  echo "    !! $KEY_FILE unreadable; skipping MCP smoke check" >&2
fi

# Gateway catalog. The MCPJungle gateway caches tool metadata at register
# time, so a deploy that adds/removes/re-describes tools leaves every gateway
# client (ChatGPT/Grok/Gemini) on the old surface until it is re-registered —
# the 2026-10 catalog sat on v1.7.0 / 44 tools for 11 days against a live
# v1.8.0 / 46. Compare live tools/list + whoami tag with the catalog
# (ops/mcp-refresh-check.sh, read-only: exit 0 current, 1 stale, 2 unknown)
# and re-register only when they differ. Never gates the deploy result and
# never prints the service key; re-running is idempotent. Skipped when the
# smoke checks above already failed (do not register a broken surface).
echo "==> gateway catalog"
if [ "$rc" -ne 0 ]; then
  echo "    skipped: bridge checks failed above; fix, then run ops/mcp-refresh-check.sh"
else
  grc=0
  "$DEPLOY_DIR/ops/mcp-refresh-check.sh" >/dev/null 2>&1 || grc=$?
  case "$grc" in
    0) echo "    gateway catalog matches live" ;;
    1)
      echo "    gateway catalog differs from live; re-registering"
      if "$DEPLOY_DIR/ops/jungle-register-bearer.sh" >/dev/null 2>&1; then
        echo "    re-registered; reconnect gateway clients (docs/jungle-gateway-refresh.md step C)"
      else
        echo "    !! re-register failed: run $DEPLOY_DIR/ops/jungle-register-bearer.sh" >&2
      fi
      ;;
    *) echo "    gateway not observable: run $DEPLOY_DIR/ops/mcp-refresh-check.sh, then $DEPLOY_DIR/ops/jungle-register-bearer.sh if stale" ;;
  esac
fi
exit $rc