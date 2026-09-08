// Flat-file feedback: one markdown file per submission, query context and
// time in the frontmatter, free text below. Dir defaults to
// ~/data/feedback (FEEDBACK_DIR overrides, honoured for tests).
// Filenames are timestamped + random so concurrent calls never collide.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { storeFromId } from '../util'

export interface FeedbackInput {
  text: string
  kind?: string
  bead?: string
  query?: string
}

export function feedbackDir(): string {
  return process.env.FEEDBACK_DIR ?? join(process.env.HOME ?? tmpdir(), 'data', 'feedback')
}

export function feedbackFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${stamp}-feedback-${rand}.md`
}

function yamlStr(s: string): string {
  return JSON.stringify(s)
}

export function buildFeedbackDoc(input: FeedbackInput, now: Date = new Date()): { filename: string; doc: string } {
  const text = input.text.trim()
  if (!text) throw new Error('text is required')
  const bead = input.bead?.trim() || undefined
  const store = bead ? storeFromId(bead) : null
  if (bead && !store) throw new Error(`unknown bead id: ${input.bead}`)
  const front = [
    '---',
    `created_at: ${now.toISOString()}`,
    `kind: ${yamlStr(input.kind?.trim().slice(0, 40) || 'note')}`,
    ...(bead ? [`bead: ${yamlStr(bead)}`, `store: ${yamlStr(store!)}`] : []),
    ...(input.query?.trim() ? [`query: ${yamlStr(input.query.trim().slice(0, 500))}`] : []),
    'tool: bead_feedback',
    '---',
  ]
  return { filename: feedbackFilename(now), doc: [...front, '', text.slice(0, 4000), ''].join('\n') }
}

export function writeFeedback(input: FeedbackInput, now: Date = new Date()): { path: string; filename: string } {
  const { filename, doc } = buildFeedbackDoc(input, now)
  const dir = feedbackDir()
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  const path = join(dir, filename)
  writeFileSync(path, doc, { mode: 0o644 })
  return { path, filename }
}
