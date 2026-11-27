import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { VALID_TIERS as SHARED_TIERS } from '@allinone/shared'
import { safeEqual } from './auth.js'

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']{2,}$/
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
const SCRYPT_KEYLEN = 64
const CURRENT_SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const LEGACY_SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }
const PHC_SCRYPT_RE = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([a-f0-9]+)\$([a-f0-9]+)$/i
const UV_POOL_SIZE = Math.max(4, Number(process.env.UV_THREADPOOL_SIZE) || 4)
// Keep at least half of libuv's threadpool free for disk/DNS/static I/O
const SCRYPT_MAX_CONCURRENT = Math.max(2, Math.min(8, Math.floor(UV_POOL_SIZE / 2)))
const SCRYPT_MAX_QUEUE = 64
const DUMMY_SCRYPT_SALT = '00112233445566778899aabbccddeeff'
const MAX_DEVICES_PER_USER = 20
const MAX_DAILY_REG_DAYS = 14
const DEFAULT_MAX_DAILY_REGISTRATIONS = 20
const SCHEMA_VERSION = 1

export const VALID_TIERS = new Set(SHARED_TIERS)

export function getLocalDayKey(ts = Date.now()) {
  const d = ts instanceof Date ? ts : new Date(ts)
  if (Number.isNaN(d.getTime())) return getLocalDayKey(Date.now())
  // Deterministic UTC day boundary (immune to DST or host timezone drift)
  return d.toISOString().slice(0, 10)
}

export function normalizeMaxDailyRegistrations(raw, fallback = DEFAULT_MAX_DAILY_REGISTRATIONS) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(100_000, Math.floor(n))
}

export function getCurrentTurnMonth(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  return d.toISOString().slice(0, 7)
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
    scrypt(job.password, job.salt, SCRYPT_KEYLEN, job.opts, (err, derivedKey) => {
      scryptActive -= 1
      pumpScryptQueue()
      if (err) job.reject(err)
      else job.resolve(derivedKey)
    })
  }
}

function scryptAsync(password, salt, opts = CURRENT_SCRYPT_OPTS) {
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
      opts,
      resolve: resolvePromise,
      reject: rejectPromise,
    })
    pumpScryptQueue()
  })
}

async function hashPasswordAsync(password, saltHex) {
  const salt = saltHex || randomBytes(16).toString('hex')
  const derivedHex = (await scryptAsync(password, salt, CURRENT_SCRYPT_OPTS)).toString('hex')
  const phc = `$scrypt$N=${CURRENT_SCRYPT_OPTS.N},r=${CURRENT_SCRYPT_OPTS.r},p=${CURRENT_SCRYPT_OPTS.p}$${salt}$${derivedHex}`
  return { salt, hash: phc }
}

function parseStoredPasswordHash(salt, storedHash) {
  const str = String(storedHash || '')
  const m = PHC_SCRYPT_RE.exec(str)
  if (m) {
    const N = Number(m[1])
    const r = Number(m[2])
    const p = Number(m[3])
    if (
      Number.isInteger(N) && N >= 1024 && N <= 1048576 &&
      Number.isInteger(r) && r >= 1 && r <= 64 &&
      Number.isInteger(p) && p >= 1 && p <= 16
    ) {
      return {
        salt: m[4],
        expectedHex: m[5],
        opts: { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) },
        needsUpgrade: N < CURRENT_SCRYPT_OPTS.N || r !== CURRENT_SCRYPT_OPTS.r || p !== CURRENT_SCRYPT_OPTS.p,
      }
    }
  }
  return {
    salt: String(salt || ''),
    expectedHex: str,
    opts: LEGACY_SCRYPT_OPTS,
    needsUpgrade: true,
  }
}

async function verifyPasswordHashAsync(password, salt, storedHash) {
  if (!password || !storedHash) return { ok: false, needsUpgrade: false }
  const parsed = parseStoredPasswordHash(salt, storedHash)
  if (!parsed.salt || !parsed.expectedHex) return { ok: false, needsUpgrade: false }
  try {
    const derivedBuf = await scryptAsync(password, parsed.salt, parsed.opts)
    const expectedBuf = Buffer.from(parsed.expectedHex, 'hex')
    if (derivedBuf.length !== expectedBuf.length) return { ok: false, needsUpgrade: false }
    const ok = timingSafeEqual(derivedBuf, expectedBuf)
    return { ok, needsUpgrade: ok && parsed.needsUpgrade }
  } catch (err) {
    if (err?.statusCode === 503) throw err
    return { ok: false, needsUpgrade: false }
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

function safeJsonParse(raw, fallback) {
  try {
    const parsed = JSON.parse(String(raw || ''))
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

export function resolveAccountsDbPath(filePath) {
  const clean = String(filePath || '').trim()
  if (/\.json$/i.test(clean)) return clean.replace(/\.json$/i, '.db')
  return clean
}

/**
 * ACID SQLite (WAL) Account, Device Credential, Session & Monthly TURN Metering Store.
 *
 * Uses Node.js 22+ built-in `node:sqlite` (zero external dependencies):
 *  - Per-column targeted SQL transactions so live `admin-cli.js` edits are never clobbered
 *  - `PRAGMA data_version` checked inside `BEGIN IMMEDIATE` before any write, merging
 *    pending in-memory telemetry deltas instead of dropping them on external reloads
 *  - WAL size cap (`journal_size_limit = 64 MB`), `0600` sidecar permissions (`-wal`/`-shm`),
 *    and `PRAGMA wal_checkpoint(TRUNCATE)` on clean close
 *  - Upgradable PHC-format scrypt password hashes (`$scrypt$N=32768,r=8,p=1$...`)
 */
export function createAccountStore({ filePath }) {
  const dbPath = resolveAccountsDbPath(filePath)
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new DatabaseSync(dbPath)
  let walSidecarsHardened = false

  function hardenDbFilePermissions(force = false) {
    if (!force && walSidecarsHardened) return
    let walSeen = false
    let shmSeen = false
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${dbPath}${suffix}`
      try {
        if (existsSync(target)) {
          chmodSync(target, 0o600)
          if (suffix === '-wal') walSeen = true
          if (suffix === '-shm') shmSeen = true
        }
      } catch {}
    }
    if (walSeen && shmSeen) walSidecarsHardened = true
  }

  hardenDbFilePermissions(true)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_size_limit = 67108864;
    PRAGMA foreign_keys = ON;
  `)
  hardenDbFilePermissions(true)

  const currentSchemaVer = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0)
  if (currentSchemaVer < SCHEMA_VERSION) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          username_lower TEXT NOT NULL UNIQUE,
          email TEXT NOT NULL DEFAULT '',
          email_lower TEXT NOT NULL DEFAULT '',
          email_verified INTEGER NOT NULL DEFAULT 0,
          email_verified_at INTEGER NOT NULL DEFAULT 0,
          login_email_2fa INTEGER NOT NULL DEFAULT 0,
          tier TEXT NOT NULL DEFAULT 'free',
          role TEXT NOT NULL DEFAULT 'user',
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_login_at INTEGER NOT NULL,
          known_login_ips_json TEXT NOT NULL DEFAULT '[]',
          turn_usage_json TEXT NOT NULL DEFAULT '{}',
          devices_json TEXT NOT NULL DEFAULT '[]',
          sessions_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(email_lower) WHERE email_lower != '';
        CREATE TABLE IF NOT EXISTS daily_registrations (
          day_key TEXT PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0
        );
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
      db.exec('COMMIT')
      hardenDbFilePermissions(true)
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  }

  const stmtUpsertUser = db.prepare(`
    INSERT INTO users (
      user_id, username, username_lower, email, email_lower,
      email_verified, email_verified_at, login_email_2fa, tier, role,
      password_salt, password_hash, token_version, created_at, last_login_at,
      known_login_ips_json, turn_usage_json, devices_json, sessions_json
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      username_lower = excluded.username_lower,
      email = excluded.email,
      email_lower = excluded.email_lower,
      email_verified = excluded.email_verified,
      email_verified_at = excluded.email_verified_at,
      login_email_2fa = excluded.login_email_2fa,
      tier = excluded.tier,
      role = excluded.role,
      password_salt = excluded.password_salt,
      password_hash = excluded.password_hash,
      token_version = excluded.token_version,
      last_login_at = excluded.last_login_at,
      known_login_ips_json = excluded.known_login_ips_json,
      turn_usage_json = excluded.turn_usage_json,
      devices_json = excluded.devices_json,
      sessions_json = excluded.sessions_json
  `)

  // Targeted column updates prevent concurrent admin-cli.js edits (tier/role/etc.) from ever being reverted
  const stmtUpdatePasswordOnly = db.prepare(
    'UPDATE users SET password_salt = ?, password_hash = ? WHERE user_id = ?',
  )
  const stmtUpdatePasswordAndRevoke = db.prepare(
    'UPDATE users SET password_salt = ?, password_hash = ?, token_version = ?, sessions_json = ? WHERE user_id = ?',
  )
  const stmtUpdateEmail = db.prepare(
    'UPDATE users SET email = ?, email_lower = ?, email_verified = ?, email_verified_at = ? WHERE user_id = ?',
  )
  const stmtUpdateLogin2fa = db.prepare('UPDATE users SET login_email_2fa = ? WHERE user_id = ?')
  const stmtUpdateTierRole = db.prepare('UPDATE users SET tier = ?, role = ? WHERE user_id = ?')
  const stmtUpdateLastLogin = db.prepare('UPDATE users SET last_login_at = ? WHERE user_id = ?')
  const stmtUpdateTurnUsage = db.prepare('UPDATE users SET turn_usage_json = ? WHERE user_id = ?')
  const stmtUpdateDevices = db.prepare('UPDATE users SET devices_json = ? WHERE user_id = ?')
  const stmtUpdateSessions = db.prepare('UPDATE users SET sessions_json = ? WHERE user_id = ?')
  const stmtUpdateSessionsAndLoginIps = db.prepare(
    'UPDATE users SET sessions_json = ?, known_login_ips_json = ? WHERE user_id = ?',
  )
  const stmtUpdateKnownLoginIps = db.prepare('UPDATE users SET known_login_ips_json = ? WHERE user_id = ?')
  const stmtUpdateRevokeTokens = db.prepare(
    'UPDATE users SET token_version = ?, sessions_json = ? WHERE user_id = ?',
  )

  const stmtUpsertDaily = db.prepare(`
    INSERT INTO daily_registrations (day_key, count) VALUES (?, ?)
    ON CONFLICT(day_key) DO UPDATE SET count = excluded.count
  `)

  const stmtPruneDaily = db.prepare('DELETE FROM daily_registrations WHERE day_key < ?')
  const stmtAllUsers = db.prepare('SELECT * FROM users')
  const stmtAllDaily = db.prepare('SELECT day_key, count FROM daily_registrations')
  const stmtDataVersion = db.prepare('PRAGMA data_version')
  const stmtUserCount = db.prepare('SELECT COUNT(*) AS cnt FROM users')
  const stmtHealthCheck = db.prepare('SELECT 1 AS ok')

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

  // Deferred hot-path telemetry deltas (preserved across external `data_version` reloads)
  /** @type {Set<string>} */
  const dirtyTelemetryUsers = new Set()
  /** @type {Map<string, { month: string, bytes: number, updatedAt: number }>} */
  const pendingTurnDelta = new Map()
  /** @type {Map<string, number>} */
  const pendingLastLogin = new Map()
  /** @type {Map<string, Map<string, number>>} */
  const pendingDeviceLastSeen = new Map()
  /** @type {Map<string, { patches: Map<string, any>, evictedSids: Set<string> }>} */
  const pendingSessionTouches = new Map()

  let closed = false
  let lastDataVersion = 0
  let lastPersistError = ''
  let flushTimer = null

  function pruneDirtyFlagIfClean(userId) {
    if (
      !pendingTurnDelta.has(userId) &&
      !pendingLastLogin.has(userId) &&
      !pendingDeviceLastSeen.has(userId) &&
      !pendingSessionTouches.has(userId)
    ) {
      dirtyTelemetryUsers.delete(userId)
    }
  }

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

  function rowToUserRecord(row) {
    const rawEmail = String(row.email || '').trim()
    const emailLower = rawEmail ? String(row.email_lower || rawEmail).trim().toLowerCase() : ''
    const tier = normalizeTier(row.tier || (row.role === 'admin' ? 'admin' : 'free'))
    const role = tier === 'admin' ? 'admin' : 'user'
    const parsedIps = safeJsonParse(row.known_login_ips_json, [])
    const parsedDevices = safeJsonParse(row.devices_json, [])
    const parsedSessions = safeJsonParse(row.sessions_json, [])
    return {
      userId: String(row.user_id),
      username: String(row.username),
      usernameLower: String(row.username_lower || row.username).toLowerCase(),
      email: rawEmail,
      emailLower,
      emailVerified: Boolean(rawEmail && row.email_verified),
      emailVerifiedAt: Number(row.email_verified_at) || 0,
      loginEmail2fa: Boolean(rawEmail && row.email_verified && row.login_email_2fa),
      tier,
      role,
      passwordSalt: String(row.password_salt || ''),
      passwordHash: String(row.password_hash || ''),
      tokenVersion: Number.isFinite(Number(row.token_version)) ? Math.max(0, Math.floor(Number(row.token_version))) : 0,
      createdAt: Number(row.created_at) || 0,
      lastLoginAt: Number(row.last_login_at) || 0,
      knownLoginIps: Array.isArray(parsedIps) ? parsedIps.filter(Boolean).slice(0, 12) : [],
      turnUsage: normalizeTurnUsageRecord(safeJsonParse(row.turn_usage_json, null)),
      devices: Array.isArray(parsedDevices) ? parsedDevices : [],
      sessions: Array.isArray(parsedSessions) ? parsedSessions : [],
    }
  }

  function persistUserRow(record) {
    stmtUpsertUser.run(
      record.userId,
      record.username,
      record.usernameLower,
      record.email || '',
      record.emailLower || '',
      record.emailVerified ? 1 : 0,
      Number(record.emailVerifiedAt) || 0,
      record.loginEmail2fa ? 1 : 0,
      record.tier,
      record.role,
      record.passwordSalt || '',
      record.passwordHash || '',
      Number(record.tokenVersion) || 0,
      Number(record.createdAt) || 0,
      Number(record.lastLoginAt) || 0,
      JSON.stringify(Array.isArray(record.knownLoginIps) ? record.knownLoginIps.slice(0, 12) : []),
      JSON.stringify(record.turnUsage || normalizeTurnUsageRecord(null)),
      JSON.stringify(Array.isArray(record.devices) ? record.devices : []),
      JSON.stringify(Array.isArray(record.sessions) ? record.sessions : []),
    )
  }

  /**
   * Merge buffered in-memory telemetry deltas onto freshly reloaded SQLite rows so
   * an external `admin-cli.js` edit NEVER discards unflushed usage/session/login updates.
   */
  function mergePendingTelemetryIntoMemory() {
    for (const uid of [...dirtyTelemetryUsers]) {
      const rec = usersById.get(uid)
      if (!rec) {
        dirtyTelemetryUsers.delete(uid)
        pendingTurnDelta.delete(uid)
        pendingLastLogin.delete(uid)
        pendingDeviceLastSeen.delete(uid)
        pendingSessionTouches.delete(uid)
        continue
      }
      const turnDelta = pendingTurnDelta.get(uid)
      if (turnDelta && turnDelta.bytes > 0) {
        const cur = normalizeTurnUsageRecord(rec.turnUsage)
        if (cur.month === turnDelta.month) {
          rec.turnUsage = {
            month: cur.month,
            bytes: cur.bytes + turnDelta.bytes,
            updatedAt: Math.max(cur.updatedAt || 0, turnDelta.updatedAt || 0),
          }
        } else if (turnDelta.month > cur.month) {
          rec.turnUsage = { ...turnDelta }
        }
      }
      const loginTs = pendingLastLogin.get(uid)
      if (loginTs) {
        rec.lastLoginAt = Math.max(Number(rec.lastLoginAt) || 0, loginTs)
      }
      const devMap = pendingDeviceLastSeen.get(uid)
      if (devMap && devMap.size > 0 && Array.isArray(rec.devices)) {
        for (const dev of rec.devices) {
          const ts = devMap.get(dev.deviceId)
          if (ts) dev.lastSeenAt = Math.max(Number(dev.lastSeenAt) || 0, ts)
        }
      }
      const sessPending = pendingSessionTouches.get(uid)
      if (sessPending && Array.isArray(rec.sessions)) {
        if (sessPending.evictedSids.size > 0) {
          rec.sessions = rec.sessions.filter((s) => s?.sid && !sessPending.evictedSids.has(s.sid))
        }
        for (const s of rec.sessions) {
          const patch = sessPending.patches.get(s.sid)
          if (!patch) continue
          if (patch.deviceName) s.deviceName = patch.deviceName
          if (patch.clientKind) s.clientKind = patch.clientKind
          if (patch.ip) s.ip = patch.ip
          if (patch.clientUid) s.clientUid = patch.clientUid
          if (patch.lastSeenAt) s.lastSeenAt = Math.max(Number(s.lastSeenAt) || 0, patch.lastSeenAt)
        }
      }
    }
  }

  function loadAllFromDb() {
    usersById.clear()
    userIdByLower.clear()
    userIdByEmailLower.clear()

    const rows = stmtAllUsers.all()
    const countedByDay = {}
    for (const row of rows) {
      const normalized = rowToUserRecord(row)
      usersById.set(normalized.userId, normalized)
      userIdByLower.set(normalized.usernameLower, normalized.userId)
      if (normalized.emailLower) {
        userIdByEmailLower.set(normalized.emailLower, normalized.userId)
      }
      if (normalized.createdAt) {
        const dk = getLocalDayKey(normalized.createdAt)
        countedByDay[dk] = (countedByDay[dk] || 0) + 1
      }
    }

    const rawDaily = {}
    for (const dRow of stmtAllDaily.all()) {
      rawDaily[String(dRow.day_key)] = Number(dRow.count) || 0
    }
    for (const [dk, cnt] of Object.entries(countedByDay)) {
      rawDaily[dk] = Math.max(rawDaily[dk] || 0, cnt)
    }
    dailyRegistrations = normalizeDailyRegistrations(rawDaily)
    lastDataVersion = Number(stmtDataVersion.get()?.data_version || 0)
    mergePendingTelemetryIntoMemory()
  }

  function syncExternalChangesIfNeeded() {
    if (closed) return
    try {
      const dv = Number(stmtDataVersion.get()?.data_version || 0)
      if (dv !== lastDataVersion) {
        loadAllFromDb()
      }
    } catch {}
  }

  /**
   * Execute an atomic SQLite write transaction.
   * Checks `PRAGMA data_version` inside `BEGIN IMMEDIATE` BEFORE running `fn()`,
   * syncing any external CLI commits (while preserving dirty telemetry deltas)
   * so `lastDataVersion` is never bumped past an unseen external write.
   */
  function runTx(fn) {
    if (closed) throw new Error('AccountStore is closed')
    db.exec('BEGIN IMMEDIATE')
    try {
      const dvBefore = Number(stmtDataVersion.get()?.data_version || 0)
      if (dvBefore !== lastDataVersion) {
        loadAllFromDb()
      }
      const res = fn()
      db.exec('COMMIT')
      lastPersistError = ''
      lastDataVersion = Number(stmtDataVersion.get()?.data_version || lastDataVersion)
      hardenDbFilePermissions(false)
      return res
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      lastPersistError = String(err?.message || err)
      throw err
    }
  }

  function migrateLegacyJsonIfPresent() {
    if (!/\.json$/i.test(String(filePath || '')) || !existsSync(filePath)) return
    const existingCount = Number(stmtUserCount.get()?.cnt || 0)
    if (existingCount > 0) return

    let parsed
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
      console.error(`[relay] CRITICAL: Failed to read/parse legacy accounts file (${filePath}):`, err?.message || err)
      throw err
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid legacy accounts file format: ${filePath}`)
    }

    runTx(() => {
      for (const u of Array.isArray(parsed?.users) ? parsed.users : []) {
        if (!u?.userId || !u?.username) continue
        const rawEmail = String(u.email || '').trim()
        const emailLower = rawEmail ? String(u.emailLower || rawEmail).trim().toLowerCase() : ''
        const tier = normalizeTier(u.tier || (u.role === 'admin' ? 'admin' : u.plan || 'free'))
        const role = tier === 'admin' ? 'admin' : 'user'
        const revoked = u.revokedSids && typeof u.revokedSids === 'object' ? u.revokedSids : {}
        const cleanSessions = (Array.isArray(u.sessions) ? u.sessions : []).filter((s) => s?.sid && !revoked[s.sid])
        persistUserRow({
          userId: String(u.userId),
          username: String(u.username),
          usernameLower: String(u.usernameLower || u.username).toLowerCase(),
          email: rawEmail,
          emailLower,
          emailVerified: Boolean(rawEmail && u.emailVerified),
          emailVerifiedAt: Number(u.emailVerifiedAt) || 0,
          loginEmail2fa: Boolean(rawEmail && u.emailVerified && u.loginEmail2fa),
          tier,
          role,
          passwordSalt: String(u.passwordSalt || ''),
          passwordHash: String(u.passwordHash || ''),
          tokenVersion: Number.isFinite(Number(u.tokenVersion)) ? Math.max(0, Math.floor(Number(u.tokenVersion))) : 0,
          createdAt: Number(u.createdAt) || Date.now(),
          lastLoginAt: Number(u.lastLoginAt) || Date.now(),
          knownLoginIps: Array.isArray(u.knownLoginIps) ? u.knownLoginIps.filter(Boolean).slice(0, 12) : [],
          turnUsage: normalizeTurnUsageRecord(u.turnUsage),
          devices: Array.isArray(u.devices) ? u.devices : [],
          sessions: cleanSessions,
        })
      }
      const normDaily = normalizeDailyRegistrations(parsed?.dailyRegistrations)
      for (const [dayKey, count] of Object.entries(normDaily)) {
        stmtUpsertDaily.run(dayKey, count)
      }
    })

    try {
      const backupPath = `${filePath}.migrated.${Date.now()}.bak`
      renameSync(filePath, backupPath)
      try { chmodSync(backupPath, 0o600) } catch {}
    } catch {}
  }

  function scheduleTelemetryFlush(userId, delayMs = 3000) {
    if (closed) return
    if (userId) dirtyTelemetryUsers.add(userId)
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush()
    }, delayMs)
    flushTimer.unref?.()
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (closed || dirtyTelemetryUsers.size === 0) return
    const ids = [...dirtyTelemetryUsers]
    try {
      runTx(() => {
        // `runTx` already checked `PRAGMA data_version` inside `BEGIN IMMEDIATE`
        // and merged pending deltas onto fresh DB rows if an external commit occurred.
        for (const uid of ids) {
          const rec = usersById.get(uid)
          if (!rec) continue
          if (pendingLastLogin.has(uid)) {
            stmtUpdateLastLogin.run(Number(rec.lastLoginAt) || 0, uid)
          }
          if (pendingTurnDelta.has(uid)) {
            stmtUpdateTurnUsage.run(JSON.stringify(rec.turnUsage || normalizeTurnUsageRecord(null)), uid)
          }
          if (pendingDeviceLastSeen.has(uid)) {
            stmtUpdateDevices.run(JSON.stringify(Array.isArray(rec.devices) ? rec.devices : []), uid)
          }
          if (pendingSessionTouches.has(uid)) {
            stmtUpdateSessions.run(JSON.stringify(Array.isArray(rec.sessions) ? rec.sessions : []), uid)
          }
        }
      })
      for (const uid of ids) {
        dirtyTelemetryUsers.delete(uid)
        pendingLastLogin.delete(uid)
        pendingTurnDelta.delete(uid)
        pendingDeviceLastSeen.delete(uid)
        pendingSessionTouches.delete(uid)
      }
    } catch (err) {
      console.error(`[accounts] Deferred telemetry flush failed: ${err?.message || err}`)
    }
  }

  function close() {
    if (closed) return
    flush()
    closed = true
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {}
    try {
      db.close()
    } catch {}
  }

  function isHealthy() {
    if (closed) return false
    try {
      const row = stmtHealthCheck.get()
      if (row && Number(row.ok) === 1) {
        if (lastPersistError) lastPersistError = ''
        return true
      }
      return false
    } catch (err) {
      lastPersistError = String(err?.message || err)
      return false
    }
  }

  migrateLegacyJsonIfPresent()
  loadAllFromDb()

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

  // O(1) lookup (maintained incrementally on every registration & DB load)
  function getTodayRegistrationCount(now = Date.now()) {
    syncExternalChangesIfNeeded()
    const todayKey = getLocalDayKey(now)
    return Math.max(0, Math.floor(Number(dailyRegistrations[todayKey]) || 0))
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

  function isUsernameTaken(username) {
    syncExternalChangesIfNeeded()
    const lower = String(username || '').trim().toLowerCase()
    return Boolean(lower && userIdByLower.has(lower))
  }

  function isEmailTaken(email, excludeUserId = '') {
    syncExternalChangesIfNeeded()
    const lower = String(email || '').trim().toLowerCase()
    if (!lower) return false
    const ownerId = userIdByEmailLower.get(lower)
    return Boolean(ownerId && ownerId !== excludeUserId)
  }

  function getUserByEmail(email) {
    syncExternalChangesIfNeeded()
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
    syncExternalChangesIfNeeded()
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

    const { salt, hash } = await hashPasswordAsync(pCheck.password)

    let txResult = null
    runTx(() => {
      if (isBootstrap && usersById.size > 0) {
        txResult = { ok: false, statusCode: 400, error: '管理员账号已初始化，请重新提交注册' }
        return
      }
      const finalIsBootstrap = isBootstrap && usersById.size === 0
      const now = Date.now()
      const todayKey = getLocalDayKey(now)
      const currentTodayCount = Math.max(0, Math.floor(Number(dailyRegistrations[todayKey]) || 0))
      if (!finalIsBootstrap && cleanLimit > 0 && currentTodayCount >= cleanLimit) {
        txResult = {
          ok: false,
          statusCode: 429,
          code: 'DAILY_REGISTRATION_LIMIT',
          error: `今日新用户注册名额已满（每日上限 ${cleanLimit} 人），请明天再试`,
        }
        return
      }
      if (userIdByLower.has(uCheck.usernameLower)) {
        txResult = { ok: false, statusCode: 400, error: '该用户名已被注册，请换一个用户名' }
        return
      }
      if (cleanEmailLower && userIdByEmailLower.has(cleanEmailLower)) {
        txResult = { ok: false, statusCode: 400, error: '该邮箱已被其他账号绑定' }
        return
      }

      const nextTodayCount = currentTodayCount + 1
      const cutoffKey = getLocalDayKey(now - (MAX_DAILY_REG_DAYS - 1) * 24 * 60 * 60 * 1000)
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
      }

      persistUserRow(record)
      stmtUpsertDaily.run(todayKey, nextTodayCount)
      stmtPruneDaily.run(cutoffKey)

      txResult = { ok: true, record, todayKey, nextTodayCount, now }
    })

    if (!txResult || !txResult.ok) {
      return txResult || { ok: false, statusCode: 400, error: '注册失败，请重试' }
    }

    const { record, todayKey, nextTodayCount, now } = txResult
    usersById.set(record.userId, record)
    userIdByLower.set(record.usernameLower, record.userId)
    if (record.emailLower) {
      userIdByEmailLower.set(record.emailLower, record.userId)
    }
    dailyRegistrations[todayKey] = nextTodayCount
    dailyRegistrations = normalizeDailyRegistrations(dailyRegistrations, now)

    return {
      ok: true,
      user: sanitizeUser(record),
      devices: [],
    }
  }

  function resolveAccountKey(identifier) {
    syncExternalChangesIfNeeded()
    const lower = String(identifier || '').trim().toLowerCase()
    if (!lower) return ''
    let userId = userIdByLower.get(lower)
    if (!userId && lower.includes('@')) {
      userId = userIdByEmailLower.get(lower)
    }
    return userId || ''
  }

  function markUserLogin(userId) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    if (!record) return null
    const now = Date.now()
    record.lastLoginAt = now
    pendingLastLogin.set(userId, Math.max(pendingLastLogin.get(userId) || 0, now))
    scheduleTelemetryFlush(userId)
    return sanitizeUser(record)
  }

  async function verifyUserPasswordAsync(userId, password) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    const pw = String(password ?? '')
    if (!record || !pw) return false
    const res = await verifyPasswordHashAsync(pw, record.passwordSalt, record.passwordHash)
    return res.ok
  }

  async function authenticateUserAsync(identifier, password, { recordLogin = true } = {}) {
    syncExternalChangesIfNeeded()
    const lower = String(identifier || '').trim().toLowerCase()
    if (!lower || !password) return null
    let userId = userIdByLower.get(lower)
    if (!userId && lower.includes('@')) {
      userId = userIdByEmailLower.get(lower)
    }
    const record = userId ? usersById.get(userId) : null
    if (!record) {
      await scryptAsync(String(password), DUMMY_SCRYPT_SALT, CURRENT_SCRYPT_OPTS)
      return null
    }
    const origSalt = record.passwordSalt
    const origHash = record.passwordHash
    const verifyRes = await verifyPasswordHashAsync(password, origSalt, origHash)
    if (!verifyRes.ok) return null
    syncExternalChangesIfNeeded()
    let current = usersById.get(userId)
    if (!current || current.passwordHash !== origHash || current.passwordSalt !== origSalt) return null

    // Transparently upgrade legacy N=16384 password hashes to N=32768 PHC format on login
    // using a targeted column UPDATE inside `runTx` so concurrent admin-cli edits are never clobbered.
    if (verifyRes.needsUpgrade) {
      try {
        const upgraded = await hashPasswordAsync(password)
        runTx(() => {
          const fresh = usersById.get(userId)
          if (!fresh || fresh.passwordHash !== origHash || fresh.passwordSalt !== origSalt) return
          stmtUpdatePasswordOnly.run(upgraded.salt, upgraded.hash, userId)
          fresh.passwordSalt = upgraded.salt
          fresh.passwordHash = upgraded.hash
        })
        current = usersById.get(userId)
        if (!current) return null
      } catch {}
    }

    if (recordLogin) {
      const now = Date.now()
      current.lastLoginAt = now
      pendingLastLogin.set(userId, Math.max(pendingLastLogin.get(userId) || 0, now))
      scheduleTelemetryFlush(userId)
    }
    return {
      user: sanitizeUser(current),
      devices: current.devices.map(sanitizeDeviceRecord),
    }
  }

  function setUserEmail(userId, email, { verified = true } = {}) {
    const eCheck = validateEmail(email)
    if (!eCheck.ok) return eCheck
    let result = null
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) {
        result = { ok: false, error: '用户不存在' }
        return
      }
      const existingOwner = userIdByEmailLower.get(eCheck.emailLower)
      if (existingOwner && existingOwner !== userId) {
        result = { ok: false, error: '该邮箱已被其他账号绑定' }
        return
      }
      const prevEmailLower = record.emailLower
      const verifiedBool = Boolean(verified)
      const verifiedAt = verifiedBool ? Date.now() : 0
      stmtUpdateEmail.run(eCheck.email, eCheck.emailLower, verifiedBool ? 1 : 0, verifiedAt, userId)
      if (prevEmailLower && prevEmailLower !== eCheck.emailLower && userIdByEmailLower.get(prevEmailLower) === userId) {
        userIdByEmailLower.delete(prevEmailLower)
      }
      record.email = eCheck.email
      record.emailLower = eCheck.emailLower
      record.emailVerified = verifiedBool
      record.emailVerifiedAt = verifiedAt
      userIdByEmailLower.set(record.emailLower, userId)
      result = { ok: true, user: sanitizeUser(record) }
    })
    return result
  }

  async function resetPasswordByEmailAsync(email, newPassword) {
    syncExternalChangesIfNeeded()
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

    let result = null
    runTx(() => {
      const fresh = usersById.get(userId)
      // Re-verify email ownership after async scrypt (prevents mid-reset email swap TOCTOU)
      if (!fresh || fresh.emailVerified !== true || fresh.emailLower !== eCheck.emailLower) {
        result = { ok: false, error: '账号状态已变更，请重试' }
        return
      }
      const nextTv = Number(fresh.tokenVersion || 0) + 1
      stmtUpdatePasswordAndRevoke.run(salt, hash, nextTv, '[]', userId)
      fresh.passwordSalt = salt
      fresh.passwordHash = hash
      fresh.tokenVersion = nextTv
      fresh.sessions = []
      pendingSessionTouches.delete(userId)
      pruneDirtyFlagIfClean(userId)
      result = { ok: true, user: sanitizeUser(fresh) }
    })
    return result
  }

  async function changePasswordAsync(userId, currentPassword, newPassword, { validateSession } = {}) {
    syncExternalChangesIfNeeded()
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
      const valid = (await verifyPasswordHashAsync(currentPassword, origSalt, origHash)).ok
      if (!valid) {
        return { ok: false, error: '当前密码不正确' }
      }
      const pCheck = validatePassword(newPassword)
      if (!pCheck.ok) return pCheck
      const { salt, hash } = await hashPasswordAsync(pCheck.password)

      let result = null
      runTx(() => {
        const fresh = usersById.get(userId)
        const sessionValid = typeof validateSession === 'function' ? Boolean(validateSession()) : true
        if (
          !fresh ||
          fresh.passwordHash !== origHash ||
          fresh.passwordSalt !== origSalt ||
          Number(fresh.tokenVersion || 0) !== origTv ||
          !sessionValid
        ) {
          result = { ok: false, error: '会话已失效或密码已被更新，请重新登录', code: 'stale_session' }
          return
        }
        const nextTv = origTv + 1
        stmtUpdatePasswordAndRevoke.run(salt, hash, nextTv, '[]', userId)
        fresh.passwordSalt = salt
        fresh.passwordHash = hash
        fresh.tokenVersion = nextTv
        fresh.sessions = []
        pendingSessionTouches.delete(userId)
        pruneDirtyFlagIfClean(userId)
        result = { ok: true, user: sanitizeUser(fresh) }
      })
      return result
    } finally {
      changingPasswordUsers.delete(userId)
    }
  }

  function bindDevice({ userId, label = '', hostname = '', platform = 'unknown', bridgeId = '' } = {}) {
    let result = null
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) return
      const devices = Array.isArray(record.devices) ? record.devices.map((d) => ({ ...d })) : []
      const now = Date.now()
      const cleanHost = String(hostname || label || 'My-PC').trim().slice(0, 64) || 'My-PC'
      const cleanLabel = String(label || hostname || 'My PC').trim().slice(0, 64) || cleanHost
      const cleanPlatform = String(platform || 'unknown').trim().slice(0, 32) || 'unknown'
      const explicitBridgeSlug = String(bridgeId || '').trim() ? sanitizeBridgeSlug(bridgeId) : ''
      const GENERIC_HOSTS = new Set(['', 'my-pc', 'my pc', 'localhost', 'unknown'])
      const hostKey = cleanHost.toLowerCase()
      const platKey = cleanPlatform.toLowerCase()

      const existingDevice =
        (explicitBridgeSlug ? devices.find((d) => d.bridgeId === explicitBridgeSlug) : null) ||
        (!explicitBridgeSlug && !GENERIC_HOSTS.has(hostKey)
          ? devices.find(
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
        stmtUpdateDevices.run(JSON.stringify(devices), userId)
        record.devices = devices
        pendingDeviceLastSeen.delete(userId)
        pruneDirtyFlagIfClean(userId)
        result = {
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
        return
      }

      if (devices.length >= MAX_DEVICES_PER_USER) {
        const err = new Error(`每个账号最多绑定 ${MAX_DEVICES_PER_USER} 台电脑，请先解绑旧设备后再试`)
        err.code = 'MAX_DEVICES_EXCEEDED'
        throw err
      }

      const deviceId = `dev_${randomBytes(6).toString('hex')}`
      const deviceSecret = `dv_${randomBytes(24).toString('hex')}`
      const baseSlug = sanitizeBridgeSlug(bridgeId || cleanHost || cleanLabel)

      const existingBridgeIds = new Set(devices.map((d) => d.bridgeId))
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
      devices.push(devRecord)
      stmtUpdateDevices.run(JSON.stringify(devices), userId)
      record.devices = devices
      pendingDeviceLastSeen.delete(userId)
      pruneDirtyFlagIfClean(userId)

      result = {
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
    })
    return result
  }

  function verifyDeviceBridge(userId, deviceSecret) {
    syncExternalChangesIfNeeded()
    if (!userId || !deviceSecret) return null
    const record = usersById.get(userId)
    if (!record || !Array.isArray(record.devices)) return null
    for (const dev of record.devices) {
      const candidate = sha256Hex(`${userId}:${dev.deviceId}:${deviceSecret}`)
      if (safeEqual(candidate, dev.secretHash)) {
        const now = Date.now()
        const shouldPersist = now - (dev.lastSeenAt || 0) > 60_000
        dev.lastSeenAt = now
        if (shouldPersist) {
          let devMap = pendingDeviceLastSeen.get(userId)
          if (!devMap) {
            devMap = new Map()
            pendingDeviceLastSeen.set(userId, devMap)
          }
          devMap.set(dev.deviceId, now)
          scheduleTelemetryFlush(userId)
        }
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
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    if (!record) return []
    return record.devices.map(sanitizeDeviceRecord)
  }

  function renameUserDevice(userId, deviceId, newLabel) {
    const clean = String(newLabel || '').trim().slice(0, 48)
    if (!clean) return null
    let result = null
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) return
      const devices = record.devices.map((d) => ({ ...d }))
      const target = devices.find((d) => d.deviceId === deviceId || d.bridgeId === deviceId)
      if (!target) return
      target.label = clean
      stmtUpdateDevices.run(JSON.stringify(devices), userId)
      record.devices = devices
      pendingDeviceLastSeen.delete(userId)
      pruneDirtyFlagIfClean(userId)
      result = sanitizeDeviceRecord(target)
    })
    return result
  }

  function removeUserDevice(userId, deviceId) {
    let result = null
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) return
      const devices = record.devices.slice()
      const idx = devices.findIndex((d) => d.deviceId === deviceId || d.bridgeId === deviceId)
      if (idx === -1) return
      const [removed] = devices.splice(idx, 1)
      stmtUpdateDevices.run(JSON.stringify(devices), userId)
      record.devices = devices
      pendingDeviceLastSeen.delete(userId)
      pruneDirtyFlagIfClean(userId)
      result = sanitizeDeviceRecord(removed)
    })
    return result
  }

  function getUserById(userId) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    return sanitizeUser(record)
  }

  function findUserByIdentifier(identifier) {
    syncExternalChangesIfNeeded()
    const clean = String(identifier || '').trim()
    if (!clean) return null
    if (usersById.has(clean)) return sanitizeUser(usersById.get(clean))
    const lower = clean.replace(/^@/, '').toLowerCase()
    const uid = userIdByLower.get(lower) || (lower.includes('@') ? userIdByEmailLower.get(lower) : '')
    return uid ? sanitizeUser(usersById.get(uid)) : null
  }

  function getUserTier(userId) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    return resolveUserTier(record)
  }

  function setUserTier(userId, targetTier, { actorUserId = '' } = {}) {
    const raw = String(targetTier || '').trim().toLowerCase()
    if (!VALID_TIERS.has(raw)) {
      return { ok: false, error: '无效的用户等级，仅支持 free / pro / ultra / admin' }
    }
    if (actorUserId && actorUserId === userId && raw !== 'admin') {
      return { ok: false, error: '不能取消当前管理员自身的管理员身份' }
    }
    let result = null
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) {
        result = { ok: false, error: '用户不存在' }
        return
      }
      if (record.role === 'admin' && raw !== 'admin') {
        let adminCount = 0
        for (const u of usersById.values()) {
          if (u.role === 'admin') adminCount += 1
        }
        if (adminCount <= 1) {
          result = { ok: false, error: '系统至少需要保留一名管理员' }
          return
        }
      }
      const prevTier = resolveUserTier(record)
      const nextRole = raw === 'admin' ? 'admin' : 'user'
      const nextTier = normalizeTier(raw)
      if (prevTier !== nextTier) {
        stmtUpdateTierRole.run(nextTier, nextRole, userId)
        record.tier = nextTier
        record.role = nextRole
      }
      result = { ok: true, prevTier, tier: nextTier, user: sanitizeUser(record) }
    })
    return result
  }

  function getTurnUsage(userId, now = new Date()) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    if (!record) return { month: getCurrentTurnMonth(now), bytes: 0, updatedAt: 0 }
    return normalizeTurnUsageRecord(record.turnUsage, now)
  }

  function addTurnUsage(userId, deltaBytes, now = new Date()) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    const add = Math.max(0, Math.floor(Number(deltaBytes) || 0))
    if (!record || add <= 0) return null
    const cur = normalizeTurnUsageRecord(record.turnUsage, now)
    const prevBytes = cur.bytes
    const ts = now instanceof Date ? now.getTime() : Number(now) || Date.now()
    const next = {
      month: cur.month,
      bytes: prevBytes + add,
      updatedAt: ts,
    }
    record.turnUsage = next
    const existingDelta = pendingTurnDelta.get(userId)
    if (existingDelta && existingDelta.month === cur.month) {
      existingDelta.bytes += add
      existingDelta.updatedAt = Math.max(existingDelta.updatedAt, ts)
    } else {
      pendingTurnDelta.set(userId, { month: cur.month, bytes: add, updatedAt: ts })
    }
    scheduleTelemetryFlush(userId, 2000)
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
    let result = null
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) {
        result = { ok: false, error: '用户不存在' }
        return
      }
      const curMonth = getCurrentTurnMonth(now)
      const nextUsage = {
        month: curMonth,
        bytes: 0,
        updatedAt: now instanceof Date ? now.getTime() : Number(now) || Date.now(),
      }
      stmtUpdateTurnUsage.run(JSON.stringify(nextUsage), userId)
      record.turnUsage = nextUsage
      pendingTurnDelta.delete(userId)
      pruneDirtyFlagIfClean(userId)
      result = { ok: true, user: sanitizeUser(record), turnUsage: { ...nextUsage } }
    })
    return result
  }

  function getTokenVersion(userId) {
    syncExternalChangesIfNeeded()
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
    if (b.startsWith(`${a} · `) || a.startsWith(`${b} · `)) return true
    return false
  }

  function pruneSessionsArray(rawSessions, now = Date.now()) {
    const sorted = (Array.isArray(rawSessions) ? rawSessions : [])
      .filter((s) => s?.sid && now - (Number(s.createdAt) || 0) <= SESSION_TTL_MS)
      .sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0))
    const seenUids = new Set()
    const active = []
    for (const s of sorted) {
      const uid = normalizeClientUid(s.clientUid)
      if (uid) {
        if (seenUids.has(uid)) continue
        seenUids.add(uid)
      }
      active.push(s)
    }
    return active.slice(0, MAX_USER_SESSIONS)
  }

  function evictDuplicateSessionsFromList(sessions, { keepSid, deviceName, clientKind, ip, clientUid, onlineSids }) {
    const onlineSet = onlineSids instanceof Set ? onlineSids : new Set(Array.isArray(onlineSids) ? onlineSids : [])
    const replacedSids = []
    const kept = []
    const cleanName = String(deviceName || '').trim()
    const cleanKind = clientKind === 'desktop' || clientKind === 'mobile' ? clientKind : 'web'
    const cleanIp = String(ip || '').trim()
    const cleanUid = normalizeClientUid(clientUid)
    const isAdminMonitor = cleanName.toLowerCase() === 'admin monitor'
    const isNamedDesktop = cleanKind === 'desktop' && cleanName.includes(' · ')

    for (const s of sessions) {
      if (!s?.sid) continue
      if (s.sid === keepSid) {
        kept.push(s)
        continue
      }
      const existingUid = normalizeClientUid(s.clientUid)
      const sameUid = Boolean(cleanUid && existingUid && existingUid === cleanUid)
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
        replacedSids.push(s.sid)
        continue
      }
      kept.push(s)
    }
    return { kept, replacedSids }
  }

  function hasUserSession(userId, sid) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    const cleanSid = String(sid || '').trim()
    if (!record || !cleanSid || !Array.isArray(record.sessions)) return false
    const entry = record.sessions.find((s) => s?.sid === cleanSid)
    if (!entry) return false
    if (Date.now() - (Number(entry.createdAt) || 0) > SESSION_TTL_MS) return false
    return true
  }

  function recordUserSession(
    userId,
    { sid, deviceName = '', clientKind = 'web', ip = '', clientUid = '', onlineSids = null } = {},
  ) {
    const cleanSid = String(sid || '').trim()
    if (!cleanSid) return null
    // Capture any unpersisted knownLoginIps written via checkAndRememberLoginContext({ skipSave: true })
    const preRecord = usersById.get(userId)
    const stagedLoginIps = preRecord && Array.isArray(preRecord.knownLoginIps) ? preRecord.knownLoginIps.slice(0, 12) : null

    let result = null
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) return
      const now = Date.now()
      const pruned = pruneSessionsArray(record.sessions, now).map((s) => ({ ...s }))
      const cleanName = String(deviceName || '').trim().slice(0, 64)
      const cleanKind = clientKind === 'desktop' || clientKind === 'mobile' ? clientKind : 'web'
      const cleanIp = String(ip || '').trim().slice(0, 64)
      const cleanUid = normalizeClientUid(clientUid)
      const { kept, replacedSids } = evictDuplicateSessionsFromList(pruned, {
        keepSid: cleanSid,
        deviceName: cleanName,
        clientKind: cleanKind,
        ip: cleanIp,
        clientUid: cleanUid,
        onlineSids,
      })
      let entry = kept.find((s) => s.sid === cleanSid)
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
        kept.unshift(entry)
      }
      const finalSessions = pruneSessionsArray(kept, now)
      const mergedIps = stagedLoginIps || (Array.isArray(record.knownLoginIps) ? record.knownLoginIps.slice(0, 12) : [])
      stmtUpdateSessionsAndLoginIps.run(JSON.stringify(finalSessions), JSON.stringify(mergedIps), userId)
      record.sessions = finalSessions
      record.knownLoginIps = mergedIps
      pendingSessionTouches.delete(userId)
      pruneDirtyFlagIfClean(userId)
      result = { ...entry, replacedSids }
    })
    return result
  }

  function touchUserSession(
    userId,
    sid,
    { deviceName = '', clientKind = '', ip = '', clientUid = '', onlineSids = null } = {},
  ) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    const cleanSid = String(sid || '').trim()
    if (!record || !cleanSid) return false
    const now = Date.now()
    if (!Array.isArray(record.sessions)) record.sessions = []
    const entry = record.sessions.find((s) => s.sid === cleanSid)
    if (!entry) return false

    const cleanName = String(deviceName || '').trim().slice(0, 64)
    const cleanKind = clientKind === 'desktop' || clientKind === 'mobile' || clientKind === 'web' ? clientKind : ''
    const cleanIp = String(ip || '').trim().slice(0, 64)
    const cleanUid = normalizeClientUid(clientUid)
    let changed = false
    const patch = {}
    if (cleanName && entry.deviceName !== cleanName) {
      entry.deviceName = cleanName
      patch.deviceName = cleanName
      changed = true
    }
    if (cleanKind && entry.clientKind !== cleanKind) {
      entry.clientKind = cleanKind
      patch.clientKind = cleanKind
      changed = true
    }
    if (cleanIp && entry.ip !== cleanIp) {
      entry.ip = cleanIp
      patch.ip = cleanIp
      changed = true
    }
    if (cleanUid && entry.clientUid !== cleanUid) {
      entry.clientUid = cleanUid
      patch.clientUid = cleanUid
      changed = true
    }
    let evicted = []
    if (cleanUid && onlineSids) {
      const { kept, replacedSids } = evictDuplicateSessionsFromList(record.sessions, {
        keepSid: cleanSid,
        deviceName: entry.deviceName,
        clientKind: entry.clientKind || 'web',
        ip: entry.ip,
        clientUid: cleanUid,
        onlineSids,
      })
      if (replacedSids.length > 0) {
        record.sessions = kept
        evicted = replacedSids
        changed = true
      }
    }
    const stale = now - (Number(entry.lastSeenAt) || 0) > 60_000
    entry.lastSeenAt = now
    patch.lastSeenAt = now
    if (changed || stale) {
      let pending = pendingSessionTouches.get(userId)
      if (!pending) {
        pending = { patches: new Map(), evictedSids: new Set() }
        pendingSessionTouches.set(userId, pending)
      }
      const prevPatch = pending.patches.get(cleanSid) || {}
      pending.patches.set(cleanSid, { ...prevPatch, ...patch })
      for (const rs of evicted) pending.evictedSids.add(rs)
      scheduleTelemetryFlush(userId)
    }
    return true
  }

  function listUserSessions(userId) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    if (!record) return []
    const now = Date.now()
    const active = pruneSessionsArray(record.sessions, now)
    record.sessions = active
    return active.map((s) => ({
      sid: s.sid,
      deviceName: s.deviceName || '',
      clientKind: s.clientKind || 'web',
      ip: s.ip || '',
      createdAt: Number(s.createdAt) || 0,
      lastSeenAt: Number(s.lastSeenAt) || Number(s.createdAt) || 0,
    }))
  }

  // Allowlist in `record.sessions` strictly enforces session revocation without persisting unbounded revokedSids
  function isSessionRevoked() {
    return false
  }

  function revokeUserSession(userId, sid) {
    const cleanSid = String(sid || '').trim()
    if (!cleanSid) return false
    let revoked = false
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) return
      const existed = Array.isArray(record.sessions) && record.sessions.some((s) => s?.sid === cleanSid)
      if (!existed) return
      const nextSessions = pruneSessionsArray(
        record.sessions.filter((s) => s.sid !== cleanSid),
        Date.now(),
      )
      stmtUpdateSessions.run(JSON.stringify(nextSessions), userId)
      record.sessions = nextSessions
      pendingSessionTouches.delete(userId)
      pruneDirtyFlagIfClean(userId)
      revoked = true
    })
    return revoked
  }

  function setLoginEmail2fa(userId, enabled) {
    const next = Boolean(enabled)
    let result = null
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) {
        result = { ok: false, error: '用户不存在' }
        return
      }
      if (next && (!record.email || !record.emailVerified)) {
        result = { ok: false, error: '请先绑定并验证邮箱，再开启登录二次验证' }
        return
      }
      stmtUpdateLogin2fa.run(next ? 1 : 0, userId)
      record.loginEmail2fa = next
      result = { ok: true, user: sanitizeUser(record) }
    })
    return result
  }

  function checkAndRememberLoginContext(userId, { deviceName = '', ip = '', clientUid = '', skipSave = false } = {}) {
    syncExternalChangesIfNeeded()
    const record = usersById.get(userId)
    if (!record) return { isNewContext: false }
    const cleanIp = String(ip || '').trim()
    const cleanName = String(deviceName || '').trim()
    const cleanUid = normalizeClientUid(clientUid)
    const existingIps = Array.isArray(record.knownLoginIps) ? record.knownLoginIps : []
    const hadHistory = existingIps.length > 0 || (Array.isArray(record.sessions) && record.sessions.length > 0)
    const knownByIp = Boolean(cleanIp && existingIps.includes(cleanIp))
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
      if (skipSave) {
        record.knownLoginIps = [cleanIp, ...existingIps.filter((x) => x !== cleanIp)].slice(0, 12)
      } else {
        runTx(() => {
          const fresh = usersById.get(userId)
          if (!fresh) return
          const freshIps = Array.isArray(fresh.knownLoginIps) ? fresh.knownLoginIps : []
          const nextIps = [cleanIp, ...freshIps.filter((x) => x !== cleanIp)].slice(0, 12)
          stmtUpdateKnownLoginIps.run(JSON.stringify(nextIps), userId)
          fresh.knownLoginIps = nextIps
        })
      }
    }
    return { isNewContext }
  }

  function revokeUserTokens(userId) {
    let result = null
    runTx(() => {
      const record = usersById.get(userId)
      if (!record) return
      const nextTv = Number(record.tokenVersion || 0) + 1
      stmtUpdateRevokeTokens.run(nextTv, '[]', userId)
      record.tokenVersion = nextTv
      record.sessions = []
      pendingSessionTouches.delete(userId)
      pruneDirtyFlagIfClean(userId)
      result = { roomId: record.userId, tokenVersion: nextTv }
    })
    return result
  }

  function listUsers() {
    syncExternalChangesIfNeeded()
    return [...usersById.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(sanitizeUser)
  }

  function listUsersForAdmin() {
    syncExternalChangesIfNeeded()
    const now = Date.now()
    return [...usersById.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((u) => {
        const activeSessions = (Array.isArray(u.sessions) ? u.sessions : [])
          .filter((s) => s?.sid && now - (Number(s.createdAt) || 0) <= SESSION_TTL_MS)
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

  function getScryptStats() {
    return {
      active: scryptActive,
      queued: scryptQueue.length,
      maxConcurrent: SCRYPT_MAX_CONCURRENT,
      maxQueue: SCRYPT_MAX_QUEUE,
    }
  }

  return {
    dbPath,
    isHealthy,
    getLastError: () => lastPersistError,
    getScryptStats,
    userCount: () => {
      syncExternalChangesIfNeeded()
      return usersById.size
    },
    getUserCount: () => {
      syncExternalChangesIfNeeded()
      return usersById.size
    },
    hasAnyUser: () => {
      syncExternalChangesIfNeeded()
      return usersById.size > 0
    },
    getTodayRegistrationCount,
    getDailyRegistrationStats,
    isUsernameTaken,
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
    close,
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
