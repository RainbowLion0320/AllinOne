import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MEDIA_TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes (read-only encrypted upload download scope)
const WS_TICKET_TTL_MS = 30 * 1000 // 30 seconds (strictly single-use)
const MAX_WS_TICKETS = 2000
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
 * Strictly requires `usr_*` account rooms, explicit scopes (`session` / `media`),
 * revocable `tokenVersion` (`tv`), per-device `sid`, and single-use `ws-ticket` handshakes.
 */
export function createAuthManager({
  jwtSecret = '',
  adminBootstrapToken = '',
  getTokenVersion = null,
  isSessionRevoked = null,
} = {}) {
  const cleanJwtSecret = String(jwtSecret || '').trim()
  const signingKey = cleanJwtSecret.length >= 16
    ? cleanJwtSecret
    : randomBytes(32).toString('hex')

  const bootstrapSecret = String(adminBootstrapToken || '').trim()

  // Per-IP rate limit for login/register attempts
  const failures = new Map()
  const MAX_FAILS = 15
  const WINDOW_MS = 10 * 60 * 1000

  // Per-account rate limit to block distributed multi-IP credential stuffing
  const accountFailures = new Map()
  const MAX_ACCT_FAILS = 10
  const ACCT_WINDOW_MS = 15 * 60 * 1000

  // Per-(IP, roomId) rate limit for /ws/bridge auth failures
  const bridgeFailures = new Map()
  const MAX_BRIDGE_FAILS = 15
  const BRIDGE_WINDOW_MS = 10 * 60 * 1000

  // Short-lived single-use WS handshake tickets: ticket -> { user, exp }
  const wsTickets = new Map()

  function pruneMap(map, ttlMs, now) {
    if (map.size < MAX_RATE_LIMIT_ENTRIES) return
    for (const [k, v] of map.entries()) {
      if (now - v.firstAt > ttlMs) map.delete(k)
    }
    while (map.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldest = map.keys().next().value
      if (!oldest) break
      map.delete(oldest)
    }
  }

  function pruneWsTickets(now) {
    for (const [k, v] of wsTickets.entries()) {
      if (now > v.exp) wsTickets.delete(k)
    }
    while (wsTickets.size >= MAX_WS_TICKETS) {
      const oldest = wsTickets.keys().next().value
      if (!oldest) break
      wsTickets.delete(oldest)
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
    pruneMap(failures, WINDOW_MS, now)
    const entry = failures.get(ip)
    if (!entry || now - entry.firstAt > WINDOW_MS) {
      failures.set(ip, { count: 1, firstAt: now })
    } else {
      entry.count += 1
    }
  }

  function clearFailure(ip) {
    failures.delete(ip)
  }

  function normalizeAccountKey(identifier) {
    return String(identifier || '').trim().toLowerCase().slice(0, 128)
  }

  function checkAccountRateLimit(identifier) {
    const key = normalizeAccountKey(identifier)
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

  function recordAccountFailure(identifier) {
    const key = normalizeAccountKey(identifier)
    if (!key) return
    const now = Date.now()
    pruneMap(accountFailures, ACCT_WINDOW_MS, now)
    const entry = accountFailures.get(key)
    if (!entry || now - entry.firstAt > ACCT_WINDOW_MS) {
      accountFailures.set(key, { count: 1, firstAt: now })
    } else {
      entry.count += 1
    }
  }

  function clearAccountFailure(identifier) {
    const key = normalizeAccountKey(identifier)
    if (key) accountFailures.delete(key)
  }

  function normalizeBridgeKey(ip, roomId) {
    const cleanIp = String(ip || 'unknown').trim().slice(0, 64) || 'unknown'
    const cleanRoom = String(roomId || '').trim().slice(0, 64)
    return `${cleanIp}::${cleanRoom}`
  }

  function checkBridgeRateLimit(ip, roomId) {
    const key = normalizeBridgeKey(ip, roomId)
    const now = Date.now()
    const entry = bridgeFailures.get(key)
    if (!entry) return true
    if (now - entry.firstAt > BRIDGE_WINDOW_MS) {
      bridgeFailures.delete(key)
      return true
    }
    return entry.count < MAX_BRIDGE_FAILS
  }

  function recordBridgeFailure(ip, roomId) {
    const key = normalizeBridgeKey(ip, roomId)
    const now = Date.now()
    pruneMap(bridgeFailures, BRIDGE_WINDOW_MS, now)
    const entry = bridgeFailures.get(key)
    if (!entry || now - entry.firstAt > BRIDGE_WINDOW_MS) {
      bridgeFailures.set(key, { count: 1, firstAt: now })
    } else {
      entry.count += 1
    }
  }

  function clearBridgeFailure(ip, roomId) {
    bridgeFailures.delete(normalizeBridgeKey(ip, roomId))
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
    const expected = createHmac('sha256', signingKey).update(body).digest('base64url')
    if (!safeEqual(sig, expected)) return null
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

  function isAdminPayload(payload) {
    return Boolean(payload && payload.role === 'admin' && String(payload.room || '').startsWith('usr_'))
  }

  function verifySessionToken(token) {
    const payload = verifyRawToken(token)
    if (!payload || payload.scope !== 'session') return null
    if (!isSessionActive(payload)) return null
    return payload
  }

  function signMediaToken(sessionPayload) {
    const room = String(sessionPayload?.room || '').trim()
    const sid = String(sessionPayload?.sid || '').trim()
    if (!room.startsWith('usr_') || !sid) {
      throw new Error('Invalid session payload for media token')
    }
    const tv = Number.isFinite(Number(sessionPayload?.tv)) ? Number(sessionPayload.tv) : 0
    const now = Date.now()
    const exp = now + MEDIA_TOKEN_TTL_MS
    const mediaToken = signRawPayload({
      sub: sessionPayload.sub || room,
      room,
      sid,
      tv,
      scope: 'media',
      iat: now,
      exp,
    })
    return { mediaToken, expiresAt: exp }
  }

  function verifyMediaToken(token) {
    const payload = verifyRawToken(token)
    if (!payload || payload.scope !== 'media') return null
    if (!isSessionActive(payload)) return null
    return payload
  }

  function issueWsTicket(sessionPayload, { deviceName = '', clientKind = '' } = {}) {
    const now = Date.now()
    pruneWsTickets(now)
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
    checkBridgeRateLimit,
    recordBridgeFailure,
    clearBridgeFailure,
    generateSessionId,
    signSessionToken,
    verifySessionToken,
    isAdminPayload,
    signMediaToken,
    verifyMediaToken,
    issueWsTicket,
    consumeWsTicket,
    verifyAdminBootstrapToken,
  }
}
