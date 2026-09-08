// Query parameter parsing + validation: the shared vocabulary for turning
// untrusted query/path input into label lists. Pure — no subprocesses.
export const LABEL_RE = /^[A-Za-z0-9:_\-.]{1,64}$/
export const RESUME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,64}$/
export const MAX_LABELS = 10
export const MAX_STORES = 5

export interface Row {
  id: string
  title: string
  labels: string[]
}

export function strParam(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return undefined
}

// Repeatable/comma/plus-separated param → deduped list.
export function listParam(v: unknown): string[] {
  if (v === undefined) return []
  const arr = Array.isArray(v) ? v : [v]
  const out: string[] = []
  for (const item of arr) {
    if (typeof item !== 'string') continue
    for (const part of item.split(/[+,]/)) {
      const t = part.trim()
      if (t) out.push(t)
    }
  }
  return [...new Set(out)]
}

export function cleanLabel(l: string): string | null {
  const t = l.trim()
  if (!LABEL_RE.test(t)) return null
  return t
}
