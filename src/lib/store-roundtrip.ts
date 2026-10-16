// Store round-trip proof (feedback k3az): read a known record, then create a
// test bead, read it back and close it — all through the same store CLI the
// MCP read/write paths use. Refuses (writes nothing) when the store's CLI is
// not at its authoritative location; the test bead is closed even when a
// later step fails.
import { createBead } from './create'
import { execStdout } from './exec'
import { closeBead } from './mutate'
import { BLOCKING_STATUSES, guardDisabled, probeStore, registryPathFor, type StoreProbe } from './store-health'

// Stores whose `create` wrapper emits a dispatch event: a test bead there
// would wake real handlers, so no automatic round-trip.
export const ROUNDTRIP_REFUSED_STORES = ['inbox']

export interface RoundTripStep {
  step: string
  command: string
  ok: boolean
  detail: string
}

export interface RoundTripResult {
  store: string
  probe: StoreProbe
  ok: boolean
  testBeadId?: string
  steps: RoundTripStep[]
}

export async function storeRoundTrip(store: string, opts: { write?: boolean } = {}): Promise<RoundTripResult> {
  const probe = await probeStore(store, { force: true, registryPath: registryPathFor(store) })
  const steps: RoundTripStep[] = [{ step: 'identify', command: probe.command, ok: probe.status === 'ok' || (guardDisabled() && BLOCKING_STATUSES.includes(probe.status)), detail: `${probe.status}: ${probe.path ?? probe.detail}` }]
  const done = (ok: boolean, testBeadId?: string): RoundTripResult => ({ store, probe, ok, testBeadId, steps })
  // Guard off (tests/ops override): the identity probe is informational only.
  if ((BLOCKING_STATUSES.includes(probe.status) && !guardDisabled()) || probe.status === 'unreachable') return done(false)

  const step = async <T>(name: string, command: string, fn: () => Promise<{ detail: string; value?: T }>): Promise<T | undefined> => {
    try {
      const r = await fn()
      steps.push({ step: name, command, ok: true, detail: r.detail })
      return r.value
    } catch (e) {
      steps.push({ step: name, command, ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
      return undefined
    }
  }

  const known = await step<string>('read known record', `${store} list --json --limit 1`, async () => {
    const rows: unknown = JSON.parse((await execStdout(store, ['list', '--json', '--limit', '1'], 20000)) || '[]')
    const id = Array.isArray(rows) && typeof (rows[0] as { id?: unknown })?.id === 'string' ? (rows[0] as { id: string }).id : undefined
    if (!id) throw new Error('store returned no records to read')
    const shown = await execStdout(store, ['show', id], 10000)
    if (!shown) throw new Error(`${id} did not read back`)
    return { detail: `${id} read back (${shown.split('\n')[0].slice(0, 100)})`, value: id }
  })
  if (!known || !opts.write) return done(!!known && !steps.some((s) => !s.ok))
  if (ROUNDTRIP_REFUSED_STORES.includes(store)) {
    steps.push({ step: 'create test bead', command: `${store} create`, ok: false, detail: `refused: ${store} create emits dispatch events; use another store` })
    return done(false)
  }

  const testId = await step<string>('create test bead', `${store} create`, async () => {
    const c = await createBead({ store, title: '[bridge-roundtrip] store_health test — safe to ignore', description: 'Created and closed by the bridge store_health round-trip check.', labels: ['bridge-roundtrip'] })
    if (!c.verified) throw new Error(`${c.id} created but did not read back`)
    return { detail: `${c.id} created and read back`, value: c.id }
  })
  if (testId) {
    await step('close test bead', `${store} close ${testId}`, async () => {
      const r = await closeBead(store, testId)
      if (!r.verified) throw new Error(`${testId} closed but did not read back`)
      return { detail: `${testId} closed and read back` }
    })
  }
  return done(steps.every((s) => s.ok), testId)
}

export function formatRoundTrip(r: RoundTripResult): string {
  return [
    `# store round-trip: ${r.store} — ${r.ok ? 'PASS' : 'FAIL'}`,
    `resolved: ${r.probe.path ?? '(none)'} [${r.probe.status}]${r.probe.prefix ? ` prefix=${r.probe.prefix}` : ''}`,
    ``,
    ...r.steps.map((s, i) => `${i + 1}. ${s.ok ? 'ok  ' : 'FAIL'} ${s.step} — \`${s.command}\` — ${s.detail}`),
  ].join('\n')
}
