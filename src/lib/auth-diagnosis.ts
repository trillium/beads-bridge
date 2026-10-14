// Truthful 401 text for the OAuth-gated MCP doors.
//
// mcp-handler's withMcpAuth answers every rejected credential with the fixed
// description "No authorization provided" — false when a token WAS sent, and
// silent about the fix. This wrapper keeps the library's answer (401, the
// Bearer challenge with resource_metadata, error="invalid_token") byte-for-byte
// and rewrites only the error_description, in the header and the JSON body, so
// a client can tell the user to re-authenticate. Contract: docs/auth-boundary.md.
//
// Diagnosis is for wording only; the library's verdict is never overridden, and
// no token value is logged or echoed.
import { accessTokenState } from './oauth'

export type CredentialFailure = 'missing' | 'malformed' | 'unknown' | 'expired' | 'wrong-audience'

const REAUTH = 'Re-authenticate (reconnect and authorize this connector again) to get a new token.'

export const CREDENTIAL_DESCRIPTIONS: Record<CredentialFailure, string> = {
  missing: 'No authorization provided: send an Authorization: Bearer access token.',
  malformed: `Authorization is present but is not a valid bridge access token (malformed). ${REAUTH}`,
  unknown: `Access token is invalid: not recognized by this bridge (never issued, revoked, or removed). ${REAUTH}`,
  expired: `Access token has expired. ${REAUTH}`,
  'wrong-audience': `Access token is valid but was issued for a different endpoint than this one. ${REAUTH}`,
}

// Minted shape: bb_at_ + base64url. Length is deliberately not pinned.
const WELL_FORMED = /^bb_at_[A-Za-z0-9_-]+$/

/** Classify a request the gate already rejected. Wording only, never authorization. */
export function diagnoseCredential(authHeader: string | null): CredentialFailure {
  if (authHeader === null || authHeader.trim() === '') return 'missing'
  const [type, token] = authHeader.trim().split(/\s+/)
  if (type?.toLowerCase() !== 'bearer' || !token || !WELL_FORMED.test(token)) return 'malformed'
  const state = accessTokenState(token)
  if (state === 'expired') return 'expired'
  if (state === 'live') return 'wrong-audience' // the gate refused a record that exists: audience mismatch
  return 'unknown'
}

/** Wrap a withMcpAuth(required: true) handler so its 401 says what is actually wrong. */
export function withCredentialDiagnosis(gated: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    const res = await gated(req)
    if (res.status !== 401) return res
    const body = (await res.clone().json().catch(() => null)) as { error?: string; error_description?: string } | null
    if (body?.error !== 'invalid_token' || body.error_description !== 'No authorization provided') return res
    const description = CREDENTIAL_DESCRIPTIONS[diagnoseCredential(req.headers.get('authorization'))]
    const headers = new Headers(res.headers)
    const challenge = headers.get('www-authenticate')
    if (challenge) headers.set('www-authenticate', challenge.replace(/error_description="[^"]*"/, `error_description="${description}"`))
    headers.set('content-type', 'application/json')
    headers.delete('content-length')
    return new Response(JSON.stringify({ ...body, error_description: description }), { status: 401, headers })
  }
}
