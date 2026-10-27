// Per-store result formatting for label queries: one ## section per store
// with id — title lines, or an explicit none/error line (never silent).
import type { Row } from './params'

/** One bead line. Timestamps are appended only when the store reported them. */
export function formatQueryRow(r: Row): string {
  const labels = r.labels.length ? ` [${r.labels.join(', ')}]` : ''
  const times = [
    r.createdAt ? `created_at=${r.createdAt}` : '',
    r.updatedAt ? `updated_at=${r.updatedAt}` : '',
  ].filter(Boolean).join(' ')
  return `${r.id} — ${r.title}${labels}${times ? ` ${times}` : ''}`
}

export function formatSection(store: string, labels: string[], rows: Row[], error?: string): string[] {
  const lines = [`## ${store} — labels: ${labels.join(', ') || '(none)'} (${rows.length})`]
  if (error) {
    lines.push(`- query error: ${error}`)
    return lines
  }
  if (!rows.length) {
    lines.push(`- none`)
    return lines
  }
  for (const r of rows) lines.push(`- ${formatQueryRow(r)}`)
  return lines
}
