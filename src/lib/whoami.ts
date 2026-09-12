// whoami: the bridge's answer to "who am I here". Server identity plus
// the caller's auth context (client id, scopes, token expiry), the stored
// operator profile (editable via identity_update), and the environment
// summary — everything an agent needs to orient, nothing secret (token
// VALUES are never echoed).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export interface WhoamiAuth {
  clientId: string
  scopes: string[]
  expiresAt?: number
  audience?: string
}

export interface WhoamiInfo {
  server: string
  version: string
  base: string
  auth?: WhoamiAuth
  operator?: OperatorProfile
  stores: string[]
}

export interface OperatorProfile {
  name?: string
  role?: string
  timezone?: string
  notes?: string
}

const PROFILE_FIELDS = ['name', 'role', 'timezone', 'notes'] as const

export function identityPath(): string {
  return process.env.IDENTITY_PATH ??
    join(process.env.HOME ?? tmpdir(), '.config', 'pai', 'beads-bridge-identity.json')
}

export function loadProfile(): OperatorProfile {
  try {
    if (!existsSync(identityPath())) return {}
    const d = JSON.parse(readFileSync(identityPath(), 'utf8')) as Record<string, unknown>
    const out: OperatorProfile = {}
    for (const f of PROFILE_FIELDS) if (typeof d[f] === 'string' && d[f]) out[f] = (d[f] as string).slice(0, 500)
    return out
  } catch {
    return {}
  }
}

// Merge provided fields (empty string clears); unknown fields rejected.
export function updateProfile(patch: Record<string, unknown>): { profile: OperatorProfile; bad: string[] } {
  const current = loadProfile()
  const bad = Object.keys(patch).filter((k) => !(PROFILE_FIELDS as readonly string[]).includes(k))
  const next: OperatorProfile = { ...current }
  for (const f of PROFILE_FIELDS) {
    if (!(f in patch)) continue
    const v = patch[f]
    if (typeof v !== 'string') continue
    const t = v.trim().slice(0, 500)
    if (t) next[f] = t
    else delete next[f]
  }
  const p = identityPath()
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 })
  return { profile: next, bad }
}

export function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'dev'
  } catch {
    return 'dev'
  }
}

export function formatWhoami(info: WhoamiInfo): string {
  const lines = [
    `# whoami — ${info.server}`,
    ``,
    `server: ${info.server} v${info.version} (streamable http, ${info.base}/mcp)`,
  ]
  if (info.auth) {
    lines.push(
      `you are: OAuth client ${info.auth.clientId} (scopes: ${info.auth.scopes.join(' ') || '(none)'})`,
      `token: ${info.auth.expiresAt ? `expires ${new Date(info.auth.expiresAt).toISOString()}` : 'no expiry on file'}` +
        (info.auth.audience ? `, audience ${info.auth.audience}` : ''),
    )
  } else {
    lines.push(`you are: unauthenticated (auth is required, so you should not see this)`)
  }
  const op = info.operator ?? {}
  const opBits = [`name: ${op.name ?? '(unset)'}`, `role: ${op.role ?? '(unset)'}` +
    (op.timezone ? `, timezone: ${op.timezone}` : '')]
  lines.push(`operator: ${opBits.join(' | ')}` + (op.notes ? `\noperator notes: ${op.notes}` : ''))
  lines.push(
    ``,
    `stores: ${info.stores.length} queryable (${info.stores.join(', ')})`,
    `you can: read (show, bundle, query, connections), write (comment, note, label, decision, create, feedback), relay (resolve/list projects, capture, upsert task, dispatch request, verify, flow)`,
    `tool catalog: your tools/list snapshot — this server re-serves it fresh every request`,
  )
  return lines.join('\n')
}
