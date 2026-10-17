// YAML-style rendering + raw JSONL for /live (inbox-egkk). The renderer is the
// exact JS the page inlines (LIVE_YAML_JS); secret-shaped fixtures are built at
// runtime so no literal trips secret scanners.
// Run: FUNNEL_BASE=https://example.test bun test src/lib/live-yaml.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LIVE_YAML_JS, LIVE_YAML_LONG } from './live-yaml'
import { displayArgs, redactString } from './redact'

const lib = new Function(
  `${LIVE_YAML_JS}; return { yamlHtml, rawLine, rawStream, YAML_LONG };`,
)() as {
  yamlHtml: (v: unknown, id: unknown, ctx: { expanded?: Record<string, boolean> }) => string
  rawLine: (e: unknown) => string
  rawStream: (e: unknown[]) => string
  YAML_LONG: number
}
const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const html = (v: unknown, ctx = {}) => lib.yamlHtml(v, 'e', ctx)

describe('live yaml renderer', () => {
  it('renders nested objects and arrays with indentation', () => {
    const out = text(html({ args: { id: 'task-1', opts: { deep: { n: 1 } }, list: ['a', { k: 'v', z: 2 }] } }))
    assert.equal(
      out,
      ['args:', '  id: "task-1"', '  opts:', '    deep:', '      n: 1', '  list:', '    - "a"', '    - k: "v"', '      z: 2'].join('\n'),
    )
  })

  it('classes keys, strings, numbers, booleans and null; empties inline', () => {
    const h = html({ a: 's', b: 1.5, c: true, d: null, e: [], f: {}, 'odd key': 1 })
    for (const c of ['y-k', 'y-s', 'y-n', 'y-b', 'y-null']) assert.ok(h.includes(`class="${c}"`), c)
    const t = text(h)
    assert.ok(t.includes('e: []') && t.includes('f: {}') && t.includes('"odd key": 1') && t.includes('d: null'))
  })

  it('escapes html in values and keys', () => {
    const h = html({ '<k>': '<img src=x onerror=1>' })
    assert.ok(!h.includes('<img') && !h.includes('<k>'))
  })

  it('collapses long strings with an explicit +N chars control, expandable', () => {
    const long = 'x'.repeat(LIVE_YAML_LONG + 1234)
    const h = html({ s: long })
    assert.ok(h.includes('… +1234 chars') && h.includes('data-expand="e.s"'))
    assert.ok(!text(h).includes('x'.repeat(LIVE_YAML_LONG + 1)))
    const full = html({ s: long }, { expanded: { 'e.s': true } })
    assert.ok(text(full).includes(long) && full.includes('data-collapse="e.s"') && !full.includes('+1234'))
  })

  it('raw view is one JSON line per event; stream is chronological JSONL', () => {
    const a = { seq: 2, tool: 'b', args: '{"x":1}' }
    const b = { seq: 1, tool: 'a' }
    assert.equal(lib.rawLine(a), JSON.stringify(a))
    const lines = lib.rawStream([a, b]).split('\n')
    assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [1, 2])
  })

  it('secret-shaped values never reach the rendered or raw view once redacted', () => {
    const bearer = ['Bea', 'rer ', 'abcdefgh', '12345678'].join('')
    const ghp = ['gh', 'p_', 'A'.repeat(24)].join('')
    const args = { token: 'hunter2hunter2', note: `see ${bearer} and ${ghp}`, nested: { password: 'p', ok: 'fine' } }
    const shown = displayArgs(args, 5000)
    const ev = { seq: 1, tool: 't', args: shown.text, summary: redactString(`got ${ghp}`) }
    const rendered = text(html({ args: JSON.parse(shown.text) })) + text(html({ summary: ev.summary }))
    for (const bad of ['hunter2', 'abcdefgh12345678', ghp]) {
      assert.ok(!rendered.includes(bad) && !lib.rawLine(ev).includes(bad), `leaked ${bad.slice(0, 4)}`)
    }
    assert.ok(rendered.includes('[redacted]') && rendered.includes('ok: "fine"'))
  })
})
