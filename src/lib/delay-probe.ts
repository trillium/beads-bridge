// Delay probe: controllable-latency MCP tool core for the inbox-z55u
// timeout experiment. Pure logic + injectable sleep live here so the MCP
// route stays a thin wrapper; no shell, no stores, no side effects.
export const MAX_DELAY_SECONDS = 300
export const MIN_DELAY_SECONDS = 0
export const MAX_CORRELATION_ID_LEN = 128

export interface DelayProbeInput {
  delaySeconds: number
  correlationId?: string
}

export interface DelayProbeResult {
  correlationId: string
  requestedDelaySeconds: number
  actualDelayMs: number
  startedAt: string
  finishedAt: string
}

export function validateDelaySeconds(v: unknown): { ok: true; delay: number } | { ok: false; error: string } {
  if (typeof v !== 'number' || !Number.isFinite(v))
    return { ok: false, error: 'delay_seconds must be a finite number.' }
  if (v < MIN_DELAY_SECONDS)
    return { ok: false, error: `delay_seconds must be >= ${MIN_DELAY_SECONDS}.` }
  if (v > MAX_DELAY_SECONDS)
    return { ok: false, error: `delay_seconds capped at ${MAX_DELAY_SECONDS}s (got ${v}).` }
  return { ok: true, delay: v }
}

export function validateCorrelationId(v: unknown): { ok: true; id: string } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, id: mintCorrelationId() }
  if (typeof v !== 'string') return { ok: false, error: 'correlation_id must be a string.' }
  const t = v.trim()
  if (!t) return { ok: true, id: mintCorrelationId() }
  if (t.length > MAX_CORRELATION_ID_LEN)
    return { ok: false, error: `correlation_id max ${MAX_CORRELATION_ID_LEN} chars (got ${t.length}).` }
  return { ok: true, id: t }
}

export function mintCorrelationId(): string {
  return `probe-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function runDelayProbe(
  input: DelayProbeInput,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<DelayProbeResult> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  await sleep(input.delaySeconds * 1000)
  const actualDelayMs = Date.now() - t0
  return {
    correlationId: input.correlationId ?? mintCorrelationId(),
    requestedDelaySeconds: input.delaySeconds,
    actualDelayMs,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}

export function formatProbeResult(r: DelayProbeResult): string {
  return [
    `# delay probe`,
    ``,
    `correlation_id: ${r.correlationId}`,
    `requested_delay_s: ${r.requestedDelaySeconds}`,
    `actual_delay_ms: ${r.actualDelayMs}`,
    `started_at: ${r.startedAt}`,
    `finished_at: ${r.finishedAt}`,
  ].join('\n')
}
