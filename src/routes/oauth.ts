// OAuth 2.1 authorization server for ChatGPT's MCP connector flow:
// discovery metadata, dynamic client registration, human approval,
// auth-code + PKCE exchange, and refresh rotation. Co-hosted with the
// resource server; token/client state persists under ~/.config/pai so
// restarts don't revoke ChatGPT. Human approval is gated by
// OAUTH_SETUP_KEY (pasted once, then a cookie).
import { Router } from 'express'
import type { Request, Response } from 'express'
import { protectedResourceHandler } from 'mcp-handler'
import { BASE } from '../config'
import { mountFetch } from '../lib/express-fetch'
import {
  SUPPORTED_SCOPES,
  TX_TTL_MS,
  buildAuthorizationServerMetadata,
  checkApproval,
  cimdRedirectUris,
  consumeCode,
  getSetupKey,
  grantApproval,
  lookupAccess,
  mcpResource,
  mintCode,
  mintTokenPair,
  normalizeResource,
  parseScope,
  pkceChallenge,
  registerClient,
  resolveClient,
  rotateRefresh,
  setupKeyMatches,
  setupKeyPath,
  validateRedirectUri,
} from '../lib/oauth'

export const mountOrder = -25
export const oauthRouter = Router()

const ISSUER = BASE.replace(/\/$/, '')
const RESOURCE = mcpResource(BASE)
const COOKIE = 'bb_approval'

// In-memory approval transactions only (a restart just makes the user retry).
interface Tx {
  clientId: string
  clientName?: string
  redirectUri: string
  scope: string[]
  state: string
  challenge: string
  resource: string
  expiresAt: number
}
const pending = new Map<string, Tx>()
const txId = (): string =>
  `bbtx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

function pruneTx(): void {
  const now = Date.now()
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function approvalCookie(req: Request): string | undefined {
  return parseCookies(req)[COOKIE]
}

function setApprovalCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${90 * 24 * 3600}`,
  )
}

// ── Discovery ────────────────────────────────────────────────────────────────

const protectedHandler = protectedResourceHandler({ authServerUrls: [ISSUER], resourceUrl: RESOURCE })
mountFetch(oauthRouter, '/.well-known/oauth-protected-resource', protectedHandler)
mountFetch(oauthRouter, '/.well-known/oauth-protected-resource/mcp', protectedHandler)

const authorizationHandler = (_req: Request, res: Response) => {
  res.json(buildAuthorizationServerMetadata(ISSUER))
}
// RFC 8414 §3.2 path insertion: MCP clients probing resource
// https://host/mcp may request the issuer metadata at the suffixed path.
// Serve both, mirroring the protected-resource mounts above.
oauthRouter.get('/.well-known/oauth-authorization-server', authorizationHandler)
oauthRouter.get('/.well-known/oauth-authorization-server/mcp', authorizationHandler)

// ── Dynamic client registration (RFC 7591, public clients) ──────────────────

oauthRouter.post('/oauth/register', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string')) {
    return void res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty string array' })
  }
  for (const u of uris as string[]) {
    try {
      const p = new URL(u)
      const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(p.hostname.toLowerCase().replace(/^\[|\]$/g, ''))
      if (p.protocol !== 'https:' && !loopback) {
        return void res.status(400).json({ error: 'invalid_redirect_uri', error_description: `redirect must be https or loopback: ${u}` })
      }
    } catch {
      return void res.status(400).json({ error: 'invalid_redirect_uri', error_description: `unparseable redirect: ${u}` })
    }
  }
  const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : undefined
  const { clientId } = registerClient(name, uris as string[])
  res.status(201).json({
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  })
})

// ── Approval UI ──────────────────────────────────────────────────────────────

function approvePage(tx: string, clientLabel: string, redirectHost: string, scope: string[], needsKey: boolean, error?: string): string {
  return `<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve beads-bridge</title></head><body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">` +
    `<h1>Approve beads-bridge access?</h1>` +
    (error ? `<p style="color:#a00"><b>${esc(error)}</b> — try again, this page still works.</p>` : '') +
    `<p><b>${esc(clientLabel)}</b> wants full bead access (scope: ${esc(scope.join(' ') || 'mcp')}). Tokens it receives can read, comment, and decide on beads.</p>` +
    `<p>After approval you are sent back to <b>${esc(redirectHost)}</b>. ChatGPT keeps a token until you revoke it (delete <code>~/.config/pai/beads-bridge-oauth.json</code> on the bridge host).</p>` +
    `<form method="post" action="/oauth/authorize">` +
    `<input type="hidden" name="tx" value="${esc(tx)}">` +
    (needsKey
      ? `<p><label>Setup key (from the bridge host file, asked once):<br><input type="password" name="setup_key" size="40" autocomplete="off"></label></p>`
      : `<p>This browser is already approved — one click:</p>`) +
    `<p><button type="submit" name="decision" value="approve">Approve</button> ` +
    `<button type="submit" name="decision" value="deny">Deny</button></p>` +
    `</form></body></html>`
}

function redirectError(res: Response, redirectUri: string, error: string, state: string, description: string): void {
  const u = new URL(redirectUri)
  u.searchParams.set('error', error)
  u.searchParams.set('error_description', description)
  if (state) u.searchParams.set('state', state)
  res.redirect(302, u.toString())
}

oauthRouter.get('/oauth/authorize', async (req: Request, res: Response) => {
  pruneTx()
  const q = req.query as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const clientId = str(q.client_id)
  const redirectUri = str(q.redirect_uri)
  const state = str(q.state)
  if (str(q.response_type) !== 'code' || !clientId) {
    return void res.type('text/plain').status(400).send('invalid_request: want ?response_type=code&client_id=...')
  }
  const resolved = await resolveClient(clientId)
  if (!resolved.ok || !validateRedirectUri(resolved.redirectUris ?? [], redirectUri)) {
    return void res.type('text/plain').status(400).send(`invalid client or redirect (${resolved.error ?? 'redirect mismatch'})`)
  }
  const challenge = str(q.code_challenge)
  if (str(q.code_challenge_method) !== 'S256' || !challenge) {
    return void redirectError(res, redirectUri, 'invalid_request', state, 'PKCE S256 code_challenge required')
  }
  const resource = normalizeResource(BASE, str(q.resource))
  if (!resource) {
    return void redirectError(res, redirectUri, 'invalid_target', state, `resource must be ${RESOURCE}`)
  }
  const scope = parseScope(str(q.scope) || undefined)
  if (!scope) {
    return void redirectError(res, redirectUri, 'invalid_scope', state, `supported scopes: ${SUPPORTED_SCOPES.join(', ')}`)
  }
  const id = txId()
  pending.set(id, {
    clientId,
    clientName: resolved.name,
    redirectUri,
    scope,
    state,
    challenge,
    resource,
    expiresAt: Date.now() + TX_TTL_MS,
  })
  let redirectHost = redirectUri
  try { redirectHost = new URL(redirectUri).host } catch { /* keep raw */ }
  const needsKey = !checkApproval(approvalCookie(req))
  res.type('text/html').send(approvePage(id, resolved.name ?? clientId, redirectHost, scope, needsKey))
})

oauthRouter.post('/oauth/authorize', (req: Request, res: Response) => {
  pruneTx()
  const body = (req.body ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  // Failed attempts must NOT burn the transaction: a wrong setup key
  // re-renders the form so the user can just retry.
  const tx = pending.get(str(body.tx))
  if (!tx) return void res.type('text/plain').status(400).send('approval expired — restart from ChatGPT')
  if (str(body.decision) !== 'approve') {
    pending.delete(str(body.tx))
    return void redirectError(res, tx.redirectUri, 'access_denied', tx.state, 'user denied the request')
  }
  if (!checkApproval(approvalCookie(req)) && !setupKeyMatches(str(body.setup_key))) {
    let redirectHost = tx.redirectUri
    try { redirectHost = new URL(tx.redirectUri).host } catch { /* keep raw */ }
    return void res.type('text/html').status(403).send(
      approvePage(str(body.tx), tx.clientName ?? tx.clientId, redirectHost, tx.scope, true, 'wrong setup key'),
    )
  }
  if (!checkApproval(approvalCookie(req))) setApprovalCookie(res, grantApproval())
  pending.delete(str(body.tx))
  const { code } = mintCode({
    clientId: tx.clientId,
    redirectUri: tx.redirectUri,
    challenge: tx.challenge,
    resource: tx.resource,
    scope: tx.scope,
    expiresAt: 0, // mintCode stamps its own expiry
  })
  const u = new URL(tx.redirectUri)
  u.searchParams.set('code', code)
  if (tx.state) u.searchParams.set('state', tx.state)
  u.searchParams.set('iss', ISSUER)
  res.redirect(302, u.toString())
})

// ── Token endpoint ───────────────────────────────────────────────────────────

function tokenError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description })
}

oauthRouter.post('/oauth/token', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const grant = str(body.grant_type)

  if (grant === 'authorization_code') {
    const rec = consumeCode(str(body.code))
    if (!rec) return void tokenError(res, 400, 'invalid_grant', 'code unknown, used, or expired')
    if (str(body.client_id) && str(body.client_id) !== rec.clientId) {
      return void tokenError(res, 400, 'invalid_grant', 'client mismatch')
    }
    if (str(body.redirect_uri) !== rec.redirectUri) {
      return void tokenError(res, 400, 'invalid_grant', 'redirect mismatch')
    }
    const resource = normalizeResource(BASE, str(body.resource))
    if (!resource || resource !== rec.resource) {
      return void tokenError(res, 400, 'invalid_target', `resource must be ${rec.resource}`)
    }
    let verifierOk = false
    try {
      verifierOk = pkceChallenge(str(body.code_verifier)) === rec.challenge && !!str(body.code_verifier)
    } catch {
      verifierOk = false
    }
    if (!verifierOk) return void tokenError(res, 400, 'invalid_grant', 'PKCE verification failed')
    const pair = mintTokenPair(rec.clientId, rec.scope, rec.resource)
    return void res.json({
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: pair.expiresIn,
      refresh_token: pair.refreshToken,
      scope: rec.scope.join(' '),
    })
  }

  if (grant === 'refresh_token') {
    const pair = rotateRefresh(str(body.refresh_token))
    if (!pair) return void tokenError(res, 400, 'invalid_grant', 'refresh token unknown or expired')
    const rec = lookupAccess(pair.accessToken)
    return void res.json({
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: pair.expiresIn,
      refresh_token: pair.refreshToken,
      scope: (rec?.scope ?? ['mcp']).join(' '),
    })
  }

  return void tokenError(res, 400, 'unsupported_grant_type', 'want authorization_code or refresh_token')
})

// Boot hint (logged once from server start): where the setup key lives.
export function oauthSetupHint(): string {
  try {
    getSetupKey()
  } catch { /* page will explain */ }
  return setupKeyPath()
}
