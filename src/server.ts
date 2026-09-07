import express, { Request, Response, NextFunction, RequestHandler } from 'express'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import { PORT, BASE, toolKey, STORES, storeAbout } from './config'
import { qstr, pstr, cacheTag, bd, storeFromId } from './util'
import { wrap } from './wrap'
import { warmResume } from './resume-cache'
import { loadRoutes } from './routes/load-routes'
import { isWebAgent } from './agent-detect'

const app = express()

app.use((req: Request, _res: Response, next: NextFunction) => {
  const ua = req.get('user-agent')?.slice(0, 120) ?? '-'
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} UA:${ua}`)
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
    console.log(`  tailnet: http://__TAILNET_IP__:${PORT}`)
    console.log(`  funnel:  ${BASE} (public; use this in ChatGPT blurbs)`)
  })
}

start().catch((e) => {
  console.error('failed to start:', e)
  process.exit(1)
})
