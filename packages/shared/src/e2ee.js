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
export const E2EE_BIN_HEADER_BYTES = 1 + 8 + E2EE_IV_BYTES // 21 bytes: [1B v][8B kid][12B iv]
export const E2EE_CHUNK_SIZE = 4 * 1024 * 1024
export const E2EE_CHUNKED_THRESHOLD = 32 * 1024 * 1024
export const E2EE_URI_PREFIX = 'allinone-e2ee://v1'
export const E2EE_GRANT_URI_PREFIX = 'allinone-e2ee-grant://v1'

const AIO2_MAGIC = [0x41, 0x49, 0x4f, 0x32] // 'AIO2'
const AIO2_HEADER_BYTES = 12
const COMPRESS_MIN_BYTES = 512
const MAX_INFLATE_JSON_BYTES = 16 * 1024 * 1024
const PAYLOAD_FLAG_RAW = 0x00
const PAYLOAD_FLAG_DEFLATE_RAW = 0x01

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const INCOMPRESSIBLE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif',
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v',
  '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar',
  '.apk', '.dmg', '.pkg', '.woff2', '.epub',
])

const INCOMPRESSIBLE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
  'image/avif', 'image/heic', 'image/heif',
  'application/zip', 'application/x-zip-compressed',
  'application/gzip', 'application/x-gzip', 'application/x-bzip2',
  'application/x-xz', 'application/zstd', 'application/x-7z-compressed',
  'application/vnd.rar', 'application/x-rar-compressed',
  'application/vnd.android.package-archive', 'application/epub+zip',
  'font/woff2',
])

export function isDeflateAvailable() {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
}

/**
 * Decide whether an `aio-bulk` file transfer benefits from per-chunk `deflate-raw` compression.
 * Skips already-compressed binary formats (JPEG/PNG/WebP/video/audio/archives) to save CPU.
 */
export function isCompressibleFile(mimeType = '', filename = '') {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase()
  if (mime.startsWith('video/') || mime.startsWith('audio/') || INCOMPRESSIBLE_MIMES.has(mime)) {
    return false
  }
  const cleanName = String(filename || '').trim().toLowerCase()
  const dotIdx = cleanName.lastIndexOf('.')
  if (dotIdx >= 0) {
    const ext = cleanName.slice(dotIdx)
    if (INCOMPRESSIBLE_EXTS.has(ext)) return false
  }
  return true
}

function concatUint8Arrays(parts, totalLen) {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(totalLen)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

export async function deflateRawBytes(input) {
  const u8 = toUint8Array(input)
  if (u8.byteLength === 0) return new Uint8Array(0)
  const cs = new CompressionStream('deflate-raw')
  const writer = cs.writable.getWriter()
  const reader = cs.readable.getReader()
  const parts = []
  let total = 0

  const writeTask = (async () => {
    await writer.write(u8)
    await writer.close()
  })()

  const readTask = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        const chunk = toUint8Array(value)
        parts.push(chunk)
        total += chunk.byteLength
      }
    }
  })()

  await Promise.all([writeTask, readTask])
  return concatUint8Arrays(parts, total)
}

export async function inflateRawBytes(input, maxBytes = MAX_INFLATE_JSON_BYTES) {
  const u8 = toUint8Array(input)
  if (u8.byteLength === 0) return new Uint8Array(0)
  const ds = new DecompressionStream('deflate-raw')
  const writer = ds.writable.getWriter()
  const reader = ds.readable.getReader()
  const parts = []
  let total = 0
  let overflowErr = null

  const writeTask = (async () => {
    try {
      await writer.write(u8)
      await writer.close()
    } catch (err) {
      if (!overflowErr) throw err
    }
  })()

  const readTask = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        const chunk = toUint8Array(value)
        total += chunk.byteLength
        if (total > maxBytes) {
          overflowErr = new Error('端到端压缩数据超出安全大小上限')
          overflowErr.code = 'E2EE_DECRYPT_FAILED'
          try { await reader.cancel(overflowErr) } catch {}
          try { await writer.abort(overflowErr) } catch {}
          throw overflowErr
        }
        parts.push(chunk)
      }
    }
  })()

  try {
    await Promise.all([writeTask, readTask])
  } catch (err) {
    if (overflowErr) throw overflowErr
    const wrapped = new Error('端到端压缩数据解压失败')
    wrapped.code = 'E2EE_DECRYPT_FAILED'
    throw wrapped
  }
  return concatUint8Arrays(parts, total)
}

async function packJsonBytes(data) {
  const utf8 = textEncoder.encode(JSON.stringify(data))
  if (utf8.byteLength >= COMPRESS_MIN_BYTES && isDeflateAvailable()) {
    try {
      const deflated = await deflateRawBytes(utf8)
      if (deflated.byteLength + 16 < utf8.byteLength) {
        const out = new Uint8Array(1 + deflated.byteLength)
        out[0] = PAYLOAD_FLAG_DEFLATE_RAW
        out.set(deflated, 1)
        return out
      }
    } catch {}
  }
  const out = new Uint8Array(1 + utf8.byteLength)
  out[0] = PAYLOAD_FLAG_RAW
  out.set(utf8, 1)
  return out
}

async function unpackJsonBytes(plainBytes) {
  const u8 = toUint8Array(plainBytes)
  if (u8.byteLength < 2) {
    const err = new Error('端到端明文格式无效')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
  const flag = u8[0]
  let utf8
  if (flag === PAYLOAD_FLAG_RAW) {
    utf8 = u8.subarray(1)
  } else if (flag === PAYLOAD_FLAG_DEFLATE_RAW) {
    if (!isDeflateAvailable()) {
      const err = new Error('当前环境不支持 deflate-raw 解压')
      err.code = 'E2EE_DECRYPT_FAILED'
      throw err
    }
    utf8 = await inflateRawBytes(u8.subarray(1), MAX_INFLATE_JSON_BYTES)
  } else {
    const err = new Error('端到端明文压缩标识无效')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
  try {
    return JSON.parse(textDecoder.decode(utf8))
  } catch {
    const err = new Error('端到端明文解析失败')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
}

/** @type {Map<string, Promise<{ cryptoKey: CryptoKey, keyId: string, keyIdBytes: Uint8Array }>>} */
const keyCache = new Map()
const MAX_KEY_CACHE = 32

export function isE2eeCryptoAvailable() {
  return Boolean(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues)
}

function toUint8Array(x) {
  if (x instanceof Uint8Array && x.constructor === Uint8Array) return x
  if (ArrayBuffer.isView(x)) {
    return new Uint8Array(x.buffer, x.byteOffset, x.byteLength)
  }
  if (x instanceof ArrayBuffer) {
    return new Uint8Array(x)
  }
  throw new TypeError('Expected Uint8Array, ArrayBufferView, or ArrayBuffer')
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

export function base64UrlToBytes(str, expectedByteLength) {
  if (typeof str !== 'string' || !str) return null
  if (/\s/.test(str)) return null
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(str)) return null
  const eqIdx = str.indexOf('=')
  if (eqIdx !== -1 && str.length % 4 !== 0) return null
  const unpadded = eqIdx !== -1 ? str.slice(0, eqIdx) : str
  if (!unpadded || unpadded.length % 4 === 1) return null
  const std = unpadded.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (std.length % 4)) % 4
  if (eqIdx !== -1 && str.length - eqIdx !== padLen) return null
  const expectedLen =
    Math.floor(unpadded.length / 4) * 3 +
    (unpadded.length % 4 === 2 ? 1 : unpadded.length % 4 === 3 ? 2 : 0)
  if (Number.isInteger(expectedByteLength) && expectedLen !== expectedByteLength) return null
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
      try {
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', idInput))
        const keyIdBytes = digest.slice(0, 8)
        const keyId = bytesToHex(keyIdBytes)
        const cryptoKey = await globalThis.crypto.subtle.importKey(
          'raw',
          rawBytes,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        )
        return { cryptoKey, keyId, keyIdBytes }
      } finally {
        rawBytes.fill(0)
        idInput.fill(0)
      }
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
  const ivBytes = typeof iv === 'string' ? base64UrlToBytes(iv, E2EE_IV_BYTES) : null
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
  if (!Number.isInteger(val) || val < 0 || val > 0xffffffff) {
    throw new RangeError(`uint32 value out of range: ${val}`)
  }
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
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffffffff) {
    throw new RangeError(`Chunk index exceeds uint32 range: ${chunkIndex}`)
  }
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

/**
 * Streaming-friendly chunked AES-256-GCM encryption (`AIO2` container, 4 MB chunks).
 * Supports Blob/File, Uint8Array/ArrayBuffer, or `{ totalSize, readSlice(offset, len) }`.
 * Keeps constant ~12 MB crypto memory even for 100 MB - 1 GB files.
 */
export async function encryptChunkedBytes(
  rawKeyStr,
  source,
  { kind = 'upload', roomId = '', chunkSize = E2EE_CHUNK_SIZE, compress = false, onChunk = null, onHeader = null } = {},
) {
  const { cryptoKey, keyId } = await importCachedKey(rawKeyStr)
  const cleanChunkSize = Math.max(1024, Math.min(16 * 1024 * 1024, Math.floor(Number(chunkSize) || E2EE_CHUNK_SIZE)))
  const useCompress = Boolean(compress && isDeflateAvailable())

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
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > 0xffffffff) {
    const err = new RangeError('端到端分块数量超出 uint32 安全上限')
    err.code = 'E2EE_CHUNK_LIMIT_EXCEEDED'
    throw err
  }
  const baseIv = new Uint8Array(E2EE_IV_BYTES)
  globalThis.crypto.getRandomValues(baseIv)
  const ivStr = bytesToBase64Url(baseIv)
  if (onHeader) {
    await onHeader({
      v: E2EE_CHUNKED_VERSION,
      kid: keyId,
      iv: ivStr,
      chunked: true,
      totalChunks,
      ...(useCompress ? { compressed: true } : {}),
    })
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
    let payloadToEncrypt = plainSlice
    if (useCompress) {
      let deflated = null
      if (plainSlice.byteLength >= COMPRESS_MIN_BYTES) {
        try {
          const cand = await deflateRawBytes(plainSlice)
          if (cand.byteLength + 32 < plainSlice.byteLength && cand.byteLength < plainSlice.byteLength * 0.96) {
            deflated = cand
          }
        } catch {}
      }
      if (deflated) {
        payloadToEncrypt = new Uint8Array(1 + deflated.byteLength)
        payloadToEncrypt[0] = PAYLOAD_FLAG_DEFLATE_RAW
        payloadToEncrypt.set(deflated, 1)
      } else {
        payloadToEncrypt = new Uint8Array(1 + plainSlice.byteLength)
        payloadToEncrypt[0] = PAYLOAD_FLAG_RAW
        payloadToEncrypt.set(plainSlice, 1)
      }
    }
    const iv = deriveChunkIv(baseIv, i)
    const aad = buildChunkAad({ kind, roomId, keyId, chunkIndex: i, totalChunks })
    const cipherBuf = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      cryptoKey,
      payloadToEncrypt,
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
    ...(useCompress ? { compressed: true } : {}),
    ...(chunks ? { chunks } : {}),
  }
}

/**
 * Streaming decryption for `AIO2` chunked AES-256-GCM containers.
 * Validates header magic, per-chunk AAD/order, total chunk count, and zero trailing bytes.
 */
export async function decryptChunkedStream(
  rawKeyStr,
  streamOrBytes,
  { iv, kid = '', kind = 'upload', roomId = '', compressed = false, onPlainChunk = null } = {},
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
  const isCompressed = Boolean(compressed)

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

      if (chunkIndex >= totalChunks) {
        if (queue.byteLength > 0) {
          const err = new Error('端到端分块密文包含多余尾部数据')
          err.code = 'E2EE_DECRYPT_FAILED'
          throw err
        }
        return
      }

      if (nextFrameLen === -1) {
        if (queue.byteLength < 4) return
        const lenBuf = queue.shift(4)
        nextFrameLen = readUint32BE(lenBuf, 0)
        const maxFrameBytes = chunkSize + (isCompressed ? 1 : 0) + 16
        if (nextFrameLen < 16 || nextFrameLen > maxFrameBytes) {
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
      let plainU8 = new Uint8Array(plainBuf)
      if (isCompressed) {
        if (plainU8.byteLength < 1) {
          const err = new Error('端到端分块压缩帧无效')
          err.code = 'E2EE_DECRYPT_FAILED'
          throw err
        }
        const flag = plainU8[0]
        if (flag === PAYLOAD_FLAG_RAW) {
          plainU8 = plainU8.subarray(1)
        } else if (flag === PAYLOAD_FLAG_DEFLATE_RAW) {
          plainU8 = await inflateRawBytes(plainU8.subarray(1), chunkSize)
        } else {
          const err = new Error('端到端分块压缩标识无效')
          err.code = 'E2EE_DECRYPT_FAILED'
          throw err
        }
      }
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

/**
 * Automatically decrypt either v1 single-shot AES-GCM (`encryptBytes`) or v2 `AIO2` chunked streams.
 */
export async function decryptAutoStream(
  rawKeyStr,
  streamOrBytes,
  { iv, kid = '', kind = 'upload', roomId = '', chunked = false, compressed = false, onPlainChunk = null } = {},
) {
  if (chunked) {
    return decryptChunkedStream(rawKeyStr, streamOrBytes, { iv, kid, kind, roomId, compressed, onPlainChunk })
  }
  if (streamOrBytes instanceof Uint8Array || ArrayBuffer.isView(streamOrBytes) || streamOrBytes instanceof ArrayBuffer) {
    const u8 = toUint8Array(streamOrBytes)
    if (isChunkedE2eeHeader(u8)) {
      return decryptChunkedStream(rawKeyStr, u8, { iv, kid, kind, roomId, compressed, onPlainChunk })
    }
    const plain = await decryptBytes(rawKeyStr, u8, { iv, kid, kind, roomId })
    if (onPlainChunk) {
      await onPlainChunk(plain)
      return { totalPlainBytes: plain.byteLength }
    }
    return { totalPlainBytes: plain.byteLength, chunks: [plain] }
  }

  // Peek first 4 bytes from stream to detect AIO2 vs v1 cleanly
  const iter = iterateByteSource(streamOrBytes)[Symbol.asyncIterator]()
  let iterDone = false
  let iterClosed = false
  const closeIter = async () => {
    if (iterDone || iterClosed) return
    iterClosed = true
    try {
      await iter.return?.()
    } catch {}
  }

  try {
    const preQueue = new ByteQueue()
    while (preQueue.byteLength < 4) {
      const step = await iter.next()
      if (step.done) {
        iterDone = true
        break
      }
      preQueue.push(step.value)
    }
    const head4 = preQueue.peek(4)
    const replayStream = (async function* () {
      try {
        const buffered = preQueue.shift(preQueue.byteLength)
        if (buffered && buffered.byteLength > 0) yield buffered
        if (iterDone) return
        while (true) {
          const step = await iter.next()
          if (step.done) {
            iterDone = true
            break
          }
          yield step.value
        }
      } finally {
        await closeIter()
      }
    })()

    if (head4 && isChunkedE2eeHeader(head4)) {
      return await decryptChunkedStream(rawKeyStr, replayStream, { iv, kid, kind, roomId, compressed, onPlainChunk })
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
  } finally {
    await closeIter()
  }
}

export async function encryptJson(rawKeyStr, data, { kind = 'msg', roomId = '' } = {}) {
  const plainBytes = await packJsonBytes(data)
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
  return unpackJsonBytes(plainBytes)
}

/**
 * Parse the 21-byte binary E2EE header without decrypting (for fast `kid` & replay `iv` checks):
 *   [0]      uint8  version (E2EE_VERSION = 1)
 *   [1..8]   8B     keyId bytes
 *   [9..20]  12B    AES-GCM IV bytes
 *   [21..N]  bytes  AES-256-GCM ciphertext (>= 16B tag)
 */
export function parseBinaryE2eeHeader(rawBytes) {
  if (!rawBytes || (!(rawBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(rawBytes))) return null
  const u8 = toUint8Array(rawBytes)
  if (u8.byteLength < E2EE_BIN_HEADER_BYTES + 16) return null
  const v = u8[0]
  if (v !== E2EE_VERSION) return null
  const kid = bytesToHex(u8.subarray(1, 9))
  const ivBytes = u8.subarray(9, 21)
  const iv = bytesToBase64Url(ivBytes)
  const ciphertext = u8.subarray(21)
  return { v, kid, iv, ivBytes, ciphertext }
}

/**
 * Compress (`deflate-raw` when >= 512 B) and AES-256-GCM encrypt a JSON payload into a raw binary
 * envelope with ZERO Base64URL overhead (used over P2P `aio-ctrl`).
 */
export async function encryptBinaryJson(rawKeyStr, data, { kind = 'msg', roomId = '' } = {}) {
  const { cryptoKey, keyId, keyIdBytes } = await importCachedKey(rawKeyStr)
  const iv = new Uint8Array(E2EE_IV_BYTES)
  globalThis.crypto.getRandomValues(iv)
  const plainBytes = await packJsonBytes(data)
  const aad = buildAad({ kind, roomId, keyId })
  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    cryptoKey,
    plainBytes,
  )
  const cipherU8 = new Uint8Array(cipherBuf)
  const bytes = new Uint8Array(E2EE_BIN_HEADER_BYTES + cipherU8.byteLength)
  bytes[0] = E2EE_VERSION
  bytes.set(keyIdBytes, 1)
  bytes.set(iv, 9)
  bytes.set(cipherU8, E2EE_BIN_HEADER_BYTES)
  return {
    v: E2EE_VERSION,
    kid: keyId,
    iv: bytesToBase64Url(iv),
    bytes,
  }
}

/**
 * Decrypt and decompress a binary E2EE JSON envelope produced by `encryptBinaryJson`.
 */
export async function decryptBinaryJson(rawKeyStr, rawBytes, { kind = 'msg', roomId = '' } = {}) {
  const hdr = parseBinaryE2eeHeader(rawBytes)
  if (!hdr) {
    const err = new Error('端到端二进制密文格式无效')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
  const { cryptoKey, keyId } = await importCachedKey(rawKeyStr)
  if (hdr.kid !== keyId) {
    const err = new Error('端到端密钥不匹配，请重新扫码同步最新密钥')
    err.code = 'E2EE_KEY_MISMATCH'
    err.expectedKeyId = hdr.kid
    throw err
  }
  const aad = buildAad({ kind, roomId, keyId })
  let plainBuf
  try {
    plainBuf = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hdr.ivBytes, additionalData: aad, tagLength: 128 },
      cryptoKey,
      hdr.ciphertext,
    )
  } catch {
    const err = new Error('端到端解密失败：密钥不匹配或密文已被篡改')
    err.code = 'E2EE_DECRYPT_FAILED'
    throw err
  }
  return unpackJsonBytes(new Uint8Array(plainBuf))
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

/**
 * Parse either a scanned `allinone-e2ee://v1?k=...&r=...` QR payload or a manually pasted 43-char Base64URL key.
 */
export function parseE2eeQrInput(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  if (text.toLowerCase().startsWith('allinone-e2ee://')) {
    try {
      const qIdx = text.indexOf('?')
      const query = qIdx !== -1 ? text.slice(qIdx + 1) : ''
      const params = new URLSearchParams(query)
      const key = normalizeE2eeKey(params.get('k') || '')
      if (!key) return null
      return {
        key,
        roomId: String(params.get('r') || '').trim(),
        isUri: true,
      }
    } catch {
      return null
    }
  }
  const key = normalizeE2eeKey(text)
  if (!key) return null
  return {
    key,
    roomId: '',
    isUri: false,
  }
}

// ---------------------------------------------------------------------------
// Zero-Knowledge Device-to-Device Key Grant (ECDH P-256 + HKDF-SHA256 + AES-256-GCM)
// Allows an already-unlocked device (e.g. Phone B) to securely transfer the E2EE
// keyring to a newly signed-in device (e.g. Computer C) without exposing plaintext
// keys to the Relay Server, clipboard, or chat apps.
// ---------------------------------------------------------------------------

const GRANT_SECRET_RE = /^[A-Za-z0-9_-]{16,44}$/

export function generateGrantReqId() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Web Crypto getRandomValues is unavailable')
  }
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

export function generateGrantSecret() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Web Crypto getRandomValues is unavailable')
  }
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

export function generateGrantNonce() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Web Crypto getRandomValues is unavailable')
  }
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

export async function computeGrantCommitment({ reqId, roomId = '', pubKey, nonce } = {}) {
  if (!isE2eeCryptoAvailable()) {
    throw new Error('当前环境不支持 Web Crypto API（请使用 HTTPS 或桌面端）')
  }
  const material = textEncoder.encode(
    `allinone-e2ee-grant-commit-v2|${String(roomId || '').trim()}|${String(reqId || '').trim()}|${String(pubKey || '').trim()}|${String(nonce || '').trim()}`,
  )
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', material))
  return bytesToHex(digest)
}

export async function computeGrantPubKeyFp(publicKeyRaw) {
  const bytes = base64UrlToBytes(publicKeyRaw)
  if (!bytes || bytes.byteLength !== 65 || bytes[0] !== 0x04) {
    throw new Error('无效的 ECDH 公钥格式')
  }
  const prefix = textEncoder.encode('allinone-e2ee-grant-v1-pub:')
  const input = new Uint8Array(prefix.length + bytes.length)
  input.set(prefix, 0)
  input.set(bytes, prefix.length)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input))
  return bytesToHex(digest.subarray(0, 8)) // 64-bit commitment (16 hex chars)
}

export async function generateGrantKeyPair() {
  if (!isE2eeCryptoAvailable()) {
    throw new Error('当前环境不支持 Web Crypto API（请使用 HTTPS 或桌面端）')
  }
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false, // private key stays non-extractable in memory
    ['deriveBits'],
  )
  const pubBuf = await globalThis.crypto.subtle.exportKey('raw', pair.publicKey)
  const publicKeyRaw = bytesToBase64Url(new Uint8Array(pubBuf))
  const publicKeyFp = await computeGrantPubKeyFp(publicKeyRaw)
  return {
    publicKeyRaw,
    publicKeyFp,
    privateKey: pair.privateKey,
  }
}

async function importGrantPublicKey(publicKeyRaw) {
  const bytes = base64UrlToBytes(publicKeyRaw)
  if (!bytes || bytes.byteLength !== 65 || bytes[0] !== 0x04) {
    const err = new Error('无效的 ECDH P-256 公钥')
    err.code = 'E2EE_GRANT_INVALID_PUBKEY'
    throw err
  }
  return globalThis.crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
}

/**
 * Derive a 6-digit Short Authentication String (SAS, e.g. "482-917") bound to BOTH
 * ephemeral public keys, the one-shot request ID, and the account room ID.
 * Both devices compute this independently; matching codes defeat active MITM by a compromised relay.
 */
export async function deriveGrantSas({
  requesterPubKey,
  approverPubKey,
  reqId,
  roomId = '',
  requesterNonce = '',
  approverNonce = '',
}) {
  const reqFp = await computeGrantPubKeyFp(requesterPubKey)
  const appFp = await computeGrantPubKeyFp(approverPubKey)
  const cleanRoom = String(roomId || '').trim()
  const cleanReq = String(reqId || '').trim()
  const cleanReqNonce = String(requesterNonce || '').trim()
  const cleanAppNonce = String(approverNonce || '').trim()
  const material = textEncoder.encode(
    cleanReqNonce || cleanAppNonce
      ? `allinone-e2ee-grant-sas-v2|${cleanRoom}|${cleanReq}|${reqFp}|${appFp}|${cleanReqNonce}|${cleanAppNonce}`
      : `allinone-e2ee-grant-sas-v1|${cleanRoom}|${cleanReq}|${reqFp}|${appFp}`,
  )
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', material))
  // Uniformly map 32-bit unsigned integer into 6 decimal digits (000000..999999)
  const num =
    (((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0) % 1_000_000
  const digits = String(num).padStart(6, '0')
  return `${digits.slice(0, 3)}-${digits.slice(3)}`
}

async function deriveGrantAesKey({
  localPrivateKey,
  peerPublicKeyRaw,
  reqId,
  roomId,
  reqFp,
  appFp,
  grantSecret = '',
}) {
  const peerPub = await importGrantPublicKey(peerPublicKeyRaw)
  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPub },
    localPrivateKey,
    256,
  )
  const hkdfBase = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  )
  const cleanSecret = String(grantSecret || '').trim()
  const salt = textEncoder.encode(`allinone-e2ee-grant-salt-v1|${String(reqId || '').trim()}`)
  const info = textEncoder.encode(
    `allinone-e2ee-grant-aes-v1|${String(roomId || '').trim()}|${reqFp}|${appFp}${cleanSecret ? `|qr:${cleanSecret}` : ''}`,
  )
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptGrantPayload({
  approverPrivateKey,
  approverPubKeyRaw,
  requesterPubKeyRaw,
  reqId,
  roomId = '',
  payload,
  grantSecret = '',
}) {
  const cleanReqId = String(reqId || '').trim()
  const cleanRoomId = String(roomId || '').trim()
  const cleanSecret = String(grantSecret || '').trim()
  const reqFp = await computeGrantPubKeyFp(requesterPubKeyRaw)
  const appFp = await computeGrantPubKeyFp(approverPubKeyRaw)
  const aesKey = await deriveGrantAesKey({
    localPrivateKey: approverPrivateKey,
    peerPublicKeyRaw: requesterPubKeyRaw,
    reqId: cleanReqId,
    roomId: cleanRoomId,
    reqFp,
    appFp,
    grantSecret: cleanSecret,
  })
  const iv = new Uint8Array(E2EE_IV_BYTES)
  globalThis.crypto.getRandomValues(iv)
  const aad = textEncoder.encode(
    `allinone-e2ee-grant-aad-v1|${cleanRoomId}|${cleanReqId}|${reqFp}|${appFp}${cleanSecret ? '|qr' : ''}`,
  )
  const plainBytes = textEncoder.encode(JSON.stringify(payload))
  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    aesKey,
    plainBytes,
  )
  return {
    v: E2EE_VERSION,
    reqId: cleanReqId,
    approverPubKey: approverPubKeyRaw,
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(new Uint8Array(cipherBuf)),
    ...(cleanSecret ? { mode: 'qr' } : {}),
  }
}

export async function decryptGrantPayload({
  requesterPrivateKey,
  requesterPubKeyRaw,
  envelope,
  roomId = '',
  expectedReqId = '',
  expectedApproverPubKey = '',
  grantSecret = '',
}) {
  if (!envelope || typeof envelope !== 'object' || envelope.v !== E2EE_VERSION || !envelope.approverPubKey || !envelope.iv || !envelope.ct) {
    const err = new Error('无效的设备授权密文包')
    err.code = 'E2EE_GRANT_DECRYPT_FAILED'
    throw err
  }
  const cleanReqId = String(envelope.reqId || '').trim()
  const cleanExpectedReqId = String(expectedReqId || '').trim()
  if (cleanExpectedReqId && cleanReqId !== cleanExpectedReqId) {
    const err = new Error('授权请求 ID 不匹配，已中止接收')
    err.code = 'E2EE_GRANT_REQID_MISMATCH'
    throw err
  }
  if (expectedApproverPubKey && String(envelope.approverPubKey).trim() !== String(expectedApproverPubKey).trim()) {
    const err = new Error('授权方公钥与安全码校验阶段不一致，已中止接收')
    err.code = 'E2EE_GRANT_PUBKEY_MISMATCH'
    throw err
  }
  const cleanRoomId = String(roomId || '').trim()
  const cleanSecret = String(grantSecret || '').trim()
  const reqFp = await computeGrantPubKeyFp(requesterPubKeyRaw)
  const appFp = await computeGrantPubKeyFp(envelope.approverPubKey)
  const aesKey = await deriveGrantAesKey({
    localPrivateKey: requesterPrivateKey,
    peerPublicKeyRaw: envelope.approverPubKey,
    reqId: cleanReqId,
    roomId: cleanRoomId,
    reqFp,
    appFp,
    grantSecret: cleanSecret,
  })
  const ivBytes = typeof envelope.iv === 'string' ? base64UrlToBytes(envelope.iv, E2EE_IV_BYTES) : null
  const ctBytes = base64UrlToBytes(envelope.ct)
  if (!ivBytes || ivBytes.byteLength !== E2EE_IV_BYTES || bytesToBase64Url(ivBytes) !== envelope.iv || !ctBytes || ctBytes.byteLength < 16) {
    const err = new Error('授权密文格式损坏')
    err.code = 'E2EE_GRANT_DECRYPT_FAILED'
    throw err
  }
  const aad = textEncoder.encode(
    `allinone-e2ee-grant-aad-v1|${cleanRoomId}|${cleanReqId}|${reqFp}|${appFp}${cleanSecret ? '|qr' : ''}`,
  )
  try {
    const plainBuf = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes, additionalData: aad, tagLength: 128 },
      aesKey,
      ctBytes,
    )
    return JSON.parse(textDecoder.decode(new Uint8Array(plainBuf)))
  } catch {
    const err = new Error('解密授权密钥包失败：安全校验未通过或已被篡改')
    err.code = 'E2EE_GRANT_DECRYPT_FAILED'
    throw err
  }
}

/**
 * Encode a Reverse-Auth QR URI displayed by a NEW device (e.g. Computer C)
 * so an already-unlocked phone (Phone B) can scan & authorize it with out-of-band MITM protection.
 */
export function encodeE2eeGrantQrUri({ reqId, roomId = '', pubKeyFp, grantSecret = '' }) {
  const cleanId = String(reqId || '').trim()
  const cleanFp = String(pubKeyFp || '').trim().toLowerCase()
  const cleanSecret = String(grantSecret || '').trim()
  if (!cleanId || !/^[0-9a-f]{16}$/.test(cleanFp)) {
    throw new Error('Invalid E2EE grant QR parameters')
  }
  if (cleanSecret && !GRANT_SECRET_RE.test(cleanSecret)) {
    throw new Error('Invalid E2EE grant QR parameters')
  }
  const params = new URLSearchParams()
  params.set('id', cleanId)
  params.set('p', cleanFp)
  if (roomId) params.set('r', String(roomId).trim())
  if (cleanSecret) params.set('s', cleanSecret)
  return `${E2EE_GRANT_URI_PREFIX}?${params.toString()}`
}

export function parseE2eeGrantQrInput(raw) {
  const text = String(raw || '').trim()
  if (!text || !text.toLowerCase().startsWith('allinone-e2ee-grant://')) return null
  try {
    const qIdx = text.indexOf('?')
    const query = qIdx !== -1 ? text.slice(qIdx + 1) : ''
    const params = new URLSearchParams(query)
    const reqId = String(params.get('id') || '').trim()
    const pubKeyFp = String(params.get('p') || '').trim().toLowerCase()
    const roomId = String(params.get('r') || '').trim()
    const rawSecret = params.get('s')
    const grantSecret = rawSecret == null ? '' : String(rawSecret).trim()
    if (!reqId || !/^[0-9a-f]{16,32}$/.test(reqId) || !/^[0-9a-f]{16}$/.test(pubKeyFp)) {
      return null
    }
    if (rawSecret != null && (!grantSecret || !GRANT_SECRET_RE.test(grantSecret))) {
      return null
    }
    return { reqId, pubKeyFp, roomId, grantSecret }
  } catch {
    return null
  }
}
