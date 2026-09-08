// Shared blurb sections (partials): single-source prose included by many
// pages. Files live in blurbs/sections/<name>.md, read per-hit so edits
// apply without a rebuild; {BASE} and {RESUME} are filled, frontmatter is
// stripped (its vars: block is the contract, never served).
import { readFileSync } from 'fs'
import path from 'path'
import { BASE } from '../config'
import { stripFrontmatter } from '../util'

export function readSection(name: string, resume = ''): string {
  if (!/^[a-z0-9-]+$/.test(name)) return ''
  try {
    return stripFrontmatter(readFileSync(path.join(__dirname, '..', '..', 'blurbs', 'sections', `${name}.md`), 'utf8'))
      .replaceAll('{BASE}', BASE)
      .replaceAll('{RESUME}', resume)
      .trim()
  } catch {
    return ''
  }
}

export function withSections(body: string, resume: string, ...names: string[]): string {
  const parts = names.map((n) => readSection(n, resume)).filter(Boolean)
  if (!parts.length) return body
  return body + '\n\n---\n\n' + parts.join('\n\n---\n\n')
}
