// QR code generator, dependency-free. A TypeScript port of the vendored
// Nayuki QR Code generator used by displayd (renderers/_qrcodegen.py, MIT —
// Copyright (c) Project Nayuki, https://www.nayuki.io/page/qr-code-generator-library),
// trimmed to what the approval page needs: byte-mode segments (any UTF-8
// text), versions 1–40, automatic mask choice, ECC boosted while the version
// does not grow. Output is a boolean module matrix plus an inline-SVG renderer.
// Parity with the Python generator is pinned by src/lib/qr.test.ts.

export type Ecc = 'LOW' | 'MEDIUM' | 'QUARTILE' | 'HIGH'
const ECC_ORDINAL: Record<Ecc, number> = { LOW: 0, MEDIUM: 1, QUARTILE: 2, HIGH: 3 }
const ECC_FORMAT_BITS: Record<Ecc, number> = { LOW: 1, MEDIUM: 0, QUARTILE: 3, HIGH: 2 }

const MIN_VERSION = 1
const MAX_VERSION = 40
const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

// Index 0 is padding. Rows: LOW, MEDIUM, QUARTILE, HIGH.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

const MASKS: ((x: number, y: number) => number)[] = [
  (x, y) => (x + y) % 2,
  (_x, y) => y % 2,
  (x) => x % 3,
  (x, y) => (x + y) % 3,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2,
  (x, y) => ((x * y) % 2) + ((x * y) % 3),
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2,
]

export class DataTooLongError extends Error {}

const getBit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0

function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function numDataCodewords(ver: number, ecl: Ecc): number {
  const o = ECC_ORDINAL[ecl]
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[o][ver] * NUM_ERROR_CORRECTION_BLOCKS[o][ver]
}

function rsMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = rsMultiply(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = rsMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i] ^= rsMultiply(coef, factor)
    })
  }
  return result
}

export class QrCode {
  readonly size: number
  readonly mask: number
  private readonly modules: boolean[][]
  private readonly isFunction: boolean[][]

  private constructor(readonly version: number, readonly ecc: Ecc, dataCodewords: number[]) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.drawFunctionPatterns()
    this.drawCodewords(this.addEccAndInterleave(dataCodewords))
    let best = 0
    let minPenalty = Infinity
    for (let i = 0; i < 8; i++) {
      this.applyMask(i)
      this.drawFormatBits(i)
      const penalty = this.penaltyScore()
      if (penalty < minPenalty) {
        best = i
        minPenalty = penalty
      }
      this.applyMask(i)
    }
    this.mask = best
    this.applyMask(best)
    this.drawFormatBits(best)
  }

  /** Encode text as UTF-8 byte-mode data at the smallest version that fits. */
  static encodeText(text: string, ecc: Ecc = 'MEDIUM'): QrCode {
    const bytes = [...Buffer.from(text, 'utf8')]
    let version = MIN_VERSION
    let used = 0
    for (;; version++) {
      const ccBits = version <= 9 ? 8 : 16
      used = bytes.length >= 1 << ccBits ? Infinity : 4 + ccBits + 8 * bytes.length
      if (used <= numDataCodewords(version, ecc) * 8) break
      if (version >= MAX_VERSION) throw new DataTooLongError('Segment too long')
    }
    let level = ecc
    for (const next of ['MEDIUM', 'QUARTILE', 'HIGH'] as Ecc[]) {
      if (used <= numDataCodewords(version, next) * 8) level = next
    }
    const bits: number[] = []
    const append = (val: number, n: number): void => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1)
    }
    append(0x4, 4)
    append(bytes.length, version <= 9 ? 8 : 16)
    for (const b of bytes) append(b, 8)
    const capacity = numDataCodewords(version, level) * 8
    append(0, Math.min(4, capacity - bits.length))
    append(0, (8 - (bits.length % 8)) % 8)
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8)
    const codewords: number[] = new Array(bits.length / 8).fill(0)
    bits.forEach((bit, i) => {
      codewords[i >>> 3] |= bit << (7 - (i & 7))
    })
    return new QrCode(version, level, codewords)
  }

  getModule(x: number, y: number): boolean {
    return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x]
  }

  private setFunctionModule(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark
    this.isFunction[y][x] = true
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0)
      this.setFunctionModule(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(this.size - 4, 3)
    this.drawFinder(3, this.size - 4)
    const pos = this.alignmentPositions()
    const n = pos.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this.drawAlignment(pos[i], pos[j])
      }
    }
    this.drawFormatBits(0)
    this.drawVersion()
  }

  private drawFormatBits(mask: number): void {
    const data = (ECC_FORMAT_BITS[this.ecc] << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i))
    this.setFunctionModule(8, 7, getBit(bits, 6))
    this.setFunctionModule(8, 8, getBit(bits, 7))
    this.setFunctionModule(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i))
    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i))
    this.setFunctionModule(8, this.size - 8, true)
  }

  private drawVersion(): void {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunctionModule(a, b, bit)
      this.setFunctionModule(b, a, bit)
    }
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy))
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4)
        }
      }
    }
  }

  private drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return []
    const numAlign = Math.floor(this.version / 7) + 2
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
    const result = [6]
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
    return result
  }

  private addEccAndInterleave(data: number[]): number[] {
    const o = ECC_ORDINAL[this.ecc]
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[o][this.version]
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[o][this.version]
    const rawCodewords = Math.floor(numRawDataModules(this.version) / 8)
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
    const shortBlockLen = Math.floor(rawCodewords / numBlocks)
    const blocks: number[][] = []
    const div = rsDivisor(blockEccLen)
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
      k += dat.length
      const ecc = rsRemainder(dat, div)
      if (i < numShortBlocks) dat.push(0)
      blocks.push(dat.concat(ecc))
    }
    const result: number[] = []
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i])
      })
    }
    return result
  }

  private drawCodewords(data: number[]): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7))
            i++
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    const masker = MASKS[mask]
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (masker(x, y) === 0 && !this.isFunction[y][x]) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  private penaltyScore(): number {
    let result = 0
    const size = this.size
    const m = this.modules
    for (let y = 0; y < size; y++) {
      let runColor = false
      let runX = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let x = 0; x < size; x++) {
        if (m[y][x] === runColor) {
          runX++
          if (runX === 5) result += PENALTY_N1
          else if (runX > 5) result++
        } else {
          this.finderAddHistory(runX, history)
          if (!runColor) result += this.finderCountPatterns(history) * PENALTY_N3
          runColor = m[y][x]
          runX = 1
        }
      }
      result += this.finderTerminateAndCount(runColor, runX, history) * PENALTY_N3
    }
    for (let x = 0; x < size; x++) {
      let runColor = false
      let runY = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let y = 0; y < size; y++) {
        if (m[y][x] === runColor) {
          runY++
          if (runY === 5) result += PENALTY_N1
          else if (runY > 5) result++
        } else {
          this.finderAddHistory(runY, history)
          if (!runColor) result += this.finderCountPatterns(history) * PENALTY_N3
          runColor = m[y][x]
          runY = 1
        }
      }
      result += this.finderTerminateAndCount(runColor, runY, history) * PENALTY_N3
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x]
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += PENALTY_N2
      }
    }
    let dark = 0
    for (const row of m) for (const cell of row) if (cell) dark++
    const total = size * size
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    return result + k * PENALTY_N4
  }

  private finderCountPatterns(h: number[]): number {
    const n = h[1]
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0)
  }

  private finderTerminateAndCount(runColor: boolean, runLength: number, h: number[]): number {
    if (runColor) {
      this.finderAddHistory(runLength, h)
      runLength = 0
    }
    runLength += this.size
    this.finderAddHistory(runLength, h)
    return this.finderCountPatterns(h)
  }

  private finderAddHistory(runLength: number, h: number[]): void {
    if (h[0] === 0) runLength += this.size
    h.pop()
    h.unshift(runLength)
  }
}

export const QR_QUIET_MODULES = 4

/**
 * Inline SVG for a QR symbol: near-black on white regardless of page theme
 * (scanners want contrast), the spec's 4-module quiet zone always included,
 * crisp edges. One path of unit squares; scales via CSS width.
 */
export function qrSvg(data: string, opts: { ecc?: Ecc; label?: string } = {}): string {
  const qr = QrCode.encodeText(data, opts.ecc ?? 'MEDIUM')
  const total = qr.size + 2 * QR_QUIET_MODULES
  let d = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) d += `M${x + QR_QUIET_MODULES},${y + QR_QUIET_MODULES}h1v1h-1z`
    }
  }
  const label = (opts.label ?? 'QR code').replace(/[&<>"]/g, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="${label}" style="width:16rem;max-width:100%;height:auto;background:#fff"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}
