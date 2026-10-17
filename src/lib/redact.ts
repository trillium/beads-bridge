// Secret redaction for values the /live event stream DISPLAYS (task-7y3fm).
//
// The activity ring used to record argument NAMES only. The event stream shows
// the arguments themselves, so everything shown passes through here first:
// by KEY name (a `token`/`password`/`authorization`-ish key hides its whole
// value, whatever the shape) and by VALUE shape (bearer headers, well-known
// token prefixes, JWTs, PEM blocks) for secrets pasted into free text.
// Pure and total: never throws, never mutates its input.

export const REDACTED = '[redacted]'

// Key names whose value is hidden wholesale. Matched against the lowercased
// key with separators stripped, so api_key / apiKey / API-KEY all collapse.
const SECRET_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'apikey',
  'accesskey',
  'privatekey',
  'secretkey',
  'bearer',
  'cookie',
  'credential',
  'signature',
]

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  // Exact short names only: `auth*`/`key*` as substrings would hide `author`.
  if (k === 'key' || k === 'pwd' || k === 'pw' || k === 'auth') return true
  return SECRET_KEY_PARTS.some((p) => k.includes(p))
}

// Value shapes that are secrets wherever they appear inside a string.
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  // key=value / key: value pairs written inline in text or URLs.
  [
    /\b((?:access_|refresh_|api_|auth_|client_)?(?:token|secret|password|passwd|apikey|api_key|key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"',;]+)/gi,
    `$1${REDACTED}`,
  ],
]

export function redactString(s: string): string {
  let out = s
  for (const [re, rep] of VALUE_PATTERNS) out = out.replace(re, rep)
  return out
}

const MAX_DEPTH = 8

/** Deep copy of `v` with secrets replaced by REDACTED. */
export function redactValue(v: unknown, depth = 0): unknown {
  try {
    if (typeof v === 'string') return redactString(v)
    if (v === null || typeof v !== 'object') return v
    if (depth >= MAX_DEPTH) return '[nested too deep]'
    if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isSecretKey(k) && val !== null && val !== undefined ? REDACTED : redactValue(val, depth + 1)
    }
    return out
  } catch {
    return REDACTED
  }
}

export interface DisplayText {
  /** Redacted text, cut at `max` chars. */
  text: string
  /** Chars cut off the end (0 = nothing hidden). */
  omitted: number
}

/** Bound already-redacted text and say exactly how much was dropped. */
export function clip(text: string, max: number): DisplayText {
  if (text.length <= max) return { text, omitted: 0 }
  return { text: text.slice(0, max), omitted: text.length - max }
}

/**
 * Exact-as-possible rendering of tool arguments: redacted JSON, cut at `max`
 * chars with the number of dropped chars reported (never a silent ellipsis).
 * Empty/absent arguments render as ''.
 */
export function displayArgs(args: unknown, max: number): DisplayText {
  try {
    if (args === undefined || args === null) return { text: '', omitted: 0 }
    if (typeof args === 'object' && Object.keys(args as object).length === 0) return { text: '', omitted: 0 }
    const json = JSON.stringify(redactValue(args)) ?? ''
    return clip(json, max)
  } catch {
    return { text: '', omitted: 0 }
  }
}
