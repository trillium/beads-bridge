// Persistent latest-heartbeat projection for the Live MCP Activity UI.
//
// THE GAP (captain's intent): the live view surfaced heartbeat information
// only transiently, attached to individual activity events (the footer delta
// each footered response carries). Once that activity scrolled or aged out of
// the ring, no always-visible indication of the latest heartbeat remained.
// This module holds the most recently composed heartbeat block in memory so
// the /live page can show it as a persistent region, updated in place.
//
// WHAT "STATUS" MEANS HERE: the snapshot records WHEN the bridge last served
// a heartbeat projection (composition time), to WHOM (caller key only —
// OAuth clientId | loopback-local | anonymous, never a token), through WHICH
// path (an explicit `heartbeat` tool read, or the automatic footer peek on a
// footered response), and the block TEXT itself. A glance tells recency (age
// ticks client-side; past HEARTBEAT_STALE_AFTER_MS the UI reads "stale") and
// content (mode/count/changed ids in the block). A stale heartbeat therefore
// reads as stale, never as current.
//
// SOURCES RECORDED (docs/live-activity.md "Persistent heartbeat"): footer
// peeks + explicit `heartbeat` tool reads, wired at the call sites in
// src/routes/mcp.ts. `relay_status` reads advance the same cursor but return
// the relay projection, not a heartbeat block, so they are not recorded.
//
// SAFETY (inherited from docs/live-activity.md — do not weaken):
// - Observational only: one in-memory snapshot, no store reads, no writes,
//   no agent requests. Restart clears it (same ephemeral posture as the
//   activity ring and the heartbeat cursors).
// - Loop prevention: recording never emits a tool call, never touches the
//   activity ring, and the /live readers are GET-only. recordLatestHeartbeat
//   never throws, so composing a response can never fail because of display.
// - Bounded: cap 1 — only the latest snapshot is retained, never a history.
//   Text is re-sliced to HEARTBEAT_MAX_CHARS (the composer already bounds
//   it); caller is a sanitized key, never arg values or tokens.
// - Transport: the existing SSE fan-out (broadcastSseFrame) carries named
//   `event: heartbeat` frames, so activity frames keep their unnamed shape
//   and a page that does not know the event is unaffected. Frames carry a
//   monotonic rev; consumers apply last-write-wins.
import { broadcastSseFrame } from './activity'
import { HEARTBEAT_MAX_CHARS } from './heartbeat'

/** Past this age the UI must read the snapshot as stale, never as current. */
export const HEARTBEAT_STALE_AFTER_MS = 5 * 60 * 1000

/** Composition path that produced the snapshot. */
export type HeartbeatOrigin = 'footer' | 'heartbeat'

export interface LatestHeartbeat {
  /** Monotonic per-process revision; a client keeps the highest it has seen. */
  rev: number
  /** Composition time, ISO. */
  at: string
  /** Composition time, ms epoch (client-side age arithmetic). */
  atMs: number
  /** Sanitized caller key only (OAuth clientId | loopback-local | anonymous). */
  caller: string
  /** Which composition path produced this block. */
  origin: HeartbeatOrigin
  /** The composed heartbeat block, bounded to HEARTBEAT_MAX_CHARS. */
  text: string
}

export interface HeartbeatFrame extends LatestHeartbeat {
  kind: 'heartbeat'
  event: 'heartbeat:current' | 'heartbeat:update'
}

let latest: LatestHeartbeat | null = null
let rev = 0

function sanitizeCaller(caller: unknown): string {
  try {
    const s = String(caller ?? '').replace(/[\x00-\x1f\x7f]+/g, '').trim()
    return (s || 'anonymous').slice(0, 120)
  } catch {
    return 'anonymous'
  }
}

/** Current snapshot — a copy, so callers can never mutate the authority. */
export function latestHeartbeat(): LatestHeartbeat | null {
  return latest ? { ...latest } : null
}

/** Current snapshot as a replay frame (null before any heartbeat observed). */
export function currentHeartbeatFrame(): HeartbeatFrame | null {
  return latest ? { kind: 'heartbeat', event: 'heartbeat:current', ...latest } : null
}

/** SSE wire form of one heartbeat frame (named event keeps it off the activity path). */
export function sseHeartbeatFrame(frame: HeartbeatFrame): string {
  return `event: heartbeat\ndata: ${JSON.stringify(frame)}\n\n`
}

/**
 * Record the most recently composed heartbeat block, replacing the previous
 * snapshot (cap 1 — never a history), and broadcast it on the shared SSE
 * fan-out. The single mutation entry point. Never throws.
 */
export function recordLatestHeartbeat(input: {
  caller: string
  origin: HeartbeatOrigin
  text: string
  now?: number
}): HeartbeatFrame {
  const atMs = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()
  const snap: LatestHeartbeat = {
    rev: ++rev,
    at: new Date(atMs).toISOString(),
    atMs,
    caller: sanitizeCaller(input.caller),
    origin: input.origin,
    text: String(input.text ?? '').slice(0, HEARTBEAT_MAX_CHARS),
  }
  latest = snap
  const frame: HeartbeatFrame = { kind: 'heartbeat', event: 'heartbeat:update', ...snap }
  try {
    broadcastSseFrame(sseHeartbeatFrame(frame))
  } catch {
    /* the boundary never fails a call */
  }
  return frame
}

/** Test seam: drop the snapshot and reset the revision. */
export function resetLatestHeartbeat(): void {
  latest = null
  rev = 0
}
