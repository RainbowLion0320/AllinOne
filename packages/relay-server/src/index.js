import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { RPC } from '@allinone/shared'
import { createAuthManager } from './auth.js'
import { createAccountStore, validateEmail, validatePassword } from './accounts.js'
import { createEmailCodeStore } from './emailCodes.js'
import { createMailer } from './mailer.js'
import { RelayHub, parseClientDeviceInfo } from './hub.js'
import { createRoomStore } from './rooms.js'
import { buildAdminOverview, collectServerHealth } from './admin-monitor.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ADMIN_DASHBOARD_DIR = resolve(__dirname, './admin')
const RELAY_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'))
    return String(pkg?.version || '0.3.9')
  } catch {
    return '0.3.9'
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

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024 // 15MB per file
const MAX_TOTAL_UPLOAD_BYTES = 256 * 1024 * 1024 // 256MB total temp upload quota
const MAX_ROOM_UPLOAD_BYTES = 64 * 1024 * 1024 // 64MB per-room temp upload quota
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours
const UPLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes
const APP_HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' https: http: ws: wss:; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

function parseEnvBool(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const lower = String(raw).trim().toLowerCase()
  if (lower === '1' || lower === 'true' || lower === 'yes') return true
  if (lower === '0' || lower === 'false' || lower === 'no') return false
  return fallback
}

function maskEmailAddress(email) {
  const clean = String(email || '').trim()
  const at = clean.indexOf('@')
  if (at <= 0) return clean
  const local = clean.slice(0, at)
  const domain = clean.slice(at)
  const prefix = local.slice(0, Math.min(2, local.length))
  return `${prefix}***${domain}`
}
const SAFE_INLINE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
])

const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const CAPACITOR_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
  'http://localhost',
  'app://allinone',
])

function isTrustedProxyAddr(rawAddr) {
  let addr = String(rawAddr || '').trim().toLowerCase()
  if (!addr) return false
  if (addr.startsWith('::ffff:')) addr = addr.slice(7)
  if (addr === '127.0.0.1' || addr === '::1') return true
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
  })
  res.end(body)
}

function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // Allow self camera so built-in QR scanner continues to work cleanly in PWA/WebView
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  if (forwardedProto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

export function createRelayServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 8787)
  const host = String(options.host ?? process.env.HOST ?? '0.0.0.0')
  const clientAccessToken = String(options.clientAccessToken ?? process.env.CLIENT_ACCESS_TOKEN ?? 'allinone-dev-pass')
  const bridgeSecret = String(options.bridgeSecret ?? process.env.BRIDGE_SECRET ?? 'allinone-dev-bridge')
  const jwtSecret = String(options.jwtSecret ?? process.env.JWT_SECRET ?? '')
  const registerInviteCode = String(options.registerInviteCode ?? process.env.REGISTER_INVITE_CODE ?? '').trim()
  const disableLegacyOwnerAuth = parseEnvBool(
    options.disableLegacyOwnerAuth ?? process.env.DISABLE_LEGACY_OWNER_AUTH,
    false,
  )
  const disableLegacyRooms = parseEnvBool(
    options.disableLegacyRooms ?? process.env.DISABLE_LEGACY_ROOMS,
    false,
  )
  const publicRelayUrl = String(options.publicRelayUrl ?? process.env.PUBLIC_RELAY_URL ?? '').trim().replace(/\/+$/, '')
  const allowedOrigins = buildAllowedOriginsSet(
    publicRelayUrl,
    options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '',
  )
  const isProd = (options.nodeEnv ?? process.env.NODE_ENV) === 'production'
  if (
    isProd &&
    !options.allowDevSecrets &&
    (clientAccessToken === 'allinone-dev-pass' ||
      bridgeSecret === 'allinone-dev-bridge' ||
      clientAccessToken.trim().length < 8 ||
      bridgeSecret.trim().length < 8)
  ) {
    throw new Error(
      'Refusing to start in production with default or weak CLIENT_ACCESS_TOKEN / BRIDGE_SECRET. Set strong secrets (>= 8 chars) in .env.',
    )
  }

  const staticDir = resolve(
    options.staticDir ?? (process.env.STATIC_DIR || resolve(__dirname, '../../mobile-app/dist')),
  )
  const uploadDir = resolve(
    options.uploadDir ?? (process.env.UPLOAD_DIR || resolve(__dirname, '../data/uploads')),
  )
  const roomsFile = resolve(
    options.roomsFile ?? (process.env.ROOMS_FILE || resolve(__dirname, '../data/rooms.json')),
  )
  const accountsFile = resolve(
    options.accountsFile ?? (process.env.ACCOUNTS_FILE || resolve(__dirname, '../data/accounts.json')),
  )
  mkdirSync(uploadDir, { recursive: true })
  try { chmodSync(uploadDir, 0o700) } catch {}

  const rooms = createRoomStore({ filePath: roomsFile })
  const accounts = createAccountStore({ filePath: accountsFile })
  const mailer = createMailer(options)
  const emailCodes = createEmailCodeStore(options.emailCodeOptions || {})
  const startedAt = Date.now()
  const auth = createAuthManager({
    clientAccessToken,
    bridgeSecret,
    jwtSecret,
    registerInviteCode,
    getTokenVersion: (roomId) =>
      String(roomId || '').startsWith('usr_')
        ? accounts.getTokenVersion(roomId)
        : rooms.getTokenVersion(roomId),
    isSessionRevoked: (roomId, sid) =>
      String(roomId || '').startsWith('usr_')
        ? accounts.isSessionRevoked(roomId, sid)
        : false,
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
    const rid = String(roomId || 'owner').trim() || 'owner'
    const isAccount = rid.startsWith('usr_')
    const liveClients = hub.getClientList(rid)
    const persisted = isAccount ? accounts.listUserSessions(rid) : []
    const liveBySid = new Map()
    const legacyLive = []

    for (const c of liveClients) {
      if (c.sid) {
        const arr = liveBySid.get(c.sid) || []
        arr.push(c)
        liveBySid.set(c.sid, arr)
      } else {
        legacyLive.push(c)
      }
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
        legacy: false,
        createdAt: p.createdAt || newestConn?.connectedAt || 0,
        lastSeenAt: newestConn?.lastSeenAt || p.lastSeenAt || p.createdAt || 0,
      })
    }

    // Live clients whose sid wasn't persisted yet (e.g., room/owner mode or restored token)
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
        legacy: !isAccount,
        createdAt: newestConn.connectedAt || 0,
        lastSeenAt: newestConn.lastSeenAt || newestConn.connectedAt || 0,
      })
    }

    // Legacy live connections issued before v0.3.9 (no `sid` in JWT)
    for (const c of legacyLive) {
      const isCurrent = Boolean(currentClientId && c.clientId === currentClientId)
      sessions.push({
        sid: '',
        clientId: c.clientId,
        clientIds: [c.clientId],
        connectionCount: 1,
        deviceName: c.deviceName || 'Web Client',
        clientKind: c.clientKind || 'web',
        ip: c.ip || '',
        online: true,
        isCurrent,
        legacy: true,
        createdAt: c.connectedAt || 0,
        lastSeenAt: c.lastSeenAt || c.connectedAt || 0,
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

  const hub = new RelayHub({
    getRoomDevices: (roomId, liveBridges) => getMergedAccountDevices(roomId, liveBridges),
  })

  function isAllowedOrigin(rawOrigin, req) {
    const origin = String(rawOrigin || '').trim()
    if (!origin) return true
    const lower = origin.replace(/\/+$/, '').toLowerCase()
    if (allowedOrigins.has(lower)) return true
    if (LOCAL_DEV_ORIGIN_RE.test(lower)) return true
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
      'Content-Type, Authorization, X-Bridge-Secret, X-Room-Id, X-Invite-Code',
    )
  }

  // Small in-memory LRU cache for bridged PC images (strictly namespaced by roomId)
  const BRIDGE_IMG_CACHE_MAX_ITEMS = 32
  const BRIDGE_IMG_CACHE_MAX_BYTES = 48 * 1024 * 1024
  const BRIDGE_IMG_CACHE_TTL_MS = 5 * 60 * 1000
  const bridgeImgCache = new Map()
  let bridgeImgCacheBytes = 0

  function getCachedBridgeImage(key) {
    const entry = bridgeImgCache.get(key)
    if (!entry) return null
    if (Date.now() - entry.cachedAt > BRIDGE_IMG_CACHE_TTL_MS) {
      bridgeImgCache.delete(key)
      bridgeImgCacheBytes -= entry.buf.length
      return null
    }
    bridgeImgCache.delete(key)
    bridgeImgCache.set(key, entry)
    return entry
  }

  function setCachedBridgeImage(key, entry) {
    if (entry.buf.length > BRIDGE_IMG_CACHE_MAX_BYTES / 2) return
    const existing = bridgeImgCache.get(key)
    if (existing) {
      bridgeImgCache.delete(key)
      bridgeImgCacheBytes -= existing.buf.length
    }
    while (
      bridgeImgCache.size >= BRIDGE_IMG_CACHE_MAX_ITEMS ||
      bridgeImgCacheBytes + entry.buf.length > BRIDGE_IMG_CACHE_MAX_BYTES
    ) {
      const oldestKey = bridgeImgCache.keys().next().value
      if (!oldestKey) break
      const oldest = bridgeImgCache.get(oldestKey)
      bridgeImgCache.delete(oldestKey)
      if (oldest) bridgeImgCacheBytes -= oldest.buf.length
    }
    bridgeImgCache.set(key, entry)
    bridgeImgCacheBytes += entry.buf.length
  }

  function purgeRoomBridgeImgCache(roomId) {
    const prefix = `${roomId}|`
    for (const [key, entry] of bridgeImgCache.entries()) {
      if (key.startsWith(prefix)) {
        bridgeImgCache.delete(key)
        bridgeImgCacheBytes -= entry.buf.length
      }
    }
  }

  // Periodic cleanup + quota enforcement for temporary uploads (prevents disk exhaustion DoS)
  function pruneUploadsForQuota(incomingBytes = 0, targetRoomId = '') {
    try {
      const now = Date.now()
      const cutoff = now - UPLOAD_TTL_MS
      const entries = []
      for (const file of readdirSync(uploadDir)) {
        if (!file.endsWith('.bin')) continue
        const id = file.slice(0, -4)
        const binPath = join(uploadDir, file)
        const metaPath = join(uploadDir, `${id}.json`)
        let st
        try {
          st = statSync(binPath)
        } catch {
          continue
        }
        if (st.mtimeMs < cutoff) {
          try { unlinkSync(binPath) } catch {}
          try { unlinkSync(metaPath) } catch {}
          continue
        }
        let roomId = ''
        try {
          if (existsSync(metaPath)) {
            roomId = String(JSON.parse(readFileSync(metaPath, 'utf8'))?.roomId || '')
          }
        } catch {}
        entries.push({ id, binPath, metaPath, size: st.size, mtimeMs: st.mtimeMs, roomId })
      }
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
      let totalBytes = entries.reduce((sum, e) => sum + e.size, 0)
      let roomBytes = targetRoomId
        ? entries.filter((e) => e.roomId === targetRoomId).reduce((sum, e) => sum + e.size, 0)
        : 0
      const evicted = new Set()
      if (targetRoomId && roomBytes + incomingBytes > MAX_ROOM_UPLOAD_BYTES) {
        for (const e of entries) {
          if (e.roomId !== targetRoomId) continue
          if (roomBytes + incomingBytes <= MAX_ROOM_UPLOAD_BYTES) break
          try { unlinkSync(e.binPath) } catch {}
          try { unlinkSync(e.metaPath) } catch {}
          evicted.add(e.id)
          roomBytes -= e.size
          totalBytes -= e.size
        }
      }
      if (totalBytes + incomingBytes > MAX_TOTAL_UPLOAD_BYTES) {
        for (const e of entries) {
          if (evicted.has(e.id)) continue
          if (totalBytes + incomingBytes <= MAX_TOTAL_UPLOAD_BYTES) break
          try { unlinkSync(e.binPath) } catch {}
          try { unlinkSync(e.metaPath) } catch {}
          evicted.add(e.id)
          totalBytes -= e.size
        }
      }
    } catch {}
  }

  const cleanupTimer = setInterval(() => {
    pruneUploadsForQuota(0, '')
  }, UPLOAD_CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()

  function extractBearer(req) {
    const header = req.headers.authorization || ''
    if (header.startsWith('Bearer ')) return header.slice(7).trim()
    return ''
  }

  function extractMediaToken(req, urlObj) {
    const headerTok = extractBearer(req)
    if (headerTok) return headerTok
    return String(urlObj.searchParams.get('mt') || urlObj.searchParams.get('token') || '').trim()
  }

  function getClientIp(req) {
    const remote = String(req.socket?.remoteAddress || 'unknown').trim()
    if (isTrustedProxyAddr(remote)) {
      const realIp = String(req.headers['x-real-ip'] || '').trim()
      if (realIp && !realIp.includes(',')) return realIp
      const xff = String(req.headers['x-forwarded-for'] || '').trim()
      if (xff) {
        const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
        // Rightmost X-Forwarded-For entry is appended by the trusted reverse proxy (cannot be spoofed by client)
        if (parts.length > 0) return parts[parts.length - 1]
      }
    }
    return remote
  }

  /**
   * Authenticate a PC Bridge request via HTTP headers ONLY (never URL query secrets!)
   * Supports:
   *  - Account device bridges (`usr_*` + per-PC `deviceSecret` -> authoritative `bridgeId`)
   *  - Legacy multi-tenant room bridges (`rm_*` + room `bridgeSecret`)
   *  - Legacy owner bridge (`owner` + `BRIDGE_SECRET`)
   */
  function authenticateBridgeInfo(req, urlObj) {
    const secret = String(req.headers['x-bridge-secret'] || '').trim()
    const requestedRoom = String(req.headers['x-room-id'] || urlObj?.searchParams?.get('roomId') || '').trim()
    if (!secret) return null
    if (!requestedRoom || requestedRoom === 'owner') {
      if (disableLegacyOwnerAuth) return null
      return auth.verifyBridgeSecret(secret) ? { roomId: 'owner', bridgeId: '', deviceId: '', label: '' } : null
    }
    if (requestedRoom.startsWith('usr_')) {
      return accounts.verifyDeviceBridge(requestedRoom, secret)
    }
    if (disableLegacyRooms) return null
    return rooms.verifyBridge(requestedRoom, secret)
      ? { roomId: requestedRoom, bridgeId: '', deviceId: '', label: '' }
      : null
  }

  function authenticateBridge(req, urlObj) {
    return authenticateBridgeInfo(req, urlObj)?.roomId || null
  }

  function requireAdmin(req, res) {
    const payload = auth.verifySessionToken(extractBearer(req))
    if (!payload) {
      sendJson(res, 401, { ok: false, error: '未登录或登录已失效' })
      return null
    }
    if (!auth.isAdminPayload(payload)) {
      sendJson(res, 403, { ok: false, error: '仅管理员可访问监控面板' })
      return null
    }
    if (String(payload.room || '').startsWith('usr_')) {
      const acct = accounts.getUserById(payload.room)
      if (!acct || acct.role !== 'admin') {
        sendJson(res, 403, { ok: false, error: '仅管理员可访问监控面板' })
        return null
      }
    }
    return payload
  }

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(req, res)
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

    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = urlObj.pathname

    // Health check (privacy-safe: unauthenticated callers only see `{ ok: true }`)
    if (pathname === '/api/health' && req.method === 'GET') {
      const user = auth.verifySessionToken(extractBearer(req))
      if (!user) {
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 200, {
        ok: true,
        roomId: user.room,
        bridges: hub.getBridgeList(user.room),
        uptimeSec: Math.round(process.uptime()),
        ...(user.room === 'owner'
          ? {
              onlineBridges: hub.getOnlineBridgeCount(),
              clients: hub.clients.size,
              rooms: rooms.count() + 1,
            }
          : {}),
      })
      return
    }

    // Multi-tenant: Register a brand-new isolated room for a PC (optionally invite-code gated)
    if (pathname === '/api/rooms/register' && req.method === 'POST') {
      if (disableLegacyRooms) {
        sendJson(res, 403, { ok: false, error: '旧版匿名房间注册已禁用，请使用账号系统登录' })
        return
      }
      const ip = getClientIp(req)
      if (!auth.checkRegisterLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '创建设备过于频繁，请稍后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const invite = String(req.headers['x-invite-code'] || body.inviteCode || '').trim()
        if (!auth.verifyRegisterInviteCode(invite)) {
          auth.recordFailure(ip)
          sendJson(res, 403, { ok: false, error: '需要有效的邀请码才能注册新设备' })
          return
        }
        const created = rooms.registerRoom({ label: body.label || body.hostname || 'My PC' })
        sendJson(res, 200, { ok: true, ...created })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Multi-tenant: Refresh 15-min pairing code for an existing PC bridge room
    if (pathname === '/api/rooms/pair-code' && req.method === 'POST') {
      if (disableLegacyRooms) {
        sendJson(res, 403, { ok: false, error: '旧版匿名房间配对已禁用' })
        return
      }
      const secret = String(req.headers['x-bridge-secret'] || '').trim()
      const roomId = String(req.headers['x-room-id'] || '').trim()
      if (!roomId || !secret || roomId === 'owner') {
        sendJson(res, 401, { ok: false, error: '未授权的房间凭证' })
        return
      }
      const refreshed = rooms.refreshPairCode(roomId, secret)
      if (!refreshed) {
        sendJson(res, 401, { ok: false, error: '房间密钥无效' })
        return
      }
      sendJson(res, 200, { ok: true, ...refreshed })
      return
    }

    // Account bootstrap check (tiny status so UI knows whether an admin exists & whether SMTP email is enabled)
    if (pathname === '/api/account/bootstrap-status' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        hasUsers: accounts.userCount() > 0,
        emailEnabled: mailer.isConfigured(),
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
          const inviteCode = String(body.inviteCode || req.headers['x-invite-code'] || '').trim()
          const isBootstrapAdmin =
            accounts.userCount() === 0 && Boolean(inviteCode) && auth.verifyAccessPassword(inviteCode)
          if (!isBootstrapAdmin && !accounts.hasActiveInviteCode(inviteCode)) {
            auth.recordFailure(ip)
            sendJson(res, 400, { ok: false, error: '请先填写有效的一次性邀请码，再获取邮箱验证码' })
            return
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
          if (!matchedUser) {
            // Do not reveal whether the email is registered and do not spend SMTP quota
            shouldDeliver = false
          } else {
            targetUserId = matchedUser.userId
            targetUsername = matchedUser.username
          }
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

        if (shouldDeliver) {
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

    // Account registration (strictly requires an admin-issued single-use invite code;
    // email binding is strictly optional when SMTP is configured;
    // when 0 users exist yet, server CLIENT_ACCESS_TOKEN works once to bootstrap the first admin account)
    if (pathname === '/api/account/register' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const inviteCode = String(body.inviteCode || req.headers['x-invite-code'] || '').trim()
        const isBootstrapAdmin =
          accounts.userCount() === 0 && Boolean(inviteCode) && auth.verifyAccessPassword(inviteCode)

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

        const result = accounts.registerUser({
          username: body.username,
          password: body.password,
          inviteCode,
          email: verifiedEmail,
          emailVerified: Boolean(verifiedEmail),
          isBootstrapAdmin,
        })
        if (!result.ok) {
          auth.recordFailure(ip)
          sendJson(res, 400, { ok: false, error: result.error })
          return
        }
        if (verifiedEmail) {
          emailCodes.consumeCode({ purpose: 'register', email: verifiedEmail })
        }
        auth.clearFailure(ip)
        const user = result.user
        const devInfo = parseClientDeviceInfo(body.deviceName || '', req.headers['user-agent'] || '', body.clientKind || '')
        const sid = auth.generateSessionId()
        accounts.recordUserSession(user.userId, {
          sid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
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
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Bind or replace verified email for an authenticated account
    if (pathname === '/api/account/email/bind' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
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
        const updated = accounts.setUserEmail(payload.room, eCheck.email, { verified: true })
        if (!updated.ok) {
          sendJson(res, 400, { ok: false, error: updated.error })
          return
        }
        emailCodes.consumeCode({ purpose: 'bind', email: eCheck.email })
        sendJson(res, 200, { ok: true, user: updated.user })
      } catch {
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
        if (!auth.checkAccountRateLimit(eCheck.email)) {
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
        if (!codeCheck.ok || !matchedUser) {
          auth.recordFailure(ip)
          auth.recordAccountFailure(eCheck.email)
          sendJson(res, 400, { ok: false, error: codeCheck.ok ? '邮箱验证码无效或已过期' : codeCheck.error })
          return
        }
        const reset = accounts.resetPasswordByEmail(eCheck.email, pCheck.password)
        if (!reset.ok) {
          auth.recordFailure(ip)
          auth.recordAccountFailure(eCheck.email)
          sendJson(res, 400, { ok: false, error: reset.error })
          return
        }
        emailCodes.consumeCode({ purpose: 'reset', email: eCheck.email })
        auth.clearFailure(ip)
        auth.clearAccountFailure(eCheck.email)
        purgeRoomBridgeImgCache(reset.user.userId)
        hub.disconnectRoomClients(reset.user.userId, 4401, 'Password reset')
        sendJson(res, 200, {
          ok: true,
          username: reset.user.username,
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Toggle optional email login 2FA for authenticated account
    if (pathname === '/api/account/security/2fa' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权或非账号登录模式' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const nextEnabled = Boolean(body.enabled)
        if (nextEnabled && !mailer.isConfigured()) {
          sendJson(res, 503, { ok: false, error: '服务器尚未配置邮件服务（SMTP），无法开启邮箱二次验证' })
          return
        }
        const updated = accounts.setLoginEmail2fa(payload.room, nextEnabled)
        if (!updated.ok) {
          sendJson(res, 400, { ok: false, error: updated.error })
          return
        }
        sendJson(res, 200, { ok: true, user: updated.user })
      } catch {
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
        if (!auth.checkAccountRateLimit(identifier)) {
          sendJson(res, 429, { ok: false, error: '该账号尝试登录失败过多，请 15 分钟后再试' })
          return
        }
        const verified = accounts.authenticateUser(identifier, body.password)
        if (!verified) {
          auth.recordFailure(ip)
          auth.recordAccountFailure(identifier)
          sendJson(res, 401, { ok: false, error: '账号或密码不正确' })
          return
        }
        const { user } = verified
        const emailCode = String(body.emailCode || '').trim()

        // Optional Email 2FA: require verified 6-digit OTP when enabled on account & SMTP is active
        if (user.loginEmail2fa && mailer.isConfigured() && user.email && user.emailVerified) {
          if (!emailCode) {
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
                  maskedEmail: maskEmailAddress(user.email),
                  cooldownSec: issued.retryAfterSec,
                  message: `验证码已发送至 ${maskEmailAddress(user.email)}，请直接输入或 ${issued.retryAfterSec} 秒后重发`,
                })
                return
              }
              sendJson(res, 429, { ok: false, error: issued.error })
              return
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
              sendJson(res, 502, { ok: false, error: `发送登录验证码失败：${String(mailErr?.message || mailErr)}` })
              return
            }
            sendJson(res, 200, {
              ok: false,
              requires2fa: true,
              maskedEmail: maskEmailAddress(user.email),
              cooldownSec: issued.cooldownSec,
              message: `已向 ${maskEmailAddress(user.email)} 发送 6 位登录验证码`,
            })
            return
          }
          const check2fa = emailCodes.verifyCode({
            purpose: 'login_2fa',
            email: user.email,
            code: emailCode,
            userId: user.userId,
            consume: false,
          })
          if (!check2fa.ok) {
            auth.recordFailure(ip)
            auth.recordAccountFailure(identifier)
            sendJson(res, 401, {
              ok: false,
              requires2fa: true,
              maskedEmail: maskEmailAddress(user.email),
              error: check2fa.error,
            })
            return
          }
          emailCodes.consumeCode({ purpose: 'login_2fa', email: user.email })
        }

        auth.clearFailure(ip)
        auth.clearAccountFailure(identifier)
        const devInfo = parseClientDeviceInfo(body.deviceName || '', req.headers['user-agent'] || '', body.clientKind || '')
        const { isNewContext } = accounts.checkAndRememberLoginContext(user.userId, {
          deviceName: devInfo.deviceName,
          ip,
        })
        const sid = auth.generateSessionId()
        accounts.recordUserSession(user.userId, {
          sid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
        })
        if (isNewContext && mailer.isConfigured() && user.email && user.emailVerified) {
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
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // PC Bridge account login -> verifies username+password once, issues a per-PC `deviceSecret` (PC never stores password!)
    if (pathname === '/api/account/device-login' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const identifier = String(body.username || '').trim()
        if (!auth.checkAccountRateLimit(identifier)) {
          sendJson(res, 429, { ok: false, error: '该账号尝试登录失败过多，请 15 分钟后再试' })
          return
        }
        const verified = accounts.authenticateUser(identifier, body.password)
        if (!verified) {
          auth.recordFailure(ip)
          auth.recordAccountFailure(identifier)
          sendJson(res, 401, { ok: false, error: '账号或密码不正确' })
          return
        }
        auth.clearFailure(ip)
        auth.clearAccountFailure(identifier)
        const bound = accounts.bindDevice({
          userId: verified.user.userId,
          label: body.label || body.hostname || 'My PC',
          hostname: body.hostname || body.label || 'My-PC',
          platform: body.platform || 'unknown',
          bridgeId: body.bridgeId || '',
        })
        hub.broadcastRoomDevices(verified.user.userId)
        sendJson(res, 200, { ok: true, ...bound })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Bridge-authenticated device status check (lets PC CLI verify binding & list sibling PCs in the same account)
    if (pathname === '/api/account/device-status' && req.method === 'GET') {
      const info = authenticateBridgeInfo(req, urlObj)
      if (!info || !info.roomId.startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '电脑绑定凭证无效或已被解绑' })
        return
      }
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
      try {
        const body = await readJsonBody(req)
        const bound = accounts.bindDevice({
          userId: payload.room,
          label: body.label || body.hostname || 'My PC',
          hostname: body.hostname || body.label || 'My-PC',
          platform: body.platform || 'unknown',
          bridgeId: body.bridgeId || '',
        })
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
      try {
        const body = await readJsonBody(req)
        const updated = accounts.renameUserDevice(payload.room, body.deviceId, body.label)
        if (!updated) {
          sendJson(res, 404, { ok: false, error: '找不到目标电脑或名称为空' })
          return
        }
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

    // Change account password (revokes all other sessions and returns a fresh JWT for caller)
    if (pathname === '/api/account/password' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload || !String(payload.room || '').startsWith('usr_')) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const changed = accounts.changePassword(payload.room, body.currentPassword, body.newPassword)
        if (!changed.ok) {
          sendJson(res, 400, { ok: false, error: changed.error })
          return
        }
        purgeRoomBridgeImgCache(payload.room)
        hub.disconnectRoomClients(payload.room, 4401, 'Password changed')
        const ip = getClientIp(req)
        const devInfo = parseClientDeviceInfo(body.deviceName || payload.dev || '', req.headers['user-agent'] || '', body.clientKind || '')
        const newSid = auth.generateSessionId()
        accounts.recordUserSession(changed.user.userId, {
          sid: newSid,
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip,
        })
        const freshToken = auth.signSessionToken(
          changed.user.userId,
          devInfo.deviceName,
          changed.user.userId,
          changed.user.tokenVersion,
          { role: changed.user.role, username: changed.user.username, sid: newSid },
        )
        sendJson(res, 200, { ok: true, token: freshToken, user: changed.user })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Admin: List all single-use invite codes + registered user summary
    if (pathname === '/api/admin/invites' && req.method === 'GET') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!auth.isAdminPayload(payload)) {
        sendJson(res, 403, { ok: false, error: '仅管理员可管理邀请码' })
        return
      }
      const invites = accounts.listInvites()
      const stats = {
        total: invites.length,
        active: invites.filter((i) => i.status === 'active').length,
        used: invites.filter((i) => i.status === 'used').length,
        revoked: invites.filter((i) => i.status === 'revoked').length,
      }
      sendJson(res, 200, { ok: true, invites, stats, users: accounts.listUsers() })
      return
    }

    // Admin: Generate N single-use registration invite codes (each usable by strictly 1 user)
    if (pathname === '/api/admin/invites' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!auth.isAdminPayload(payload)) {
        sendJson(res, 403, { ok: false, error: '仅管理员可生成邀请码' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const created = accounts.createInvites({
          count: body.count ?? 1,
          note: body.note || '',
          createdBy: payload.uname || payload.sub || 'admin',
          grantAdmin: Boolean(body.grantAdmin),
        })
        hub.recordActivity({
          type: 'admin.invite',
          roomId: payload.room,
          label: payload.uname ? `@${payload.uname}` : 'admin',
          detail: `Created ${created.length} invite(s)${body.note ? ` · ${String(body.note).slice(0, 32)}` : ''}`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, invites: created })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Admin: Revoke an unused invite code
    if (pathname === '/api/admin/invites/revoke' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!auth.isAdminPayload(payload)) {
        sendJson(res, 403, { ok: false, error: '仅管理员可作废邀请码' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const resRevoke = accounts.revokeInvite(body.id || body.code)
        if (!resRevoke) {
          sendJson(res, 404, { ok: false, error: '找不到该邀请码' })
          return
        }
        if (!resRevoke.ok) {
          sendJson(res, 400, { ok: false, error: resRevoke.error })
          return
        }
        hub.recordActivity({
          type: 'admin.invite',
          roomId: payload.room,
          label: payload.uname ? `@${payload.uname}` : 'admin',
          detail: `Revoked ${resRevoke.invite.code}`,
          ip: getClientIp(req),
        })
        sendJson(res, 200, { ok: true, invite: resRevoke.invite })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Admin Monitor: On-demand full server & all-users status snapshot (zero idle overhead)
    if (pathname === '/api/admin/overview' && req.method === 'GET') {
      const payload = requireAdmin(req, res)
      if (!payload) return
      const serverHealth = collectServerHealth({
        uploadDir,
        bridgeImgCacheItems: bridgeImgCache.size,
        bridgeImgCacheBytes,
        bridgeImgCacheMaxBytes: BRIDGE_IMG_CACHE_MAX_BYTES,
        mailer,
        registerInviteGated: auth.hasRegisterInviteCode(),
        startedAt,
        version: RELAY_VERSION,
      })
      const overview = buildAdminOverview({
        accounts,
        rooms,
        hub,
        serverHealth,
        currentAdminRoom: payload.room || '',
        currentAdminSid: payload.sid || '',
      })
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, 200, overview)
      return
    }

    // Admin Monitor: Kick / revoke a single client session for any user or legacy room
    if (pathname === '/api/admin/users/kick-session' && req.method === 'POST') {
      const payload = requireAdmin(req, res)
      if (!payload) return
      try {
        const body = await readJsonBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        const targetSid = String(body.sid || '').trim()
        const targetClientId = String(body.clientId || '').trim()
        if (!targetRoom || (!targetSid && !targetClientId)) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户或会话标识' })
          return
        }
        if (targetRoom === payload.room && targetSid && payload.sid && targetSid === payload.sid) {
          sendJson(res, 400, { ok: false, error: '不能踢出当前正在使用的管理员会话' })
          return
        }
        let revokedPermanent = false
        if (targetRoom.startsWith('usr_') && targetSid) {
          revokedPermanent = accounts.revokeUserSession(targetRoom, targetSid)
        }
        const kickedConnections = hub.disconnectClient(
          targetRoom,
          { clientId: targetClientId, sid: targetSid },
          4401,
          'Session revoked by admin',
        )
        const targetUser = targetRoom.startsWith('usr_') ? accounts.getUserById(targetRoom) : null
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

    // Admin Monitor: Force sign-out ALL sessions for a user or legacy room
    if (pathname === '/api/admin/users/revoke-all' && req.method === 'POST') {
      const payload = requireAdmin(req, res)
      if (!payload) return
      try {
        const body = await readJsonBody(req)
        const targetRoom = String(body.userId || body.roomId || '').trim()
        if (!targetRoom) {
          sendJson(res, 400, { ok: false, error: '缺少目标用户标识' })
          return
        }
        if (targetRoom === payload.room) {
          sendJson(res, 400, { ok: false, error: '不能在监控面板强制下线当前管理员自身' })
          return
        }
        const revoked = targetRoom.startsWith('usr_')
          ? accounts.revokeUserTokens(targetRoom)
          : rooms.revokeRoomTokens(targetRoom)
        if (!revoked) {
          sendJson(res, 404, { ok: false, error: '找不到目标用户或房间' })
          return
        }
        purgeRoomBridgeImgCache(targetRoom)
        const disconnectedClients = hub.disconnectRoomClients(targetRoom, 4401, 'All sessions revoked by admin')
        const targetUser = targetRoom.startsWith('usr_') ? accounts.getUserById(targetRoom) : null
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
        if (!targetRoom || !targetBridgeId) {
          sendJson(res, 400, { ok: false, error: '缺少目标房间或桥接标识' })
          return
        }
        const disconnected = hub.disconnectBridge(targetRoom, targetBridgeId, 4000, 'Disconnected by admin')
        if (!disconnected) {
          sendJson(res, 404, { ok: false, error: '该电脑桥接当前不在线' })
          return
        }
        const targetUser = targetRoom.startsWith('usr_') ? accounts.getUserById(targetRoom) : null
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

    // Revoke ALL active mobile tokens for a room or account (callable by either the PC bridge or an authenticated mobile client)
    if (pathname === '/api/rooms/revoke' && req.method === 'POST') {
      const bridgeRoom = authenticateBridge(req, urlObj)
      const clientUser = bridgeRoom ? null : auth.verifySessionToken(extractBearer(req))
      const targetRoom = bridgeRoom || clientUser?.room || null
      if (!targetRoom) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      const revoked = targetRoom.startsWith('usr_')
        ? accounts.revokeUserTokens(targetRoom)
        : rooms.revokeRoomTokens(targetRoom)
      if (!revoked) {
        sendJson(res, 404, { ok: false, error: '房间或账号不存在' })
        return
      }
      purgeRoomBridgeImgCache(targetRoom)
      const disconnectedClients = hub.disconnectRoomClients(targetRoom, 4401, 'Session revoked')
      sendJson(res, 200, {
        ok: true,
        roomId: revoked.roomId,
        tokenVersion: revoked.tokenVersion,
        disconnectedClients,
      })
      return
    }

    // Multi-tenant: Mobile pairing via single-use 8-char Pairing Code or QR pairToken -> room-scoped 30-day JWT
    if (pathname === '/api/auth/pair' && req.method === 'POST') {
      if (disableLegacyRooms) {
        sendJson(res, 403, { ok: false, error: '旧版扫码配对已禁用，请使用个人账号登录' })
        return
      }
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const result = rooms.exchangePair({
          pairCode: body.pairCode || body.code || '',
          pairToken: body.pairToken || body.token || '',
        })
        if (!result.ok) {
          auth.recordFailure(ip)
          sendJson(res, 401, { ok: false, error: result.error })
          return
        }
        auth.clearFailure(ip)
        const token = auth.signSessionToken(
          result.roomId,
          body.deviceName || 'mobile',
          result.roomId,
          result.tokenVersion,
        )
        sendJson(res, 200, {
          ok: true,
          token,
          roomId: result.roomId,
          label: result.label,
          bridges: hub.getBridgeList(result.roomId),
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Owner mobile login -> signed session token strictly scoped to `room = 'owner'`
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      if (disableLegacyOwnerAuth) {
        sendJson(res, 403, { ok: false, error: '旧版共享密钥登录已禁用，请使用个人账号登录' })
        return
      }
      const ip = getClientIp(req)
      if (!auth.checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' })
        return
      }
      try {
        const body = await readJsonBody(req)
        if (!auth.verifyAccessPassword(body.password || body.token || '')) {
          auth.recordFailure(ip)
          sendJson(res, 401, { ok: false, error: '访问密钥不正确' })
          return
        }
        auth.clearFailure(ip)
        const token = auth.signSessionToken(
          'owner',
          body.deviceName || 'mobile',
          'owner',
          rooms.getTokenVersion('owner'),
        )
        sendJson(res, 200, {
          ok: true,
          token,
          roomId: 'owner',
          bridges: hub.getBridgeList('owner'),
        })
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
      if (String(payload.room || '').startsWith('usr_') && payload.sid) {
        accounts.touchUserSession(payload.room, payload.sid, {
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip: getClientIp(req),
        })
      }
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

    // Kick / revoke a single logged-in client device (by `sid` or live `clientId`)
    if (pathname === '/api/auth/sessions/revoke' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
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
        if ((targetSid && payload.sid && targetSid === payload.sid) || (targetClientId && currentClientId && targetClientId === currentClientId)) {
          sendJson(res, 400, { ok: false, error: '不能踢出当前本机设备，如需退出请使用退出登录' })
          return
        }
        const isAccount = String(payload.room || '').startsWith('usr_')
        let revokedPermanent = false
        if (isAccount && targetSid) {
          revokedPermanent = accounts.revokeUserSession(payload.room, targetSid)
        }
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
          legacy: !revokedPermanent,
          ...merged,
        })
      } catch {
        sendJson(res, 400, { ok: false, error: '请求格式错误' })
      }
      return
    }

    // Nuclear security action: revoke EVERY other device/token (including offline & legacy JWTs) while keeping caller logged in with a fresh rotated JWT
    if (pathname === '/api/auth/sessions/revoke-others' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const currentClientId = String(body.currentClientId || '').trim()
        const targetRoom = String(payload.room || 'owner').trim() || 'owner'
        const isAccount = targetRoom.startsWith('usr_')
        const ip = getClientIp(req)
        const devInfo = parseClientDeviceInfo(
          body.deviceName || payload.dev || '',
          req.headers['user-agent'] || '',
          body.clientKind || '',
        )
        const revoked = isAccount
          ? accounts.revokeUserTokens(targetRoom)
          : rooms.revokeRoomTokens(targetRoom)
        if (!revoked) {
          sendJson(res, 404, { ok: false, error: '账号或房间不存在' })
          return
        }
        purgeRoomBridgeImgCache(targetRoom)
        const newSid = auth.generateSessionId()
        let freshToken = ''
        if (isAccount) {
          const acctUser = accounts.getUserById(targetRoom)
          accounts.recordUserSession(targetRoom, {
            sid: newSid,
            deviceName: devInfo.deviceName,
            clientKind: devInfo.clientKind,
            ip,
          })
          freshToken = auth.signSessionToken(
            targetRoom,
            devInfo.deviceName,
            targetRoom,
            revoked.tokenVersion,
            { role: acctUser?.role || payload.role || 'user', username: acctUser?.username || payload.uname || '', sid: newSid },
          )
        } else {
          freshToken = auth.signSessionToken(
            targetRoom,
            devInfo.deviceName,
            targetRoom,
            revoked.tokenVersion,
            { role: payload.role || (targetRoom === 'owner' ? 'admin' : 'user'), sid: newSid },
          )
        }
        const kickedConnections = hub.disconnectOtherRoomClients(
          targetRoom,
          { keepClientId: currentClientId, newSidForKept: newSid },
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

    // Issue a 15-minute read-only scoped media token for <img> / download links (cannot open WS or run RPCs)
    if (pathname === '/api/auth/media-token' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      const { mediaToken, expiresAt } = auth.signMediaToken(payload)
      sendJson(res, 200, { ok: true, mediaToken, expiresAt })
      return
    }

    // Verify existing session token
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '登录已失效' })
        return
      }
      const isAccount = String(payload.room || '').startsWith('usr_')
      const acctUser = isAccount ? accounts.getUserById(payload.room) : null
      const roomMeta = isAccount ? null : rooms.getRoomMeta(payload.room)
      const bridges = hub.getBridgeList(payload.room)
      const clientSessions = getMergedClientSessions(payload.room, { currentSid: payload.sid || '' })
      sendJson(res, 200, {
        ok: true,
        user: payload,
        roomId: payload.room,
        username: acctUser?.username || payload.uname || '',
        email: acctUser?.email || '',
        emailVerified: Boolean(acctUser?.emailVerified),
        loginEmail2fa: Boolean(acctUser?.loginEmail2fa),
        emailEnabled: mailer.isConfigured(),
        role: acctUser?.role || (payload.room === 'owner' ? 'admin' : 'user'),
        label: acctUser ? `@${acctUser.username}` : roomMeta?.label || '',
        ...(isAccount ? { devices: getMergedAccountDevices(payload.room, bridges) } : {}),
        bridges,
        clientSessions,
      })
      return
    }

    // Attachment upload (scoped strictly to caller's roomId)
    if (pathname === '/api/uploads' && req.method === 'POST') {
      const payload = auth.verifySessionToken(extractBearer(req))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      try {
        const body = await readJsonBody(req, Math.ceil(MAX_UPLOAD_BYTES * 1.45))
        const rawBase64 = String(body.dataBase64 || '')
        const cleanBase64 = rawBase64.includes(',') ? rawBase64.split(',').pop() : rawBase64
        const buf = Buffer.from(cleanBase64, 'base64')
        if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
          sendJson(res, 400, { ok: false, error: '文件为空或超过 15MB 限制' })
          return
        }
        const safeName = String(body.filename || 'upload.bin').replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, '_').slice(0, 100)
        const ownerRoom = payload.room || 'owner'
        pruneUploadsForQuota(buf.length, ownerRoom)
        const id = randomUUID()
        const meta = {
          id,
          roomId: ownerRoom,
          filename: safeName,
          mimeType: String(body.mimeType || 'application/octet-stream'),
          size: buf.length,
          createdAt: Date.now(),
        }
        writeFileSync(join(uploadDir, `${id}.bin`), buf, { mode: 0o600 })
        writeFileSync(join(uploadDir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 })
        sendJson(res, 200, {
          ok: true,
          upload: {
            id: meta.id,
            filename: meta.filename,
            mimeType: meta.mimeType,
            size: meta.size,
            createdAt: meta.createdAt,
            url: `/api/uploads/${id}`,
          },
        })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `上传失败：${String(err.message || err)}` })
      }
      return
    }

    // Proxy local PC image files strictly through the authenticated user's OWN room bridge
    if (pathname === '/api/bridge-file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const payload = auth.verifyMediaToken(extractMediaToken(req, urlObj))
      if (!payload) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      const roomId = payload.room || 'owner'
      const filePath = urlObj.searchParams.get('path') || ''
      const cwd = urlObj.searchParams.get('cwd') || ''
      const bridgeId = urlObj.searchParams.get('bridgeId') || undefined
      const asDownload = urlObj.searchParams.get('download') === '1'
      if (!filePath.trim()) {
        sendJson(res, 400, { ok: false, error: '缺少 path 参数' })
        return
      }

      const cacheKey = `${roomId}|${bridgeId || 'primary'}|${cwd}|${filePath}`
      try {
        let entry = getCachedBridgeImage(cacheKey)
        if (!entry) {
          const result = await hub.callBridge(
            roomId,
            RPC.FILE_READ,
            { path: filePath, cwd },
            { bridgeId, timeoutMs: 25_000 },
          )
          if (!result?.dataBase64 || !String(result.mimeType || '').startsWith('image/')) {
            sendJson(res, 403, { ok: false, error: '仅支持预览图片文件' })
            return
          }
          const buf = Buffer.from(result.dataBase64, 'base64')
          entry = {
            buf,
            mimeType: result.mimeType,
            filename: result.filename || 'image.png',
            cachedAt: Date.now(),
          }
          setCachedBridgeImage(cacheKey, entry)
        }

        const headers = {
          'Content-Type': entry.mimeType,
          'Content-Length': entry.buf.length,
          'Content-Disposition': `${asDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
        }
        if (entry.mimeType === 'image/svg+xml') {
          headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
        }
        res.writeHead(200, headers)
        if (req.method === 'HEAD') res.end()
        else res.end(entry.buf)
      } catch (err) {
        const msg = String(err?.message || err)
        const status = err?.code === 'BRIDGE_OFFLINE'
          ? 503
          : /找不到/.test(msg)
            ? 404
            : /仅允许|不支持|拒绝访问/.test(msg)
              ? 403
              : 500
        sendJson(res, status, { ok: false, error: msg })
      }
      return
    }

    // Attachment download (strictly isolated to the owning roomId!)
    if (pathname.startsWith('/api/uploads/') && req.method === 'GET') {
      const bridgeRoom = authenticateBridge(req, urlObj)
      const clientUser = bridgeRoom ? null : auth.verifyMediaToken(extractMediaToken(req, urlObj))
      const callerRoom = bridgeRoom || clientUser?.room || null
      if (!callerRoom) {
        sendJson(res, 401, { ok: false, error: '未授权' })
        return
      }
      const id = pathname.slice('/api/uploads/'.length).replace(/[^a-zA-Z0-9-]/g, '')
      const binPath = join(uploadDir, `${id}.bin`)
      const metaPath = join(uploadDir, `${id}.json`)
      if (!id || !existsSync(binPath) || !existsSync(metaPath)) {
        sendJson(res, 404, { ok: false, error: '文件不存在或已过期' })
        return
      }
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      const fileRoom = meta.roomId || 'owner'
      if (fileRoom !== callerRoom) {
        sendJson(res, 403, { ok: false, error: '无权访问其他房间的文件' })
        return
      }
      const data = readFileSync(binPath)
      // Ephemeral consume: when the PC bridge downloads a non-image attachment with ?consume=1, delete temp files immediately
      if (bridgeRoom && urlObj.searchParams.get('consume') === '1') {
        try { unlinkSync(binPath) } catch {}
        try { unlinkSync(metaPath) } catch {}
      }
      const safeMime = String(meta.mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase()
      const disposition = SAFE_INLINE_IMAGE_MIMES.has(safeMime) ? 'inline' : 'attachment'
      res.writeHead(200, {
        'Content-Type': meta.mimeType || 'application/octet-stream',
        'Content-Length': data.length,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.filename || 'upload.bin')}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      })
      res.end(data)
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
      if (adminTarget && existsSync(adminTarget) && statSync(adminTarget).isFile()) {
        const ext = extname(adminTarget).toLowerCase()
        const buf = readFileSync(adminTarget)
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
      sendJson(res, 404, { ok: false, error: 'Not Found' })
      return
    }

    // Static PWA, installer scripts (.ps1/.sh/.mjs), & APK serving
    if ((req.method === 'GET' || req.method === 'HEAD') && existsSync(staticDir)) {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const candidate = resolve(staticDir, normalize(rel))
      let target = null
      const withinStaticDir = candidate === staticDir || candidate.startsWith(`${staticDir}${sep}`)
      if (withinStaticDir && existsSync(candidate) && statSync(candidate).isFile()) {
        target = candidate
      } else if (!pathname.startsWith('/api/') && !pathname.startsWith('/ws/') && !pathname.startsWith('/downloads/') && !pathname.startsWith('/admin')) {
        const indexHtml = join(staticDir, 'index.html')
        if (existsSync(indexHtml)) target = indexHtml
      }
      if (target) {
        const ext = extname(target).toLowerCase()
        const isMutable =
          ext === '.html' ||
          ext === '.ps1' ||
          ext === '.sh' ||
          ext === '.mjs' ||
          target.endsWith('sw.js') ||
          target.endsWith('registerSW.js') ||
          target.endsWith('manifest.webmanifest')

        // Dynamically inject this server's public URL into setup.ps1 / setup.sh so the public repo stays 100% generic
        if (ext === '.ps1' || ext === '.sh') {
          const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
          const inferredOrigin = req.headers.host ? `${proto}://${req.headers.host}` : ''
          const effectiveUrl = publicRelayUrl || inferredOrigin
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
          staticHeaders['Content-Security-Policy'] = APP_HTML_CSP
        }
        res.writeHead(200, staticHeaders)
        if (req.method === 'HEAD') {
          res.end()
        } else {
          res.end(readFileSync(target))
        }
        return
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' })
  })

  // WebSocket server handling both /ws/bridge and /ws/client (32MB supports high-res PC screenshots)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })

  server.on('upgrade', (req, socket, head) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = urlObj.pathname

    if (pathname === '/ws/bridge') {
      const bridgeIp = getClientIp(req)
      if (!auth.checkRateLimit(bridgeIp)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return
      }
      const bridgeAuth = authenticateBridgeInfo(req, urlObj)
      if (!bridgeAuth) {
        auth.recordFailure(bridgeIp)
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      auth.clearFailure(bridgeIp)
      const meta = {
        roomId: bridgeAuth.roomId,
        // For account-bound devices, enforce the authoritative bridgeId bound to that deviceSecret
        bridgeId: bridgeAuth.bridgeId || urlObj.searchParams.get('bridgeId') || 'home-pc',
        deviceId: bridgeAuth.deviceId || '',
        label: bridgeAuth.label || '',
        hostname: urlObj.searchParams.get('hostname') || bridgeAuth.hostname || 'PC',
        platform: urlObj.searchParams.get('platform') || bridgeAuth.platform || 'win32',
        mode: urlObj.searchParams.get('mode') || 'dsh-plugin',
        ip: getClientIp(req),
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        hub.registerBridge(ws, meta)
      })
      return
    }

    if (pathname === '/ws/client') {
      // Block cross-site WebSocket hijacking (CSWSH) from untrusted third-party web origins
      if (req.headers.origin && !isAllowedOrigin(req.headers.origin, req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      const ticket = String(urlObj.searchParams.get('ticket') || '').trim()
      let user = null
      if (ticket) {
        user = auth.consumeWsTicket(ticket)
      } else {
        // Fallback for older cached mobile clients or header-authenticated callers
        const legacyTok = extractBearer(req) || String(urlObj.searchParams.get('token') || '').trim()
        user = auth.verifySessionToken(legacyTok)
      }
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const lastSeq = Number(urlObj.searchParams.get('lastSeq') || 0)
      const clientIp = getClientIp(req)
      const clientUa = String(req.headers['user-agent'] || '')
      if (String(user?.room || '').startsWith('usr_') && user?.sid) {
        const devInfo = parseClientDeviceInfo(user.dev || '', clientUa, user.kind || '')
        accounts.touchUserSession(user.room, user.sid, {
          deviceName: devInfo.deviceName,
          clientKind: devInfo.clientKind,
          ip: clientIp,
        })
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        hub.registerClient(ws, user, { lastSeq, ip: clientIp, userAgent: clientUa })
      })
      return
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
  })

  const start = () =>
    new Promise((resolveStart) => {
      server.listen(port, host, () => {
        const addr = server.address()
        const boundPort = typeof addr === 'object' && addr ? addr.port : port
        console.log(`[relay] AllinOne Relay Server listening on http://${host}:${boundPort}`)
        console.log(`[relay] Admin Monitor Dashboard: ${publicRelayUrl ? `${publicRelayUrl}/admin` : `http://${host}:${boundPort}/admin`}`)
        console.log(`[relay] Static PWA dir: ${staticDir} (${existsSync(staticDir) ? 'ready' : 'not built yet'})`)
        console.log(`[relay] Email verification: ${mailer.isConfigured() ? mailer.getProvider() : 'disabled (configure SMTP_* or RESEND_API_KEY to enable)'}`)
        if (clientAccessToken === 'allinone-dev-pass' || bridgeSecret === 'allinone-dev-bridge') {
          console.warn('[relay] WARNING: Using default dev secrets! Please set CLIENT_ACCESS_TOKEN and BRIDGE_SECRET in .env before deploying publicly.')
        }
        resolveStart({ port: boundPort, host })
      })
    })

  const close = () =>
    new Promise((resolveClose) => {
      clearInterval(cleanupTimer)
      hub.shutdown()
      wss.close(() => {
        server.close(() => resolveClose())
      })
    })

  return { server, wss, hub, rooms, accounts, mailer, start, close }
}

// Run directly when invoked as main script
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const app = createRelayServer()
  app.start()
  const shutdown = () => {
    app.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
