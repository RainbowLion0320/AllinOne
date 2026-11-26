import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { chmod as chmodAsync, open as openAsync, unlink as unlinkAsync } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeEqual } from './auth.js'

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']{2,}$/
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
const SCRYPT_KEYLEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }
const SCRYPT_MAX_CONCURRENT = 16
const SCRYPT_MAX_QUEUE = 64
const DUMMY_SCRYPT_SALT = '00112233445566778899aabbccddeeff'
const MAX_DEVICES_PER_USER = 20
const MAX_REVOKED_SIDS = 1024
const MAX_DAILY_REG_DAYS = 14
const DEFAULT_MAX_DAILY_REGISTRATIONS = 20

export const VALID_TIERS = new Set(['free', 'pro', 'ultra', 'admin'])

export function getLocalDayKey(ts = Date.now()) {
  const d = ts instanceof Date ? ts : new Date(ts)
  if (Number.isNaN(d.getTime())) return getLocalDayKey(Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function normalizeMaxDailyRegistrations(raw, fallback = DEFAULT_MAX_DAILY_REGISTRATIONS) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(100_000, Math.floor(n))
}

export function getCurrentTurnMonth(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function normalizeTurnUsageRecord(raw, now = new Date()) {
  const curMonth = getCurrentTurnMonth(now)
  if (raw && typeof raw === 'object' && String(raw.month || '') === curMonth) {
    return {
      month: curMonth,
      bytes: Math.max(0, Math.floor(Number(raw.bytes) || 0)),
      updatedAt: Number(raw.updatedAt) || 0,
    }
  }
  return { month: curMonth, bytes: 0, updatedAt: 0 }
}

export function normalizeTier(raw) {
  const t = String(raw || '').trim().toLowerCase()
  return VALID_TIERS.has(t) ? t : 'free'
}

export function resolveUserTier(user) {
  if (!user) return 'free'
  return normalizeTier(user.tier || (user.role === 'admin' ? 'admin' : 'free'))
}

function sha256Hex(val) {
  return createHash('sha256').update(String(val ?? ''), 'utf8').digest('hex')
}

let scryptActive = 0
const scryptQueue = []

function pumpScryptQueue() {
  while (scryptActive < SCRYPT_MAX_CONCURRENT && scryptQueue.length > 0) {
    const job = scryptQueue.shift()
    scryptActive += 1
    scrypt(job.password, job.salt, SCRYPT_KEYLEN, SCRYPT_OPTS, (err, derivedKey) => {
      scryptActive -= 1
      pumpScryptQueue()
      if (err) job.reject(err)
      else job.resolve(derivedKey)
    })
  }
}

function scryptAsync(password, salt) {
  if (scryptActive >= SCRYPT_MAX_CONCURRENT && scryptQueue.length >= SCRYPT_MAX_QUEUE) {
    const err = new Error('服务器认证队列繁忙，请稍后重试')
    err.statusCode = 503
    err.code = 'SCRYPT_OVERLOADED'
    return Promise.reject(err)
  }
  return new Promise((resolvePromise, rejectPromise) => {
    scryptQueue.push({
      password: String(password),
      salt: String(salt),
      resolve: resolvePromise,
      reject: rejectPromise,
    })
    pumpScryptQueue()
  })
}

async function hashPasswordAsync(password, saltHex) {
  const salt = saltHex || randomBytes(16).toString('hex')
  const derived = (await scryptAsync(password, salt)).toString('hex')
  return { salt, hash: derived }
}

async function verifyPasswordHashAsync(password, salt, expectedHashHex) {
  if (!password || !salt || !expectedHashHex) return false
  try {
    const derivedBuf = await scryptAsync(password, salt)
    const expectedBuf = Buffer.from(String(expectedHashHex), 'hex')
    if (derivedBuf.length !== expectedBuf.length) return false
    return timingSafeEqual(derivedBuf, expectedBuf)
  } catch (err) {
    if (err?.statusCode === 503) throw err
    return false
  }
}

function sanitizeBridgeSlug(raw) {
  const slug = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || 'my-pc'
}

function validateUsername(raw) {
  const u = String(raw || '').trim()
  if (!USERNAME_RE.test(u)) {
    return { ok: false, error: '用户名需为 3~32 位字母、数字、点、下划线或连字符' }
  }
  return { ok: true, username: u, usernameLower: u.toLowerCase() }
}

export function validateEmail(raw) {
  const email = String(raw || '').trim()
  if (!email) {
    return { ok: false, error: '请输入邮箱地址' }
  }
  if (email.length > 254 || /[\r\n\0]/.test(email) || !EMAIL_RE.test(email)) {
    return { ok: false, error: '请输入有效的邮箱地址' }
  }
  return { ok: true, email, emailLower: email.toLowerCase() }
}

export function validatePassword(raw) {
  const p = String(raw ?? '')
  if (p.length < 8) {
    return { ok: false, error: '密码长度至少需要 8 位' }
  }
  if (p.length > 128) {
    return { ok: false, error: '密码长度不能超过 128 位' }
  }
  return { ok: true, password: p }
}

/**
 * Lightweight, zero-dependency account + daily registration cap + per-PC device credential store.
 * Persists to JSON with `0600` permissions using atomic temp-file rename:
 *  - Passwords stored strictly as salted `scrypt` hashes (never plaintext)
 *  - Per-PC `deviceSecret` stored strictly as salted SHA-256 hashes (never plaintext)
 *  - Open registration enforced atomically with a configurable daily registration cap
 */
export function createAccountStore({ filePath }) {
  mkdirSync(dirname(filePath), { recursive: true })

  /** @type {Map<string, any>} */
  const usersById = new Map()
  /** @type {Map<string, string>} */
  const userIdByLower = new Map()
  /** @type {Map<string, string>} */
  const userIdByEmailLower = new Map()
  /** @type {Record<string, number>} */
  let dailyRegistrations = {}
  /** @type {Set<string>} */
  const changingPasswordUsers = new Set()

  function normalizeDailyRegistrations(raw, now = Date.now()) {
    const out = {}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
    const cutoffKey = getLocalDayKey(now - (MAX_DAILY_REG_DAYS - 1) * 24 * 60 * 60 * 1000)
    const entries = Object.entries(raw)
      .filter(([k]) => DAY_KEY_RE.test(k) && k >= cutoffKey)
      .map(([k, v]) => [k, Math.max(0, Math.floor(Number(v) || 0))])
      .filter(([, count]) => count > 0)
      .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
      .slice(0, MAX_DAILY_REG_DAYS)
    for (const [k, count] of entries) {
      out[k] = count
    }
    return out
  }

  function load() {
    if (!existsSync(filePath)) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
      console.error(`[relay] CRITICAL: Failed to read/parse accounts file (${filePath}):`, err?.message || err)
      throw err
    }
    if (!parsed || typeof parsed !== 'object') {
      const err = new Error(`Invalid accounts file format: ${filePath}`)
      console.error(`[relay] CRITICAL: ${err.message}`)
      throw err
    }
    for (const u of Array.isArray(parsed?.users) ? parsed.users : []) {
      if (!u?.userId || !u?.username) continue
      const { plan: legacyPlan, invitedBy: _legacyInvitedBy, inviteId: _legacyInviteId, ...restUser } = u
      const rawEmail = String(u.email || '').trim()
      const emailLower = rawEmail ? String(u.emailLower || rawEmail).trim().toLowerCase() : ''
      const tier = normalizeTier(u.tier || (u.role === 'admin' ? 'admin' : legacyPlan || 'free'))
      const role = tier === 'admin' ? 'admin' : 'user'
      const normalized = {
        ...restUser,
        usernameLower: String(u.usernameLower || u.username).toLowerCase(),
        email: rawEmail,
        emailLower,
        emailVerified: Boolean(rawEmail && u.emailVerified),
        emailVerifiedAt: Number(u.emailVerifiedAt) || 0,
        loginEmail2fa: Boolean(rawEmail && u.emailVerified && u.loginEmail2fa),
        knownLoginIps: Array.isArray(u.knownLoginIps) ? u.knownLoginIps.filter(Boolean).slice(0, 12) : [],
        tier,
        role,
        turnUsage: normalizeTurnUsageRecord(u.turnUsage),
        tokenVersion: Number.isFinite(Number(u.tokenVersion)) ? Math.max(0, Math.floor(Number(u.tokenVersion))) : 0,
        devices: Array.isArray(u.devices) ? u.devices : [],
        sessions: Array.isArray(u.sessions) ? u.sessions : [],
        revokedSids: u.revokedSids && typeof u.revokedSids === 'object' ? u.revokedSids : {},
      }
      usersById.set(normalized.userId, normalized)
      userIdByLower.set(normalized.usernameLower, normalized.userId)
      if (normalized.emailLower) {
        userIdByEmailLower.set(normalized.emailLower, normalized.userId)
      }
    }
    // Gracefully ignore any legacy `parsed.invites` array (dropped on next save)
    dailyRegistrations = normalizeDailyRegistrations(parsed?.dailyRegistrations)
  }

  let saveTimer = null
  let saveDirty = false
  let saveGen = 0
  let persistedGen = 0
  let asyncSaveInFlight = null

  function serializeAccountsPayload() {
    dailyRegistrations = normalizeDailyRegistrations(dailyRegistrations)
    return JSON.stringify(
      {
        version: 1,
        users: [...usersById.values()],
        dailyRegistrations,
      },
      null,
      2,
    )
  }

  function save() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const targetGen = ++saveGen
    const payload = serializeAccountsPayload()
    const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
    let fd = null
    try {
      fd = openSync(tmpPath, 'w', 0o600)
      const buf = Buffer.from(payload, 'utf8')
      let written = 0
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written)
      }
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      try { chmodSync(tmpPath, 0o600) } catch {}
      renameSync(tmpPath, filePath)
      try { chmodSync(filePath, 0o600) } catch {}
      persistedGen = Math.max(persistedGen, targetGen)
      saveDirty = persistedGen < saveGen
    } catch (err) {
      if (fd !== null) {
        try { closeSync(fd) } catch {}
      }
      saveDirty = true
      try { unlinkSync(tmpPath) } catch {}
      throw err
    }
  }

  async function drainAsyncSave() {
    if (asyncSaveInFlight) return asyncSaveInFlight
    asyncSaveInFlight = (async () => {
      while (saveDirty || persistedGen < saveGen) {
        const targetGen = saveGen
        saveDirty = false
        const payload = serializeAccountsPayload()
        const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
        let fh = null
        try {
          fh = await openAsync(tmpPath, 'w', 0o600)
          await fh.writeFile(payload, 'utf8')
          await fh.sync()
          await fh.close()
          fh = null
          try { await chmodAsync(tmpPath, 0o600) } catch {}
          // Perform generation check + atomic rename synchronously on the main thread
          // so a concurrent sync save() (gen N+1) can never be overwritten by a stale libuv renameAsync(gen N).
          if (persistedGen >= targetGen) {
            try { await unlinkAsync(tmpPath) } catch {}
            continue
          }
          renameSync(tmpPath, filePath)
          try { chmodSync(filePath, 0o600) } catch {}
          persistedGen = Math.max(persistedGen, targetGen)
        } catch (err) {
          if (fh !== null) {
            try { await fh.close() } catch {}
          }
          try { await unlinkAsync(tmpPath) } catch {}
          saveDirty = persistedGen < saveGen
          console.error(`[accounts] Async save failed: ${err?.message || err}`)
          break
        }
      }
    })().finally(() => {
      asyncSaveInFlight = null
      if (saveDirty || persistedGen < saveGen) {
        scheduleSave(1000, { bumpGen: false })
      }
    })
    return asyncSaveInFlight
  }

  /**
   * Coalesce high-frequency non-critical metadata writes (e.g. lastSeenAt heartbeats)
   * into a single serialized non-blocking disk write every few seconds.
   */
  function scheduleSave(delayMs = 5000, { bumpGen = true } = {}) {
    if (bumpGen) saveGen += 1
    saveDirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void drainAsyncSave()
    }, delayMs)
    saveTimer.unref?.()
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (saveDirty || persistedGen < saveGen) {
      try {
        save()
      } catch (err) {
        console.error(`[accounts] Flush save failed: ${err?.message || err}`)
      }
    }
  }

  load()

  function sanitizeDeviceRecord(d) {
    return {
      deviceId: d.deviceId,
      bridgeId: d.bridgeId,
      label: d.label || d.hostname || d.bridgeId,
      hostname: d.hostname || d.bridgeId,
      platform: d.platform || 'unknown',
      createdAt: d.createdAt || 0,
      lastSeenAt: d.lastSeenAt || 0,
    }
  }

  function sanitizeUser(u) {
    if (!u) return null
    const tier = resolveUserTier(u)
    const role = tier === 'admin' ? 'admin' : 'user'
    return {
      userId: u.userId,
      username: u.username,
      email: u.email || '',
      emailVerified: Boolean(u.email && u.emailVerified),
      loginEmail2fa: Boolean(u.email && u.emailVerified && u.loginEmail2fa),
      role,
      tier,
      turnUsage: normalizeTurnUsageRecord(u.turnUsage),
      tokenVersion: u.tokenVersion,
      createdAt: u.createdAt || 0,
      lastLoginAt: u.lastLoginAt || 0,
      deviceCount: Array.isArray(u.devices) ? u.devices.length : 0,
    }
  }

  function getTodayRegistrationCount(now = Date.now()) {
    const todayKey = getLocalDayKey(now)
    const persisted = Math.max(0, Math.floor(Number(dailyRegistrations[todayKey]) || 0))
    let counted = 0
    for (const u of usersById.values()) {
      if (u?.createdAt && getLocalDayKey(u.createdAt) === todayKey) {
        counted += 1
      }
    }
    return Math.max(persisted, counted)
  }

  function getDailyRegistrationStats(maxDaily = DEFAULT_MAX_DAILY_REGISTRATIONS, now = Date.now()) {
    const todayKey = getLocalDayKey(now)
    const used = getTodayRegistrationCount(now)
    const cleanLimit = normalizeMaxDailyRegistrations(maxDaily, DEFAULT_MAX_DAILY_REGISTRATIONS)
    return {
      date: todayKey,
      used,
      limit: cleanLimit,
      remaining: cleanLimit > 0 ? Math.max(0, cleanLimit - used) : null,
      exceeded: cleanLimit > 0 && used >= cleanLimit,
    }
  }

  function isEmailTaken(email, excludeUserId = '') {
    const lower = String(email || '').trim().toLowerCase()
    if (!lower) return false
    const ownerId = userIdByEmailLower.get(lower)
    return Boolean(ownerId && ownerId !== excludeUserId)
  }

  function getUserByEmail(email) {
    const lower = String(email || '').trim().toLowerCase()
    if (!lower) return null
    const userId = userIdByEmailLower.get(lower)
    if (!userId) return null
    return sanitizeUser(usersById.get(userId))
  }

  async function registerUserAsync({
    username,
    password,
    bootstrapToken = '',
    expectedBootstrapToken = '',
    email = '',
    emailVerified = false,
    maxDailyRegistrations = DEFAULT_MAX_DAILY_REGISTRATIONS,
  } = {}) {
    const uCheck = validateUsername(username)
    if (!uCheck.ok) return { ...uCheck, statusCode: 400 }
    const pCheck = validatePassword(password)
    if (!pCheck.ok) return { ...pCheck, statusCode: 400 }

    const isBootstrap = usersById.size === 0
    const expectedBoot = String(expectedBootstrapToken || '').trim()
    const providedBoot = String(bootstrapToken || '').trim()
    const cleanLimit = normalizeMaxDailyRegistrations(maxDailyRegistrations, DEFAULT_MAX_DAILY_REGISTRATIONS)

    if (isBootstrap) {
      if (expectedBoot && !safeEqual(providedBoot, expectedBoot)) {
        return { ok: false, statusCode: 400, error: '管理员初始化密钥无效' }
      }
    } else if (cleanLimit > 0 && getTodayRegistrationCount() >= cleanLimit) {
      return {
        ok: false,
        statusCode: 429,
        code: 'DAILY_REGISTRATION_LIMIT',
        error: `今日新用户注册名额已满（每日上限 ${cleanLimit} 人），请明天再试`,
      }
    }

    if (userIdByLower.has(uCheck.usernameLower)) {
      return { ok: false, statusCode: 400, error: '该用户名已被注册，请换一个用户名' }
    }

    let cleanEmail = ''
    let cleanEmailLower = ''
    if (String(email || '').trim()) {
      const eCheck = validateEmail(email)
      if (!eCheck.ok) return { ...eCheck, statusCode: 400 }
      if (userIdByEmailLower.has(eCheck.emailLower)) {
        return { ok: false, statusCode: 400, error: '该邮箱已被其他账号绑定' }
      }
      cleanEmail = eCheck.email
      cleanEmailLower = eCheck.emailLower
    }

    // Offload expensive scrypt hashing to libuv worker pool so event loop never stalls
    const { salt, hash } = await hashPasswordAsync(pCheck.password)

    // Re-verify bootstrap state, daily cap, and uniqueness synchronously after await (prevents TOCTOU races)
    if (isBootstrap && usersById.size > 0) {
      return { ok: false, statusCode: 400, error: '管理员账号已初始化，请重新提交注册' }
    }
    const finalIsBootstrap = isBootstrap && usersById.size === 0
    if (!finalIsBootstrap && cleanLimit > 0 && getTodayRegistrationCount() >= cleanLimit) {
      return {
        ok: false,
        statusCode: 429,
        code: 'DAILY_REGISTRATION_LIMIT',
        error: `今日新用户注册名额已满（每日上限 ${cleanLimit} 人），请明天再试`,
      }
    }
    if (userIdByLower.has(uCheck.usernameLower)) {
      return { ok: false, statusCode: 400, error: '该用户名已被注册，请换一个用户名' }
    }
    if (cleanEmailLower && userIdByEmailLower.has(cleanEmailLower)) {
      return { ok: false, statusCode: 400, error: '该邮箱已被其他账号绑定' }
    }

    const now = Date.now()
    const todayKey = getLocalDayKey(now)
    const nextTodayCount = getTodayRegistrationCount(now) + 1
    const userId = `usr_${randomBytes(8).toString('hex')}`
    const tier = finalIsBootstrap ? 'admin' : 'free'
    const role = finalIsBootstrap ? 'admin' : 'user'

    const record = {
      userId,
      username: uCheck.username,
      usernameLower: uCheck.usernameLower,
      email: cleanEmail,
      emailLower: cleanEmailLower,
      emailVerified: Boolean(cleanEmail && emailVerified),
      emailVerifiedAt: cleanEmail && emailVerified ? now : 0,
      loginEmail2fa: false,
      knownLoginIps: [],
      tier,
      role,
      turnUsage: normalizeTurnUsageRecord(null, now),
      passwordSalt: salt,
      passwordHash: hash,
      tokenVersion: 0,
      createdAt: now,
      lastLoginAt: now,
      devices: [],
      sessions: [],
      revokedSids: {},
    }

    usersById.set(userId, record)
    userIdByLower.set(record.usernameLower, userId)
    if (record.emailLower) {
      userIdByEmailLower.set(record.emailLower, userId)
    }
    dailyRegistrations[todayKey] = nextTodayCount
    dailyRegistrations = normalizeDailyRegistrations(dailyRegistrations, now)
    save()

    return {
      ok: true,
      user: sanitizeUser(record),
      devices: [],
    }
  }

  function resolveAccountKey(identifier) {
    const lower = String(identifier || '').trim().toLowerCase()
    if (!lower) return ''
    let userId = userIdByLower.get(lower)
    if (!userId && lower.includes('@')) {
      userId = userIdByEmailLower.get(lower)
    }
    return userId || ''
  }

  function markUserLogin(userId) {
    const record = usersById.get(userId)
    if (!record) return null
    record.lastLoginAt = Date.now()
    scheduleSave()
    return sanitizeUser(record)
  }

  async function verifyUserPasswordAsync(userId, password) {
    const record = usersById.get(userId)
    const pw = String(password ?? '')
    if (!record || !pw) return false
    return verifyPasswordHashAsync(pw, record.passwordSalt, record.passwordHash)
  }

  async function authenticateUserAsync(identifier, password, { recordLogin = true } = {}) {
    const lower = String(identifier || '').trim().toLowerCase()
    if (!lower || !password) return null
    let userId = userIdByLower.get(lower)
    if (!userId && lower.includes('@')) {
      userId = userIdByEmailLower.get(lower)
    }
    const record = userId ? usersById.get(userId) : null
    if (!record) {
      // Constant-time mitigation: spend equivalent scrypt CPU time for unknown identifiers
      await scryptAsync(String(password), DUMMY_SCRYPT_SALT)
      return null
    }
    const origSalt = record.passwordSalt
    const origHash = record.passwordHash
    const ok = await verifyPasswordHashAsync(password, origSalt, origHash)
    if (!ok) return null
    if (usersById.get(userId) !== record || record.passwordHash !== origHash) return null
    if (recordLogin) {
      record.lastLoginAt = Date.now()
      scheduleSave()
    }
    return {
      user: sanitizeUser(record),
      devices: record.devices.map(sanitizeDeviceRecord),
    }
  }

  function setUserEmail(userId, email, { verified = true } = {}) {
    const record = usersById.get(userId)
    if (!record) return { ok: false, error: '用户不存在' }
    const eCheck = validateEmail(email)
    if (!eCheck.ok) return eCheck
    const existingOwner = userIdByEmailLower.get(eCheck.emailLower)
    if (existingOwner && existingOwner !== userId) {
      return { ok: false, error: '该邮箱已被其他账号绑定' }
    }
    if (record.emailLower && record.emailLower !== eCheck.emailLower) {
      if (userIdByEmailLower.get(record.emailLower) === userId) {
        userIdByEmailLower.delete(record.emailLower)
      }
    }
    record.email = eCheck.email
    record.emailLower = eCheck.emailLower
    record.emailVerified = Boolean(verified)
    record.emailVerifiedAt = verified ? Date.now() : 0
    userIdByEmailLower.set(record.emailLower, userId)
    save()
    return { ok: true, user: sanitizeUser(record) }
  }

  async function resetPasswordByEmailAsync(email, newPassword) {
    const eCheck = validateEmail(email)
    if (!eCheck.ok) return eCheck
    const pCheck = validatePassword(newPassword)
    if (!pCheck.ok) return pCheck
    const userId = userIdByEmailLower.get(eCheck.emailLower)
    if (!userId) {
      return { ok: false, error: '该邮箱未绑定任何账号' }
    }
    const record = usersById.get(userId)
    if (!record) {
      return { ok: false, error: '账号不存在' }
    }
    if (record.emailVerified !== true) {
      return { ok: false, error: '该邮箱尚未完成验证，无法用于重置密码' }
    }
    const { salt, hash } = await hashPasswordAsync(pCheck.password)
    if (usersById.get(userId) !== record || record.emailVerified !== true) {
      return { ok: false, error: '账号状态已变更，请重试' }
    }
    record.passwordSalt = salt
    record.passwordHash = hash
    record.tokenVersion = Number(record.tokenVersion || 0) + 1
    record.sessions = []
    record.revokedSids = {}
    save()
    return { ok: true, user: sanitizeUser(record) }
  }

  async function changePasswordAsync(userId, currentPassword, newPassword, { validateSession } = {}) {
    const record = usersById.get(userId)
    if (!record) return { ok: false, error: '用户不存在' }
    if (changingPasswordUsers.has(userId)) {
      return { ok: false, error: '正在修改密码，请稍后重试' }
    }
    const origHash = record.passwordHash
    const origSalt = record.passwordSalt
    const origTv = Number(record.tokenVersion || 0)
    changingPasswordUsers.add(userId)
    try {
      const valid = await verifyPasswordHashAsync(currentPassword, origSalt, origHash)
      if (!valid) {
        return { ok: false, error: '当前密码不正确' }
      }
      const pCheck = validatePassword(newPassword)
      if (!pCheck.ok) return pCheck
      const { salt, hash } = await hashPasswordAsync(pCheck.password)
      const sessionValid = typeof validateSession === 'function' ? Boolean(validateSession()) : true
      if (
        usersById.get(userId) !== record ||
        record.passwordHash !== origHash ||
        record.passwordSalt !== origSalt ||
        Number(record.tokenVersion || 0) !== origTv ||
        !sessionValid
      ) {
        return { ok: false, error: '会话已失效或密码已被更新，请重新登录', code: 'stale_session' }
      }
      record.passwordSalt = salt
      record.passwordHash = hash
      record.tokenVersion = origTv + 1
      record.sessions = []
      record.revokedSids = {}
      save()
      return { ok: true, user: sanitizeUser(record) }
    } finally {
      changingPasswordUsers.delete(userId)
    }
  }

  function bindDevice({ userId, label = '', hostname = '', platform = 'unknown', bridgeId = '' } = {}) {
    const record = usersById.get(userId)
    if (!record) return null
    if (!Array.isArray(record.devices)) record.devices = []
    const now = Date.now()
    const cleanHost = String(hostname || label || 'My-PC').trim().slice(0, 64) || 'My-PC'
    const cleanLabel = String(label || hostname || 'My PC').trim().slice(0, 64) || cleanHost
    const cleanPlatform = String(platform || 'unknown').trim().slice(0, 32) || 'unknown'
    const explicitBridgeSlug = String(bridgeId || '').trim() ? sanitizeBridgeSlug(bridgeId) : ''
    const GENERIC_HOSTS = new Set(['', 'my-pc', 'my pc', 'localhost', 'unknown'])
    const hostKey = cleanHost.toLowerCase()
    const platKey = cleanPlatform.toLowerCase()

    // Rebind existing PC in-place by explicit bridgeId OR same non-generic (hostname, platform)
    // so reinstalling desktop / re-running setup on the same PC never creates duplicate PC entries
    const existingDevice =
      (explicitBridgeSlug ? record.devices.find((d) => d.bridgeId === explicitBridgeSlug) : null) ||
      (!explicitBridgeSlug && !GENERIC_HOSTS.has(hostKey)
        ? record.devices.find(
            (d) =>
              String(d.hostname || '').trim().toLowerCase() === hostKey &&
              String(d.platform || '').trim().toLowerCase() === platKey,
          )
        : null)
    if (existingDevice) {
      const deviceSecret = `dv_${randomBytes(24).toString('hex')}`
      const hadCustomLabel =
        existingDevice.label &&
        existingDevice.hostname &&
        existingDevice.label.trim().toLowerCase() !== existingDevice.hostname.trim().toLowerCase()
      const incomingIsDefaultLabel = !label || cleanLabel.toLowerCase() === hostKey
      existingDevice.label = hadCustomLabel && incomingIsDefaultLabel ? existingDevice.label : cleanLabel
      existingDevice.hostname = cleanHost
      existingDevice.platform = cleanPlatform
      existingDevice.secretHash = sha256Hex(`${userId}:${existingDevice.deviceId}:${deviceSecret}`)
      existingDevice.lastSeenAt = now
      save()
      return {
        userId: record.userId,
        username: record.username,
        roomId: record.userId,
        deviceId: existingDevice.deviceId,
        bridgeId: existingDevice.bridgeId,
        label: existingDevice.label,
        hostname: existingDevice.hostname,
        platform: existingDevice.platform,
        deviceSecret,
      }
    }

    if (record.devices.length >= MAX_DEVICES_PER_USER) {
      const err = new Error(`每个账号最多绑定 ${MAX_DEVICES_PER_USER} 台电脑，请先解绑旧设备后再试`)
      err.code = 'MAX_DEVICES_EXCEEDED'
      throw err
    }

    const deviceId = `dev_${randomBytes(6).toString('hex')}`
    const deviceSecret = `dv_${randomBytes(24).toString('hex')}`
    const baseSlug = sanitizeBridgeSlug(bridgeId || cleanHost || cleanLabel)

    const existingBridgeIds = new Set(record.devices.map((d) => d.bridgeId))
    let finalBridgeId = baseSlug
    if (existingBridgeIds.has(finalBridgeId)) {
      finalBridgeId = `${baseSlug.slice(0, 24)}-${deviceId.slice(4, 10)}`
    }

    const devRecord = {
      deviceId,
      bridgeId: finalBridgeId,
      label: cleanLabel,
      hostname: cleanHost,
      platform: cleanPlatform,
      secretHash: sha256Hex(`${userId}:${deviceId}:${deviceSecret}`),
      createdAt: now,
      lastSeenAt: now,
    }
    record.devices.push(devRecord)
    save()

    return {
      userId: record.userId,
      username: record.username,
      roomId: record.userId,
      deviceId: devRecord.deviceId,
      bridgeId: devRecord.bridgeId,
      label: devRecord.label,
      hostname: devRecord.hostname,
      platform: devRecord.platform,
      deviceSecret,
    }
  }

  function verifyDeviceBridge(userId, deviceSecret) {
    if (!userId || !deviceSecret) return null
    const record = usersById.get(userId)
    if (!record || !Array.isArray(record.devices)) return null
    for (const dev of record.devices) {
      const candidate = sha256Hex(`${userId}:${dev.deviceId}:${deviceSecret}`)
      if (safeEqual(candidate, dev.secretHash)) {
        const now = Date.now()
        // Throttle disk writes for heartbeat/reconnect bursts (update persisted lastSeenAt at most once/min)
        const shouldPersist = now - (dev.lastSeenAt || 0) > 60_000
        dev.lastSeenAt = now
        if (shouldPersist) scheduleSave()
        return {
          roomId: record.userId,
          userId: record.userId,
          username: record.username,
          deviceId: dev.deviceId,
          bridgeId: dev.bridgeId,
          label: dev.label,
          hostname: dev.hostname,
          platform: dev.platform,
        }
      }
    }
    return null
  }

  function listUserDevices(userId) {
    const record = usersById.get(userId)
    if (!record) return []
    return record.devices.map(sanitizeDeviceRecord)
  }

  function renameUserDevice(userId, deviceId, newLabel) {
    const record = usersById.get(userId)
    if (!record) return null
    const target = record.devices.find((d) => d.deviceId === deviceId || d.bridgeId === deviceId)
    if (!target) return null
    const clean = String(newLabel || '').trim().slice(0, 48)
    if (!clean) return null
    target.label = clean
    save()
    return sanitizeDeviceRecord(target)
  }

  function removeUserDevice(userId, deviceId) {
    const record = usersById.get(userId)
    if (!record) return null
    const idx = record.devices.findIndex((d) => d.deviceId === deviceId || d.bridgeId === deviceId)
    if (idx === -1) return null
    const [removed] = record.devices.splice(idx, 1)
    save()
    return sanitizeDeviceRecord(removed)
  }

  function getUserById(userId) {
    const record = usersById.get(userId)
    return sanitizeUser(record)
  }

  function findUserByIdentifier(identifier) {
    const clean = String(identifier || '').trim()
    if (!clean) return null
    if (usersById.has(clean)) return sanitizeUser(usersById.get(clean))
    const lower = clean.replace(/^@/, '').toLowerCase()
    const uid = userIdByLower.get(lower) || (lower.includes('@') ? userIdByEmailLower.get(lower) : '')
    return uid ? sanitizeUser(usersById.get(uid)) : null
  }

  function getUserTier(userId) {
    const record = usersById.get(userId)
    return resolveUserTier(record)
  }

  function setUserTier(userId, targetTier, { actorUserId = '' } = {}) {
    const record = usersById.get(userId)
    if (!record) return { ok: false, error: '用户不存在' }
    const raw = String(targetTier || '').trim().toLowerCase()
    if (!VALID_TIERS.has(raw)) {
      return { ok: false, error: '无效的用户等级，仅支持 free / pro / ultra / admin' }
    }
    if (actorUserId && actorUserId === userId && raw !== 'admin') {
      return { ok: false, error: '不能取消当前管理员自身的管理员身份' }
    }
    if (record.role === 'admin' && raw !== 'admin') {
      let adminCount = 0
      for (const u of usersById.values()) {
        if (u.role === 'admin') adminCount += 1
      }
      if (adminCount <= 1) {
        return { ok: false, error: '系统至少需要保留一名管理员' }
      }
    }
    const prevTier = resolveUserTier(record)
    record.tier = raw
    record.role = raw === 'admin' ? 'admin' : 'user'
    const nextTier = resolveUserTier(record)
    if (prevTier !== nextTier) {
      save()
    }
    return { ok: true, prevTier, tier: nextTier, user: sanitizeUser(record) }
  }

  function getTurnUsage(userId, now = new Date()) {
    const record = usersById.get(userId)
    if (!record) return { month: getCurrentTurnMonth(now), bytes: 0, updatedAt: 0 }
    return normalizeTurnUsageRecord(record.turnUsage, now)
  }

  function addTurnUsage(userId, deltaBytes, now = new Date()) {
    const record = usersById.get(userId)
    const add = Math.max(0, Math.floor(Number(deltaBytes) || 0))
    if (!record || add <= 0) return null
    const cur = normalizeTurnUsageRecord(record.turnUsage, now)
    const prevBytes = cur.bytes
    const next = {
      month: cur.month,
      bytes: prevBytes + add,
      updatedAt: now instanceof Date ? now.getTime() : Number(now) || Date.now(),
    }
    record.turnUsage = next
    scheduleSave(3000)
    return {
      userId: record.userId,
      tier: resolveUserTier(record),
      month: next.month,
      prevBytes,
      bytes: next.bytes,
      updatedAt: next.updatedAt,
    }
  }

  function resetTurnUsage(userId, now = new Date()) {
    const record = usersById.get(userId)
    if (!record) return { ok: false, error: '用户不存在' }
    const curMonth = getCurrentTurnMonth(now)
    record.turnUsage = {
      month: curMonth,
      bytes: 0,
      updatedAt: now instanceof Date ? now.getTime() : Number(now) || Date.now(),
    }
    save()
    return { ok: true, user: sanitizeUser(record), turnUsage: { ...record.turnUsage } }
  }

  function getTokenVersion(userId) {
    const record = usersById.get(userId)
    if (!record) return -1
    return Number(record.tokenVersion || 0)
  }

  const SESSION_TTL_MS = 31 * 24 * 60 * 60 * 1000
  const MAX_USER_SESSIONS = 30

  function normalizeClientUid(raw) {
    const clean = String(raw || '').trim()
    return /^[a-zA-Z0-9._-]{8,64}$/.test(clean) ? clean : ''
  }

  function isSameDeviceNameOrLegacyUpgrade(oldName, newName) {
    const a = String(oldName || '').trim().toLowerCase()
    const b = String(newName || '').trim().toLowerCase()
    if (!a || !b) return false
    if (a === b) return true
    // Match legacy generic "Windows Desktop" when upgraded to "Windows Desktop · Work37" (or vice versa)
    if (b.startsWith(`${a} · `) || a.startsWith(`${b} · `)) return true
    return false
  }

  function pruneUserSessionData(record, now = Date.now()) {
    if (!Array.isArray(record.sessions)) record.sessions = []
    if (!record.revokedSids || typeof record.revokedSids !== 'object') record.revokedSids = {}
    const sorted = record.sessions
      .filter((s) => s?.sid && now - (Number(s.createdAt) || 0) <= SESSION_TTL_MS && !record.revokedSids[s.sid])
      .sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0))
    // Keep only the newest session per unique non-empty clientUid
    const seenUids = new Set()
    const active = []
    for (const s of sorted) {
      const uid = normalizeClientUid(s.clientUid)
      if (uid) {
        if (seenUids.has(uid)) {
          record.revokedSids[s.sid] = now
          continue
        }
        seenUids.add(uid)
      }
      active.push(s)
    }
    if (active.length > MAX_USER_SESSIONS) {
      for (const evicted of active.slice(MAX_USER_SESSIONS)) {
        if (evicted?.sid) record.revokedSids[evicted.sid] = now
      }
    }
    record.sessions = active.slice(0, MAX_USER_SESSIONS)
    for (const [sid, ts] of Object.entries(record.revokedSids)) {
      if (now - Number(ts || 0) > SESSION_TTL_MS) {
        delete record.revokedSids[sid]
      }
    }
    const revokedEntries = Object.entries(record.revokedSids)
    if (revokedEntries.length > MAX_REVOKED_SIDS) {
      revokedEntries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      const kept = {}
      for (const [sid, ts] of revokedEntries.slice(0, MAX_REVOKED_SIDS)) {
        kept[sid] = ts
      }
      record.revokedSids = kept
    }
  }

  function evictDuplicateSessions(record, { keepSid, deviceName, clientKind, ip, clientUid, onlineSids, now }) {
    const onlineSet = onlineSids instanceof Set ? onlineSids : new Set(Array.isArray(onlineSids) ? onlineSids : [])
    const replacedSids = []
    const kept = []
    const cleanName = String(deviceName || '').trim()
    const cleanKind = clientKind === 'desktop' || clientKind === 'mobile' ? clientKind : 'web'
    const cleanIp = String(ip || '').trim()
    const cleanUid = normalizeClientUid(clientUid)
    const isAdminMonitor = cleanName.toLowerCase() === 'admin monitor'
    const isNamedDesktop = cleanKind === 'desktop' && cleanName.includes(' · ')

    for (const s of record.sessions) {
      if (!s?.sid) continue
      if (s.sid === keepSid) {
        kept.push(s)
        continue
      }
      const existingUid = normalizeClientUid(s.clientUid)
      // 1. Exact clientUid match -> definitively the same device/installation (survives IP switches & re-logins)
      const sameUid = Boolean(cleanUid && existingUid && existingUid === cleanUid)
      // 2. Offline ghost dedup (reinstalled APK / cleared storage / legacy pre-clientUid entry / named PC / Admin Monitor)
      const isOffline = !onlineSet.has(s.sid)
      const sameKind = (s.clientKind || 'web') === cleanKind
      const sameName = isSameDeviceNameOrLegacyUpgrade(s.deviceName, cleanName)
      const isLegacyWithoutUid = !existingUid
      const isSameIp = Boolean(cleanIp && s.ip && s.ip === cleanIp)
      const isOfflineGhost = Boolean(
        isOffline &&
        sameKind &&
        sameName &&
        (isLegacyWithoutUid || isSameIp || isAdminMonitor || isNamedDesktop),
      )
      if (sameUid || isOfflineGhost) {
        record.revokedSids[s.sid] = now
        replacedSids.push(s.sid)
        continue
      }
      kept.push(s)
    }
    record.sessions = kept
    return replacedSids
  }

  function hasUserSession(userId, sid) {
    const record = usersById.get(userId)
    const cleanSid = String(sid || '').trim()
    if (!record || !cleanSid || !Array.isArray(record.sessions)) return false
    if (record.revokedSids?.[cleanSid]) return false
    const entry = record.sessions.find((s) => s?.sid === cleanSid)
    if (!entry) return false
    if (Date.now() - (Number(entry.createdAt) || 0) > SESSION_TTL_MS) return false
    return true
  }

  function recordUserSession(
    userId,
    { sid, deviceName = '', clientKind = 'web', ip = '', clientUid = '', onlineSids = null } = {},
  ) {
    const record = usersById.get(userId)
    const cleanSid = String(sid || '').trim()
    if (!record || !cleanSid) return null
    const now = Date.now()
    pruneUserSessionData(record, now)
    const cleanName = String(deviceName || '').trim().slice(0, 64)
    const cleanKind = clientKind === 'desktop' || clientKind === 'mobile' ? clientKind : 'web'
    const cleanIp = String(ip || '').trim().slice(0, 64)
    const cleanUid = normalizeClientUid(clientUid)
    const replacedSids = evictDuplicateSessions(record, {
      keepSid: cleanSid,
      deviceName: cleanName,
      clientKind: cleanKind,
      ip: cleanIp,
      clientUid: cleanUid,
      onlineSids,
      now,
    })
    let entry = record.sessions.find((s) => s.sid === cleanSid)
    if (entry) {
      if (cleanName) entry.deviceName = cleanName
      entry.clientKind = cleanKind
      if (cleanIp) entry.ip = cleanIp
      if (cleanUid) entry.clientUid = cleanUid
      entry.lastSeenAt = now
    } else {
      entry = {
        sid: cleanSid,
        deviceName: cleanName || 'Unknown Device',
        clientKind: cleanKind,
        ip: cleanIp,
        ...(cleanUid ? { clientUid: cleanUid } : {}),
        createdAt: now,
        lastSeenAt: now,
      }
      record.sessions.unshift(entry)
    }
    pruneUserSessionData(record, now)
    save()
    return { ...entry, replacedSids }
  }

  function touchUserSession(
    userId,
    sid,
    { deviceName = '', clientKind = '', ip = '', clientUid = '', onlineSids = null } = {},
  ) {
    const record = usersById.get(userId)
    const cleanSid = String(sid || '').trim()
    if (!record || !cleanSid) return false
    if (record.revokedSids?.[cleanSid]) return false
    const now = Date.now()
    if (!Array.isArray(record.sessions)) record.sessions = []
    let entry = record.sessions.find((s) => s.sid === cleanSid)
    const cleanName = String(deviceName || '').trim().slice(0, 64)
    const cleanKind = clientKind === 'desktop' || clientKind === 'mobile' || clientKind === 'web' ? clientKind : ''
    const cleanIp = String(ip || '').trim().slice(0, 64)
    const cleanUid = normalizeClientUid(clientUid)
    if (!entry) {
      // Allowlist enforcement: never auto-admit unknown or previously evicted sids
      return false
    }
    let changed = false
    if (cleanName && entry.deviceName !== cleanName) {
      entry.deviceName = cleanName
      changed = true
    }
    if (cleanKind && entry.clientKind !== cleanKind) {
      entry.clientKind = cleanKind
      changed = true
    }
    if (cleanIp && entry.ip !== cleanIp) {
      entry.ip = cleanIp
      changed = true
    }
    if (cleanUid && entry.clientUid !== cleanUid) {
      entry.clientUid = cleanUid
      changed = true
    }
    // Retroactively clean up any offline duplicate / legacy ghost from the same device once clientUid is attached
    if (cleanUid && onlineSids) {
      const swept = evictDuplicateSessions(record, {
        keepSid: cleanSid,
        deviceName: entry.deviceName,
        clientKind: entry.clientKind || 'web',
        ip: entry.ip,
        clientUid: cleanUid,
        onlineSids,
        now,
      })
      if (swept.length > 0) changed = true
    }
    const stale = now - (Number(entry.lastSeenAt) || 0) > 60_000
    entry.lastSeenAt = now
    if (changed || stale) scheduleSave()
    return true
  }

  function listUserSessions(userId) {
    const record = usersById.get(userId)
    if (!record) return []
    const now = Date.now()
    pruneUserSessionData(record, now)
    return record.sessions.map((s) => ({
      sid: s.sid,
      deviceName: s.deviceName || '',
      clientKind: s.clientKind || 'web',
      ip: s.ip || '',
      createdAt: Number(s.createdAt) || 0,
      lastSeenAt: Number(s.lastSeenAt) || Number(s.createdAt) || 0,
    }))
  }

  function isSessionRevoked(userId, sid) {
    const record = usersById.get(userId)
    const cleanSid = String(sid || '').trim()
    if (!record || !cleanSid) return false
    return Boolean(record.revokedSids?.[cleanSid])
  }

  function revokeUserSession(userId, sid) {
    const record = usersById.get(userId)
    const cleanSid = String(sid || '').trim()
    if (!record || !cleanSid) return false
    const existed = Array.isArray(record.sessions) && record.sessions.some((s) => s?.sid === cleanSid)
    if (!existed) return false
    if (!record.revokedSids || typeof record.revokedSids !== 'object') record.revokedSids = {}
    const now = Date.now()
    record.revokedSids[cleanSid] = now
    record.sessions = record.sessions.filter((s) => s.sid !== cleanSid)
    pruneUserSessionData(record, now)
    save()
    return true
  }

  function setLoginEmail2fa(userId, enabled) {
    const record = usersById.get(userId)
    if (!record) return { ok: false, error: '用户不存在' }
    const next = Boolean(enabled)
    if (next && (!record.email || !record.emailVerified)) {
      return { ok: false, error: '请先绑定并验证邮箱，再开启登录二次验证' }
    }
    record.loginEmail2fa = next
    save()
    return { ok: true, user: sanitizeUser(record) }
  }

  function checkAndRememberLoginContext(userId, { deviceName = '', ip = '', clientUid = '', skipSave = false } = {}) {
    const record = usersById.get(userId)
    if (!record) return { isNewContext: false }
    const cleanIp = String(ip || '').trim()
    const cleanName = String(deviceName || '').trim()
    const cleanUid = normalizeClientUid(clientUid)
    if (!Array.isArray(record.knownLoginIps)) record.knownLoginIps = []
    const hadHistory = record.knownLoginIps.length > 0 || (Array.isArray(record.sessions) && record.sessions.length > 0)
    const knownByIp = Boolean(cleanIp && record.knownLoginIps.includes(cleanIp))
    const knownBySession = Boolean(
      Array.isArray(record.sessions) &&
      record.sessions.some(
        (s) =>
          (cleanUid && normalizeClientUid(s.clientUid) === cleanUid) ||
          (s.ip === cleanIp && (!cleanName || s.deviceName === cleanName)),
      ),
    )
    const isNewContext = Boolean(hadHistory && cleanIp && !knownByIp && !knownBySession)
    if (cleanIp) {
      record.knownLoginIps = [cleanIp, ...record.knownLoginIps.filter((x) => x !== cleanIp)].slice(0, 12)
      if (!skipSave) save()
    }
    return { isNewContext }
  }

  function revokeUserTokens(userId) {
    const record = usersById.get(userId)
    if (!record) return null
    record.tokenVersion = Number(record.tokenVersion || 0) + 1
    record.sessions = []
    record.revokedSids = {}
    save()
    return { roomId: record.userId, tokenVersion: record.tokenVersion }
  }

  function listUsers() {
    return [...usersById.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(sanitizeUser)
  }

  /**
   * Read-only sanitized user snapshot for the admin monitoring dashboard.
   * Never mutates persisted state or exposes password / deviceSecret hashes.
   */
  function listUsersForAdmin() {
    const now = Date.now()
    return [...usersById.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((u) => {
        const revoked = u.revokedSids && typeof u.revokedSids === 'object' ? u.revokedSids : {}
        const activeSessions = (Array.isArray(u.sessions) ? u.sessions : [])
          .filter((s) => s?.sid && now - (Number(s.createdAt) || 0) <= SESSION_TTL_MS && !revoked[s.sid])
          .sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0))
          .slice(0, MAX_USER_SESSIONS)
          .map((s) => ({
            sid: s.sid,
            deviceName: s.deviceName || '',
            clientKind: s.clientKind || 'web',
            ip: s.ip || '',
            createdAt: Number(s.createdAt) || 0,
            lastSeenAt: Number(s.lastSeenAt) || Number(s.createdAt) || 0,
          }))
        return {
          ...sanitizeUser(u),
          devices: (Array.isArray(u.devices) ? u.devices : []).map(sanitizeDeviceRecord),
          sessions: activeSessions,
        }
      })
  }

  return {
    userCount: () => usersById.size,
    getUserCount: () => usersById.size,
    hasAnyUser: () => usersById.size > 0,
    getTodayRegistrationCount,
    getDailyRegistrationStats,
    isEmailTaken,
    getUserByEmail,
    registerUserAsync,
    resolveAccountKey,
    markUserLogin,
    verifyUserPasswordAsync,
    authenticateUserAsync,
    setUserEmail,
    setLoginEmail2fa,
    checkAndRememberLoginContext,
    resetPasswordByEmailAsync,
    changePasswordAsync,
    flush,
    bindDevice,
    verifyDeviceBridge,
    listUserDevices,
    renameUserDevice,
    removeUserDevice,
    getUserById,
    findUserByIdentifier,
    getUserTier,
    setUserTier,
    getTurnUsage,
    addTurnUsage,
    resetTurnUsage,
    getTokenVersion,
    recordUserSession,
    touchUserSession,
    listUserSessions,
    hasUserSession,
    isSessionRevoked,
    revokeUserSession,
    revokeUserTokens,
    listUsers,
    listUsersForAdmin,
  }
}
