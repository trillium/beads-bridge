# Deploying and looking at beads-bridge

The bridge is a personal single-machine service: one launchd job
(`com.beads-bridge.server`), one port (3737), one clean checkout it serves
from. This page is how you ship it and how you look at it.

## Where the running code lives

The service does **not** run from the working clone. It runs from a dedicated
deploy checkout:

```
$HOME/.local/share/beads-bridge/app     # clean clone, fast-forwarded to origin/main
~/code/beads-bridge                     # the dev clone; uncommitted work here is NEVER served
```

That separation is the point. The dev clone is where experiments happen; the
deploy checkout is what "deployed" means. Anything uncommitted in the dev clone
is invisible to the running server, and the deploy can always be a clean
fast-forward — the dirty-tree deadlock that pinned the service at an old commit
cannot happen to it.

`ops/launchd/com.beads-bridge.server.plist` is the job definition; its
`WorkingDirectory` is the deploy checkout. Keep the two in step.

## Ship it

```sh
ops/deploy.sh              # fast-forward to origin/main, install, restart, verify
ops/deploy.sh <git-ref>    # or deploy a specific ref (detached HEAD)
```

The script refuses to run over a modified deploy checkout, waits for `:3737`
to answer `/live`, then prints the status code of every live route. Exit
non-zero means at least one route is not 200 — that is the deploy's own gate.

## Look at it

| URL | What it shows |
|---|---|
| `http://localhost:3737/live` | Canonical two-panel sidebar: activity cards left, resolved bead content right. |
| `http://localhost:3737/live/variants` | Index of the candidate surfaces, with provenance for each. |
| `http://localhost:3737/live/v1` | The canonical page again, exposed as a comparison baseline. |
| `http://localhost:3737/live/jumbotron` | Wall-sized glance panel: live/idle state, the newest call at display scale. |
| `http://localhost:3737/live/timeline` | The stream as a time axis, plus calls-by-tool / by-caller and window health. |
| `http://localhost:3737/live/log` | Dense fixed-width log tail, one line per call, newest first. |
| `http://localhost:3737/live/stats` | Aggregates only: totals, error rate, latency percentiles, 30-minute histogram. |

`localhost` needs no credential (direct loopback socket, no forwarding
headers). From another tailnet device use `http://100.74.138.74:3737/live`
(direct tailnet peer). Through Funnel (`https://macbook.hippo-tilapia.ts.net`)
every route including `/live` requires a bearer credential — see
`src/lib/access-gate.ts`.

The ring is in-memory: a restart clears it, so a freshly booted bridge shows
IDLE until real MCP calls arrive. `bead_show` / `query_store` / `whoami`
through `/mcp` are enough to fill it.

## Screenshotting the live pages

Every data-bearing surface holds an EventSource open forever, so the page
never fires `load`. Headless `--screenshot` and `--virtual-time-budget` hang
without ever writing a file; a human in a browser is unaffected. Use the CDP
capture instead, which navigates, waits, and shoots whatever has rendered:

```sh
node ops/live-shot.mjs http://localhost:3737/live/jumbotron shots/jumbotron.png 8000 1600 1000
```