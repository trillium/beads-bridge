// Agent-mail presence over the loopback pilot (mcp_agent_mail serve-http).
//
// A persistent way to contact a specific agent resolves to three questions:
// who is it (stable registered name), are they home (liveness), and did it
// land (receipt). This module answers the first two; sending stays on the
// pilot's send_message. Reads only — never registers, retires, or sends.
//
// Auth shape (pilot-enforced, not ours): agent profiles are
// registration_token-gated. Without the target's token we report
// `credentialed` with the handshake guidance and assert NOTHING about
// existence — the pilot's own error texts differ between missing and gated,
// and we refuse to turn that into an existence oracle.
//
// Upstream is a loopback const, never configurable off-loopback (same pin
// as JUNGLE_UPSTREAM / CHATGPT_UPSTREAM).
// Live tests need the pilot (port 18765) and run only with AGENT_MAIL_LIVE=1.

export const AGENT_MAIL_UPSTREAM = 'http://127.0.0.1:18765/mcp/'

export function staleAfterMs(): number {
  const n = Number(process.env.AGENT_MAIL_STALE_AFTER_MS)
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000
}

interface PilotOk {
  ok: true
  text: string
}

interface PilotErr {
  ok: false
  error: string
}

function pilotErrorText(json: unknown): string | null {
  // tools/call result: { content: [{ type: 'text', text }], isError? }
  if (typeof json !== 'object' || json === null) return null
  const r = (json as Record<string, unknown>).result as Record<string, unknown> | undefined
  const content = r?.content
  if (!Array.isArray(content)) return null
  const first = content[0] as Record<string, unknown> | undefined
  const text = first?.text
  if (typeof text !== 'string') return null
  const isError = (r as Record<string, unknown>).isError === true
  return isError || /^error\b/i.test(text.trim()) ? text : null
}

function pilotText(json: unknown): string {
  if (typeof json !== 'object' || json === null) return ''
  const r = (json as Record<string, unknown>).result as Record<string, unknown> | undefined
  const content = r?.content
  const parts: string[] = []
  if (Array.isArray(content)) {
    for (const c of content) {
      const t = (c as Record<string, unknown>)?.text
      if (typeof t === 'string') parts.push(t)
    }
  }
  // FastMCP answers data-only calls (e.g. fetch_inbox) with empty content
  // and the payload under structuredContent — fall back to that.
  if (!parts.length && r && typeof r.structuredContent !== 'undefined') {
    try { parts.push(JSON.stringify(r.structuredContent)) } catch { /* fall through */ }
  }
  return parts.join('\n')
}

/** One pilot tools/call over a fresh session. Never throws transport-safe: throws only with a message. */
export async function pilotCall(tool: string, args: Record<string, unknown>, timeoutMs = 15000): Promise<PilotOk | PilotErr> {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const post = async (body: unknown, sessionId?: string): Promise<{ status: number; headers: Headers; json: unknown }> => {
    const h: Record<string, string> = { ...headers }
    if (sessionId) h['mcp-session-id'] = sessionId
    const res = await fetch(AGENT_MAIL_UPSTREAM, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json: unknown = null
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      try { json = JSON.parse(text) } catch { json = null }
    } else {
      const line = text.split('\n').find((l) => l.startsWith('data:'))
      try { json = line ? JSON.parse(line.slice(5).trim()) : null } catch { json = null }
    }
    return { status: res.status, headers: res.headers, json }
  }
  let init: { status: number; headers: Headers; json: unknown }
  try {
    init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'beads-bridge', version: 'agent-presence' } } })
  } catch (e) {
    throw new Error(`agent mail unreachable at ${AGENT_MAIL_UPSTREAM}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (init.status !== 200 || !init.json) throw new Error(`agent mail initialize failed: HTTP ${init.status}`)
  const sessionId = init.headers.get('mcp-session-id') ?? undefined
  const called = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }, sessionId)
  if (called.status !== 200 || !called.json) throw new Error(`agent mail ${tool} failed: HTTP ${called.status}`)
  const errText = pilotErrorText(called.json)
  if (errText) return { ok: false, error: errText }
  return { ok: true, text: pilotText(called.json) }
}

export type PresenceStatus = 'active' | 'stale' | 'retired' | 'credentialed' | 'unknown'

export interface Presence {
  status: PresenceStatus
  agent: string
  project: string
  lastActive?: string
  ageMs?: number
  retiredAt?: string
  contactPolicy?: string
  unread?: number
  unreadTruncated?: boolean
  note: string
}

/** SQLite-naive UTC ('YYYY-MM-DD HH:MM:SS.ffffff') → ms epoch. Null on garbage. */
export function parsePilotTs(ts: unknown): number | null {
  if (typeof ts !== 'string') return null
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/)
  if (!m) return null
  const frac = (m[7] ?? '.000').slice(1).padEnd(3, '0').slice(0, 3)
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${frac}Z`)
  return Number.isFinite(ms) ? ms : null
}

function tryProfile(text: string): Record<string, unknown> | null {
  try {
    const d = JSON.parse(text) as unknown
    return typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function classifyWhoisError(error: string): 'credentialed' | 'unknown' {
  if (/registration_token/i.test(error)) return 'credentialed'
  return 'unknown'
}

export function verdictFromProfile(profile: Record<string, unknown>, now = Date.now(), staleMs = staleAfterMs()): { status: 'active' | 'stale' | 'retired'; lastActive?: string; ageMs?: number; retiredAt?: string; contactPolicy?: string } {
  // The pilot omits null fields (verified live: no retired_at /
  // contact_policy keys on an active profile), so absent retired_at means
  // not-retired. A retired agent's last_active still ages out to stale,
  // which stays directionally correct (no live reader).
  const retiredAt = typeof profile.retired_at === 'string' && profile.retired_at ? profile.retired_at : undefined
  if (retiredAt) return { status: 'retired', retiredAt }
  const lastActive = typeof profile.last_active_ts === 'string' ? profile.last_active_ts : undefined
  const contactPolicy = typeof profile.contact_policy === 'string' ? profile.contact_policy : undefined
  const at = lastActive ? parsePilotTs(lastActive) : null
  if (at === null) return { status: 'stale', lastActive, contactPolicy }
  const ageMs = now - at
  return ageMs <= staleMs
    ? { status: 'active', lastActive, ageMs, contactPolicy }
    : { status: 'stale', lastActive, ageMs, contactPolicy }
}

function unreadFromInbox(text: string, limit: number): { unread: number; truncated: boolean } | null {
  try {
    const d = JSON.parse(text) as unknown
    const rec = (typeof d === 'object' && d !== null && !Array.isArray(d) ? d : {}) as Record<string, unknown>
    const rows = Array.isArray(d) ? d : Array.isArray(rec.messages) ? rec.messages : Array.isArray(rec.result) ? rec.result : null
    if (!Array.isArray(rows)) return null
    return { unread: rows.length, truncated: rows.length >= limit }
  } catch {
    return null
  }
}

export interface PresenceInput {
  project: string
  agent: string
  registrationToken?: string
}

/** Presence for one agent: whois profile + unread inbox depth. Reads only. Throws on transport failure. */
export async function agentPresence(input: PresenceInput, now = Date.now()): Promise<Presence> {
  const project = input.project.trim()
  const agent = input.agent.trim()
  if (!project || !agent) throw new Error('agent_presence: empty project or agent')
  const token = input.registrationToken?.trim() || undefined
  const whoisArgs: Record<string, unknown> = { project_key: project, agent_name: agent, include_recent_commits: false }
  if (token) whoisArgs.registration_token = token
  const whois = await pilotCall('whois', whoisArgs)
  if (!whois.ok) {
    const status = classifyWhoisError(whois.error)
    return {
      status, agent, project,
      note: status === 'credentialed'
        ? 'Agent-mail profiles are registration_token-gated. Supply the agent\u2019s registration_token (shared out-of-band or via the request_contact handshake) for a full presence readout. No existence claim is made without it.'
        : `No agent '${agent}' in project '${project}' (pilot: ${whois.error.slice(0, 160)})`,
    }
  }
  const profile = tryProfile(whois.text)
  if (!profile) {
    return { status: 'unknown', agent, project, note: `Unparseable whois payload: ${whois.text.slice(0, 160)}` }
  }
  const v = verdictFromProfile(profile, now)
  let unread: number | undefined
  let unreadTruncated: boolean | undefined
  let inboxNote = ''
  if (token && v.status !== 'retired') {
    try {
      const inbox = await pilotCall('fetch_inbox', {
        project_key: project, agent_name: agent, registration_token: token,
        unread_only: true, include_bodies: false, limit: 50,
      })
      if (inbox.ok) {
        const u = unreadFromInbox(inbox.text, 50)
        if (u) { unread = u.unread; unreadTruncated = u.truncated }
      } else {
        inboxNote = ` Inbox depth unavailable: ${inbox.error.slice(0, 120)}`
      }
    } catch (e) {
      inboxNote = ` Inbox depth unavailable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 140)
    }
  }
  const age = v.ageMs !== undefined ? ` (${ageStr(v.ageMs)} ago)` : ''
  const note =
    v.status === 'active' ? `Last active ${v.lastActive ?? 'unknown'}${age} — home and draining mail.` + inboxNote :
    v.status === 'stale' ? `Last active ${v.lastActive ?? 'never recorded'}${age} — may not be running; mail persists but nobody may read it soon.` + inboxNote :
    `Retired ${v.retiredAt} — mail persists, no active reader. Unretire before expecting replies.`
  return {
    status: v.status, agent, project,
    lastActive: v.lastActive, ageMs: v.ageMs, retiredAt: v.retiredAt,
    contactPolicy: v.contactPolicy, unread, unreadTruncated, note,
  }
}

function ageStr(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function formatPresence(p: Presence): string {
  const head = `# agent presence — ${p.agent} @ ${p.project}`
  const rows = [
    `status: ${p.status}`,
    ...(p.lastActive ? [`last active: ${p.lastActive}${p.ageMs !== undefined ? ` (${ageStr(p.ageMs)} ago)` : ''}`] : []),
    ...(p.retiredAt ? [`retired: ${p.retiredAt}`] : []),
    ...(p.contactPolicy ? [`contact policy: ${p.contactPolicy}`] : []),
    ...(p.unread !== undefined ? [`unread inbox: ${p.unread}${p.unreadTruncated ? '+' : ''}`] : []),
  ]
  return [head, '', ...rows, '', p.note].join('\n')
}
