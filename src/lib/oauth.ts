// OAuth 2.1 authorization-server core for the MCP bridge: pure helpers
// (PKCE, redirect validation, CIMD checks, metadata docs) plus a tiny
// file-persisted store for clients, codes, tokens, and approvals.
//
// The human approval behind every grant is gated by OAUTH_SETUP_KEY
// (env wins, else a 0600 file under ~/.config/pai minted on first use).
// Token/client state lives in OAUTH_STORE_PATH (default
// ~/.config/pai/beads-bridge-oauth.json, 0600) so restarts don't revoke
// ChatGPT — only in-flight approval transactions are memory-only.
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export const SUPPORTED_SCOPES = ['mcp']
export const CODE_TTL_MS = 10 * 60 * 1000
export const ACCESS_TTL_MS = 24 * 3600 * 1000
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000
export const TX_TTL_MS = 15 * 60 * 1000
const CIMD_CACHE_TTL_MS = 5 * 60 * 1000

const rand = (n: number): string => randomBytes(n).toString('base64url')

// ── Pure helpers ─────────────────────────────────────────────────────────────

// PKCE S256 (RFC 7636): base64url(sha256(ascii(verifier))).
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

function loopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === '::1' || h === 'localhost'
}

// Exact match, except loopback URIs ignore the port (RFC 8252 §7.3 —
// ChatGPT/Codex callbacks use ephemeral loopback ports).
export function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true
  try {
    const r = new URL(registered)
    const p = new URL(presented)
    if (!loopbackHost(r.hostname) || !loopbackHost(p.hostname)) return false
    return r.protocol === p.protocol &&
      r.pathname === p.pathname &&
      r.search === p.search &&
      r.hash === p.hash
  } catch {
    return false
  }
}

// Presented redirect must be https or loopback AND match a registered one.
export function validateRedirectUri(registered: string[], presented: string): boolean {
  try {
    const p = new URL(presented)
    if (p.protocol !== 'https:' && !loopbackHost(p.hostname)) return false
  } catch {
    return false
  }
  return registered.some((r) => redirectMatches(r, presented))
}

// Validate a fetched Client ID Metadata Document against the client_id URL.
export function validateCimdDoc(clientId: string, doc: unknown): { ok: boolean; redirectUris?: string[]; error?: string } {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'metadata is not a JSON object' }
  const d = doc as Record<string, unknown>
  if (d.client_id !== clientId) return { ok: false, error: 'client_id mismatch' }
  if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.length || !d.redirect_uris.every((u) => typeof u === 'string')) {
    return { ok: false, error: 'redirect_uris missing or invalid' }
  }
  return { ok: true, redirectUris: d.redirect_uris as string[] }
}

// Canonical MCP resource this server protects. Null when the client asks
// for anything else (RFC 8707 audience binding).
export function normalizeResource(base: string, resource: string): string | null {
  const want = `${base.replace(/\/$/, '')}/mcp`
  const got = resource.replace(/\/$/, '')
  return got === want ? want : null
}

export function mcpResource(base: string): string {
  return `${base.replace(/\/$/, '')}/mcp`
}

export function parseScope(scope: string | undefined): string[] | null {
  const parts = (scope ?? '').split(/\s+/).filter(Boolean)
  const list = parts.length ? [...new Set(parts)] : ['mcp']
  return list.every((s) => SUPPORTED_SCOPES.includes(s)) ? list : null
}

// RFC 8414 metadata. Issuer has no path component, so the single root
// well-known document serves every client. logo_uri is informational only
// (RFC 8414 permits additional members; parsers ignore what they don't
// need): it advertises the brand mark, but ChatGPT's connector-list icon
// is a manual dashboard upload no code change can set.
export function buildAuthorizationServerMetadata(issuer: string): Record<string, unknown> {
  const iss = issuer.replace(/\/$/, '')
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    logo_uri: `${iss}/favicon.svg`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [...SUPPORTED_SCOPES],
  }
}

// ── Setup key (human approval gate) ──────────────────────────────────────────

const SETUP_PATH = join(process.env.HOME ?? tmpdir(), '.config', 'pai', 'beads-bridge-oauth-setup')

export function setupKeyPath(): string {
  return process.env.OAUTH_SETUP_PATH ?? SETUP_PATH
}

export function getSetupKey(): string {
  if (process.env.OAUTH_SETUP_KEY) return process.env.OAUTH_SETUP_KEY
  const p = setupKeyPath()
  try {
    const k = readFileSync(p, 'utf8').trim()
    if (k) return k
  } catch { /* mint below */ }
  const k = `bo_${rand(24)}`
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(p, k, { mode: 0o600 })
  return k
}

export function setupKeyMatches(presented: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(getSetupKey())
  return a.length === b.length && timingSafeEqual(a, b)
}

// ── Persisted store ──────────────────────────────────────────────────────────

export interface CodeRec {
  clientId: string
  redirectUri: string
  challenge: string
  resource: string
  scope: string[]
  expiresAt: number
}

export interface TokenRec {
  clientId: string
  scope: string[]
  resource: string
  expiresAt: number
}

export interface RefreshRec extends TokenRec {
  accessToken: string
}

interface StoreData {
  clients: Record<string, { name?: string; redirectUris: string[]; createdAt: number }>
  codes: Record<string, CodeRec>
  access: Record<string, TokenRec>
  refresh: Record<string, RefreshRec>
  approvals: Record<string, number>
}

const STORE_PATH = join(process.env.HOME ?? tmpdir(), '.config', 'pai', 'beads-bridge-oauth.json')

export function storePath(): string {
  return process.env.OAUTH_STORE_PATH ?? STORE_PATH
}

function blank(): StoreData {
  return { clients: {}, codes: {}, access: {}, refresh: {}, approvals: {} }
}

function prune(d: StoreData): StoreData {
  const now = Date.now()
  for (const [k, v] of Object.entries(d.codes)) if (v.expiresAt <= now) delete d.codes[k]
  for (const [k, v] of Object.entries(d.access)) if (v.expiresAt <= now) delete d.access[k]
  for (const [k, v] of Object.entries(d.refresh)) if (v.expiresAt <= now) delete d.refresh[k]
  for (const [k, v] of Object.entries(d.approvals)) if (v + 90 * 24 * 3600 * 1000 <= now) delete d.approvals[k]
  return d
}

export function loadStore(): StoreData {
  try {
    const raw = readFileSync(storePath(), 'utf8')
    const d = { ...blank(), ...(JSON.parse(raw) as Partial<StoreData>) }
    return prune(d)
  } catch {
    return blank()
  }
}

export function saveStore(d: StoreData): void {
  const p = storePath()
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(p, JSON.stringify(prune(d)), { mode: 0o600 })
}

export function registerClient(name: string | undefined, redirectUris: string[]): { clientId: string } {
  const d = loadStore()
  const clientId = `bbcid_${rand(12)}`
  d.clients[clientId] = { name, redirectUris, createdAt: Date.now() }
  saveStore(d)
  return { clientId }
}

export function mintCode(rec: Omit<CodeRec, never>): { code: string } {
  const d = loadStore()
  const code = `bbc_${rand(24)}`
  d.codes[code] = { ...rec, expiresAt: Date.now() + CODE_TTL_MS }
  saveStore(d)
  return { code }
}

// Single-use: returns and deletes the code, or null.
export function consumeCode(code: string): CodeRec | null {
  const d = loadStore()
  const rec = d.codes[code]
  if (!rec) return null
  delete d.codes[code]
  saveStore(d)
  return rec.expiresAt > Date.now() ? rec : null
}

export function mintTokenPair(clientId: string, scope: string[], resource: string): { accessToken: string; refreshToken: string; expiresIn: number } {
  const d = loadStore()
  const accessToken = `bb_at_${rand(24)}`
  const refreshToken = `bb_rt_${rand(24)}`
  const now = Date.now()
  d.access[accessToken] = { clientId, scope, resource, expiresAt: now + ACCESS_TTL_MS }
  d.refresh[refreshToken] = { clientId, scope, resource, expiresAt: now + REFRESH_TTL_MS, accessToken }
  saveStore(d)
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000) }
}

export function lookupAccess(token: string): (TokenRec & { token: string }) | null {
  const d = loadStore()
  const rec = d.access[token]
  if (!rec || rec.expiresAt <= Date.now()) return null
  return { ...rec, token }
}

// Rotate: consumes the refresh token, revokes its access token, mints a pair.
export function rotateRefresh(token: string): { accessToken: string; refreshToken: string; expiresIn: number } | null {
  const d = loadStore()
  const rec = d.refresh[token]
  if (!rec || rec.expiresAt <= Date.now()) return null
  delete d.refresh[token]
  delete d.access[rec.accessToken]
  const accessToken = `bb_at_${rand(24)}`
  const refreshToken = `bb_rt_${rand(24)}`
  const now = Date.now()
  d.access[accessToken] = { clientId: rec.clientId, scope: rec.scope, resource: rec.resource, expiresAt: now + ACCESS_TTL_MS }
  d.refresh[refreshToken] = { clientId: rec.clientId, scope: rec.scope, resource: rec.resource, expiresAt: now + REFRESH_TTL_MS, accessToken }
  saveStore(d)
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000) }
}

export function grantApproval(): string {
  const d = loadStore()
  const t = `bb_appr_${rand(18)}`
  d.approvals[t] = Date.now()
  saveStore(d)
  return t
}

export function checkApproval(token: string | undefined): boolean {
  if (!token) return false
  const d = loadStore()
  const at = d.approvals[token]
  return !!at && at + 90 * 24 * 3600 * 1000 > Date.now()
}

// ── CIMD fetch (short cache; https only) ─────────────────────────────────────

const cimdCache = new Map<string, { at: number; redirectUris: string[] }>()

export function clearCimdCacheForTests(): void {
  cimdCache.clear()
}

export async function cimdRedirectUris(clientId: string): Promise<{ ok: boolean; redirectUris?: string[]; error?: string }> {
  let u: URL
  try {
    u = new URL(clientId)
  } catch {
    return { ok: false, error: 'not a URL client_id' }
  }
  if (u.protocol !== 'https:' || !u.pathname || u.pathname === '/') {
    return { ok: false, error: 'client_id must be an https URL with a path' }
  }
  const hit = cimdCache.get(clientId)
  if (hit && Date.now() - hit.at < CIMD_CACHE_TTL_MS) return { ok: true, redirectUris: hit.redirectUris }
  try {
    const res = await fetch(clientId, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
      redirect: 'follow',
    })
    if (!res.ok) return { ok: false, error: `metadata fetch failed: ${res.status}` }
    const text = await res.text()
    if (text.length > 20_000) return { ok: false, error: 'metadata too large' }
    const checked = validateCimdDoc(clientId, JSON.parse(text))
    if (!checked.ok) return checked
    cimdCache.set(clientId, { at: Date.now(), redirectUris: checked.redirectUris! })
    return checked
  } catch (e) {
    return { ok: false, error: `metadata fetch failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160) }
  }
}

// Resolve a client_id to its redirect URIs: DCR registry first, CIMD URL second.
export async function resolveClient(clientId: string): Promise<{ ok: boolean; redirectUris?: string[]; name?: string; error?: string }> {
  const d = loadStore()
  const reg = d.clients[clientId]
  if (reg) return { ok: true, redirectUris: reg.redirectUris, name: reg.name }
  if (/^https:\/\//.test(clientId)) {
    const r = await cimdRedirectUris(clientId)
    if (r.ok) return { ok: true, redirectUris: r.redirectUris, name: clientId }
    return { ok: false, error: r.error }
  }
  return { ok: false, error: 'unknown client' }
}
