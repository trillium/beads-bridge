// Unit tests: bun test src/lib/oauth.test.ts (node:test, no new deps).
// Store tests point OAUTH_STORE_PATH at a temp dir — never the real one.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CODE_TTL_MS,
  MAX_GRANTS,
  PENDING_APPROVAL_TTL_MS,
  SHORT_CODE_LEN,
  EXPIRED_TOMBSTONE_TTL_MS,
  NEVER_EXPIRES,
  NO_EXPIRY_EXPIRES_IN_S,
  GRANT_TTL_MS,
  accessTokenState,
  buildAuthorizationServerMetadata,
  consumeCode,
  challengeGrant,
  decideGrantChallenge,
  denyGrant,
  getGrant,
  getGrantChallenge,
  grantChallengeState,
  openGrant,
  redeemGrant,
  loadStore,
  lookupAccess,
  mintCode,
  mintTokenPair,
  mcpResource,
  normalizeResource,
  parseScope,
  pkceChallenge,
  redirectMatches,
  rotateRefresh,
  saveStore,
  storePath,
  tokenLive,
  validateCimdDoc,
  validateRedirectUri,
} from './oauth'

const BASE = 'https://bridge.example.net'

beforeEach(() => {
  process.env.OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'oauth-test-')), 'store.json')
})

describe('pkceChallenge', () => {
  it('matches the RFC 7636 Appendix B vector', () => {
    assert.equal(
      pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })
})

describe('redirectMatches', () => {
  it('accepts exact matches', () => {
    assert.ok(redirectMatches('https://app.example/cb', 'https://app.example/cb'))
  })
  it('allows loopback port flexibility (RFC 8252)', () => {
    assert.ok(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:51734/callback'))
    assert.ok(!redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:51734/other'))
  })
  it('rejects host/scheme drift on non-loopback', () => {
    assert.ok(!redirectMatches('https://app.example/cb', 'https://evil.example/cb'))
    assert.ok(!redirectMatches('https://app.example/cb', 'http://app.example/cb'))
  })
})

describe('validateRedirectUri', () => {
  it('rejects http non-loopback even if listed', () => {
    assert.ok(!validateRedirectUri(['http://app.example/cb'], 'http://app.example/cb'))
  })
  it('rejects unparsable input', () => {
    assert.ok(!validateRedirectUri(['https://app.example/cb'], 'not a url'))
  })
})

describe('validateCimdDoc', () => {
  const good = {
    client_id: 'https://chatgpt.com/oauth/codex/abc/client.json',
    client_name: 'ChatGPT',
    redirect_uris: ['http://127.0.0.1:9999/callback/abc'],
  }
  it('accepts a matching doc', () => {
    const r = validateCimdDoc(good.client_id, good)
    assert.ok(r.ok)
    assert.deepEqual(r.redirectUris, good.redirect_uris)
  })
  it('rejects client_id mismatch and bad shapes', () => {
    assert.ok(!validateCimdDoc('https://x.example/other.json', good).ok)
    assert.ok(!validateCimdDoc(good.client_id, { client_id: good.client_id }).ok)
    assert.ok(!validateCimdDoc(good.client_id, null).ok)
  })
})

describe('normalizeResource', () => {
  it('accepts the canonical resource, tolerates a trailing slash', () => {
    assert.equal(normalizeResource(BASE, `${BASE}/mcp`), `${BASE}/mcp`)
    assert.equal(normalizeResource(BASE, `${BASE}/mcp/`), `${BASE}/mcp`)
  })
  it('accepts the scoped chatgpt audience (and its trailing slash)', () => {
    assert.equal(normalizeResource(BASE, `${BASE}/chatgpt/mcp`), `${BASE}/chatgpt/mcp`)
    assert.equal(normalizeResource(BASE, `${BASE}/chatgpt/mcp/`), `${BASE}/chatgpt/mcp`)
  })
  it('rejects anything else', () => {
    assert.equal(normalizeResource(BASE, `${BASE}/other`), null)
    assert.equal(normalizeResource(BASE, 'https://evil.example/mcp'), null)
  })
})

describe('parseScope', () => {
  it('defaults to mcp and rejects unknown scopes', () => {
    assert.deepEqual(parseScope(undefined), ['mcp'])
    assert.deepEqual(parseScope('mcp'), ['mcp'])
    assert.equal(parseScope('mcp admin'), null)
  })
})

describe('buildAuthorizationServerMetadata', () => {
  it('advertises everything ChatGPT hard-requires', () => {
    const m = buildAuthorizationServerMetadata(BASE)
    assert.equal(m.issuer, BASE)
    assert.equal(m.authorization_endpoint, `${BASE}/oauth/authorize`)
    assert.equal(m.token_endpoint, `${BASE}/oauth/token`)
    assert.ok((m.registration_endpoint as string).endsWith('/oauth/register'))
    assert.deepEqual(m.code_challenge_methods_supported, ['S256'])
    assert.ok((m.token_endpoint_auth_methods_supported as string[]).includes('none'))
    assert.equal(m.authorization_response_iss_parameter_supported, true)
    assert.equal(m.logo_uri, `${BASE}/favicon.svg`)
  })
})

describe('code + token lifecycle', () => {
  it('consumes once, then mints and rotates pairs', () => {
    const resource = mcpResource(BASE)
    const { code } = mintCode({
      clientId: 'bbcid_test',
      redirectUri: 'http://127.0.0.1:1/callback',
      challenge: pkceChallenge('verifier-123'),
      resource,
      scope: ['mcp'],
      expiresAt: 0,
    })
    const rec = consumeCode(code)
    assert.ok(rec)
    assert.equal(consumeCode(code), null) // single-use
    const pair = mintTokenPair(rec!.clientId, rec!.scope, rec!.resource)
    assert.ok(lookupAccess(pair.accessToken))
    const rotated = rotateRefresh(pair.refreshToken)
    assert.ok(rotated)
    assert.equal(lookupAccess(pair.accessToken), null) // old access revoked
    assert.equal(rotateRefresh(pair.refreshToken), null) // old refresh spent
    assert.ok(lookupAccess(rotated!.accessToken))
  })
})

// Granted credentials live until revoked: the token handout must not
// reintroduce expiry for disuse (the "Connection failed" a day later).
// Time travel patches Date.now, so no test depends on real elapsed time.
function travelAhead(ms: number): () => void {
  const real = Date.now
  Date.now = () => real() + ms
  return () => { Date.now = real }
}

describe('never-expiring credentials', () => {
  it('tokenLive: the one enforcement point — sentinel live, future live, past dead', () => {
    assert.equal(tokenLive(NEVER_EXPIRES), true)
    assert.equal(tokenLive(Date.now() + 60_000), true)
    assert.equal(tokenLive(Date.now() - 60_000), false)
  })

  it('a granted token still authorizes after 25h, 31d, and 366d of disuse', () => {
    const pair = mintTokenPair('bbcid_forever', ['mcp'], mcpResource(BASE))
    assert.equal(pair.expiresIn, NO_EXPIRY_EXPIRES_IN_S)
    // Sentinel survives the JSON file round trip (Infinity would not).
    const onDisk = JSON.parse(readFileSync(storePath(), 'utf8'))
    assert.equal(onDisk.access[pair.accessToken].expiresAt, NEVER_EXPIRES)
    assert.equal(onDisk.refresh[pair.refreshToken].expiresAt, NEVER_EXPIRES)
    for (const age of [25 * 3600 * 1000, 31 * 24 * 3600 * 1000, 366 * 24 * 3600 * 1000]) {
      const restore = travelAhead(age)
      try {
        assert.ok(lookupAccess(pair.accessToken), `access dead after ${age}ms`)
      } finally {
        restore()
      }
    }
    // Rotation still works past the old 30-day refresh death, and the
    // rotated pair is itself immortal.
    const restore = travelAhead(31 * 24 * 3600 * 1000)
    try {
      const rotated = rotateRefresh(pair.refreshToken)
      assert.ok(rotated)
      assert.ok(lookupAccess(rotated!.accessToken))
    } finally {
      restore()
    }
  })

  it('legacy live tokens promote to never-expire on load; dead ones still prune', () => {
    const now = Date.now()
    const resource = mcpResource(BASE)
    writeFileSync(storePath(), JSON.stringify({
      clients: {},
      codes: {},
      access: {
        bb_at_legacy: { clientId: 'c', scope: ['mcp'], resource, expiresAt: now + 3600_000 },
        bb_at_dead: { clientId: 'c', scope: ['mcp'], resource, expiresAt: now - 1000 },
      },
      refresh: {
        bb_rt_legacy: { clientId: 'c', scope: ['mcp'], resource, expiresAt: now + 3600_000, accessToken: 'bb_at_legacy' },
        bb_rt_dead: { clientId: 'c', scope: ['mcp'], resource, expiresAt: now - 1000, accessToken: 'bb_at_dead' },
      },
      approvals: {},
    }))
    const loaded = loadStore()
    assert.equal(loaded.access.bb_at_legacy.expiresAt, NEVER_EXPIRES)
    assert.equal(loaded.refresh.bb_rt_legacy.expiresAt, NEVER_EXPIRES)
    assert.equal(loaded.access.bb_at_dead, undefined)
    assert.equal(loaded.refresh.bb_rt_dead, undefined)
    saveStore(loaded)
    const onDisk = JSON.parse(readFileSync(storePath(), 'utf8'))
    assert.equal(onDisk.access.bb_at_legacy.expiresAt, NEVER_EXPIRES)
    assert.equal(onDisk.access.bb_at_dead, undefined)
    const restore = travelAhead(25 * 3600 * 1000)
    try {
      assert.ok(lookupAccess('bb_at_legacy'))
      assert.ok(rotateRefresh('bb_rt_legacy'))
    } finally {
      restore()
    }
  })

  it('revocation by deleting the store file still takes effect', () => {
    const pair = mintTokenPair('bbcid_revoke', ['mcp'], mcpResource(BASE))
    assert.ok(lookupAccess(pair.accessToken))
    unlinkSync(storePath())
    assert.equal(lookupAccess(pair.accessToken), null)
    assert.equal(rotateRefresh(pair.refreshToken), null)
  })

  it('unknown or garbage bearers never authorize', () => {
    mintTokenPair('bbcid_probe', ['mcp'], mcpResource(BASE))
    assert.equal(lookupAccess('bb_at_nope'), null)
    assert.equal(lookupAccess(''), null)
    assert.equal(rotateRefresh('bb_rt_nope'), null)
    assert.equal(rotateRefresh(''), null)
  })
})

describe('flow-step lifetimes are untouched', () => {
  it('CODE_TTL_MS and GRANT_TTL_MS are still short', () => {
    assert.equal(CODE_TTL_MS, 10 * 60 * 1000)
    assert.equal(GRANT_TTL_MS, 15 * 60 * 1000)
  })

  it('codes still expire on schedule', () => {
    const resource = mcpResource(BASE)
    const mk = () => mintCode({
      clientId: 'bbcid_code',
      redirectUri: 'http://127.0.0.1:1/callback',
      challenge: pkceChallenge('v'),
      resource,
      scope: ['mcp'],
      expiresAt: 0,
    }).code
    const old = mk()
    const restore = travelAhead(CODE_TTL_MS + 60_000)
    try {
      assert.equal(consumeCode(old), null)
    } finally {
      restore()
    }
    assert.ok(consumeCode(mk())) // fresh codes still work
  })

  it('approvals still sweep at 90 days', () => {
    const now = Date.now()
    writeFileSync(storePath(), JSON.stringify({
      clients: {},
      codes: {},
      access: {},
      refresh: {},
      approvals: { fresh: now, stale: now - 91 * 24 * 3600 * 1000 },
    }))
    const loaded = loadStore()
    assert.ok(loaded.approvals.fresh)
    assert.equal(loaded.approvals.stale, undefined)
  })
})

describe('accessTokenState (expired vs unknown)', () => {
  const dead = { clientId: 'c', scope: ['mcp'], resource: 'r', expiresAt: Date.now() - 60_000 }

  it('reports live, expired (tombstone) and unknown', () => {
    const live = mintTokenPair('c', ['mcp'], 'r').accessToken
    writeFileSync(storePath(), JSON.stringify({ ...loadStore(), access: { ...loadStore().access, bb_at_dead: dead } }))
    assert.equal(accessTokenState(live), 'live')
    assert.equal(accessTokenState('bb_at_dead'), 'expired')
    assert.equal(accessTokenState('bb_at_nope'), 'unknown')
    assert.equal(lookupAccess('bb_at_dead'), null) // a tombstone grants nothing
  })

  it('persists a hashed tombstone on save and never writes the token back', () => {
    writeFileSync(storePath(), JSON.stringify({ ...loadStore(), access: { bb_at_dead: dead } }))
    saveStore(loadStore())
    const raw = readFileSync(storePath(), 'utf8')
    assert.ok(!raw.includes('bb_at_dead'))
    assert.equal(accessTokenState('bb_at_dead'), 'expired')
  })

  it('drops tombstones after the retention window', () => {
    writeFileSync(storePath(), JSON.stringify({ ...loadStore(), access: { bb_at_dead: dead } }))
    saveStore(loadStore())
    const restore = travelAhead(EXPIRED_TOMBSTONE_TTL_MS + 60_000)
    try {
      assert.equal(accessTokenState('bb_at_dead'), 'unknown')
    } finally {
      restore()
    }
  })
})

describe('grants (one persisted record per authorization)', () => {
  const req = {
    clientId: 'bbcid_a',
    clientName: 'ChatGPT',
    redirectUri: 'https://chatgpt.com/cb',
    scope: ['mcp'],
    clientState: 's1',
    codeChallenge: 'pkce',
    resource: 'https://example.test/mcp',
  }
  const onDisk = () => JSON.parse(readFileSync(storePath(), 'utf8')).grants
  const challenged = () => {
    const { id } = openGrant(req)
    return { id, c: challengeGrant(id)! }
  }

  it('opens an unguessable, persisted, 15-minute record holding the whole request', () => {
    const before = Date.now()
    const { id } = openGrant(req)
    assert.match(id, /^bbtx_[A-Za-z0-9_-]{24}$/)
    const g = onDisk()[id]
    assert.equal(g.state, 'open')
    assert.equal(g.redirectUri, req.redirectUri)
    assert.equal(g.codeChallenge, 'pkce')
    assert.equal(g.clientState, 's1')
    assert.ok(g.expiresAt >= before + GRANT_TTL_MS && g.expiresAt <= Date.now() + GRANT_TTL_MS)
    assert.notEqual(openGrant(req).id, id)
  })

  it('a challenge mints an unguessable id, a short code and a 10-minute expiry on the record', () => {
    const before = Date.now()
    const { id, c } = challenged()
    assert.match(c.id, /^bbpa_[A-Za-z0-9_-]{24}$/)
    assert.equal(c.shortCode.length, SHORT_CODE_LEN)
    assert.match(c.shortCode, /^[A-HJKMNP-Z2-9]+$/)
    assert.ok(c.expiresAt >= before + PENDING_APPROVAL_TTL_MS && c.expiresAt <= Date.now() + PENDING_APPROVAL_TTL_MS)
    assert.equal(PENDING_APPROVAL_TTL_MS, 10 * 60 * 1000)
    assert.equal(onDisk()[id].state, 'challenged')
    assert.deepEqual(onDisk()[id].challenge, c)
    assert.equal(grantChallengeState(c.id), 'pending')
    assert.deepEqual(getGrantChallenge(c.id), { status: 'pending', shortCode: c.shortCode, clientName: 'ChatGPT', redirectHost: 'chatgpt.com', scope: ['mcp'] })
  })

  it('re-challenging replaces the challenge: the old id is dead at once', () => {
    const { id, c } = challenged()
    const next = challengeGrant(id)!
    assert.notEqual(next.id, c.id)
    assert.equal(grantChallengeState(c.id), 'expired')
    assert.equal(decideGrantChallenge(c.id, 'approved'), 'not_found')
    assert.equal(grantChallengeState(next.id), 'pending')
  })

  it('decides once: challenged → approved, then refuses a second decision', () => {
    const { id, c } = challenged()
    assert.equal(decideGrantChallenge(c.id, 'approved'), 'ok')
    assert.equal(grantChallengeState(c.id), 'approved')
    assert.equal(decideGrantChallenge(c.id, 'denied'), 'already_decided')
    assert.equal(getGrant(id)?.state, 'approved')
    assert.equal(decideGrantChallenge('bbpa_nope', 'approved'), 'not_found')
    // A live approval cannot be wiped by a re-challenge.
    assert.equal(challengeGrant(id), null)
    assert.equal(grantChallengeState(c.id), 'approved')
  })

  it('redeem is a single compare-and-set: pending, then approved once, then unknown', () => {
    const { id, c } = challenged()
    assert.deepEqual(redeemGrant(id, { challengeId: c.id, browserApproved: false }), { outcome: 'pending' })
    decideGrantChallenge(c.id, 'approved')
    assert.deepEqual(redeemGrant(id, { challengeId: 'bbpa_other', browserApproved: false }), { outcome: 'unapproved' })
    const r = redeemGrant(id, { challengeId: c.id, browserApproved: false })
    assert.equal(r.outcome, 'approved')
    assert.equal(r.outcome === 'approved' && r.via, 'tailnet')
    assert.equal(r.outcome === 'approved' && r.grant.codeChallenge, 'pkce')
    assert.deepEqual(redeemGrant(id, { challengeId: c.id, browserApproved: false }), { outcome: 'unknown' })
    assert.equal(getGrant(id), null)
    assert.equal(grantChallengeState(c.id), 'expired')
  })

  it('a denied grant redeems as denied, once — even for an already-approved browser', () => {
    const { id, c } = challenged()
    decideGrantChallenge(c.id, 'denied')
    assert.equal(redeemGrant(id, { challengeId: c.id, browserApproved: true }).outcome, 'denied')
    assert.equal(redeemGrant(id, { challengeId: c.id, browserApproved: true }).outcome, 'unknown')
  })

  it('an already-approved browser redeems an open grant without a challenge', () => {
    const { id } = openGrant(req)
    assert.deepEqual(redeemGrant(id, { challengeId: '', browserApproved: false }), { outcome: 'unapproved' })
    const r = redeemGrant(id, { challengeId: '', browserApproved: true })
    assert.equal(r.outcome === 'approved' && r.via, 'browser')
    assert.equal(getGrant(id), null)
  })

  it('deny deletes the grant whatever its state', () => {
    const { id, c } = challenged()
    assert.equal(denyGrant(id)?.redirectUri, req.redirectUri)
    assert.equal(getGrant(id), null)
    assert.equal(grantChallengeState(c.id), 'expired')
    assert.equal(denyGrant(id), null)
  })

  it('an expired challenge voids its decision; the grant can be re-challenged', () => {
    const { id, c } = challenged()
    decideGrantChallenge(c.id, 'approved')
    const raw = JSON.parse(readFileSync(storePath(), 'utf8'))
    raw.grants[id].challenge.expiresAt = Date.now() - 1
    writeFileSync(storePath(), JSON.stringify(raw))
    assert.equal(grantChallengeState(c.id), 'expired')
    assert.equal(getGrantChallenge(c.id), null)
    assert.equal(decideGrantChallenge(c.id, 'denied'), 'not_found')
    assert.deepEqual(redeemGrant(id, { challengeId: c.id, browserApproved: false }), { outcome: 'unapproved' })
    const next = challengeGrant(id)!
    assert.equal(getGrant(id)?.state, 'challenged')
    assert.equal(grantChallengeState(next.id), 'pending')
  })

  it('an expired grant is pruned on the store cadence and reads as unknown', () => {
    const { id, c } = challenged()
    const raw = JSON.parse(readFileSync(storePath(), 'utf8'))
    raw.grants[id].expiresAt = Date.now() - 1
    writeFileSync(storePath(), JSON.stringify(raw))
    assert.equal(getGrant(id), null)
    assert.equal(grantChallengeState(c.id), 'expired')
    assert.deepEqual(redeemGrant(id, { challengeId: c.id, browserApproved: true }), { outcome: 'unknown' })
    saveStore(loadStore()) // any write persists the prune
    assert.deepEqual(onDisk(), {})
  })

  it('drops the pre-grant pendingApprovals map on load', () => {
    writeFileSync(storePath(), JSON.stringify({ pendingApprovals: { bbpa_old: { tx: 'bbtx_gone', status: 'pending', expiresAt: Date.now() + 60_000 } } }))
    saveStore(loadStore())
    assert.equal('pendingApprovals' in JSON.parse(readFileSync(storePath(), 'utf8')), false)
  })

  it('caps open grants: the oldest is evicted once the cap is exceeded', () => {
    const first = openGrant(req).id
    let last = first
    for (let i = 0; i < MAX_GRANTS; i++) last = openGrant(req).id
    assert.equal(Object.keys(onDisk()).length, MAX_GRANTS)
    assert.equal(getGrant(first), null)
    assert.equal(getGrant(last)?.state, 'open')
  })
})

describe('saveStore', () => {
  it('replaces the store atomically: 0600 file, no temp file left behind', () => {
    openGrant({ clientId: 'c', redirectUri: 'https://chatgpt.com/cb', scope: ['mcp'], clientState: '', codeChallenge: 'x', resource: 'r' })
    saveStore(loadStore())
    assert.deepEqual(readdirSync(dirname(storePath())), ['store.json'])
    assert.equal(statSync(storePath()).mode & 0o777, 0o600)
  })
})
