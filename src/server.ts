import express, { Request, Response, NextFunction, RequestHandler } from 'express'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import { PORT, BASE, toolKey, STORES, storeAbout } from './config'
import { qstr, pstr, cacheTag, bd, storeFromId } from './util'
import { wrap } from './wrap'
import { resumeRouter } from './routes/resume'
import { readRouter } from './routes/read'
import { verbsRouter } from './routes/verbs'
import { probeRouter } from './routes/probe'
import { actionsRouter } from './routes/actions'
import { warmResume } from './resume-cache'
import { guideRouter } from './routes/guide'
import { printRouter } from './routes/print'
import { pasteRouter } from './routes/paste'
import { resumeBlurbRouter } from './routes/resume-blurb'

const app = express()

app.use((req: Request, _res: Response, next: NextFunction) => {
  const ua = req.get('user-agent')?.slice(0, 120) ?? '-'
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} UA:${ua}`)
  next()
})

// Resume voice-loop routes first: /fetch/* and /resume must win over /:store.
app.use(resumeRouter)
app.use(resumeBlurbRouter)
app.use(readRouter)
app.use(verbsRouter)
app.use(probeRouter)
app.use(actionsRouter)
app.use(guideRouter)
app.use(printRouter)
app.use(express.urlencoded({ extended: false, limit: '2mb' }))
app.use(express.json({ limit: '2mb' }))
app.use(pasteRouter)

// ── Routes ────────────────────────────────────────────────────────────────────

app.use((req: Request, res: Response) => {
  res.type('text/plain').status(404).send(
    `# Not found: ${req.path}\n\nFetch / for the store index.\nFetch /next for the next queued item.`
  )
})

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  warmResume('resumes-zak')
  console.log(`beads-bridge on all interfaces :${PORT}`)
  console.log(`  local:   http://localhost:${PORT}`)
  console.log(`  tailnet: http://__TAILNET_IP__:${PORT}`)
  console.log(`  funnel:  ${BASE} (public; use this in ChatGPT blurbs)`)
})
