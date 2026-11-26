import { createHmac, randomInt } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createAuthManager } from './auth.js'
import { createAccountStore, normalizeMaxDailyRegistrations, validateEmail, validatePassword } from './accounts.js'
import { createEmailCodeStore } from './emailCodes.js'
import { createMailer } from './mailer.js'
import { RelayHub, parseClientDeviceInfo } from './hub.js'
import { createStunServer } from './stun-server.js'
import { buildAdminOverview, collectServerHealth } from './admin-monitor.js'
import {
  buildTurnQuotaSnapshot,
  createTurnLogMeter,
  getTurnQuotaBytesForTier,
  parseCoturnUsageLine,
  resolveTurnQuotaConfig,
} from './turn-meter.js'
import { createCloudflareTurnProvider, normalizeCloudflareIceResponse, parseCfTurnTiers } from './cf-turn.js'

export {
  buildTurnQuotaSnapshot,
  createCloudflareTurnProvider,
  getTurnQuotaBytesForTier,
  normalizeCloudflareIceResponse,
  parseCfTurnTiers,
  parseCoturnUsageLine,
  resolveTurnQuotaConfig,
}

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ADMIN_DASHBOARD_DIR = resolve(__dirname, './admin')
const RELAY_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'))
    return String(pkg?.version || '1.0.27')
  } catch {
    return '1.0.27'
  }
})()

/** Load simple .env file if present (no extra dependency needed). */
function loadDotEnv(filePath) {
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

loadDotEnv(resolve(__dirname, '../.env'))
loadDotEnv(resolve(__dirname, '../../../.env'))

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',
  '.dmg': 'application/octet-stream',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.ps1': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
}

const DEFAULT_PUBLIC_STUN_SERVERS = [
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.cloudflare.com:3478',
]

/**
 * Generate RFC draft-uberti-behave-turn-rest-00 time-limited HMAC-SHA1 TURN credentials
 * compatible with `coturn --use-auth-secret`.
 */
export function buildTurnCredentials({ secret, userId = 'allinone', ttlSec = 86_400, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const cleanSecret = String(secret || '').trim()
  if (!cleanSecret) return null
  const safeTtl = Math.max(60, Math.min(7 * 86_400, Number(ttlSec) || 86_400))
  const expiry = Math.floor(Number(nowSec) || Math.floor(Date.now() / 1000)) + safeTtl
  const safeUser = String(userId || 'allinone').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'allinone'
  const username = `${expiry}:${safeUser}`
  const credential = createHmac('sha1', cleanSecret).update(username).digest('base64')
  return { username, credential, expiresAt: expiry * 1000 }
}
const APP_HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' https: http: ws: wss:; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
const SANDBOX_PREVIEW_CSP =
  "sandbox allow-scripts allow-forms; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"

function maskEmailAddress(email) {
  const clean = String(email || '').trim()
  const at = clean.indexOf('@')
  if (at <= 0) return clean
  const local = clean.slice(0, at)
  const domain = clean.slice(at)
  const prefix = local.slice(0, Math.min(2, local.length))
  return `${prefix}***${domain}`
}

const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const CAPACITOR_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
  'http://localhost',
  'app://allinone',
])

function normalizeIpForMatch(rawAddr) {
  let addr = String(rawAddr || '').trim().toLowerCase()
  if (!addr) return ''
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  if (addr.startsWith('::ffff:')) addr = addr.slice(7)
  return addr
}

function extractValidIp(raw) {
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
function createTrustedProxyChecker(rawSpec = 'loopback') {
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

function buildAllowedOriginsSet(publicRelayUrl, rawAllowedOrigins) {
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

function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        rejectPromise(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise(text.length > 0 ? JSON.parse(text) : {})
      } catch (err) {
        rejectPromise(err)
      }
    })
    req.on('error', rejectPromise)
  })
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const SAFE_SCRIPT_URL_RE = /^https?:\/\/[A-Za-z0-9._:\-\[\]\/]+$/
const SAFE_PREFIX_RE = /^\/[A-Za-z0-9._\-\/]*$/

function getTrustedForwardedProto(req, isTrustedProxy) {
  if (!isTrustedProxy(req.socket?.remoteAddress)) return ''
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  return proto === 'https' || proto === 'http' ? proto : ''
}

function validateSafeScriptUrl(rawUrl) {
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

function resolveSafePublicScriptUrl(req, publicRelayUrl, isTrustedProxy) {
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

function setSecurityHeaders(req, res, isTrustedProxy) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // Allow self camera so built-in QR scanner continues to work cleanly in PWA/WebView
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
  const forwardedProto = getTrustedForwardedProto(req, isTrustedProxy)
  if (forwardedProto === 'https' || req.socket?.encrypted) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

function firstNonEmptyEnv(explicit, envVal, fallback) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return explicit
  if (envVal !== undefined && envVal !== null && String(envVal).trim() !== '') return envVal
  return fallback
}

export function createRelayServer(options = {}) {
  const port = Number(firstNonEmptyEnv(options.port, process.env.PORT, 8787))
  const host = String(firstNonEmptyEnv(options.host, process.env.HOST, '0.0.0.0')).trim()
  const jwtSecret = String(options.jwtSecret ?? process.env.JWT_SECRET ?? '').trim()
  const adminBootstrapToken = String(options.adminBootstrapToken ?? process.env.ADMIN_BOOTSTRAP_TOKEN ?? '').trim()
  const rawMaxDaily = options.maxDailyRegistrations ?? process.env.MAX_DAILY_REGISTRATIONS
  const maxDailyRegistrations = normalizeMaxDailyRegistrations(rawMaxDaily, 20)
  const publicRelayUrl = String(options.publicRelayUrl ?? process.env.PUBLIC_RELAY_URL ?? '').trim().replace(/\/+$/, '')
  const allowedOrigins = buildAllowedOriginsSet(
    publicRelayUrl,
    options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '',
  )
  const isTrustedProxy = createTrustedProxyChecker(options.trustProxy ?? process.env.TRUST_PROXY ?? 'loopback')
  const isProd = (options.nodeEnv ?? process.env.NODE_ENV) === 'production'
  if (isProd && !options.allowDevSecrets && jwtSecret.length < 16) {
    throw new Error(
      'Refusing to start in production without a strong JWT_SECRET (>= 16 chars). Set JWT_SECRET in .env.',
    )
  }

  const staticDir = resolve(
    options.staticDir ?? (process.env.STATIC_DIR || resolve(__dirname, '../../mobile-app/dist')),
  )
  const accountsFile = resolve(
    options.accountsFile ?? (process.env.ACCOUNTS_FILE || resolve(__dirname, '../data/accounts.json')),
  )

  const rawStunPort = firstNonEmptyEnv(options.stunPort, process.env.STUN_PORT, '3478')
  const stunDisabled =
    options.stunEnabled === false ||
    String(rawStunPort).trim().toLowerCase() === 'false' ||
    String(rawStunPort).trim().toLowerCase() === 'off' ||
    String(rawStunPort).trim() === '-1'
  const stunPort = stunDisabled ? -1 : Number(rawStunPort)
  const stunHost = String(
    firstNonEmptyEnv(options.stunHost, process.env.STUN_HOST, options.host ? options.host : '0.0.0.0'),
  ).trim()
  const stunServer =
    !stunDisabled && Number.isInteger(stunPort) && stunPort >= 0
      ? createStunServer({ port: stunPort, host: stunHost })
      : null

  const turnSecret = String(options.turnSecret ?? process.env.TURN_SECRET ?? '').trim()
  const turnHostExplicit = String(options.turnHost ?? process.env.TURN_HOST ?? '').trim()
  const turnPortRaw = firstNonEmptyEnv(options.turnPort, process.env.TURN_PORT, '3478')
  const turnPort = Number.isInteger(Number(turnPortRaw)) && Number(turnPortRaw) > 0 ? Number(turnPortRaw) : 3478
  const turnTtlSec = Math.max(120, Number(firstNonEmptyEnv(options.turnTtlSec, process.env.TURN_TTL_SEC, 600)) || 600)
  const turnLogFile = String(options.turnLogFile ?? process.env.TURN_LOG_FILE ?? '').trim()
  const turnQuotaConfig = resolveTurnQuotaConfig(options, process.env)
  let hubRef = null
  const cfTurn = createCloudflareTurnProvider(
    {
      ...options,
      onRecovered: () => {
        if (!hubRef) return
        for (const rid of hubRef.getActiveRoomIds()) {
          if (cfTurn.appliesToTier(accounts.getUserTier(rid))) {
            hubRef.pushIceUpdate(rid, { quotaExceeded: false })
          }
        }
      },
    },
    process.env,
  )

  const accounts = createAccountStore({ filePath: accountsFile })
  const mailer = createMailer(options)
  const emailCodes = createEmailCodeStore(options.emailCodeOptions || {})
  const startedAt = Date.now()

  function buildUserTurnQuota(roomId) {
    const rid = String(roomId || '').trim()
    if (!rid.startsWith('usr_')) return null
    const tier = accounts.getUserTier(rid)
    const usage = accounts.getTurnUsage(rid)
    const snap = buildTurnQuotaSnapshot({
      tier,
      month: usage.month,
      usedBytes: usage.bytes,
      config: turnQuotaConfig,
    })
    const cfActive = Boolean(cfTurn.appliesToTier(tier) && cfTurn.getIceEntry())
    return {
      ...snap,
      ...(cfActive ? { exceeded: false } : {}),
      provider: cfActive ? 'cloudflare' : turnSecret ? 'self-hosted' : 'none',
    }
  }

  function extractPublicHostname(req = null) {
    if (turnHostExplicit) return turnHostExplicit
    if (publicRelayUrl) {
      try {
        return new URL(publicRelayUrl).hostname
      } catch {}
    }
    // Use per-request Host only for that specific request; never mutate global state across rooms
    if (req?.headers?.host) {
      try {
        const parsed = new URL(`http://${req.headers.host}`).hostname
        if (parsed) return parsed
      } catch {}
    }
    return ''
  }

  function resolveIceServers(req = null, scopeId = '') {
    if (Array.isArray(options.iceServers)) {
      return options.iceServers
    }
    const envIce = String(process.env.ICE_SERVERS || '').trim()
    if (envIce) {
      return envIce
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((urls) => ({ urls }))
    }

    const publicHost = extractPublicHostname(req)
    const bareHost = publicHost ? publicHost.replace(/^\[|\]$/g, '') : ''
    const formattedHost = bareHost && bareHost.includes(':') ? `[${bareHost}]` : bareHost
    const stunStats = stunServer?.getStats?.()
    const quota = scopeId ? buildUserTurnQuota(scopeId) : null

    // Mode 0: Tiered Cloudflare Realtime TURN (e.g. `free` tier -> Cloudflare 1 TB/mo free pool, 0 self-hosted VPS egress)
    // Still puts our low-latency domestic STUN first when available so direct P2P stays fast & proxy-clean.
    if (cfTurn.enabled && quota && cfTurn.appliesToTier(quota.tier)) {
      const cfEntry = cfTurn.getIceEntry()
      if (cfEntry && cfEntry.turnServers.length > 0) {
        const servers = []
        if (formattedHost && (turnSecret || (stunStats?.enabled && stunStats.port > 0))) {
          const stunPortNum = turnSecret ? turnPort : stunStats.port
          servers.push({ urls: `stun:${formattedHost}:${stunPortNum}` })
        } else if (cfEntry.stunServers.length > 0) {
          servers.push(...cfEntry.stunServers)
        }
        servers.push(...cfEntry.turnServers)
        return servers
      }
    }

    // Mode 1: Hardened self-hosted coturn (handles BOTH STUN and TURN UDP+TCP cleanly with zero proxy-polluted public STUNs)
    if (turnSecret && formattedHost) {
      const servers = [{ urls: `stun:${formattedHost}:${turnPort}` }]
      if (!quota || !quota.exceeded) {
        const creds = buildTurnCredentials({
          secret: turnSecret,
          userId: scopeId || 'allinone',
          ttlSec: turnTtlSec,
        })
        if (creds) {
          servers.push(
            {
              urls: `turn:${formattedHost}:${turnPort}?transport=udp`,
              username: creds.username,
              credential: creds.credential,
            },
            {
              urls: `turn:${formattedHost}:${turnPort}?transport=tcp`,
              username: creds.username,
              credential: creds.credential,
            },
          )
        }
      }
      return servers
    }

    // Mode 2: Built-in stateless Node STUN (UDP 3478)
    if (stunStats?.enabled && stunStats.port > 0 && formattedHost) {
      return [{ urls: `stun:${formattedHost}:${stunStats.port}` }]
    }

    // Mode 3: Public STUN fallback (only when neither TURN nor built-in STUN is active)
    return DEFAULT_PUBLIC_STUN_SERVERS.map((u) => ({ urls: u }))
  }
  const auth = createAuthManager({
    jwtSecret,
    adminBootstrapToken,
    getTokenVersion: (roomId) => accounts.getTokenVersion(roomId),
    isSessionRevoked: (roomId, sid) => accounts.isSessionRevoked(roomId, sid),
    hasUserSession: (roomId, sid) => accounts.hasUserSession(roomId, sid),
  })

  function getMergedAccountDevices(roomId, liveBridges = null) {
    if (!String(roomId || '').startsWith('usr_')) return undefined
    const bound = accounts.listUserDevices(roomId)
    const live = liveBridges || hub.getBridgeList(roomId)
    const liveByBridgeId = new Map(live.map((b) => [b.bridgeId, b]))
    const merged = bound.map((dev) => {
      const b = liveByBridgeId.get(dev.bridgeId)
      return {
        deviceId: dev.deviceId,
        bridgeId: dev.bridgeId,
        label: dev.label || b?.hostname || dev.hostname || dev.bridgeId,
        hostname: b?.hostname || dev.hostname || dev.bridgeId,
        platform: b?.platform || dev.platform || 'unknown',
        online: Boolean(b?.online),
        apps: b?.apps || [],
        e2ee: b?.e2ee || null,
        mode: b?.mode || 'portable',
        connectedAt: b?.connectedAt || 0,
        lastSeenAt: b?.lastSeen || dev.lastSeenAt || dev.createdAt || 0,
        createdAt: dev.createdAt || 0,
      }
    })
    // Online devices first, then most recently seen
    merged.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    return merged
  }

  function getMergedClientSessions(roomId, { currentSid = '', currentClientId = '' } = {}) {
    const rid = String(roomId || '').trim()
    const liveClients = hub.getClientList(rid)
    const persisted = accounts.listUserSessions(rid)
    const liveBySid = new Map()

    for (const c of liveClients) {
      if (!c.sid) continue
      const arr = liveBySid.get(c.sid) || []
      arr.push(c)
      liveBySid.set(c.sid, arr)
    }

    const sessions = []
    const seenSids = new Set()

    for (const p of persisted) {
      seenSids.add(p.sid)
      const conns = liveBySid.get(p.sid) || []
      const newestConn = conns[0] || null
      const isCurrent = Boolean(
        (currentSid && p.sid === currentSid) ||
        (currentClientId && conns.some((c) => c.clientId === currentClientId)),
      )
      sessions.push({
        sid: p.sid,
        clientId: newestConn?.clientId || '',
        clientIds: conns.map((c) => c.clientId),
        connectionCount: conns.length,
        deviceName: newestConn?.deviceName || p.deviceName || 'Web Client',
        clientKind: newestConn?.clientKind || p.clientKind || 'web',
        ip: newestConn?.ip || p.ip || '',
        online: conns.length > 0,
        isCurrent,
        createdAt: p.createdAt || newestConn?.connectedAt || 0,
        lastSeenAt: newestConn?.lastSeenAt || p.lastSeenAt || p.createdAt || 0,
      })
    }

    for (const [sid, conns] of liveBySid.entries()) {
      if (seenSids.has(sid)) continue
      const newestConn = conns[0]
      const isCurrent = Boolean(
        (currentSid && sid === currentSid) ||
        (currentClientId && conns.some((c) => c.clientId === currentClientId)),
      )
      sessions.push({
        sid,
        clientId: newestConn.clientId,
        clientIds: conns.map((c) => c.clientId),
        connectionCount: conns.length,
        deviceName: newestConn.deviceName || 'Web Client',
        clientKind: newestConn.clientKind || 'web',
        ip: newestConn.ip || '',
        online: true,
        isCurrent,
        createdAt: newestConn.connectedAt || 0,
        lastSeenAt: newestConn.lastSeenAt || newestConn.connectedAt || 0,
      })
    }

    sessions.sort(
      (a, b) =>
        Number(b.isCurrent) - Number(a.isCurrent) ||
        Number(b.online) - Number(a.online) ||
        (b.lastSeenAt || 0) - (a.lastSeenAt || 0),
    )

    const onlineCount = liveClients.length
    const onlineDeviceCount = sessions.filter((s) => s.online).length
    return {
      sessions,
      onlineCount,
      onlineDeviceCount,
      totalCount: sessions.length,
    }
  }

  const iceRefreshSec = Math.min(
    turnSecret ? turnTtlSec * 0.75 : Infinity,
    cfTurn.enabled ? cfTurn.ttlSec * 0.45 : Infinity,
  )
  const iceRefreshMs = Number.isFinite(iceRefreshSec) ? Math.max(60_000, Math.floor(iceRefreshSec * 1000)) : 0
  const hub = new RelayHub({
    getRoomDevices: (roomId, liveBridges) => getMergedAccountDevices(roomId, liveBridges),
    getIceServers: (req, roomId) => resolveIceServers(req, roomId),
    getTurnQuota: (roomId) => buildUserTurnQuota(roomId),
    iceRefreshIntervalMs: iceRefreshMs,
  })
  hubRef = hub

  function recordTurnUsageBytes(userId, billedBytes) {
    const rid = String(userId || '').trim()
    if (!rid.startsWith('usr_') || !Number.isFinite(billedBytes) || billedBytes <= 0) return null
    const before = buildUserTurnQuota(rid)
    const updated = accounts.addTurnUsage(rid, billedBytes)
    if (!updated) return null
    const after = buildUserTurnQuota(rid)
    if (!before?.exceeded && after?.exceeded) {
      const targetUser = accounts.getUserById(rid)
      console.log(
        `[turn-meter] User ${targetUser ? `@${targetUser.username}` : rid} (${after.tier}) reached monthly TURN quota (${after.usedBytes}/${after.quotaBytes} B); switching to P2P-only`,
      )
      hub.recordActivity({
        type: 'turn.quota_exceeded',
        roomId: rid,
        label: targetUser ? `@${targetUser.username}` : rid,
        detail: `${after.tier.toUpperCase()} monthly TURN limit reached`,
      })
      hub.pushIceUpdate(rid, { quotaExceeded: true })
    }
    return after
  }

  const turnMeter = turnLogFile
    ? createTurnLogMeter({
        logPath: turnLogFile,
        pollIntervalMs: options.turnMeterPollMs || 3_000,
        startFromBeginning: Boolean(options.turnMeterStartFromBeginning),
        onUsage: ({ userId, billedBytes }) => {
          recordTurnUsageBytes(userId, billedBytes)
        },
      })
    : null

  function isAllowedOrigin(rawOrigin, req) {
    const origin = String(rawOrigin || '').trim()
    if (!origin) return true
    const lower = origin.replace(/\/+$/, '').toLowerCase()
    if (allowedOrigins.has(lower)) return true
    if (!isProd && LOCAL_DEV_ORIGIN_RE.test(lower)) return true
    const reqHost = String(req?.headers?.host || '').trim().toLowerCase()
    if (reqHost && (lower === `https://${reqHost}` || lower === `http://${reqHost}`)) {
      return true
    }
    return false
  }

  function setCors(req, res) {
    const origin = req.headers.origin
    if (origin && isAllowedOrigin(origin, req)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Bridge-Secret, X-Room-Id',
    )
  }

  function extractBearer(req) {
    const header = req.headers.authorization || ''
    if (header.startsWith('Bearer ')) return header.slice(7).trim()
    return ''
  }

  function getClientIp(req) {
    const remote = String(req.socket?.remoteAddress || 'unknown').trim()
    if (isTrustedProxy(remote)) {
      const realIp = String(req.headers['x-real-ip'] || '').trim()
      if (realIp && !realIp.includes(',')) {
        const validReal = extractValidIp(realIp)
        if (validReal) return validReal
      }
      const xff = String(req.headers['x-forwarded-for'] || '').trim()
      if (xff) {
        const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
        // Rightmost X-Forwarded-For entry is appended by the trusted reverse proxy (cannot be spoofed by client)
        if (parts.length > 0) {
          const validXff = extractValidIp(parts[parts.length - 1])
          if (validXff) return validXff
        }
      }
    }
    return remote
  }

  // Per-user mutation & API rate limiter (bounded map, 1-minute sliding window)
  const userActionBuckets = new Map()
  const MAX_USER_ACTION_BUCKETS = 5000
  function checkUserActionRateLimit(bucketName, roomId, limitPerMin = 60) {
    const rid = String(roomId || '').trim()
    if (!rid) return true
    const key = `${bucketName}:${rid}`
    const now = Date.now()
    const windowMs = 60_000
    if (userActionBuckets.size >= MAX_USER_ACTION_BUCKETS) {
      for (const [k, v] of userActionBuckets.entries()) {
        if (now - v.startAt >= windowMs) userActionBuckets.delete(k)
      }
      while (userActionBuckets.size >= MAX_USER_ACTION_BUCKETS) {
        const oldest = userActionBuckets.keys().next().value
        if (!oldest) break
        userActionBuckets.delete(oldest)
      }
    }
    const entry = userActionBuckets.get(key)
    if (!entry || now - entry.startAt >= windowMs) {
      userActionBuckets.set(key, { count: 1, startAt: now })
      return true
    }
    if (entry.count >= limitPerMin) return false
    entry.count += 1
    return true
  }

  // Per-(account, ip) 10-minute cooldown on login alert emails to prevent alert spam
  const LOGIN_ALERT_COOLDOWN_MS = 10 * 60 * 1000
  const MAX_LOGIN_ALERT_ENTRIES = 5000
  const loginAlertCooldowns = new Map()
  function shouldSendLoginAlert(userId, ip) {
    const cleanUser = String(userId || '').trim()
    const cleanIp = String(ip || '').trim() || 'unknown'
    if (!cleanUser) return false
    const now = Date.now()
    const key = `${cleanUser}::${cleanIp}`
    const lastAt = loginAlertCooldowns.get(key)
    if (lastAt && now - lastAt < LOGIN_ALERT_COOLDOWN_MS) return false
    if (loginAlertCooldowns.size >= MAX_LOGIN_ALERT_ENTRIES) {
      for (const [k, ts] of loginAlertCooldowns.entries()) {
        if (now - ts >= LOGIN_ALERT_COOLDOWN_MS) loginAlertCooldowns.delete(k)
      }
      while (loginAlertCooldowns.size >= MAX_LOGIN_ALERT_ENTRIES) {
        const oldest = loginAlertCooldowns.keys().next().value
        if (!oldest) break
        loginAlertCooldowns.delete(oldest)
      }
    }
    loginAlertCooldowns.set(key, now)
    return true
  }

  // Global & per-IP concurrent WebSocket connection caps
  const maxWsPerIp = Math.max(10, Number(firstNonEmptyEnv(options.maxWsPerIp, process.env.MAX_WS_PER_IP, 120)) || 120)
  const maxWsGlobal = Math.max(20, Number(firstNonEmptyEnv(options.maxWsGlobal, process.env.MAX_WS_GLOBAL, 10_000)) || 10_000)
  let activeWsGlobal = 0
  const activeWsByIp = new Map()
  function tryAcquireWsSlot(ip) {
    const cleanIp = String(ip || 'unknown').trim().slice(0, 64) || 'unknown'
    if (activeWsGlobal >= maxWsGlobal) return { ok: false, statusLine: '503 Service Unavailable', release: null }
    const curIp = activeWsByIp.get(cleanIp) || 0
    if (curIp >= maxWsPerIp) return { ok: false, statusLine: '429 Too Many Requests', release: null }
    activeWsGlobal += 1
    activeWsByIp.set(cleanIp, curIp + 1)
    let released = false
    return {
      ok: true,
      statusLine: '',
      release: () => {
        if (released) return
        released = true
        activeWsGlobal = Math.max(0, activeWsGlobal - 1)
        const next = (activeWsByIp.get(cleanIp) || 0) - 1
        if (next <= 0) activeWsByIp.delete(cleanIp)
        else activeWsByIp.set(cleanIp, next)
      },
    }
  }

  /**
   * Authenticate a PC Bridge request via HTTP headers ONLY (never URL query secrets!)
   * Strictly requires account device bridges (`usr_*` + per-PC `deviceSecret` -> authoritative `bridgeId`).
   */
  function authenticateBridgeInfo(req, urlObj) {
    const secret = String(req.headers['x-bridge-secret'] || '').trim()
    const requestedRoom = String(req.headers['x-room-id'] || urlObj?.searchParams?.get('roomId') || '').trim()
    if (!secret || !requestedRoom.startsWith('usr_')) return null
    return accounts.verifyDeviceBridge(requestedRoom, secret)
  }

  function requireAdmin(req, res) {
    const payload = auth.verifySessionToken(extractBearer(req))
    if (!payload) {
      sendJson(res, 401, { ok: false, error: '未登录或登录已失效' })
      return null
    }
    const acct = accounts.getUserById(payload.room)
    if (!acct || acct.role !== 'admin') {
      sendJson(res, 403, { ok: false, error: '仅管理员可访问监控面板' })
      return null
    }
    return payload
  }

  /**
   * Enforce optional Email 2FA challenge/send/verify/consume flow for login endpoints.
   * Returns `true` if login may proceed; returns `false` if an HTTP response was already sent.
   */
  async function handleOptionalEmail2fa(res, { user, emailCode, ip, accountRateKey }) {
    if (!user?.loginEmail2fa) {
      return true
    }
    // Fail-closed: never silently bypass enabled 2FA if mailer is unavailable or misconfigured
    if (!mailer.isConfigured() || !user.email || !user.emailVerified) {
      sendJson(res, 503, { ok: false, error: '服务器邮件服务异常，暂无法完成邮箱二次验证' })
      return false
    }
    const cleanCode = String(emailCode || '').trim()
    const maskedEmail = maskEmailAddress(user.email)
    if (!cleanCode) {
      const issued = emailCodes.issueCode({
        purpose: 'login_2fa',
        email: user.email,
        ip,
        userId: user.userId,
      })
      if (!issued.ok) {
        if (issued.retryAfterSec) {
          sendJson(res, 200, {
            ok: false,
            requires2fa: true,
            maskedEmail,
            cooldownSec: issued.retryAfterSec,
            message: `验证码已发送至 ${maskedEmail}，请直接输入或 ${issued.retryAfterSec} 秒后重发`,
          })
          return false
        }
        sendJson(res, 429, { ok: false, error: issued.error })
        return false
      }
      try {
        await mailer.sendVerificationCode({
          to: user.email,
          code: issued.code,
          purpose: 'login_2fa',
          username: user.username,
        })
      } catch (mailErr) {
        issued.rollback?.()
        console.error(`[relay] Failed to send login 2FA email for @${user.username}:`, mailErr?.message || mailErr)
        sendJson(res, 502, { ok: false, error: '发送登录验证码失败，请稍后重试或联系管理员检查邮件服务配置' })
        return false
      }
      sendJson(res, 200, {
        ok: false,
        requires2fa: true,
        maskedEmail,
        cooldownSec: issued.cooldownSec,
        message: `已向 ${maskedEmail} 发送 6 位登录验证码`,
      })
      return false
    }
    const check2fa = emailCodes.verifyCode({
      purpose: 'login_2fa',
      email: user.email,
      code: cleanCode,
      userId: user.userId,
      consume: false,
    })
    if (!check2fa.ok) {
      auth.recordFailure(ip)
      auth.recordAccountFailure(accountRateKey, ip)
      sendJson(res, 401, {
        ok: false,
        requires2fa: true,
        maskedEmail,
        error: check2fa.error,
      })
      return false
    }
    emailCodes.consumeCode({ purpose: 'login_2fa', email: user.email })
    return true
  }

  const server = http.createServer(async (req, res) => {
    try {
      setSecurityHeaders(req, res, isTrustedProxy)
      setCors(req, res)
      if (req.method === 'OPTIONS') {
        if (req.headers.origin && !isAllowedOrigin(req.headers.origin, req)) {
          res.writeHead(403)
          res.end()
          return
        }
        res.writeHead(204)
        res.end()
        return
      }

      let urlObj
      try {
        urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      } catch {
        sendJson(res, 400, { ok: false, error: 'Bad Request' })
        return
      }
      const pathname = urlObj.pathname

    // Health check (privacy-safe: unauthenticated callers only see `{ ok: true }`)
    if (pathname === '/api/health' && req.method === 'GET') {
      const user = auth.verifySessionToken(extractBearer(req))
      if (!user) {
        sendJson(res, 200, { ok: true })
        return
      }
      const bridges = hub.getBridgeList(user.room)
      sendJson(res, 200, {
        ok: true,
        version: RELAY_VERSION,
        roomId: user.room,
        bridges,
        onlineBridges: bridges.filter((b) => b.online).length,
        uptimeSec: Math.round(process.uptime()),
      })
      return
    }

    // Account bootstrap check (status so UI knows whether an admin exists, SMTP availability & daily registration quota)
    if (pathname === '/api/account/bootstrap-status' && req.method === 'GET') {
      const hasAdmin = accounts.hasAnyUser()
      const dailyStats = accounts.getDailyRegistrationStats(maxDailyRegistrations)
      sendJson(res, 200, {
        ok: true,
        hasAdmin,
        hasUsers: hasAdmin,
        userCount: accounts.getUserCount(),
        needsBootstrapToken: !hasAdmin && Boolean(adminBootstrapToken),
        emailEnabled: mailer.isConfigured(),
        openRegistration: true,
        dailyRegistrationLimit: maxDailyRegistrations,
        dailyRegistrationsUsed: dailyStats.used,
        dailyRegistrationRemaining: dailyStats.remaining,
      })
      return
    }

    // Send 6-digit email verification code for optional register binding, post-login email bind, or password reset
    if (pathname === '/api/account/email/send-code' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      if (!mailer.isConfigured()) {
        sendJson(res, 503, { ok: false, error: '服务器尚未配置邮件服务（SMTP）' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const purpose = String(body.purpose || '').trim()
        if (purpose !== 'register' && purpose !== 'bind' && purpose !== 'reset') {
          sendJson(res, 400, { ok: false, error: '不支持的验证码用途' })
          return
        }
        const eCheck = validateEmail(body.email)
        if (!eCheck.ok) {
          sendJson(res, 400, { ok: false, error: eCheck.error })
          return
        }

        let targetUserId = ''
        let targetUsername = ''
        let shouldDeliver = true

        if (purpose === 'register') {
          if (accounts.hasAnyUser()) {
            const dailyStats = accounts.getDailyRegistrationStats(maxDailyRegistrations)
            if (dailyStats.exceeded) {
              sendJson(res, 429, {
                ok: false,
                code: 'DAILY_REGISTRATION_LIMIT',
                error: `今日新用户注册名额已满（每日上限 ${dailyStats.limit} 人），请明天再试`,
              })
              return
            }
          } else if (adminBootstrapToken) {
            const bootstrapToken = String(body.bootstrapToken || '').trim()
            if (!auth.verifyAdminBootstrapToken(bootstrapToken)) {
              auth.recordFailure(ip)
              sendJson(res, 400, { ok: false, error: '管理员初始化密钥无效' })
              return
            }
          }
          if (accounts.isEmailTaken(eCheck.email)) {
            sendJson(res, 400, { ok: false, error: '该邮箱已被其他账号绑定' })
            return
          }
        } else if (purpose === 'bind') {
          const payload = auth.verifySessionToken(extractBearer(req))
          if (!payload || !String(payload.room || '').startsWith('usr_')) {
            sendJson(res, 401, { ok: false, error: '请先登录账号后再绑定邮箱' })
            return
          }
          if (!checkUserActionRateLimit('write', payload.room, 60)) {
            sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
            return
          }
          const curUser = accounts.getUserById(payload.room)
          if (!curUser) {
            sendJson(res, 401, { ok: false, error: '账号不存在' })
            return
          }
          if (accounts.isEmailTaken(eCheck.email, payload.room)) {
            sendJson(res, 400, { ok: false, error: '该邮箱已被其他账号绑定' })
            return
          }
          if (curUser.email && curUser.email.toLowerCase() === eCheck.emailLower && curUser.emailVerified) {
            sendJson(res, 400, { ok: false, error: '当前账号已绑定该邮箱' })
            return
          }
          targetUserId = payload.room
          targetUsername = curUser.username
        } else if (purpose === 'reset') {
          const matchedUser = accounts.getUserByEmail(eCheck.email)
          if (!matchedUser || !matchedUser.emailVerified) {
            // Do not reveal whether the email is registered, do not spend SMTP quota,
            // and do not insert fake emails into emailCodes.codes or emailSendLog (prevents FIFO eviction).
            shouldDeliver = false
          } else {
            targetUserId = matchedUser.userId
            targetUsername = matchedUser.username
          }
        }

        if (!shouldDeliver) {
          const ipCheck = emailCodes.checkIpSendLimit(ip)
          if (!ipCheck.ok) {
            sendJson(res, 429, { ok: false, error: ipCheck.error })
            return
          }
          const cfg = emailCodes.getConfig()
          await new Promise((r) => setTimeout(r, 40 + randomInt(0, 60)))
          sendJson(res, 200, {
            ok: true,
            cooldownSec: cfg.cooldownSec,
            expiresInSec: cfg.expiresInSec,
            message: '如果该邮箱已绑定账号，验证码已发送（10 分钟内有效）',
          })
          return
        }

        const issued = emailCodes.issueCode({
          purpose,
          email: eCheck.email,
          ip,
          userId: targetUserId,
        })
        if (!issued.ok) {
          sendJson(res, 429, {
            ok: false,
            error: issued.error,
            ...(issued.retryAfterSec ? { retryAfterSec: issued.retryAfterSec } : {}),
          })
          return
        }

        try {
          await mailer.sendVerificationCode({
            to: eCheck.email,
            code: issued.code,
            purpose,
            username: targetUsername,
          })
        } catch (err) {
          issued.rollback()
          console.error(`[relay] Failed to send ${purpose} verification email:`, err?.message || err)
          sendJson(res, 502, { ok: false, error: '验证码发送失败，请稍后重试或检查邮件服务配置' })
          return
        }

        sendJson(res, 200, {
          ok: true,
          cooldownSec: issued.cooldownSec,
          expiresInSec: issued.expiresInSec,
          message:
            purpose === 'reset'
              ? '如果该邮箱已绑定账号，验证码已发送（10 分钟内有效）'
              : '验证码已发送至邮箱（10 分钟内有效）',
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Account registration (open registration with configurable daily cap;
    // email binding is strictly optional when SMTP is configured;
    // when 0 users exist yet, first user becomes admin and requires ADMIN_BOOTSTRAP_TOKEN if configured)
    if (pathname === '/api/account/register' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const bootstrapToken = String(body.bootstrapToken || '').trim()

        if (accounts.hasAnyUser()) {
          const dailyStats = accounts.getDailyRegistrationStats(maxDailyRegistrations)
          if (dailyStats.exceeded) {
            sendJson(res, 429, {
              ok: false,
              code: 'DAILY_REGISTRATION_LIMIT',
              error: `今日新用户注册名额已满（每日上限 ${dailyStats.limit} 人），请明天再试`,
            })
            return
          }
        } else if (adminBootstrapToken && !auth.verifyAdminBootstrapToken(bootstrapToken)) {
          auth.recordFailure(ip)
          sendJson(res, 400, { ok: false, error: '管理员初始化密钥无效' })
          return
        }

        const rawEmail = String(body.email || '').trim()
        let verifiedEmail = ''
        if (rawEmail) {
          if (!mailer.isConfigured()) {
            sendJson(res, 400, { ok: false, error: '服务器尚未开启邮箱验证，请留空邮箱直接注册' })
            return
          }
          const eCheck = validateEmail(rawEmail)
          if (!eCheck.ok) {
            sendJson(res, 400, { ok: false, error: eCheck.error })
            return
          }
          if (accounts.isEmailTaken(eCheck.email)) {
            sendJson(res, 400, { ok: false, error: '该邮箱已被其他账号绑定' })
            return
          }
          const codeCheck = emailCodes.verifyCode({
            purpose: 'register',
            email: eCheck.email,
            code: body.emailCode,
            consume: false,
          })
          if (!codeCheck.ok) {
            auth.recordFailure(ip)
            sendJson(res, 400, { ok: false, error: codeCheck.error })
            return
          }
          verifiedEmail = eCheck.email
        }

        const result = await accounts.registerUserAsync({
          username: body.username,
          password: body.password,
          bootstrapToken,
          expectedBootstrapToken: adminBootstrapToken,
          email: verifiedEmail,
          emailVerified: Boolean(verifiedEmail),
          maxDailyRegistrations,
        })
        if (!result.ok) {
          const statusCode = result.statusCode || 400
          if (statusCode !== 429) auth.recordFailure(ip)
          sendJson(res, statusCode, {
            ok: false,
            ...(result.code ? { code: result.code } : {}),
            error: result.error,
          })
          return
        }
        if (verifiedEmail) {
          emailCodes.consumeCode({ purpose: 'register', email: verifiedEmail })
        }
        auth.clearFailure(ip)
        const user = result.user
        const devInfo = parseClientDeviceInfo(body.deviceName || '', req.headers['user-agent'] || '', body.clientKind || '')
        const sid = auth.generateSessionId()
        const onlineSids = new Set(hub.getClientList(user.userId).map((c) => c.sid).filter(Boolean))
        accounts.recordUserSession(user.userId, {
          sid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
          clientUid: body.clientUid || '',
          onlineSids,
        })
        hub.recordActivity({
          type: 'user.register',
          roomId: user.userId,
          label: `@${user.username}`,
          detail: devInfo.deviceName,
          ip,
        })
        const token = auth.signSessionToken(
          user.userId,
          devInfo.deviceName,
          user.userId,
          user.tokenVersion,
          { role: user.role, username: user.username, sid },
        )
        sendJson(res, 200, {
          ok: true,
          token,
          roomId: user.userId,
          user,
          devices: [],
          bridges: [],
        })
      } catch (err) {
        if (err?.statusCode === 503) {
          sendJson(res, 503, { ok: false, error: err.message || '服务器繁忙，请稍后重试' })
          return
        }
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Bind or replace verified email for an authenticated account (requires currentPassword re-authentication)
    if (pathname === '/api/account/email/bind' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
        return
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return
      }
      if (!mailer.isConfigured()) {
        sendJson(res, 503, { ok: false, error: '服务器尚未配置邮件服务（SMTP）' })
        return
      }
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip) || !auth.checkAccountRateLimit(payload.room, ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请稍后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const currentPassword = String(body.currentPassword ?? '')
        if (!currentPassword) {
          sendJson(res, 403, { ok: false, error: '绑定或更换邮箱需要验证当前密码' })
          return
        }
        const pwValid = await accounts.verifyUserPasswordAsync(payload.room, currentPassword)
        if (!pwValid) {
          auth.recordFailure(ip)
          auth.recordAccountFailure(payload.room, ip)
          sendJson(res, 403, { ok: false, error: '绑定或更换邮箱需要验证当前密码' })
          return
        }
        auth.clearAccountFailure(payload.room, ip)
        const eCheck = validateEmail(body.email)
        if (!eCheck.ok) {
          sendJson(res, 400, { ok: false, error: eCheck.error })
          return
        }
        const codeCheck = emailCodes.verifyCode({
          purpose: 'bind',
          email: eCheck.email,
          code: body.code,
          userId: payload.room,
          consume: false,
        })
        if (!codeCheck.ok) {
          sendJson(res, 400, { ok: false, error: codeCheck.error })
          return
        }
        const prevUser = accounts.getUserById(payload.room)
        const prevEmail = prevUser?.email && prevUser.emailVerified ? prevUser.email : ''
        const updated = accounts.setUserEmail(payload.room, eCheck.email, { verified: true })
        if (!updated.ok) {
          sendJson(res, 400, { ok: false, error: updated.error })
          return
        }
        emailCodes.consumeCode({ purpose: 'bind', email: eCheck.email })
        if (prevEmail && prevEmail.toLowerCase() !== eCheck.emailLower) {
          mailer
            .sendSecurityNotice({
              to: prevEmail,
              username: updated.user.username,
              title: '账号绑定邮箱已变更',
              summary: `你的 All in One 账号绑定邮箱已更换为 ${maskEmailAddress(eCheck.email)}。如非本人操作，请立即修改密码并强制下线所有设备。`,
              ip,
              at: Date.now(),
            })
            .catch((err) => {
              console.warn(`[relay] Failed to send email-change security notice for @${updated.user.username}: ${String(err?.message || err)}`)
            })
        }
        sendJson(res, 200, { ok: true, user: updated.user })
      } catch (err) {
        if (err?.statusCode === 503) {
          sendJson(res, 503, { ok: false, error: err.message || '服务器繁忙，请稍后重试' })
          return
        }
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Self-service password reset using verified email OTP (revokes all active sessions immediately)
    if (pathname === '/api/account/password/reset' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      if (!mailer.isConfigured()) {
        sendJson(res, 503, { ok: false, error: '服务器尚未配置邮件服务（SMTP）' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const eCheck = validateEmail(body.email)
        if (!eCheck.ok) {
          sendJson(res, 400, { ok: false, error: eCheck.error })
          return
        }
        const pCheck = validatePassword(body.newPassword)
        if (!pCheck.ok) {
          sendJson(res, 400, { ok: false, error: pCheck.error })
          return
        }
        const matchedUser = accounts.getUserByEmail(eCheck.email)
        const accountRateKey = accounts.resolveAccountKey(eCheck.email)
        if (accountRateKey && !auth.checkResetRateLimit(accountRateKey)) {
          sendJson(res, 429, { ok: false, error: '该账号验证尝试过于频繁，请 15 分钟后再试' })
          return
        }
        const codeCheck = emailCodes.verifyCode({
          purpose: 'reset',
          email: eCheck.email,
          code: body.code,
          userId: matchedUser?.userId || '',
          consume: false,
        })
        if (!codeCheck.ok || !matchedUser || !matchedUser.emailVerified) {
          auth.recordFailure(ip)
          if (accountRateKey) auth.recordResetFailure(accountRateKey)
          sendJson(res, 400, { ok: false, error: codeCheck.ok ? '邮箱验证码无效或已过期' : codeCheck.error })
          return
        }
        const reset = await accounts.resetPasswordByEmailAsync(eCheck.email, pCheck.password)
        if (!reset.ok) {
          auth.recordFailure(ip)
          if (accountRateKey) auth.recordResetFailure(accountRateKey)
          sendJson(res, 400, { ok: false, error: reset.error })
          return
        }
        emailCodes.consumeCode({ purpose: 'reset', email: eCheck.email })
        auth.clearFailure(ip)
        if (accountRateKey) auth.clearResetFailure(accountRateKey)
        hub.disconnectRoomClients(reset.user.userId, 4401, 'Password reset')
        sendJson(res, 200, {
          ok: true,
          username: reset.user.username,
        })
      } catch (err) {
        if (err?.statusCode === 503) {
          sendJson(res, 503, { ok: false, error: err.message || '服务器繁忙，请稍后重试' })
          return
        }
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Toggle optional email login 2FA for authenticated account (disabling requires currentPassword re-authentication)
    if (pathname === '/api/account/security/2fa' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
        return
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return
      }
      const ip = getClientIp(req)
      try {
        const body = await readJsonBody(req)
        const nextEnabled = Boolean(body.enabled)
        if (nextEnabled && !mailer.isConfigured()) {
          sendJson(res, 503, { ok: false, error: '服务器尚未配置邮件服务（SMTP），无法开启邮箱二次验证' })
          return
        }
        const prevUser = accounts.getUserById(payload.room)
        if (nextEnabled === false) {
          if (!auth.checkRateLimit(ip) || !auth.checkAccountRateLimit(payload.room, ip)) {
            sendJson(res, 429, { ok: false, error: '尝试次数过多，请稍后再试' })
            return
          }
          const currentPassword = String(body.currentPassword ?? '')
          if (!currentPassword) {
            sendJson(res, 403, { ok: false, error: '关闭邮箱二次验证需要验证当前密码' })
            return
          }
          const pwValid = await accounts.verifyUserPasswordAsync(payload.room, currentPassword)
          if (!pwValid) {
            auth.recordFailure(ip)
            auth.recordAccountFailure(payload.room, ip)
            sendJson(res, 403, { ok: false, error: '关闭邮箱二次验证需要验证当前密码' })
            return
          }
          auth.clearAccountFailure(payload.room, ip)
        }
        const updated = accounts.setLoginEmail2fa(payload.room, nextEnabled)
        if (!updated.ok) {
          sendJson(res, 400, { ok: false, error: updated.error })
          return
        }
        if (nextEnabled === false && prevUser?.loginEmail2fa && mailer.isConfigured() && updated.user?.email && updated.user?.emailVerified) {
          mailer
            .sendSecurityNotice({
              to: updated.user.email,
              username: updated.user.username,
              title: '邮箱登录二次验证已关闭',
              summary: '你的 All in One 账号刚刚关闭了邮箱登录二次验证（2FA）。如非本人操作，请立即修改密码、重新开启二次验证并下线所有其他设备。',
              ip,
              at: Date.now(),
            })
            .catch((err) => {
              console.warn(`[relay] Failed to send 2FA-disabled security notice for @${updated.user.username}: ${String(err?.message || err)}`)
            })
        }
        sendJson(res, 200, { ok: true, user: updated.user })
      } catch (err) {
        if (err?.statusCode === 503) {
          sendJson(res, 503, { ok: false, error: err.message || '服务器繁忙，请稍后重试' })
          return
        }
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Account mobile/web login -> room-scoped JWT bound to `usr_<id>` + optional email 2FA + new-device login alert!
    if (pathname === '/api/account/login' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const identifier = String(body.username || '').trim()
        const accountRateKey = accounts.resolveAccountKey(identifier)
        if (accountRateKey && !auth.checkAccountRateLimit(accountRateKey, ip)) {
          sendJson(res, 429, { ok: false, error: '该账号尝试登录失败过多，请 15 分钟后再试' })
          return
        }
        const verified = await accounts.authenticateUserAsync(identifier, body.password, { recordLogin: false })
        if (!verified) {
          auth.recordFailure(ip)
          if (accountRateKey) auth.recordAccountFailure(accountRateKey, ip)
          sendJson(res, 401, { ok: false, error: '账号或密码不正确' })
          return
        }
        let { user } = verified

        // Optional Email 2FA: require verified 6-digit OTP when enabled on account (fail-closed if SMTP unavailable)
        if (!(await handleOptionalEmail2fa(res, { user, emailCode: body.emailCode, ip, accountRateKey }))) {
          return
        }

        auth.clearFailure(ip)
        if (accountRateKey) auth.clearAccountFailure(accountRateKey, ip)
        user = accounts.markUserLogin(user.userId) || user
        const devInfo = parseClientDeviceInfo(body.deviceName || '', req.headers['user-agent'] || '', body.clientKind || '')
        // Coalesce login context update + recordUserSession into a single atomic save()
        const { isNewContext } = accounts.checkAndRememberLoginContext(user.userId, {
          deviceName: devInfo.deviceName,
          ip,
          clientUid: body.clientUid || '',
          skipSave: true,
        })
        const sid = auth.generateSessionId()
        const onlineSids = new Set(hub.getClientList(user.userId).map((c) => c.sid).filter(Boolean))
        const recorded = accounts.recordUserSession(user.userId, {
          sid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
          clientUid: body.clientUid || '',
          onlineSids,
        })
        for (const oldSid of recorded?.replacedSids || []) {
          hub.disconnectClient(user.userId, { sid: oldSid }, 4401, 'Replaced by new sign-in on same device')
        }
        if (isNewContext && mailer.isConfigured() && user.email && user.emailVerified && shouldSendLoginAlert(user.userId, ip)) {
          mailer
            .sendLoginAlert({
              to: user.email,
              username: user.username,
              deviceName: devInfo.deviceName,
              ip,
              at: Date.now(),
            })
            .catch((err) => {
              console.warn(`[relay] Failed to send login alert email for @${user.username}: ${String(err?.message || err)}`)
            })
        }
        hub.recordActivity({
          type: 'user.login',
          roomId: user.userId,
          label: `@${user.username}`,
          detail: devInfo.deviceName,
          ip,
        })
        const token = auth.signSessionToken(
          user.userId,
          devInfo.deviceName,
          user.userId,
          user.tokenVersion,
          { role: user.role, username: user.username, sid },
        )
        const bridges = hub.getBridgeList(user.userId)
        sendJson(res, 200, {
          ok: true,
          token,
          roomId: user.userId,
          user,
          devices: getMergedAccountDevices(user.userId, bridges),
          bridges,
        })
      } catch (err) {
        if (err?.statusCode === 503) {
          sendJson(res, 503, { ok: false, error: err.message || '服务器繁忙，请稍后重试' })
          return
        }
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // PC Bridge account login -> verifies username+password (+ optional Email 2FA) once, issues a per-PC `deviceSecret`
    if (pathname === '/api/account/device-login' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const identifier = String(body.username || '').trim()
        const accountRateKey = accounts.resolveAccountKey(identifier)
        if (accountRateKey && !auth.checkAccountRateLimit(accountRateKey, ip)) {
          sendJson(res, 429, { ok: false, error: '该账号尝试登录失败过多，请 15 分钟后再试' })
          return
        }
        const verified = await accounts.authenticateUserAsync(identifier, body.password, { recordLogin: false })
        if (!verified) {
          auth.recordFailure(ip)
          if (accountRateKey) auth.recordAccountFailure(accountRateKey, ip)
          sendJson(res, 401, { ok: false, error: '账号或密码不正确' })
          return
        }
        const { user } = verified

        // Enforce the same Email 2FA verification when enabled on account (fail-closed if SMTP unavailable)
        if (!(await handleOptionalEmail2fa(res, { user, emailCode: body.emailCode, ip, accountRateKey }))) {
          return
        }

        auth.clearFailure(ip)
        if (accountRateKey) auth.clearAccountFailure(accountRateKey, ip)
        let bound
        try {
          bound = accounts.bindDevice({
            userId: user.userId,
            label: body.label || body.hostname || 'My PC',
            hostname: body.hostname || body.label || 'My-PC',
            platform: body.platform || 'unknown',
            bridgeId: body.bridgeId || '',
          })
        } catch (bindErr) {
          sendJson(res, 400, { ok: false, error: String(bindErr?.message || '绑定电脑失败') })
          return
        }
        if (!bound) {
          sendJson(res, 404, { ok: false, error: '账号不存在' })
          return
        }
        accounts.markUserLogin(user.userId)
        const deviceLabel = bound.label || bound.hostname || 'My PC'
        const { isNewContext } = accounts.checkAndRememberLoginContext(user.userId, {
          deviceName: deviceLabel,
          ip,
        })
        if (isNewContext && mailer.isConfigured() && user.email && user.emailVerified && shouldSendLoginAlert(user.userId, ip)) {
          mailer
            .sendLoginAlert({
              to: user.email,
              username: user.username,
              deviceName: deviceLabel,
              ip,
              at: Date.now(),
            })
            .catch((err) => {
              console.warn(`[relay] Failed to send device-login alert email for @${user.username}: ${String(err?.message || err)}`)
            })
        }
        hub.recordActivity({
          type: 'user.login',
          roomId: user.userId,
          label: `@${user.username}`,
          detail: `PC bind: ${deviceLabel}`,
          ip,
        })
        hub.broadcastRoomDevices(user.userId)
        sendJson(res, 200, { ok: true, ...bound })
      } catch (err) {
        if (err?.statusCode === 503) {
          sendJson(res, 503, { ok: false, error: err.message || '服务器繁忙，请稍后重试' })
          return
        }
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Bridge-authenticated device status check (lets PC CLI verify binding & list sibling PCs in the same account)
    if (pathname === '/api/account/device-status' && req.method === 'GET') {
      const ip = getClientIp(req)
      const requestedRoom = String(req.headers['x-room-id'] || urlObj.searchParams.get('roomId') || '').trim()
      if (!auth.checkBridgeRateLimit(ip) || (requestedRoom && !auth.checkBridgeRateLimit(ip, requestedRoom))) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return
      }
      const info = authenticateBridgeInfo(req, urlObj)
      if (!info || !info.roomId.startsWith('usr_')) {
        auth.recordBridgeFailure(ip)
        if (requestedRoom) auth.recordBridgeFailure(ip, requestedRoom)
        sendJson(res, 401, { ok: false, error: '电脑绑定凭证无效或已被解绑' })
        return
      }
      auth.clearBridgeFailure(ip)
      if (requestedRoom) auth.clearBridgeFailure(ip, requestedRoom)
      sendJson(res, 200, {
        ok: true,
        userId: info.userId,
        username: info.username,
        deviceId: info.deviceId,
        bridgeId: info.bridgeId,
        label: info.label,
        devices: getMergedAccountDevices(info.roomId),
      })
      return
    }

    // List all bound PCs for the authenticated account
    if (pathname === '/api/account/devices' && req.method === 'GET') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        devices: getMergedAccountDevices(payload.room),
        bridges: hub.getBridgeList(payload.room),
      })
      return
    }

    // Register / bind this PC using an already-authenticated account JWT (used by Desktop App for 1-click auto-bind!)
    if (pathname === '/api/account/devices/register' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
        return
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const bound = accounts.bindDevice({
          userId: payload.room,
          label: body.label || body.hostname || 'My PC',
          hostname: body.hostname || body.label || 'My-PC',
          platform: body.platform || 'unknown',
          bridgeId: body.bridgeId || '',
        })
        if (!bound) {
          sendJson(res, 404, { ok: false, error: '账号不存在' })
          return
        }
        hub.broadcastRoomDevices(payload.room)
        sendJson(res, 200, {
          ok: true,
          ...bound,
          devices: getMergedAccountDevices(payload.room),
        })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err?.message || '绑定电脑失败') })
      }
      return
    }

    // Rename a bound PC inside the authenticated user's account
    if (pathname === '/api/account/devices/rename' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const updated = accounts.renameUserDevice(payload.room, body.deviceId, body.label)
        if (!updated) {
          sendJson(res, 404, { ok: false, error: '找不到目标电脑或名称为空' })
          return
        }
        hub.updateBridgeLabel(payload.room, updated.bridgeId, updated.label)
        hub.broadcastRoomDevices(payload.room)
        sendJson(res, 200, {
          ok: true,
          device: updated,
          devices: getMergedAccountDevices(payload.room),
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Unbind a PC from the authenticated user's account (immediately kicks its WS bridge and revokes its deviceSecret)
    if (pathname === '/api/account/devices/remove' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const removed = accounts.removeUserDevice(payload.room, body.deviceId)
        if (!removed) {
          sendJson(res, 404, { ok: false, error: '找不到目标电脑' })
          return
        }
        hub.disconnectBridge(payload.room, removed.bridgeId, 4401, 'Device unbound')
        hub.broadcastRoomDevices(payload.room)
        sendJson(res, 200, {
          ok: true,
          removed,
          devices: getMergedAccountDevices(payload.room),
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Change account password (rate-limited, non-blocking scrypt, kicks OTHER clients while keeping caller connected)
    if (pathname === '/api/account/password' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      const bearerToken = extractBearer(req)
      const payload = auth.verifySessionToken(bearerToken)
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      if (!auth.checkAccountRateLimit(payload.room, ip)) {
        sendJson(res, 429, { ok: false, error: '该账号尝试次数过多，请 15 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        if (!auth.checkRateLimit(ip)) {
          sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
          return
        }
        if (!auth.checkAccountRateLimit(payload.room, ip)) {
          sendJson(res, 429, { ok: false, error: '该账号尝试次数过多，请 15 分钟后再试' })
          return
        }
        if (!auth.verifySessionToken(bearerToken)) {
          sendJson(res, 401, { ok: false, error: '会话已失效或密码已被更新，请重新登录' })
          return
        }
        const changed = await accounts.changePasswordAsync(
          payload.room,
          body.currentPassword,
          body.newPassword,
          { validateSession: () => Boolean(auth.verifySessionToken(bearerToken)) },
        )
        if (!changed.ok) {
          if (changed.code === 'stale_session') {
            sendJson(res, 401, { ok: false, error: changed.error })
            return
          }
          if (changed.error === '当前密码不正确') {
            auth.recordFailure(ip)
            auth.recordAccountFailure(payload.room, ip)
          }
          sendJson(res, 400, { ok: false, error: changed.error })
          return
        }
        auth.clearFailure(ip)
        auth.clearAccountFailure(payload.room, ip)
        const currentClientId = String(body.currentClientId || '').trim()
        const devInfo = parseClientDeviceInfo(
          body.deviceName || payload.dev || '',
          req.headers['user-agent'] || '',
          body.clientKind || '',
        )
        const newSid = auth.generateSessionId()
        accounts.recordUserSession(changed.user.userId, {
          sid: newSid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
          clientUid: body.clientUid || '',
        })
        hub.disconnectOtherRoomClients(
          payload.room,
          { keepClientId: currentClientId, keepSid: payload.sid || '', newSidForKept: newSid },
          4401,
          'Password changed',
        )
        const freshToken = auth.signSessionToken(
          changed.user.userId,
          devInfo.deviceName,
          changed.user.userId,
          changed.user.tokenVersion,
          { role: changed.user.role, username: changed.user.username, sid: newSid },
        )
        sendJson(res, 200, { ok: true, token: freshToken, user: changed.user })
      } catch (err) {
        if (err?.statusCode === 503) {
          sendJson(res, 503, { ok: false, error: err.message || '服务器繁忙，请稍后重试' })
          return
        }
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Admin Monitor: On-demand full server & all-users status snapshot (zero idle overhead)
    if (pathname === '/api/admin/overview' && req.method === 'GET') {
      const payload = requireAdmin(req, res)
      if (!payload) return
      const dailyRegistration = accounts.getDailyRegistrationStats(maxDailyRegistrations)
      const serverHealth = collectServerHealth({
        mailer,
        stun: stunServer?.getStats?.() || null,
        turn: {
          enabled: Boolean((turnSecret && extractPublicHostname(req)) || cfTurn.enabled),
          host: extractPublicHostname(req) || '',
          port: turnSecret ? turnPort : 0,
          ttlSec: turnTtlSec,
          meteringEnabled: Boolean(turnLogFile),
          cloudflare: cfTurn.getStats(),
          quotas: {
            freeMb: turnQuotaConfig.freeMb,
            proMb: turnQuotaConfig.proMb,
            ultraMb: turnQuotaConfig.ultraMb,
            adminMb: turnQuotaConfig.adminMb,
          },
        },
        dailyRegistration,
        startedAt,
        version: RELAY_VERSION,
      })
      const overview = buildAdminOverview({
        accounts,
        hub,
        serverHealth,
        dailyRegistration,
        getTurnQuota: (uid) => buildUserTurnQuota(uid),
        currentAdminRoom: payload.room || '',
        currentAdminSid: payload.sid || '',
      })
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, overview)
      return
    }

    // Admin: Update a user's tier (`free` / `pro` / `ultra` / `admin`; `ultra` and `admin` share identical TURN quota rules)
    if (pathname === '/api/admin/users/set-tier' && req.method === 'POST') {
      const payload = requireAdmin(req, res)
      if (!payload) return
      try {
        const body = await readJsonBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        const targetTier = String(body.tier || '').trim().toLowerCase()
        if (!targetRoom.startsWith('usr_') || !targetTier) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户或等级参数' })
          return
        }
        const changed = accounts.setUserTier(targetRoom, targetTier, { actorUserId: payload.room })
        if (!changed.ok) {
          sendJson(res, 400, { ok: false, error: changed.error })
          return
        }
        const turnQuota = buildUserTurnQuota(targetRoom)
        hub.pushIceUpdate(targetRoom, { quotaExceeded: Boolean(turnQuota?.exceeded) })
        hub.recordActivity({
          type: 'admin.tier',
          roomId: targetRoom,
          label: `@${changed.user.username}`,
          detail: `${String(changed.prevTier || 'free').toUpperCase()} -> ${String(changed.tier).toUpperCase()}`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, user: changed.user, tier: changed.tier, turnQuota })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Admin: Reset a user's current-month TURN relay usage to 0 bytes
    if (pathname === '/api/admin/users/reset-turn-usage' && req.method === 'POST') {
      const payload = requireAdmin(req, res)
      if (!payload) return
      try {
        const body = await readJsonBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        if (!targetRoom.startsWith('usr_')) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户标识' })
          return
        }
        const reset = accounts.resetTurnUsage(targetRoom)
        if (!reset.ok) {
          sendJson(res, 404, { ok: false, error: reset.error })
          return
        }
        const turnQuota = buildUserTurnQuota(targetRoom)
        hub.pushIceUpdate(targetRoom, { quotaExceeded: false })
        hub.recordActivity({
          type: 'admin.quota_reset',
          roomId: targetRoom,
          label: `@${reset.user.username}`,
          detail: `Monthly TURN usage reset (${reset.turnUsage.month})`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, user: reset.user, turnQuota })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Admin Monitor: Kick / revoke a single client session for any user
    if (pathname === '/api/admin/users/kick-session' && req.method === 'POST') {
      const payload = requireAdmin(req, res)
      if (!payload) return
      try {
        const body = await readJsonBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        const targetSid = String(body.sid || '').trim()
        const targetClientId = String(body.clientId || '').trim()
        if (!targetRoom.startsWith('usr_') || (!targetSid && !targetClientId)) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户或会话标识' })
          return
        }
        if (targetRoom === payload.room && targetSid && payload.sid && targetSid === payload.sid) {
          sendJson(res, 400, { ok: false, error: '不能踢出当前正在使用的管理员会话' })
          return
        }
        const revokedPermanent = targetSid ? accounts.revokeUserSession(targetRoom, targetSid) : false
        const kickedConnections = hub.disconnectClient(
          targetRoom,
          { clientId: targetClientId, sid: targetSid },
          4401,
          'Session revoked by admin',
        )
        const targetUser = accounts.getUserById(targetRoom)
        hub.recordActivity({
          type: 'admin.kick',
          roomId: targetRoom,
          label: targetUser ? `@${targetUser.username}` : targetRoom,
          detail: `Admin revoked session (${kickedConnections} live)`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, revokedPermanent, kickedConnections })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Admin Monitor: Force sign-out ALL sessions for a user
    if (pathname === '/api/admin/users/revoke-all' && req.method === 'POST') {
      const payload = requireAdmin(req, res)
      if (!payload) return
      try {
        const body = await readJsonBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        if (!targetRoom.startsWith('usr_')) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户标识' })
          return
        }
        if (targetRoom === payload.room) {
          sendJson(res, 400, { ok: false, error: '不能在监控面板强制下线当前管理员自身' })
          return
        }
        const revoked = accounts.revokeUserTokens(targetRoom)
        if (!revoked) {
          sendJson(res, 404, { ok: false, error: '找不到目标用户' })
          return
        }
        const disconnectedClients = hub.disconnectRoomClients(targetRoom, 4401, 'All sessions revoked by admin')
        const targetUser = accounts.getUserById(targetRoom)
        hub.recordActivity({
          type: 'admin.kick',
          roomId: targetRoom,
          label: targetUser ? `@${targetUser.username}` : targetRoom,
          detail: `Admin signed out all terminals (${disconnectedClients} live)`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, {
          ok: true,
          roomId: revoked.roomId,
          tokenVersion: revoked.tokenVersion,
          disconnectedClients,
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Admin Monitor: Soft-disconnect a live PC bridge WebSocket (non-destructive; keeps device bound)
    if (pathname === '/api/admin/bridges/disconnect' && req.method === 'POST') {
      const payload = requireAdmin(req, res)
      if (!payload) return
      try {
        const body = await readJsonBody(req)
        const targetRoom = String(body.roomId || body.userId || '').trim()
        const targetBridgeId = String(body.bridgeId || '').trim()
        if (!targetRoom.startsWith('usr_') || !targetBridgeId) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户或桥接标识' })
          return
        }
        const disconnected = hub.disconnectBridge(targetRoom, targetBridgeId, 4000, 'Disconnected by admin')
        if (!disconnected) {
          sendJson(res, 404, { ok: false, error: '该电脑桥接当前不在线' })
          return
        }
        const targetUser = accounts.getUserById(targetRoom)
        hub.recordActivity({
          type: 'admin.kick',
          roomId: targetRoom,
          label: targetUser ? `@${targetUser.username}` : targetRoom,
          detail: `Admin disconnected bridge ${targetBridgeId}`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, disconnected })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Issue a 30-second single-use WebSocket handshake ticket so master 30-day JWT never appears in WS URLs/logs
    if (pathname === '/api/auth/ws-ticket' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      if (!checkUserActionRateLimit('ws-ticket', payload.room, 120)) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return
      }
      let body = {}
      try {
        body = await readJsonBody(req, 16 * 1024)
      } catch {
        body = {}
      }
      const devInfo = parseClientDeviceInfo(
        body?.deviceName || payload.dev || '',
        req.headers['user-agent'] || '',
        body?.clientKind || '',
      )
      const onlineSids = new Set(hub.getClientList(payload.room).map((c) => c.sid).filter(Boolean))
      accounts.touchUserSession(payload.room, payload.sid, {
        deviceName: devInfo.deviceName,
        clientKind: devInfo.clientKind,
        ip: getClientIp(req),
        clientUid: body?.clientUid || '',
        onlineSids,
      })
      const { ticket, expiresAt } = auth.issueWsTicket(payload, {
        deviceName: devInfo.deviceName,
        clientKind: devInfo.clientKind,
      })
      sendJson(res, 200, { ok: true, ticket, expiresAt })
      return
    }

    // List all active & logged-in controlling devices (phones, desktops, browsers) for security auditing
    if (pathname === '/api/auth/sessions' && req.method === 'GET') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      const currentClientId = String(urlObj.searchParams.get('clientId') || '').trim()
      const merged = getMergedClientSessions(payload.room, {
        currentSid: payload.sid || '',
        currentClientId,
      })
      sendJson(res, 200, {
        ok: true,
        roomId: payload.room,
        currentSid: payload.sid || '',
        ...merged,
      })
      return
    }

    // Sign out current session (permanently revokes caller's `sid` without kicking other devices)
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      const revokedPermanent = payload.sid ? accounts.revokeUserSession(payload.room, payload.sid) : false
      const kickedConnections = payload.sid
        ? hub.disconnectClient(payload.room, { sid: payload.sid }, 4401, 'Signed out')
        : 0
      sendJson(res, 200, { ok: true, revokedPermanent, kickedConnections })
      return
    }

    // Kick / revoke a single logged-in client device (by `sid` or live `clientId`)
    if (pathname === '/api/auth/sessions/revoke' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const targetSid = String(body.sid || '').trim()
        const targetClientId = String(body.clientId || '').trim()
        const currentClientId = String(body.currentClientId || '').trim()
        if (!targetSid && !targetClientId) {
          sendJson(res, 400, { ok: false, error: '缺少目标会话标识' })
          return
        }
        if (targetSid) {
          const liveMatch = hub.getClientList(payload.room).some((c) => c.sid === targetSid)
          const knownSid = accounts.hasUserSession(payload.room, targetSid) || liveMatch
          // Reject unknown/synthetic sids so attackers cannot bloat accounts.json
          if (targetSid.length > 64 || !knownSid) {
            sendJson(res, 404, { ok: false, error: '目标会话不存在或已失效' })
            return
          }
        }
        if ((targetSid && payload.sid && targetSid === payload.sid) || (targetClientId && currentClientId && targetClientId === currentClientId)) {
          sendJson(res, 400, { ok: false, error: '不能踢出当前本机设备，如需退出请使用退出登录' })
          return
        }
        const revokedPermanent = targetSid ? accounts.revokeUserSession(payload.room, targetSid) : false
        const kickedConnections = hub.disconnectClient(
          payload.room,
          { clientId: targetClientId, sid: targetSid },
          4401,
          'Session revoked by user',
        )
        const merged = getMergedClientSessions(payload.room, {
          currentSid: payload.sid || '',
          currentClientId,
        })
        sendJson(res, 200, {
          ok: true,
          revokedPermanent,
          kickedConnections,
          ...merged,
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Revoke EVERY other device/token while keeping caller logged in with a fresh rotated JWT
    if (pathname === '/api/auth/sessions/revoke-others' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const currentClientId = String(body.currentClientId || '').trim()
        const targetRoom = payload.room
        const ip = getClientIp(req)
        const devInfo = parseClientDeviceInfo(
          body.deviceName || payload.dev || '',
          req.headers['user-agent'] || '',
          body.clientKind || '',
        )
        const revoked = accounts.revokeUserTokens(targetRoom)
        if (!revoked) {
          sendJson(res, 404, { ok: false, error: '账号不存在' })
          return
        }
        const newSid = auth.generateSessionId()
        const acctUser = accounts.getUserById(targetRoom)
        accounts.recordUserSession(targetRoom, {
          sid: newSid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
          clientUid: body.clientUid || '',
        })
        const freshToken = auth.signSessionToken(
          targetRoom,
          devInfo.deviceName,
          targetRoom,
          revoked.tokenVersion,
          { role: acctUser?.role || payload.role || 'user', username: acctUser?.username || payload.uname || '', sid: newSid },
        )
        const kickedConnections = hub.disconnectOtherRoomClients(
          targetRoom,
          { keepClientId: currentClientId, keepSid: payload.sid || '', newSidForKept: newSid },
          4401,
          'Signed out from another device',
        )
        const merged = getMergedClientSessions(targetRoom, {
          currentSid: newSid,
          currentClientId,
        })
        sendJson(res, 200, {
          ok: true,
          token: freshToken,
          sid: newSid,
          tokenVersion: revoked.tokenVersion,
          kickedConnections,
          ...merged,
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Revoke ALL active sessions for the authenticated account (including current terminal)
    if (pathname === '/api/auth/sessions/revoke-all' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      if (!checkUserActionRateLimit('write', payload.room, 60)) {
        sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' })
        return
      }
      const revoked = accounts.revokeUserTokens(payload.room)
      if (!revoked) {
        sendJson(res, 404, { ok: false, error: '账号不存在' })
        return
      }
      const disconnectedClients = hub.disconnectRoomClients(payload.room, 4401, 'All sessions revoked')
      sendJson(res, 200, {
        ok: true,
        roomId: revoked.roomId,
        tokenVersion: revoked.tokenVersion,
        disconnectedClients,
      })
      return
    }

    // Verify existing session token
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      if (!checkUserActionRateLimit('me', payload.room, 120)) {
        sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
        return
      }
      const acctUser = accounts.getUserById(payload.room)
      if (!acctUser) {
        sendJson(res, 401, { ok: false, error: '账号不存在' })
        return
      }
      const bridges = hub.getBridgeList(payload.room)
      const clientSessions = getMergedClientSessions(payload.room, { currentSid: payload.sid || '' })
      sendJson(res, 200, {
        ok: true,
        user: { ...payload, role: acctUser.role, tier: acctUser.tier },
        roomId: payload.room,
        username: acctUser.username,
        email: acctUser.email || '',
        emailVerified: Boolean(acctUser.emailVerified),
        loginEmail2fa: Boolean(acctUser.loginEmail2fa),
        emailEnabled: mailer.isConfigured(),
        role: acctUser.role,
        tier: acctUser.tier,
        turnQuota: buildUserTurnQuota(payload.room),
        mode: 'p2p-only',
        iceServers: resolveIceServers(req, payload.room),
        label: `@${acctUser.username}`,
        devices: getMergedAccountDevices(payload.room, bridges),
        bridges,
        clientSessions,
      })
      return
    }

    // Standalone lightweight Admin Monitoring Dashboard (/admin, zero-dependency, on-demand)
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/'))) {
      const adminFiles = {
        '/admin': 'index.html',
        '/admin/': 'index.html',
        '/admin/index.html': 'index.html',
        '/admin/styles.css': 'styles.css',
        '/admin/app.js': 'app.js',
      }
      const mapped = adminFiles[pathname]
      const adminTarget = mapped ? join(ADMIN_DASHBOARD_DIR, mapped) : ''
      if (adminTarget) {
        try {
          if (statSync(adminTarget).isFile()) {
            const ext = extname(adminTarget).toLowerCase()
            let buf = readFileSync(adminTarget)
            if (ext === '.html' && pathname === '/admin') {
              // Keep asset & back-to-app links subpath-safe when accessed without trailing slash (e.g. /subpath/admin)
              const html = buf
                .toString('utf8')
                .replaceAll('href="./styles.css"', 'href="admin/styles.css"')
                .replaceAll('src="./app.js"', 'src="admin/app.js"')
                .replaceAll('href="../"', 'href="./"')
              buf = Buffer.from(html, 'utf8')
            }
            const headers = {
              'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
              'Content-Length': buf.length,
              'Cache-Control': 'no-cache, no-store, must-revalidate',
            }
            if (ext === '.html') {
              headers['Content-Security-Policy'] =
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
            }
            res.writeHead(200, headers)
            if (req.method === 'HEAD') res.end()
            else res.end(buf)
            return
          }
        } catch {}
      }
      sendJson(res, 404, { ok: false, error: 'Not Found' })
      return
    }

    // Static PWA, installer scripts (.ps1/.sh/.mjs), & APK serving
    if ((req.method === 'GET' || req.method === 'HEAD') && existsSync(staticDir)) {
      let decodedPathname = pathname
      try {
        decodedPathname = decodeURIComponent(pathname)
      } catch {
        sendJson(res, 400, { ok: false, error: 'Bad Request' })
        return
      }
      if (decodedPathname.includes('\0')) {
        sendJson(res, 400, { ok: false, error: 'Bad Request' })
        return
      }
      const rel = decodedPathname === '/' ? 'index.html' : decodedPathname.replace(/^\/+/, '')
      const candidate = resolve(staticDir, normalize(rel))
      let target = null
      const withinStaticDir = candidate === staticDir || candidate.startsWith(`${staticDir}${sep}`)
      if (withinStaticDir) {
        try {
          if (statSync(candidate).isFile()) target = candidate
        } catch {}
      }
      if (!target && !decodedPathname.startsWith('/api/') && !decodedPathname.startsWith('/ws/') && !decodedPathname.startsWith('/downloads/') && !decodedPathname.startsWith('/admin')) {
        const indexHtml = join(staticDir, 'index.html')
        try {
          if (statSync(indexHtml).isFile()) target = indexHtml
        } catch {}
      }
      if (target) {
        try {
          const ext = extname(target).toLowerCase()
          const isMutable =
            ext === '.html' ||
            ext === '.ps1' ||
            ext === '.sh' ||
            ext === '.mjs' ||
            target.endsWith('sw.js') ||
            target.endsWith('registerSW.js') ||
            target.endsWith('manifest.webmanifest') ||
            target.endsWith('All-in-One-WebBundle.json') ||
            target.endsWith('All-in-One-WebBundle.zip')

          // Dynamically inject this server's strictly validated public URL into setup.ps1 / setup.sh
          if (ext === '.ps1' || ext === '.sh') {
            const effectiveUrl = resolveSafePublicScriptUrl(req, publicRelayUrl, isTrustedProxy)
            let scriptBody = readFileSync(target, 'utf8')
            if (effectiveUrl) {
              scriptBody = scriptBody.replaceAll('https://your-relay.example.com', effectiveUrl)
            }
            const buf = Buffer.from(scriptBody, 'utf8')
            res.writeHead(200, {
              'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8',
              'Content-Length': buf.length,
              'Cache-Control': 'no-cache, no-store, must-revalidate',
            })
            if (req.method === 'HEAD') res.end()
            else res.end(buf)
            return
          }

          const st = statSync(target)
          const staticHeaders = {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Content-Length': st.size,
            'Cache-Control': isMutable ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
          }
          if (ext === '.html') {
            const isSandboxPreview = basename(target).toLowerCase() === 'sandbox-preview.html'
            staticHeaders['Content-Security-Policy'] = isSandboxPreview ? SANDBOX_PREVIEW_CSP : APP_HTML_CSP
            if (isSandboxPreview) {
              staticHeaders['X-Frame-Options'] = 'SAMEORIGIN'
            }
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, staticHeaders)
            res.end()
            return
          }

          const stream = createReadStream(target)
          stream.on('open', () => {
            if (!res.headersSent) {
              res.writeHead(200, staticHeaders)
            }
            stream.pipe(res)
          })
          stream.on('error', () => {
            if (!res.headersSent) {
              sendJson(res, 404, { ok: false, error: 'Not Found' })
            } else {
              try { res.destroy() } catch {}
            }
          })
          res.on('close', () => {
            if (!stream.destroyed) stream.destroy()
          })
          return
        } catch {
          sendJson(res, 404, { ok: false, error: 'Not Found' })
          return
        }
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' })
    } catch (err) {
      console.error('[relay] Unhandled HTTP request error:', err?.stack || err)
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { ok: false, error: 'Internal Server Error' })
        } catch {}
      } else {
        try { res.end() } catch {}
      }
    }
  })

  // Tight HTTP timeouts to mitigate Slowloris & stalled-request resource exhaustion
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.keepAliveTimeout = 60_000

  // Pure Control-Plane WebSocket server (strictly capped at 256 KB — zero data-plane relay)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  wss.on('error', (err) => {
    console.warn('[control] WebSocketServer error:', err?.message || err)
  })

  server.on('upgrade', (req, socket, head) => {
    const onUpgradeSocketError = () => {
      try { socket.destroy() } catch {}
    }
    socket.on('error', onUpgradeSocketError)

    const rejectUpgrade = (statusLine) => {
      try {
        if (!socket.destroyed && socket.writable) {
          socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`)
        }
      } catch {}
      try { socket.destroy() } catch {}
    }

    let urlObj
    try {
      urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      rejectUpgrade('400 Bad Request')
      return
    }
    const pathname = urlObj.pathname

    if (pathname === '/ws/bridge') {
      const bridgeIp = getClientIp(req)
      const requestedRoom = String(
        req.headers['x-room-id'] || urlObj.searchParams.get('roomId') || '',
      ).trim()
      if (!requestedRoom.startsWith('usr_')) {
        rejectUpgrade('401 Unauthorized')
        return
      }
      if (!auth.checkBridgeRateLimit(bridgeIp, requestedRoom)) {
        rejectUpgrade('429 Too Many Requests')
        return
      }
      const bridgeAuth = authenticateBridgeInfo(req, urlObj)
      if (!bridgeAuth) {
        auth.recordBridgeFailure(bridgeIp, requestedRoom)
        rejectUpgrade('401 Unauthorized')
        return
      }
      auth.clearBridgeFailure(bridgeIp, requestedRoom)
      const slot = tryAcquireWsSlot(bridgeIp)
      if (!slot.ok) {
        rejectUpgrade(slot.statusLine)
        return
      }
      socket.once('close', slot.release)
      const rawInitialKeyId = String(
        req.headers['x-e2ee-key-id'] || urlObj.searchParams.get('e2eeKeyId') || '',
      ).trim()
      const initialKeyId = /^[0-9a-f]{16}$/i.test(rawInitialKeyId) ? rawInitialKeyId.toLowerCase() : ''
      const meta = {
        roomId: bridgeAuth.roomId,
        bridgeId: String(bridgeAuth.bridgeId || urlObj.searchParams.get('bridgeId') || 'home-pc').trim().slice(0, 64) || 'home-pc',
        deviceId: String(bridgeAuth.deviceId || '').trim().slice(0, 64),
        label: String(bridgeAuth.label || '').trim().slice(0, 64),
        hostname: String(urlObj.searchParams.get('hostname') || bridgeAuth.hostname || 'PC').trim().slice(0, 64) || 'PC',
        platform: String(urlObj.searchParams.get('platform') || bridgeAuth.platform || 'win32').trim().slice(0, 32) || 'win32',
        mode: String(urlObj.searchParams.get('mode') || 'desktop').trim().slice(0, 32) || 'desktop',
        ...(initialKeyId ? { e2ee: { enabled: true, v: 1, keyId: initialKeyId } } : {}),
        ip: bridgeIp,
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        socket.removeListener('error', onUpgradeSocketError)
        ws.once('close', slot.release)
        hub.registerBridge(ws, meta, { req })
      })
      return
    }

    if (pathname === '/ws/client') {
      // Block cross-site WebSocket hijacking (CSWSH) from untrusted third-party web origins
      if (req.headers.origin && !isAllowedOrigin(req.headers.origin, req)) {
        rejectUpgrade('403 Forbidden')
        return
      }
      const clientIp = getClientIp(req)
      const slot = tryAcquireWsSlot(clientIp)
      if (!slot.ok) {
        rejectUpgrade(slot.statusLine)
        return
      }
      // Strictly require a single-use 30s ws-ticket (never accept master JWTs in URLs)
      const ticket = String(urlObj.searchParams.get('ticket') || '').trim()
      const user = ticket ? auth.consumeWsTicket(ticket) : null
      if (!user) {
        slot.release()
        rejectUpgrade('401 Unauthorized')
        return
      }
      socket.once('close', slot.release)
      const clientUa = String(req.headers['user-agent'] || '')
      const devInfo = parseClientDeviceInfo(user.dev || '', clientUa, user.kind || '')
      try {
        accounts.touchUserSession(user.room, user.sid, {
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip: clientIp,
        })
      } catch (err) {
        console.warn('[control] Failed to persist touchUserSession on WS upgrade:', err?.message || err)
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        socket.removeListener('error', onUpgradeSocketError)
        ws.once('close', slot.release)
        hub.registerClient(ws, user, { ip: clientIp, userAgent: clientUa, req })
      })
      return
    }

    rejectUpgrade('404 Not Found')
  })

  const start = async () => {
    let stunInfo = { enabled: false, port: 0 }
    if (stunServer) {
      try {
        const bound = await stunServer.start()
        stunInfo = { enabled: true, port: bound.port }
      } catch (err) {
        console.warn(`[stun] Could not bind UDP ${stunPort} (${err?.message || err}); continuing with public STUN fallbacks`)
      }
    }
    if (cfTurn.enabled) {
      await cfTurn.refresh()
      cfTurn.start()
    }
    try {
      return await new Promise((resolveStart, rejectStart) => {
        const onListenError = (err) => {
          server.removeListener('listening', onListening)
          rejectStart(err)
        }
        const onListening = () => {
          server.removeListener('error', onListenError)
          const addr = server.address()
          const boundPort = typeof addr === 'object' && addr ? addr.port : port
          console.log(`[control] AllinOne Control Server (v${RELAY_VERSION}, pure P2P signaling) listening on http://${host}:${boundPort}`)
          if (stunInfo.enabled) {
            console.log(`[stun] Stateless RFC 5389 STUN listening on udp://${stunHost}:${stunInfo.port}`)
          }
          const turnPublicHost = extractPublicHostname(null)
          if (turnSecret && turnPublicHost) {
            console.log(
              `[turn] Dynamic HMAC-SHA1 TURN enabled (turn:${turnPublicHost}:${turnPort} udp+tcp, ttl=${turnTtlSec}s, quotas: free=${turnQuotaConfig.freeMb}MB pro=${turnQuotaConfig.proMb}MB ultra/admin=${turnQuotaConfig.ultraMb}MB)`,
            )
          }
          if (cfTurn.enabled) {
            const cfSt = cfTurn.getStats()
            console.log(
              `[cf-turn] Tiered Cloudflare Realtime TURN enabled (tiers=${cfSt.tiers.join(',')}, ttl=${cfSt.ttlSec}s, status=${cfSt.ready ? 'ready' : 'warming'})`,
            )
          }
          if (turnMeter) {
            turnMeter.start()
            console.log(`[turn-meter] Watching coturn accounting log: ${turnLogFile}`)
          }
          console.log(`[control] Admin Monitor Dashboard: ${publicRelayUrl ? `${publicRelayUrl}/admin` : `http://${host}:${boundPort}/admin`}`)
          console.log(`[control] Static PWA dir: ${staticDir} (${existsSync(staticDir) ? 'ready' : 'not built yet'})`)
          console.log(`[control] Registration: Open registration (daily limit: ${maxDailyRegistrations || 'unlimited'})`)
          console.log(`[control] Email verification: ${mailer.isConfigured() ? mailer.getProvider() : 'disabled (configure SMTP_* or RESEND_API_KEY to enable)'}`)
          if (jwtSecret.length < 16) {
            console.warn('[control] WARNING: JWT_SECRET is not set — using an ephemeral random signing key. Set JWT_SECRET (>= 16 chars) in .env before deploying publicly.')
          }
          resolveStart({ port: boundPort, host, stunPort: stunInfo.port })
        }
        server.once('error', onListenError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
    } catch (err) {
      cfTurn.stop()
      turnMeter?.stop?.()
      hub.shutdown()
      if (stunServer) {
        try { await stunServer.close() } catch {}
      }
      throw err
    }
  }

  let closePromise = null
  const close = async () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      cfTurn.stop()
      turnMeter?.stop?.()
      accounts.flush()
      hub.shutdown()
      if (stunServer) {
        try { await stunServer.close() } catch {}
      }
      await new Promise((resolveClose) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(forceTimer)
          resolveClose()
        }
        const forceTimer = setTimeout(() => {
          try { server.closeAllConnections?.() } catch {}
          done()
        }, 5000)
        forceTimer.unref?.()
        wss.close(() => {
          try { server.closeIdleConnections?.() } catch {}
          server.close(() => done())
        })
      })
    })()
    return closePromise
  }

  return { server, wss, hub, accounts, mailer, stunServer, turnMeter, cfTurn, recordTurnUsageBytes, start, close }
}

// Run directly when invoked as main script
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const app = createRelayServer()
  app.start().catch((err) => {
    console.error(`[control] Failed to start server: ${err?.stack || err}`)
    process.exit(1)
  })
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    app.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
