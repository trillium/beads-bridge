import express, { Request, Response, NextFunction, RequestHandler } from 'express'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import { PORT, BASE, toolKey, STORES, storeAbout, TAILNET_IP } from './config'
import { qstr, pstr, cacheTag, bd, storeFromId } from './util'
import { wrap } from './wrap'
import { warmResume } from './resume-cache'
import { loadRoutes } from './routes/load-routes'
import { isWebAgent } from './agent-detect'

const app = express()

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now()
  res.on('finish', () => {
    const ua = req.get('user-agent')?.slice(0, 80) ?? '-'
    const verdict = (req as Request & { accessVerdict?: string }).accessVerdict ?? 'ALLOW:legacy'
    console.log(`${new Date().toISOString()} ${verdict} ${res.statusCode} ${req.method} ${req.originalUrl} ip=${req.ip} ua=${ua} ${Date.now() - start}ms`)
  })
  next()
})

// Access gate: tailnet IPs and localhost always pass; off-tailnet passes
// only for approved agent fetchers (ChatGPT). Everything else gets 403.
const TAILNET = /^100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\./
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/
const APPROVED_AGENT_UA = /chatgpt-user|gptbot/i
app.use((req: Request, res: Response, next: NextFunction) => {
  const tagged = req as Request & { accessVerdict?: string }
  const ip = (req.ip ?? '').replace(/^::ffff:/, '')
  const ua = req.get('user-agent') ?? ''
  if (TAILNET.test(ip)) tagged.accessVerdict = 'ALLOW:tailnet'
  else if (LOOPBACK.test(req.ip ?? '')) tagged.accessVerdict = 'ALLOW:localhost'
  else if (APPROVED_AGENT_UA.test(ua)) tagged.accessVerdict = 'ALLOW:agent-ua'
  else {
    tagged.accessVerdict = 'DENY:403'
    return void res.type('text/plain').status(403).send('# forbidden\n')
  }
  next()
})

// File-based routing: src/routes/*.ts auto-mounts (see load-routes.ts).
// Body parsers first so route files never think about them.
app.use(express.urlencoded({ extended: false, limit: '2mb' }))
app.use(express.json({ limit: '2mb' }))

// ── Start ─────────────────────────────────────────────────────────────────────
// Registration order: route files first, then SPA static, then the 404.
// (Static before routes would let dist/index.html swallow / and break agents.)
async function start() {
  await loadRoutes(app)
  app.use(express.static(path.join(__dirname, '..', 'web', 'dist')))
  app.use((req: Request, res: Response) => {
    res.type('text/plain').status(404).send(
      `# Not found: ${req.path}\n\nFetch / for the store index.\nFetch /next for the next queued item.`
    )
  })
  app.listen(PORT, '0.0.0.0', () => {
    warmResume('resumes-zak')
    console.log(`beads-bridge on all interfaces :${PORT}`)
    console.log(`  local:   http://localhost:${PORT}`)
    console.log(`  tailnet: http://${TAILNET_IP}:${PORT}`)
    console.log(`  funnel:  ${BASE} (public; use this in ChatGPT blurbs)`)
  })
}

start().catch((e) => {
  console.error('failed to start:', e)
  process.exit(1)
})
