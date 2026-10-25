# Consolidating on the mini1 bridge (2026-10-17, task-k6hoh)

mini1 is the canonical host (it owns the authoritative Dolt). Scout report:
`macbook-ops/data/bridges-canonical-20261017/report.md`. Status of each phase and its rollback.

## Phase 0 / Step A - MacBook SQL reads -> mini1 Dolt (done)
- MacBook `app/.env` gained `BEADS_BRIDGE_SQL_HOST/PORT/USER/PASSWORD/DATABASE` -> `100.102.238.78:3307`, user `bridge_ro`, db `brain_unified`. Old values: all unset (defaults `127.0.0.1:3307 root brain_unified`, the frozen local copy). Backup: `app/.env.bak-pre-mini1-sql-20261017`.
- `bridge_ro` is a SELECT-only Dolt user (`'bridge_ro'@'100.%'`, `GRANT SELECT ON brain_unified.*`) created on mini1; its password is in `~/.config/beads-bridge/sql-ro-password` (0600) on the MacBook.
- `ops/deploy.sh` only fast-forwards tracked files and refuses dirty trees; `.env` is gitignored, so it persists across deploys.
- Rollback: restore the backup `.env`, `launchctl kickstart -k gui/$(id -u)/com.beads-bridge.server`. Drop the user: `DROP USER 'bridge_ro'@'100.%'` on mini1.
- Verify: create a bead via `bead_create`, then `GET /q/<store>?title=<title>&all` finds it at once.

## Phase 1 - mini1 on the current build with its own ingress (done, no ChatGPT traffic yet)
- mini1 `app/` is now a git checkout (`ops/deploy.sh origin/main`); the old copy is `app.pre-deploy-20261017`, the old env `env.bak-20261017` (both in `~/.local/share/beads-bridge/`).
- mini1 `.env`: `FUNNEL_BASE=https://mini1.hippo-tilapia.ts.net:8443`, `TAILNET_IP=100.102.238.78`.
- Ingress: `tailscale funnel --bg --https=8443 3737` on mini1. `:443 -> 13013` (calendar-merge-service) is untouched.
- Rollback: `tailscale funnel --https=8443 off`; stop service, `rm -rf app && mv app.pre-deploy-20261017 app`, restart.
- Verify: `curl https://mini1.hippo-tilapia.ts.net:8443/.well-known/oauth-protected-resource/chatgpt/mcp` returns resource `https://mini1.hippo-tilapia.ts.net:8443/chatgpt/mcp` (bare and `/chatgpt/mcp`-suffixed paths both 200); data routes answer 401/403 unauthenticated.
- Quirk seen: after `deploy.sh`'s bootout/bootstrap the mini1 job sat "pended nondemand spawn" with runs=0 and the deploy reported no pid; `launchctl kickstart -k gui/$(id -u)/com.beads-bridge.server` started it.

## Phase 2 - ChatGPT re-grant (human step, not done)
New connector URL `https://mini1.hippo-tilapia.ts.net:8443/chatgpt/mcp`; OAuth approval is a tailnet-only QR/link shown on the approval page (no typed key; see docs/deploy.md). Keep the old connector until Phase 4.

## Phase 3 - vps01 `/live` and displayd poller (staged, not done)
Repointing before ChatGPT moves would show an empty activity ring (it is per-process memory). After the soak: vps01 Caddy upstream `100.74.138.74:3737` -> `100.102.238.78:3737` (pre-check vps01 -> mini1:3737), and the displayd poller `--bridge` URL likewise. Rollback: restore the old values.

## Phase 4 - retire the MacBook bridge (not done)
After the soak: see the scout report (rsync feedback first, stop the MacBook Dolt last).
