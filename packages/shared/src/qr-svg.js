/**
 * Zero-dependency, 100% offline ISO/IEC 18004 QR Code SVG encoder (Versions 1–16, EC Level M).
 * Isomorphic (Node.js + Browser via TextEncoder). Keeps sensitive keys/URLs strictly local.
 */

const textEncoder = new TextEncoder()

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255]
  }
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

function rsGeneratorPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    const root = GF_EXP[i]
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], root)
    }
    poly = next
  }
  return poly
}

function rsComputeRemainder(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount)
  const rem = new Uint8Array(ecCount)
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ rem[0]
    for (let j = 0; j < ecCount - 1; j += 1) {
      rem[j] = rem[j + 1]
    }
    rem[ecCount - 1] = 0
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        rem[j] ^= gfMul(gen[j + 1], factor)
      }
    }
  }
  return rem
}

const VERSION_SPECS_M = [
  { version: 1, ecPerBlock: 10, blocks: [[1, 16]], align: [] },
  { version: 2, ecPerBlock: 16, blocks: [[1, 28]], align: [6, 18] },
  { version: 3, ecPerBlock: 26, blocks: [[1, 44]], align: [6, 22] },
  { version: 4, ecPerBlock: 18, blocks: [[2, 32]], align: [6, 26] },
  { version: 5, ecPerBlock: 24, blocks: [[2, 43]], align: [6, 30] },
  { version: 6, ecPerBlock: 16, blocks: [[4, 27]], align: [6, 34] },
  { version: 7, ecPerBlock: 18, blocks: [[4, 31]], align: [6, 22, 38] },
  { version: 8, ecPerBlock: 22, blocks: [[2, 38], [2, 39]], align: [6, 24, 42] },
  { version: 9, ecPerBlock: 22, blocks: [[3, 36], [2, 37]], align: [6, 26, 46] },
  { version: 10, ecPerBlock: 26, blocks: [[4, 43], [1, 44]], align: [6, 28, 50] },
  { version: 11, ecPerBlock: 30, blocks: [[1, 50], [4, 51]], align: [6, 30, 54] },
  { version: 12, ecPerBlock: 22, blocks: [[6, 36], [2, 37]], align: [6, 32, 58] },
  { version: 13, ecPerBlock: 22, blocks: [[8, 37], [1, 38]], align: [6, 34, 62] },
  { version: 14, ecPerBlock: 24, blocks: [[4, 40], [5, 41]], align: [6, 26, 46, 66] },
  { version: 15, ecPerBlock: 24, blocks: [[5, 41], [5, 42]], align: [6, 26, 48, 70] },
  { version: 16, ecPerBlock: 28, blocks: [[7, 45], [3, 46]], align: [6, 26, 50, 74] },
]

function totalDataBytes(spec) {
  return spec.blocks.reduce((sum, [cnt, dc]) => sum + cnt * dc, 0)
}

function bchRemainder(val, poly, deg) {
  let r = val << deg
  const topBit = 1 << deg
  for (let i = 15; i >= 0; i -= 1) {
    if (r & (topBit << i)) {
      r ^= poly << i
    }
  }
  return r
}

function getFormatBits(mask) {
  const data = (0b00 << 3) | (mask & 7)
  const rem = bchRemainder(data, 0x537, 10)
  return ((data << 10) | rem) ^ 0x5412
}

function getVersionBits(version) {
  const rem = bchRemainder(version, 0x1f25, 12)
  return (version << 12) | rem
}

function buildCodewords(bytes, spec) {
  const capBytes = totalDataBytes(spec)
  const countBits = spec.version <= 9 ? 8 : 16
  const bits = []
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1)
    }
  }

  pushBits(0b0100, 4)
  pushBits(bytes.length, countBits)
  for (const b of bytes) pushBits(b, 8)

  const capBits = capBytes * 8
  const term = Math.min(4, capBits - bits.length)
  pushBits(0, term)

  while (bits.length % 8 !== 0) bits.push(0)

  const data = new Uint8Array(capBytes)
  let byteIdx = 0
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j]
    data[byteIdx++] = v
  }
  let padToggle = 0
  while (byteIdx < capBytes) {
    data[byteIdx++] = padToggle === 0 ? 0xec : 0x11
    padToggle ^= 1
  }

  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  let maxDataLen = 0
  for (const [count, dc] of spec.blocks) {
    for (let i = 0; i < count; i += 1) {
      const slice = data.subarray(offset, offset + dc)
      offset += dc
      dataBlocks.push(slice)
      ecBlocks.push(rsComputeRemainder(slice, spec.ecPerBlock))
      if (dc > maxDataLen) maxDataLen = dc
    }
  }

  const out = []
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const blk of dataBlocks) {
      if (i < blk.length) out.push(blk[i])
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const ec of ecBlocks) {
      out.push(ec[i])
    }
  }
  return out
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function evaluatePenalty(grid, size) {
  let penalty = 0
  for (let r = 0; r < size; r += 1) {
    let runColor = grid[r][0]
    let runLen = 1
    for (let c = 1; c < size; c += 1) {
      if (grid[r][c] === runColor) {
        runLen += 1
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5)
        runColor = grid[r][c]
        runLen = 1
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5)
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = grid[0][c]
    let runLen = 1
    for (let r = 1; r < size; r += 1) {
      if (grid[r][c] === runColor) {
        runLen += 1
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5)
        runColor = grid[r][c]
        runLen = 1
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5)
  }
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = grid[r][c]
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
        penalty += 3
      }
    }
  }
  // Rule 3: 1:1:3:1:1 finder-like pattern preceded or followed by 4 light modules (+40 each)
  for (let r = 0; r < size; r += 1) {
    const row = grid[r]
    for (let c = 0; c <= size - 11; c += 1) {
      if (
        (row[c] === 1 && row[c + 1] === 0 && row[c + 2] === 1 && row[c + 3] === 1 &&
          row[c + 4] === 1 && row[c + 5] === 0 && row[c + 6] === 1 &&
          row[c + 7] === 0 && row[c + 8] === 0 && row[c + 9] === 0 && row[c + 10] === 0) ||
        (row[c] === 0 && row[c + 1] === 0 && row[c + 2] === 0 && row[c + 3] === 0 &&
          row[c + 4] === 1 && row[c + 5] === 0 && row[c + 6] === 1 &&
          row[c + 7] === 1 && row[c + 8] === 1 && row[c + 9] === 0 && row[c + 10] === 1)
      ) {
        penalty += 40
      }
    }
  }
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r <= size - 11; r += 1) {
      if (
        (grid[r][c] === 1 && grid[r + 1][c] === 0 && grid[r + 2][c] === 1 && grid[r + 3][c] === 1 &&
          grid[r + 4][c] === 1 && grid[r + 5][c] === 0 && grid[r + 6][c] === 1 &&
          grid[r + 7][c] === 0 && grid[r + 8][c] === 0 && grid[r + 9][c] === 0 && grid[r + 10][c] === 0) ||
        (grid[r][c] === 0 && grid[r + 1][c] === 0 && grid[r + 2][c] === 0 && grid[r + 3][c] === 0 &&
          grid[r + 4][c] === 1 && grid[r + 5][c] === 0 && grid[r + 6][c] === 1 &&
          grid[r + 7][c] === 1 && grid[r + 8][c] === 1 && grid[r + 9][c] === 0 && grid[r + 10][c] === 1)
      ) {
        penalty += 40
      }
    }
  }
  let dark = 0
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (grid[r][c]) dark += 1
    }
  }
  const pct = (dark * 100) / (size * size)
  const k = Math.floor(Math.abs(pct - 50) / 5)
  penalty += k * 10
  return penalty
}

export function encodeQrMatrix(text) {
  const bytes = textEncoder.encode(String(text ?? ''))
  const spec = VERSION_SPECS_M.find((s) => {
    const capBytes = totalDataBytes(s)
    const headerBits = 4 + (s.version <= 9 ? 8 : 16)
    return headerBits + bytes.length * 8 <= capBytes * 8
  })
  if (!spec) {
    const maxSpec = VERSION_SPECS_M[VERSION_SPECS_M.length - 1]
    const maxBytes = Math.floor((totalDataBytes(maxSpec) * 8 - (4 + (maxSpec.version <= 9 ? 8 : 16))) / 8)
    throw new Error(`QR payload too long (${bytes.length} bytes, max ${maxBytes})`)
  }

  const size = 17 + 4 * spec.version
  const grid = Array.from({ length: size }, () => new Uint8Array(size))
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size))

  const setFunc = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return
    grid[r][c] = dark ? 1 : 0
    isFunc[r][c] = 1
  }

  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = top + dr
        const c = left + dc
        if (r < 0 || c < 0 || r >= size || c >= size) continue
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
        const inBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        setFunc(r, c, inBox && (inBorder || inCore))
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)

  for (let i = 8; i < size - 8; i += 1) {
    setFunc(6, i, i % 2 === 0)
    setFunc(i, 6, i % 2 === 0)
  }

  const align = spec.align
  for (let i = 0; i < align.length; i += 1) {
    for (let j = 0; j < align.length; j += 1) {
      if (i === 0 && j === 0) continue
      if (i === 0 && j === align.length - 1) continue
      if (i === align.length - 1 && j === 0) continue
      const cr = align[i]
      const cc = align[j]
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc))
          setFunc(cr + dr, cc + dc, dist === 0 || dist === 2)
        }
      }
    }
  }

  const drawFormat = (mask) => {
    const bits = getFormatBits(mask)
    const bitAt = (idx) => (bits >>> idx) & 1
    const c1 = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ]
    for (let i = 0; i < 15; i += 1) {
      const [r, c] = c1[i]
      setFunc(r, c, bitAt(14 - i))
    }
    for (let i = 0; i < 7; i += 1) {
      setFunc(size - 1 - i, 8, bitAt(14 - i))
    }
    setFunc(size - 8, 8, 1)
    for (let i = 0; i < 8; i += 1) {
      setFunc(8, size - 8 + i, bitAt(7 - i))
    }
  }
  drawFormat(0)

  if (spec.version >= 7) {
    const vBits = getVersionBits(spec.version)
    for (let i = 0; i < 18; i += 1) {
      const bit = (vBits >>> i) & 1
      const a = Math.floor(i / 3)
      const b = size - 11 + (i % 3)
      setFunc(a, b, bit)
      setFunc(b, a, bit)
    }
  }

  const codewords = buildCodewords(bytes, spec)
  let bitIdx = 0
  const totalBits = codewords.length * 8
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step
      for (let dx = 0; dx < 2; dx += 1) {
        const c = right - dx
        if (isFunc[r][c]) continue
        let dark = 0
        if (bitIdx < totalBits) {
          dark = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1
          bitIdx += 1
        }
        grid[r][c] = dark
      }
    }
    upward = !upward
  }

  let bestMask = 0
  let bestPenalty = Infinity
  let bestGrid = null

  for (let m = 0; m < 8; m += 1) {
    const candidate = grid.map((row) => Uint8Array.from(row))
    const maskFn = MASK_FNS[m]
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!isFunc[r][c] && maskFn(r, c)) {
          candidate[r][c] ^= 1
        }
      }
    }
    const bits = getFormatBits(m)
    const bitAt = (idx) => (bits >>> idx) & 1
    const c1 = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ]
    for (let i = 0; i < 15; i += 1) {
      const [r, c] = c1[i]
      candidate[r][c] = bitAt(14 - i)
    }
    for (let i = 0; i < 7; i += 1) candidate[size - 1 - i][8] = bitAt(14 - i)
    candidate[size - 8][8] = 1
    for (let i = 0; i < 8; i += 1) candidate[8][size - 8 + i] = bitAt(7 - i)

    const p = evaluatePenalty(candidate, size)
    if (p < bestPenalty) {
      bestPenalty = p
      bestMask = m
      bestGrid = candidate
    }
  }

  return { size, version: spec.version, mask: bestMask, grid: bestGrid }
}

const SAFE_SVG_COLOR_RE =
  /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]{3,20}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/

function sanitizeSvgColor(val, fallback) {
  const s = String(val ?? '').trim()
  return SAFE_SVG_COLOR_RE.test(s) ? s : fallback
}

export function renderQrSvg(text, { pixelSize = 240, quietZone = 4, darkColor = '#0F172A', lightColor = '#FFFFFF' } = {}) {
  const safePixelSize = Number.isFinite(Number(pixelSize))
    ? Math.max(16, Math.min(4096, Math.round(Number(pixelSize))))
    : 240
  const safeQuietZone = Number.isFinite(Number(quietZone))
    ? Math.max(0, Math.min(32, Math.floor(Number(quietZone))))
    : 4
  const safeDark = sanitizeSvgColor(darkColor, '#0F172A')
  const safeLight = sanitizeSvgColor(lightColor, '#FFFFFF')
  const { size, grid } = encodeQrMatrix(text)
  const total = size + safeQuietZone * 2
  const parts = []
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (grid[r][c]) {
        parts.push(`M${c + safeQuietZone},${r + safeQuietZone}h1v1h-1z`)
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${safePixelSize}" height="${safePixelSize}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="${safeLight}"/><path d="${parts.join('')}" fill="${safeDark}"/></svg>`
}

export function renderQrDataUrl(text, opts = {}) {
  const svg = renderQrSvg(text, opts)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
