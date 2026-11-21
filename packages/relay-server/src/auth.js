import { createHmac, timingSafeEqual } from 'node:crypto'

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8')
  const bufB = Buffer.from(String(b ?? ''), 'utf8')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Create a lightweight HMAC-SHA256 signed bearer token manager for multi-tenant mobile clients.
 */
export function createAuthManager({ clientAccessToken, bridgeSecret, jwtSecret }) {
  const signingKey = jwtSecret && jwtSecret.trim().length >= 16
    ? jwtSecret.trim()
    : createHmac('sha256', 'allinone-relay-key-v1')
        .update(`${clientAccessToken}::${bridgeSecret}`)
        .digest('hex')

  // Per-IP rate limit for login/pair attempts
  const failures = new Map()
  const MAX_FAILS = 15
  const WINDOW_MS = 10 * 60 * 1000

  // Per-IP rate limit for room registrations
  const registrations = new Map()
  const MAX_REG_PER_HOUR = 20
  const REG_WINDOW_MS = 60 * 60 * 1000

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
    const entry = registrations.get(ip)
    if (!entry || now - entry.firstAt > REG_WINDOW_MS) {
      registrations.set(ip, { count: 1, firstAt: now })
      return true
    }
    if (entry.count >= MAX_REG_PER_HOUR) return false
    entry.count += 1
    return true
  }

  function signSessionToken(subject = 'owner', deviceName = 'mobile', roomId = 'owner') {
    const room = String(roomId || 'owner').trim() || 'owner'
    const payload = {
      sub: subject,
      room,
      dev: String(deviceName || 'mobile').slice(0, 64),
      iat: Date.now(),
      exp: Date.now() + TOKEN_TTL_MS,
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const sig = createHmac('sha256', signingKey).update(body).digest('base64url')
    return `${body}.${sig}`
  }

  function verifySessionToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null
    const [body, sig] = token.split('.')
    if (!body || !sig) return null
    const expected = createHmac('sha256', signingKey).update(body).digest('base64url')
    if (!safeEqual(sig, expected)) return null
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
      if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null
      // Backward compatibility: legacy owner tokens without `room` belong strictly to `owner`
      if (!payload.room) payload.room = 'owner'
      return payload
    } catch {
      return null
    }
  }

  function verifyAccessPassword(password) {
    return safeEqual(password, clientAccessToken)
  }

  function verifyBridgeSecret(secret) {
    return safeEqual(secret, bridgeSecret)
  }

  return {
    checkRateLimit,
    recordFailure,
    clearFailure,
    checkRegisterLimit,
    signSessionToken,
    verifySessionToken,
    verifyAccessPassword,
    verifyBridgeSecret,
  }
}
