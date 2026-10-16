#!/bin/sh
# Live, READ-ONLY parity + benchmark run against the authoritative shared Dolt DB.
# Usage: ops/sql-parity/run.sh <bench|list|stall>.ts [args...]
#   bench.ts bundle | retrieval | snapshot <root…> | connections <root…>
#   list.ts                      runListQuery (SQL) vs runListAsync (bd), 69 filter shapes
#   stall.ts connections|snapshot <root…>   worst event-loop gap (run once on main, once on this branch)
# Copies the working tree into a SCRATCH dir on the host (default mini1:
# ~/.local/share/beads-bridge-parity) — never the live app dir, never a
# deploy/restart — and runs there, where the bd wrappers and Dolt are real.
# Needs ~/.local/share/beads-bridge/app/node_modules on the host for deps.
set -e
HOST=${PARITY_HOST:-mini1}
DIR=${PARITY_DIR:-.local/share/beads-bridge-parity}
cd "$(dirname "$0")/../.."
ssh "$HOST" "mkdir -p ~/$DIR && ln -sfn ~/.local/share/beads-bridge/app/node_modules ~/$DIR/node_modules"
rsync -a --delete src config package.json tsconfig.json "$HOST:$DIR/"
rsync -a --delete ops/sql-parity/ "$HOST:$DIR/ops/sql-parity/"
P=$1; shift
ssh "$HOST" "export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:/opt/homebrew/bin:\$PATH; cd ~/$DIR && FUNNEL_BASE=https://example.test RUNS=\${RUNS:-3} bun ops/sql-parity/$P $*"
