import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { oauthRouter } from './oauth'
import { mcpRouter } from './mcp'
import { readRouter } from './read'
import { jungleRouter } from './jungle'
import { chatgptRouter } from './chatgpt'
import { grokRouter } from './grok'
import { geminiRouter } from './gemini'
import { accessGate } from '../lib/access-gate'
import { loadRoutes } from './load-routes'
import { createSupportHatchApp } from '../support-hatch/mcp'

const EVIL = 'https://evil.example'

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(accessGate)
  app.use(express.urlencoded({ extended: false, limit: '2mb' }))
  app.use(express.json({ limit: '2mb' }))
  app.use(oauthRouter)
  app.use(mcpRouter)
  app.use(jungleRouter)
  app.use(chatgptRouter)
  app.use(grokRouter)
  app.use(geminiRouter)
  app.use(readRouter)
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const addr = server.address() as import('node:net').AddressInfo
  try {
    await fn('http://127.0.0.1:' + addr.port)
  } finally {
    const closer = server as import('node:http').Server & { closeAllConnections?: () => void }
    closer.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('CORS: default-deny preflight on /mcp', () => {
  beforeEach(() => {
    process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'cors-test-')), 'store.json')
  })

  it('OPTIONS /mcp returns no ACAO and no credentials allowance', async () => {
    await withApp(async (base) => {
      const res = await fetch(base + '/mcp', {
        method: 'OPTIONS',
        headers: {
          origin: EVIL,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      })
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
    })
  })

  it('a cross-origin POST /mcp without a bearer gets no ACAO', async () => {
    await withApp(async (base) => {
      const res = await fetch(base + '/mcp', {
        method: 'POST',
        headers: { origin: EVIL, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
    })
  })
})

describe('CORS: disallowed origin on an ordinary route', () => {
  it('GET /help with a cross origin returns no ACAO', async () => {
    await withApp(async (base) => {
      const res = await fetch(base + '/help', { headers: { origin: EVIL } })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
    })
  })

  it('OPTIONS /help with a cross origin returns no ACAO', async () => {
    await withApp(async (base) => {
      const res = await fetch(base + '/help', {
        method: 'OPTIONS',
        headers: { origin: EVIL, 'access-control-request-method': 'GET' },
      })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
    })
  })
})

describe('CORS: protected-resource metadata is public but not credentialed', () => {
  it('GET returns ACAO: * without credentials', async () => {
    await withApp(async (base) => {
      const res = await fetch(base + '/.well-known/oauth-protected-resource/mcp', {
        headers: { origin: EVIL },
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('access-control-allow-origin'), '*')
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS')
      assert.equal(res.headers.get('access-control-allow-headers'), '*')
      assert.equal(res.headers.get('access-control-max-age'), '86400')
      assert.equal(res.headers.get('access-control-expose-headers'), null)
    })
  })

  it('OPTIONS preflight returns ACAO: * without credentials', async () => {
    await withApp(async (base) => {
      const res = await fetch(base + '/.well-known/oauth-protected-resource/mcp', {
        method: 'OPTIONS',
        headers: { origin: EVIL, 'access-control-request-method': 'GET' },
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('access-control-allow-origin'), '*')
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS')
      assert.equal(res.headers.get('access-control-allow-headers'), '*')
      assert.equal(res.headers.get('access-control-max-age'), '86400')
    })
  })
})

describe('CORS: no tested endpoint advertises credentials', () => {
  it('none of /help, /mcp, metadata sets ACAC: true', async () => {
    await withApp(async (base) => {
      const cases: { path: string; init: RequestInit }[] = [
        { path: '/help', init: { headers: { origin: EVIL } } },
        { path: '/mcp', init: { method: 'OPTIONS', headers: { origin: EVIL, 'access-control-request-method': 'POST' } } },
        { path: '/.well-known/oauth-protected-resource/mcp', init: { headers: { origin: EVIL } } },
      ]
      for (const c of cases) {
        const res = await fetch(base + c.path, c.init)
        assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true', c.path)
      }
    })
  })
})

describe('CORS: scoped MCP doors are default-deny too', () => {
  beforeEach(() => {
    process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'cors-test-')), 'store.json')
  })

  for (const path of ['/jungle/mcp', '/chatgpt/mcp', '/grok/mcp', '/gemini/mcp']) {
    it(`OPTIONS ${path} returns no ACAO`, async () => {
      await withApp(async (base) => {
        const res = await fetch(base + path, {
          method: 'OPTIONS',
          headers: {
            origin: EVIL,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization,content-type',
          },
        })
        assert.equal(res.headers.get('access-control-allow-origin'), null)
        assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
      })
    })

    it(`GET ${path} with a cross origin returns no ACAO`, async () => {
      await withApp(async (base) => {
        const res = await fetch(base + path, { headers: { origin: EVIL } })
        assert.equal(res.headers.get('access-control-allow-origin'), null)
        assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
      })
    })
  }
})

describe('CORS: authorization-server metadata is default-deny', () => {
  for (const path of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/oauth-authorization-server/jungle/mcp',
    '/.well-known/oauth-authorization-server/chatgpt/mcp',
  ]) {
    it(`GET ${path} returns no ACAO`, async () => {
      await withApp(async (base) => {
        const res = await fetch(base + path, { headers: { origin: EVIL } })
        assert.equal(res.headers.get('access-control-allow-origin'), null)
        assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
      })
    })

    it(`OPTIONS ${path} returns no ACAO`, async () => {
      await withApp(async (base) => {
        const res = await fetch(base + path, {
          method: 'OPTIONS',
          headers: { origin: EVIL, 'access-control-request-method': 'GET' },
        })
        assert.equal(res.headers.get('access-control-allow-origin'), null)
        assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
      })
    })
  }
})

describe('CORS: OAuth ceremony endpoints are default-deny', () => {
  for (const path of ['/oauth/register', '/oauth/authorize', '/oauth/token']) {
    it(`OPTIONS ${path} returns no ACAO`, async () => {
      await withApp(async (base) => {
        const res = await fetch(base + path, {
          method: 'OPTIONS',
          headers: { origin: EVIL, 'access-control-request-method': 'POST' },
        })
        assert.equal(res.headers.get('access-control-allow-origin'), null)
        assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
      })
    })
  }
})

describe('CORS: all protected-resource metadata doors are public but not credentialed', () => {
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource/jungle/mcp',
    '/.well-known/oauth-protected-resource/chatgpt/mcp',
    '/.well-known/oauth-protected-resource/grok/mcp',
    '/.well-known/oauth-protected-resource/gemini/mcp',
  ]) {
    it(`GET ${path} returns ACAO: * without credentials or expose headers`, async () => {
      await withApp(async (base) => {
        const res = await fetch(base + path, { headers: { origin: EVIL } })
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('access-control-allow-origin'), '*')
        assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
        assert.equal(res.headers.get('access-control-expose-headers'), null)
        assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS')
        assert.equal(res.headers.get('access-control-allow-headers'), '*')
        assert.equal(res.headers.get('access-control-max-age'), '86400')
      })
    })

    it(`OPTIONS ${path} returns ACAO: * without credentials`, async () => {
      await withApp(async (base) => {
        const res = await fetch(base + path, {
          method: 'OPTIONS',
          headers: { origin: EVIL, 'access-control-request-method': 'GET' },
        })
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('access-control-allow-origin'), '*')
        assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
        assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS')
        assert.equal(res.headers.get('access-control-allow-headers'), '*')
        assert.equal(res.headers.get('access-control-max-age'), '86400')
      })
    })
  }
})

describe('CORS: ordinary routes expose no CORS grant', () => {
  for (const path of ['/help', '/live', '/']) {
    it(`GET ${path} returns no ACAO and no allow methods/headers`, async () => {
      await withApp(async (base) => {
        const res = await fetch(base + path, { headers: { origin: EVIL } })
        assert.equal(res.headers.get('access-control-allow-origin'), null)
        assert.equal(res.headers.get('access-control-allow-methods'), null)
        assert.equal(res.headers.get('access-control-allow-headers'), null)
        assert.equal(res.headers.get('access-control-expose-headers'), null)
        assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
      })
    })
  }
})

describe('CORS: support hatch is default-deny', () => {
  let server: import('node:http').Server
  let base: string

  before(async () => {
    process.env.SUPPORT_HATCH_DIR = mkdtempSync(join(tmpdir(), 'cors-hatch-'))
    const app = createSupportHatchApp('test-token-that-is-at-least-24-chars')
    server = await new Promise<import('node:http').Server>((resolve) => {
      const s = (app as any).listen(0, '127.0.0.1', () => resolve(s))
    })
    const addr = server.address() as import('node:net').AddressInfo
    base = 'http://127.0.0.1:' + addr.port
  })

  after(async () => {
    const closer = server as import('node:http').Server & { closeAllConnections?: () => void }
    closer.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  for (const path of ['/mcp', '/health']) {
    it(`OPTIONS ${path} returns no ACAO`, async () => {
      const res = await fetch(base + path, {
        method: 'OPTIONS',
        headers: { origin: EVIL, 'access-control-request-method': 'POST' },
      })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
    })

    it(`GET ${path} with a cross origin returns no ACAO`, async () => {
      const res = await fetch(base + path, { headers: { origin: EVIL } })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
    })
  }
})

describe('CORS: full surface default-deny smoke (real app via loadRoutes)', () => {
  let server: import('node:http').Server
  let base: string

  before(async () => {
    process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'cors-full-')), 'store.json')
    const app = express()
    app.set('trust proxy', 'loopback')
    app.use(accessGate)
    app.use(express.urlencoded({ extended: false, limit: '2mb' }))
    app.use(express.json({ limit: '2mb' }))
    await loadRoutes(app)
    app.use(express.static(join(tmpdir(), 'cors-no-static')))
    app.use((_req: any, res: any) => res.type('text/plain').status(404).send('nf'))
    server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    const addr = server.address() as import('node:net').AddressInfo
    base = 'http://127.0.0.1:' + addr.port
  }, { timeout: 60000 })

  after(async () => {
    const closer = server as import('node:http').Server & { closeAllConnections?: () => void }
    closer.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, { timeout: 60000 })

  const paths = ['/', '/help', '/live', '/live/config', '/live/variants', '/live/v1', '/probe', '/guide', '/actions/openapi.json', '/experiment/test']

  for (const p of paths) {
    it(`GET ${p} returns no ACAO`, async () => {
      const res = await fetch(base + p, { headers: { origin: EVIL } })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
    })

    it(`OPTIONS ${p} returns no ACAO`, async () => {
      const res = await fetch(base + p, {
        method: 'OPTIONS',
        headers: { origin: EVIL, 'access-control-request-method': 'GET' },
      })
      assert.equal(res.headers.get('access-control-allow-origin'), null)
      assert.notEqual(res.headers.get('access-control-allow-credentials'), 'true')
    })
  }
})

describe('CORS: no application-level CORS grant exists in src/', () => {
  it('no non-test source file references Access-Control', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = j(process.cwd(), 'src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = j(dir, name)
        if (statSync(full).isDirectory()) { walk(full); continue }
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
        const content = readFileSync(full, 'utf8')
        if (content.includes('Access-Control')) offenders.push(full)
      }
    }
    walk(root)
    assert.deepEqual(offenders, [], `unexpected CORS header usage: ${offenders.join(', ')}`)
  })
})
