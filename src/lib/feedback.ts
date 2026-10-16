// Flat-file feedback: one markdown file per submission, query context and
// time in the frontmatter, free text below. Dir defaults to
// ~/data/feedback (FEEDBACK_DIR overrides, honoured for tests).
// Filenames are timestamped + random so concurrent calls never collide.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { storeFromId } from '../util'
import { ambiguousBeadIdError, resolveBeadStore } from './store-aliases'

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
  if (bead) {
    const r = resolveBeadStore(bead)
    if (r.kind === 'ambiguous') throw new Error(ambiguousBeadIdError(bead, r.prefix, r.candidates))
  }
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
  return { filename: feedbackFilename(now), doc: [...front, '', text, ''].join('\n') }
}

export function writeFeedback(input: FeedbackInput, now: Date = new Date()): { path: string; filename: string } {
  const { filename, doc } = buildFeedbackDoc(input, now)
  const dir = feedbackDir()
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  const path = join(dir, filename)
  writeFileSync(path, doc, { mode: 0o644 })
  return { path, filename }
}

// ---------------------------------------------------------------------------
// Editing (feedback mwfd). Records are MUTABLE through feedback_edit only, and
// every edit leaves an audit trail: the full previous version is kept as an
// immutable snapshot under <dir>/.history/ (written exclusively — never
// overwritten) and the record's frontmatter carries `revision`, `updated_at`
// and `last_edit_reason`. A save is only reported once the file is read back
// and the new body, revision and snapshot all check out.
// ---------------------------------------------------------------------------
const FILENAME_RE = /^\d{4}-\d{2}-\d{2}T[\d\-.]+Z-feedback-[a-z0-9]+\.md$/
const ID_RE = /^[a-z0-9]{3,12}$/

export const FEEDBACK_HISTORY_DIR = '.history'

/** Resolve a filename (with or without .md) or the short id suffix (e.g. `mwfd`) to one record. */
export function resolveFeedbackFile(dir: string, ref: string): string {
  const raw = ref.trim()
  if (!raw) throw new Error('id is required (feedback filename or its short id, e.g. "mwfd")')
  if (/[/\\]|\.\./.test(raw)) throw new Error(`bad feedback reference '${ref}'`)
  const withExt = raw.endsWith('.md') ? raw : `${raw}.md`
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => FILENAME_RE.test(n))
  } catch { /* no dir yet => not found below */ }
  if (FILENAME_RE.test(withExt)) {
    if (names.includes(withExt)) return withExt
    throw new Error(`no feedback record named '${withExt}'`)
  }
  if (!ID_RE.test(raw)) throw new Error(`'${ref}' is neither a feedback filename nor a short id`)
  const hits = names.filter((n) => n.endsWith(`-feedback-${raw}.md`))
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) throw new Error(`no feedback record with id '${raw}'`)
  throw new Error(`feedback id '${raw}' is ambiguous: ${hits.join(', ')} — pass the full filename`)
}

interface ParsedDoc {
  front: string[]
  body: string
}

function parseDoc(doc: string): ParsedDoc {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(doc)
  if (!m) throw new Error('feedback record has no frontmatter; refusing to edit it')
  return { front: m[1].split('\n'), body: m[2] }
}

function frontNumber(front: string[], key: string): number {
  const v = front.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim()
  const n = v === undefined ? 0 : Number(v)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

export interface FeedbackEditInput {
  /** Filename (with or without .md) or short id. */
  id: string
  /** replace: the text becomes the whole body. append: added below the existing body. */
  text: string
  mode?: 'replace' | 'append'
  /** Why the record changed; kept in frontmatter and the audit trail. */
  reason?: string
}

export interface FeedbackEditReceipt {
  filename: string
  path: string
  revision: number
  previousRevision: number
  historyPath: string
  mode: 'replace' | 'append'
  verified: boolean
}

export function editFeedback(input: FeedbackEditInput, now: Date = new Date()): FeedbackEditReceipt {
  const text = input.text.trim()
  if (!text) throw new Error('text is required')
  const mode = input.mode ?? 'replace'
  if (mode !== 'replace' && mode !== 'append') throw new Error(`mode must be 'replace' or 'append', got '${String(input.mode)}'`)
  const dir = feedbackDir()
  const filename = resolveFeedbackFile(dir, input.id)
  const path = join(dir, filename)
  const prior = readFileSync(path, 'utf8')
  const { front, body } = parseDoc(prior)
  const previousRevision = frontNumber(front, 'revision')
  const revision = previousRevision + 1
  const stamp = now.toISOString()
  const newBody = mode === 'append' ? `${body.trimEnd()}\n\n**Amendment (${stamp}):**\n${text}\n` : `${text}\n`
  const reason = input.reason?.trim().slice(0, 300)
  const keep = front.filter((l) => !/^(revision|updated_at|last_edit_reason):/.test(l))
  const doc = ['---', ...keep, `updated_at: ${stamp}`, `revision: ${revision}`, ...(reason ? [`last_edit_reason: ${yamlStr(reason)}`] : []), '---', '', newBody].join('\n')

  // Audit trail first: the superseded version, exclusive-create so an existing
  // snapshot (a concurrent edit already took this revision) is an error, never an overwrite.
  const histDir = join(dir, FEEDBACK_HISTORY_DIR)
  mkdirSync(histDir, { recursive: true, mode: 0o755 })
  const historyPath = join(histDir, `${filename.replace(/\.md$/, '')}.r${previousRevision}.md`)
  try {
    writeFileSync(historyPath, prior, { flag: 'wx', mode: 0o444 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`feedback ${filename} was edited concurrently (revision ${previousRevision} already archived); re-read and retry`)
    throw e
  }

  // Atomic replace: temp file in the same dir, then rename over the record.
  const tmp = join(dir, `.${filename}.tmp-${Math.random().toString(36).slice(2, 8)}`)
  try {
    writeFileSync(tmp, doc, { mode: 0o644 })
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* already gone */ }
    try { unlinkSync(historyPath) } catch { /* keep the failure below primary */ }
    throw e
  }

  // Persistence verification: read the record back from disk.
  const back = parseDoc(readFileSync(path, 'utf8'))
  const verified =
    back.body === newBody &&
    frontNumber(back.front, 'revision') === revision &&
    existsSync(historyPath) &&
    readFileSync(historyPath, 'utf8') === prior
  if (!verified) throw new Error(`feedback ${filename} was written but did not read back as expected; re-read it before reporting success`)
  return { filename, path, revision, previousRevision, historyPath, mode, verified }
}

export function formatFeedbackEdit(r: FeedbackEditReceipt): string {
  return [
    `Feedback ${r.filename} updated (${r.mode}) — revision ${r.previousRevision} -> ${r.revision}`,
    `Verified: yes — read back from disk; new body and revision match`,
    `Audit trail: previous version kept at ${FEEDBACK_HISTORY_DIR}/${r.historyPath.split('/').pop()} (read-only snapshot); frontmatter carries revision/updated_at/last_edit_reason`,
  ].join('\n')
}
