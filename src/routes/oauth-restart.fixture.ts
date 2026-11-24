// One bridge "process" for src/routes/oauth-restart.test.ts: the public OAuth
// routes behind the real access gate, plus the tailnet approval app (its socket
// peer is injected — the test can only reach it from loopback). Prints one JSON
// line with both ports and its pid, then serves until killed. Each test step
// runs in a fresh process, so nothing in memory can carry a grant between steps.
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { accessGate } from '../lib/access-gate'
import { createTailnetApprovalApp } from '../lib/tailnet-approval'
import { oauthRouter } from './oauth'

const listen = (app: express.Express): Promise<Server> =>
  new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s))
  })

const publicApp = express()
publicApp.use(accessGate)
publicApp.use(express.urlencoded({ extended: false, limit: '2mb' }))
publicApp.use(express.json({ limit: '2mb' }))
publicApp.use(oauthRouter)

void Promise.all([
  listen(publicApp),
  listen(createTailnetApprovalApp({ peer: (req) => req.get('x-test-peer') ?? '' })),
]).then(([pub, tail]) => {
  const port = (s: Server) => (s.address() as AddressInfo).port
  process.stdout.write(`${JSON.stringify({ pid: process.pid, pub: port(pub), tail: port(tail) })}\n`)
})
