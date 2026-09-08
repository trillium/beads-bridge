// Shared debug-state helpers for every agent-fetchable route.
// Failure rule: when a fetch FAILS, the response drops directly into the
// debug state — attempt log + prefilled copyable markdown block + retry
// literals + the debug protocol — instead of requiring a second fetch.
// ?debug=1 still appends the protocol on demand for healthy pages.
//
// The debug-state template lives in blurbs/debug-state.md (read per-hit so
// edits apply without a rebuild); {ATTEMPTS}, {STEPS}, {RESULTS}, and
// {RETRY} are filled in here.
import { readFileSync } from 'fs'
import path from 'path'
import { stripFrontmatter } from '../util'

export interface Attempt { label: string; ok: boolean; detail: string }

const BLURB = path.join(__dirname, '..', '..', 'blurbs', 'debug-state.md')
const PROTOCOL = path.join(__dirname, '..', '..', 'blurbs', 'fetch-debug.md')

// Debug-state protocol from blurbs/fetch-debug.md — read per-hit so edits
// apply without a restart.
export function debugBlock(): string {
  try {
    return "\n" + readFileSync(PROTOCOL, 'utf8').trim()
  } catch { return "\n## debug — wrap your complete output in one fenced markdown block." }
}

export const withDebug = (req: { query: unknown }, body: string) =>
  (req.query as Record<string, unknown>).debug !== undefined ? body + debugBlock() : body

// Auto-debug section: the blurbs/debug-state.md template with its
// placeholders filled, followed by the debug protocol itself.
export function failureDebug(attempts: Attempt[], retry: string[]): string {
  const mark = (a: Attempt) => `${a.ok ? '✅' : '❌'} ${a.label}${a.detail ? ` — ${a.detail}` : ''}`
  const step = (a: Attempt) => `- ${mark(a)}`
  const results = [
    ...attempts.filter((a) => a.ok).map((a) => `- worked: ${a.label}`),
    ...attempts.filter((a) => !a.ok).map((a) => `- did not work: ${a.label} — ${a.detail || 'see above'}`),
  ]
  let template: string
  try {
    template = stripFrontmatter(readFileSync(BLURB, 'utf8'))
  } catch {
    return `\n## debug — a fetch failed. You are in a debug state. Do not guess contents.\n\n${attempts.map(step).join('\n')}` + debugBlock()
  }
  return "\n" + template
    .replaceAll('{ATTEMPTS}', attempts.map((a) => `- ${mark(a)}`).join('\n'))
    .replaceAll('{STEPS}', attempts.map(step).join('\n'))
    .replaceAll('{RESULTS}', results.join('\n'))
    .replaceAll('{RETRY}', retry.map((u) => `- ${u}`).join('\n'))
    + debugBlock()
}
