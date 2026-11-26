import { createHash, randomBytes, randomInt } from 'node:crypto'
import { safeEqual } from './auth.js'

const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const DEFAULT_COOLDOWN_MS = 60 * 1000 // 60 seconds between sends per (purpose, email)
const MAX_VERIFY_ATTEMPTS = 5
const MAX_EMAIL_SENDS_PER_HOUR = 6
const MAX_IP_SENDS_PER_HOUR = 12
const DEFAULT_MAX_GLOBAL_EMAILS_PER_HOUR = 300
const HOUR_MS = 60 * 60 * 1000
const MAX_TRACKED_KEYS = 2000

function sha256Hex(val) {
  return createHash('sha256').update(String(val ?? ''), 'utf8').digest('hex')
}

function normalizeKeyEmail(email) {
  return String(email || '').trim().toLowerCase()
}

/**
 * In-memory 6-digit email verification code manager with strict anti-abuse limits:
 * - Codes are hashed with a per-code random salt (never stored plaintext)
 * - 10-minute expiration, single-use consumption, 5-attempt brute-force lockout
 * - 60-second resend cooldown + unified per-email, per-user (bind), per-IP, and global hourly caps
 */
export function createEmailCodeStore(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : CODE_TTL_MS
  const cooldownMs = Number(options.cooldownMs) >= 0 ? Number(options.cooldownMs) : DEFAULT_COOLDOWN_MS
  const maxEmailPerHour = Number(options.maxEmailPerHour) > 0 ? Number(options.maxEmailPerHour) : MAX_EMAIL_SENDS_PER_HOUR
  const maxIpPerHour = Number(options.maxIpPerHour) > 0 ? Number(options.maxIpPerHour) : MAX_IP_SENDS_PER_HOUR
  const envGlobalMax = Number(process.env.MAX_EMAILS_PER_HOUR)
  const maxGlobalPerHour =
    Number(options.maxGlobalPerHour) > 0
      ? Number(options.maxGlobalPerHour)
      : Number.isFinite(envGlobalMax) && envGlobalMax > 0
        ? Math.floor(envGlobalMax)
        : DEFAULT_MAX_GLOBAL_EMAILS_PER_HOUR

  /** key `${purpose}:${emailLower}` -> { salt, hash, userId, issuedAt, expiresAt, attempts } */
  const codes = new Map()
  /** key `emailLower` -> timestamps[] (unified across all purposes) */
  const emailSendLog = new Map()
  /** key `bind:${userId}` -> timestamps[] (caps per-user bind sends across arbitrary emails) */
  const userSendLog = new Map()
  /** ip -> timestamps[] */
  const ipSendLog = new Map()
  /** Global outbound verification timestamps within the last hour */
  let globalSendLog = []

  function pruneMap(map, maxSize) {
    if (map.size < maxSize) return
    const now = Date.now()
    for (const [k, v] of map.entries()) {
      if (Array.isArray(v)) {
        const fresh = v.filter((t) => now - t < HOUR_MS)
        if (fresh.length === 0) map.delete(k)
        else map.set(k, fresh)
      } else if (v && typeof v.expiresAt === 'number' && now > v.expiresAt) {
        map.delete(k)
      }
    }
    while (map.size >= maxSize) {
      const oldest = map.keys().next().value
      if (!oldest) break
      map.delete(oldest)
    }
  }

  function getRecentTimestamps(map, key, now) {
    const arr = map.get(key)
    if (!arr) return []
    const fresh = arr.filter((t) => now - t < HOUR_MS)
    if (fresh.length === 0) map.delete(key)
    else map.set(key, fresh)
    return fresh
  }

  function getConfig() {
    return {
      cooldownSec: Math.ceil(cooldownMs / 1000),
      expiresInSec: Math.ceil(ttlMs / 1000),
    }
  }

  /**
   * Enforce and record per-IP send quota without mutating `codes`, `emailSendLog`, or `globalSendLog`.
   * Used for non-existent password-reset targets so random probes cannot evict valid OTPs.
   */
  function checkIpSendLimit(ip = 'unknown') {
    const cleanIp = String(ip || 'unknown').trim() || 'unknown'
    const now = Date.now()
    pruneMap(ipSendLog, MAX_TRACKED_KEYS)
    const recentIp = getRecentTimestamps(ipSendLog, cleanIp, now)
    if (recentIp.length >= maxIpPerHour) {
      return {
        ok: false,
        error: '当前网络请求验证码过于频繁，请稍后再试',
      }
    }
    ipSendLog.set(cleanIp, [...recentIp, now])
    return { ok: true }
  }

  /**
   * Issue a fresh 6-digit code if rate limits pass.
   * Returns `{ ok, code, cooldownSec, expiresInSec, rollback }` or `{ ok: false, error, retryAfterSec? }`.
   */
  function issueCode({ purpose, email, ip = 'unknown', userId = '' }) {
    const cleanPurpose = String(purpose || '').trim()
    const emailLower = normalizeKeyEmail(email)
    const cleanIp = String(ip || 'unknown').trim() || 'unknown'
    const cleanUserId = String(userId || '').trim()
    if (!cleanPurpose || !emailLower) {
      return { ok: false, error: '邮箱地址无效' }
    }

    const now = Date.now()
    pruneMap(codes, MAX_TRACKED_KEYS)
    pruneMap(emailSendLog, MAX_TRACKED_KEYS)
    pruneMap(userSendLog, MAX_TRACKED_KEYS)
    pruneMap(ipSendLog, MAX_TRACKED_KEYS)

    const key = `${cleanPurpose}:${emailLower}`
    const prev = codes.get(key)
    if (prev && cooldownMs > 0 && now - prev.issuedAt < cooldownMs) {
      const retryAfterSec = Math.max(1, Math.ceil((cooldownMs - (now - prev.issuedAt)) / 1000))
      return {
        ok: false,
        retryAfterSec,
        error: `发送过于频繁，请 ${retryAfterSec} 秒后再试`,
      }
    }

    const recentEmail = getRecentTimestamps(emailSendLog, emailLower, now)
    if (recentEmail.length >= maxEmailPerHour) {
      return {
        ok: false,
        error: '该邮箱发送验证码次数过多，请 1 小时后再试',
      }
    }

    const bindUserKey = cleanPurpose === 'bind' && cleanUserId ? `bind:${cleanUserId}` : ''
    const recentUser = bindUserKey ? getRecentTimestamps(userSendLog, bindUserKey, now) : []
    if (bindUserKey && recentUser.length >= maxEmailPerHour) {
      return {
        ok: false,
        error: '当前账号发送绑定验证码次数过多，请 1 小时后再试',
      }
    }

    const recentIp = getRecentTimestamps(ipSendLog, cleanIp, now)
    if (recentIp.length >= maxIpPerHour) {
      return {
        ok: false,
        error: '当前网络请求验证码过于频繁，请稍后再试',
      }
    }

    globalSendLog = globalSendLog.filter((t) => now - t < HOUR_MS)
    if (globalSendLog.length >= maxGlobalPerHour) {
      return {
        ok: false,
        error: '服务器邮件发送已达本小时上限，请稍后再试',
      }
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const salt = randomBytes(12).toString('hex')
    const entry = {
      salt,
      hash: sha256Hex(`${cleanPurpose}:${emailLower}:${salt}:${code}`),
      userId: cleanUserId,
      issuedAt: now,
      expiresAt: now + ttlMs,
      attempts: 0,
    }

    codes.set(key, entry)
    emailSendLog.set(emailLower, [...recentEmail, now])
    if (bindUserKey) userSendLog.set(bindUserKey, [...recentUser, now])
    ipSendLog.set(cleanIp, [...recentIp, now])
    globalSendLog.push(now)

    const removeOneTimestamp = (map, mapKey, ts) => {
      const cur = map.get(mapKey)
      if (!cur) return
      const idx = cur.lastIndexOf(ts)
      if (idx === -1) return
      const next = cur.slice()
      next.splice(idx, 1)
      if (next.length === 0) map.delete(mapKey)
      else map.set(mapKey, next)
    }

    // Roll back cooldown & quota entry if the upstream SMTP send itself fails
    let rolledBack = false
    const rollback = () => {
      if (rolledBack) return
      rolledBack = true
      if (codes.get(key) === entry) {
        if (prev && prev.expiresAt > Date.now()) codes.set(key, prev)
        else codes.delete(key)
      }
      removeOneTimestamp(emailSendLog, emailLower, now)
      if (bindUserKey) removeOneTimestamp(userSendLog, bindUserKey, now)
      removeOneTimestamp(ipSendLog, cleanIp, now)
      const gIdx = globalSendLog.lastIndexOf(now)
      if (gIdx !== -1) globalSendLog.splice(gIdx, 1)
    }

    return {
      ok: true,
      code,
      cooldownSec: Math.ceil(cooldownMs / 1000),
      expiresInSec: Math.ceil(ttlMs / 1000),
      rollback,
    }
  }

  /**
   * Verify a 6-digit code. Set `consume: true` to burn immediately, or `consume: false`
   * to validate before persisting and follow up with `consumeCode()`.
   */
  function verifyCode({ purpose, email, code, userId = '', consume = true }) {
    const cleanPurpose = String(purpose || '').trim()
    const emailLower = normalizeKeyEmail(email)
    const cleanCode = String(code || '').trim()
    if (!/^\d{6}$/.test(cleanCode)) {
      return { ok: false, error: '请输入 6 位数字邮箱验证码' }
    }

    const key = `${cleanPurpose}:${emailLower}`
    const entry = codes.get(key)
    if (!entry) {
      return { ok: false, error: '验证码不存在或已失效，请重新获取' }
    }
    if (Date.now() > entry.expiresAt) {
      codes.delete(key)
      return { ok: false, error: '验证码已过期，请重新获取' }
    }
    if (entry.userId && String(userId || '') !== entry.userId) {
      return { ok: false, error: '验证码与当前账号不匹配，请重新获取' }
    }

    const candidate = sha256Hex(`${cleanPurpose}:${emailLower}:${entry.salt}:${cleanCode}`)
    if (!safeEqual(candidate, entry.hash)) {
      entry.attempts += 1
      if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
        codes.delete(key)
        return { ok: false, error: '验证码错误次数过多，已作废，请重新获取' }
      }
      return { ok: false, error: '邮箱验证码不正确' }
    }

    if (consume) {
      codes.delete(key)
    }
    return { ok: true }
  }

  function consumeCode({ purpose, email }) {
    const key = `${String(purpose || '').trim()}:${normalizeKeyEmail(email)}`
    codes.delete(key)
  }

  return {
    getConfig,
    checkIpSendLimit,
    issueCode,
    verifyCode,
    consumeCode,
  }
}
