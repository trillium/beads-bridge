// Build/boot identity for the /live auto-reload (task-4u4ah).
//
// Computed ONCE at import — `backendCommit()` shells out to git, so it must
// never run per request. BOOT_ID changes on every process start (every deploy
// restarts the bridge), which is what lets an open /live tab notice a new
// deploy and reload itself. Not sensitive: a short sha is already in
// `bridge_info`; no paths or env are exposed.
import { randomBytes } from 'node:crypto'
import { backendCommit } from './capabilities'

export const BUILD_COMMIT: string = backendCommit()
export const BOOT_ID: string = Date.now().toString(36) + randomBytes(3).toString('hex')

export interface BuildInfo {
  bootId: string
  commit: string
}

export function currentBuild(): BuildInfo {
  return { bootId: BOOT_ID, commit: BUILD_COMMIT }
}

/** SSE wire form (named event, same pattern as `sseHeartbeatFrame`). */
export function sseBuildFrame(build: BuildInfo = currentBuild()): string {
  return `event: build\ndata: ${JSON.stringify(build)}\n\n`
}

/**
 * Client snippet shared by /live and every variant (inline pages: no asset).
 * Defines `checkBuild(build)`: reload once per distinct new bootId (guard in
 * sessionStorage, in-memory fallback). `onNewBoot` runs first so the caller
 * can reset its highest-seen revisions (a restarted process counts from 1).
 * `BAKED` is the boot id baked into this page at render time.
 */
export function buildGuardJs(onNewBoot = 'function () {}'): string {
  return `var BAKED_BOOT = ${JSON.stringify(BOOT_ID)};
var reloadedFor = null;
function checkBuild(b) {
  if (!b || typeof b.bootId !== 'string' || b.bootId === BAKED_BOOT) return;
  try { (${onNewBoot})(b); } catch (e) {}
  var seen = reloadedFor;
  try { seen = sessionStorage.getItem('live.reloadedFor') || seen; } catch (e) {}
  if (seen === b.bootId) return;
  reloadedFor = b.bootId;
  try { sessionStorage.setItem('live.reloadedFor', b.bootId); } catch (e) {}
  location.reload();
}`
}
