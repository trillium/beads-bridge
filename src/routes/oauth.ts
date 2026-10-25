// OAuth 2.1 authorization server for ChatGPT's MCP connector flow:
// discovery metadata, dynamic client registration, human approval,
// auth-code + PKCE exchange, and refresh rotation. Co-hosted with the
// resource server; token/client state persists under ~/.config/beads-bridge so
// restarts don't revoke ChatGPT. Human approval is a tailnet-only QR/link
// (src/lib/tailnet-approval.ts) that completes in the original browser, which
// then holds an approval cookie so later grants are one click.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { protectedResourceHandler } from 'mcp-handler'
import { BASE } from '../config'
import { mountFetch } from '../lib/express-fetch'
import { esc, pending, pruneTx, txId } from '../lib/oauth-tx'
import type { Tx } from '../lib/oauth-tx'
import { qrSvg } from '../lib/qr'
import { tailnetApprovalUrl } from '../lib/tailnet-approval'
import {
  SUPPORTED_SCOPES,
  TX_TTL_MS,
  audienceResources,
  buildAuthorizationServerMetadata,
  chatgptResource,
  checkApproval,
  consumePendingApproval,
  createPendingApproval,
  cimdRedirectUris,
  consumeCode,
  geminiResource,
  getSetupKey,
  grantApproval,
  grokResource,
  jungleResource,
  lookupAccess,
  mcpResource,
  mintCode,
  mintTokenPair,
  normalizeResource,
  parseScope,
  pendingApprovalState,
  pkceChallenge,
  registerClient,
  resolveClient,
  rotateRefresh,
  setupKeyPath,
  validateRedirectUri,
} from '../lib/oauth'

export const mountOrder = -25
export const oauthRouter = Router()

const ISSUER = BASE.replace(/\/$/, '')
const RESOURCE = mcpResource(BASE)
const COOKIE = 'bb_approval'

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
// Jungle front-door audience (RFC 9728 path insertion for resource
// https://host/jungle/mcp): same issuer/keys, distinct resource identifier
// so bridge-direct and jungle-routed tokens never cross-accept.
const jungleProtectedHandler = protectedResourceHandler({ authServerUrls: [ISSUER], resourceUrl: jungleResource(BASE) })
mountFetch(oauthRouter, '/.well-known/oauth-protected-resource/jungle/mcp', jungleProtectedHandler)
// Scoped ChatGPT front-door audience (resource https://host/chatgpt/mcp):
// same issuer/keys, distinct resource identifier so scoped tokens never
// cross-accept with bridge-direct or full-jungle tokens.
const chatgptProtectedHandler = protectedResourceHandler({ authServerUrls: [ISSUER], resourceUrl: chatgptResource(BASE) })
mountFetch(oauthRouter, '/.well-known/oauth-protected-resource/chatgpt/mcp', chatgptProtectedHandler)
// Scoped Grok front-door audience (resource https://host/grok/mcp).
const grokProtectedHandler = protectedResourceHandler({ authServerUrls: [ISSUER], resourceUrl: grokResource(BASE) })
mountFetch(oauthRouter, '/.well-known/oauth-protected-resource/grok/mcp', grokProtectedHandler)
// Scoped Gemini front-door audience (resource https://host/gemini/mcp).
const geminiProtectedHandler = protectedResourceHandler({ authServerUrls: [ISSUER], resourceUrl: geminiResource(BASE) })
mountFetch(oauthRouter, '/.well-known/oauth-protected-resource/gemini/mcp', geminiProtectedHandler)

const authorizationHandler = (_req: Request, res: Response) => {
  res.json(buildAuthorizationServerMetadata(ISSUER))
}
// RFC 8414 §3.2 path insertion: MCP clients probing resource
// https://host/mcp may request the issuer metadata at the suffixed path.
// Serve both, mirroring the protected-resource mounts above.
oauthRouter.get('/.well-known/oauth-authorization-server', authorizationHandler)
oauthRouter.get('/.well-known/oauth-authorization-server/mcp', authorizationHandler)
// Jungle front-door audience (resource https://host/jungle/mcp): clients
// probing that resource request issuer metadata at the suffixed path.
oauthRouter.get('/.well-known/oauth-authorization-server/jungle/mcp', authorizationHandler)
// Scoped ChatGPT front-door audience (resource https://host/chatgpt/mcp).
oauthRouter.get('/.well-known/oauth-authorization-server/chatgpt/mcp', authorizationHandler)
// Scoped Grok front-door audience (resource https://host/grok/mcp).
oauthRouter.get('/.well-known/oauth-authorization-server/grok/mcp', authorizationHandler)
// Scoped Gemini front-door audience (resource https://host/gemini/mcp).
oauthRouter.get('/.well-known/oauth-authorization-server/gemini/mcp', authorizationHandler)

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

// Bead mark (same artwork as web/public/favicon.svg, inlined so the consent
// page is branded even when the static dist bundle is absent). Branding only.
const BEAD_MARK = `<svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true" style="vertical-align:-6px;margin-right:.4rem"><defs><linearGradient id="bb-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8f46ff"/><stop offset="1" stop-color="#7e14ff"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#bb-g)"/><rect x="5" y="28.5" width="54" height="7" rx="3.5" fill="#ede6ff" opacity="0.5"/><circle cx="32" cy="32" r="17" fill="#ede6ff"/><circle cx="32" cy="32" r="10.5" fill="#7e14ff"/><rect x="21.5" y="29.75" width="21" height="4.5" rx="2.25" fill="#ede6ff"/></svg>`

interface Challenge {
  /** Pending-approval id, or null when this browser is already approved. */
  approvalId: string | null
  shortCode: string
  /** Tailnet approval URL (QR + link), or null when TAILNET_IP is unusable. */
  url: string | null
}

// How the human proves they are on the tailnet: a pending record, a link and a
// QR code for it. Skipped for a browser that already holds an approval cookie.
function openChallenge(txKey: string, tx: Tx): Challenge {
  const p = createPendingApproval({
    tx: txKey,
    clientName: tx.clientName ?? tx.clientId,
    redirectHost: hostOf(tx.redirectUri),
    scope: tx.scope,
  })
  return { approvalId: p.id, shortCode: p.shortCode, url: tailnetApprovalUrl(p.id) }
}

function hostOf(redirectUri: string): string {
  try { return new URL(redirectUri).host } catch { return redirectUri }
}

// Polls the unguessable status endpoint every 2 s; "approved"/"denied" submit
// the same form the Approve/Deny buttons use, so the code/PKCE flow below is
// unchanged. The status response carries nothing but the state word.
const POLL_SCRIPT = `<script>(function(){var f=document.getElementById('bb-form'),m=document.getElementById('bb-wait');if(!f)return;var id=f.elements.approval.value;function go(d){var i=document.createElement('input');i.type='hidden';i.name='decision';i.value=d;f.appendChild(i);f.submit()}function tick(){fetch('/oauth/pending/'+encodeURIComponent(id)+'/status',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(j.status==='approved')return go('approve');if(j.status==='denied')return go('deny');if(j.status==='expired'){m.textContent='This request expired — reload this page to get a new code.';return}setTimeout(tick,2000)}).catch(function(){setTimeout(tick,2000)})}setTimeout(tick,2000)})()</script>`

function approvePage(tx: string, clientLabel: string, redirectHost: string, scope: string[], challenge: Challenge, error?: string): string {
  const head =
    `<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><meta name="theme-color" content="#7e14ff"><title>Approve beads-bridge</title></head><body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">` +
    `<h1>${BEAD_MARK}Approve beads-bridge access?</h1>` +
    (error ? `<p style="color:#a00"><b>${esc(error)}</b></p>` : '') +
    `<p><b>${esc(clientLabel)}</b> wants full bead access (scope: ${esc(scope.join(' ') || 'mcp')}). Tokens it receives can read, comment, and decide on beads.</p>` +
    `<p>After approval you are sent back to <b>${esc(redirectHost)}</b>. ChatGPT keeps a token until you revoke it (delete <code>~/.config/beads-bridge/beads-bridge-oauth.json</code> on the bridge host).</p>`
  if (!challenge.approvalId) {
    return head +
      `<form method="post" action="/oauth/authorize">` +
      `<input type="hidden" name="tx" value="${esc(tx)}">` +
      `<p>This browser is already approved — one click:</p>` +
      `<p><button type="submit" name="decision" value="approve">Approve</button> ` +
      `<button type="submit" name="decision" value="deny">Deny</button></p>` +
      `</form></body></html>`
  }
  const approve = challenge.url
    ? `<p>Approve from a device on the tailnet — tap the link, or scan the code with your phone:</p>` +
      `<p><a href="${esc(challenge.url)}" style="word-break:break-all">${esc(challenge.url)}</a></p>` +
      `<p>${qrSvg(challenge.url, { label: 'QR code for the tailnet approval link' })}</p>` +
      `<p>Code: <b style="font-size:2rem;letter-spacing:.2em;font-family:ui-monospace,monospace">${esc(challenge.shortCode)}</b><br>` +
      `<small>The approval page shows the same code — approve only if it matches.</small></p>` +
      `<p id="bb-wait" aria-live="polite">Waiting for approval…</p>`
    : `<p><b>Tailnet approval is not configured on this bridge</b> (<code>TAILNET_IP</code> must be a tailnet address). No grant can be approved until it is.</p>`
  return head +
    `<form id="bb-form" method="post" action="/oauth/authorize">` +
    `<input type="hidden" name="tx" value="${esc(tx)}">` +
    `<input type="hidden" name="approval" value="${esc(challenge.approvalId)}">` +
    approve +
    `<p><button type="submit" name="decision" value="deny">Deny</button></p>` +
    `</form>` + (challenge.url ? POLL_SCRIPT : '') + `</body></html>`
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
    return void redirectError(res, redirectUri, 'invalid_target', state, `resource must be one of ${audienceResources(BASE).join(', ')}`)
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
  const tx = pending.get(id)!
  const approval: Challenge = checkApproval(approvalCookie(req))
    ? { approvalId: null, shortCode: '', url: null }
    : openChallenge(id, tx)
  res.type('text/html').send(approvePage(id, resolved.name ?? clientId, hostOf(redirectUri), scope, approval))
})

// Public status poll for the page above. The id is an unguessable capability;
// the answer is one of pending|approved|denied|expired and nothing else.
oauthRouter.get('/oauth/pending/:id/status', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ status: pendingApprovalState(String(req.params.id)) })
})

oauthRouter.post('/oauth/authorize', (req: Request, res: Response) => {
  pruneTx()
  const body = (req.body ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  // A grant that is not (yet) approved must NOT burn the transaction: the
  // page is re-rendered so the human can retry.
  const txKey = str(body.tx)
  const tx = pending.get(txKey)
  if (!tx) return void res.type('text/plain').status(400).send('approval expired — restart from ChatGPT')
  const approvalId = str(body.approval)
  const deny = (): void => {
    pending.delete(txKey)
    redirectError(res, tx.redirectUri, 'access_denied', tx.state, 'user denied the request')
  }
  if (str(body.decision) !== 'approve') {
    if (approvalId) consumePendingApproval(approvalId, txKey)
    return void deny()
  }
  const cookieOk = checkApproval(approvalCookie(req))
  if (!cookieOk) {
    // Approval must come from the tailnet device that decided this exact tx.
    const outcome = approvalId ? consumePendingApproval(approvalId, txKey) : 'expired'
    if (outcome === 'denied') return void deny()
    if (outcome === 'pending') {
      return void res.type('text/plain').status(409).send('not approved yet — approve from your tailnet device')
    }
    if (outcome !== 'approved') {
      return void res.type('text/html').status(403).send(
        approvePage(txKey, tx.clientName ?? tx.clientId, hostOf(tx.redirectUri), tx.scope, openChallenge(txKey, tx), 'Approval expired or was not granted — use the new code below.'),
      )
    }
    setApprovalCookie(res, grantApproval())
  } else if (approvalId) {
    consumePendingApproval(approvalId, txKey)
  }
  pending.delete(txKey)
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
