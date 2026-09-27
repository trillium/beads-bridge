// Shared sidecar view state for the Live MCP Activity UI (project-s1rf.1.1).
//
// WHAT "THE SAME SESSION" MEANS: the activity ring is process-global and a
// viewer carries no identity, so the only coherent session key is the bridge
// instance itself — every viewer of `GET /live` on one instance shares this
// one view, and a second instance (another port) is a different session. That
// view is therefore held once, here, and never per connection.
//
// TRANSPORT: no second channel. Changes go out over the existing SSE fan-out
// (`broadcastSseFrame` in ./activity) as named `event: view` messages, so
// activity frames keep their current shape and a page that does not know the
// event ignores it. Every frame carries the WHOLE view plus a monotonic
// `revision`, so a consumer applies last-write-wins and never depends on
// frame ordering or on having seen earlier changes.
//
// OBSERVATIONAL: view state is memory only — never a store, never a bead,
// restart clears it (same ephemeral posture as the ring). The only change
// source today is the observed stream (`followActivity`), so the /live
// surface stays GET-only. A tap-driven drawer change would have to arrive
// from a client, which needs a guarded write route this repo does not have;
// see docs/live-activity.md "Drawer sync" for the proposed shape.
import { broadcastSseFrame, observeActivity } from './activity'

export type DrawerState = 'open' | 'closed'

/** Named events carried on the `view` frame (`view:current` = state replay). */
export type SidecarViewEvent = 'view:current' | 'view:open' | 'view:close' | 'view:select'

export interface SidecarView {
  /** Monotonic per-process revision; a client keeps the highest it has seen. */
  revision: number
  drawer: DrawerState
  /** Activity seq the shared view is pointed at (null before any event). */
  selectedSeq: number | null
  at: string
  /** What produced the state: init | activity | a future client channel | test. */
  origin: string
}

export interface SidecarViewFrame extends SidecarView {
  kind: 'view'
  event: SidecarViewEvent
}

export interface ViewPatch {
  drawer?: DrawerState
  selectedSeq?: number | null
}

/** Mobile-first default: the live content leads, navigation is collapsible. */
export const DEFAULT_DRAWER: DrawerState = 'closed'

const initial = (): SidecarView => ({
  revision: 1,
  drawer: DEFAULT_DRAWER,
  selectedSeq: null,
  at: new Date(0).toISOString(),
  origin: 'init',
})

let view: SidecarView = initial()

/** Current shared view — a copy, so callers can never mutate the authority. */
export function currentView(): SidecarView {
  return { ...view }
}

/** Current state as a frame: what a connecting or reconnecting viewer obtains. */
export function currentViewFrame(): SidecarViewFrame {
  return { kind: 'view', event: 'view:current', ...currentView() }
}

/** SSE wire form of one view frame (named event keeps it off the activity path). */
export function sseViewFrame(frame: SidecarViewFrame): string {
  return `event: view\ndata: ${JSON.stringify(frame)}\n\n`
}

function eventFor(patch: ViewPatch): SidecarViewEvent {
  if (patch.drawer !== undefined && patch.drawer !== view.drawer) {
    return patch.drawer === 'open' ? 'view:open' : 'view:close'
  }
  return 'view:select'
}

/**
 * Accept one view change and broadcast it — the single mutation entry point.
 * The activity driver calls it with `origin: 'activity'`; a future guarded
 * client channel would call it with its own origin. A patch that changes
 * nothing still advances the revision, so a caller never has to diff first
 * and consumers stay last-write-wins. Never throws.
 */
export function setView(patch: ViewPatch, origin: string): SidecarViewFrame {
  const theEvent = eventFor(patch)
  const next: SidecarView = {
    revision: view.revision + 1,
    drawer: patch.drawer ?? view.drawer,
    selectedSeq: patch.selectedSeq !== undefined ? patch.selectedSeq : view.selectedSeq,
    at: new Date().toISOString(),
    origin,
  }
  view = next
  const frame: SidecarViewFrame = { kind: 'view', event: theEvent, ...next }
  try {
    broadcastSseFrame(sseViewFrame(frame))
  } catch {
    /* the boundary never fails a call */
  }
  return frame
}

/** Test seam: back to the initial shared state (does not broadcast). */
export function resetViewState(): void {
  view = initial()
}

let following = false

/**
 * Mirror the observed stream into the shared view: every recorded event moves
 * the shared cursor to that event's seq, so every viewer points at the same
 * (newest) activity and a late joiner lands on it too. Idempotent — wiring it
 * at module load below is deliberate, since the shared view exists to mirror
 * this stream.
 */
export function followActivity(): void {
  if (following) return
  following = true
  observeActivity((ev) => {
    setView({ selectedSeq: ev.seq }, 'activity')
  })
}

followActivity()
