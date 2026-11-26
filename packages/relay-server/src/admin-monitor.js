import os from 'node:os'
import { APP_LIST } from '@allinone/shared'

const ALLOWED_APPS = new Set(APP_LIST)

function normalizeApps(rawApps) {
  if (!Array.isArray(rawApps)) return []
  const out = []
  const seen = new Set()
  for (const item of rawApps) {
    if (!item) continue
    if (typeof item === 'string') {
      const app = item.trim()
      if (!ALLOWED_APPS.has(app) || seen.has(app)) continue
      seen.add(app)
      out.push({ app, available: true, writable: true })
    } else if (typeof item === 'object' && typeof item.app === 'string') {
      const app = item.app.trim()
      if (!ALLOWED_APPS.has(app) || seen.has(app)) continue
      seen.add(app)
      out.push({
        app,
        available: Boolean(item.available),
        writable: Boolean(item.writable),
      })
    }
    if (out.length >= APP_LIST.length) break
  }
  return out
}

function normalizePlatformBucket(platform) {
  const p = String(platform || '').toLowerCase()
  if (p.includes('darwin') || p.includes('mac')) return 'darwin'
  if (p.startsWith('win') || p === 'windows') return 'win32'
  if (p.includes('linux')) return 'linux'
  return 'other'
}

/**
 * Compute an on-demand server resource snapshot.
 * Zero background polling timers — only runs when an admin opens or refreshes `/admin`.
 */
export function collectServerHealth({
  mailer = null,
  stun = null,
  turn = null,
  dailyRegistration = null,
  startedAt = Date.now(),
  version = '1.0.24',
} = {}) {
  const mem = process.memoryUsage()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = Math.max(0, totalMem - freeMem)
  const cpus = os.cpus() || []
  const loadAvg = os.loadavg() || [0, 0, 0]

  return {
    version,
    mode: 'p2p-only',
    startedAt,
    now: Date.now(),
    node: {
      version: process.version,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external || 0,
    },
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      uptimeSec: Math.round(os.uptime()),
      cpuCount: cpus.length || 1,
      cpuModel: cpus[0]?.model ? String(cpus[0].model).trim() : '',
      loadAvg: loadAvg.map((v) => Number(Number(v || 0).toFixed(2))),
      totalMemBytes: totalMem,
      freeMemBytes: freeMem,
      usedMemBytes: usedMem,
      memUsagePct: totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0,
    },
    stun: stun || { enabled: false, port: 0, requests: 0 },
    turn: turn || { enabled: false, host: '', port: 0 },
    config: {
      openRegistration: true,
      dailyRegistration: dailyRegistration || null,
    },
    features: {
      emailEnabled: Boolean(mailer?.isConfigured?.()),
      emailProvider: mailer?.getProvider?.() || 'none',
      openRegistration: true,
      p2pOnly: true,
    },
  }
}

/**
 * Assemble a complete, read-only admin monitoring snapshot of all users, bound PCs,
 * controlling client sessions, live connections, daily registration quota, and recent events.
 */
export function buildAdminOverview({
  accounts,
  hub,
  serverHealth,
  dailyRegistration = null,
  getTurnQuota = null,
  currentAdminRoom = '',
  currentAdminSid = '',
} = {}) {
  const now = Date.now()
  const cutoff24h = now - 24 * 60 * 60 * 1000

  const rawUsers = accounts.listUsersForAdmin()
  const allBridges = hub.getAllBridges()
  const allClients = hub.getAllClients()
  const metrics = hub.getMetricsSummary()

  // Index username by roomId (`usr_*`) for enriching live connections & activity log
  const ownerNameByRoom = new Map()
  for (const u of rawUsers) {
    ownerNameByRoom.set(u.userId, `@${u.username}`)
  }

  // Group live bridges & clients by roomId
  const bridgesByRoom = new Map()
  for (const b of allBridges) {
    const arr = bridgesByRoom.get(b.roomId) || []
    arr.push(b)
    bridgesByRoom.set(b.roomId, arr)
  }

  const clientsByRoom = new Map()
  for (const c of allClients) {
    const arr = clientsByRoom.get(c.roomId) || []
    arr.push(c)
    clientsByRoom.set(c.roomId, arr)
  }

  // Distributions across online connections
  const appStats = Object.create(null)
  for (const appId of APP_LIST) {
    appStats[appId] = { available: 0, writable: 0 }
  }
  const bridgePlatforms = { win32: 0, darwin: 0, linux: 0, other: 0 }
  const clientKinds = { desktop: 0, mobile: 0, web: 0 }

  for (const b of allBridges) {
    if (!b.online) continue
    bridgePlatforms[normalizePlatformBucket(b.platform)] += 1
    for (const a of normalizeApps(b.apps)) {
      if (!ALLOWED_APPS.has(a.app)) continue
      if (!appStats[a.app]) appStats[a.app] = { available: 0, writable: 0 }
      if (a.available) appStats[a.app].available += 1
      if (a.writable) appStats[a.app].writable += 1
    }
  }

  for (const c of allClients) {
    const kind = c.clientKind === 'desktop' || c.clientKind === 'mobile' ? c.clientKind : 'web'
    clientKinds[kind] += 1
  }

  const userStatusDist = { active: 0, bridgeOnly: 0, clientOnly: 0, offline: 0 }
  let totalBoundDevices = 0
  let recent24hUsers = 0
  let totalTurnUsedBytes = 0

  const users = rawUsers.map((u) => {
    const roomBridges = bridgesByRoom.get(u.userId) || []
    const roomClients = clientsByRoom.get(u.userId) || []
    const rStats = hub.getRoomStats(u.userId)
    const tier = u.tier || (u.role === 'admin' ? 'admin' : 'free')
    const turnQuota = typeof getTurnQuota === 'function' ? getTurnQuota(u.userId) : null
    totalTurnUsedBytes += Number(turnQuota?.usedBytes ?? u.turnUsage?.bytes ?? 0)

    const liveBridgeById = new Map(roomBridges.map((b) => [b.bridgeId, b]))
    const mergedDevices = (u.devices || []).map((dev) => {
      const live = liveBridgeById.get(dev.bridgeId)
      const normApps = normalizeApps(live?.apps)
      return {
        deviceId: dev.deviceId,
        bridgeId: dev.bridgeId,
        label: dev.label || live?.hostname || dev.hostname || dev.bridgeId,
        hostname: live?.hostname || dev.hostname || dev.bridgeId,
        platform: live?.platform || dev.platform || 'unknown',
        mode: live?.mode || 'portable',
        ip: live?.ip || '',
        online: Boolean(live?.online),
        apps: normApps,
        connectedAt: live?.connectedAt || 0,
        lastSeenAt: live?.lastSeen || dev.lastSeenAt || dev.createdAt || 0,
        createdAt: dev.createdAt || 0,
      }
    })
    mergedDevices.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    totalBoundDevices += mergedDevices.length

    // Merge persisted + live controlling client sessions
    const liveBySid = new Map()
    for (const c of roomClients) {
      if (!c.sid) continue
      const arr = liveBySid.get(c.sid) || []
      arr.push(c)
      liveBySid.set(c.sid, arr)
    }

    const sessions = []
    const seenSids = new Set()
    for (const p of u.sessions || []) {
      seenSids.add(p.sid)
      const conns = liveBySid.get(p.sid) || []
      const newest = conns[0] || null
      sessions.push({
        sid: p.sid,
        clientId: newest?.clientId || '',
        connectionCount: conns.length,
        deviceName: newest?.deviceName || p.deviceName || 'Web Client',
        clientKind: newest?.clientKind || p.clientKind || 'web',
        ip: newest?.ip || p.ip || '',
        online: conns.length > 0,
        isCurrentAdmin: Boolean(currentAdminRoom === u.userId && currentAdminSid && p.sid === currentAdminSid),
        createdAt: p.createdAt || newest?.connectedAt || 0,
        lastSeenAt: newest?.lastSeenAt || p.lastSeenAt || p.createdAt || 0,
      })
    }
    for (const [sid, conns] of liveBySid.entries()) {
      if (seenSids.has(sid)) continue
      const newest = conns[0]
      sessions.push({
        sid,
        clientId: newest.clientId,
        connectionCount: conns.length,
        deviceName: newest.deviceName || 'Web Client',
        clientKind: newest.clientKind || 'web',
        ip: newest.ip || '',
        online: true,
        isCurrentAdmin: Boolean(currentAdminRoom === u.userId && currentAdminSid && sid === currentAdminSid),
        createdAt: newest.connectedAt || 0,
        lastSeenAt: newest.lastSeenAt || newest.connectedAt || 0,
      })
    }
    sessions.sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0))

    const onlineBridgeCount = mergedDevices.filter((d) => d.online).length
    const onlineClientCount = roomClients.length
    const onlineSessionCount = sessions.filter((s) => s.online).length

    let status = 'offline'
    if (onlineBridgeCount > 0 && onlineClientCount > 0) {
      status = 'active'
      userStatusDist.active += 1
    } else if (onlineBridgeCount > 0) {
      status = 'bridge_only'
      userStatusDist.bridgeOnly += 1
    } else if (onlineClientCount > 0) {
      status = 'client_only'
      userStatusDist.clientOnly += 1
    } else {
      userStatusDist.offline += 1
    }

    // Aggregate deduplicated ready AI tools across this user's online bridges
    const userAppMap = new Map()
    for (const dev of mergedDevices) {
      if (!dev.online) continue
      for (const a of dev.apps) {
        if (!a.available) continue
        const prev = userAppMap.get(a.app)
        if (!prev || (!prev.writable && a.writable)) {
          userAppMap.set(a.app, { app: a.app, available: true, writable: a.writable })
        }
      }
    }

    const lastActivityAt = Math.max(
      u.lastLoginAt || 0,
      rStats.lastActivityAt || 0,
      ...mergedDevices.map((d) => d.lastSeenAt || 0),
      ...sessions.map((s) => s.lastSeenAt || 0),
    )

    if (status !== 'offline' || lastActivityAt >= cutoff24h) {
      recent24hUsers += 1
    }

    return {
      userId: u.userId,
      username: u.username,
      email: u.email || '',
      emailVerified: Boolean(u.emailVerified),
      role: u.role,
      tier,
      turnQuota,
      isCurrentAdmin: currentAdminRoom === u.userId,
      tokenVersion: u.tokenVersion,
      createdAt: u.createdAt || 0,
      lastLoginAt: u.lastLoginAt || 0,
      status,
      onlineBridgeCount,
      totalDeviceCount: mergedDevices.length,
      onlineClientCount,
      onlineSessionCount,
      totalSessionCount: sessions.length,
      lastActivityAt,
      apps: [...userAppMap.values()],
      stats: rStats,
      devices: mergedDevices,
      sessions,
    }
  })

  // Sort default: active > bridge_only > client_only > offline, then most recent activity
  const statusRank = { active: 3, bridge_only: 2, client_only: 1, offline: 0 }
  users.sort(
    (a, b) =>
      statusRank[b.status] - statusRank[a.status] ||
      (b.lastActivityAt || 0) - (a.lastActivityAt || 0) ||
      (b.createdAt || 0) - (a.createdAt || 0),
  )

  const liveBridges = allBridges
    .filter((b) => b.online)
    .map((b) => ({
      ...b,
      apps: normalizeApps(b.apps),
      ownerLabel: ownerNameByRoom.get(b.roomId) || b.roomId,
    }))

  const liveClients = allClients.map((c) => ({
    ...c,
    ownerLabel: ownerNameByRoom.get(c.roomId) || c.roomId,
    isCurrentAdmin: Boolean(currentAdminRoom === c.roomId && currentAdminSid && c.sid === currentAdminSid),
  }))

  const resolvedDailyRegistration =
    dailyRegistration ||
    serverHealth?.config?.dailyRegistration ||
    accounts?.getDailyRegistrationStats?.() ||
    null

  const activity = hub.getActivityLog(80).map((item) => ({
    ...item,
    ownerLabel: item.roomId ? ownerNameByRoom.get(item.roomId) || item.roomId : '',
  }))

  const onlineUsers = userStatusDist.active + userStatusDist.bridgeOnly + userStatusDist.clientOnly

  return {
    ok: true,
    generatedAt: now,
    server: serverHealth,
    summary: {
      totalUsers: users.length,
      onlineUsers,
      activeUsers: userStatusDist.active,
      bridgeOnlyUsers: userStatusDist.bridgeOnly,
      clientOnlyUsers: userStatusDist.clientOnly,
      offlineUsers: userStatusDist.offline,
      recent24hUsers,
      onlineBridges: metrics.onlineBridgeCount,
      totalBoundDevices,
      onlineClients: metrics.onlineClientCount,
      totalSignals: metrics.totalSignals || 0,
      totalTurnUsedBytes,
      totalBridgeConnects: metrics.totalBridgeConnects,
      totalClientConnects: metrics.totalClientConnects,
      dailyRegistration: resolvedDailyRegistration,
    },
    distributions: {
      userStatus: userStatusDist,
      apps: appStats,
      bridgePlatforms,
      clientKinds,
    },
    users,
    liveBridges,
    liveClients,
    activity,
  }
}
