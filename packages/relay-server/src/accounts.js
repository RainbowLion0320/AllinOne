import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeEqual } from './auth.js'

const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // No 0/O/1/I ambiguity
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']{2,}$/
const SCRYPT_KEYLEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }

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

function generateInviteCode() {
  const bytes = randomBytes(8)
  let raw = ''
  for (let i = 0; i < 8; i += 1) {
    raw += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length]
  }
  return `INV-${raw.slice(0, 4)}-${raw.slice(4)}`
}

export function normalizeInviteCode(input) {
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

export function validateUsername(raw) {
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

  function load() {
    if (!existsSync(filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
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
          role: u.role === 'admin' ? 'admin' : 'user',
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
        invitesById.set(inv.id, inv)
      }
    } catch {}
  }

  function save() {
    const payload = JSON.stringify(
      {
        version: 1,
        users: [...usersById.values()],
        invites: [...invitesById.values()],
      },
      null,
      2,
    )
    const tmpPath = `${filePath}.tmp.${process.pid}`
    writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(tmpPath, 0o600) } catch {}
    renameSync(tmpPath, filePath)
    try { chmodSync(filePath, 0o600) } catch {}
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
    return {
      userId: u.userId,
      username: u.username,
      email: u.email || '',
      emailVerified: Boolean(u.email && u.emailVerified),
      role: u.role,
      tokenVersion: u.tokenVersion,
      createdAt: u.createdAt || 0,
      lastLoginAt: u.lastLoginAt || 0,
      deviceCount: Array.isArray(u.devices) ? u.devices.length : 0,
    }
  }

  function createInvites({ count = 1, note = '', createdBy = 'admin', grantAdmin = false } = {}) {
    const n = Math.max(1, Math.min(50, Math.floor(Number(count) || 1)))
    const cleanNote = String(note || '').trim().slice(0, 80)
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
        grantAdmin: Boolean(grantAdmin),
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
      .map((inv) => ({ ...inv }))
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
      role,
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

  function authenticateUser(identifier, password) {
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
    record.lastLoginAt = Date.now()
    save()
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

  function changePassword(userId, currentPassword, newPassword) {
    const record = usersById.get(userId)
    if (!record) return { ok: false, error: '用户不存在' }
    if (!verifyPasswordHash(currentPassword, record.passwordSalt, record.passwordHash)) {
      return { ok: false, error: '当前密码不正确' }
    }
    const pCheck = validatePassword(newPassword)
    if (!pCheck.ok) return pCheck
    const { salt, hash } = hashPassword(pCheck.password)
    record.passwordSalt = salt
    record.passwordHash = hash
    record.tokenVersion = Number(record.tokenVersion || 0) + 1
    record.sessions = []
    record.revokedSids = {}
    save()
    return { ok: true, user: sanitizeUser(record) }
  }

  function bindDevice({ userId, label = '', hostname = '', platform = 'unknown', bridgeId = '' } = {}) {
    const record = usersById.get(userId)
    if (!record) return null
    const now = Date.now()
    const deviceId = `dev_${randomBytes(6).toString('hex')}`
    const deviceSecret = `dv_${randomBytes(24).toString('hex')}`
    const cleanHost = String(hostname || label || 'My-PC').trim().slice(0, 64) || 'My-PC'
    const cleanLabel = String(label || hostname || 'My PC').trim().slice(0, 64) || cleanHost
    const baseSlug = sanitizeBridgeSlug(bridgeId || cleanHost || cleanLabel)

    const existingBridgeIds = new Set((record.devices || []).map((d) => d.bridgeId))
    let finalBridgeId = baseSlug
    if (existingBridgeIds.has(finalBridgeId)) {
      finalBridgeId = `${baseSlug.slice(0, 24)}-${deviceId.slice(4, 10)}`
    }

    const devRecord = {
      deviceId,
      bridgeId: finalBridgeId,
      label: cleanLabel,
      hostname: cleanHost,
      platform: String(platform || 'unknown').trim().slice(0, 32) || 'unknown',
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
        if (shouldPersist) save()
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
    record.sessions = record.sessions
      .filter((s) => s?.sid && now - (Number(s.createdAt) || 0) <= SESSION_TTL_MS && !record.revokedSids[s.sid])
      .sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0))
      .slice(0, MAX_USER_SESSIONS)
    for (const [sid, ts] of Object.entries(record.revokedSids)) {
      if (now - Number(ts || 0) > SESSION_TTL_MS) {
        delete record.revokedSids[sid]
      }
    }
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
    if (changed || stale) save()
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

  return {
    userCount: () => usersById.size,
    createInvites,
    listInvites,
    revokeInvite,
    hasActiveInviteCode,
    isEmailTaken,
    getUserByEmail,
    registerUser,
    authenticateUser,
    setUserEmail,
    resetPasswordByEmail,
    changePassword,
    bindDevice,
    verifyDeviceBridge,
    listUserDevices,
    renameUserDevice,
    removeUserDevice,
    getUserById,
    getTokenVersion,
    recordUserSession,
    touchUserSession,
    listUserSessions,
    isSessionRevoked,
    revokeUserSession,
    revokeUserTokens,
    listUsers,
  }
}
