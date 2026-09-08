// Stale-dependency handoff: unconfirmed bullets (no confirmed: label),
// unverified stories, and open verification tasks in a composed set — each
// with its refresh literal. Always emitted, first among the evidence.
import { BASE } from '../../config'
import type { Row } from './params'

export function staleSection(kept: Record<string, Row[]>, id: string): string[] {
  const unconf = (kept['resume_bullets'] ?? []).filter((r) => !r.labels.some((l) => l.startsWith('confirmed:')))
  const unver = (kept['stories'] ?? []).filter((r) => !r.labels.includes('verification:verified'))
  const open = kept['task'] ?? []
  const lines = [`## stale dependencies — resolve before deciding`, ``]
  if (!unconf.length && !unver.length && !open.length) {
    lines.push(`None in this set — all referenced beads confirmed/verified.`, ``)
  } else {
    const show = (title: string, rows: Row[]) => {
      if (!rows.length) return
      lines.push(`${title} (${rows.length}):`)
      for (const r of rows.slice(0, 8)) lines.push(`- ${r.id} — ${r.title}`)
      if (rows.length > 8) lines.push(`- …and ${rows.length - 8} more`)
      lines.push(``)
    }
    show('Unconfirmed bullets', unconf)
    show('Unverified stories', unver)
    show('Open verification tasks', open)
  }
  lines.push(
    `Refresh once verified/refreshed (fetch after the external action completes):`, ``,
    `${BASE}/fetch/${id}/unconfirmed?fresh=1`,
    `${BASE}/fetch/${id}/findings?fresh=1`,
    `${BASE}/fetch/${id}/stories?fresh=1`,
  )
  return lines
}
