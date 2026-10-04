import { timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import express, { type Request, type Response } from 'express'
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'
import { retrieveReport, submitReport, type DiagnosticReport } from './store'

const maxText = (max: number) => z.string().max(max).optional()
const reportSchema = z.object({
  user_description: z.string().min(1).max(4000),
  failing_operation: z.string().min(1).max(2000),
  exact_response: z.string().min(1).max(16000),
  timestamp: maxText(100),
  bridge_version: maxText(200),
  backend_version: maxText(200),
  manifest_schema_metadata: maxText(4000),
  recent_call_context: maxText(8000),
  client_identity: maxText(500),
  reproduction_steps: maxText(4000),
}).strict()

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const error = (value: string) => ({ content: [{ type: 'text' as const, text: value }], isError: true as const })

export const supportHatchHandler = createMcpHandler((server) => {
  server.registerTool(
    'support_report_submit',
    {
      title: 'Submit diagnostic report',
      description: 'Submit a compact Beads/bridge/MCP failure report to the independent support hatch. Keep exact_response verbatim; do not include secrets or credentials. The returned receipt can be verified by retrieving the report.',
      inputSchema: reportSchema,
    },
    async (input: DiagnosticReport) => {
      const parsed = reportSchema.safeParse(input)
      if (!parsed.success) return error(`Invalid diagnostic report: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      try {
        const receipt = submitReport(parsed.data)
        return text(JSON.stringify({ accepted: true, receipt }, null, 2))
      } catch (e) {
        return error(`Support hatch storage unavailable; no receipt issued: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'support_report_get',
    {
      title: 'Retrieve diagnostic report',
      description: 'Retrieve a report by report_id and independently verify its SHA-256 receipt.',
      inputSchema: z.object({ report_id: z.string().uuid() }),
    },
    async ({ report_id }: { report_id: string }) => {
      try {
        const stored = retrieveReport(report_id)
        if (!stored) return error(`No complete support report found for ${report_id}.`)
        return text(JSON.stringify(stored, null, 2))
      } catch (e) {
        return error(`Support report integrity check failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )
})

function authorized(req: Request, token: string): boolean {
  const supplied = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function dispatch(req: Request, res: Response, token: string): Promise<void> {
  if (!authorized(req, token)) {
    res.status(401).type('text/plain').send('Support hatch bearer token required.\n')
    return
  }
  try {
    const method = req.method.toUpperCase()
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    const body = method === 'GET' || method === 'HEAD' ? undefined : await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let oversized = false
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 64 * 1024) {
          oversized = true
          reject(new Error('REQUEST_TOO_LARGE'))
          req.resume()
          return
        }
        if (!oversized) chunks.push(Buffer.from(chunk))
      })
      req.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks)) })
      req.on('error', reject)
    })
    const fetchReq = new Request(`http://${req.headers.host ?? 'localhost'}${req.originalUrl}`, { method, headers, body: body?.length ? body : undefined, duplex: 'half' } as RequestInit)
    const out = await supportHatchHandler(fetchReq)
    res.status(out.status)
    out.headers.forEach((value, key) => res.setHeader(key, value))
    if (!out.body) { res.end(); return }
    Readable.fromWeb(out.body as import('node:stream/web').ReadableStream).pipe(res)
  } catch (e) {
    if (!res.headersSent && e instanceof Error && e.message === 'REQUEST_TOO_LARGE') res.status(413).json({ error: 'MCP request exceeds the 64 KiB limit.' })
    else if (!res.headersSent) res.status(500).json({ error: `Support hatch handler failed: ${e instanceof Error ? e.message : String(e)}` })
    else res.destroy(e instanceof Error ? e : undefined)
  }
}

export function createSupportHatchApp(token: string) {
  if (!token || token.length < 24) throw new Error('SUPPORT_HATCH_TOKEN must contain at least 24 characters')
  const app = express()
  app.all('/mcp', (req, res) => { void dispatch(req, res, token) })
  app.get('/health', (_req, res) => res.json({ service: 'support-hatch', storage: 'independent-files' }))
  return app
}
