// PostHog usage tracking for server actions. Privacy-clean by design:
// no IPs, no query strings, no raw user-agents, no person profiles
// ($process_person_profile: false, static service distinct id).
// Zero-config safe: without POSTHOG_KEY every call is a no-op, so tests
// and keyless dev never touch the network.
import { PostHog } from 'posthog-node'

const SERVICE_ID = 'beads-bridge-server'

let client: PostHog | null | undefined
let warned = false

function getClient(): PostHog | null {
  if (client !== undefined) return client
  const key = process.env.POSTHOG_KEY
  if (!key) {
    client = null
    return client
  }
  client = new PostHog(key, {
    host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
    flushAt: 20,
    flushInterval: 10_000,
  })
  return client
}

// Collapse a request path to a stable action name: drop the query string
// and cap segment sprawl so per-bead URLs don't explode cardinality.
export function actionName(method: string, originalUrl: string): string {
  const path = originalUrl.split('?')[0] || '/'
  const segs = path.split('/').filter(Boolean)
  if (!segs.length) return `${method} /`
  const head = segs[0]
  // Known two-segment namespaces stay specific; deeper bead-id paths collapse.
  const namespaced = new Set(['q', 'beads', 'fetch', 'resume', 'guide', 'print'])
  if (namespaced.has(head) && segs[1]) return `${method} /${head}/${segs[1].split('+')[0]}${segs.length > 2 ? '/*' : ''}`
  if (segs.length > 1) return `${method} /${head}/*`
  return `${method} /${head}`
}

export interface ActionHit {
  method: string
  originalUrl: string
  status: number
  ms: number
  /** Coarse client class from the access gate — never a raw UA or IP. */
  client: string
}

export function trackAction(hit: ActionHit): void {
  try {
    const ph = getClient()
    if (!ph) return
    const cls = Math.floor(hit.status / 100)
    ph.capture({
      distinctId: SERVICE_ID,
      event: 'server action',
      properties: {
        $process_person_profile: false,
        method: hit.method,
        action: actionName(hit.method, hit.originalUrl),
        status: hit.status,
        status_class: `${cls}xx`,
        latency_ms: hit.ms,
        client: hit.client,
      },
    })
  } catch {
    if (!warned) {
      warned = true
      console.log('posthog track failed (continuing without analytics)')
    }
  }
}

export async function shutdownAnalytics(): Promise<void> {
  try {
    await client?.shutdown()
  } catch { /* best effort on exit */ }
  client = undefined
}

// Test seam: forget the cached client so env changes take effect.
export function resetAnalyticsForTests(): void {
  client = undefined
  warned = false
}
