// Scratchpad: timestamped scratch entries in one flat markdown file.
// Append / read tail / clear. Path defaults to ~/data/scratchpad.md
// (SCRATCHPAD_PATH overrides, honoured for tests). Single-operator,
// no locking — entries are atomic appends.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const HEADER = '# scratchpad\n'

export function scratchpadPath(): string {
  return process.env.SCRATCHPAD_PATH ??
    join(process.env.HOME ?? tmpdir(), 'data', 'scratchpad.md')
}

function ensure(): string {
  const p = scratchpadPath()
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o755 })
  if (!existsSync(p)) writeFileSync(p, HEADER, { mode: 0o644 })
  return p
}

export function scratchAppend(text: string, now: Date = new Date()): { path: string; entries: number } {
  const t = text.trim().slice(0, 2000)
  if (!t) throw new Error('text is required')
  const p = ensure()
  const line = `- ${now.toISOString()} ${t.replace(/\n/g, ' / ')}\n`
  writeFileSync(p, readFileSync(p, 'utf8') + line)
  return { path: p, entries: scratchEntries().length }
}

export function scratchEntries(): string[] {
  try {
    return readFileSync(ensure(), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
  } catch {
    return []
  }
}

export function scratchRead(limit = 20): { entries: string[]; total: number } {
  const all = scratchEntries()
  const n = Math.min(100, Math.max(1, limit))
  return { entries: all.slice(-n), total: all.length }
}

export function scratchClear(): { cleared: number } {
  const n = scratchEntries().length
  writeFileSync(ensure(), HEADER)
  return { cleared: n }
}
