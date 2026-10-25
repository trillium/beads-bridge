// FUNNEL_BASE not needed: bun test src/lib/qr.test.ts
// Parity: the module matrices below were produced by displayd's vendored
// Python generator (renderers/_qrcodegen.py) at ECC MEDIUM; each entry pins
// version, mask, boosted ECC ordinal and sha256 of the row-major "0"/"1" grid
// (rows joined by \n). Inputs are byte-mode (the Python picks the same mode).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DataTooLongError, QrCode, qrSvg } from './qr'

const ORD = { LOW: 0, MEDIUM: 1, QUARTILE: 2, HIGH: 3 } as const
const grid = (qr: QrCode): string =>
  Array.from({ length: qr.size }, (_, y) => Array.from({ length: qr.size }, (_, x) => (qr.getModule(x, y) ? '1' : '0')).join('')).join('\n')

const CASES: { text: string; version: number; mask: number; ecc: number; sha: string }[] = [
  { text: 'hello', version: 1, mask: 6, ecc: 3, sha: '69eec149521d0daf8dd3263acf22740ee26b4a844714a559cabedbf5de3f1bad' },
  { text: 'http://100.64.1.2:3738/oauth/approve/bbpa_AbCdEfGhIjKlMnOpQrStUvWx', version: 5, mask: 2, ecc: 1, sha: 'a4b96d1240dab7675cdf3403fb7e0dfb1a806823f11d0e154919e97909364c26' },
  { text: 'x'.repeat(300) + 'é', version: 13, mask: 0, ecc: 1, sha: '28091fe43710f7daa31a88d1d88c896a53618eddf12ac540c21a1af71de05e42' },
  { text: 'y'.repeat(1500), version: 32, mask: 2, ecc: 1, sha: '6bb8d0348734b24e02c4bf73d7dcb037a9a894112f1b3f95efdfc7e7cd7bf1f2' },
]

describe('QrCode (port of the displayd Nayuki generator)', () => {
  for (const c of CASES) {
    it(`matches the Python reference for ${c.text.length} chars (v${c.version})`, () => {
      const qr = QrCode.encodeText(c.text)
      assert.equal(qr.version, c.version)
      assert.equal(qr.mask, c.mask)
      assert.equal(ORD[qr.ecc], c.ecc)
      assert.equal(qr.size, c.version * 4 + 17)
      assert.equal(createHash('sha256').update(grid(qr)).digest('hex'), c.sha)
    })
  }

  it('refuses a payload beyond version-40 capacity instead of drawing a smear', () => {
    assert.throws(() => QrCode.encodeText('z'.repeat(5000)), DataTooLongError)
  })
})

describe('qrSvg', () => {
  it('is a self-contained inline SVG with a 4-module quiet zone, black on white', () => {
    const svg = qrSvg('hello')
    assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29"/) // v1 = 21 modules + 2*4
    assert.match(svg, /fill="#fff"/)
    assert.match(svg, /fill="#000"/)
    assert.doesNotMatch(svg, /<script|href=/i)
    // top-left finder corner sits inside the quiet zone: module (0,0) → (4,4)
    assert.ok(svg.includes('M4,4h1v1h-1z'))
    assert.ok(!svg.includes('M0,0h1v1h-1z'))
  })
})
