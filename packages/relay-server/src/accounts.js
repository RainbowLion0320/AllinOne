import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod as chmodAsync, rename as renameAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeEqual } from './auth.js'

const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // No 0/O/1/I ambiguity
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']{2,}$/
const SCRYPT_KEYLEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }
const MAX_DEVICES_PER_USER = 20
const MAX_REVOKED_SIDS = 64

export const VALID_PLANS = new Set(['free', 'pro', 'ultra'])
export const VALID_TIERS = new Set(['free', 'pro', 'ultra', 'admin'])

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

export function normalizePlan(raw) {
  const p = String(raw || '').trim().toLowerCase()
  return VALID_PLANS.has(p) ? p : 'free'
}

export function normalizeTier(raw) {
  const t = String(raw || '').trim().toLowerCase()
  return VALID_TIERS.has(t) ? t : 'free'
}

export function resolveUserTier(user) {
  if (!user) return 'free'
  if (user.role === 'admin') return 'admin'
  return normalizePlan(user.plan)
}

export function resolveInviteTier(inv) {
  if (!inv) return 'free'
  if (inv.grantAdmin) return 'admin'
  return normalizePlan(inv.plan)
}

function sha256Hex(val) {
  return createHash('sha256').update(String(val ?? ''), 'utf8').digest('hex')
}

function hashPassword(password, saltHex) {
  const salt = saltHex || randomBytes(16).toString('hex')
  const derived = scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString('hex')
  return { salt, hash: derived }
}

function verifyPasswordHash(password, salt, expectedHashHex) {
  if (!password || !salt || !expectedHashHex) return false
  try {
    const derivedBuf = scryptSync(String(password), String(salt), SCRYPT_KEYLEN, SCRYPT_OPTS)
    const expectedBuf = Buffer.from(String(expectedHashHex), 'hex')
    if (derivedBuf.length !== expectedBuf.length) return false
    return timingSafeEqual(derivedBuf, expectedBuf)
  } catch {
    return false
  }
}

function scryptAsync(password, salt) {
  return new Promise((resolvePromise, rejectPromise) => {
    scrypt(String(password), String(salt), SCRYPT_KEYLEN, SCRYPT_OPTS, (err, derivedKey) => {
      if (err) rejectPromise(err)
      else resolvePromise(derivedKey)
    })
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
  } catch {
    return false
  }
}

function generateInviteCode() {
  const bytes = randomBytes(8)
  let raw = ''
  for (let i = 0; i < 8; i += 1) {
    raw += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length]
  }
  return `INV-${raw.slice(0, 4)}-${raw.slice(4)}`
}

function normalizeInviteCode(input) {
  let clean = String(input || '')
    .trim()
    .toUpperCase()
    .replace(/^INV[-_\s]*/i, '')
    .replace(/[^A-Z0-9]/g, '')
  if (clean.length !== 8) return ''
  return `INV-${clean.slice(0, 4)}-${clean.slice(4)}`
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
 * Lightweight, zero-dependency account + single-use invite code + per-PC device credential store.
 * Persists to JSON with `0600` permissions using atomic temp-file rename:
 *  - Passwords stored strictly as salted `scrypt` hashes (never plaintext)
 *  - Per-PC `deviceSecret` stored strictly as salted SHA-256 hashes (never plaintext)
 *  - Invite codes are strictly single-use: burned synchronously inside `registerUser()`
 */
export function createAccountStore({ filePath }) {
  mkdirSync(dirname(filePath), { recursive: true })

  /** @type {Map<string, any>} */
  const usersById = new Map()
  /** @type {Map<string, string>} */
  const userIdByLower = new Map()
  /** @type {Map<string, string>} */
  const userIdByEmailLower = new Map()
  /** @type {Map<string, any>} */
  const invitesById = new Map()
  /** @type {Set<string>} */
  const changingPasswordUsers = new Set()

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
      const rawEmail = String(u.email || '').trim()
      const emailLower = rawEmail ? String(u.emailLower || rawEmail).trim().toLowerCase() : ''
      const normalized = {
        ...u,
        usernameLower: String(u.usernameLower || u.username).toLowerCase(),
        email: rawEmail,
        emailLower,
        emailVerified: Boolean(rawEmail && u.emailVerified),
        emailVerifiedAt: Number(u.emailVerifiedAt) || 0,
        loginEmail2fa: Boolean(rawEmail && u.emailVerified && u.loginEmail2fa),
        knownLoginIps: Array.isArray(u.knownLoginIps) ? u.knownLoginIps.filter(Boolean).slice(0, 12) : [],
        role: u.role === 'admin' ? 'admin' : 'user',
        plan: u.role === 'admin' ? 'free' : normalizePlan(u.plan),
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
    for (const inv of Array.isArray(parsed?.invites) ? parsed.invites : []) {
      if (!inv?.id || !inv?.code) continue
      const grantAdmin = Boolean(inv.grantAdmin)
      const plan = grantAdmin ? 'free' : normalizePlan(inv.plan)
      invitesById.set(inv.id, {
        ...inv,
        grantAdmin,
        plan,
        tier: grantAdmin ? 'admin' : plan,
      })
    }
  }

  let saveTimer = null
  let saveDirty = false
  let asyncSaveInFlight = null

  function serializeAccountsPayload() {
    return JSON.stringify(
      {
        version: 1,
        users: [...usersById.values()],
        invites: [...invitesById.values()],
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
    saveDirty = false
    const payload = serializeAccountsPayload()
    const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
    try {
      writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmpPath, 0o600) } catch {}
      renameSync(tmpPath, filePath)
      try { chmodSync(filePath, 0o600) } catch {}
    } catch (err) {
      try { unlinkSync(tmpPath) } catch {}
      throw err
    }
  }

  async function drainAsyncSave() {
    if (asyncSaveInFlight) return asyncSaveInFlight
    asyncSaveInFlight = (async () => {
      while (saveDirty) {
        saveDirty = false
        const payload = serializeAccountsPayload()
        const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
        try {
          await writeFileAsync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
          try { await chmodAsync(tmpPath, 0o600) } catch {}
          await renameAsync(tmpPath, filePath)
          try { await chmodAsync(filePath, 0o600) } catch {}
        } catch (err) {
          try { await unlinkAsync(tmpPath) } catch {}
          console.error(`[accounts] Async save failed: ${err?.message || err}`)
          break
        }
      }
    })().finally(() => {
      asyncSaveInFlight = null
      if (saveDirty) {
        scheduleSave(1000)
      }
    })
    return asyncSaveInFlight
  }

  /**
   * Coalesce high-frequency non-critical metadata writes (e.g. lastSeenAt heartbeats)
   * into a single serialized non-blocking disk write every few seconds.
   */
  function scheduleSave(delayMs = 5000) {
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
    if (saveDirty) {
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
    const role = u.role === 'admin' ? 'admin' : 'user'
    const plan = role === 'admin' ? 'free' : normalizePlan(u.plan)
    const tier = role === 'admin' ? 'admin' : plan
    return {
      userId: u.userId,
      username: u.username,
      email: u.email || '',
      emailVerified: Boolean(u.email && u.emailVerified),
      loginEmail2fa: Boolean(u.email && u.emailVerified && u.loginEmail2fa),
      role,
      plan,
      tier,
      turnUsage: normalizeTurnUsageRecord(u.turnUsage),
      tokenVersion: u.tokenVersion,
      createdAt: u.createdAt || 0,
      lastLoginAt: u.lastLoginAt || 0,
      deviceCount: Array.isArray(u.devices) ? u.devices.length : 0,
    }
  }

  function createInvites({ count = 1, note = '', createdBy = 'admin', grantAdmin = false, plan = '', tier = '' } = {}) {
    const n = Math.max(1, Math.min(50, Math.floor(Number(count) || 1)))
    const cleanNote = String(note || '').trim().slice(0, 80)
    const resolvedTier = grantAdmin
      ? 'admin'
      : String(tier || '').trim()
        ? normalizeTier(tier)
        : String(plan || '').trim()
          ? normalizePlan(plan)
          : 'free'
    const finalGrantAdmin = resolvedTier === 'admin'
    const finalPlan = finalGrantAdmin ? 'free' : normalizePlan(resolvedTier)
    const existingCodes = new Set([...invitesById.values()].map((i) => i.code))
    const created = []
    const now = Date.now()

    for (let i = 0; i < n; i += 1) {
      let code = generateInviteCode()
      while (existingCodes.has(code)) {
        code = generateInviteCode()
      }
      existingCodes.add(code)
      const record = {
        id: `inv_${randomBytes(6).toString('hex')}`,
        code,
        note: cleanNote,
        grantAdmin: finalGrantAdmin,
        plan: finalPlan,
        tier: resolvedTier,
        createdBy: String(createdBy || 'admin').slice(0, 64),
        createdAt: now,
        status: 'active', // 'active' | 'used' | 'revoked'
        usedByUserId: '',
        usedByUsername: '',
        usedAt: 0,
        revokedAt: 0,
      }
      invitesById.set(record.id, record)
      created.push({ ...record })
    }
    save()
    return created
  }

  function listInvites() {
    return [...invitesById.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((inv) => {
        const grantAdmin = Boolean(inv.grantAdmin)
        const plan = grantAdmin ? 'free' : normalizePlan(inv.plan)
        return { ...inv, grantAdmin, plan, tier: grantAdmin ? 'admin' : plan }
      })
  }

  function revokeInvite(idOrCode) {
    const raw = String(idOrCode || '').trim()
    if (!raw) return null
    const normalizedCode = normalizeInviteCode(raw)
    let target = invitesById.get(raw) || null
    if (!target && normalizedCode) {
      for (const inv of invitesById.values()) {
        if (safeEqual(inv.code, normalizedCode)) {
          target = inv
          break
        }
      }
    }
    if (!target) return null
    if (target.status !== 'active') {
      return { ok: false, error: target.status === 'used' ? '该邀请码已被使用，无法作废' : '该邀请码已经作废', invite: { ...target } }
    }
    target.status = 'revoked'
    target.revokedAt = Date.now()
    save()
    return { ok: true, invite: { ...target } }
  }

  function hasActiveInviteCode(inviteCode) {
    const normalized = normalizeInviteCode(inviteCode)
    if (!normalized) return false
    for (const inv of invitesById.values()) {
      if (inv.status === 'active' && safeEqual(inv.code, normalized)) {
        return true
      }
    }
    return false
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

  function registerUser({
    username,
    password,
    inviteCode = '',
    email = '',
    emailVerified = false,
    isBootstrapAdmin = false,
  } = {}) {
    const uCheck = validateUsername(username)
    if (!uCheck.ok) return uCheck
    const pCheck = validatePassword(password)
    if (!pCheck.ok) return pCheck

    if (userIdByLower.has(uCheck.usernameLower)) {
      return { ok: false, error: '该用户名已被注册，请换一个用户名' }
    }

    let cleanEmail = ''
    let cleanEmailLower = ''
    if (String(email || '').trim()) {
      const eCheck = validateEmail(email)
      if (!eCheck.ok) return eCheck
      if (userIdByEmailLower.has(eCheck.emailLower)) {
        return { ok: false, error: '该邮箱已被其他账号绑定' }
      }
      cleanEmail = eCheck.email
      cleanEmailLower = eCheck.emailLower
    }

    let matchedInvite = null
    if (!isBootstrapAdmin) {
      const normalized = normalizeInviteCode(inviteCode)
      if (!normalized) {
        return { ok: false, error: '请输入有效的一次性邀请码（格式如 INV-XXXX-XXXX）' }
      }
      for (const inv of invitesById.values()) {
        if (inv.status === 'active' && safeEqual(inv.code, normalized)) {
          matchedInvite = inv
          break
        }
      }
      if (!matchedInvite) {
        return { ok: false, error: '邀请码无效、已被使用或已作废，请联系管理员获取新邀请码' }
      }
    }

    const now = Date.now()
    const userId = `usr_${randomBytes(8).toString('hex')}`
    const { salt, hash } = hashPassword(pCheck.password)
    const role = isBootstrapAdmin || matchedInvite?.grantAdmin ? 'admin' : 'user'
    const plan = role === 'admin' ? 'free' : normalizePlan(matchedInvite?.plan)

    // Strictly burn the single-use invite synchronously before persisting
    if (matchedInvite) {
      matchedInvite.status = 'used'
      matchedInvite.usedByUserId = userId
      matchedInvite.usedByUsername = uCheck.username
      matchedInvite.usedAt = now
    }

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
      role,
      plan,
      passwordSalt: salt,
      passwordHash: hash,
      tokenVersion: 0,
      createdAt: now,
      lastLoginAt: now,
      invitedBy: isBootstrapAdmin ? 'bootstrap' : matchedInvite?.createdBy || '',
      inviteId: matchedInvite?.id || '',
      devices: [],
      sessions: [],
      revokedSids: {},
    }

    usersById.set(userId, record)
    userIdByLower.set(record.usernameLower, userId)
    if (record.emailLower) {
      userIdByEmailLower.set(record.emailLower, userId)
    }
    save()

    return {
      ok: true,
      user: sanitizeUser(record),
      devices: [],
    }
  }

  async function registerUserAsync({
    username,
    password,
    inviteCode = '',
    email = '',
    emailVerified = false,
    isBootstrapAdmin = false,
  } = {}) {
    const uCheck = validateUsername(username)
    if (!uCheck.ok) return uCheck
    const pCheck = validatePassword(password)
    if (!pCheck.ok) return pCheck

    if (userIdByLower.has(uCheck.usernameLower)) {
      return { ok: false, error: '该用户名已被注册，请换一个用户名' }
    }

    let cleanEmail = ''
    let cleanEmailLower = ''
    if (String(email || '').trim()) {
      const eCheck = validateEmail(email)
      if (!eCheck.ok) return eCheck
      if (userIdByEmailLower.has(eCheck.emailLower)) {
        return { ok: false, error: '该邮箱已被其他账号绑定' }
      }
      cleanEmail = eCheck.email
      cleanEmailLower = eCheck.emailLower
    }

    const normalizedInvite = isBootstrapAdmin ? '' : normalizeInviteCode(inviteCode)
    if (!isBootstrapAdmin) {
      if (!normalizedInvite) {
        return { ok: false, error: '请输入有效的一次性邀请码（格式如 INV-XXXX-XXXX）' }
      }
      let preMatched = null
      for (const inv of invitesById.values()) {
        if (inv.status === 'active' && safeEqual(inv.code, normalizedInvite)) {
          preMatched = inv
          break
        }
      }
      if (!preMatched) {
        return { ok: false, error: '邀请码无效、已被使用或已作废，请联系管理员获取新邀请码' }
      }
    }

    // Offload expensive scrypt hashing to libuv worker pool so event loop never stalls
    const { salt, hash } = await hashPasswordAsync(pCheck.password)

    // Re-verify uniqueness & single-use invite state synchronously after await (prevents TOCTOU races)
    if (isBootstrapAdmin && usersById.size > 0) {
      return { ok: false, error: '管理员账号已初始化，请使用邀请码注册' }
    }
    if (userIdByLower.has(uCheck.usernameLower)) {
      return { ok: false, error: '该用户名已被注册，请换一个用户名' }
    }
    if (cleanEmailLower && userIdByEmailLower.has(cleanEmailLower)) {
      return { ok: false, error: '该邮箱已被其他账号绑定' }
    }

    let matchedInvite = null
    if (!isBootstrapAdmin) {
      for (const inv of invitesById.values()) {
        if (inv.status === 'active' && safeEqual(inv.code, normalizedInvite)) {
          matchedInvite = inv
          break
        }
      }
      if (!matchedInvite) {
        return { ok: false, error: '邀请码无效、已被使用或已作废，请联系管理员获取新邀请码' }
      }
    }

    const now = Date.now()
    const userId = `usr_${randomBytes(8).toString('hex')}`
    const role = isBootstrapAdmin || matchedInvite?.grantAdmin ? 'admin' : 'user'
    const plan = role === 'admin' ? 'free' : normalizePlan(matchedInvite?.plan)

    if (matchedInvite) {
      matchedInvite.status = 'used'
      matchedInvite.usedByUserId = userId
      matchedInvite.usedByUsername = uCheck.username
      matchedInvite.usedAt = now
    }

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
      role,
      plan,
      passwordSalt: salt,
      passwordHash: hash,
      tokenVersion: 0,
      createdAt: now,
      lastLoginAt: now,
      invitedBy: isBootstrapAdmin ? 'bootstrap' : matchedInvite?.createdBy || '',
      inviteId: matchedInvite?.id || '',
      devices: [],
      sessions: [],
      revokedSids: {},
    }

    usersById.set(userId, record)
    userIdByLower.set(record.usernameLower, userId)
    if (record.emailLower) {
      userIdByEmailLower.set(record.emailLower, userId)
    }
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
    return userId || lower
  }

  function markUserLogin(userId) {
    const record = usersById.get(userId)
    if (!record) return null
    record.lastLoginAt = Date.now()
    scheduleSave()
    return sanitizeUser(record)
  }

  function authenticateUser(identifier, password, { recordLogin = true } = {}) {
    const lower = String(identifier || '').trim().toLowerCase()
    if (!lower || !password) return null
    let userId = userIdByLower.get(lower)
    if (!userId && lower.includes('@')) {
      userId = userIdByEmailLower.get(lower)
    }
    if (!userId) return null
    const record = usersById.get(userId)
    if (!record) return null
    if (!verifyPasswordHash(password, record.passwordSalt, record.passwordHash)) {
      return null
    }
    if (recordLogin) {
      record.lastLoginAt = Date.now()
      scheduleSave()
    }
    return {
      user: sanitizeUser(record),
      devices: record.devices.map(sanitizeDeviceRecord),
    }
  }

  async function authenticateUserAsync(identifier, password, { recordLogin = true } = {}) {
    const lower = String(identifier || '').trim().toLowerCase()
    if (!lower || !password) return null
    let userId = userIdByLower.get(lower)
    if (!userId && lower.includes('@')) {
      userId = userIdByEmailLower.get(lower)
    }
    if (!userId) return null
    const record = usersById.get(userId)
    if (!record) return null
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

  function resetPasswordByEmail(email, newPassword) {
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
    const { salt, hash } = hashPassword(pCheck.password)
    record.passwordSalt = salt
    record.passwordHash = hash
    record.tokenVersion = Number(record.tokenVersion || 0) + 1
    record.sessions = []
    record.revokedSids = {}
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
    const { salt, hash } = await hashPasswordAsync(pCheck.password)
    if (usersById.get(userId) !== record) {
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

    // Allow rebinding an existing explicit bridgeId in-place even when at MAX_DEVICES_PER_USER
    const existingDevice = explicitBridgeSlug
      ? record.devices.find((d) => d.bridgeId === explicitBridgeSlug)
      : null
    if (existingDevice) {
      const deviceSecret = `dv_${randomBytes(24).toString('hex')}`
      existingDevice.label = cleanLabel
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
    if (raw === 'admin') {
      record.role = 'admin'
      record.plan = 'free'
    } else {
      record.role = 'user'
      record.plan = raw
    }
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

  function pruneUserSessionData(record, now = Date.now()) {
    if (!Array.isArray(record.sessions)) record.sessions = []
    if (!record.revokedSids || typeof record.revokedSids !== 'object') record.revokedSids = {}
    const active = record.sessions
      .filter((s) => s?.sid && now - (Number(s.createdAt) || 0) <= SESSION_TTL_MS && !record.revokedSids[s.sid])
      .sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0))
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

  function hasUserSession(userId, sid) {
    const record = usersById.get(userId)
    const cleanSid = String(sid || '').trim()
    if (!record || !cleanSid || !Array.isArray(record.sessions)) return false
    return record.sessions.some((s) => s?.sid === cleanSid)
  }

  function recordUserSession(userId, { sid, deviceName = '', clientKind = 'web', ip = '' } = {}) {
    const record = usersById.get(userId)
    const cleanSid = String(sid || '').trim()
    if (!record || !cleanSid) return null
    const now = Date.now()
    pruneUserSessionData(record, now)
    const cleanName = String(deviceName || '').trim().slice(0, 64)
    const cleanKind = clientKind === 'desktop' || clientKind === 'mobile' ? clientKind : 'web'
    const cleanIp = String(ip || '').trim().slice(0, 64)
    let entry = record.sessions.find((s) => s.sid === cleanSid)
    if (entry) {
      if (cleanName) entry.deviceName = cleanName
      entry.clientKind = cleanKind
      if (cleanIp) entry.ip = cleanIp
      entry.lastSeenAt = now
    } else {
      entry = {
        sid: cleanSid,
        deviceName: cleanName || 'Unknown Device',
        clientKind: cleanKind,
        ip: cleanIp,
        createdAt: now,
        lastSeenAt: now,
      }
      record.sessions.unshift(entry)
    }
    pruneUserSessionData(record, now)
    save()
    return { ...entry }
  }

  function touchUserSession(userId, sid, { deviceName = '', clientKind = '', ip = '' } = {}) {
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
    if (!entry) {
      recordUserSession(userId, { sid: cleanSid, deviceName: cleanName, clientKind: cleanKind || 'web', ip: cleanIp })
      return true
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
    if (!record.revokedSids || typeof record.revokedSids !== 'object') record.revokedSids = {}
    const now = Date.now()
    record.revokedSids[cleanSid] = now
    if (Array.isArray(record.sessions)) {
      record.sessions = record.sessions.filter((s) => s.sid !== cleanSid)
    }
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

  function checkAndRememberLoginContext(userId, { deviceName = '', ip = '' } = {}) {
    const record = usersById.get(userId)
    if (!record) return { isNewContext: false }
    const cleanIp = String(ip || '').trim()
    const cleanName = String(deviceName || '').trim()
    if (!Array.isArray(record.knownLoginIps)) record.knownLoginIps = []
    const hadHistory = record.knownLoginIps.length > 0 || (Array.isArray(record.sessions) && record.sessions.length > 0)
    const knownByIp = Boolean(cleanIp && record.knownLoginIps.includes(cleanIp))
    const knownBySession = Boolean(
      Array.isArray(record.sessions) &&
      record.sessions.some((s) => s.ip === cleanIp && (!cleanName || s.deviceName === cleanName)),
    )
    const isNewContext = Boolean(hadHistory && cleanIp && !knownByIp && !knownBySession)
    if (cleanIp) {
      record.knownLoginIps = [cleanIp, ...record.knownLoginIps.filter((x) => x !== cleanIp)].slice(0, 12)
      save()
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
          invitedBy: u.invitedBy || '',
          inviteId: u.inviteId || '',
          devices: (Array.isArray(u.devices) ? u.devices : []).map(sanitizeDeviceRecord),
          sessions: activeSessions,
        }
      })
  }

  return {
    userCount: () => usersById.size,
    createInvites,
    listInvites,
    revokeInvite,
    hasActiveInviteCode,
    isEmailTaken,
    getUserByEmail,
    registerUser,
    registerUserAsync,
    resolveAccountKey,
    markUserLogin,
    authenticateUser,
    authenticateUserAsync,
    setUserEmail,
    setLoginEmail2fa,
    checkAndRememberLoginContext,
    resetPasswordByEmail,
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
