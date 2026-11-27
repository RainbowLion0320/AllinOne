import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const WS_TICKET_TTL_MS = 30 * 1000 // 30 seconds (strictly single-use)
const MAX_WS_TICKETS = 2000
const MAX_WS_TICKETS_PER_ROOM = 20
const MAX_RATE_LIMIT_ENTRIES = 5000

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8')
  const bufB = Buffer.from(String(b ?? ''), 'utf8')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Account-based HMAC-SHA256 bearer token manager for multi-tenant All in One clients.
 * Strictly requires `usr_*` account rooms, explicit `session` scope,
 * revocable `tokenVersion` (`tv`), per-device `sid`, and single-use `ws-ticket` handshakes.
 */
export function createAuthManager({
  jwtSecret = '',
  jwtSecretPrevious = '',
  adminBootstrapToken = '',
  getTokenVersion = null,
  isSessionRevoked = null,
  hasUserSession = null,
} = {}) {
  const cleanJwtSecret = String(jwtSecret || '').trim()
  const signingKey = cleanJwtSecret.length >= 16
    ? cleanJwtSecret
    : randomBytes(32).toString('hex')
  const cleanPrevSecret = String(jwtSecretPrevious || '').trim()
  const previousSigningKey =
    cleanPrevSecret.length >= 16 && cleanPrevSecret !== signingKey ? cleanPrevSecret : ''

  const bootstrapSecret = String(adminBootstrapToken || '').trim()

  // Per-IP rate limit for login/register attempts
  const failures = new Map()
  const MAX_FAILS = 15
  const WINDOW_MS = 10 * 60 * 1000

  // Per-(account, ip) rate limit for login/device-login/sensitive password checks
  // (never inserts nonexistent usernames; isolated per IP so remote attackers cannot lock out a victim)
  const accountFailures = new Map()
  const MAX_ACCT_FAILS = 10
  const ACCT_WINDOW_MS = 15 * 60 * 1000

  // Per-(ip, normalizedEmail) rate limit dedicated to password reset OTP verification.
  // Keyed by (ip, email) so remote attackers cannot lock out victims from another IP,
  // and tracked uniformly regardless of whether the email exists (zero enumeration oracle).
  const resetFailures = new Map()
  const MAX_RESET_FAILS = 10
  const RESET_WINDOW_MS = 15 * 60 * 1000

  // Per-(IP, roomId) + Per-IP-only rate limits for /ws/bridge & device-status auth failures.
  // Nonexistent/invalid rooms collapse into one sentinel bucket per IP (`__invalid__`) so
  // spraying random roomIds cannot pollute the Map or lock out valid rooms behind the same NAT IP.
  const bridgeFailures = new Map()
  const bridgeIpFailures = new Map()
  const INVALID_BRIDGE_ROOM_BUCKET = '__invalid__'
  const MAX_BRIDGE_FAILS = 15
  const MAX_BRIDGE_IP_FAILS = 60
  const BRIDGE_WINDOW_MS = 10 * 60 * 1000

  // Short-lived single-use WS handshake tickets: ticket -> { user, exp }
  const wsTickets = new Map()

  function pruneMap(map, ttlMs, now, maxCountThreshold = Infinity) {
    if (map.size < MAX_RATE_LIMIT_ENTRIES) return
    for (const [k, v] of map.entries()) {
      if (now - v.firstAt > ttlMs) map.delete(k)
    }
    if (map.size < MAX_RATE_LIMIT_ENTRIES) return
    // Never let an attacker flush active lockouts via FIFO: evict lowest-count non-locked entries first
    let victimKey = null
    let victimCount = Infinity
    for (const [k, v] of map.entries()) {
      if (v.count < maxCountThreshold && v.count < victimCount) {
        victimKey = k
        victimCount = v.count
        if (victimCount <= 1) break
      }
    }
    if (victimKey !== null) {
      map.delete(victimKey)
      return
    }
    // All entries are actively locked out: evict the oldest lockout only as a hard memory cap
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }

  function pruneExpiredWsTickets(now) {
    for (const [k, v] of wsTickets.entries()) {
      if (now > v.exp) wsTickets.delete(k)
    }
  }

  function checkRateLimit(ip) {
    const now = Date.now()
    const entry = failures.get(ip)
    if (!entry) return true
    if (now - entry.firstAt > WINDOW_MS) {
      failures.delete(ip)
      return true
    }
    return entry.count < MAX_FAILS
  }

  function recordFailure(ip) {
    const now = Date.now()
    pruneMap(failures, WINDOW_MS, now, MAX_FAILS)
    const entry = failures.get(ip)
    if (!entry || now - entry.firstAt > WINDOW_MS) {
      failures.set(ip, { count: 1, firstAt: now })
    } else {
      entry.count += 1
    }
  }

  // Per-IP global failure counters expire naturally after WINDOW_MS and are NEVER
  // cleared by a single successful login (prevents self-reset brute-force bypass).
  function clearFailure(ip, identifier = '') {
    if (identifier) {
      clearAccountFailure(identifier, ip)
    }
  }

  function normalizeExistingAccountId(identifier) {
    const key = String(identifier || '').trim().toLowerCase().slice(0, 128)
    // Strictly track only real `usr_*` accounts so nonexistent usernames can never pollute or evict map entries
    return key.startsWith('usr_') ? key : ''
  }

  function normalizeAccountKey(identifier, ip = '') {
    const acct = normalizeExistingAccountId(identifier)
    if (!acct) return ''
    const cleanIp = String(ip || '').trim().slice(0, 64)
    return cleanIp ? `${acct}::${cleanIp}` : acct
  }

  function checkAccountRateLimit(identifier, ip = '') {
    const key = normalizeAccountKey(identifier, ip)
    if (!key) return true
    const now = Date.now()
    const entry = accountFailures.get(key)
    if (!entry) return true
    if (now - entry.firstAt > ACCT_WINDOW_MS) {
      accountFailures.delete(key)
      return true
    }
    return entry.count < MAX_ACCT_FAILS
  }

  function recordAccountFailure(identifier, ip = '') {
    const key = normalizeAccountKey(identifier, ip)
    if (!key) return
    const now = Date.now()
    pruneMap(accountFailures, ACCT_WINDOW_MS, now, MAX_ACCT_FAILS)
    const entry = accountFailures.get(key)
    if (!entry || now - entry.firstAt > ACCT_WINDOW_MS) {
      accountFailures.set(key, { count: 1, firstAt: now })
    } else {
      entry.count += 1
    }
  }

  function clearAccountFailure(identifier, ip = '') {
    const key = normalizeAccountKey(identifier, ip)
    if (key) accountFailures.delete(key)
  }

  function normalizeResetKey(ip, email) {
    const cleanIp = String(ip || 'unknown').trim().slice(0, 64) || 'unknown'
    const cleanEmail = String(email || '').trim().toLowerCase().slice(0, 254)
    if (!cleanEmail) return ''
    return `${cleanIp}::${cleanEmail}`
  }

  function checkResetRateLimit(ip, email) {
    const key = normalizeResetKey(ip, email)
    if (!key) return true
    const now = Date.now()
    const entry = resetFailures.get(key)
    if (!entry) return true
    if (now - entry.firstAt > RESET_WINDOW_MS) {
      resetFailures.delete(key)
      return true
    }
    return entry.count < MAX_RESET_FAILS
  }

  function recordResetFailure(ip, email) {
    const key = normalizeResetKey(ip, email)
    if (!key) return
    const now = Date.now()
    pruneMap(resetFailures, RESET_WINDOW_MS, now, MAX_RESET_FAILS)
    const entry = resetFailures.get(key)
    if (!entry || now - entry.firstAt > RESET_WINDOW_MS) {
      resetFailures.set(key, { count: 1, firstAt: now })
    } else {
      entry.count += 1
    }
  }

  function clearResetFailure(ip, email) {
    const key = normalizeResetKey(ip, email)
    if (key) resetFailures.delete(key)
  }

  function normalizeBridgeIp(ip) {
    return String(ip || 'unknown').trim().slice(0, 64) || 'unknown'
  }

  function normalizeBridgeKey(ip, roomId) {
    const cleanIp = normalizeBridgeIp(ip)
    const cleanRoom = String(roomId || '').trim().slice(0, 64)
    return `${cleanIp}::${cleanRoom}`
  }

  function checkBridgeRateLimit(ip, roomId = '', { roomExists = true } = {}) {
    const now = Date.now()
    const ipKey = normalizeBridgeIp(ip)
    const ipEntry = bridgeIpFailures.get(ipKey)
    if (ipEntry) {
      if (now - ipEntry.firstAt > BRIDGE_WINDOW_MS) {
        bridgeIpFailures.delete(ipKey)
      } else if (ipEntry.count >= MAX_BRIDGE_IP_FAILS) {
        return false
      }
    }
    const cleanRoom = String(roomId || '').trim()
    const bucketRoom = roomExists && cleanRoom ? cleanRoom : INVALID_BRIDGE_ROOM_BUCKET
    const key = normalizeBridgeKey(ip, bucketRoom)
    const entry = bridgeFailures.get(key)
    if (!entry) return true
    if (now - entry.firstAt > BRIDGE_WINDOW_MS) {
      bridgeFailures.delete(key)
      return true
    }
    return entry.count < MAX_BRIDGE_FAILS
  }

  function recordBridgeFailure(ip, roomId = '', { recordRoom = true } = {}) {
    const now = Date.now()
    const ipKey = normalizeBridgeIp(ip)
    pruneMap(bridgeIpFailures, BRIDGE_WINDOW_MS, now, MAX_BRIDGE_IP_FAILS)
    const ipEntry = bridgeIpFailures.get(ipKey)
    if (!ipEntry || now - ipEntry.firstAt > BRIDGE_WINDOW_MS) {
      bridgeIpFailures.set(ipKey, { count: 1, firstAt: now })
    } else {
      ipEntry.count += 1
    }
    const cleanRoom = String(roomId || '').trim()
    const bucketRoom = recordRoom && cleanRoom ? cleanRoom : INVALID_BRIDGE_ROOM_BUCKET
    const key = normalizeBridgeKey(ip, bucketRoom)
    pruneMap(bridgeFailures, BRIDGE_WINDOW_MS, now, MAX_BRIDGE_FAILS)
    const entry = bridgeFailures.get(key)
    if (!entry || now - entry.firstAt > BRIDGE_WINDOW_MS) {
      bridgeFailures.set(key, { count: 1, firstAt: now })
    } else {
      entry.count += 1
    }
  }

  // Only clears the per-(ip, roomId) bucket; NEVER resets the IP-wide bridge failure counter.
  function clearBridgeFailure(ip, roomId = '') {
    const cleanRoom = String(roomId || '').trim()
    if (cleanRoom) {
      bridgeFailures.delete(normalizeBridgeKey(ip, cleanRoom))
    }
  }

  function signRawPayload(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const sig = createHmac('sha256', signingKey).update(body).digest('base64url')
    return `${body}.${sig}`
  }

  function verifyRawToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [body, sig] = parts
    if (!body || !sig) return null
    const expectedCurrent = createHmac('sha256', signingKey).update(body).digest('base64url')
    let matched = safeEqual(sig, expectedCurrent)
    if (!matched && previousSigningKey) {
      const expectedPrev = createHmac('sha256', previousSigningKey).update(body).digest('base64url')
      matched = safeEqual(sig, expectedPrev)
    }
    if (!matched) return null
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
      if (!payload || typeof payload !== 'object') return null
      if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null
      if (typeof payload.room !== 'string' || !payload.room.startsWith('usr_')) return null
      if (typeof payload.sid !== 'string' || !payload.sid.trim()) return null
      if (typeof payload.tv !== 'number' || !Number.isFinite(payload.tv)) return null
      return payload
    } catch {
      return null
    }
  }

  function isTokenVersionCurrent(payload) {
    if (typeof getTokenVersion !== 'function') return true
    const currentTv = Number(getTokenVersion(payload.room))
    if (!Number.isFinite(currentTv) || currentTv < 0) return false
    return payload.tv === currentTv
  }

  function isSessionActive(payload) {
    if (!isTokenVersionCurrent(payload)) return false
    if (typeof isSessionRevoked === 'function' && isSessionRevoked(payload.room, payload.sid)) {
      return false
    }
    if (payload.sid && typeof hasUserSession === 'function' && !hasUserSession(payload.room, payload.sid)) {
      return false
    }
    return true
  }

  function generateSessionId() {
    return `s_${randomBytes(8).toString('hex')}`
  }

  function signSessionToken(
    subject,
    deviceName = 'Web Client',
    roomId,
    tokenVersion = 0,
    { role = 'user', username = '', sid = '' } = {},
  ) {
    const room = String(roomId || '').trim()
    if (!room.startsWith('usr_')) {
      throw new Error(`Invalid account roomId: ${room}`)
    }
    const tv = Number.isFinite(Number(tokenVersion)) ? Math.max(0, Math.floor(Number(tokenVersion))) : 0
    const now = Date.now()
    const effectiveRole = role === 'admin' ? 'admin' : 'user'
    const sessionId = String(sid || '').trim() || generateSessionId()
    return signRawPayload({
      sub: String(subject || room),
      room,
      dev: String(deviceName || 'Web Client').slice(0, 64),
      sid: sessionId,
      tv,
      role: effectiveRole,
      ...(username ? { uname: String(username).slice(0, 32) } : {}),
      scope: 'session',
      iat: now,
      exp: now + TOKEN_TTL_MS,
    })
  }

  function verifySessionToken(token) {
    const payload = verifyRawToken(token)
    if (!payload || payload.scope !== 'session') return null
    if (!isSessionActive(payload)) return null
    return payload
  }

  function issueWsTicket(sessionPayload, { deviceName = '', clientKind = '' } = {}) {
    const now = Date.now()
    pruneExpiredWsTickets(now)
    const room = String(sessionPayload?.room || '').trim()
    if (room) {
      const roomKeys = []
      for (const [k, v] of wsTickets.entries()) {
        if (v.user?.room === room) roomKeys.push(k)
      }
      while (roomKeys.length >= MAX_WS_TICKETS_PER_ROOM) {
        const oldestRoomTicket = roomKeys.shift()
        if (oldestRoomTicket) wsTickets.delete(oldestRoomTicket)
      }
    }
    while (wsTickets.size >= MAX_WS_TICKETS) {
      // Fair multi-tenant eviction: evict the oldest ticket from the room holding the most tickets
      const roomCounts = new Map()
      const roomOldest = new Map()
      for (const [k, v] of wsTickets.entries()) {
        const r = String(v.user?.room || '')
        roomCounts.set(r, (roomCounts.get(r) || 0) + 1)
        if (!roomOldest.has(r)) roomOldest.set(r, k)
      }
      let heaviestRoom = ''
      let maxCount = 0
      for (const [r, c] of roomCounts.entries()) {
        if (c > maxCount) {
          maxCount = c
          heaviestRoom = r
        }
      }
      const victim = roomOldest.get(heaviestRoom) || wsTickets.keys().next().value
      if (!victim) break
      wsTickets.delete(victim)
    }
    const ticket = `tk_${randomBytes(24).toString('hex')}`
    const exp = now + WS_TICKET_TTL_MS
    const cleanDev = String(deviceName || '').trim().slice(0, 64)
    const cleanKind = String(clientKind || '').trim().slice(0, 16)
    wsTickets.set(ticket, {
      user: {
        sub: sessionPayload.sub,
        room: sessionPayload.room,
        dev: cleanDev || sessionPayload.dev || 'Web Client',
        ...(cleanKind ? { kind: cleanKind } : {}),
        sid: String(sessionPayload.sid),
        tv: Number(sessionPayload.tv),
      },
      exp,
    })
    return { ticket, expiresAt: exp }
  }

  function consumeWsTicket(ticket) {
    const clean = String(ticket || '').trim()
    if (!clean) return null
    const entry = wsTickets.get(clean)
    if (!entry) return null
    wsTickets.delete(clean)
    if (Date.now() > entry.exp) return null
    if (!isSessionActive(entry.user)) return null
    return entry.user
  }

  function verifyAdminBootstrapToken(token) {
    if (!bootstrapSecret) return false
    return safeEqual(token, bootstrapSecret)
  }

  return {
    checkRateLimit,
    recordFailure,
    clearFailure,
    checkAccountRateLimit,
    recordAccountFailure,
    clearAccountFailure,
    checkResetRateLimit,
    recordResetFailure,
    clearResetFailure,
    checkBridgeRateLimit,
    recordBridgeFailure,
    clearBridgeFailure,
    generateSessionId,
    signSessionToken,
    verifySessionToken,
    issueWsTicket,
    consumeWsTicket,
    verifyAdminBootstrapToken,
  }
}
