// Tailnet-only human approval for OAuth grants (replaces the typed setup key).
//
// The public approval page (src/routes/oauth.ts) shows a QR code / link for
// `http://<TAILNET_IP>:<APPROVAL_PORT>/oauth/approve/<pending-id>`. That route
// exists ONLY on this module's separate Express app, served by a second
// listener bound to TAILNET_IP — the public app never mounts it, so from the
// Funnel path it is a plain 404, like Sidecar's pair/approve routes on its
// public front. Defence in depth, none of it header-based:
//   1. structural: only this app has the route, and it listens on the tailnet
//      interface address, not 0.0.0.0 and not loopback;
//   2. the socket peer must be inside the Tailscale CGNAT range 100.64.0.0/10
//      (displayd `touch_client.py` TAILNET_CGNAT);
//   3. a request carrying proxy-forwarding headers (a Funnel/proxy hop) is
//      refused even if its peer is in range. X-Forwarded-For is never trusted.
// Approving only flips the pending record; the original public browser sees
// that on its status poll and completes the normal code/PKCE flow itself.
import express from 'express'
import type { Request, RequestHandler } from 'express'
import { isIPv4 } from 'net'
import type { Server } from 'http'
import { APPROVAL_PORT } from '../config'
import { hasForwardMarkers, socketPeer } from './access-gate'
import { cancelTx, esc } from './oauth-tx'
import { decidePendingApproval, getPendingApproval } from './oauth'

/** True for IPv4 addresses inside 100.64.0.0/10 (also ::ffff:-mapped). */
export function isTailnetAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, '')
  if (!isIPv4(a)) return false
  const [o1, o2] = a.split('.').map(Number)
  return o1 === 100 && o2 >= 64 && o2 <= 127
}

export const APPROVE_PATH = '/oauth/approve'

// Read at call time (config.ts has already merged .env into process.env), so
// tests can point the bridge at a tailnet address without re-importing config.
const tailnetIp = (): string => process.env.TAILNET_IP ?? 'unset'

/** The URL the QR code / tappable link carries, or null when TAILNET_IP is unusable. */
export function tailnetApprovalUrl(pendingId: string, ip: string = tailnetIp(), port: number = APPROVAL_PORT): string | null {
  if (!isTailnetAddress(ip)) return null
  return `http://${ip}:${port}${APPROVE_PATH}/${pendingId}`
}

const notFound: RequestHandler = (req, res) => {
  res.type('text/plain').status(404).send(
    `# Not found: ${req.path}\n\nFetch / for the store index.\nFetch /next for the next queued item.`,
  )
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve beads-bridge</title></head><body style="font-family:system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem">${body}</body></html>`
}

export interface TailnetApprovalOptions {
  /** Socket peer of a request; injectable so tests can simulate tailnet peers. */
  peer?: (req: Request) => string
}

export function createTailnetApprovalApp(opts: TailnetApprovalOptions = {}): express.Express {
  const peerOf = opts.peer ?? socketPeer
  const app = express()
  app.disable('x-powered-by')
  // No `trust proxy`: the peer is the socket address, nothing else.

  app.use((req, res, next) => {
    if (!isTailnetAddress(peerOf(req)) || hasForwardMarkers(req)) return notFound(req, res, next)
    next()
  })
  app.use(express.urlencoded({ extended: false, limit: '8kb' }))

  const id = (req: Request): string => String(req.params.id ?? '')

  app.get(`${APPROVE_PATH}/:id`, (req, res, next) => {
    const rec = getPendingApproval(id(req))
    if (!rec) return notFound(req, res, next)
    if (rec.status !== 'pending') {
      return void res.type('text/html').send(page(`<h1>Already ${esc(rec.status)}</h1><p>This request has been decided. You can close this page.</p>`))
    }
    res.type('text/html').send(page(
      `<h1>Approve beads-bridge access?</h1>` +
      `<p><b>${esc(rec.clientName)}</b> wants full bead access (scope: ${esc(rec.scope.join(' ') || 'mcp')}). After approval it is sent back to <b>${esc(rec.redirectHost)}</b>.</p>` +
      `<p>Code: <b style="font-size:2rem;letter-spacing:.2em;font-family:ui-monospace,monospace">${esc(rec.shortCode)}</b></p>` +
      `<p>Approve only if this code matches the one on the page that is asking.</p>` +
      `<form method="post" action="${APPROVE_PATH}/${esc(id(req))}">` +
      `<button type="submit" name="decision" value="approve" style="font-size:1.2rem;padding:.6rem 1.4rem">Approve</button> ` +
      `<button type="submit" name="decision" value="deny" style="font-size:1.2rem;padding:.6rem 1.4rem">Deny</button>` +
      `</form>`,
    ))
  })

  app.post(`${APPROVE_PATH}/:id`, (req, res, next) => {
    // A cross-site form post must not be able to flip a decision.
    const origin = req.get('origin')
    if (origin) {
      let host = ''
      try { host = new URL(origin).host } catch { /* treated as mismatch */ }
      if (host !== req.get('host')) return void res.type('text/plain').status(403).send('cross-origin request refused\n')
    }
    const rec = getPendingApproval(id(req))
    if (!rec) return notFound(req, res, next)
    const approve = (req.body ?? {}).decision === 'approve'
    const result = decidePendingApproval(id(req), approve ? 'approved' : 'denied')
    if (result === 'not_found') return notFound(req, res, next)
    if (result === 'already_decided') {
      return void res.status(409).type('text/html').send(page(`<h1>Already decided</h1><p>This request was decided already. You can close this page.</p>`))
    }
    if (!approve) cancelTx(rec.tx)
    res.type('text/html').send(page(
      approve
        ? `<h1>Approved</h1><p>The waiting browser will finish connecting on its own. You can close this page.</p>`
        : `<h1>Denied</h1><p>The request was cancelled. You can close this page.</p>`,
    ))
  })

  app.use(notFound)
  return app
}

const RETRY_MS = 30_000

/**
 * Bind the tailnet listener on TAILNET_IP:APPROVAL_PORT. Returns null (after
 * logging why) when TAILNET_IP is not a tailnet address; a failed bind (e.g.
 * Tailscale not up yet at boot) is retried so the public bridge never depends
 * on it.
 */
export function startTailnetApprovalListener(app: express.Express = createTailnetApprovalApp()): Server | null {
  const ip = tailnetIp()
  if (!isTailnetAddress(ip)) {
    console.log(`  tailnet approval: DISABLED (TAILNET_IP is not a 100.64.0.0/10 address) — QR approval unavailable`)
    return null
  }
  const listen = (): Server => {
    const server = app.listen(APPROVAL_PORT, ip, () => {
      console.log(`  tailnet approval: http://${ip}:${APPROVAL_PORT}${APPROVE_PATH}/<id> (tailnet peers only)`)
    })
    server.on('error', (e: NodeJS.ErrnoException) => {
      console.error(`tailnet approval listener failed (${e.code ?? e.message}); retrying in ${RETRY_MS / 1000}s`)
      server.close()
      setTimeout(listen, RETRY_MS).unref()
    })
    return server
  }
  return listen()
}
