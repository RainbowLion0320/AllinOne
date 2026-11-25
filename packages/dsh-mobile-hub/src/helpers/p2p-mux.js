/**
 * Self-contained mirror of `@allinone/shared/p2p-mux` for `dsh-mobile-hub` standalone/plugin runtime.
 */

export const P2P_CTRL_LABEL = 'aio-ctrl'
export const P2P_BULK_LABEL = 'aio-bulk'

export const CTRL_FRAG_LIMIT_CHARS = 48 * 1024
export const BULK_SLICE_BYTES = 60 * 1024
export const BULK_HIGH_WATER_BYTES = 2 * 1024 * 1024
export const BULK_LOW_WATER_BYTES = 512 * 1024

export const BULK_HEADER_BYTES = 16
export const BULK_FLAG_EOF = 1

const BULK_MAGIC_0 = 0x41 // 'A'
const BULK_MAGIC_1 = 0x49 // 'I'
const BULK_MAGIC_2 = 0x4f // 'O'
const BULK_MAGIC_3 = 0x42 // 'B'

function toU8(data) {
  if (data instanceof Uint8Array && data.constructor === Uint8Array) return data
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data)
}

export function encodeBulkFrame(streamId, seq, payload = new Uint8Array(0), flags = 0) {
  const bytes = toU8(payload)
  const out = new Uint8Array(BULK_HEADER_BYTES + bytes.byteLength)
  out[0] = BULK_MAGIC_0
  out[1] = BULK_MAGIC_1
  out[2] = BULK_MAGIC_2
  out[3] = BULK_MAGIC_3
  const view = new DataView(out.buffer, out.byteOffset, BULK_HEADER_BYTES)
  view.setUint32(4, streamId >>> 0, false)
  view.setUint32(8, seq >>> 0, false)
  view.setUint32(12, flags >>> 0, false)
  if (bytes.byteLength > 0) out.set(bytes, BULK_HEADER_BYTES)
  return out
}

export function decodeBulkFrame(raw) {
  const bytes = toU8(raw)
  if (bytes.byteLength < BULK_HEADER_BYTES) return null
  if (
    bytes[0] !== BULK_MAGIC_0 ||
    bytes[1] !== BULK_MAGIC_1 ||
    bytes[2] !== BULK_MAGIC_2 ||
    bytes[3] !== BULK_MAGIC_3
  ) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, BULK_HEADER_BYTES)
  const streamId = view.getUint32(4, false)
  const seq = view.getUint32(8, false)
  const flags = view.getUint32(12, false)
  const payload = bytes.subarray(BULK_HEADER_BYTES)
  return {
    streamId,
    seq,
    flags,
    eof: Boolean(flags & BULK_FLAG_EOF),
    payload,
  }
}

export async function waitForChannelDrain(
  dc,
  {
    highWaterMark = BULK_HIGH_WATER_BYTES,
    lowWaterMark = BULK_LOW_WATER_BYTES,
    signal = null,
    timeoutMs = 30_000,
  } = {},
) {
  if (!dc) throw new Error('DataChannel unavailable')
  if (signal?.aborted) {
    const err = new Error('Transfer aborted')
    err.name = 'AbortError'
    throw err
  }
  const getBuffered = () => Number(dc.bufferedAmount || 0)
  const isOpen = () => (dc.readyState || 'open') === 'open'

  if (!isOpen()) throw new Error('DataChannel closed')
  if (getBuffered() < highWaterMark) return

  try {
    dc.bufferedAmountLowThreshold = lowWaterMark
  } catch {}

  await new Promise((resolve, reject) => {
    let done = false
    const cleanups = []
    const finish = (err) => {
      if (done) return
      done = true
      for (const fn of cleanups) {
        try { fn() } catch {}
      }
      if (err) reject(err)
      else resolve()
    }

    const timer = setTimeout(() => finish(new Error('DataChannel backpressure timeout')), timeoutMs)
    cleanups.push(() => clearTimeout(timer))

    const poll = setInterval(() => {
      if (!isOpen()) return finish(new Error('DataChannel closed during transfer'))
      if (getBuffered() <= lowWaterMark) finish()
    }, 20)
    cleanups.push(() => clearInterval(poll))

    if (typeof dc.addEventListener === 'function') {
      const onLow = () => {
        if (getBuffered() <= lowWaterMark) finish()
      }
      const onClose = () => finish(new Error('DataChannel closed during transfer'))
      dc.addEventListener('bufferedamountlow', onLow)
      dc.addEventListener('close', onClose)
      cleanups.push(() => {
        dc.removeEventListener('bufferedamountlow', onLow)
        dc.removeEventListener('close', onClose)
      })
    } else if (dc.bufferedAmountLow && typeof dc.bufferedAmountLow.subscribe === 'function') {
      const sub = dc.bufferedAmountLow.subscribe(() => {
        if (getBuffered() <= lowWaterMark) finish()
      })
      cleanups.push(() => sub?.unsubscribe?.())
    }

    if (signal) {
      const onAbort = () => {
        const err = new Error('Transfer aborted')
        err.name = 'AbortError'
        finish(err)
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', onAbort))
    }
  })
}

export async function sendWithBackpressure(dc, bytes, opts = {}) {
  await waitForChannelDrain(dc, opts)
  if ((dc.readyState || 'open') !== 'open') {
    throw new Error('DataChannel closed')
  }
  dc.send(bytes)
}

export function createCtrlCodec({ maxFragsInFlight = 64, fragTimeoutMs = 30_000 } = {}) {
  let fragSeq = 1
  const assemblies = new Map()

  function pruneStale(now = Date.now()) {
    for (const [id, entry] of assemblies.entries()) {
      if (now - entry.createdAt > fragTimeoutMs) {
        assemblies.delete(id)
      }
    }
    while (assemblies.size > maxFragsInFlight) {
      const oldest = assemblies.keys().next().value
      if (!oldest) break
      assemblies.delete(oldest)
    }
  }

  function encode(msg) {
    const raw = JSON.stringify(msg)
    if (raw.length <= CTRL_FRAG_LIMIT_CHARS) {
      return [raw]
    }
    const id = `f${fragSeq++}`
    const total = Math.ceil(raw.length / CTRL_FRAG_LIMIT_CHARS)
    const frames = []
    for (let i = 0; i < total; i += 1) {
      frames.push(
        JSON.stringify({
          _aioFrag: {
            id,
            i,
            n: total,
            d: raw.slice(i * CTRL_FRAG_LIMIT_CHARS, (i + 1) * CTRL_FRAG_LIMIT_CHARS),
          },
        }),
      )
    }
    return frames
  }

  function decode(rawFrame) {
    const text =
      typeof rawFrame === 'string'
        ? rawFrame
        : new TextDecoder().decode(toU8(rawFrame))
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || !parsed._aioFrag) {
      return parsed
    }
    const f = parsed._aioFrag
    const id = String(f.id || '')
    const idx = Number(f.i)
    const total = Number(f.n)
    if (!id || !Number.isInteger(idx) || !Number.isInteger(total) || total <= 0 || total > 1024 || idx < 0 || idx >= total) {
      return null
    }
    pruneStale()
    let entry = assemblies.get(id)
    if (!entry) {
      entry = { parts: new Array(total), received: 0, total, createdAt: Date.now() }
      assemblies.set(id, entry)
    }
    if (entry.parts[idx] === undefined) {
      entry.parts[idx] = String(f.d || '')
      entry.received += 1
    }
    if (entry.received < entry.total) {
      return null
    }
    assemblies.delete(id)
    try {
      return JSON.parse(entry.parts.join(''))
    } catch {
      return null
    }
  }

  function clear() {
    assemblies.clear()
  }

  return { encode, decode, clear }
}
