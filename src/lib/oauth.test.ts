// Unit tests: bun test src/lib/oauth.test.ts (node:test, no new deps).
// Store tests point OAUTH_STORE_PATH at a temp dir — never the real one.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAuthorizationServerMetadata,
  consumeCode,
  lookupAccess,
  mintCode,
  mintTokenPair,
  mcpResource,
  normalizeResource,
  parseScope,
  pkceChallenge,
  redirectMatches,
  rotateRefresh,
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
