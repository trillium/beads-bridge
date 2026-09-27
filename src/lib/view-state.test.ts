// Shared sidecar view state tests (project-s1rf.1.1 drawer sync).
//
// Pins the contract: one authority per bridge instance (the session), a
// monotonic revision so a consumer is last-write-wins, named change events
// (view:open / view:close / view:select / view:current), broadcast over the
// EXISTING SSE fan-out as `event: view` frames, and the activity follow driver
// that keeps every viewer's cursor on the same event.
//
// Unit tests: FUNNEL_BASE=https://example.test bun test src/lib/view-state.test.ts
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { recordEvent, resetActivity, subscribeActivity } from './activity'
import {
  DEFAULT_DRAWER,
  currentView,
  currentViewFrame,
  followActivity,
  resetViewState,
  setView,
  sseViewFrame,
  type SidecarViewFrame,
} from './view-state'

/** Capture every frame the fan-out pushes, the way a live SSE sink does. */
function capture(): { frames: string[]; stop: () => void } {
  const frames: string[] = []
  const stop = subscribeActivity((line) => {
    frames.push(line)
    return true
  })
  return { frames, stop }
}

function viewFrames(frames: string[]): SidecarViewFrame[] {
  return frames
    .filter((f) => f.startsWith('event: view\n'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as SidecarViewFrame)
}

describe('shared sidecar view', () => {
  beforeEach(() => {
    resetActivity()
    resetViewState()
  })

  it('starts closed with no cursor and a replayable current frame', () => {
    const v = currentView()
    assert.equal(v.drawer, DEFAULT_DRAWER)
    assert.equal(v.drawer, 'closed')
    assert.equal(v.selectedSeq, null)
    assert.ok(v.revision >= 1)
    const frame = currentViewFrame()
    assert.equal(frame.kind, 'view')
    assert.equal(frame.event, 'view:current')
    assert.equal(frame.revision, v.revision)
  })

  it('names the drawer change events', () => {
    const open = setView({ drawer: 'open' }, 'client')
    assert.equal(open.event, 'view:open')
    assert.equal(open.drawer, 'open')
    assert.equal(currentView().drawer, 'open')

    const close = setView({ drawer: 'closed' }, 'client')
    assert.equal(close.event, 'view:close')
    assert.equal(close.drawer, 'closed')
  })

  it('names a cursor change view:select', () => {
    const frame = setView({ selectedSeq: 42 }, 'client')
    assert.equal(frame.event, 'view:select')
    assert.equal(frame.selectedSeq, 42)
    assert.equal(currentView().selectedSeq, 42)
  })

  it('advances the revision monotonically, even for a no-op patch', () => {
    const a = setView({ drawer: 'closed' }, 'client')
    const b = setView({ drawer: 'closed' }, 'client')
    assert.equal(a.revision + 1, b.revision)
    assert.ok(setView({ selectedSeq: null }, 'client').revision > b.revision)
  })

  it('hands out copies, never the authority', () => {
    const v = currentView()
    v.drawer = 'open'
    v.selectedSeq = 99
    assert.equal(currentView().drawer, 'closed')
    assert.equal(currentView().selectedSeq, null)
  })

  it('broadcasts every change on the existing fan-out as a named view frame', () => {
    const { frames, stop } = capture()
    try {
      const sent = setView({ drawer: 'open' }, 'client')
      const got = viewFrames(frames)
      assert.equal(got.length, 1)
      assert.deepEqual(got[0], sent)
      assert.equal(sseViewFrame(sent), frames[frames.length - 1])
    } finally {
      stop()
    }
  })

  it('carries state only — no bead, store, or payload fields', () => {
    const frame = setView({ drawer: 'open' }, 'client')
    assert.deepEqual(
      Object.keys(frame).sort(),
      ['at', 'drawer', 'event', 'kind', 'origin', 'revision', 'selectedSeq'],
    )
  })

  it('stops broadcasting after a sink unsubscribes', () => {
    const { frames, stop } = capture()
    setView({ drawer: 'open' }, 'client')
    stop()
    setView({ drawer: 'closed' }, 'client')
    assert.equal(viewFrames(frames).length, 1)
  })

  it('survives a failing sink without losing the state change', () => {
    const stop = subscribeActivity(() => false)
    try {
      const frame = setView({ drawer: 'open' }, 'client')
      assert.equal(currentView().drawer, 'open')
      assert.equal(frame.revision, currentView().revision)
    } finally {
      stop()
    }
  })

  it('follows the activity stream: every event moves the shared cursor', () => {
    followActivity() // idempotent; already wired at module load
    const { frames, stop } = capture()
    try {
      const ev = recordEvent({
        at: new Date(0).toISOString(),
        tool: 'bead_show',
        outcome: 'ok',
        caller: 'loopback-local',
        sessionId: null,
        client: 'curl',
        authed: false,
        durationMs: 2,
        argNames: ['id'],
        beadRefs: [],
        summary: 'x',
      })
      assert.equal(currentView().selectedSeq, ev.seq)
      const sent = viewFrames(frames)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].event, 'view:select')
      assert.equal(sent[0].selectedSeq, ev.seq)
      assert.equal(sent[0].origin, 'activity')
    } finally {
      stop()
    }
  })
})
