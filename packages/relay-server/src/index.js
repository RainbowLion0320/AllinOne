import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createAuthManager, safeEqual } from './auth.js'
import { createAccountStore, normalizeMaxDailyRegistrations } from './accounts.js'
import { createEmailCodeStore } from './emailCodes.js'
import { createMailer } from './mailer.js'
import { RelayHub } from './hub.js'
import { createStunServer } from './stun-server.js'
import {
  buildTurnQuotaSnapshot,
  createTurnLogMeter,
  getTurnQuotaBytesForTier,
  parseCoturnUsageLine,
  resolveTurnQuotaConfig,
} from './turn-meter.js'
import { createCloudflareTurnProvider, normalizeCloudflareIceResponse, parseCfTurnTiers } from './cf-turn.js'
import {
  LOCAL_DEV_ORIGIN_RE,
  buildAllowedOriginsSet,
  createIpDailyRegistrationLimiter,
  createLogger,
  createOutboundEmailGate,
  createTrustedProxyChecker,
  createUserActionRateLimiter,
  loadDotEnv,
  normalizeIpForMatch,
  resolveClientIp,
  sendJson,
  setSecurityHeaders,
} from './http-utils.js'
import { createAdminRoutes } from './routes/admin.js'
import { createAuthRoutes } from './routes/auth.js'
import { buildMergedAccountDevices, buildMergedClientSessions, createDeviceRoutes } from './routes/devices.js'
import { buildTurnCredentials, createIceManager } from './routes/ice.js'
import { createStaticHandler } from './routes/static.js'
import { createWsUpgradeHandler } from './routes/ws.js'

export {
  buildTurnCredentials,
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
    return String(pkg?.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

loadDotEnv(resolve(__dirname, '../.env'))
loadDotEnv(resolve(__dirname, '../../../.env'))

function firstNonEmptyEnv(explicit, envVal, fallback) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return explicit
  if (envVal !== undefined && envVal !== null && String(envVal).trim() !== '') return envVal
  return fallback
}

export function createRelayServer(options = {}) {
  const log = options.log || createLogger('control')
  const port = Number(firstNonEmptyEnv(options.port, process.env.PORT, 8787))
  const host = String(firstNonEmptyEnv(options.host, process.env.HOST, '0.0.0.0')).trim()
  const jwtSecret = String(options.jwtSecret ?? process.env.JWT_SECRET ?? '').trim()
  const jwtSecretPrevious = String(options.jwtSecretPrevious ?? process.env.JWT_SECRET_PREVIOUS ?? '').trim()
  const adminBootstrapToken = String(options.adminBootstrapToken ?? process.env.ADMIN_BOOTSTRAP_TOKEN ?? '').trim()
  const metricsToken = String(options.metricsToken ?? process.env.METRICS_TOKEN ?? '').trim()
  const rawMaxDaily = options.maxDailyRegistrations ?? process.env.MAX_DAILY_REGISTRATIONS
  const maxDailyRegistrations = normalizeMaxDailyRegistrations(rawMaxDaily, 20)
  const maxRegPerIpPerDay = normalizeMaxDailyRegistrations(
    options.maxRegistrationsPerIpPerDay ?? process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY,
    5,
  )
  const publicRelayUrl = String(options.publicRelayUrl ?? process.env.PUBLIC_RELAY_URL ?? '').trim().replace(/\/+$/, '')
  const allowedOrigins = buildAllowedOriginsSet(
    publicRelayUrl,
    options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '',
  )
  const isTrustedProxy = createTrustedProxyChecker(options.trustProxy ?? process.env.TRUST_PROXY ?? 'loopback')
  const trustProxyHeader = String(options.trustProxyHeader ?? process.env.TRUST_PROXY_HEADER ?? '').trim()
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

  const turnSecret = String(options.turnSecret ?? process.env.TURN_SECRET ?? '').trim()
  const turnHostExplicit = String(options.turnHost ?? process.env.TURN_HOST ?? '').trim()
  const turnPortRaw = firstNonEmptyEnv(options.turnPort, process.env.TURN_PORT, '3478')
  const turnPort = Number.isInteger(Number(turnPortRaw)) && Number(turnPortRaw) > 0 ? Number(turnPortRaw) : 3478
  const turnTtlSec = Math.max(120, Number(firstNonEmptyEnv(options.turnTtlSec, process.env.TURN_TTL_SEC, 600)) || 600)
  const turnLogFile = String(
    options.turnLogFile ?? options.turnLogPath ?? process.env.TURN_LOG_PATH ?? process.env.TURN_LOG_FILE ?? '',
  ).trim()
  const turnQuotaConfig = resolveTurnQuotaConfig(options, process.env)

  const stunExplicitlyConfigured =
    options.stunPort !== undefined ||
    options.stunEnabled !== undefined ||
    String(process.env.STUN_PORT ?? '').trim() !== ''
  const rawStunPort = firstNonEmptyEnv(options.stunPort, process.env.STUN_PORT, '3478')
  const stunDisabledByConfig =
    options.stunEnabled === false ||
    String(rawStunPort).trim().toLowerCase() === 'false' ||
    String(rawStunPort).trim().toLowerCase() === 'off' ||
    String(rawStunPort).trim() === '-1'
  const candidateStunPort = stunDisabledByConfig ? -1 : Number(rawStunPort)
  const stunAutoDisabledForCoturn = Boolean(!stunExplicitlyConfigured && turnSecret && candidateStunPort === turnPort)
  const stunPort = stunDisabledByConfig || stunAutoDisabledForCoturn ? -1 : candidateStunPort
  const stunHost = String(
    firstNonEmptyEnv(options.stunHost, process.env.STUN_HOST, options.host ? options.host : '0.0.0.0'),
  ).trim()
  const stunServer =
    Number.isInteger(stunPort) && stunPort >= 0
      ? createStunServer({ port: stunPort, host: stunHost, log })
      : null

  let hubRef = null
  const cfTurn = createCloudflareTurnProvider(
    {
      ...options,
      log,
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
  const outboundEmailGate = createOutboundEmailGate({
    maxGlobalPerHour: Number(process.env.MAX_EMAILS_PER_HOUR) || 120,
  })
  const ipDailyRegLimiter = createIpDailyRegistrationLimiter({ maxPerIpPerDay: maxRegPerIpPerDay })
  const checkUserActionRateLimit = createUserActionRateLimiter()
  const startedAt = Date.now()
  let isDraining = false

  const ice = createIceManager({
    options,
    env: process.env,
    accounts,
    stunServer,
    cfTurn,
    turnSecret,
    turnHostExplicit,
    turnPort,
    turnTtlSec,
    turnQuotaConfig,
    publicRelayUrl,
    isTrustedProxy,
    getHub: () => hubRef,
    log,
  })

  const auth = createAuthManager({
    jwtSecret,
    jwtSecretPrevious,
    adminBootstrapToken,
    getTokenVersion: (roomId) => accounts.getTokenVersion(roomId),
    isSessionRevoked: (roomId, sid) => accounts.isSessionRevoked(roomId, sid),
    hasUserSession: (roomId, sid) => accounts.hasUserSession(roomId, sid),
  })

  const iceRefreshSec = Math.min(
    turnSecret ? turnTtlSec * 0.75 : Infinity,
    cfTurn.enabled ? cfTurn.ttlSec * 0.45 : Infinity,
  )
  const iceRefreshMs = Number.isFinite(iceRefreshSec) ? Math.max(60_000, Math.floor(iceRefreshSec * 1000)) : 0
  const hub = new RelayHub({
    log,
    getRoomDevices: (roomId, liveBridges) => buildMergedAccountDevices(accounts, hubRef, roomId, liveBridges),
    getIceServers: (req, roomId, fallbackHost) => ice.resolveIceServers(req, roomId, fallbackHost),
    getTurnQuota: (roomId) => ice.buildUserTurnQuota(roomId),
    iceRefreshIntervalMs: iceRefreshMs,
  })
  hubRef = hub

  const getMergedAccountDevices = (roomId, liveBridges = null) =>
    buildMergedAccountDevices(accounts, hub, roomId, liveBridges)
  const getMergedClientSessions = (roomId, opts = {}) =>
    buildMergedClientSessions(accounts, hub, roomId, opts)

  const turnMeter = turnLogFile
    ? createTurnLogMeter({
        logPath: turnLogFile,
        cursorPath: join(dirname(accounts.dbPath), 'turn-meter-cursor.json'),
        pollIntervalMs: options.turnMeterPollMs || 3_000,
        startFromBeginning: Boolean(options.turnMeterStartFromBeginning),
        log,
        onUsage: ({ userId, billedBytes }) => ice.recordTurnUsageBytes(userId, billedBytes),
      })
    : null

  function isAllowedOrigin(rawOrigin, req) {
    const origin = String(rawOrigin || '').trim()
    if (!origin) return true
    const lower = origin.replace(/\/+$/, '').toLowerCase()
    if (allowedOrigins.has(lower)) return true
    if (!isProd && LOCAL_DEV_ORIGIN_RE.test(lower)) return true
    const reqHost = String(req?.headers?.host || '').trim().toLowerCase()
    return Boolean(reqHost && (lower === `https://${reqHost}` || lower === `http://${reqHost}`))
  }

  function setCors(req, res) {
    const origin = req.headers.origin
    if (origin && isAllowedOrigin(origin, req)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bridge-Secret, X-Room-Id')
  }

  function extractBearer(req) {
    const header = req.headers.authorization || ''
    return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  }

  function getClientIp(req) {
    return resolveClientIp(req, isTrustedProxy, { trustProxyHeader })
  }

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

  const authRoutes = createAuthRoutes({
    auth,
    accounts,
    hub,
    mailer,
    emailCodes,
    outboundEmailGate,
    ipDailyRegLimiter,
    adminBootstrapToken,
    maxDailyRegistrations,
    extractBearer,
    checkUserActionRateLimit,
    getClientIp,
    getMergedAccountDevices,
    getMergedClientSessions,
    buildUserTurnQuota: ice.buildUserTurnQuota,
    resolveIceServers: ice.resolveIceServers,
    observeRequestHost: ice.observeRequestHost,
    log,
  })

  const deviceRoutes = createDeviceRoutes({
    auth,
    accounts,
    hub,
    extractBearer,
    checkUserActionRateLimit,
    getClientIp,
    authenticateBridgeInfo,
    getMergedAccountDevices,
    observeRequestHost: ice.observeRequestHost,
    log,
  })

  const adminRoutes = createAdminRoutes({
    requireAdmin,
    checkUserActionRateLimit,
    getClientIp,
    accounts,
    hub,
    mailer,
    stunServer,
    turnSecret,
    turnPort,
    turnTtlSec,
    turnLogFile,
    turnMeter,
    turnQuotaConfig,
    cfTurn,
    maxDailyRegistrations,
    startedAt,
    relayVersion: RELAY_VERSION,
    extractPublicHostname: ice.extractPublicHostname,
    buildUserTurnQuota: ice.buildUserTurnQuota,
    buildUserTurnQuotaReadOnly: ice.buildUserTurnQuotaReadOnly,
    log,
  })

  const staticHandler = createStaticHandler({
    staticDir,
    adminDashboardDir: ADMIN_DASHBOARD_DIR,
    relayVersion: RELAY_VERSION,
    publicRelayUrl,
    isTrustedProxy,
  })

  // Pure Control-Plane WebSocket server (strictly capped at 72 KB — zero data-plane relay)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 72 * 1024 })
  wss.on('error', (err) => {
    log.warn(`[control] WebSocketServer error: ${err?.message || err}`)
  })

  const wsUpgrade = createWsUpgradeHandler({
    wss,
    auth,
    accounts,
    hub,
    ice,
    getClientIp,
    isAllowedOrigin,
    authenticateBridgeInfo,
    isDraining: () => isDraining,
    maxWsPerIp: Math.max(10, Number(firstNonEmptyEnv(options.maxWsPerIp, process.env.MAX_WS_PER_IP, 120)) || 120),
    maxWsGlobal: Math.max(20, Number(firstNonEmptyEnv(options.maxWsGlobal, process.env.MAX_WS_GLOBAL, 10_000)) || 10_000),
    log,
  })

  function renderPrometheusMetrics() {
    const m = hub.getMetricsSummary()
    const sc = accounts.getScryptStats()
    const stunSt = stunServer?.getStats?.() || { enabled: false, requests: 0, dropped: 0 }
    const mem = process.memoryUsage()
    const healthy = !isDraining && accounts.isHealthy()
    return [
      '# HELP allinone_up Whether the relay server is healthy and not draining',
      '# TYPE allinone_up gauge',
      `allinone_up ${healthy ? 1 : 0}`,
      '# HELP allinone_online_bridges Currently connected PC bridges',
      '# TYPE allinone_online_bridges gauge',
      `allinone_online_bridges ${m.onlineBridgeCount}`,
      '# HELP allinone_online_clients Currently connected client terminals',
      '# TYPE allinone_online_clients gauge',
      `allinone_online_clients ${m.onlineClientCount}`,
      '# HELP allinone_active_ws_total Active WebSocket connections',
      '# TYPE allinone_active_ws_total gauge',
      `allinone_active_ws_total ${wsUpgrade.getActiveWsCount()}`,
      '# HELP allinone_signals_total Total WebRTC signaling frames relayed',
      '# TYPE allinone_signals_total counter',
      `allinone_signals_total ${m.totalSignals || 0}`,
      '# HELP allinone_scrypt_active Active scrypt password hashing workers',
      '# TYPE allinone_scrypt_active gauge',
      `allinone_scrypt_active ${sc.active}`,
      '# HELP allinone_scrypt_queued Queued scrypt password hashing jobs',
      '# TYPE allinone_scrypt_queued gauge',
      `allinone_scrypt_queued ${sc.queued}`,
      '# HELP allinone_stun_requests_total Valid STUN binding requests served',
      '# TYPE allinone_stun_requests_total counter',
      `allinone_stun_requests_total ${stunSt.requests || 0}`,
      '# HELP allinone_stun_dropped_total STUN packets dropped by rate limits',
      '# TYPE allinone_stun_dropped_total counter',
      `allinone_stun_dropped_total ${stunSt.dropped || 0}`,
      '# HELP allinone_process_rss_bytes Node.js resident set size in bytes',
      '# TYPE allinone_process_rss_bytes gauge',
      `allinone_process_rss_bytes ${mem.rss}`,
      '',
    ].join('\n')
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

      if (pathname === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true })
        return
      }

      if (pathname === '/readyz' && req.method === 'GET') {
        const sc = accounts.getScryptStats()
        const storageHealthy = accounts.isHealthy()
        const ready = !isDraining && storageHealthy && sc.queued < sc.maxQueue
        sendJson(res, ready ? 200 : 503, { ok: ready, draining: isDraining, storageHealthy })
        return
      }

      // OpenMetrics / Prometheus endpoint:
      // - If `METRICS_TOKEN` is set, require timing-safe Bearer authentication.
      // - Otherwise strictly require direct loopback with ZERO proxy forwarding headers.
      if (pathname === '/metrics' && req.method === 'GET') {
        const bearer = extractBearer(req)
        if (metricsToken) {
          if (!bearer || !safeEqual(bearer, metricsToken)) {
            sendJson(res, 401, { ok: false, error: 'Unauthorized' })
            return
          }
        } else {
          const remoteAddr = normalizeIpForMatch(req.socket?.remoteAddress || '')
          const isLoopbackRemote = remoteAddr === '127.0.0.1' || remoteAddr === '::1'
          const hasProxyHeaders = Boolean(
            req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded'],
          )
          if (!isLoopbackRemote || hasProxyHeaders) {
            sendJson(res, 403, { ok: false, error: 'Forbidden' })
            return
          }
        }
        const body = renderPrometheusMetrics()
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        })
        res.end(body)
        return
      }

      if (pathname === '/api/health' && req.method === 'GET') {
        const user = auth.verifySessionToken(extractBearer(req))
        if (!user) {
          sendJson(res, isDraining ? 503 : 200, { ok: !isDraining })
          return
        }
        const bridges = hub.getBridgeList(user.room)
        sendJson(res, isDraining ? 503 : 200, {
          ok: !isDraining,
          version: RELAY_VERSION,
          roomId: user.room,
          bridges,
          onlineBridges: bridges.filter((b) => b.online).length,
          uptimeSec: Math.round(process.uptime()),
        })
        return
      }

      if (await authRoutes.handleAuthRoute(req, res, pathname, urlObj)) return
      if (await deviceRoutes.handleDeviceRoute(req, res, pathname, urlObj)) return
      if (await adminRoutes.handleAdminRoute(req, res, pathname)) return
      if (await staticHandler.handleStaticRequest(req, res, pathname)) return

      sendJson(res, 404, { ok: false, error: 'Not Found' })
    } catch (err) {
      log.error('[relay] Unhandled HTTP request error:', { stack: err?.stack || String(err) })
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
  server.on('upgrade', wsUpgrade.handleUpgrade)

  const start = async () => {
    let stunInfo = { enabled: false, port: 0 }
    if (stunServer) {
      try {
        const bound = await stunServer.start()
        stunInfo = { enabled: true, port: bound.port }
      } catch (err) {
        log.warn(`[stun] Could not bind UDP ${stunPort} (${err?.message || err}); continuing with public STUN fallbacks`)
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
          log.info(`[control] AllinOne Control Server (v${RELAY_VERSION}, pure P2P signaling) listening on http://${host}:${boundPort}`)
          if (stunInfo.enabled) {
            log.info(`[stun] Stateless RFC 5389 STUN listening on udp://${stunHost}:${stunInfo.port}`)
          }
          const turnPublicHost = ice.extractPublicHostname(null)
          if (turnSecret && turnPublicHost) {
            log.info(
              `[turn] Dynamic HMAC-SHA1 TURN enabled (turn:${turnPublicHost}:${turnPort} udp+tcp, ttl=${turnTtlSec}s, quotas: free=${turnQuotaConfig.freeMb}MB pro=${turnQuotaConfig.proMb}MB ultra/admin=${turnQuotaConfig.ultraMb}MB)`,
            )
          }
          if (cfTurn.enabled) {
            const cfSt = cfTurn.getStats()
            log.info(
              `[cf-turn] Tiered Cloudflare Realtime TURN enabled (tiers=${cfSt.tiers.join(',')}, ttl=${cfSt.ttlSec}s, status=${cfSt.ready ? 'ready' : 'warming'})`,
            )
          }
          if (turnMeter) {
            turnMeter.start()
            log.info(`[turn-meter] Watching coturn accounting log: ${turnLogFile}`)
          }
          log.info(`[control] Admin Monitor Dashboard: ${publicRelayUrl ? `${publicRelayUrl}/admin` : `http://${host}:${boundPort}/admin`}`)
          log.info(`[control] Static PWA dir: ${staticDir} (${existsSync(staticDir) ? 'ready' : 'not built yet'})`)
          log.info(`[control] Registration: Open registration (daily limit: ${maxDailyRegistrations || 'unlimited'})`)
          log.info(`[control] Email verification: ${mailer.isConfigured() ? mailer.getProvider() : 'disabled (configure SMTP_* or RESEND_API_KEY to enable)'}`)
          if (jwtSecret.length < 16) {
            log.warn('[control] WARNING: JWT_SECRET is not set — using an ephemeral random signing key. Set JWT_SECRET (>= 16 chars) in .env before deploying publicly.')
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
      isDraining = true
      hub.shutdown()
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
      cfTurn.stop()
      turnMeter?.stop?.()
      if (stunServer) {
        try { await stunServer.close() } catch {}
      }
      accounts.close()
    })()
    return closePromise
  }

  return {
    server,
    wss,
    hub,
    accounts,
    mailer,
    stunServer,
    turnMeter,
    cfTurn,
    recordTurnUsageBytes: ice.recordTurnUsageBytes,
    start,
    close,
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const app = createRelayServer()
  app.start().catch((err) => {
    console.error(`[control] Failed to start server: ${err?.stack || err}`)
    try { app.accounts.close() } catch {}
    process.exit(1)
  })
  let shuttingDown = false
  const shutdown = (code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    app.close().finally(() => process.exit(code))
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  process.on('uncaughtException', (err) => {
    console.error(`[control] FATAL uncaughtException: ${err?.stack || err}`)
    try { app.accounts.flush() } catch {}
    shutdown(1)
  })
  process.on('unhandledRejection', (reason) => {
    console.error(`[control] FATAL unhandledRejection: ${reason?.stack || reason}`)
    try { app.accounts.flush() } catch {}
    shutdown(1)
  })
}
