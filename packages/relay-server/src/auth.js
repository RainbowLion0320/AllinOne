import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MEDIA_TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes (read-only image/upload scope)
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
 * Create a lightweight HMAC-SHA256 signed bearer token manager for multi-tenant mobile clients.
 * Supports:
 *  - Room-scoped 30-day session tokens with revocable `tokenVersion` (`tv`)
 *  - 30-second single-use WebSocket handshake tickets (`ws-ticket`)
 *  - 15-minute read-only scoped media tokens (`media`) so long-lived JWTs never appear in URLs
 *  - Optional registration invite code (`registerInviteCode`)
 */
export function createAuthManager({
  clientAccessToken,
  bridgeSecret,
  jwtSecret,
  registerInviteCode = '',
  getTokenVersion = null,
  isSessionRevoked = null,
}) {
  const signingKey = jwtSecret && jwtSecret.trim().length >= 16
    ? jwtSecret.trim()
    : createHmac('sha256', 'allinone-relay-key-v1')
        .update(`${clientAccessToken}::${bridgeSecret}`)
        .digest('hex')

  const inviteSecret = String(registerInviteCode || '').trim()

  // Per-IP rate limit for login/pair attempts
  const failures = new Map()
  const MAX_FAILS = 15
  const WINDOW_MS = 10 * 60 * 1000

  // Per-IP rate limit for room registrations
  const registrations = new Map()
  const MAX_REG_PER_HOUR = 20
  const REG_WINDOW_MS = 60 * 60 * 1000

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

  function checkRegisterLimit(ip) {
    const now = Date.now()
    pruneMap(registrations, REG_WINDOW_MS, now)
    const entry = registrations.get(ip)
    if (!entry || now - entry.firstAt > REG_WINDOW_MS) {
      registrations.set(ip, { count: 1, firstAt: now })
      return true
    }
    if (entry.count >= MAX_REG_PER_HOUR) return false
    entry.count += 1
    return true
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
      if (!payload.room) payload.room = 'owner'
      return payload
    } catch {
      return null
    }
  }

  function isTokenVersionCurrent(payload) {
    if (typeof getTokenVersion !== 'function') return true
    const currentTv = Number(getTokenVersion(payload.room))
    if (!Number.isFinite(currentTv) || currentTv < 0) return false
    // Backward compatibility: legacy tokens issued prior to v0.1.21 lack `tv` -> treat as 0
    const tokenTv = Number.isFinite(Number(payload.tv)) ? Number(payload.tv) : 0
    return tokenTv === currentTv
  }

  function isSessionActive(payload) {
    if (!isTokenVersionCurrent(payload)) return false
    if (payload?.sid && typeof isSessionRevoked === 'function') {
      if (isSessionRevoked(payload.room, payload.sid)) return false
    }
    return true
  }

  function generateSessionId() {
    return `s_${randomBytes(8).toString('hex')}`
  }

  function signSessionToken(
    subject = 'owner',
    deviceName = 'mobile',
    roomId = 'owner',
    tokenVersion = 0,
    { role = '', username = '', sid = '' } = {},
  ) {
    const room = String(roomId || 'owner').trim() || 'owner'
    const tv = Number.isFinite(Number(tokenVersion)) ? Math.max(0, Math.floor(Number(tokenVersion))) : 0
    const now = Date.now()
    const effectiveRole = role || (room === 'owner' ? 'admin' : 'user')
    const sessionId = String(sid || '').trim() || generateSessionId()
    return signRawPayload({
      sub: subject,
      room,
      dev: String(deviceName || 'mobile').slice(0, 64),
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
    if (!payload) return false
    return payload.role === 'admin' || payload.room === 'owner'
  }

  function verifySessionToken(token) {
    const payload = verifyRawToken(token)
    if (!payload) return null
    // Reject media-only tokens or unknown scopes; allow legacy tokens without `scope`
    if (payload.scope && payload.scope !== 'session') return null
    if (!isSessionActive(payload)) return null
    return payload
  }

  function signMediaToken(sessionPayload) {
    const room = String(sessionPayload?.room || 'owner').trim() || 'owner'
    const tv = Number.isFinite(Number(sessionPayload?.tv)) ? Number(sessionPayload.tv) : 0
    const sid = String(sessionPayload?.sid || '').trim()
    const now = Date.now()
    const exp = now + MEDIA_TOKEN_TTL_MS
    const mediaToken = signRawPayload({
      sub: sessionPayload?.sub || room,
      room,
      ...(sid ? { sid } : {}),
      tv,
      scope: 'media',
      iat: now,
      exp,
    })
    return { mediaToken, expiresAt: exp }
  }

  function verifyMediaToken(token) {
    const payload = verifyRawToken(token)
    if (!payload) return null
    // Accept read-only `media` tokens AND session tokens (for backward compatibility)
    if (payload.scope && payload.scope !== 'media' && payload.scope !== 'session') return null
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
        room: sessionPayload.room || 'owner',
        dev: cleanDev || sessionPayload.dev || 'mobile',
        ...(cleanKind ? { kind: cleanKind } : {}),
        ...(sessionPayload.sid ? { sid: String(sessionPayload.sid) } : {}),
        tv: Number.isFinite(Number(sessionPayload.tv)) ? Number(sessionPayload.tv) : 0,
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
    // Strictly single-use: delete immediately on lookup
    wsTickets.delete(clean)
    if (Date.now() > entry.exp) return null
    if (!isSessionActive(entry.user)) return null
    return entry.user
  }

  function verifyAccessPassword(password) {
    return safeEqual(password, clientAccessToken)
  }

  function verifyBridgeSecret(secret) {
    return safeEqual(secret, bridgeSecret)
  }

  function hasRegisterInviteCode() {
    return inviteSecret.length > 0
  }

  function verifyRegisterInviteCode(code) {
    if (!inviteSecret) return true
    return safeEqual(code, inviteSecret)
  }

  return {
    checkRateLimit,
    recordFailure,
    clearFailure,
    checkRegisterLimit,
    generateSessionId,
    signSessionToken,
    verifySessionToken,
    isAdminPayload,
    signMediaToken,
    verifyMediaToken,
    issueWsTicket,
    consumeWsTicket,
    verifyAccessPassword,
    verifyBridgeSecret,
    hasRegisterInviteCode,
    verifyRegisterInviteCode,
  }
}
