/**
 * Isomorphic Zero-Knowledge End-to-End Encryption (E2EE) primitive for All in One.
 *
 * Uses native Web Crypto API (`crypto.subtle` + `crypto.getRandomValues`) available identically
 * in modern browsers, Electron, Capacitor WebViews, and Node.js >= 20 — zero external dependencies.
 *
 * Cryptographic properties:
 *  - 256-bit random room key (32 bytes, base64url encoded, never sent to the Relay Server)
 *  - Authenticated encryption: AES-256-GCM with fresh 96-bit (12-byte) random IV per message/file
 *  - 128-bit GCM authentication tag
 *  - Additional Authenticated Data (AAD) binding protocol version, message kind, roomId, and keyId
 *  - Non-reversible key fingerprint (`keyId` = first 8 bytes of SHA-256("allinone-e2ee-v1-id:" || key))
 */

export const E2EE_VERSION = 1
export const E2EE_CHUNKED_VERSION = 2
export const E2EE_KEY_BYTES = 32
export const E2EE_IV_BYTES = 12
export const E2EE_CHUNK_SIZE = 4 * 1024 * 1024
export const E2EE_CHUNKED_THRESHOLD = 32 * 1024 * 1024
export const E2EE_METHOD_MARKER = '__e2ee__'
export const E2EE_EVENT_MARKER = '__e2ee__'
export const E2EE_URI_PREFIX = 'allinone-e2ee://v1'

const AIO2_MAGIC = [0x41, 0x49, 0x4f, 0x32] // 'AIO2'
const AIO2_HEADER_BYTES = 12

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** @type {Map<string, Promise<{ cryptoKey: CryptoKey, keyId: string, rawBytes: Uint8Array }>>} */
const keyCache = new Map()
const MAX_KEY_CACHE = 32

export function isE2eeCryptoAvailable() {
  return Boolean(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues)
}

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array && bytes.constructor === Uint8Array) return bytes
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  return new Uint8Array(bytes)
}

export function bytesToBase64(bytes) {
  const u8 = toUint8Array(bytes)
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64')
  }
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(b64) {
  const clean = String(b64 || '').trim().replace(/\s+/g, '')
  if (!clean) return new Uint8Array(0)
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    const buf = Buffer.from(clean, 'base64')
    return Uint8Array.from(buf)
  }
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64UrlToBytes(str) {
  if (typeof str !== 'string' || !str) return null
  if (/\s/.test(str)) return null
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(str)) return null
  const eqIdx = str.indexOf('=')
  if (eqIdx !== -1 && str.length % 4 !== 0) return null
  const unpadded = eqIdx !== -1 ? str.slice(0, eqIdx) : str
  if (!unpadded || unpadded.length % 4 === 1) return null
  const std = unpadded.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (std.length % 4)) % 4
  const expectedLen = Math.floor(unpadded.length / 4) * 3 + (unpadded.length % 4 === 2 ? 1 : unpadded.length % 4 === 3 ? 2 : 0)
  try {
    const bytes = base64ToBytes(`${std}${'='.repeat(padLen)}`)
    if (bytes.byteLength !== expectedLen) return null
    return bytes
  } catch {
    return null
  }
}

export function generateE2eeKey() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Web Crypto getRandomValues is unavailable in this environment')
  }
  const bytes = new Uint8Array(E2EE_KEY_BYTES)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

export function normalizeE2eeKey(raw) {
  const clean = String(raw || '').trim().replace(/\s+/g, '')
  if (!clean) return ''
  const bytes = base64UrlToBytes(clean)
  if (!bytes || bytes.byteLength !== E2EE_KEY_BYTES) return ''
  return bytesToBase64Url(bytes)
}

export function formatE2eeFingerprint(keyId) {
  const hex = String(keyId || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '')
  if (!hex) return ''
  return (hex.slice(0, 16).match(/.{1,4}/g) || [hex]).join('-')
}

function bytesToHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

async function importCachedKey(rawKeyStr) {
  const normalized = normalizeE2eeKey(rawKeyStr)
  if (!normalized) {
    const err = new Error('无效的端到端加密密钥（应为 256-bit Base64URL 密钥）')
    err.code = 'E2EE_INVALID_KEY'
    throw err
  }
  if (!isE2eeCryptoAvailable()) {
    const err = new Error('当前环境不支持 Web Crypto API（请使用 HTTPS 或桌面端）')
    err.code = 'E2EE_UNAVAILABLE'
    throw err
  }
  let entry = keyCache.get(normalized)
  if (!entry) {
    if (keyCache.size >= MAX_KEY_CACHE) {
      const oldest = keyCache.keys().next().value
      if (oldest) keyCache.delete(oldest)
    }
    entry = (async () => {
      const rawBytes = base64UrlToBytes(normalized)
      const prefix = textEncoder.encode('allinone-e2ee-v1-id:')
      const idInput = new Uint8Array(prefix.length + rawBytes.length)
      idInput.set(prefix, 0)
      idInput.set(rawBytes, prefix.length)
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', idInput))
      const keyId = bytesToHex(digest.subarray(0, 8))
      const cryptoKey = await globalThis.crypto.subtle.importKey(
        'raw',
        rawBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
      return { cryptoKey, keyId, rawBytes }
    })()
    keyCache.set(normalized, entry)
    entry.catch(() => {
      if (keyCache.get(normalized) === entry) keyCache.delete(normalized)
    })
  }
  return entry
}

export async function computeE2eeKeyId(rawKeyStr) {
  const { keyId } = await importCachedKey(rawKeyStr)
  return keyId
}

function buildAad({ kind = 'msg', roomId = '', keyId = '' }) {
  return textEncoder.encode(`allinone-e2ee-v${E2EE_VERSION}|${String(kind || 'msg')}|${String(roomId || '')}|${String(keyId || '')}`)
}

export async function encryptBytes(rawKeyStr, plainBytes, { kind = 'upload', roomId = '' } = {}) {
  const { cryptoKey, keyId } = await importCachedKey(rawKeyStr)
  const iv = new Uint8Array(E2EE_IV_BYTES)
  globalThis.crypto.getRandomValues(iv)
  const input = toUint8Array(plainBytes)
  const aad = buildAad({ kind, roomId, keyId })
  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    cryptoKey,
    input,
  )
  return {
    v: E2EE_VERSION,
    kid: keyId,
    iv: bytesToBase64Url(iv),
    ciphertext: new Uint8Array(cipherBuf),
  }
}

export async function decryptBytes(rawKeyStr, cipherBytes, { iv, kid = '', kind = 'upload', roomId = '' } = {}) {
  const { cryptoKey, keyId } = await importCachedKey(rawKeyStr)
  if (kid && String(kid) !== keyId) {
    const err = new Error('端到端密钥不匹配，请重新扫码同步最新密钥')
    err.code = 'E2EE_KEY_MISMATCH'
    err.expectedKeyId = String(kid)
    throw err
  }
  const ivBytes = typeof iv === 'string' ? base64UrlToBytes(iv) : null
  if (!ivBytes || ivBytes.byteLength !== E2EE_IV_BYTES || bytesToBase64Url(ivBytes) !== iv) {
    const err = new Error('端到端密文 IV 无效')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
  const input = toUint8Array(cipherBytes)
  const aad = buildAad({ kind, roomId, keyId })
  try {
    const plainBuf = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes, additionalData: aad, tagLength: 128 },
      cryptoKey,
      input,
    )
    return new Uint8Array(plainBuf)
  } catch {
    const err = new Error('端到端解密失败：密钥不匹配或密文已被篡改')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
}

function writeUint32BE(buf, offset, val) {
  const n = val >>> 0
  buf[offset] = (n >>> 24) & 0xff
  buf[offset + 1] = (n >>> 16) & 0xff
  buf[offset + 2] = (n >>> 8) & 0xff
  buf[offset + 3] = n & 0xff
}

function readUint32BE(buf, offset) {
  return (
    ((buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3]) >>>
    0
  )
}

function deriveChunkIv(baseIv, chunkIndex) {
  const iv = new Uint8Array(E2EE_IV_BYTES)
  iv.set(baseIv)
  const idx = chunkIndex >>> 0
  iv[8] ^= (idx >>> 24) & 0xff
  iv[9] ^= (idx >>> 16) & 0xff
  iv[10] ^= (idx >>> 8) & 0xff
  iv[11] ^= idx & 0xff
  return iv
}

function buildChunkAad({ kind = 'upload', roomId = '', keyId = '', chunkIndex = 0, totalChunks = 1 }) {
  return textEncoder.encode(
    `allinone-e2ee-v2|${String(kind || 'upload')}|${String(roomId || '')}|${String(keyId || '')}|${chunkIndex}|${totalChunks}`,
  )
}

export function isChunkedE2eeHeader(bytes) {
  if (!bytes || bytes.byteLength < 4) return false
  return (
    bytes[0] === AIO2_MAGIC[0] &&
    bytes[1] === AIO2_MAGIC[1] &&
    bytes[2] === AIO2_MAGIC[2] &&
    bytes[3] === AIO2_MAGIC[3]
  )
}

class ByteQueue {
  constructor() {
    this.parts = []
    this.headOffset = 0
    this.byteLength = 0
  }

  push(chunk) {
    if (!chunk || chunk.byteLength === 0) return
    this.parts.push(toUint8Array(chunk))
    this.byteLength += chunk.byteLength
  }

  peek(n) {
    if (this.byteLength < n) return null
    const out = new Uint8Array(n)
    let written = 0
    for (let i = 0; i < this.parts.length && written < n; i += 1) {
      const part = this.parts[i]
      const start = i === 0 ? this.headOffset : 0
      const avail = part.byteLength - start
      const take = Math.min(avail, n - written)
      out.set(part.subarray(start, start + take), written)
      written += take
    }
    return out
  }

  shift(n) {
    if (this.byteLength < n) return null
    if (n === 0) return new Uint8Array(0)
    const out = new Uint8Array(n)
    let written = 0
    while (written < n && this.parts.length > 0) {
      const head = this.parts[0]
      const avail = head.byteLength - this.headOffset
      const take = Math.min(avail, n - written)
      out.set(head.subarray(this.headOffset, this.headOffset + take), written)
      written += take
      this.headOffset += take
      this.byteLength -= take
      if (this.headOffset >= head.byteLength) {
        this.parts.shift()
        this.headOffset = 0
      }
    }
    return out
  }
}

async function* iterateByteSource(source) {
  if (!source) return
  if (source instanceof Uint8Array || ArrayBuffer.isView(source) || source instanceof ArrayBuffer) {
    yield toUint8Array(source)
    return
  }
  if (typeof source.getReader === 'function') {
    const reader = source.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) yield toUint8Array(value)
      }
    } finally {
      try { reader.releaseLock() } catch {}
    }
    return
  }
  if (typeof source[Symbol.asyncIterator] === 'function') {
    for await (const chunk of source) {
      if (chunk && chunk.byteLength > 0) yield toUint8Array(chunk)
    }
    return
  }
  throw new Error('不支持的密文输入源')
}

export async function encryptChunkedBytes(
  rawKeyStr,
  source,
  { kind = 'upload', roomId = '', chunkSize = E2EE_CHUNK_SIZE, onChunk = null, onHeader = null } = {},
) {
  const { cryptoKey, keyId } = await importCachedKey(rawKeyStr)
  const cleanChunkSize = Math.max(1024, Math.min(16 * 1024 * 1024, Math.floor(Number(chunkSize) || E2EE_CHUNK_SIZE)))

  let totalSize = 0
  let readSlice = null
  if (source && typeof source.readSlice === 'function' && Number.isFinite(source.totalSize)) {
    totalSize = Math.max(0, Math.floor(source.totalSize))
    readSlice = source.readSlice
  } else if (source && typeof source.slice === 'function' && Number.isFinite(source.size)) {
    totalSize = Math.max(0, Math.floor(source.size))
    readSlice = async (offset, len) => new Uint8Array(await source.slice(offset, offset + len).arrayBuffer())
  } else if (source instanceof Uint8Array || ArrayBuffer.isView(source) || source instanceof ArrayBuffer) {
    const u8 = toUint8Array(source)
    totalSize = u8.byteLength
    readSlice = async (offset, len) => u8.subarray(offset, offset + len)
  } else {
    throw new Error('不支持的明文输入源')
  }

  const totalChunks = Math.max(1, Math.ceil(totalSize / cleanChunkSize))
  const baseIv = new Uint8Array(E2EE_IV_BYTES)
  globalThis.crypto.getRandomValues(baseIv)
  const ivStr = bytesToBase64Url(baseIv)
  if (onHeader) {
    await onHeader({ v: E2EE_CHUNKED_VERSION, kid: keyId, iv: ivStr, chunked: true, totalChunks })
  }

  const header = new Uint8Array(AIO2_HEADER_BYTES)
  header.set(AIO2_MAGIC, 0)
  writeUint32BE(header, 4, cleanChunkSize)
  writeUint32BE(header, 8, totalChunks)

  const chunks = onChunk ? null : [header]
  let totalBytes = header.byteLength
  if (onChunk) await onChunk(header)

  for (let i = 0; i < totalChunks; i += 1) {
    const offset = i * cleanChunkSize
    const len = Math.min(cleanChunkSize, Math.max(0, totalSize - offset))
    const plainSlice = len > 0 ? toUint8Array(await readSlice(offset, len)) : new Uint8Array(0)
    const iv = deriveChunkIv(baseIv, i)
    const aad = buildChunkAad({ kind, roomId, keyId, chunkIndex: i, totalChunks })
    const cipherBuf = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      cryptoKey,
      plainSlice,
    )
    const cipherU8 = new Uint8Array(cipherBuf)
    const frame = new Uint8Array(4 + cipherU8.byteLength)
    writeUint32BE(frame, 0, cipherU8.byteLength)
    frame.set(cipherU8, 4)
    totalBytes += frame.byteLength
    if (onChunk) await onChunk(frame)
    else chunks.push(frame)
  }

  return {
    v: E2EE_CHUNKED_VERSION,
    kid: keyId,
    iv: bytesToBase64Url(baseIv),
    chunked: true,
    totalChunks,
    totalBytes,
    ...(chunks ? { chunks } : {}),
  }
}

export async function decryptChunkedStream(
  rawKeyStr,
  streamOrBytes,
  { iv, kid = '', kind = 'upload', roomId = '', onPlainChunk = null } = {},
) {
  const { cryptoKey, keyId } = await importCachedKey(rawKeyStr)
  if (kid && String(kid) !== keyId) {
    const err = new Error('端到端密钥不匹配，请重新扫码同步最新密钥')
    err.code = 'E2EE_KEY_MISMATCH'
    err.expectedKeyId = String(kid)
    throw err
  }
  const baseIv = typeof iv === 'string' ? base64UrlToBytes(iv, E2EE_IV_BYTES) : null
  if (!baseIv || baseIv.byteLength !== E2EE_IV_BYTES || bytesToBase64Url(baseIv) !== iv) {
    const err = new Error('端到端密文 IV 无效')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }

  const queue = new ByteQueue()
  let headerParsed = false
  let chunkSize = 0
  let totalChunks = 0
  let chunkIndex = 0
  let nextFrameLen = -1
  let totalPlainBytes = 0
  const plainChunks = onPlainChunk ? null : []

  const drainFrames = async () => {
    while (true) {
      if (!headerParsed) {
        if (queue.byteLength < AIO2_HEADER_BYTES) return
        const hdr = queue.shift(AIO2_HEADER_BYTES)
        if (!isChunkedE2eeHeader(hdr)) {
          const err = new Error('端到端分块密文头无效')
          err.code = 'E2EE_DECRYPT_FAILED'
          throw err
        }
        chunkSize = readUint32BE(hdr, 4)
        totalChunks = readUint32BE(hdr, 8)
        if (chunkSize < 1024 || chunkSize > 16 * 1024 * 1024 || totalChunks < 1) {
          const err = new Error('端到端分块密文参数非法')
          err.code = 'E2EE_DECRYPT_FAILED'
          throw err
        }
        headerParsed = true
      }

      if (chunkIndex >= totalChunks) return

      if (nextFrameLen === -1) {
        if (queue.byteLength < 4) return
        const lenBuf = queue.shift(4)
        nextFrameLen = readUint32BE(lenBuf, 0)
        if (nextFrameLen < 16 || nextFrameLen > chunkSize + 16) {
          const err = new Error('端到端分块密文帧长度非法')
          err.code = 'E2EE_DECRYPT_FAILED'
          throw err
        }
      }

      if (queue.byteLength < nextFrameLen) return
      const cipherFrame = queue.shift(nextFrameLen)
      nextFrameLen = -1

      const chunkIv = deriveChunkIv(baseIv, chunkIndex)
      const aad = buildChunkAad({ kind, roomId, keyId, chunkIndex, totalChunks })
      let plainBuf
      try {
        plainBuf = await globalThis.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: chunkIv, additionalData: aad, tagLength: 128 },
          cryptoKey,
          cipherFrame,
        )
      } catch {
        const err = new Error('端到端分块解密失败：密钥不匹配或密文已被篡改')
        err.code = 'E2EE_DECRYPT_FAILED'
        throw err
      }
      const plainU8 = new Uint8Array(plainBuf)
      totalPlainBytes += plainU8.byteLength
      chunkIndex += 1
      if (onPlainChunk) await onPlainChunk(plainU8)
      else plainChunks.push(plainU8)
    }
  }

  for await (const rawChunk of iterateByteSource(streamOrBytes)) {
    queue.push(rawChunk)
    await drainFrames()
  }
  await drainFrames()

  if (!headerParsed || chunkIndex !== totalChunks || queue.byteLength !== 0 || nextFrameLen !== -1) {
    const err = new Error('端到端分块密文不完整或已被截断')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }

  return { totalPlainBytes, ...(plainChunks ? { chunks: plainChunks } : {}) }
}

export async function decryptAutoStream(
  rawKeyStr,
  streamOrBytes,
  { iv, kid = '', kind = 'upload', roomId = '', chunked = false, onPlainChunk = null } = {},
) {
  if (chunked) {
    return decryptChunkedStream(rawKeyStr, streamOrBytes, { iv, kid, kind, roomId, onPlainChunk })
  }
  if (streamOrBytes instanceof Uint8Array || ArrayBuffer.isView(streamOrBytes) || streamOrBytes instanceof ArrayBuffer) {
    const u8 = toUint8Array(streamOrBytes)
    if (isChunkedE2eeHeader(u8)) {
      return decryptChunkedStream(rawKeyStr, u8, { iv, kid, kind, roomId, onPlainChunk })
    }
    const plain = await decryptBytes(rawKeyStr, u8, { iv, kid, kind, roomId })
    if (onPlainChunk) {
      await onPlainChunk(plain)
      return { totalPlainBytes: plain.byteLength }
    }
    return { totalPlainBytes: plain.byteLength, chunks: [plain] }
  }

  const iter = iterateByteSource(streamOrBytes)[Symbol.asyncIterator]()
  const preQueue = new ByteQueue()
  let done = false
  while (preQueue.byteLength < 4) {
    const step = await iter.next()
    if (step.done) {
      done = true
      break
    }
    preQueue.push(step.value)
  }
  const head4 = preQueue.peek(4)
  const replayStream = (async function* () {
    const buffered = preQueue.shift(preQueue.byteLength)
    if (buffered && buffered.byteLength > 0) yield buffered
    if (done) return
    while (true) {
      const step = await iter.next()
      if (step.done) break
      yield step.value
    }
  })()

  if (head4 && isChunkedE2eeHeader(head4)) {
    return decryptChunkedStream(rawKeyStr, replayStream, { iv, kid, kind, roomId, onPlainChunk })
  }

  const parts = []
  let total = 0
  for await (const c of replayStream) {
    parts.push(c)
    total += c.byteLength
  }
  const full = new Uint8Array(total)
  let pos = 0
  for (const c of parts) {
    full.set(c, pos)
    pos += c.byteLength
  }
  const plain = await decryptBytes(rawKeyStr, full, { iv, kid, kind, roomId })
  if (onPlainChunk) {
    await onPlainChunk(plain)
    return { totalPlainBytes: plain.byteLength }
  }
  return { totalPlainBytes: plain.byteLength, chunks: [plain] }
}

export async function encryptJson(rawKeyStr, data, { kind = 'msg', roomId = '' } = {}) {
  const plainBytes = textEncoder.encode(JSON.stringify(data))
  const { v, kid, iv, ciphertext } = await encryptBytes(rawKeyStr, plainBytes, { kind, roomId })
  return {
    v,
    kid,
    iv,
    ct: bytesToBase64Url(ciphertext),
  }
}

export async function decryptJson(rawKeyStr, envelope, { kind = 'msg', roomId = '' } = {}) {
  if (!envelope || typeof envelope !== 'object' || envelope.v !== E2EE_VERSION || !envelope.iv || !envelope.ct) {
    const err = new Error('端到端密文格式无效')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
  const cipherBytes = base64UrlToBytes(envelope.ct)
  if (!cipherBytes || cipherBytes.byteLength < 16) {
    const err = new Error('端到端密文损坏')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
  const plainBytes = await decryptBytes(rawKeyStr, cipherBytes, {
    iv: envelope.iv,
    kid: envelope.kid || '',
    kind,
    roomId,
  })
  try {
    return JSON.parse(textDecoder.decode(plainBytes))
  } catch {
    const err = new Error('端到端明文解析失败')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
}

/**
 * Encode an offline-only QR sync URI containing the 256-bit room key.
 * Uses a custom scheme (`allinone-e2ee://v1`) so the key is never sent over HTTP or logged in browser URL history.
 */
export function encodeE2eeQrUri({ key, roomId = '' } = {}) {
  const normalized = normalizeE2eeKey(key)
  if (!normalized) throw new Error('Invalid E2EE key')
  const params = new URLSearchParams()
  params.set('k', normalized)
  if (roomId) params.set('r', String(roomId).trim())
  return `${E2EE_URI_PREFIX}?${params.toString()}`
}
