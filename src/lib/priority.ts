// Real bead priority (the P0..P4 status). The supported mechanism is the bd
// CLI's own field — `create --priority N` / `update --priority N` — shown in
// `show` as the "[● P2 · OPEN]" header. A `priority:P0` LABEL is just a
// string tag: it never changes that field (2026-10-17 Sidecar: label said P0,
// status stayed P2). Inputs therefore take a `priority` field, and priority
// labels are rejected rather than silently stored. See
// docs/priority-and-project-resolution.md.

export type Priority = 0 | 1 | 2 | 3 | 4

export const PRIORITY_INPUT_HELP = 'Real priority status: 0-4 or P0-P4 (0 = highest). Sets the bead\'s actual P status, not a label.'

// Accepts 0-4, "0"-"4", "P0"-"P4" (any case). Throws on anything else —
// never guesses, never clamps.
export function parsePriority(value: unknown): Priority | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const m = /^p?([0-4])$/i.exec(String(value).trim())
  if (!m) throw new Error(`invalid priority: ${JSON.stringify(value)} (want 0-4 or P0-P4, 0 = highest)`)
  return Number(m[1]) as Priority
}

const PRIORITY_LABEL_RE = /^priority\s*[:=]/i

// null when no label tries to carry priority; otherwise the error to return.
export function priorityLabelError(labels: string[] | undefined): string | null {
  const bad = (labels ?? []).filter((l) => PRIORITY_LABEL_RE.test(l.trim()))
  if (!bad.length) return null
  return `priority labels do not set the real P status: ${bad.join(', ')} — pass the \`priority\` field (0-4 or P0-P4) instead`
}

// The P number in a `show` header line: "○ project-yg4v · Sidecar   [● P2 · OPEN]".
export function priorityFromShow(text: string | null | undefined): Priority | null {
  if (!text) return null
  // The status group is the LAST bracket on the header line — a title may
  // itself contain "[P1]".
  const m = /\[([^\]\n]*)\]\s*$/.exec(text.split('\n', 1)[0])
  const p = m ? /\bP([0-4])\b/.exec(m[1]) : null
  return p ? (Number(p[1]) as Priority) : null
}

// Read-after-write: true only when the read-back header carries exactly the
// requested priority. An unreadable header is NOT confirmation.
export function priorityReadsBack(text: string | null | undefined, want: Priority): boolean {
  return priorityFromShow(text) === want
}
