import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HELPER = join(import.meta.dir, '../../ops/gateway-tools.py')
const dir = mkdtempSync(join(tmpdir(), 'gw-tools-'))

function run(args: string[]) {
  return Bun.spawnSync(['python3', HELPER, ...args])
}
function fixture(name: string, body: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(body))
  return p
}

const tools = [
  { name: 'beads-bridge__whoami', enabled: true },
  { name: 'beads-bridge__bead_show', enabled: true },
  { name: 'beads-bridge__off', enabled: false },
]

describe('ops/gateway-tools.py', () => {
  test('names: enabled only, prefix stripped, sorted', () => {
    const r = run(['names', fixture('a.json', tools)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim().split('\n')).toEqual(['bead_show', 'whoami'])
  })
  test('report: match exits 0', () => {
    const r = run(['report', fixture('b.json', tools), '2'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe('beads-bridge tools via gateway: 2 (live 2)')
  })
  test('report: short register exits 1', () => {
    const r = run(['report', fixture('c.json', { tools }), '46'])
    expect(r.exitCode).toBe(1)
    expect(r.stdout.toString().trim()).toBe('beads-bridge tools via gateway: 2 (live 46)')
  })
  test('unparseable reply exits 2', () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, 'not json')
    expect(run(['report', p, '1']).exitCode).toBe(2)
  })
})
