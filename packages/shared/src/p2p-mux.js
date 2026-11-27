/**
 * Shared AIO-P2P v1 Dual-Channel Framing, Fragmentation & Backpressure Utilities.
 *
 * Works identically in browsers (WebRTC RTCDataChannel), Electron Chromium workers,
 * and Node.js (`werift` RTCDataChannel) with zero external dependencies.
 *
 * Channels:
 *  - `aio-ctrl`: Ordered reliable binary channel (`AIOC`/`AIOF`) carrying JSON metadata plus an
 *                optional zero-copy binary payload, auto-fragmented into <= 48 KB SCTP slices.
 *  - `aio-bulk`: Ordered reliable binary channel (`AIOB`) for E2EE file/image transfers (60 KB safe
 *                slices with bufferedAmount + credit-window flow control).
 */

export const P2P_CTRL_LABEL = 'aio-ctrl'
export const P2P_BULK_LABEL = 'aio-bulk'

export const CTRL_FRAG_LIMIT_BYTES = 48 * 1024
export const CTRL_MAX_FRAGMENTS = 1024
export const BULK_SLICE_BYTES = 60 * 1024
export const BULK_HIGH_WATER_BYTES = 2 * 1024 * 1024
export const BULK_LOW_WATER_BYTES = 512 * 1024
export const BULK_DEFAULT_WINDOW_BYTES = 8 * 1024 * 1024

export const BULK_HEADER_BYTES = 16
export const BULK_FLAG_EOF = 1

const BULK_MAGIC_0 = 0x41 // 'A'
const BULK_MAGIC_1 = 0x49 // 'I'
const BULK_MAGIC_2 = 0x4f // 'O'
const BULK_MAGIC_3 = 0x42 // 'B'

const CTRL_SINGLE_MAGIC_3 = 0x43 // 'C' -> 'AIOC'
const CTRL_FRAG_MAGIC_3 = 0x46   // 'F' -> 'AIOF'
const CTRL_SINGLE_HEADER_BYTES = 4
const CTRL_FRAG_HEADER_BYTES = 16
export const MAX_CTRL_REASSEMBLY_BYTES = 32 * 1024 * 1024

function toU8(data) {
  if (data instanceof Uint8Array && data.constructor === Uint8Array) return data
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new TypeError('Expected Uint8Array, ArrayBufferView, or ArrayBuffer')
}

/**
 * Encode one binary slice for `aio-bulk`:
 *   [0..3]  Magic 'AIOB'
 *   [4..7]  uint32 BE streamId
 *   [8..11] uint32 BE seq
 *   [12..15] uint32 BE flags (bit 0 = EOF)
 *   [16..N] payload bytes (<= 64 KB)
 */
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

/**
 * Decode one binary slice from `aio-bulk`. Returns null if frame is malformed.
 */
export function decodeBulkFrame(raw) {
  if (!raw || (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw))) return null
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

/**
 * Wait until a DataChannel's send buffer drains below `lowWaterMark`, respecting `AbortSignal`.
 * Works with Browser RTCDataChannel, werift RTCDataChannel, and custom proxy adapters.
 */
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
    timer.unref?.()
    cleanups.push(() => clearTimeout(timer))

    let hasNativeDrainEvent = false
    if (typeof dc.addEventListener === 'function') {
      hasNativeDrainEvent = true
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
      hasNativeDrainEvent = true
      const sub = dc.bufferedAmountLow.subscribe(() => {
        if (getBuffered() <= lowWaterMark) finish()
      })
      cleanups.push(() => sub?.unsubscribe?.())
    }

    // Immediate re-check after attaching edge-triggered listeners to prevent missed-edge 250ms stalls
    if (!isOpen()) return finish(new Error('DataChannel closed during transfer'))
    if (getBuffered() <= lowWaterMark) return finish()

    // Only poll at 50 Hz if the DataChannel lacks native low-water events; otherwise use a gentle 250ms safety check.
    const pollMs = hasNativeDrainEvent ? 250 : 20
    const poll = setInterval(() => {
      if (!isOpen()) return finish(new Error('DataChannel closed during transfer'))
      if (getBuffered() <= lowWaterMark) finish()
    }, pollMs)
    poll.unref?.()
    cleanups.push(() => clearInterval(poll))

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

/**
 * Send raw bytes on a DataChannel after applying backpressure checks.
 */
export async function sendWithBackpressure(dc, bytes, opts = {}) {
  await waitForChannelDrain(dc, opts)
  if ((dc.readyState || 'open') !== 'open') {
    throw new Error('DataChannel closed')
  }
  dc.send(bytes)
}

/**
 * Serialize async writes onto a single DataChannel so concurrent streams or fragmented
 * control bursts cannot race on `bufferedAmountLowThreshold` or overshoot `highWaterMark`.
 * Accepts either a DataChannel instance or a resolver function `() => dc`.
 */
export function createSerializedChannelWriter(dcOrGetter = null, defaultOpts = {}) {
  let boundDc = typeof dcOrGetter === 'function' ? null : dcOrGetter
  let dcGetter = typeof dcOrGetter === 'function' ? dcOrGetter : null
  let chain = Promise.resolve()
  let closed = false

  function resolveDc() {
    return dcGetter ? dcGetter() : boundDc
  }

  function setChannel(nextDc) {
    if (typeof nextDc === 'function') {
      dcGetter = nextDc
      boundDc = null
    } else {
      dcGetter = null
      boundDc = nextDc || null
    }
  }

  function enqueue(fn) {
    if (closed) return Promise.reject(new Error('DataChannel writer closed'))
    const task = chain.then(() => {
      if (closed) throw new Error('DataChannel writer closed')
      return fn()
    })
    chain = task.catch(() => {})
    return task
  }

  function send(bytes, opts = {}) {
    const merged = { ...defaultOpts, ...opts }
    return enqueue(() => {
      const target = resolveDc()
      if (!target) throw new Error('DataChannel not bound to writer')
      return sendWithBackpressure(target, bytes, merged)
    })
  }

  function close() {
    closed = true
    boundDc = null
    dcGetter = null
  }

  return { enqueue, send, setChannel, close }
}

/**
 * Credit-based receiver-driven window controller for `aio-bulk` streams.
 * Prevents fast LAN senders from overflowing slow receivers' crypto/disk queues.
 */
export function createBulkWindowController({
  initialWindowBytes = BULK_DEFAULT_WINDOW_BYTES,
  timeoutMs = 45_000,
} = {}) {
  let creditBytes = Math.max(BULK_SLICE_BYTES, Number(initialWindowBytes) || BULK_DEFAULT_WINDOW_BYTES)
  let closedErr = null
  const waiters = []

  function wakeAll() {
    while (waiters.length > 0) {
      const w = waiters[0]
      if (closedErr) {
        waiters.shift()
        w.reject(closedErr)
      } else if (creditBytes >= w.needed) {
        waiters.shift()
        creditBytes -= w.needed
        w.resolve()
      } else {
        break
      }
    }
  }

  function grant(bytes) {
    const n = Math.floor(Number(bytes) || 0)
    if (n <= 0 || closedErr) return
    creditBytes += n
    wakeAll()
  }

  function consume(bytes, signal = null) {
    const needed = Math.max(1, Math.floor(Number(bytes) || 0))
    if (closedErr) return Promise.reject(closedErr)
    if (signal?.aborted) {
      const err = new Error('Transfer aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    }
    if (waiters.length === 0 && creditBytes >= needed) {
      creditBytes -= needed
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
        const idx = waiters.indexOf(entry)
        if (idx !== -1) {
          waiters.splice(idx, 1)
          // Prevent head-of-line deadlock when an aborted/timed-out front waiter blocked smaller waiters behind it
          if (idx === 0 && waiters.length > 0 && (closedErr || creditBytes >= waiters[0].needed)) {
            wakeAll()
          }
        }
      }
      const entry = {
        needed,
        resolve: () => {
          if (settled) return
          settled = true
          cleanup()
          resolve()
        },
        reject: (err) => {
          if (settled) return
          settled = true
          cleanup()
          reject(err)
        },
      }
      const timer = setTimeout(() => {
        entry.reject(new Error('Bulk receive window timeout'))
      }, timeoutMs)
      timer.unref?.()
      const onAbort = signal
        ? () => {
            const err = new Error('Transfer aborted')
            err.name = 'AbortError'
            entry.reject(err)
          }
        : null
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true })
      waiters.push(entry)
    })
  }

  function abort(err) {
    closedErr = err instanceof Error ? err : new Error(String(err || 'Bulk window aborted'))
    wakeAll()
  }

  return {
    grant,
    consume,
    abort,
    get availableBytes() {
      return creditBytes
    },
  }
}

const ctrlTextEncoder = new TextEncoder()
const ctrlTextDecoder = new TextDecoder()

function unpackCtrlLogical(logical) {
  if (!logical || logical.byteLength < 4) return null
  const view = new DataView(logical.buffer, logical.byteOffset, 4)
  const metaLen = view.getUint32(0, false)
  if (metaLen === 0 || 4 + metaLen > logical.byteLength) return null
  let meta
  try {
    meta = JSON.parse(ctrlTextDecoder.decode(logical.subarray(4, 4 + metaLen)))
  } catch {
    return null
  }
  const binStart = 4 + metaLen
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    if (binStart < logical.byteLength) {
      meta.bin = logical.subarray(binStart)
    } else {
      delete meta.bin
    }
  }
  return meta
}

/**
 * Create a symmetric binary control-channel codec with automatic 48 KB binary SCTP fragmentation.
 * Supports arbitrary JSON metadata plus an optional zero-copy `bin: Uint8Array` payload
 * (eliminates +33% Base64URL inflation and JSON double-escaping on `aio-ctrl`).
 */
export function createCtrlCodec({
  maxFragsInFlight = 64,
  fragTimeoutMs = 30_000,
  maxTotalReassemblyBytes = MAX_CTRL_REASSEMBLY_BYTES,
} = {}) {
  const totalReassemblyCap =
    Number.isFinite(Number(maxTotalReassemblyBytes)) && Number(maxTotalReassemblyBytes) > 0
      ? Math.floor(Number(maxTotalReassemblyBytes))
      : MAX_CTRL_REASSEMBLY_BYTES
  let fragSeq = 1
  let totalReassemblyBytes = 0
  /** @type {Map<number, { parts: (Uint8Array | undefined)[], received: number, receivedBytes: number, total: number, createdAt: number }>} */
  const assemblies = new Map()

  function removeAssembly(id) {
    const entry = assemblies.get(id)
    if (!entry) return false
    assemblies.delete(id)
    totalReassemblyBytes = Math.max(0, totalReassemblyBytes - entry.receivedBytes)
    return true
  }

  function pruneStale(now = Date.now(), reserve = 0, neededBytes = 0, excludeId = null) {
    for (const [id, entry] of [...assemblies.entries()]) {
      if (now - entry.createdAt > fragTimeoutMs) {
        removeAssembly(id)
      }
    }
    const maxAllowed = Math.max(0, maxFragsInFlight - reserve)
    while (assemblies.size > maxAllowed) {
      const oldest = [...assemblies.keys()].find((k) => k !== excludeId)
      if (oldest === undefined) break
      removeAssembly(oldest)
    }
    if (neededBytes > 0) {
      while (totalReassemblyBytes + neededBytes > totalReassemblyCap) {
        const oldest = [...assemblies.keys()].find((k) => k !== excludeId)
        if (oldest === undefined) break
        removeAssembly(oldest)
      }
    }
  }

  /**
   * Encode a control message object (with optional `bin: Uint8Array`) into 1 or more binary frames <= 48 KB each.
   * @param {any} msg
   * @returns {Uint8Array[]}
   */
  function encode(msg) {
    let metaObj = msg
    let binBytes = null
    if (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.bin !== undefined) {
      const { bin, ...rest } = msg
      metaObj = rest
      binBytes = bin ? toU8(bin) : null
    }
    const metaBytes = ctrlTextEncoder.encode(JSON.stringify(metaObj))
    const binLen = binBytes ? binBytes.byteLength : 0
    const logicalLen = 4 + metaBytes.byteLength + binLen
    if (logicalLen > totalReassemblyCap) {
      const err = new Error(`Control message (${logicalLen} B) exceeds maximum limit (${totalReassemblyCap} B)`)
      err.code = 'CTRL_MESSAGE_TOO_LARGE'
      throw err
    }
    const logical = new Uint8Array(logicalLen)
    new DataView(logical.buffer, logical.byteOffset, 4).setUint32(0, metaBytes.byteLength, false)
    logical.set(metaBytes, 4)
    if (binLen > 0) logical.set(binBytes, 4 + metaBytes.byteLength)

    if (logicalLen <= CTRL_FRAG_LIMIT_BYTES - CTRL_SINGLE_HEADER_BYTES) {
      const frame = new Uint8Array(CTRL_SINGLE_HEADER_BYTES + logicalLen)
      frame[0] = BULK_MAGIC_0
      frame[1] = BULK_MAGIC_1
      frame[2] = BULK_MAGIC_2
      frame[3] = CTRL_SINGLE_MAGIC_3
      frame.set(logical, CTRL_SINGLE_HEADER_BYTES)
      return [frame]
    }

    const fragId = fragSeq++ >>> 0
    const sliceCap = CTRL_FRAG_LIMIT_BYTES - CTRL_FRAG_HEADER_BYTES
    const total = Math.ceil(logicalLen / sliceCap)
    if (total > CTRL_MAX_FRAGMENTS) {
      const err = new Error(`Control message requires ${total} fragments (max ${CTRL_MAX_FRAGMENTS})`)
      err.code = 'CTRL_MESSAGE_TOO_LARGE'
      throw err
    }
    const frames = new Array(total)
    for (let i = 0; i < total; i += 1) {
      const start = i * sliceCap
      const slice = logical.subarray(start, Math.min(logicalLen, start + sliceCap))
      const frame = new Uint8Array(CTRL_FRAG_HEADER_BYTES + slice.byteLength)
      frame[0] = BULK_MAGIC_0
      frame[1] = BULK_MAGIC_1
      frame[2] = BULK_MAGIC_2
      frame[3] = CTRL_FRAG_MAGIC_3
      const view = new DataView(frame.buffer, frame.byteOffset, CTRL_FRAG_HEADER_BYTES)
      view.setUint32(4, fragId, false)
      view.setUint32(8, i >>> 0, false)
      view.setUint32(12, total >>> 0, false)
      frame.set(slice, CTRL_FRAG_HEADER_BYTES)
      frames[i] = frame
    }
    return frames
  }

  /**
   * Feed one incoming binary control frame (`AIOC` or `AIOF`).
   * Returns the decoded object once complete, or `null` while awaiting remaining fragments.
   * @param {Uint8Array|ArrayBuffer} rawFrame
   * @returns {any|null}
   */
  function decode(rawFrame) {
    if (!rawFrame || (!(rawFrame instanceof ArrayBuffer) && !ArrayBuffer.isView(rawFrame))) return null
    const bytes = toU8(rawFrame)
    if (
      bytes.byteLength < CTRL_SINGLE_HEADER_BYTES ||
      bytes[0] !== BULK_MAGIC_0 ||
      bytes[1] !== BULK_MAGIC_1 ||
      bytes[2] !== BULK_MAGIC_2
    ) {
      return null
    }
    if (bytes[3] === CTRL_SINGLE_MAGIC_3) {
      return unpackCtrlLogical(bytes.subarray(CTRL_SINGLE_HEADER_BYTES))
    }
    if (bytes[3] !== CTRL_FRAG_MAGIC_3 || bytes.byteLength < CTRL_FRAG_HEADER_BYTES) {
      return null
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, CTRL_FRAG_HEADER_BYTES)
    const fragId = view.getUint32(4, false)
    const idx = view.getUint32(8, false)
    const total = view.getUint32(12, false)
    if (total === 0 || total > CTRL_MAX_FRAGMENTS || idx >= total) {
      return null
    }
    const rawSlice = bytes.subarray(CTRL_FRAG_HEADER_BYTES)
    if (rawSlice.byteLength > CTRL_FRAG_LIMIT_BYTES) {
      return null
    }
    // Detach from oversized/pooled backing ArrayBuffers so fragmented messages never pin large slabs
    const slice =
      rawSlice.buffer.byteLength > Math.max(CTRL_FRAG_LIMIT_BYTES * 2, rawSlice.byteLength * 2)
        ? rawSlice.slice()
        : rawSlice
    const now = Date.now()
    let entry = assemblies.get(fragId)
    if (entry && now - entry.createdAt > fragTimeoutMs) {
      removeAssembly(fragId)
      entry = undefined
    }
    if (!entry) {
      pruneStale(now, 1, slice.byteLength)
      if (
        slice.byteLength > MAX_CTRL_REASSEMBLY_BYTES ||
        totalReassemblyBytes + slice.byteLength > totalReassemblyCap
      ) {
        return null
      }
      entry = { parts: new Array(total), received: 0, receivedBytes: 0, total, createdAt: now }
      assemblies.set(fragId, entry)
    } else if (entry.total !== total) {
      return null
    }
    if (entry.parts[idx] === undefined) {
      if (entry.receivedBytes + slice.byteLength > MAX_CTRL_REASSEMBLY_BYTES) {
        removeAssembly(fragId)
        return null
      }
      if (totalReassemblyBytes + slice.byteLength > totalReassemblyCap) {
        pruneStale(now, 0, slice.byteLength, fragId)
        if (totalReassemblyBytes + slice.byteLength > totalReassemblyCap) {
          if (entry.received === 0) removeAssembly(fragId)
          return null
        }
      }
      entry.parts[idx] = slice
      entry.received += 1
      entry.receivedBytes += slice.byteLength
      totalReassemblyBytes += slice.byteLength
    }
    if (entry.received < entry.total) {
      return null
    }
    removeAssembly(fragId)
    const full = new Uint8Array(entry.receivedBytes)
    let offset = 0
    for (let i = 0; i < entry.total; i += 1) {
      const part = entry.parts[i]
      if (!part) return null
      full.set(part, offset)
      offset += part.byteLength
    }
    return unpackCtrlLogical(full)
  }

  function clear() {
    assemblies.clear()
    totalReassemblyBytes = 0
  }

  return { encode, decode, clear }
}
