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
export const E2EE_KEY_BYTES = 32
export const E2EE_IV_BYTES = 12
export const E2EE_METHOD_MARKER = '__e2ee__'
export const E2EE_EVENT_MARKER = '__e2ee__'
export const E2EE_URI_PREFIX = 'allinone-e2ee://v1'

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
