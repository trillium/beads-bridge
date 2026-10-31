# Deploying and looking at beads-bridge

The bridge is a personal single-machine service: one launchd job
(`com.beads-bridge.server`), one public port (3737) plus a tailnet-only
approval port (3738), one clean checkout it serves from. This page is how you ship it and how you look at it.

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

The script refuses to run over a modified deploy checkout, restarts the job,
then waits until the process listening on `:3737` is a different pid from the
one recorded before the restart and `/live` answers. It then prints the status
code of every live route and the OAuth approval-boundary probes (below). Exit
non-zero means the new process never took the port, at least one route is not
200, or a boundary probe is wrong — that is the deploy's own gate.

Which launchd domain is restarted depends on the host. When
`/Library/LaunchDaemons/com.beads-bridge.server.plist` exists, or
`launchctl print system/com.beads-bridge.server` succeeds, the script runs
`sudo -n launchctl kickstart -k system/com.beads-bridge.server` and stops with
that command printed if passwordless sudo is missing. Otherwise it keeps the
per-user `gui/<uid>` bootout and bootstrap (MacBook and mini0).
`ops/deploy.sh --restart-plan` prints `domain=system` or `domain=gui` and does
not restart anything.

**Open `/live` tabs reload on deploy.** Every deploy restarts the process, which
mints a new `BOOT_ID` (`src/lib/build-id.ts`). Pages carry the id they were
rendered with; on seeing a different one (via `/live/config` or the SSE `build`
frame on reconnect) they `location.reload()` once. No script change needed.

## OAuth approval is tailnet-only (QR)

The human approval behind every OAuth grant is no longer a typed setup key.
The public `/oauth/authorize` page shows a QR code, the same URL as a tappable
link, and a short code; the page polls `GET /oauth/pending/:id/status` (public,
returns only `{status}`) and completes by itself once a tailnet device approves.

- **Approval listener:** a second Express listener bound to
  `TAILNET_IP:BEADS_BRIDGE_APPROVAL_PORT` (default `PORT+1` = **3738**). It
  serves only `/oauth/approve/:id` (GET page, POST approve/deny); everything else
  is 404. It must be a separate port because the main server binds `0.0.0.0:3737`,
  which already covers the tailnet address. It refuses any peer outside
  100.64.0.0/10 and any request carrying Funnel/proxy forwarding headers.
- **Public listener:** never mounts `/oauth/approve/*` — it 404s there, even for
  a tailnet-range address or spoofed forwarding headers.
- **Needs `TAILNET_IP`** in the bridge's `.env` (this host's tailnet address).
  Without it the listener stays off and the approval page says approval is not
  configured.
- **Rule for vps01 / Funnel:** the public front must **never** proxy
  `/oauth/approve/*` or port 3738 (the vps01 allowlist is exact; do not add
  either). Approval pages are reachable only over the tailnet.

`ops/deploy.sh` probes all three after a restart and fails the deploy unless:
public `:3737/oauth/approve/…` is 404, the tailnet listener answers 404 for an
unknown id (up), and `127.0.0.1:3738` is not bound (connection refused).

**Old setup key:** the code no longer reads `OAUTH_SETUP_KEY`,
`OAUTH_SETUP_PATH` or `~/.config/beads-bridge/beads-bridge-oauth-setup`. The
file is not deleted by the code; remove it by hand when you like:
`rm ~/.config/beads-bridge/beads-bridge-oauth-setup`.

### Redeploy sequence (per bridge)

Run on each host; the `.env` edit is needed once.

1. Check the deploy checkout `.env` has `TAILNET_IP=<this host's 100.x address>`
   (MacBook: `100.74.138.74`; mini0: its own `tailscale ip -4`). Optional
   `BEADS_BRIDGE_APPROVAL_PORT` (default 3738).
2. Run `ops/deploy.sh <merged-ref>` from the deploy checkout
   (`$HOME/.local/share/beads-bridge/app/ops/deploy.sh`; override the
   location with `DEPLOY_DIR`). Expect `==> oauth approval boundary` to show
   404 / 404 / 000.
3. Open the door's authorize URL, scan the QR (or tap the link) from a
   tailnet-connected device, and approve; the waiting page continues on its own.
4. Confirm vps01 still has no route for `/oauth/approve` or `:3738`.

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