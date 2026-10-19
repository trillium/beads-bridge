// Bounded byte-range comment read path (task-ap93d):
// Slices bead comment text by byte offset and limit to prevent connector
// gateway truncation (~20,000 bytes) on large durable records (e.g. status-kdv).
import { resolveBeadStore, ambiguousBeadIdError, unknownBeadIdError } from './store-aliases'
import { storeFromId } from '../util'
import { beadText } from './exec'
import { relayStatus } from './relay-status'

export interface CommentSliceResult {
  /** The sliced byte range decoded as UTF-8 string. */
  text: string
  /** Next byte offset to fetch, or null if end of comments reached. */
  next_offset: number | null
  /** Total byte size of the concatenated comment text. */
  total_bytes: number
  /** Whether the comments were truncated in this response. */
  truncated: boolean
}

/**
 * Adjust byte index backwards if it points into the middle of a multi-byte UTF-8 sequence,
 * preventing broken characters at slice boundaries.
 */
function adjustToUtf8Boundary(buf: Buffer, index: number): number {
  if (index <= 0) return 0
  if (index >= buf.length) return buf.length
  let i = index
  while (i > 0 && (buf[i] & 0xc0) === 0x80) {
    i--
  }
  const lead = buf[i]
  let expectedLen = 1
  if ((lead & 0xe0) === 0xc0) expectedLen = 2
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4

  if (i + expectedLen > index) {
    return i
  }
  return index
}

/**
 * Slice comment text by byte offset and limit.
 * Byte offsets into the concatenated comment text:
 * Returns { text, next_offset, total_bytes, truncated }.
 */
export function sliceCommentText(commentText: string, offset?: number, limit?: number): CommentSliceResult {
  const buf = Buffer.from(commentText, 'utf8')
  const total_bytes = buf.length
  const rawStart = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0
  const start = adjustToUtf8Boundary(buf, Math.max(0, Math.min(rawStart, total_bytes)))
  const end = typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
    ? adjustToUtf8Boundary(buf, Math.max(start, Math.min(start + limit, total_bytes)))
    : total_bytes
  const text = buf.subarray(start, end).toString('utf8')
  const truncated = end < total_bytes
  const next_offset = truncated ? end : null
  return {
    text,
    next_offset,
    total_bytes,
    truncated,
  }
}

/**
 * Read comments for a bead and slice by byte offset and limit.
 */
export async function readBeadCommentsSlice(
  id: string,
  offset?: number,
  limit?: number,
): Promise<{ ok: true; result: CommentSliceResult } | { ok: false; error: string }> {
  const clean = id.trim()
  const resolved = resolveBeadStore(clean)
  if (resolved.kind === 'ambiguous') {
    return { ok: false, error: ambiguousBeadIdError(clean, resolved.prefix, resolved.candidates) }
  }
  const store = storeFromId(clean)
  if (!store) {
    return { ok: false, error: unknownBeadIdError(clean) }
  }
  relayStatus.markVerified(clean)
  const comments = await beadText(store, ['comments', clean])
  return { ok: true, result: sliceCommentText(comments, offset, limit) }
}
