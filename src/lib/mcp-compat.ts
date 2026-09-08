// ChatGPT-interop shim for 2026-era MCP envelopes.
//
// openai-mcp sends modern requests (protocolVersion 2026-07-28 in
// params._meta) with a SPARSE envelope — version only, no client
// capabilities/info. Our SDK validates the full envelope and 400s those.
// Our tools never branch on client capabilities, so backfilling the absent
// keys with neutral defaults is safe and keeps us interoperable.
// Pure + unit-tested; applied in mcp.ts before the SDK handler sees the body.
// SEP-2243: methods whose Mcp-Name header must mirror a body field.
const NAME_SOURCE: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}

export const META_PREFIX = 'io.modelcontextprotocol/'
export const KEY_VERSION = `${META_PREFIX}protocolVersion`
export const KEY_CAPS = `${META_PREFIX}clientCapabilities`
export const KEY_INFO = `${META_PREFIX}clientInfo`

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// Returns the fixed message (a copy when changed, the input untouched).
export function backfillModernEnvelope(msg: unknown): unknown {
  if (!isRecord(msg)) return msg
  const params = msg.params
  if (!isRecord(params)) return msg
  const meta = params._meta
  if (!isRecord(meta)) return msg
  const version = meta[KEY_VERSION]
  if (typeof version !== 'string' || !version.startsWith('2026-')) return msg
  let changed = false
  const nextMeta: Record<string, unknown> = { ...meta }
  if (!isRecord(nextMeta[KEY_CAPS])) {
    nextMeta[KEY_CAPS] = {}
    changed = true
  }
  if (!isRecord(nextMeta[KEY_INFO])) {
    nextMeta[KEY_INFO] = { name: 'unknown', version: '0' }
    changed = true
  }
  if (!changed) return msg
  return { ...msg, params: { ...params, _meta: nextMeta } }
}

// Compat entry point: backfill a sparse 2026 body AND the Mcp-Method
// header the SDK requires to agree with it. Returns the input untouched
// when there is nothing to fix. Legacy traffic is never modified.
export async function withCompatRequest(fetchReq: globalThis.Request): Promise<globalThis.Request> {
  if (fetchReq.method !== 'POST') return fetchReq
  if (!(fetchReq.headers.get('content-type') ?? '').includes('application/json')) return fetchReq
  let body: unknown
  try {
    body = await fetchReq.clone().json()
  } catch {
    return fetchReq
  }
  const fixed = backfillModernEnvelope(body)
  const method = isRecord(fixed) && typeof fixed.method === 'string' ? fixed.method : null
  const meta = isRecord(fixed) && isRecord(fixed.params) && isRecord(fixed.params._meta)
    ? (fixed.params._meta as Record<string, unknown>)
    : null
  const modern = !!meta && typeof meta[KEY_VERSION] === 'string' &&
    (meta[KEY_VERSION] as string).startsWith('2026-')
  const needMethod = modern && !!method && !fetchReq.headers.has('mcp-method')
  // Mcp-Name mirrors params.name / params.uri for the mapped methods.
  let needName: string | null = null
  if (modern && method && NAME_SOURCE[method] && !fetchReq.headers.has('mcp-name')) {
    const params = isRecord(fixed) ? fixed.params : null
    const v = isRecord(params) ? params[NAME_SOURCE[method]] : null
    if (typeof v === 'string' && v) needName = v
  }
  if (fixed === body && !needMethod && !needName) return fetchReq
  const init: RequestInit = {}
  if (fixed !== body) init.body = JSON.stringify(fixed)
  if (needMethod || needName) {
    const headers = new Headers(fetchReq.headers)
    if (needMethod) headers.set('Mcp-Method', method as string)
    if (needName) headers.set('Mcp-Name', needName)
    init.headers = headers
  }
  return new globalThis.Request(fetchReq, init)
}
