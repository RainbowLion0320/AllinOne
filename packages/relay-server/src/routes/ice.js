import { createHmac } from 'node:crypto'
import { buildTurnQuotaSnapshot } from '../turn-meter.js'

export const DEFAULT_PUBLIC_STUN_SERVERS = [
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.cloudflare.com:3478',
]

const MAX_ROOM_HOST_CACHE = 5000

/**
 * Generate RFC draft-uberti-behave-turn-rest-00 time-limited HMAC-SHA1 TURN credentials
 * compatible with `coturn --use-auth-secret`.
 */
export function buildTurnCredentials({
  secret,
  userId = 'allinone',
  ttlSec = 86_400,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const cleanSecret = String(secret || '').trim()
  if (!cleanSecret) return null
  const safeTtl = Math.max(60, Math.min(7 * 86_400, Number(ttlSec) || 86_400))
  const expiry = Math.floor(Number(nowSec) || Math.floor(Date.now() / 1000)) + safeTtl
  const safeUser = String(userId || 'allinone').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'allinone'
  const username = `${expiry}:${safeUser}`
  const credential = createHmac('sha1', cleanSecret).update(username).digest('base64')
  return { username, credential, expiresAt: expiry * 1000 }
}

function parseHostnameCandidate(rawHost) {
  const clean = String(rawHost || '').split(',')[0].trim()
  if (!clean) return ''
  try {
    const parsed = new URL(`http://${clean}`).hostname
    return parsed || ''
  } catch {
    return ''
  }
}

function isLoopbackHostname(host) {
  const bare = String(host || '').replace(/^\[|\]$/g, '').toLowerCase()
  return bare === '127.0.0.1' || bare === '::1' || bare === 'localhost'
}

/**
 * Cohesive ICE / STUN / TURN / Quota manager.
 *
 * - Caches observed public hostnames from incoming HTTP/WS requests so periodic
 *   `hub.pushIceUpdate()` refreshes never wipe self-hosted STUN/TURN entries when
 *   `PUBLIC_RELAY_URL` / `TURN_HOST` are unset.
 * - Provides pure read-only quota inspection (`buildUserTurnQuotaReadOnly`) with
 *   zero outbound Cloudflare HTTP calls and zero extra SQLite queries for `/admin`.
 */
export function createIceManager({
  options = {},
  env = process.env,
  accounts,
  stunServer,
  cfTurn,
  turnSecret = '',
  turnHostExplicit = '',
  turnPort = 3478,
  turnTtlSec = 600,
  turnQuotaConfig,
  publicRelayUrl = '',
  isTrustedProxy = () => false,
  getHub = () => null,
  log = console,
}) {
  let lastObservedPublicHost = ''
  /** @type {Map<string, string>} roomId -> last observed hostname */
  const roomObservedHosts = new Map()

  function rememberHost(hostname, roomId = '') {
    if (!hostname) return
    const loopback = isLoopbackHostname(hostname)
    if (!lastObservedPublicHost || !loopback) {
      lastObservedPublicHost = hostname
    }
    const rid = String(roomId || '').trim()
    if (rid.startsWith('usr_')) {
      const existing = roomObservedHosts.get(rid)
      if (!existing || !loopback) {
        if (!existing && roomObservedHosts.size >= MAX_ROOM_HOST_CACHE) {
          const oldest = roomObservedHosts.keys().next().value
          if (oldest) roomObservedHosts.delete(oldest)
        }
        roomObservedHosts.delete(rid)
        roomObservedHosts.set(rid, hostname)
      }
    }
  }

  function observeRequestHost(req, roomId = '') {
    if (!req?.headers) return ''
    const trusted = isTrustedProxy(req.socket?.remoteAddress)
    const rawHost = (trusted && req.headers['x-forwarded-host']) || req.headers.host || ''
    const hostname = parseHostnameCandidate(rawHost)
    if (hostname) rememberHost(hostname, roomId)
    return hostname
  }

  function extractPublicHostname(req = null, roomId = '', fallbackHost = '') {
    if (turnHostExplicit) return turnHostExplicit
    if (publicRelayUrl) {
      try {
        const parsed = new URL(publicRelayUrl).hostname
        if (parsed) return parsed
      } catch {}
    }
    if (req) {
      const fromReq = observeRequestHost(req, roomId)
      if (fromReq) return fromReq
    }
    if (fallbackHost) {
      const parsedFallback = parseHostnameCandidate(fallbackHost)
      if (parsedFallback) return parsedFallback
    }
    const rid = String(roomId || '').trim()
    if (rid && roomObservedHosts.has(rid)) {
      return roomObservedHosts.get(rid)
    }
    return lastObservedPublicHost
  }

  /**
   * Pure read-only quota snapshot from already-loaded user data.
   * Zero SQLite queries and zero outbound Cloudflare TURN HTTP requests.
   */
  function buildUserTurnQuotaFromData(user) {
    if (!user) return null
    const userId = String(user.userId || '').trim()
    const tier = user.tier || (user.role === 'admin' ? 'admin' : 'free')
    const usage = user.turnUsage && typeof user.turnUsage === 'object' ? user.turnUsage : { month: '', bytes: 0 }
    const snap = buildTurnQuotaSnapshot({
      tier,
      month: usage.month,
      usedBytes: usage.bytes,
      config: turnQuotaConfig,
    })
    const cfActive = Boolean(cfTurn.appliesToTier(snap.tier) && cfTurn.isReady(userId))
    return {
      ...snap,
      ...(cfActive ? { exceeded: false } : {}),
      provider: cfActive ? 'cloudflare' : turnSecret ? 'self-hosted' : 'none',
    }
  }

  function buildUserTurnQuota(roomId) {
    const rid = String(roomId || '').trim()
    if (!rid.startsWith('usr_')) return null
    const user = accounts.getUserById(rid)
    if (!user) {
      const usage = accounts.getTurnUsage(rid)
      return buildUserTurnQuotaFromData({ userId: rid, tier: 'free', turnUsage: usage })
    }
    return buildUserTurnQuotaFromData(user)
  }

  function buildUserTurnQuotaReadOnly(userOrRoomId) {
    if (userOrRoomId && typeof userOrRoomId === 'object') {
      return buildUserTurnQuotaFromData(userOrRoomId)
    }
    return buildUserTurnQuota(userOrRoomId)
  }

  function resolveIceServers(req = null, scopeId = '', fallbackHost = '') {
    if (Array.isArray(options.iceServers)) {
      return options.iceServers
    }
    const envIce = String(env.ICE_SERVERS || '').trim()
    if (envIce) {
      return envIce
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((urls) => ({ urls }))
    }

    const publicHost = extractPublicHostname(req, scopeId, fallbackHost)
    const bareHost = publicHost ? publicHost.replace(/^\[|\]$/g, '') : ''
    const formattedHost = bareHost && bareHost.includes(':') ? `[${bareHost}]` : bareHost
    const stunStats = stunServer?.getStats?.()
    const quota = scopeId ? buildUserTurnQuota(scopeId) : null

    // Mode 0: Tiered Cloudflare Realtime TURN (isolated per-user credentials)
    if (cfTurn.enabled && quota && cfTurn.appliesToTier(quota.tier)) {
      const cfEntry = cfTurn.getIceEntry(scopeId)
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
      if (!cfTurn.fallbackSelfHosted) {
        if (formattedHost && (turnSecret || (stunStats?.enabled && stunStats.port > 0))) {
          return [{ urls: `stun:${formattedHost}:${turnSecret ? turnPort : stunStats.port}` }]
        }
        return DEFAULT_PUBLIC_STUN_SERVERS.map((u) => ({ urls: u }))
      }
    }

    // Mode 1: Hardened self-hosted coturn
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

    // Mode 3: Public STUN fallback
    return DEFAULT_PUBLIC_STUN_SERVERS.map((u) => ({ urls: u }))
  }

  function recordTurnUsageBytes(userId, billedBytes) {
    const rid = String(userId || '').trim()
    if (!rid.startsWith('usr_') || !Number.isFinite(billedBytes) || billedBytes <= 0) return null
    const before = buildUserTurnQuota(rid)
    const updated = accounts.addTurnUsage(rid, billedBytes)
    if (!updated) return null
    const after = buildUserTurnQuota(rid)
    if (!before?.exceeded && after?.exceeded) {
      const targetUser = accounts.getUserById(rid)
      log.info?.(
        `[turn-meter] User ${targetUser ? `@${targetUser.username}` : rid} (${after.tier}) reached monthly TURN quota (${after.usedBytes}/${after.quotaBytes} B); switching to P2P-only`,
      )
      const hub = getHub()
      hub?.recordActivity({
        type: 'turn.quota_exceeded',
        roomId: rid,
        label: targetUser ? `@${targetUser.username}` : rid,
        detail: `${after.tier.toUpperCase()} monthly TURN limit reached`,
      })
      hub?.pushIceUpdate(rid, { quotaExceeded: true })
    }
    return after
  }

  return {
    observeRequestHost,
    extractPublicHostname,
    buildUserTurnQuota,
    buildUserTurnQuotaReadOnly,
    resolveIceServers,
    recordTurnUsageBytes,
  }
}
