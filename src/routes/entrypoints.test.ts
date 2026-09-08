// Entry-point contract: every page an agent can start from carries the
// durable-object convention — either the content itself or a fetchable URL.
// These tests read the served-source files (templates + route code), which
// ARE the pages modulo placeholder fills covered by sections.test.ts.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const src = (p: string) => readFileSync(join(root, p), 'utf8')
const blurb = (p: string) => readFileSync(join(root, 'blurbs', p), 'utf8')

describe('durable object format (action-object.md)', () => {
  const md = blurb('action-object.md')
  it('requires all 10 sections', () => {
    for (const s of ['Action:', 'Target:', 'Source:', 'Status:', 'Description:',
      'Generate bullets', 'External action', 'Feedback required',
      'Completion condition', 'reasoning']) {
      assert.ok(md.includes(s), `missing section: ${s}`)
    }
  })
  it('mandates the exact source bead', () => {
    assert.ok(md.includes('MUST LIST EXACT SOURCE BEAD'))
  })
})

describe('GET / (prompt.md)', () => {
  it('teaches capture + missing-dependency with the format slot', () => {
    const md = src('prompt.md')
    assert.ok(md.includes('## Durable knowledge capture'))
    assert.ok(md.includes('## durable: <scope>'))
    assert.ok(md.includes('## Missing-dependency capture'))
    assert.ok(md.includes('__DURABLE_OBJECT_FORMAT__'))
  })
  it('read.ts fills the slot from action-object.md', () => {
    const code = src('src/routes/read.ts')
    assert.ok(code.includes('__DURABLE_OBJECT_FORMAT__'))
    assert.ok(code.includes('action-object.md'))
  })
})

describe('blurb entry point (/resume/:id)', () => {
  it('template carries the convention placeholder', () => {
    assert.ok(blurb('resume-session.md').includes('{{DURABLE_EMIT}}'))
  })
  it('route fills it from the shared section', () => {
    const code = src('src/routes/resume-blurb.ts')
    assert.ok(code.includes('{{DURABLE_EMIT}}'))
    assert.ok(code.includes("readSection('durable-emit')"))
  })
})

describe('fetch index entry point (/fetch/:id)', () => {
  it('template carries the convention placeholder', () => {
    assert.ok(blurb('resume-index.md').includes('{{DURABLE_EMIT}}'))
  })
  it('route fills it from the shared section', () => {
    const code = src('src/routes/resume.ts')
    assert.ok(code.includes('{{DURABLE_EMIT}}'))
    assert.ok(code.includes("readSection('durable-emit')"))
  })
})

describe('/help entry point', () => {
  it('includes the shared section', () => {
    assert.ok(src('src/routes/read.ts').includes("readSection('durable-emit')"))
  })
})

describe('/guide entry point', () => {
  it('registers the format as a fetchable URL', () => {
    const code = src('src/routes/guide.ts')
    assert.ok(code.includes("'durable-object'"))
    assert.ok(code.includes('action-object.md'))
  })
})

describe('shared section (single source)', () => {
  it('durable-emit.md teaches the envelope with frontmatter vars', () => {
    const md = blurb('sections/durable-emit.md')
    assert.ok(md.includes('## durable: <scope>'))
    assert.ok(md.includes('vars:'))
  })
})
