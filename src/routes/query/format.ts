// Per-store result formatting for label queries: one ## section per store
// with id — title lines, or an explicit none/error line (never silent).
import type { Row } from './params'

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
  for (const r of rows) lines.push(`- ${r.id} — ${r.title}`)
  return lines
}
