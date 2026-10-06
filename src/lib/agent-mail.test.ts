// Unit tests: pure presence helpers only (no pilot I/O — live coverage
// needs AGENT_MAIL_LIVE=1, see below).
// FUNNEL_BASE=https://example.test bun test src/lib/agent-mail.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_MAIL_UPSTREAM,
  classifyWhoisError,
  formatPresence,
  parsePilotTs,
  verdictFromProfile,
} from './agent-mail'

describe('agent-mail upstream pin', () => {
  it('stays loopback — never off-host', () => {
    assert.equal(AGENT_MAIL_UPSTREAM, 'http://127.0.0.1:18765/mcp/')
  })
})

describe('parsePilotTs', () => {
  it('parses SQLite-naive UTC datetimes', () => {
    const ms = parsePilotTs('2026-09-25 22:19:27.429687')
    assert.ok(typeof ms === 'number')
    assert.equal(new Date(ms as number).toISOString(), '2026-09-25T22:19:27.429Z')
  })
  it('rejects garbage', () => {
    assert.equal(parsePilotTs('yesterday'), null)
    assert.equal(parsePilotTs(123), null)
    assert.equal(parsePilotTs(''), null)
  })
})

describe('classifyWhoisError', () => {
  it('token-gated reads are credentialed, never existence claims', () => {
    assert.equal(
      classifyWhoisError("Error calling tool 'whois': whois requires registration_token for agent 'x'"),
      'credentialed',
    )
  })
  it('anything else is unknown', () => {
    assert.equal(classifyWhoisError("Agent 'nope' not found in project 'p'."), 'unknown')
  })
})

describe('verdictFromProfile', () => {
  const NOW = Date.parse('2026-10-05T16:00:00Z')
  it('retired_at set means retired regardless of activity', () => {
    const v = verdictFromProfile({ retired_at: '2026-09-26 22:52:40', last_active_ts: '2026-10-05 15:59:00' }, NOW, 15 * 60 * 1000)
    assert.equal(v.status, 'retired')
  })
  it('fresh last_active means active', () => {
    const v = verdictFromProfile({ last_active_ts: '2026-10-05 15:55:00', contact_policy: 'auto' }, NOW, 15 * 60 * 1000)
    assert.equal(v.status, 'active')
    assert.equal(v.contactPolicy, 'auto')
    assert.ok((v.ageMs ?? -1) >= 0 && (v.ageMs ?? -1) <= 15 * 60 * 1000)
  })
  it('old last_active means stale', () => {
    const v = verdictFromProfile({ last_active_ts: '2026-09-25 22:19:27' }, NOW, 15 * 60 * 1000)
    assert.equal(v.status, 'stale')
  })
  it('missing timestamp degrades to stale, never active', () => {
    const v = verdictFromProfile({}, NOW, 15 * 60 * 1000)
    assert.equal(v.status, 'stale')
  })
})

describe('formatPresence', () => {
  it('renders the full readout without leaking the token', () => {
    const text = formatPresence({
      status: 'active', agent: 'worker_42', project: 'relays',
      lastActive: '2026-10-05 15:55:00', ageMs: 5 * 60 * 1000,
      contactPolicy: 'auto', unread: 3, unreadTruncated: false,
      note: 'home and draining mail.',
    })
    assert.match(text, /worker_42 @ relays/)
    assert.match(text, /status: active/)
    assert.match(text, /unread inbox: 3/)
    assert.ok(!text.includes('tok'), 'no token material in output')
  })
  it('renders credentialed without an existence claim', () => {
    const text = formatPresence({ status: 'credentialed', agent: 'x', project: 'p', note: 'Supply the token. No existence claim.' })
    assert.match(text, /status: credentialed/)
    assert.ok(!/exists|registered/i.test(text.split('\n').slice(0, 4).join(' ')), 'header must not claim existence')
  })
})
