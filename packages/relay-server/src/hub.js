import { randomUUID } from 'node:crypto'
import { EVENTS } from '@allinone/shared'
import { E2EE_EVENT_MARKER, E2EE_METHOD_MARKER } from '@allinone/shared/e2ee'

const EVENT_BUFFER_SIZE = 200
const DEFAULT_RPC_TIMEOUT_MS = 300_000
const ACTIVITY_LOG_MAX = 80
const ROOM_STATS_MAX = 2000
const ROOM_EVENTS_MAX = 2000
const MAX_CACHED_EVENT_BYTES = 512 * 1024
const MAX_PENDING_RPC_PER_ROOM = 200
const E2EE_GRANT_TTL_MS = 120_000
const E2EE_GRANT_MAX_PER_ROOM = 8
const E2EE_GRANT_SWEEP_MS = 15_000
const WS_HEARTBEAT_INTERVAL_MS = 30_000
const MAX_CLIENTS_PER_ROOM = 30
const MAX_BRIDGES_PER_ROOM = 16

/**
 * Parse raw client `dev` tag and HTTP `User-Agent` into a clean human-readable device name & category.
 * Handles both explicit labels from v0.3.9+ clients and raw legacy `Mozilla/5.0 ...` strings.
 */
export function parseClientDeviceInfo(rawDev = '', userAgent = '', explicitKind = '') {
  const dev = String(rawDev || '').trim()
  const ua = String(userAgent || '').trim()
  const cleanKind = explicitKind === 'desktop' || explicitKind === 'mobile' || explicitKind === 'web'
    ? explicitKind
    : ''

  // If caller already sent a clean explicit label (not raw Mozilla/5.0 UA or generic 'mobile')
  const looksLikeRawUa = /^Mozilla\//i.test(dev) || /AppleWebKit|Gecko\//i.test(dev)
  if (dev && !looksLikeRawUa && dev.toLowerCase() !== 'mobile') {
    let kind = cleanKind
    if (!kind) {
      if (/desktop|桌面|electron/i.test(dev)) kind = 'desktop'
      else if (/android|iphone|ipad|ios|phone|手机/i.test(dev)) kind = 'mobile'
      else kind = 'web'
    }
    return { deviceName: dev.slice(0, 64), clientKind: kind }
  }

  const probe = `${ua} ${dev}`
  const isElectron = /Electron\//i.test(probe)
  const isAndroid = /Android/i.test(probe)
  const isIPhone = /iPhone/i.test(probe)
  const isIPad = /iPad/i.test(probe)
  const isMac = /Macintosh|Mac OS X/i.test(probe)
  const isWindows = /Windows NT/i.test(probe)
  const isLinux = /Linux/i.test(probe) && !isAndroid

  let osLabel = ''
  if (isIPhone) osLabel = 'iPhone'
  else if (isIPad) osLabel = 'iPad'
  else if (isAndroid) osLabel = 'Android'
  else if (isWindows) osLabel = 'Windows'
  else if (isMac) osLabel = 'macOS'
  else if (isLinux) osLabel = 'Linux'

  if (isElectron || cleanKind === 'desktop') {
    return {
      deviceName: osLabel ? `${osLabel} Desktop` : 'Desktop App',
      clientKind: 'desktop',
    }
  }

  // Android WebView (Capacitor native APK) typically has `; wv)` in UA
  if (isAndroid && (/; wv\)/i.test(probe) || cleanKind === 'mobile')) {
    return { deviceName: 'Android App', clientKind: 'mobile' }
  }

  let browser = ''
  if (/Edg\//i.test(probe)) browser = 'Edge'
  else if (/Chrome\//i.test(probe) && !/Edg\//i.test(probe)) browser = 'Chrome'
  else if (/Firefox\//i.test(probe)) browser = 'Firefox'
  else if (/Safari\//i.test(probe) && !/Chrome\//i.test(probe)) browser = 'Safari'

  if (isIPhone || isIPad || isAndroid) {
    return {
      deviceName: browser ? `${osLabel} · ${browser}` : osLabel,
      clientKind: 'mobile',
    }
  }

  if (osLabel) {
    return {
      deviceName: browser ? `${osLabel} · ${browser}` : osLabel,
      clientKind: cleanKind || 'web',
    }
  }

  return {
    deviceName: dev && !looksLikeRawUa ? dev.slice(0, 64) : 'Web Client',
    clientKind: cleanKind || 'web',
  }
}

/**
 * Strictly account-isolated, zero-knowledge E2EE WebSocket hub connecting:
 *  - PC Bridges (each bound to a single account `roomId`: `'usr_<id>'`, mandatory E2EE)
 *  - Mobile/Desktop/Web clients (each JWT-bound to a single account `roomId`)
 *
 * Guarantees Account A can NEVER see Account B's bridges, events, RPCs, or files,
 * and Relay NEVER forwards plaintext RPCs or bridge events.
 */
export class RelayHub {
  constructor({ log = console, getRoomDevices = null, trafficGuard = null, isAdminRoom = null, getRoomTier = null } = {}) {
    this.log = log
    this.getRoomDevices = typeof getRoomDevices === 'function' ? getRoomDevices : null
    this.trafficGuard = trafficGuard || null
    this.isAdminRoom = typeof isAdminRoom === 'function' ? isAdminRoom : () => false
    this.getRoomTier = typeof getRoomTier === 'function'
      ? getRoomTier
      : (rid) => (this.isAdminRoom(rid) ? 'admin' : 'free')
    /** @type {Map<string, { roomId: string, bridgeId: string, ws: import('ws').WebSocket, meta: any, connectedAt: number, lastSeen: number }>} */
    this.bridges = new Map() // key = `${roomId}::${bridgeId}`
    /** @type {Map<string, { roomId: string, ws: import('ws').WebSocket, user: any, connectedAt: number }>} */
    this.clients = new Map()
    /** @type {Map<string, Set<string>>} Secondary index for O(1) per-room event fan-out */
    this.roomClients = new Map()
    /** @type {Map<string, any>} */
    this.pendingRpc = new Map()
    /** @type {Map<string, { seq: number, buffer: any[] }>} */
    this.roomEvents = new Map()
    /** @type {Map<string, { rpcCount: number, eventCount: number, lastActivityAt: number, lastRpcMethod: string, lastRpcAt: number }>} */
    this.roomStats = new Map()
    this.globalStats = {
      startedAt: Date.now(),
      totalRpcs: 0,
      totalEvents: 0,
      totalBridgeConnects: 0,
      totalClientConnects: 0,
    }
    /** @type {Array<{ id: number, ts: number, type: string, roomId: string, label: string, detail: string, ip: string }>} */
    this.activityLog = []
    this._activitySeq = 0
    /**
     * Ephemeral, strictly room-scoped zero-knowledge E2EE device key-grant requests.
     * Stores ONLY ephemeral P-256 public keys & metadata for up to 120s (never plaintext secrets).
     * @type {Map<string, any>}
     */
    this.e2eeGrants = new Map()

    // Periodic sweep so expired E2EE grant requests actively emit E2EE_GRANT_CANCEL (reason: 'expired')
    this._grantSweepTimer = setInterval(() => {
      if (this.e2eeGrants.size > 0) this.pruneExpiredGrants()
    }, E2EE_GRANT_SWEEP_MS)
    this._grantSweepTimer.unref()

    // Server-side WS ping/pong liveness heartbeat (reaps half-open/dead TCP sockets)
    this._heartbeatTimer = setInterval(() => {
      for (const entry of this.bridges.values()) {
        if (entry.ws.readyState !== 1) continue
        if (entry.isAlive === false) {
          this.log.warn?.(`[relay] Bridge heartbeat timeout: room=${entry.roomId} id=${entry.bridgeId}`)
          try { entry.ws.terminate() } catch {}
          continue
        }
        entry.isAlive = false
        try { entry.ws.ping() } catch {}
      }
      for (const [cid, entry] of this.clients.entries()) {
        if (entry.ws.readyState !== 1) continue
        if (entry.isAlive === false) {
          this.log.warn?.(`[relay] Client heartbeat timeout: room=${entry.roomId} client=${cid}`)
          try { entry.ws.terminate() } catch {}
          continue
        }
        entry.isAlive = false
        try { entry.ws.ping() } catch {}
      }
    }, WS_HEARTBEAT_INTERVAL_MS)
    this._heartbeatTimer.unref()
  }

  pruneExpiredGrants(now = Date.now()) {
    for (const [reqId, g] of this.e2eeGrants.entries()) {
      if (now >= g.expiresAt || !this.clients.has(g.requesterClientId)) {
        this.e2eeGrants.delete(reqId)
        this.pushRoomGrantEvent(g.roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId, reason: 'expired' })
      }
    }
  }

  sanitizeGrantPublic(g) {
    return {
      reqId: g.reqId,
      roomId: g.roomId,
      requesterClientId: g.requesterClientId,
      deviceName: g.deviceName,
      clientKind: g.clientKind,
      ip: g.ip,
      pubKey: g.pubKey,
      wantedKeyId: g.wantedKeyId || '',
      createdAt: g.createdAt,
      expiresAt: g.expiresAt,
    }
  }

  getPendingGrantsForClient(roomId, excludeClientId = '') {
    const rid = String(roomId || '').trim()
    if (!rid) return []
    const now = Date.now()
    this.pruneExpiredGrants(now)
    const out = []
    for (const g of this.e2eeGrants.values()) {
      if (g.roomId !== rid) continue
      if (excludeClientId && g.requesterClientId === excludeClientId) continue
      if (g.expiresAt <= now) continue
      out.push(this.sanitizeGrantPublic(g))
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  _indexRoomClient(roomId, clientId) {
    let set = this.roomClients.get(roomId)
    if (!set) {
      set = new Set()
      this.roomClients.set(roomId, set)
    }
    set.add(clientId)
  }

  _unindexRoomClient(roomId, clientId) {
    const set = this.roomClients.get(roomId)
    if (!set) return
    set.delete(clientId)
    if (set.size === 0) {
      this.roomClients.delete(roomId)
    }
  }

  _getRoomClientEntries(roomId) {
    const set = this.roomClients.get(roomId)
    if (!set || set.size === 0) return []
    const out = []
    for (const cid of set) {
      const c = this.clients.get(cid)
      if (c) out.push([cid, c])
      else set.delete(cid)
    }
    if (set.size === 0) this.roomClients.delete(roomId)
    return out
  }

  pushRoomGrantEvent(roomId, event, payload, excludeClientId = '') {
    const rid = String(roomId || '').trim()
    if (!rid) return
    const entries = this._getRoomClientEntries(rid)
    if (entries.length === 0) return
    const frame = JSON.stringify({
      type: 'event',
      ts: Date.now(),
      bridgeId: '',
      event,
      payload,
    })
    for (const [cid, c] of entries) {
      if (c.ws.readyState !== 1) continue
      if (excludeClientId && cid === excludeClientId) continue
      try { c.ws.send(frame) } catch {}
    }
  }

  cancelClientGrants(clientId, reason = 'disconnected') {
    for (const [reqId, g] of this.e2eeGrants.entries()) {
      if (g.requesterClientId === clientId) {
        this.e2eeGrants.delete(reqId)
        this.pushRoomGrantEvent(g.roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId, reason }, clientId)
      } else if (g.offeredByClientId === clientId) {
        g.offeredByClientId = ''
        g.approverPubKey = ''
        this.sendToClient(g.requesterClientId, {
          type: 'event',
          ts: Date.now(),
          bridgeId: '',
          event: EVENTS.E2EE_GRANT_CANCEL,
          payload: { reqId, reason: 'approver_disconnected', reopen: true },
        })
      }
    }
  }

  failPendingRpcsForBridgeWs(bridgeWs, bridgeKey = '') {
    for (const [relayReqId, pending] of this.pendingRpc.entries()) {
      const match = pending.bridgeWs
        ? pending.bridgeWs === bridgeWs
        : Boolean(bridgeKey && pending.bridgeKey === bridgeKey)
      if (match) {
        clearTimeout(pending.timer)
        this.pendingRpc.delete(relayReqId)
        this.sendToClient(pending.clientId, {
          type: 'rpc.res',
          id: pending.clientReqId,
          ok: false,
          error: { code: 'BRIDGE_DISCONNECTED', message: '电脑端连接已断开，请稍后重试' },
        })
      }
    }
  }

  clearPendingRpcsForClient(clientId) {
    if (!clientId) return
    for (const [relayReqId, pending] of this.pendingRpc.entries()) {
      if (pending.clientId === clientId) {
        clearTimeout(pending.timer)
        this.pendingRpc.delete(relayReqId)
      }
    }
  }

  getOrCreateRoomStats(roomId) {
    const rid = String(roomId || '').trim()
    let st = this.roomStats.get(rid)
    if (!st) {
      if (this.roomStats.size >= ROOM_STATS_MAX) {
        const oldestKey = this.roomStats.keys().next().value
        if (oldestKey) this.roomStats.delete(oldestKey)
      }
      st = { rpcCount: 0, eventCount: 0, lastActivityAt: 0, lastRpcMethod: '', lastRpcAt: 0 }
      this.roomStats.set(rid, st)
    }
    return st
  }

  getRoomStats(roomId) {
    const rid = String(roomId || '').trim()
    const st = this.roomStats.get(rid)
    const base = st
      ? { ...st }
      : { rpcCount: 0, eventCount: 0, lastActivityAt: 0, lastRpcMethod: '', lastRpcAt: 0 }
    if (this.trafficGuard) {
      let tier = 'free'
      try {
        tier = String(this.getRoomTier(rid) || 'free')
      } catch {}
      base.traffic = this.trafficGuard.getRoomUsage(rid, tier)
    }
    return base
  }

  getRoomFileLimits(roomId) {
    const rid = String(roomId || '').trim()
    let tier = 'free'
    try {
      tier = String(this.getRoomTier(rid) || 'free')
    } catch {}
    if (this.trafficGuard && typeof this.trafficGuard.getLimitsForTier === 'function') {
      const lim = this.trafficGuard.getLimitsForTier(tier)
      return {
        tier: lim.tier,
        maxUploadBytes: lim.maxUploadBytes,
        maxImageBytes: lim.maxImageBytes,
        maxDocumentBytes: lim.maxDocumentBytes,
      }
    }
    return {
      tier,
      maxUploadBytes: 15 * 1024 * 1024,
      maxImageBytes: 15 * 1024 * 1024,
      maxDocumentBytes: 10 * 1024 * 1024,
    }
  }

  notifyRoomTierChanged(roomId) {
    const rid = String(roomId || '').trim()
    if (!rid) return
    const info = this.getRoomFileLimits(rid)
    const msg = {
      type: 'tier.update',
      roomId: rid,
      tier: info.tier,
      fileLimits: {
        maxUploadBytes: info.maxUploadBytes,
        maxImageBytes: info.maxImageBytes,
        maxDocumentBytes: info.maxDocumentBytes,
      },
      ts: Date.now(),
    }
    for (const b of this.bridges.values()) {
      if (b.roomId === rid && b.ws.readyState === 1) {
        this.sendRaw(b.ws, msg)
      }
    }
    for (const [, c] of this._getRoomClientEntries(rid)) {
      if (c.ws.readyState === 1) {
        this.sendRaw(c.ws, msg)
      }
    }
  }

  getTrafficSummary() {
    if (!this.trafficGuard) {
      return {
        monthKey: '',
        totalBytes10m: 0,
        totalBytes24h: 0,
        totalBytesMonth: 0,
        totalBytesLifetime: 0,
        totalThrottledCount: 0,
        limits: { burst10mBytes: 0, daily24hBytes: 0, monthlyBytes: 0, proMonthlyBytes: 0, uploadPerMin: 0, adminExempt: true },
      }
    }
    return this.trafficGuard.getGlobalSummary()
  }

  checkRoomTraffic(roomId, bytes, { sourceLabel = '', ip = '' } = {}) {
    if (!this.trafficGuard || !roomId) return { allowed: true, hardKick: false }
    let tier = 'free'
    try {
      tier = String(this.getRoomTier(roomId) || 'free')
    } catch {}
    const res = this.trafficGuard.consumeBytes(roomId, bytes, { tier })
    if (!res.allowed) {
      this.recordActivity({
        type: 'traffic.throttled',
        roomId,
        label: sourceLabel || 'ws',
        detail: `${res.code || 'TRAFFIC_QUOTA_EXCEEDED'}${res.quotaWindow ? `/${res.quotaWindow}` : ''} [${tier}] (${Math.round((Number(bytes) || 0) / 1024)}KB)`,
        ip,
      })
    }
    return res
  }

  recordActivity({ type, roomId = '', label = '', detail = '', ip = '' } = {}) {
    this._activitySeq += 1
    this.activityLog.push({
      id: this._activitySeq,
      ts: Date.now(),
      type: String(type || 'info').slice(0, 32),
      roomId: String(roomId || '').slice(0, 64),
      label: String(label || '').slice(0, 64),
      detail: String(detail || '').slice(0, 120),
      ip: String(ip || '').slice(0, 64),
    })
    if (this.activityLog.length > ACTIVITY_LOG_MAX) {
      this.activityLog.splice(0, this.activityLog.length - ACTIVITY_LOG_MAX)
    }
  }

  getActivityLog(limit = 60) {
    const n = Math.max(1, Math.min(ACTIVITY_LOG_MAX, Math.floor(Number(limit) || 60)))
    return this.activityLog.slice(-n).reverse()
  }

  getAllBridges() {
    const out = []
    for (const b of this.bridges.values()) {
      out.push({
        roomId: b.roomId,
        bridgeId: b.bridgeId,
        deviceId: b.meta?.deviceId || '',
        label: b.meta?.label || b.meta?.hostname || b.bridgeId,
        online: b.ws.readyState === 1,
        hostname: b.meta?.hostname || b.bridgeId,
        platform: b.meta?.platform || 'unknown',
        mode: b.meta?.mode || 'dsh-plugin',
        ip: b.meta?.ip || '',
        apps: Array.isArray(b.meta?.apps) ? b.meta.apps : [],
        e2ee: b.meta?.e2ee || null,
        connectedAt: b.connectedAt,
        lastSeen: b.lastSeen,
      })
    }
    return out.sort((a, b) => Number(b.online) - Number(a.online) || (b.connectedAt || 0) - (a.connectedAt || 0))
  }

  getAllClients() {
    const out = []
    for (const [clientId, c] of this.clients.entries()) {
      if (c.ws.readyState !== 1) continue
      out.push({
        clientId,
        roomId: c.roomId,
        sid: c.sid || '',
        deviceName: c.deviceName || 'Web Client',
        clientKind: c.clientKind || 'web',
        ip: c.ip || '',
        connectedAt: c.connectedAt,
        lastSeenAt: c.lastSeenAt || c.connectedAt,
        online: true,
      })
    }
    return out.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0))
  }

  getMetricsSummary() {
    let onlineClients = 0
    for (const c of this.clients.values()) {
      if (c.ws.readyState === 1) onlineClients += 1
    }
    return {
      ...this.globalStats,
      pendingRpcCount: this.pendingRpc.size,
      onlineBridgeCount: this.getOnlineBridgeCount(),
      onlineClientCount: onlineClients,
    }
  }

  resolveRoomDevices(roomId, liveBridges = null) {
    if (!this.getRoomDevices) return undefined
    try {
      return this.getRoomDevices(roomId, liveBridges || this.getBridgeList(roomId))
    } catch {
      return undefined
    }
  }

  bridgeKey(roomId, bridgeId) {
    return `${String(roomId || '').trim()}::${bridgeId || 'home-pc'}`
  }

  getRoomEventState(roomId) {
    const rid = String(roomId || '').trim()
    let st = this.roomEvents.get(rid)
    if (st) {
      // Refresh LRU position
      this.roomEvents.delete(rid)
      this.roomEvents.set(rid, st)
      return st
    }
    while (this.roomEvents.size >= ROOM_EVENTS_MAX) {
      const oldestKey = this.roomEvents.keys().next().value
      if (!oldestKey) break
      this.roomEvents.delete(oldestKey)
    }
    st = { seq: 0, buffer: [] }
    this.roomEvents.set(rid, st)
    return st
  }

  getOnlineBridgeCount() {
    let n = 0
    for (const b of this.bridges.values()) {
      if (b.ws.readyState === 1) n += 1
    }
    return n
  }

  getBridgeList(roomId) {
    const rid = String(roomId || '').trim()
    if (!rid) return []
    const out = []
    for (const b of this.bridges.values()) {
      if (b.roomId !== rid) continue
      out.push({
        bridgeId: b.bridgeId,
        deviceId: b.meta?.deviceId || '',
        label: b.meta?.label || b.meta?.hostname || b.bridgeId,
        online: b.ws.readyState === 1,
        hostname: b.meta?.hostname || b.bridgeId,
        platform: b.meta?.platform || 'unknown',
        mode: b.meta?.mode || 'desktop',
        apps: b.meta?.apps || [],
        e2ee: b.meta?.e2ee || null,
        connectedAt: b.connectedAt,
        lastSeen: b.lastSeen,
      })
    }
    return out
  }

  getPrimaryBridge(roomId, requestedId) {
    const rid = String(roomId || '').trim()
    if (!rid) return null
    const reqId = String(requestedId || '').trim()
    if (reqId) {
      const b = this.bridges.get(this.bridgeKey(rid, reqId))
      return b && b.ws.readyState === 1 ? b : null
    }
    for (const b of this.bridges.values()) {
      if (b.roomId === rid && b.ws.readyState === 1) return b
    }
    return null
  }

  registerBridge(ws, meta = {}) {
    ws.on('error', (err) => {
      this.log.warn?.(
        `[relay] Bridge WS error (room=${String(meta?.roomId || '').trim()}, id=${String(meta?.bridgeId || '').trim()}): ${err?.message || err}`,
      )
      try { ws.terminate() } catch {}
    })
    const roomId = String(meta.roomId || '').trim()
    if (!roomId.startsWith('usr_')) {
      try { ws.close(4401, 'Invalid account room') } catch {}
      return
    }
    const bridgeId = String(meta.bridgeId || 'home-pc').trim() || 'home-pc'
    const key = this.bridgeKey(roomId, bridgeId)
    const existing = this.bridges.get(key)
    if (!existing) {
      let roomBridgeCount = 0
      for (const b of this.bridges.values()) {
        if (b.roomId === roomId && b.ws.readyState === 1) roomBridgeCount += 1
      }
      if (roomBridgeCount >= MAX_BRIDGES_PER_ROOM) {
        try { ws.close(4029, 'Too many concurrent bridges in room') } catch {}
        return
      }
    }
    if (existing && existing.ws !== ws) {
      this.failPendingRpcsForBridgeWs(existing.ws, key)
      try {
        existing.ws.close(4001, 'Replaced by newer bridge connection')
      } catch {}
    }

    const now = Date.now()
    const entry = { roomId, bridgeId, ws, meta, connectedAt: now, lastSeen: now, isAlive: true }
    this.bridges.set(key, entry)
    this.globalStats.totalBridgeConnects += 1
    const rStats = this.getOrCreateRoomStats(roomId)
    rStats.lastActivityAt = now
    this.recordActivity({
      type: 'bridge.online',
      roomId,
      label: meta.label || meta.hostname || bridgeId,
      detail: `${meta.platform || 'unknown'} · ${meta.mode || 'bridge'}`,
      ip: meta.ip || '',
    })
    this.log.info(
      `[relay] Bridge connected: room=${roomId} id=${bridgeId} (${meta.hostname || 'unknown'}, mode=${meta.mode || 'unknown'})`,
    )

    const bridges = this.getBridgeList(roomId)
    const devices = this.resolveRoomDevices(roomId, bridges)
    const tierInfo = this.getRoomFileLimits(roomId)
    this.sendRaw(ws, {
      type: 'bridge.welcome',
      roomId,
      bridgeId,
      tier: tierInfo.tier,
      fileLimits: {
        maxUploadBytes: tierInfo.maxUploadBytes,
        maxImageBytes: tierInfo.maxImageBytes,
        maxDocumentBytes: tierInfo.maxDocumentBytes,
      },
      ts: now,
    })
    this.broadcastEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
      bridgeId,
      online: true,
      bridges,
      ...(devices ? { devices } : {}),
    })

    ws.on('pong', () => {
      entry.isAlive = true
      entry.lastSeen = Date.now()
    })

    ws.on('message', (raw) => {
      entry.isAlive = true
      entry.lastSeen = Date.now()
      const rawBytes = typeof raw === 'string' ? Buffer.byteLength(raw) : (raw?.byteLength ?? raw?.length ?? 0)
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      this.handleBridgeMessage(roomId, bridgeId, msg, ws, rawBytes)
    })

    ws.on('close', () => {
      this.failPendingRpcsForBridgeWs(ws, key)
      if (this.bridges.get(key)?.ws === ws) {
        this.bridges.delete(key)
        this.recordActivity({
          type: 'bridge.offline',
          roomId,
          label: entry.meta?.label || entry.meta?.hostname || bridgeId,
          detail: entry.meta?.platform || '',
          ip: entry.meta?.ip || '',
        })
        this.log.info(`[relay] Bridge disconnected: room=${roomId} id=${bridgeId}`)
        const bridges = this.getBridgeList(roomId)
        const devices = this.resolveRoomDevices(roomId, bridges)
        this.broadcastEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
          bridgeId,
          online: false,
          bridges,
          ...(devices ? { devices } : {}),
        })
      }
    })
  }

  getClientList(roomId) {
    const rid = String(roomId || '').trim()
    if (!rid) return []
    const out = []
    for (const [clientId, c] of this._getRoomClientEntries(rid)) {
      if (c.ws.readyState !== 1) continue
      out.push({
        clientId,
        sid: c.sid || '',
        deviceName: c.deviceName || 'Web Client',
        clientKind: c.clientKind || 'web',
        ip: c.ip || '',
        connectedAt: c.connectedAt,
        lastSeenAt: c.lastSeenAt || c.connectedAt,
        online: true,
      })
    }
    return out.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0))
  }

  broadcastRoomClients(roomId) {
    const rid = String(roomId || '').trim()
    if (!rid) return
    const entries = this._getRoomClientEntries(rid)
    if (entries.length === 0) return
    const clients = this.getClientList(rid)
    const frame = JSON.stringify({
      type: 'event',
      ts: Date.now(),
      bridgeId: '',
      event: EVENTS.CLIENTS_STATUS,
      payload: {
        onlineCount: clients.length,
        clients,
      },
    })
    for (const [, client] of entries) {
      if (client.ws.readyState === 1) {
        try {
          client.ws.send(frame)
        } catch {}
      }
    }
  }

  registerClient(ws, user, { lastSeq = 0, ip = '', userAgent = '' } = {}) {
    const clientId = randomUUID()
    ws.on('error', (err) => {
      this.log.warn?.(
        `[relay] Client WS error (room=${String(user?.room || '').trim()}, client=${clientId}): ${err?.message || err}`,
      )
      try { ws.terminate() } catch {}
    })
    const roomId = String(user?.room || '').trim()
    if (!roomId.startsWith('usr_')) {
      try { ws.close(4401, 'Invalid account room') } catch {}
      return
    }
    const roomClientEntries = this._getRoomClientEntries(roomId)
    if (roomClientEntries.length >= MAX_CLIENTS_PER_ROOM) {
      roomClientEntries.sort(
        (a, b) => (a[1].lastSeenAt || a[1].connectedAt || 0) - (b[1].lastSeenAt || b[1].connectedAt || 0),
      )
      const toEvict = roomClientEntries.slice(0, roomClientEntries.length - MAX_CLIENTS_PER_ROOM + 1)
      this._dropClients(toEvict, 4029, 'Too many concurrent client connections', 'evicted')
    }
    const parsed = parseClientDeviceInfo(user?.dev || '', userAgent, user?.kind || '')
    const now = Date.now()
    const entry = {
      roomId,
      ws,
      user,
      sid: String(user?.sid || '').trim(),
      deviceName: parsed.deviceName,
      clientKind: parsed.clientKind,
      ip: String(ip || '').trim(),
      connectedAt: now,
      lastSeenAt: now,
      isAlive: true,
    }
    this.clients.set(clientId, entry)
    this._indexRoomClient(roomId, clientId)
    this.globalStats.totalClientConnects += 1
    const rStats = this.getOrCreateRoomStats(roomId)
    rStats.lastActivityAt = now
    this.recordActivity({
      type: 'client.online',
      roomId,
      label: parsed.deviceName,
      detail: parsed.clientKind,
      ip: entry.ip,
    })
    this.log.info(`[relay] Mobile client connected: ${clientId} (room=${roomId}, dev=${parsed.deviceName}, ip=${entry.ip || 'unknown'})`)

    const evState = this.getRoomEventState(roomId)

    const bridges = this.getBridgeList(roomId)
    const devices = this.resolveRoomDevices(roomId, bridges)
    const clients = this.getClientList(roomId)
    const pendingGrants = this.getPendingGrantsForClient(roomId, clientId)
    const tierInfo = this.getRoomFileLimits(roomId)
    this.sendRaw(ws, {
      type: 'hello',
      clientId,
      sid: entry.sid,
      roomId,
      tier: tierInfo.tier,
      fileLimits: {
        maxUploadBytes: tierInfo.maxUploadBytes,
        maxImageBytes: tierInfo.maxImageBytes,
        maxDocumentBytes: tierInfo.maxDocumentBytes,
      },
      seq: evState.seq,
      bridges,
      ...(devices ? { devices } : {}),
      clients,
      onlineClientCount: clients.length,
      pendingGrants,
      ts: Date.now(),
    })

    // Notify sibling clients in this room immediately that another controlling client connected
    this.broadcastRoomClients(roomId)

    if (Number.isFinite(lastSeq) && lastSeq > 0 && lastSeq < evState.seq) {
      for (const item of evState.buffer) {
        if (item.seq <= lastSeq) continue
        // Skip superseded status snapshots since `hello` already delivered fresh bridges/devices/clients
        if (item.event === EVENTS.BRIDGE_STATUS || item.event === EVENTS.CLIENTS_STATUS) continue
        this.sendRaw(ws, { type: 'event', ...item })
      }
    }

    ws.on('pong', () => {
      entry.isAlive = true
      entry.lastSeenAt = Date.now()
    })

    ws.on('message', (raw) => {
      entry.isAlive = true
      entry.lastSeenAt = Date.now()
      const rawBytes = typeof raw === 'string' ? Buffer.byteLength(raw) : (raw?.byteLength ?? raw?.length ?? 0)
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      this.handleClientMessage(clientId, msg, rawBytes)
    })

    ws.on('close', () => {
      this.clearPendingRpcsForClient(clientId)
      this.cancelClientGrants(clientId, 'disconnected')
      const hadQrNudge = Boolean(entry.lastQrNudgeAt)
      const existed = this.clients.delete(clientId)
      this._unindexRoomClient(roomId, clientId)
      this.log.info(`[relay] Mobile client disconnected: ${clientId} (room=${roomId})`)
      if (existed) {
        if (hadQrNudge) {
          this.pushRoomGrantEvent(
            roomId,
            EVENTS.E2EE_QR_NUDGE,
            { requesterClientId: clientId, action: 'done', ts: Date.now() },
            clientId,
          )
        }
        this.recordActivity({
          type: 'client.offline',
          roomId,
          label: entry.deviceName,
          detail: entry.clientKind,
          ip: entry.ip,
        })
        this.broadcastRoomClients(roomId)
      }
    })
  }

  handleBridgeMessage(roomId, bridgeId, msg, ws = null, rawBytes = 0) {
    if (!msg || typeof msg !== 'object') return
    const key = this.bridgeKey(roomId, bridgeId)
    const activeBridge = this.bridges.get(key)
    if (!activeBridge || (ws && activeBridge.ws !== ws)) return

    if (msg.type === 'ping') {
      this.sendRaw(activeBridge.ws, { type: 'pong', ts: Date.now() })
      return
    }

    if (msg.type === 'bridge.meta') {
      const nextMeta = { ...activeBridge.meta, ...(msg.meta || {}) }
      if (!nextMeta.e2ee?.enabled || !nextMeta.e2ee?.keyId) {
        this.log.warn?.(`[relay] Closing non-E2EE bridge: room=${roomId} id=${bridgeId}`)
        try {
          activeBridge.ws.close(4008, 'E2EE required — upgrade bridge/desktop app to v0.4.4+')
        } catch {}
        return
      }
      activeBridge.meta = nextMeta
      const bridges = this.getBridgeList(roomId)
      const devices = this.resolveRoomDevices(roomId, bridges)
      this.broadcastEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
        bridgeId,
        online: true,
        bridges,
        ...(devices ? { devices } : {}),
      })
      return
    }

    if (msg.type === 'rpc.res') {
      const pending = this.pendingRpc.get(msg.id)
      if (!pending || pending.roomId !== roomId) return
      if (ws && pending.bridgeWs && pending.bridgeWs !== ws) return
      clearTimeout(pending.timer)
      this.pendingRpc.delete(msg.id)
      if (msg.e2ee) {
        const trafficRes = this.checkRoomTraffic(roomId, rawBytes, {
          sourceLabel: `bridge:${bridgeId}`,
          ip: activeBridge.meta?.ip || '',
        })
        if (!trafficRes.allowed) {
          this.sendToClient(pending.clientId, {
            type: 'rpc.res',
            id: pending.clientReqId,
            ok: false,
            error: {
              code: trafficRes.code || 'TRAFFIC_QUOTA_EXCEEDED',
              message: trafficRes.message || '当前账号传输流量已达上限，请稍后再试',
            },
          })
          if (trafficRes.hardKick) {
            try { activeBridge.ws.close(4009, 'Traffic quota exceeded') } catch {}
          }
          return
        }
        this.sendToClient(pending.clientId, {
          type: 'rpc.res',
          id: pending.clientReqId,
          ok: true,
          e2ee: msg.e2ee,
        })
      } else if (msg.ok === false && msg.error) {
        // Structured protocol errors (e.g. E2EE_KEY_MISMATCH / E2EE_REPLAY_DETECTED) carry no plaintext payload
        this.sendToClient(pending.clientId, {
          type: 'rpc.res',
          id: pending.clientReqId,
          ok: false,
          error: msg.error,
        })
      } else {
        this.sendToClient(pending.clientId, {
          type: 'rpc.res',
          id: pending.clientReqId,
          ok: false,
          error: {
            code: 'E2EE_KEY_REQUIRED',
            message: '中转服务已强制端到端加密，拒绝明文响应',
          },
        })
      }
      return
    }

    if (msg.type === 'event') {
      if (!msg.e2ee) return
      const trafficRes = this.checkRoomTraffic(roomId, rawBytes, {
        sourceLabel: `bridge:${bridgeId}`,
        ip: activeBridge.meta?.ip || '',
      })
      if (!trafficRes.allowed) {
        if (trafficRes.hardKick) {
          try { activeBridge.ws.close(4009, 'Traffic quota exceeded') } catch {}
        }
        return
      }
      this.broadcastEvent(roomId, bridgeId, E2EE_EVENT_MARKER, null, msg.e2ee)
    }
  }

  handleClientMessage(clientId, msg, rawBytes = 0) {
    if (!msg || typeof msg !== 'object') return
    const client = this.clients.get(clientId)
    if (!client) return
    const roomId = client.roomId

    if (msg.type === 'ping') {
      this.sendToClient(clientId, { type: 'pong', ts: Date.now() })
      return
    }

    if (rawBytes > 0) {
      const trafficRes = this.checkRoomTraffic(roomId, rawBytes, {
        sourceLabel: client.deviceName || 'client',
        ip: client.ip || '',
      })
      if (!trafficRes.allowed) {
        if (msg.type === 'rpc.req' && msg.id) {
          this.sendToClient(clientId, {
            type: 'rpc.res',
            id: String(msg.id),
            ok: false,
            error: {
              code: trafficRes.code || 'TRAFFIC_QUOTA_EXCEEDED',
              message: trafficRes.message || '当前账号传输流量已达上限，请稍后再试',
            },
          })
        }
        if (trafficRes.hardKick) {
          try { client.ws.close(4009, 'Traffic quota exceeded') } catch {}
        }
        return
      }
    }

    // Zero-knowledge device-to-device E2EE key grant signaling (strictly same-room, blind courier)
    if (msg.type === 'e2ee.grant.req') {
      const reqId = String(msg.reqId || '').trim().toLowerCase()
      const pubKey = String(msg.pubKey || '').trim()
      const wantedKeyId = String(msg.wantedKeyId || '').trim().toLowerCase()
      if (!/^[0-9a-f]{16,32}$/.test(reqId) || !/^[A-Za-z0-9_-]{80,100}$/.test(pubKey)) return
      if (wantedKeyId && !/^[0-9a-f]{16}$/.test(wantedKeyId)) return
      const now = Date.now()
      this.pruneExpiredGrants(now)
      if (this.e2eeGrants.has(reqId)) return
      // Enforce per-room cap (evict oldest pending request in this room if needed)
      const roomGrants = [...this.e2eeGrants.values()]
        .filter((g) => g.roomId === roomId)
        .sort((a, b) => a.createdAt - b.createdAt)
      while (roomGrants.length >= E2EE_GRANT_MAX_PER_ROOM) {
        const oldest = roomGrants.shift()
        if (!oldest) break
        this.e2eeGrants.delete(oldest.reqId)
        this.pushRoomGrantEvent(roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId: oldest.reqId, reason: 'replaced' })
      }
      const grant = {
        reqId,
        roomId,
        requesterClientId: clientId,
        deviceName: client.deviceName || 'Web Client',
        clientKind: client.clientKind || 'web',
        ip: client.ip || '',
        pubKey,
        wantedKeyId,
        createdAt: now,
        expiresAt: now + E2EE_GRANT_TTL_MS,
        offeredByClientId: '',
        approverPubKey: '',
      }
      this.e2eeGrants.set(reqId, grant)
      this.pushRoomGrantEvent(roomId, EVENTS.E2EE_GRANT_REQUEST, this.sanitizeGrantPublic(grant), clientId)
      return
    }

    if (msg.type === 'e2ee.grant.list') {
      this.sendToClient(clientId, {
        type: 'e2ee.grant.list.res',
        id: String(msg.id || ''),
        grants: this.getPendingGrantsForClient(roomId, clientId),
      })
      return
    }

    if (msg.type === 'e2ee.grant.offer') {
      const reqId = String(msg.reqId || '').trim().toLowerCase()
      const approverPubKey = String(msg.approverPubKey || '').trim()
      if (!/^[0-9a-f]{16,32}$/.test(reqId) || !/^[A-Za-z0-9_-]{80,100}$/.test(approverPubKey)) return
      const now = Date.now()
      this.pruneExpiredGrants(now)
      const grant = this.e2eeGrants.get(reqId)
      if (!grant || grant.roomId !== roomId || grant.requesterClientId === clientId || grant.expiresAt <= now) return
      if (grant.offeredByClientId && !this.clients.has(grant.offeredByClientId)) {
        grant.offeredByClientId = ''
        grant.approverPubKey = ''
      }
      if (grant.offeredByClientId && grant.offeredByClientId !== clientId) return
      grant.offeredByClientId = clientId
      grant.approverPubKey = approverPubKey
      this.sendToClient(grant.requesterClientId, {
        type: 'event',
        ts: now,
        bridgeId: '',
        event: EVENTS.E2EE_GRANT_OFFER,
        payload: {
          reqId,
          approverClientId: clientId,
          approverDeviceName: client.deviceName || 'Authorized Device',
          approverClientKind: client.clientKind || 'mobile',
          approverIp: client.ip || '',
          approverPubKey,
        },
      })
      return
    }

    if (msg.type === 'e2ee.grant.deliver') {
      const reqId = String(msg.reqId || '').trim().toLowerCase()
      const env = msg.envelope
      if (!/^[0-9a-f]{16,32}$/.test(reqId) || !env || typeof env !== 'object') return
      if (env.v !== 1 || String(env.reqId || '').trim().toLowerCase() !== reqId) return
      const appPub = String(env.approverPubKey || '').trim()
      const iv = String(env.iv || '').trim()
      const ct = String(env.ct || '').trim()
      if (
        !/^[A-Za-z0-9_-]{80,100}$/.test(appPub) ||
        !/^[A-Za-z0-9_-]{14,24}$/.test(iv) ||
        !/^[A-Za-z0-9_-]{24,16384}$/.test(ct)
      ) {
        return
      }
      const now = Date.now()
      this.pruneExpiredGrants(now)
      const grant = this.e2eeGrants.get(reqId)
      if (!grant || grant.roomId !== roomId || grant.requesterClientId === clientId || grant.expiresAt <= now) return
      if (grant.offeredByClientId && !this.clients.has(grant.offeredByClientId)) {
        grant.offeredByClientId = ''
        grant.approverPubKey = ''
      }
      if (grant.offeredByClientId && (grant.offeredByClientId !== clientId || grant.approverPubKey !== appPub)) {
        return
      }
      const requester = this.clients.get(grant.requesterClientId)
      if (!requester || requester.ws?.readyState !== 1) return
      // Strictly single-use: burn request immediately before delivery
      this.e2eeGrants.delete(reqId)
      this.sendToClient(grant.requesterClientId, {
        type: 'event',
        ts: now,
        bridgeId: '',
        event: EVENTS.E2EE_GRANT_DELIVER,
        payload: {
          reqId,
          approverDeviceName: client.deviceName || 'Authorized Device',
          approverClientKind: client.clientKind || 'mobile',
          approverIp: client.ip || '',
          envelope: { v: 1, reqId, approverPubKey: appPub, iv, ct },
        },
      })
      this.pushRoomGrantEvent(roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId, reason: 'delivered' }, grant.requesterClientId)
      return
    }

    if (msg.type === 'e2ee.grant.reject') {
      const reqId = String(msg.reqId || '').trim().toLowerCase()
      const now = Date.now()
      this.pruneExpiredGrants(now)
      const grant = this.e2eeGrants.get(reqId)
      if (!grant || grant.roomId !== roomId || grant.requesterClientId === clientId || grant.expiresAt <= now) return
      this.e2eeGrants.delete(reqId)
      this.sendToClient(grant.requesterClientId, {
        type: 'event',
        ts: now,
        bridgeId: '',
        event: EVENTS.E2EE_GRANT_REJECT,
        payload: {
          reqId,
          approverDeviceName: client.deviceName || 'Authorized Device',
        },
      })
      this.pushRoomGrantEvent(roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId, reason: 'rejected' }, grant.requesterClientId)
      return
    }

    if (msg.type === 'e2ee.grant.cancel') {
      const reqId = String(msg.reqId || '').trim().toLowerCase()
      const grant = this.e2eeGrants.get(reqId)
      if (!grant || grant.roomId !== roomId || grant.requesterClientId !== clientId) return
      this.e2eeGrants.delete(reqId)
      this.pushRoomGrantEvent(roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId, reason: 'cancelled' }, clientId)
      return
    }

    // Ephemeral same-room UI nudge when a locked/scanning device wants an unlocked device (e.g. PC) to show its QR code.
    // Strictly carries non-secret metadata only (no keys, no credentials); rate-limited per client.
    if (msg.type === 'e2ee.qr.nudge') {
      const action = msg.action === 'done' ? 'done' : 'scanning'
      const wantedKeyId = String(msg.wantedKeyId || '').trim().toLowerCase()
      if (wantedKeyId && !/^[0-9a-f]{16}$/.test(wantedKeyId)) return
      const now = Date.now()
      if (action === 'scanning' && client.lastQrNudgeAt && now - client.lastQrNudgeAt < 4_000) {
        return
      }
      if (action === 'scanning') client.lastQrNudgeAt = now
      this.pushRoomGrantEvent(
        roomId,
        EVENTS.E2EE_QR_NUDGE,
        {
          requesterClientId: clientId,
          deviceName: client.deviceName || 'Mobile Device',
          clientKind: client.clientKind || 'mobile',
          wantedKeyId,
          action,
          ts: now,
        },
        clientId,
      )
      return
    }

    if (msg.type === 'rpc.req') {
      const clientReqId = String(msg.id || randomUUID())
      const requestedBridgeId = String(msg.bridgeId || '').trim()
      const bridge = this.getPrimaryBridge(roomId, requestedBridgeId)
      if (!bridge) {
        this.sendToClient(clientId, {
          type: 'rpc.res',
          id: clientReqId,
          ok: false,
          error: {
            code: 'BRIDGE_OFFLINE',
            message: requestedBridgeId
              ? `目标电脑（${requestedBridgeId}）当前未在线，请确认该电脑已开机并启动桥接，或切换其他电脑。`
              : '你的电脑端桥接服务未在线，请确认电脑已开机并启动 All in One 电脑端桥接。',
          },
        })
        return
      }

      if (!msg.e2ee) {
        this.sendToClient(clientId, {
          type: 'rpc.res',
          id: clientReqId,
          ok: false,
          error: {
            code: 'E2EE_KEY_REQUIRED',
            keyId: bridge.meta?.e2ee?.keyId || '',
            message: '中转服务已强制开启端到端加密，请先同步电脑端密钥',
          },
        })
        return
      }

      let roomPendingCount = 0
      for (const p of this.pendingRpc.values()) {
        if (p.roomId === roomId) roomPendingCount += 1
      }
      if (roomPendingCount >= MAX_PENDING_RPC_PER_ROOM) {
        this.sendToClient(clientId, {
          type: 'rpc.res',
          id: clientReqId,
          ok: false,
          error: {
            code: 'TOO_MANY_PENDING_RPCS',
            message: '当前并发请求过多，请稍后重试',
          },
        })
        return
      }

      const relayReqId = randomUUID()
      const timeoutMs = Number.isFinite(msg.timeoutMs)
        ? Math.min(Math.max(5_000, msg.timeoutMs), 600_000)
        : DEFAULT_RPC_TIMEOUT_MS

      const timer = setTimeout(() => {
        if (!this.pendingRpc.has(relayReqId)) return
        this.pendingRpc.delete(relayReqId)
        this.sendToClient(clientId, {
          type: 'rpc.res',
          id: clientReqId,
          ok: false,
          error: { code: 'RPC_TIMEOUT', message: `请求超时（${Math.round(timeoutMs / 1000)}s）` },
        })
      }, timeoutMs)

      this.pendingRpc.set(relayReqId, {
        clientId,
        clientReqId,
        timer,
        roomId,
        bridgeKey: this.bridgeKey(roomId, bridge.bridgeId),
        bridgeWs: bridge.ws,
      })

      const rpcNow = Date.now()
      this.globalStats.totalRpcs += 1
      const rStats = this.getOrCreateRoomStats(roomId)
      rStats.rpcCount += 1
      rStats.lastRpcMethod = E2EE_METHOD_MARKER
      rStats.lastRpcAt = rpcNow
      rStats.lastActivityAt = rpcNow

      const sent = this.sendRaw(bridge.ws, {
        type: 'rpc.req',
        id: relayReqId,
        method: E2EE_METHOD_MARKER,
        e2ee: msg.e2ee,
      })
      if (!sent) {
        clearTimeout(timer)
        this.pendingRpc.delete(relayReqId)
        this.sendToClient(clientId, {
          type: 'rpc.res',
          id: clientReqId,
          ok: false,
          error: { code: 'BRIDGE_DISCONNECTED', message: '电脑端连接已断开，请稍后重试' },
        })
      }
    }
  }

  broadcastEvent(roomId, bridgeId, event, payload, e2ee = null) {
    const rid = String(roomId || '').trim()
    if (!rid) return
    const evState = this.getRoomEventState(rid)
    const now = Date.now()
    evState.seq += 1
    this.globalStats.totalEvents += 1
    const rStats = this.getOrCreateRoomStats(rid)
    rStats.eventCount += 1
    rStats.lastActivityAt = now
    const envelope = e2ee
      ? {
          seq: evState.seq,
          ts: now,
          bridgeId,
          event: E2EE_EVENT_MARKER,
          e2ee,
        }
      : {
          seq: evState.seq,
          ts: now,
          bridgeId,
          event,
          payload,
        }
    const frame = JSON.stringify({ type: 'event', ...envelope })
    if (Buffer.byteLength(frame, 'utf8') <= MAX_CACHED_EVENT_BYTES) {
      evState.buffer.push(envelope)
      if (evState.buffer.length > EVENT_BUFFER_SIZE) {
        evState.buffer.shift()
      }
    }
    for (const [, client] of this._getRoomClientEntries(rid)) {
      if (client.ws.readyState === 1) {
        try {
          client.ws.send(frame)
        } catch {}
      }
    }
  }

  sendToClient(clientId, payload) {
    const client = this.clients.get(clientId)
    if (!client) return false
    return this.sendRaw(client.ws, payload)
  }

  sendRaw(ws, payload) {
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  broadcastRoomDevices(roomId) {
    const rid = String(roomId || '').trim()
    if (!rid) return
    const bridges = this.getBridgeList(rid)
    const devices = this.resolveRoomDevices(rid, bridges)
    this.broadcastEvent(rid, '', EVENTS.BRIDGE_STATUS, {
      bridgeId: '',
      online: bridges.some((b) => b.online),
      bridges,
      ...(devices ? { devices } : {}),
    })
  }

  disconnectBridge(roomId, bridgeId, code = 4401, reason = 'Device unbound') {
    const rid = String(roomId || '').trim()
    const bid = String(bridgeId || '').trim()
    if (!rid || !bid) return false
    const key = this.bridgeKey(rid, bid)
    const entry = this.bridges.get(key)
    if (!entry) return false
    this.bridges.delete(key)
    this.failPendingRpcsForBridgeWs(entry.ws, key)
    this.recordActivity({
      type: 'bridge.offline',
      roomId: rid,
      label: entry.meta?.label || entry.meta?.hostname || bid,
      detail: entry.meta?.platform || '',
      ip: entry.meta?.ip || '',
    })
    this.log.info(`[relay] Bridge disconnected: room=${rid} id=${bid}`)
    try {
      entry.ws.close(code, reason)
    } catch {}
    const bridges = this.getBridgeList(rid)
    const devices = this.resolveRoomDevices(rid, bridges)
    this.broadcastEvent(rid, bid, EVENTS.BRIDGE_STATUS, {
      bridgeId: bid,
      online: false,
      bridges,
      ...(devices ? { devices } : {}),
    })
    return true
  }

  _dropClients(targets, code = 4401, reason = 'Session revoked', grantReason = 'revoked') {
    if (!targets.length) return 0
    for (const [cid, client] of targets) {
      this.clients.delete(cid)
      this._unindexRoomClient(client.roomId, cid)
      try {
        client.ws.close(code, reason)
      } catch {}
    }
    for (const [cid] of targets) {
      this.cancelClientGrants(cid, grantReason)
      this.clearPendingRpcsForClient(cid)
    }
    return targets.length
  }

  disconnectClient(roomId, { clientId = '', sid = '' } = {}, code = 4401, reason = 'Session revoked') {
    const rid = String(roomId || '').trim()
    const targetCid = String(clientId || '').trim()
    const targetSid = String(sid || '').trim()
    if (!rid || (!targetCid && !targetSid)) return 0
    const targets = []
    for (const [cid, client] of this._getRoomClientEntries(rid)) {
      const matchCid = targetCid && cid === targetCid
      const matchSid = targetSid && client.sid && client.sid === targetSid
      if (matchCid || matchSid) targets.push([cid, client])
    }
    const disconnected = this._dropClients(targets, code, reason)
    if (disconnected > 0) {
      this.log.info(`[relay] Kicked ${disconnected} client connection(s) in room=${rid}`)
      this.broadcastRoomClients(rid)
    }
    return disconnected
  }

  disconnectOtherRoomClients(roomId, { keepClientId = '', keepSid = '', newSidForKept = '' } = {}, code = 4401, reason = 'Session revoked') {
    const rid = String(roomId || '').trim()
    if (!rid) return 0
    const keepCid = String(keepClientId || '').trim()
    const keepSession = String(keepSid || '').trim()
    const targets = []
    for (const [cid, client] of this._getRoomClientEntries(rid)) {
      if ((keepCid && cid === keepCid) || (keepSession && client.sid && client.sid === keepSession)) {
        if (newSidForKept) client.sid = String(newSidForKept)
        continue
      }
      targets.push([cid, client])
    }
    const disconnected = this._dropClients(targets, code, reason)
    if (disconnected > 0) {
      this.log.info(`[relay] Kicked ${disconnected} other client(s) in room=${rid}`)
      this.broadcastRoomClients(rid)
    }
    return disconnected
  }

  disconnectRoomClients(roomId, code = 4401, reason = 'Session revoked') {
    const rid = String(roomId || '').trim()
    if (!rid) return 0
    const targets = this._getRoomClientEntries(rid)
    const disconnected = this._dropClients(targets, code, reason)
    const evState = this.roomEvents.get(rid)
    if (evState) {
      evState.buffer = []
    }
    if (disconnected > 0) {
      this.log.info(`[relay] Revoked and disconnected ${disconnected} client(s) in room=${rid}`)
    }
    return disconnected
  }

  shutdown() {
    if (this._grantSweepTimer) {
      clearInterval(this._grantSweepTimer)
      this._grantSweepTimer = null
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingRpc.clear()
    for (const b of this.bridges.values()) {
      try { b.ws.close(1001, 'Server shutting down') } catch {}
    }
    for (const c of this.clients.values()) {
      try { c.ws.close(1001, 'Server shutting down') } catch {}
    }
  }
}
