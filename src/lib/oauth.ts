// OAuth 2.1 authorization-server core for the MCP bridge: pure helpers
// (PKCE, redirect validation, CIMD checks, metadata docs) plus a tiny
// file-persisted store for clients, codes, tokens, and approvals.
//
// The human approval behind every grant is a tailnet-only QR approval (grant
// records below, served by src/lib/tailnet-approval.ts) — there is no typed key.
// All OAuth state — clients, in-flight grants, codes, tokens — lives in
// OAUTH_STORE_PATH (default ~/.config/beads-bridge/beads-bridge-oauth.json,
// 0600), so a restart neither revokes ChatGPT nor breaks a grant mid-flow.
import { createHash, randomBytes, randomInt } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { configFile } from './config-dir'

export const SUPPORTED_SCOPES = ['mcp']
export const CODE_TTL_MS = 10 * 60 * 1000
// An in-flight grant (authorize → code) lives at most this long.
export const GRANT_TTL_MS = 15 * 60 * 1000
// A grant's tailnet challenge (QR + short code): short-lived, replaced on retry.
export const PENDING_APPROVAL_TTL_MS = 10 * 60 * 1000
export const MAX_GRANTS = 100
// Granted credentials live until revoked (deleting the store file revokes).
// expiresAt === NEVER_EXPIRES (0) means "never expires". 0 is the sentinel
// because it JSON round-trips exactly (JSON.stringify(Infinity) becomes
// null, which would compare as garbage against Date.now()) and can never
// be confused with a real issuance timestamp. tokenLive() below is the ONE
// place that interprets it — every reader must go through it so the
// meaning cannot drift.
export const NEVER_EXPIRES = 0
// Wire compat: some OAuth clients require expires_in on the token response.
// It no longer describes a server-enforced death (there is none) — a client
// that sees a value may proactively refresh, which is harmless because
// rotation still works. Ten years: far enough to mean "don't bother",
// finite so it JSON-encodes exactly. Omitting the field would be the
// purer "does not expire" signal, but strict clients error on a missing
// field, and a client-side refresh loop against a live rotation endpoint
// cannot lock anyone out — while a client that chokes on the response can.
export const NO_EXPIRY_EXPIRES_IN_S = 10 * 365 * 24 * 3600
/** Single enforcement point for credential liveness: never-expires, else future. */
export function tokenLive(expiresAt: number): boolean {
  return expiresAt === NEVER_EXPIRES || expiresAt > Date.now()
}
const CIMD_CACHE_TTL_MS = 5 * 60 * 1000

const rand = (n: number): string => randomBytes(n).toString('base64url')

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

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

// Canonical MCP resources this server protects, in one place. Null when the
// client asks for anything else (RFC 8707 audience binding). All entries are
// returned verbatim so each gate can enforce exact-audience equality: a token
// minted for one audience never opens another (/mcp, /jungle/mcp, and the
// scoped group doors /chatgpt/mcp, /grok/mcp, /gemini/mcp).
//
// One source of truth on purpose: `normalizeResource` and the
// `invalid_target` rejection both read this list, so a door cannot be mounted
// but forgotten here, nor listed here but not mounted.
export function audienceResources(base: string): string[] {
  const bare = base.replace(/\/$/, '')
  return [
    `${bare}/mcp`,
    `${bare}/jungle/mcp`,
    `${bare}/chatgpt/mcp`,
    `${bare}/grok/mcp`,
    `${bare}/gemini/mcp`,
  ]
}

export function normalizeResource(base: string, resource: string): string | null {
  const got = resource.replace(/\/$/, '')
  return audienceResources(base).find((r) => r === got) ?? null
}

export function mcpResource(base: string): string {
  return `${base.replace(/\/$/, '')}/mcp`
}

// Public jungle front-door resource: the bridge proxies this path to the
// loopback MCPJungle gateway (see src/routes/jungle.ts) behind the same
// OAuth gate as /mcp. A distinct audience so bridge-direct and
// jungle-routed tokens never cross-accept.
export function jungleResource(base: string): string {
  return `${base.replace(/\/$/, '')}/jungle/mcp`
}

// Scoped ChatGPT front-door resource: the bridge proxies this path to the
// loopback MCPJungle `chatgpt` tool group (see src/routes/chatgpt.ts),
// which contains only the beads-bridge server. A distinct audience so
// scoped tokens never cross-accept with /mcp or /jungle/mcp.
export function chatgptResource(base: string): string {
  return `${base.replace(/\/$/, '')}/chatgpt/mcp`
}

// Scoped Grok front-door resource: the same shape as the ChatGPT door, aimed
// at the loopback MCPJungle `grok` tool group (see src/routes/grok.ts), which
// contains only the beads-bridge server. Grok's connector flow is the same
// OAuth 2.1 machinery (RFC 9728 + RFC 8414 discovery, DCR, PKCE, Streamable
// HTTP), so it is served by the same bridge OAuth server with its own
// audience. A distinct audience so grok tokens never cross-accept.
export function grokResource(base: string): string {
  return `${base.replace(/\/$/, '')}/grok/mcp`
}

// Scoped Gemini front-door resource: same shape again, aimed at the loopback
// MCPJungle `gemini` tool group (see src/routes/gemini.ts). The consumer
// Gemini app and Gemini Enterprise both take a remote HTTPS MCP server URL
// with OAuth; Gemini CLI (`~/.gemini/settings.json` `httpUrl` + static
// headers) has no OAuth flow, so it would need a static header instead — see
// docs/jungle-gateway.md. A distinct audience so gemini tokens never
// cross-accept.
export function geminiResource(base: string): string {
  return `${base.replace(/\/$/, '')}/gemini/mcp`
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
  // Granted credential: NEVER_EXPIRES (0) = live until revoked. Read only
  // via tokenLive() — never compare directly against Date.now().
  expiresAt: number
}

export interface RefreshRec extends TokenRec {
  accessToken: string
}

// One authorization grant, from /oauth/authorize to the code it mints, is ONE
// persisted record (`StoreData.grants`, keyed by its unguessable id — the `tx`
// field of the public approval form). Nothing about an in-flight grant lives in
// process memory, so a restart between any two steps changes nothing.
//
//   open ──challenge──▶ challenged ──tailnet decides──▶ approved | denied
//     │                    ▲   │ (re-challenge replaces the challenge; the
//     │                    └───┘  previous one is dead at once)
//     └── redeem (browser already approved) ──▶ consumed (record deleted)
//   approved ── redeem with its own challenge id ──▶ consumed (record deleted)
//   denied / any state ── deny ──▶ record deleted
//   every state ── expiresAt ──▶ pruned (reads as unknown)
export type GrantState = 'open' | 'challenged' | 'approved' | 'denied'

// The tailnet proof (QR + short code) a grant is waiting on. At most one per
// grant; its id is the capability in the QR link and the status poll.
export interface GrantChallenge {
  id: string
  shortCode: string
  expiresAt: number
}

export interface Grant {
  state: GrantState
  // The authorization request, validated by GET /oauth/authorize.
  clientId: string
  clientName?: string
  redirectUri: string
  scope: string[]
  clientState: string
  codeChallenge: string
  resource: string
  challenge?: GrantChallenge
  createdAt: number
  expiresAt: number
}

export type GrantRequest = Pick<Grant, 'clientId' | 'clientName' | 'redirectUri' | 'scope' | 'clientState' | 'codeChallenge' | 'resource'>

interface StoreData {
  clients: Record<string, { name?: string; redirectUris: string[]; createdAt: number }>
  codes: Record<string, CodeRec>
  access: Record<string, TokenRec>
  refresh: Record<string, RefreshRec>
  approvals: Record<string, number>
  // In-flight authorization grants, keyed by grant id (see Grant above).
  // Pruned with the rest of the store; never approved by anything but
  // `decideGrantChallenge` (called from the tailnet listener).
  grants: Record<string, Grant>
  // Tombstones for access tokens pruned because they expired: sha256(token) →
  // when the record died. Lets the gate say "expired" rather than "unknown".
  // Hashed so the store never gains a second copy of a credential; a tombstone
  // grants nothing (lookupAccess never reads it).
  expired: Record<string, number>
}

export function storePath(): string {
  return process.env.OAUTH_STORE_PATH ?? configFile('beads-bridge-oauth.json')
}

function blank(): StoreData {
  return { clients: {}, codes: {}, access: {}, refresh: {}, approvals: {}, grants: {}, expired: {} }
}

export const EXPIRED_TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

function prune(d: StoreData): StoreData {
  const now = Date.now()
  // Flow-step artefacts stay short-lived: codes die on schedule.
  for (const [k, v] of Object.entries(d.codes)) if (v.expiresAt <= now) delete d.codes[k]
  // Granted credentials: dead ones prune as before; still-live legacy ones
  // (real timestamps from before the never-expire change) are promoted to
  // NEVER_EXPIRES so a token that is live today stays live until revoked.
  for (const [k, v] of Object.entries(d.access)) {
    if (!tokenLive(v.expiresAt)) {
      d.expired[tokenHash(k)] = v.expiresAt
      delete d.access[k]
    } else if (v.expiresAt !== NEVER_EXPIRES) v.expiresAt = NEVER_EXPIRES
  }
  for (const [k, v] of Object.entries(d.refresh)) {
    if (!tokenLive(v.expiresAt)) delete d.refresh[k]
    else if (v.expiresAt !== NEVER_EXPIRES) v.expiresAt = NEVER_EXPIRES
  }
  for (const [k, v] of Object.entries(d.expired)) if (v + EXPIRED_TOMBSTONE_TTL_MS <= now) delete d.expired[k]
  for (const [k, v] of Object.entries(d.grants)) if (v.expiresAt <= now) delete d.grants[k]
  // Pre-grant stores kept tailnet approvals in their own map; their memory
  // transactions died with the old process, so the records are orphans.
  delete (d as unknown as Record<string, unknown>).pendingApprovals
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
  const tmp = `${p}.${process.pid}.${rand(6)}.tmp`
  writeFileSync(tmp, JSON.stringify(prune(d)), { mode: 0o600 })
  renameSync(tmp, p)
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
  d.access[accessToken] = { clientId, scope, resource, expiresAt: NEVER_EXPIRES }
  d.refresh[refreshToken] = { clientId, scope, resource, expiresAt: NEVER_EXPIRES, accessToken }
  saveStore(d)
  return { accessToken, refreshToken, expiresIn: NO_EXPIRY_EXPIRES_IN_S }
}

export function lookupAccess(token: string): (TokenRec & { token: string }) | null {
  const d = loadStore()
  const rec = d.access[token]
  if (!rec || !tokenLive(rec.expiresAt)) return null
  return { ...rec, token }
}

// Why lookupAccess would refuse a token, for the client-facing error text only
// (never an authorization decision). 'expired' needs the tombstone prune() leaves.
export type AccessTokenState = 'live' | 'expired' | 'unknown'
export function accessTokenState(token: string): AccessTokenState {
  const d = loadStore()
  if (d.access[token]) return 'live'
  return tokenHash(token) in d.expired ? 'expired' : 'unknown'
}

// Rotate: consumes the refresh token, revokes its access token, mints a pair.
export function rotateRefresh(token: string): { accessToken: string; refreshToken: string; expiresIn: number } | null {
  const d = loadStore()
  const rec = d.refresh[token]
  if (!rec || !tokenLive(rec.expiresAt)) return null
  delete d.refresh[token]
  delete d.access[rec.accessToken]
  const accessToken = `bb_at_${rand(24)}`
  const refreshToken = `bb_rt_${rand(24)}`
  d.access[accessToken] = { clientId: rec.clientId, scope: rec.scope, resource: rec.resource, expiresAt: NEVER_EXPIRES }
  d.refresh[refreshToken] = { clientId: rec.clientId, scope: rec.scope, resource: rec.resource, expiresAt: NEVER_EXPIRES, accessToken }
  saveStore(d)
  return { accessToken, refreshToken, expiresIn: NO_EXPIRY_EXPIRES_IN_S }
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

// ── Grants (authorization transaction + tailnet QR challenge) ───────────────

// No 0/O/1/I/L: the code is read aloud / compared by eye across two screens.
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const SHORT_CODE_LEN = 6

function shortCode(): string {
  let out = ''
  for (let i = 0; i < SHORT_CODE_LEN; i++) out += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)]
  return out
}

// Unauthenticated callers can open grants, so the store keeps only the newest.
function capGrants(d: StoreData): void {
  const open = Object.entries(d.grants).sort(([, a], [, b]) => a.createdAt - b.createdAt)
  for (const [k] of open.slice(0, Math.max(0, open.length - MAX_GRANTS))) delete d.grants[k]
}

const liveChallenge = (g: Grant): GrantChallenge | null =>
  g.challenge && g.challenge.expiresAt > Date.now() ? g.challenge : null

function findByChallenge(d: StoreData, challengeId: string): Grant | null {
  if (!challengeId) return null
  for (const g of Object.values(d.grants)) if (liveChallenge(g)?.id === challengeId) return g
  return null
}

export function openGrant(req: GrantRequest): { id: string } {
  const d = loadStore()
  const id = `bbtx_${rand(18)}`
  const now = Date.now()
  d.grants[id] = { ...req, state: 'open', createdAt: now, expiresAt: now + GRANT_TTL_MS }
  capGrants(d)
  saveStore(d)
  return { id }
}

// Live record or null (unknown, expired and pruned all read the same).
export function getGrant(id: string): Grant | null {
  return loadStore().grants[id] ?? null
}

// → challenged with a fresh tailnet challenge. Replacing the challenge kills
// the previous one: a grant never has two live QR codes. A decision lapses with
// its challenge, so an approval whose challenge expired is re-challenged too;
// null for an unknown grant, a denied one, or a live approval (a stray POST
// must not wipe it out from under the rightful browser).
export function challengeGrant(id: string): GrantChallenge | null {
  const d = loadStore()
  const g = d.grants[id]
  if (!g || g.state === 'denied' || (g.state === 'approved' && liveChallenge(g))) return null
  g.state = 'challenged'
  g.challenge = { id: `bbpa_${rand(18)}`, shortCode: shortCode(), expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS }
  saveStore(d)
  return g.challenge
}

export type ChallengeState = 'pending' | 'approved' | 'denied' | 'expired'

const challengeStateOf = (g: Grant | null): ChallengeState =>
  !g ? 'expired' : g.state === 'approved' || g.state === 'denied' ? g.state : 'pending'

// What the public status poll may reveal: the state, nothing else.
export function grantChallengeState(challengeId: string): ChallengeState {
  return challengeStateOf(findByChallenge(loadStore(), challengeId))
}

// Display fields for the tailnet approval page; never the redirect URI itself.
export interface ChallengeView {
  status: 'pending' | 'approved' | 'denied'
  shortCode: string
  clientName: string
  redirectHost: string
  scope: string[]
}

export function getGrantChallenge(challengeId: string): ChallengeView | null {
  const g = findByChallenge(loadStore(), challengeId)
  if (!g) return null
  let redirectHost = g.redirectUri
  try { redirectHost = new URL(g.redirectUri).host } catch { /* show it raw */ }
  return {
    status: challengeStateOf(g) as ChallengeView['status'],
    shortCode: g.challenge!.shortCode,
    clientName: g.clientName ?? g.clientId,
    redirectHost,
    scope: g.scope,
  }
}

// challenged → approved|denied, once, through its live challenge. Anything
// else (unknown, expired, replaced, already decided) changes nothing.
export function decideGrantChallenge(challengeId: string, decision: 'approved' | 'denied'): 'ok' | 'not_found' | 'already_decided' {
  const d = loadStore()
  const g = findByChallenge(d, challengeId)
  if (!g) return 'not_found'
  if (g.state !== 'challenged') return 'already_decided'
  g.state = decision
  saveStore(d)
  return 'ok'
}

export type RedeemOutcome =
  | { outcome: 'approved'; grant: Grant; via: 'browser' | 'tailnet' }
  | { outcome: 'denied'; grant: Grant }
  | { outcome: 'pending' }
  | { outcome: 'unapproved' }
  | { outcome: 'unknown' }

// The browser asks to finish the grant. One compare-and-set on the record:
//   denied                                   → deleted, 'denied'
//   approved via the challenge it presents   → deleted, 'approved' (tailnet)
//   any state, browser already approved      → deleted, 'approved' (browser)
//   challenged, presenting its live challenge → kept,   'pending'
//   otherwise (expired/replaced challenge)    → kept,   'unapproved'
export function redeemGrant(id: string, proof: { challengeId: string; browserApproved: boolean }): RedeemOutcome {
  const d = loadStore()
  const g = d.grants[id]
  if (!g) return { outcome: 'unknown' }
  const presented = liveChallenge(g)?.id === proof.challengeId && !!proof.challengeId
  let result: RedeemOutcome
  if (g.state === 'denied') result = { outcome: 'denied', grant: g }
  else if (g.state === 'approved' && presented) result = { outcome: 'approved', grant: g, via: 'tailnet' }
  else if (proof.browserApproved) result = { outcome: 'approved', grant: g, via: 'browser' }
  else return { outcome: g.state === 'challenged' && presented ? 'pending' : 'unapproved' }
  delete d.grants[id]
  saveStore(d)
  return result
}

// The human declined in the browser: the grant ends now, whatever its state.
export function denyGrant(id: string): Grant | null {
  const d = loadStore()
  const g = d.grants[id]
  if (!g) return null
  delete d.grants[id]
  saveStore(d)
  return g
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
