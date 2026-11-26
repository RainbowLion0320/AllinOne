import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'

const SAFE_SCRIPT_URL_RE = /^https?:\/\/[A-Za-z0-9._:\-\[\]\/]+$/
const SAFE_PREFIX_RE = /^\/[A-Za-z0-9._\-\/]*$/

export const CAPACITOR_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
  'http://localhost',
  'app://allinone',
])

export const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

export class HttpError extends Error {
  constructor(statusCode, message, code = '') {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
  }
}

/** Load simple `.env` file if present (zero external dependencies). */
export function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return
  const raw = readFileSync(filePath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

/**
 * Lightweight structured logger. Set `LOG_FORMAT=json` for NDJSON logs suitable for
 * Loki/CloudWatch/Datadog; defaults to clean readable lines.
 */
export function createLogger(component = 'control', { json = String(process.env.LOG_FORMAT || '').toLowerCase() === 'json' } = {}) {
  const emit = (level, msg, fields = null) => {
    if (json) {
      const record = {
        ts: new Date().toISOString(),
        level,
        component,
        msg: String(msg),
        ...(fields && typeof fields === 'object' ? fields : {}),
      }
      const line = JSON.stringify(record)
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
      return
    }
    const suffix = fields && typeof fields === 'object' && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ''
    const out = `${msg}${suffix}`
    if (level === 'error') console.error(out)
    else if (level === 'warn') console.warn(out)
    else console.log(out)
  }
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  }
}

export function maskEmailAddress(email) {
  const clean = String(email || '').trim()
  const at = clean.indexOf('@')
  if (at <= 0) return clean
  const local = clean.slice(0, at)
  const domain = clean.slice(at)
  const prefix = local.slice(0, Math.min(2, local.length))
  return `${prefix}***${domain}`
}

export function normalizeIpForMatch(rawAddr) {
  let addr = String(rawAddr || '').trim().toLowerCase()
  if (!addr) return ''
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  if (addr.startsWith('::ffff:')) addr = addr.slice(7)
  return addr
}

export function extractValidIp(raw) {
  let clean = String(raw || '').trim()
  if (!clean) return ''
  if (clean.startsWith('[') && clean.endsWith(']')) clean = clean.slice(1, -1)
  return net.isIP(clean) !== 0 ? clean : ''
}

function isLoopbackAddr(addr) {
  return addr === '127.0.0.1' || addr === '::1'
}

function isPrivateAddr(addr) {
  if (isLoopbackAddr(addr)) return true
  if (addr.startsWith('10.') || addr.startsWith('192.168.') || addr.startsWith('fc') || addr.startsWith('fd')) {
    return true
  }
  const m = addr.match(/^172\.(\d+)\./)
  if (m) {
    const second = Number(m[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

/**
 * Build a trusted reverse-proxy predicate from `TRUST_PROXY`:
 * - `'loopback'` (default): trusts ONLY `127.0.0.1` / `::1` / `::ffff:127.0.0.1`
 * - `'private'`: trusts loopback + RFC1918 / IPv6 ULA ranges (e.g. Docker bridge)
 * - `'none'` / `'false'` / `'0'` / `'off'`: never trusts forwarded headers
 * - comma-separated proxy IPs (optionally mixed with `'loopback'` / `'private'`)
 */
export function createTrustedProxyChecker(rawSpec = 'loopback') {
  const clean = String(rawSpec ?? '').trim().toLowerCase() || 'loopback'
  if (clean === 'false' || clean === 'none' || clean === '0' || clean === 'off') {
    return () => false
  }
  const tokens = clean.split(',').map((s) => s.trim()).filter(Boolean)
  let allowLoopback = false
  let allowPrivate = false
  const exactIps = new Set()
  for (const tok of tokens) {
    if (tok === 'loopback') allowLoopback = true
    else if (tok === 'private') allowPrivate = true
    else {
      const norm = normalizeIpForMatch(tok)
      if (norm && net.isIP(norm) !== 0) exactIps.add(norm)
    }
  }
  if (!allowLoopback && !allowPrivate && exactIps.size === 0) {
    allowLoopback = true
  }
  return (rawAddr) => {
    const addr = normalizeIpForMatch(rawAddr)
    if (!addr) return false
    if (allowPrivate && isPrivateAddr(addr)) return true
    if (allowLoopback && isLoopbackAddr(addr)) return true
    return exactIps.has(addr)
  }
}

/**
 * Extract authoritative client IP.
 * Always prefers rightmost non-trusted-proxy hop in `X-Forwarded-For` BEFORE `X-Real-IP`
 * so reverse proxies that pass client-supplied `X-Real-IP` (Caddy, Traefik, ALB, cloudflared)
 * cannot be spoofed to bypass IP rate limits.
 */
export function resolveClientIp(req, isTrustedProxy, { trustProxyHeader = '' } = {}) {
  const remote = String(req.socket?.remoteAddress || 'unknown').trim()
  if (!isTrustedProxy(remote)) return remote

  const headerMode = String(trustProxyHeader || '').trim().toLowerCase()
  const readRealIp = () => {
    const realIp = String(req.headers['x-real-ip'] || '').trim()
    if (realIp && !realIp.includes(',')) {
      return extractValidIp(realIp)
    }
    return ''
  }

  if (headerMode === 'x-real-ip') {
    const validReal = readRealIp()
    if (validReal) return validReal
  }

  const xff = String(req.headers['x-forwarded-for'] || '').trim()
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
    // Walk from right to left, stopping at the first hop that is NOT itself a trusted proxy
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const valid = extractValidIp(parts[i])
      if (!valid) continue
      if (!isTrustedProxy(valid) || i === 0) return valid
    }
  }

  // Fallback to X-Real-IP only when X-Forwarded-For is absent (and not explicitly forbidden)
  if (headerMode !== 'x-forwarded-for') {
    const validReal = readRealIp()
    if (validReal) return validReal
  }

  return remote
}

export function buildAllowedOriginsSet(publicRelayUrl, rawAllowedOrigins) {
  const allowed = new Set(CAPACITOR_ORIGINS)
  if (publicRelayUrl) {
    try {
      allowed.add(new URL(publicRelayUrl).origin.toLowerCase())
    } catch {}
  }
  const extra = String(rawAllowedOrigins || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const item of extra) {
    try {
      allowed.add(new URL(item).origin.toLowerCase())
    } catch {
      allowed.add(item.replace(/\/+$/, '').toLowerCase())
    }
  }
  return allowed
}

/**
 * Parse a JSON HTTP request body and assert that it is a plain object.
 * Throws `HttpError(413)` on size overflow and `HttpError(400)` on invalid JSON or non-object payload.
 */
export function readJsonObjectBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let total = 0
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      rejectPromise(err)
    }
    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        fail(new HttpError(413, '请求体过大', 'PAYLOAD_TOO_LARGE'))
        try { req.destroy() } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (!text) {
          resolvePromise({})
          return
        }
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          rejectPromise(new HttpError(400, '请求体必须是 JSON 对象', 'INVALID_JSON_OBJECT'))
          return
        }
        resolvePromise(parsed)
      } catch {
        rejectPromise(new HttpError(400, '请求格式错误', 'INVALID_JSON'))
      }
    })
    req.on('error', (err) => fail(new HttpError(400, String(err?.message || '读取请求失败'), 'REQUEST_STREAM_ERROR')))
  })
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function sendRouteError(res, err, log = console, context = '') {
  if (err instanceof HttpError) {
    sendJson(res, err.statusCode, {
      ok: false,
      ...(err.code ? { code: err.code } : {}),
      error: err.message,
    })
    return
  }
  if (err?.statusCode === 503) {
    sendJson(res, 503, { ok: false, error: err.message || '服务器繁忙，请稍后重试' })
    return
  }
  log.error?.(`[relay] Route error${context ? ` (${context})` : ''}: ${err?.stack || err?.message || err}`)
  sendJson(res, 500, { ok: false, error: '服务器内部错误，请稍后重试' })
}

export function getTrustedForwardedProto(req, isTrustedProxy) {
  if (!isTrustedProxy(req.socket?.remoteAddress)) return ''
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  return proto === 'https' || proto === 'http' ? proto : ''
}

export function validateSafeScriptUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/\/+$/, '')
  if (!trimmed || trimmed.length > 256) return ''
  if (!SAFE_SCRIPT_URL_RE.test(trimmed)) return ''
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return ''
    const cleanPath = parsed.pathname.replace(/\/+$/, '')
    const candidate = `${parsed.origin}${cleanPath}`
    return SAFE_SCRIPT_URL_RE.test(candidate) ? candidate : ''
  } catch {
    return ''
  }
}

export function resolveSafePublicScriptUrl(req, publicRelayUrl, isTrustedProxy) {
  if (publicRelayUrl) {
    return validateSafeScriptUrl(publicRelayUrl)
  }
  const trusted = isTrustedProxy(req.socket?.remoteAddress)
  const proto = (trusted && getTrustedForwardedProto(req, isTrustedProxy)) || (req.socket?.encrypted ? 'https' : 'http')
  const rawHost = String(req.headers.host || '').trim()
  if (!rawHost) return ''
  let prefix = ''
  if (trusted) {
    const rawPrefix = String(req.headers['x-forwarded-prefix'] || '').split(',')[0].trim()
    if (rawPrefix) {
      const normalized = rawPrefix.startsWith('/') ? rawPrefix : `/${rawPrefix}`
      const stripped = normalized.replace(/\/+$/, '')
      if (stripped && !stripped.includes('..') && SAFE_PREFIX_RE.test(stripped)) {
        prefix = stripped
      }
    }
  }
  return validateSafeScriptUrl(`${proto}://${rawHost}${prefix}`)
}

export function setSecurityHeaders(req, res, isTrustedProxy) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
  const forwardedProto = getTrustedForwardedProto(req, isTrustedProxy)
  if (forwardedProto === 'https' || req.socket?.encrypted) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

/**
 * Unified anti-spam quota gate for ALL non-OTP outbound security emails
 * (login alerts, 2FA disabled notices, email-change notices).
 */
export function createOutboundEmailGate({
  maxPerAccountPerHour = 5,
  maxGlobalPerHour = 120,
  loginAlertCooldownMs = 10 * 60 * 1000,
  securityNoticeCooldownMs = 2 * 60 * 1000,
  maxEntries = 5000,
} = {}) {
  const HOUR_MS = 60 * 60 * 1000
  /** @type {Map<string, number[]>} */
  const accountHourly = new Map()
  /** @type {Map<string, number>} */
  const cooldowns = new Map()
  /** @type {number[]} */
  let globalHourly = []

  function pruneStale(now) {
    globalHourly = globalHourly.filter((t) => now - t < HOUR_MS)
    if (accountHourly.size >= maxEntries) {
      for (const [k, list] of accountHourly.entries()) {
        const fresh = list.filter((t) => now - t < HOUR_MS)
        if (fresh.length === 0) accountHourly.delete(k)
        else accountHourly.set(k, fresh)
      }
      while (accountHourly.size >= maxEntries) {
        const oldest = accountHourly.keys().next().value
        if (!oldest) break
        accountHourly.delete(oldest)
      }
    }
    if (cooldowns.size >= maxEntries) {
      const maxCd = Math.max(loginAlertCooldownMs, securityNoticeCooldownMs)
      for (const [k, ts] of cooldowns.entries()) {
        if (now - ts >= maxCd) cooldowns.delete(k)
      }
      while (cooldowns.size >= maxEntries) {
        const oldest = cooldowns.keys().next().value
        if (!oldest) break
        cooldowns.delete(oldest)
      }
    }
  }

  function tryConsume({ userId, kind = 'security', ip = '' }) {
    const cleanUser = String(userId || '').trim()
    if (!cleanUser) return false
    const now = Date.now()
    pruneStale(now)

    const cdMs = kind === 'login_alert' ? loginAlertCooldownMs : securityNoticeCooldownMs
    const cdKey = kind === 'login_alert' ? `login:${cleanUser}:${String(ip || 'unknown').trim()}` : `${kind}:${cleanUser}`
    const lastAt = cooldowns.get(cdKey) || 0
    if (lastAt && now - lastAt < cdMs) return false

    const userEvents = (accountHourly.get(cleanUser) || []).filter((t) => now - t < HOUR_MS)
    if (userEvents.length >= maxPerAccountPerHour) return false
    if (globalHourly.length >= maxGlobalPerHour) return false

    cooldowns.set(cdKey, now)
    accountHourly.set(cleanUser, [...userEvents, now])
    globalHourly.push(now)
    return true
  }

  return { tryConsume }
}

/**
 * Per-IP successful registration limiter (prevents 1 IP from burning the global daily cap).
 */
export function createIpDailyRegistrationLimiter({ maxPerIpPerDay = 5, maxEntries = 5000 } = {}) {
  const limit = Math.max(0, Math.floor(Number(maxPerIpPerDay) || 0))
  /** @type {Map<string, { day: string, count: number }>} */
  const counts = new Map()

  function utcDay(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10)
  }

  function check(ip, now = Date.now()) {
    if (limit <= 0) return true
    const cleanIp = String(ip || 'unknown').trim().slice(0, 64) || 'unknown'
    const entry = counts.get(cleanIp)
    const today = utcDay(now)
    if (!entry || entry.day !== today) return true
    return entry.count < limit
  }

  function record(ip, now = Date.now()) {
    if (limit <= 0) return
    const cleanIp = String(ip || 'unknown').trim().slice(0, 64) || 'unknown'
    const today = utcDay(now)
    if (counts.size >= maxEntries) {
      for (const [k, v] of counts.entries()) {
        if (v.day !== today) counts.delete(k)
      }
      while (counts.size >= maxEntries) {
        const oldest = counts.keys().next().value
        if (!oldest) break
        counts.delete(oldest)
      }
    }
    const entry = counts.get(cleanIp)
    if (!entry || entry.day !== today) {
      counts.set(cleanIp, { day: today, count: 1 })
    } else {
      entry.count += 1
    }
  }

  return { check, record, limit }
}
