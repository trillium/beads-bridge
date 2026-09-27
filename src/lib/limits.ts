// Single bound for free-text body fields across the MCP tool boundary
// (bead descriptions, feedback text, dispatch instructions, …).
//
// Why 100_000: the fleet's durable reports run to the tens of kilobytes
// and Beads itself round-trips 5,200+ characters verbatim through the
// native CLI (storage is SQLite TEXT — no practical ceiling in this
// range). Transport is execFile argv with a 4MB stdout buffer and the
// Express JSON body limit is 2MB, so 100KB fits comfortably end to end
// while still failing LOUDLY at the schema boundary past it instead of
// risking transport/store failures on unbounded payloads.
//
// Invariant: the MCP zod schema is the ONE enforcement point. Lib
// functions pass body text through verbatim and never slice — a schema
// raise without the slice removal (or vice versa) either rejects good
// input or silently truncates it, and silent truncation is worse.
// Import this constant at every schema site and every storage site so
// the two can never diverge again.
//
// Short identifier/summary fields (titles ≤200, queries ≤500, kinds,
// labels) keep their own tighter bounds deliberately — they are looked
// up and displayed, not read as documents.
import { z } from 'zod'

export const MAX_BODY_CHARS = 100_000

export const bodyText = (desc: string) =>
  z.string().max(MAX_BODY_CHARS).describe(desc)

export const requiredBodyText = (desc: string) =>
  z.string().min(1).max(MAX_BODY_CHARS).describe(desc)
