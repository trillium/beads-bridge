import { readdirSync, readFileSync, statSync, realpathSync } from 'fs'
import { join, relative, resolve, sep } from 'path'

export const INSPECT_CHUNK_CAP = 16 * 1024
export const INSPECT_MAX_FILES = 5
export const INSPECT_MAX_ENTRIES = 200
export const INSPECT_MAX_MATCHES = 30

const ALLOW_EXT = new Set(['.ts', '.tsx', '.js', '.json', '.md', '.yaml', '.yml', '.txt'])
const DENY_DIRS = new Set(['node_modules', '.git', 'dist', '.worktrees', 'data'])
const DENY_FILES = new Set(['package-lock.json', 'bun.lock', 'pnpm-lock.yaml'])

export function inspectRoot(): string {
  if (process.env.BRIDGE_ROOT?.trim()) return resolve(process.env.BRIDGE_ROOT.trim())
  return resolve(join(__dirname, '..', '..'))
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

function readableFile(name: string): boolean {
  if (DENY_FILES.has(name)) return false
  if (name.endsWith('.log') || name.endsWith('.map') || name.endsWith('.min.js')) return false
  return ALLOW_EXT.has(extOf(name))
}

function insideRoot(root: string, p: string): string | null {
  const abs = resolve(root, p)
  const realRoot = realpathSync(root)
  let realAbs: string
  try {
    realAbs = realpathSync(abs)
  } catch {
    realAbs = abs
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) return null
  return abs
}

export function inspectTree(rel = '.', depth = 3, limit = INSPECT_MAX_ENTRIES): string {
  const root = inspectRoot()
  const start = insideRoot(root, rel)
  if (!start) return `# inspect tree — denied\n\nPath escapes the Bridge checkout.`
  const lines: string[] = []
  const cap = Math.max(1, Math.min(INSPECT_MAX_ENTRIES, limit))
  const maxDepth = Math.max(0, Math.min(5, depth))
  let stopped = false
  const walk = (dir: string, d: number) => {
    if (stopped || lines.length >= cap) {
      stopped = true
      return
    }
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const n of names) {
      if (lines.length >= cap) {
        stopped = true
        break
      }
      const abs = join(dir, n)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      const shown = relative(root, abs) || '.'
      if (st.isDirectory()) {
        if (DENY_DIRS.has(n)) continue
        lines.push(`${shown}/`)
        if (d < maxDepth) walk(abs, d + 1)
      } else if (st.isFile()) {
        if (readableFile(n)) lines.push(shown)
      }
      if (stopped) break
    }
  }
  walk(start, 0)
  const head = `# inspect tree — ${relative(root, start) || '.'} (${lines.length}${stopped ? ', truncated' : ''})`
  return [head, ``, ...lines].join('\n')
}

export function inspectSearch(pattern: string, rel = '.', limit = INSPECT_MAX_MATCHES): string {
  const q = pattern.trim()
  if (!q) return `# inspect search — denied\n\nEmpty pattern.`
  const root = inspectRoot()
  const start = insideRoot(root, rel)
  if (!start) return `# inspect search — denied\n\nPath escapes the Bridge checkout.`
  const cap = Math.max(1, Math.min(INSPECT_MAX_MATCHES, limit))
  const hits: string[] = []
  let filesScanned = 0
  const walk = (dir: string): void => {
    if (hits.length >= cap || filesScanned > 300) return
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const n of names) {
      if (hits.length >= cap || filesScanned > 300) return
      const abs = join(dir, n)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!DENY_DIRS.has(n)) walk(abs)
      } else if (st.isFile() && readableFile(n) && st.size <= 512 * 1024) {
        filesScanned++
        let body: string
        try {
          body = readFileSync(abs, 'utf8')
        } catch {
          continue
        }
        const lines = body.split('\n')
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
          const at = lines[i].indexOf(q)
          if (at >= 0) {
            const lo = Math.max(0, at - 60)
            hits.push(`${relative(root, abs)}:${i + 1}: …${lines[i].slice(lo, lo + 160).trim()}…`)
          }
        }
      }
    }
  }
  walk(start)
  if (!hits.length) return `# inspect search — no match\n\nNo "${q.slice(0, 120)}" in readable Bridge sources under ${relative(root, start) || '.'} (${filesScanned} files scanned).`
  return [`# inspect search — "${q.slice(0, 120)}" (${hits.length})`, ``, ...hits].join('\n')
}

export function inspectRead(rel: string, offset = 1, limit = 120): string {
  const root = inspectRoot()
  const abs = insideRoot(root, rel)
  if (!abs) return `# inspect read — denied\n\nPath escapes the Bridge checkout.`
  const base = abs.split(sep).pop() ?? ''
  if (!readableFile(base)) return `# inspect read — denied\n\n${rel} is not a readable source file (want .ts/.json/.md/.yaml/.txt, no logs/locks/minified).`
  let body: string
  try {
    body = readFileSync(abs, 'utf8')
  } catch {
    return `# inspect read — missing\n\nNo such file: ${rel}.`
  }
  const lines = body.split('\n')
  const from = Math.max(1, offset)
  const count = Math.max(1, Math.min(300, limit))
  const slice = lines.slice(from - 1, from - 1 + count).join('\n')
  let chunk = slice
  let cut = false
  if (Buffer.byteLength(chunk, 'utf8') > INSPECT_CHUNK_CAP) {
    chunk = Buffer.from(chunk, 'utf8').subarray(0, INSPECT_CHUNK_CAP).toString('utf8')
    cut = true
  }
  const total = `${from}-${from - 1 + slice.split('\n').length} of ${lines.length} lines${cut ? ' (16KB chunk cap — narrow offset/limit to continue)' : ''}`
  return [`# inspect read — ${relative(root, abs)} (${total})`, ``, '```', chunk, '```'].join('\n')
}

export function inspectReadMany(rels: string[]): string {
  const root = inspectRoot()
  const wanted = rels.map((r) => r.trim()).filter(Boolean).slice(0, INSPECT_MAX_FILES)
  if (!wanted.length) return `# inspect read-many — denied\n\nNo files given (max ${INSPECT_MAX_FILES}).`
  const parts: string[] = []
  for (const rel of wanted) {
    const abs = insideRoot(root, rel)
    if (!abs) {
      parts.push(`## ${rel} — denied (escapes the Bridge checkout)`)
      continue
    }
    const base = abs.split(sep).pop() ?? ''
    if (!readableFile(base)) {
      parts.push(`## ${rel} — denied (not a readable source file)`)
      continue
    }
    let body: string
    try {
      body = readFileSync(abs, 'utf8')
    } catch {
      parts.push(`## ${rel} — missing`)
      continue
    }
    let chunk = body
    let cut = false
    if (Buffer.byteLength(chunk, 'utf8') > INSPECT_CHUNK_CAP) {
      chunk = Buffer.from(chunk, 'utf8').subarray(0, INSPECT_CHUNK_CAP).toString('utf8')
      cut = true
    }
    parts.push([`## ${relative(root, abs)} (${body.split('\n').length} lines${cut ? ', 16KB chunk cap' : ''})`, ``, '```', chunk, '```'].join('\n'))
  }
  return [`# inspect read-many (${parts.length} file${parts.length === 1 ? '' : 's'})`, ``, ...parts].join('\n\n')
}
