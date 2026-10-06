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
PORT="${BEADS_BRIDGE_PORT:-3737}"

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

# Wait for a RUNNING pid, not merely an answered port: the port alone cannot
# tell the new process from the old one draining.
echo "==> waiting for :$PORT"
i=0
pid=""
while [ $i -lt 120 ]; do
  pid=$(launchctl list | awk -v n="$APP_NAME" '$3 == n { print $1 }')
  if [ -n "$pid" ] && [ "$pid" != "-" ] && curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/live" 2>/dev/null; then break; fi
  pid=""
  i=$((i + 1))
  sleep 0.5
done
if [ -z "$pid" ]; then
  echo "!! $APP_NAME has no running pid after 60s" >&2
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

# MCP smoke check. The /live routes above stayed green through the 2026-10-06
# outage in which every MCP call answered "Session terminated" because the
# deployed revision lacked the MCP/auth work — so the route gate alone cannot
# tell a working bridge from a dead MCP path. Probe the real path the clients
# use: a tools/list on /mcp with the service key over loopback.
KEY_FILE="$HOME/.config/pai/beads-bridge-toolkey"
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
exit $rc