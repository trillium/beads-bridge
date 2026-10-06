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
launchctl bootout "gui/$(id -u)/$APP_NAME" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "==> waiting for :$PORT"
i=0
while [ $i -lt 60 ]; do
  if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/live"; then break; fi
  i=$((i + 1))
  sleep 0.5
done

echo "==> live route check"
rc=0
for p in /live /live/variants /live/v1 /live/jumbotron /live/timeline /live/log /live/stats; do
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p")
  printf '    %-16s %s\n' "$p" "$code"
  [ "$code" = 200 ] || rc=1
done
exit $rc