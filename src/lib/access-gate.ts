// Public-ingress authentication gate (handoff `handoff-mgjj`, P1 security).
//
// Why this exists: Tailscale Funnel publishes the bridge publicly but
// proxies to the loopback socket, and Express without `trust proxy` reports
// every Funnel-forwarded request as `req.ip = 127.0.0.1`. The old gate's
// LOOPBACK branch therefore admitted the whole public internet to every
// non-MCP data/action route (live log: `ALLOW:localhost 200 GET /next`
// with a random public User-Agent).
//
// Policy (addresses and User-Agent are routing hints only, never auth):
// - `/.well-known/*`, `/oauth/*` — public by design (connector setup:
//   discovery, dynamic registration, approval, token exchange).
// - `/mcp`, `/jungle/mcp` — public by design at this layer; the bearer
//   credential is enforced downstream (`withMcpAuth(required: true)` with
//   exact-audience checks in `src/routes/mcp.ts` / `src/routes/jungle.ts`).
// - Every other route requires a valid bearer credential (a live OAuth
//   access token from `lookupAccess`, either audience, or the existing
//   `toolKey` service credential) — from anywhere, Funnel included. This
//   is the ChatGPT path for data routes: OAuth setup is public, calls
//   carry the token.
// - Direct tailnet (socket peer in 100.64/10) and direct local (loopback
//   socket peer with NO forwarding headers) pass exactly as before.
// - Anything else — Funnel-forwarded without a credential, LAN, public
//   direct — gets 403. The old ChatGPT-User-Agent exception is gone: UA
//   is not authentication.
//
// Funnel detection: Funnel stamps forwarding headers (`X-Forwarded-For`,
// `X-Forwarded-Proto`, ...) onto the loopback hop; true direct-local
// sockets carry none. These headers are consulted only to WITHHOLD the
// localhost bypass, never to grant access — spoofing them fails closed.
// Likewise the socket peer (not `req.ip`, not XFF-derived) decides the
// tailnet/local bypasses, so no spoofed header can manufacture one.
// `trust proxy loopback` in `src/server.ts` is a supporting routing
// correction (truthful `req.ip` in logs) — not the security boundary.
import type { Request, RequestHandler, Response, NextFunction } from 'express'
import { toolKey } from '../config'
import { lookupAccess } from './oauth'

export const TAILNET = /^100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\./
export const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/

// Forwarding headers a proxy (Tailscale Funnel) stamps onto the loopback
// hop. Presence splits Funnel-forwarded traffic from true direct-local
// traffic. Routing hint only — see module header.
const FORWARD_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'forwarded',
  'x-forwarded-host',
  'x-real-ip',
]

// Socket peer address (never `req.ip`: with `trust proxy` enabled that
// reflects X-Forwarded-For, which is attacker-influenced on public hops).
export function socketPeer(req: Request): string {
  return req.socket?.remoteAddress ?? ''
}

// True when the request arrived via a forwarding proxy on the loopback
// socket (Funnel shape). Only ever withholds the localhost bypass.
export function hasForwardMarkers(req: Request): boolean {
  try {
    return FORWARD_HEADERS.some((h) => req.get(h) != null)
  } catch {
    return false
  }
}

function bearerToken(req: Request): string {
  return String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '')
}

// The existing credentials, checked in the same order as the route-level
// gates: cheap service-key compare first, then the OAuth access store
// (expiry enforced inside `lookupAccess`). Either audience counts here —
// data routes are not audience-bound the way `/mcp` vs `/jungle/mcp` are.
export function hasValidCredential(req: Request): boolean {
  const t = bearerToken(req)
  if (!t) return false
  if (t === toolKey) return true
  return lookupAccess(t) !== null
}

export type IngressVerdict =
  | 'ALLOW:mcp'
  | 'ALLOW:credential'
  | 'ALLOW:tailnet'
  | 'ALLOW:localhost'
  | 'DENY:403'

export function classifyIngress(req: Request): IngressVerdict {
  const p = req.path
  if (
    p === '/mcp' ||
    p === '/jungle/mcp' ||
    p.startsWith('/.well-known/') ||
    p.startsWith('/oauth/')
  ) {
    return 'ALLOW:mcp'
  }
  if (hasValidCredential(req)) return 'ALLOW:credential'
  const peer = socketPeer(req)
  if (TAILNET.test(peer.replace(/^::ffff:/, ''))) return 'ALLOW:tailnet'
  if (LOOPBACK.test(peer) && !hasForwardMarkers(req)) return 'ALLOW:localhost'
  return 'DENY:403'
}

export const accessGate: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const verdict = classifyIngress(req)
  ;(req as Request & { accessVerdict?: string }).accessVerdict = verdict
  if (verdict === 'DENY:403') {
    return void res.type('text/plain').status(403).send('# forbidden\n')
  }
  next()
}
