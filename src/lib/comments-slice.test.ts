// Unit and integration tests for byte-range comment reads (task-ap93d):
// FUNNEL_BASE=https://example.test bun test src/lib/comments-slice.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sliceCommentText, readBeadCommentsSlice } from './comments-slice'
import { findWildcard, invokeWildcard, searchWildcards } from './wildcard'

const CTX = { caller: 'test-caller' }

describe('sliceCommentText unit tests', () => {
  const sample = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n'
  const sampleBytes = Buffer.byteLength(sample, 'utf8')

  it('returns the entire text when offset and limit are omitted', () => {
    const r = sliceCommentText(sample)
    assert.equal(r.text, sample)
    assert.equal(r.total_bytes, sampleBytes)
    assert.equal(r.next_offset, null)
    assert.equal(r.truncated, false)
  })

  it('slices by byte offset and limit', () => {
    const r = sliceCommentText(sample, 0, 10)
    assert.equal(Buffer.byteLength(r.text, 'utf8'), 10)
    assert.equal(r.next_offset, 10)
    assert.equal(r.total_bytes, sampleBytes)
    assert.equal(r.truncated, true)

    const r2 = sliceCommentText(sample, 10, 10)
    assert.equal(Buffer.byteLength(r2.text, 'utf8'), 10)
    assert.equal(r2.next_offset, 20)
    assert.equal(r2.truncated, true)

    const r3 = sliceCommentText(sample, 20)
    assert.equal(Buffer.byteLength(r3.text, 'utf8'), sampleBytes - 20)
    assert.equal(r3.next_offset, null)
    assert.equal(r3.truncated, false)

    // Recombined text matches original
    assert.equal(r.text + r2.text + r3.text, sample)
  })

  it('handles offset beyond total_bytes gracefully', () => {
    const r = sliceCommentText(sample, 500)
    assert.equal(r.text, '')
    assert.equal(r.next_offset, null)
    assert.equal(r.total_bytes, sampleBytes)
    assert.equal(r.truncated, false)
  })

  it('does not split multi-byte UTF-8 sequences', () => {
    // '🎉' is 4 bytes: F0 9F 8E 89
    const unicodeText = 'abc🎉def'
    const buf = Buffer.from(unicodeText, 'utf8')
    assert.equal(buf.length, 10) // 3 + 4 + 3

    // Requesting limit 5 would split the emoji at byte 5 (2 bytes into the 4-byte emoji)
    // adjustToUtf8Boundary should back up to byte 3
    const r = sliceCommentText(unicodeText, 0, 5)
    assert.equal(r.text, 'abc')
    assert.equal(r.next_offset, 3)
    assert.equal(r.truncated, true)

    // Next slice starting at 3 with limit 5 should capture the emoji (3..7) + 'd' (7..8)
    const r2 = sliceCommentText(unicodeText, r.next_offset!, 5)
    assert.equal(r2.text, '🎉d')
    assert.equal(r2.next_offset, 8)
    assert.equal(r2.truncated, true)

    const r3 = sliceCommentText(unicodeText, r2.next_offset!)
    assert.equal(r3.text, 'ef')
    assert.equal(r3.next_offset, null)
    assert.equal(r3.truncated, false)

    assert.equal(r.text + r2.text + r3.text, unicodeText)
  })
})

describe('regression fixture: comments >20KB', () => {
  it('reads a >20KB comment fixture in bounded slices and loops to completion without loss', () => {
    // Construct a >20KB comment payload (25KB of structured poke log lines)
    let fixture = 'Comments on test-large:\n\n'
    let entryIndex = 1
    while (Buffer.byteLength(fixture, 'utf8') < 25000) {
      fixture += `[Tester] at 2026-10-18 0${(entryIndex % 9) + 1}:00\n  poke #${entryIndex}: verifying high-volume poke log payload slicing integrity\n\n`
      entryIndex++
    }
    const totalBytes = Buffer.byteLength(fixture, 'utf8')
    assert.ok(totalBytes > 20000, `fixture must exceed 20KB, got ${totalBytes}`)

    // Slice in 4KB chunks
    const chunkSize = 4096
    const chunks: string[] = []
    let currentOffset = 0

    while (true) {
      const slice = sliceCommentText(fixture, currentOffset, chunkSize)
      assert.equal(slice.total_bytes, totalBytes)
      chunks.push(slice.text)

      if (!slice.truncated || slice.next_offset === null) {
        assert.equal(slice.truncated, false)
        assert.equal(slice.next_offset, null)
        break
      }
      assert.equal(slice.truncated, true)
      assert.ok(slice.next_offset > currentOffset)
      currentOffset = slice.next_offset
    }

    const reconstructed = chunks.join('')
    assert.equal(Buffer.byteLength(reconstructed, 'utf8'), totalBytes)
    assert.equal(reconstructed, fixture)
  })
})

describe('status-kdv real bead acceptance', () => {
  it('reads byte 20,000 through end of status-kdv without loss or re-truncation', async () => {
    const r = await readBeadCommentsSlice('status-kdv', 20000)
    assert.equal(r.ok, true)
    if (!r.ok) return

    assert.ok(r.result.total_bytes > 20000, `status-kdv total_bytes should exceed 20,000, got ${r.result.total_bytes}`)
    assert.equal(r.result.truncated, false, 'unbounded limit through end must not be truncated')
    assert.equal(r.result.next_offset, null, 'reaching end must yield null next_offset')
    assert.equal(Buffer.byteLength(r.result.text, 'utf8'), r.result.total_bytes - 20000)
  })

  it('loops over status-kdv in 16KB slices to completion and reconstructs the full comment text', async () => {
    const full = await readBeadCommentsSlice('status-kdv')
    assert.equal(full.ok, true)
    if (!full.ok) return

    let offset = 0
    const limit = 16000
    const parts: string[] = []

    while (true) {
      const page = await readBeadCommentsSlice('status-kdv', offset, limit)
      assert.equal(page.ok, true)
      if (!page.ok) break
      parts.push(page.result.text)

      if (!page.result.truncated || page.result.next_offset === null) {
        assert.equal(page.result.truncated, false)
        assert.equal(page.result.next_offset, null)
        break
      }
      assert.equal(page.result.truncated, true)
      assert.ok(page.result.next_offset > offset)
      offset = page.result.next_offset
    }

    const joined = parts.join('')
    assert.equal(Buffer.byteLength(joined, 'utf8'), full.result.total_bytes)
    assert.equal(joined, full.result.text)
  })
})

describe('capability registry entry (wildcard)', () => {
  it('is advertised in capability registry as read-only with stable id bead_show and alias bead_comments', () => {
    const def = findWildcard('bead_show')
    assert.ok(def, 'bead_show must be registered in wildcard registry')
    assert.equal(def.id, 'bead_show')
    assert.equal(def.effect, 'read')
    assert.ok(def.params.some((p) => p.name === 'id' && p.required))
    assert.ok(def.params.some((p) => p.name === 'offset' && !p.required))
    assert.ok(def.params.some((p) => p.name === 'limit' && !p.required))

    // Alias lookup
    const aliasDef = findWildcard('bead_comments')
    assert.equal(aliasDef?.id, 'bead_show')

    // Registry entry documents parameters and truncation behavior it replaces
    assert.match(def.description, /20,000|truncation/i)
    assert.match(def.description, /offset|limit/i)
  })

  it('can be found via searchWildcards for pagination, slice, and truncation intents', () => {
    const hits = searchWildcards('comment pagination byte slices')
    assert.ok(hits.length > 0)
    assert.ok(hits.some((h) => h.def.id === 'bead_show'))

    const truncationHits = searchWildcards('status-kdv truncation poke log')
    assert.ok(truncationHits.length > 0)
    assert.ok(truncationHits.some((h) => h.def.id === 'bead_show'))
  })

  it('can be invoked via invokeWildcard to read bounded slices', async () => {
    const r = await invokeWildcard('bead_show', { id: 'status-kdv', offset: 20000, limit: 10000 }, CTX)
    assert.equal(r.ok, true)
    if (!r.ok) return

    assert.equal(r.effect, 'read')
    const parsed = JSON.parse(r.text)
    assert.equal(typeof parsed.text, 'string')
    assert.equal(Buffer.byteLength(parsed.text, 'utf8'), 10000)
    assert.equal(parsed.next_offset, 30000)
    assert.equal(parsed.truncated, true)
    assert.ok(parsed.total_bytes > 20000)
  })
})

describe('HTTP routes', () => {
  it('GET /{id}/comments?offset=&limit= returns JSON slice', async () => {
    const express = (await import('express')).default
    const { readRouter } = await import('../routes/read.js')
    const app = express()
    app.use(readRouter)
    let server: any
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const port = server.address().port
    const base = `http://127.0.0.1:${port}`

    try {
      const res = await fetch(`${base}/status-kdv/comments?offset=20000&limit=5000`)
      assert.equal(res.status, 200)
      assert.ok(res.headers.get('content-type')?.includes('application/json'))
      const body = await res.json()
      assert.equal(typeof body.text, 'string')
      assert.equal(Buffer.byteLength(body.text, 'utf8'), 5000)
      assert.equal(body.next_offset, 25000)
      assert.equal(body.truncated, true)
      assert.ok(body.total_bytes > 20000)

      // GET /{id}?offset= returns JSON slice
      const res2 = await fetch(`${base}/status-kdv?offset=20000`)
      assert.equal(res2.status, 200)
      assert.ok(res2.headers.get('content-type')?.includes('application/json'))
      const body2 = await res2.json()
      assert.equal(body2.truncated, false)
      assert.equal(body2.next_offset, null)
      assert.equal(Buffer.byteLength(body2.text, 'utf8'), body2.total_bytes - 20000)

      // GET /{id} without offset/limit returns plain text wrapped bead
      const res3 = await fetch(`${base}/status-kdv`)
      assert.equal(res3.status, 200)
      assert.ok(res3.headers.get('content-type')?.includes('text/plain'))
      const body3 = await res3.text()
      assert.ok(body3.includes('status-kdv'))
      assert.ok(body3.includes('Poke log'))
    } finally {
      server.close()
    }
  })
})

