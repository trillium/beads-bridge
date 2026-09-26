// Personality document (task-xqj24): one durable, substantial operator-
// controlled record — an AGENTS.md-style bootstrap doc for MCP-connected
// assistants. Replaces the 500-char profile-schema model for operating
// instructions: there is no per-field cap, only a generous whole-document
// guard. Path honors PERSONALITY_PATH (tests); default is
// ~/.config/pai/beads-bridge-personality.md. The file holds raw markdown.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadProfile, updateProfile, type OperatorProfile } from './whoami'

// Whole-document guard against runaway writes — ~100 printed pages, not 500
// chars. Replace/append/section-edit all enforce it on the resulting doc.
export const PERSONALITY_MAX_CHARS = 200_000
const MIGRATED_HEADING = 'Migrated from operator profile'

export function personalityPath(): string {
  return process.env.PERSONALITY_PATH ??
    join(process.env.HOME ?? tmpdir(), '.config', 'pai', 'beads-bridge-personality.md')
}

export function defaultPersonality(): string {
  return [
    '# Operator personality',
    '',
    'Durable operating instructions for assistants connected over MCP.',
    'This document is startup/bootstrap context: read it fully at session start.',
    '',
    '## Interaction rules',
    '',
    '(unset — how assistants should work with the operator.)',
    '',
    '## Beads / First Mate usage',
    '',
    '(unset — which stores, when to file beads, how dispatch works.)',
    '',
    '## Speaking preferences',
    '',
    '(unset — tone, length, how to handle ambiguity.)',
    '',
    '## Action repertoire',
    '',
    '- Offer Beads-project discussion when asked who you are.',
    '',
  ].join('\n')
}

// Pure read: a missing file yields the default with existed=false and creates
// nothing — a read must not conjure the operator's document as a side effect.
export function loadPersonality(): { doc: string; existed: boolean } {
  try {
    if (!existsSync(personalityPath())) return { doc: defaultPersonality(), existed: false }
    return { doc: readFileSync(personalityPath(), 'utf8'), existed: true }
  } catch {
    return { doc: defaultPersonality(), existed: false }
  }
}

// Profile fields absorbed by the document (task-xqj24 fold decision):
// operator notes plus the five posture fields. name/role/timezone are
// structural and stay in the profile file.
const MIGRATED_FIELDS = ['notes', 'personality', 'communication', 'principles', 'relationship', 'relay_stance'] as const
const MIGRATED_LABELS: Record<(typeof MIGRATED_FIELDS)[number], string> = {
  notes: 'Operator notes',
  personality: 'Personality',
  communication: 'Communication',
  principles: 'Principles',
  relationship: 'Relationship',
  relay_stance: 'Relay stance',
}

export function migrationSection(p: OperatorProfile): string {
  const parts: string[] = []
  for (const f of MIGRATED_FIELDS) {
    const v = p[f]
    if (v) parts.push(`### ${MIGRATED_LABELS[f]}\n\n${v}`)
  }
  if (!parts.length) return ''
  return [`## ${MIGRATED_HEADING}`, '', ...parts].join('\n') + '\n'
}

function writeDoc(doc: string): void {
  const p = personalityPath()
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(p, doc, { mode: 0o600 })
}

function checkCap(doc: string): void {
  if (doc.length > PERSONALITY_MAX_CHARS) {
    throw new Error(`personality document is ${doc.length} chars, max ${PERSONALITY_MAX_CHARS}`)
  }
}

// Entry-point guarantee: every whoami/personality_* call routes through here,
// so existing operator notes/posture are relocated into the document exactly
// once and never lost behind a missing file. After copying, the migrated
// fields are cleared from the profile so one surface stays canonical.
export function ensurePersonality(profile: OperatorProfile = loadProfile()): { doc: string; migrated: boolean } {
  const cur = loadPersonality()
  if (cur.existed) return { doc: cur.doc, migrated: false }
  const section = migrationSection(profile)
  const doc = section ? `${defaultPersonality()}\n${section}` : defaultPersonality()
  checkCap(doc)
  writeDoc(doc)
  if (section) {
    const patch: Record<string, string> = {}
    for (const f of MIGRATED_FIELDS) if (profile[f]) patch[f] = ''
    if (Object.keys(patch).length) updateProfile(patch)
  }
  return { doc, migrated: section !== '' }
}

// Full replace: the caller's document becomes the whole record verbatim.
export function savePersonality(doc: string): { chars: number } {
  if (!doc.trim()) throw new Error('personality_replace needs a non-empty document')
  checkCap(doc)
  writeDoc(doc)
  return { chars: doc.length }
}

// Append: new text goes at the end. Migrates first so unmigrated profile
// content is the base, never silently dropped.
export function appendPersonality(text: string, profile: OperatorProfile = loadProfile()): { chars: number } {
  const t = text.trim()
  if (!t) throw new Error('personality_append needs text')
  const base = ensurePersonality(profile).doc.replace(/\s+$/, '')
  const doc = `${base}\n\n${t}\n`
  checkCap(doc)
  writeDoc(doc)
  return { chars: doc.length }
}

export function listSections(doc: string): string[] {
  const out: string[] = []
  for (const m of doc.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) out.push(m[1])
  return out
}

// Targeted edit: replace the body under one `## heading` (case-insensitive,
// first match), leaving every other section byte-identical. Sub-sections
// (deeper headings) belong to their parent. Unknown headings error out
// listing what exists, so callers can discover rather than guess.
export function editPersonalitySection(
  heading: string,
  body: string,
  profile: OperatorProfile = loadProfile(),
): { chars: number } {
  const want = heading.trim().toLowerCase()
  if (!want) throw new Error('personality_section_edit needs a heading')
  const t = body.trim()
  if (!t) throw new Error('personality_section_edit needs a non-empty body')
  const base = ensurePersonality(profile).doc
  const lines = base.split('\n')
  let idx = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (m && m[2].toLowerCase() === want) {
      idx = i
      level = m[1].length
      break
    }
  }
  if (idx === -1) {
    throw new Error(`no section '${heading.trim()}' (have: ${listSections(base).join(' | ') || '(none)'})`)
  }
  let end = lines.length
  for (let i = idx + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+.+?\s*$/.exec(lines[i])
    if (m && m[1].length <= level) {
      end = i
      break
    }
  }
  const doc = [...lines.slice(0, idx + 1), '', t, '', ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  checkCap(doc)
  writeDoc(doc)
  return { chars: doc.length }
}
