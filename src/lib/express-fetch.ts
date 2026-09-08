// Express <-> Fetch adapter for mcp-handler's web-standard handlers.
// Body parsers already ran, so non-GET bodies are re-serialized; the Fetch
// response is piped back onto the Express response.
import type { Request, Response } from 'express'

export type FetchHandler = (req: globalThis.Request) => globalThis.Response | Promise<globalThis.Response>

const PASS_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'last-event-id',
  'mcp-protocol-version',
  'authorization',
]

export function toFetchRequest(req: Request): globalThis.Request {
  const host = req.get('host') ?? 'localhost'
  const proto = req.protocol ?? 'http'
  const headers = new Headers()
  for (const h of PASS_HEADERS) {
    const v = req.get(h)
    if (v) headers.set(h, v)
  }
  const init: RequestInit = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  }
  return new globalThis.Request(`${proto}://${host}${req.originalUrl}`, init)
}

export async function sendFetchResponse(res: Response, out: globalThis.Response): Promise<void> {
  res.status(out.status)
  out.headers.forEach((v, k) => {
    if (!['content-length', 'connection', 'transfer-encoding'].includes(k.toLowerCase())) res.setHeader(k, v)
  })
  res.send(Buffer.from(await out.arrayBuffer()))
}

export function mountFetch(
  router: { all: (path: string, handler: (req: Request, res: Response) => void | Promise<void>) => unknown },
  path: string,
  handler: FetchHandler,
  onErrorStatus = 500,
): void {
  router.all(path, async (req: Request, res: Response) => {
    try {
      await sendFetchResponse(res, await handler(toFetchRequest(req)))
    } catch {
      res.status(onErrorStatus).json({ error: 'handler failed' })
    }
  })
}
