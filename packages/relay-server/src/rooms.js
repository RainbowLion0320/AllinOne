import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeEqual } from './auth.js'

const PAIR_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // No 0/O/1/I ambiguity
const PAIR_TTL_MS = 15 * 60 * 1000 // 15 minutes
const ROOM_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days
const MAX_ROOMS = 500

function sha256Hex(val) {
  return createHash('sha256').update(String(val ?? ''), 'utf8').digest('hex')
}

function generatePairCode() {
  const bytes = randomBytes(8)
  let raw = ''
  for (let i = 0; i < 8; i += 1) {
    raw += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length]
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

export function normalizePairCode(input) {
  const clean = String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (clean.length !== 8) return ''
  return `${clean.slice(0, 4)}-${clean.slice(4)}`
}

/**
 * Lightweight, secret-safe multi-tenant room registry.
 * Persists ONLY salted SHA-256 hashes (never plaintext bridge secrets or pairing tokens)
 * so each friend's PC & mobile phone live inside a strictly isolated room.
 */
export function createRoomStore({ filePath }) {
  mkdirSync(dirname(filePath), { recursive: true })

  /** @type {Map<string, any>} */
  const rooms = new Map()
  let ownerTokenVersion = 0

  function load() {
    if (!existsSync(filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (Number.isFinite(Number(parsed?.ownerTokenVersion))) {
        ownerTokenVersion = Math.max(0, Math.floor(Number(parsed.ownerTokenVersion)))
      }
      if (Array.isArray(parsed?.rooms)) {
        for (const r of parsed.rooms) {
          if (r?.roomId) {
            rooms.set(r.roomId, {
              ...r,
              tokenVersion: Number.isFinite(Number(r.tokenVersion)) ? Math.max(0, Math.floor(Number(r.tokenVersion))) : 0,
              pairedCount: Number.isFinite(Number(r.pairedCount)) ? Math.max(0, Math.floor(Number(r.pairedCount))) : 0,
            })
          }
        }
      }
    } catch {}
  }

  function save() {
    const cutoff = Date.now() - ROOM_IDLE_TTL_MS
    for (const [id, r] of rooms.entries()) {
      if ((r.lastSeenAt || r.createdAt || 0) < cutoff) {
        rooms.delete(id)
      }
    }
    if (rooms.size > MAX_ROOMS) {
      // Evict never-paired rooms first so registration floods cannot evict active paired rooms
      const sorted = [...rooms.values()].sort((a, b) => {
        const aPaired = (a.pairedCount || 0) > 0 ? 1 : 0
        const bPaired = (b.pairedCount || 0) > 0 ? 1 : 0
        if (aPaired !== bPaired) return aPaired - bPaired
        return (a.lastSeenAt || 0) - (b.lastSeenAt || 0)
      })
      for (const stale of sorted.slice(0, rooms.size - MAX_ROOMS)) {
        rooms.delete(stale.roomId)
      }
    }
    const payload = JSON.stringify(
      { version: 2, ownerTokenVersion, rooms: [...rooms.values()] },
      null,
      2,
    )
    writeFileSync(filePath, payload, 'utf8')
    try { chmodSync(filePath, 0o600) } catch {}
  }

  load()

  function registerRoom({ label = 'My PC' } = {}) {
    const roomId = `rm_${randomBytes(8).toString('hex')}`
    const bridgeSecret = `br_${randomBytes(24).toString('hex')}`
    const pairCode = generatePairCode()
    const pairToken = `pt_${randomBytes(20).toString('hex')}`
    const now = Date.now()
    const pairExpiresAt = now + PAIR_TTL_MS

    const record = {
      roomId,
      label: String(label || 'My PC').trim().slice(0, 64) || 'My PC',
      bridgeSecretHash: sha256Hex(`${roomId}:${bridgeSecret}`),
      pairCodeHash: sha256Hex(pairCode),
      pairTokenHash: sha256Hex(pairToken),
      pairExpiresAt,
      tokenVersion: 0,
      pairedCount: 0,
      createdAt: now,
      lastSeenAt: now,
    }
    rooms.set(roomId, record)
    save()

    return {
      roomId,
      label: record.label,
      bridgeSecret,
      pairCode,
      pairToken,
      pairExpiresAt,
    }
  }

  function verifyBridge(roomId, secret) {
    if (!roomId || !secret) return false
    const record = rooms.get(roomId)
    if (!record) return false
    const candidateHash = sha256Hex(`${roomId}:${secret}`)
    if (!safeEqual(candidateHash, record.bridgeSecretHash)) return false
    record.lastSeenAt = Date.now()
    return true
  }

  function refreshPairCode(roomId, secret) {
    if (!verifyBridge(roomId, secret)) return null
    const record = rooms.get(roomId)
    const pairCode = generatePairCode()
    const pairToken = `pt_${randomBytes(20).toString('hex')}`
    const pairExpiresAt = Date.now() + PAIR_TTL_MS

    record.pairCodeHash = sha256Hex(pairCode)
    record.pairTokenHash = sha256Hex(pairToken)
    record.pairExpiresAt = pairExpiresAt
    record.lastSeenAt = Date.now()
    save()

    return {
      roomId,
      label: record.label,
      pairCode,
      pairToken,
      pairExpiresAt,
    }
  }

  function exchangePair({ pairCode = '', pairToken = '' } = {}) {
    const now = Date.now()
    const cleanToken = String(pairToken || '').trim()
    const cleanCode = normalizePairCode(pairCode)

    if (!cleanToken && !cleanCode) {
      return { ok: false, error: '请输入 8 位配对码或扫描二维码' }
    }

    const tokenHash = cleanToken ? sha256Hex(cleanToken) : ''
    const codeHash = cleanCode ? sha256Hex(cleanCode) : ''

    for (const record of rooms.values()) {
      const matched =
        (tokenHash && record.pairTokenHash && safeEqual(tokenHash, record.pairTokenHash)) ||
        (codeHash && record.pairCodeHash && safeEqual(codeHash, record.pairCodeHash))
      if (!matched) continue

      if (now > (record.pairExpiresAt || 0)) {
        return { ok: false, error: '配对码已过期（有效期 15 分钟），请在电脑端按回车刷新一个新配对码' }
      }
      // Strictly single-use: burn pairCode and pairToken immediately after successful redemption
      record.pairCodeHash = ''
      record.pairTokenHash = ''
      record.pairExpiresAt = 0
      record.pairedCount = Number(record.pairedCount || 0) + 1
      record.lastSeenAt = now
      save()
      return {
        ok: true,
        roomId: record.roomId,
        label: record.label,
        tokenVersion: Number(record.tokenVersion || 0),
      }
    }

    return { ok: false, error: '配对码无效或已被使用，请在电脑端按回车刷新一个新配对码' }
  }

  function getTokenVersion(roomId) {
    if (!roomId || roomId === 'owner') return ownerTokenVersion
    const record = rooms.get(roomId)
    if (!record) return -1
    return Number(record.tokenVersion || 0)
  }

  function revokeRoomTokens(roomId) {
    if (!roomId || roomId === 'owner') {
      ownerTokenVersion += 1
      save()
      return { roomId: 'owner', tokenVersion: ownerTokenVersion }
    }
    const record = rooms.get(roomId)
    if (!record) return null
    record.tokenVersion = Number(record.tokenVersion || 0) + 1
    // Also invalidate any unredeemed pairing link/code for this room
    record.pairCodeHash = ''
    record.pairTokenHash = ''
    record.pairExpiresAt = 0
    record.lastSeenAt = Date.now()
    save()
    return { roomId: record.roomId, tokenVersion: record.tokenVersion }
  }

  function getRoomMeta(roomId) {
    if (!roomId || roomId === 'owner') return null
    const record = rooms.get(roomId)
    if (!record) return null
    return {
      roomId: record.roomId,
      label: record.label || '',
      tokenVersion: Number(record.tokenVersion || 0),
      createdAt: record.createdAt || 0,
      lastSeenAt: record.lastSeenAt || 0,
    }
  }

  return {
    registerRoom,
    verifyBridge,
    refreshPairCode,
    exchangePair,
    getTokenVersion,
    revokeRoomTokens,
    getRoomMeta,
    count: () => rooms.size,
  }
}
