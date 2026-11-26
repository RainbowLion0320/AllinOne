import { randomUUID } from 'node:crypto'
import { APP_LIST, EVENTS, P2P_PROTOCOL_VERSION } from '@allinone/shared'

const ALLOWED_APPS = new Set(APP_LIST)
const ACTIVITY_LOG_MAX = 80
const ROOM_STATS_MAX = 2000
const E2EE_GRANT_TTL_MS = 120_000
const E2EE_GRANT_MAX_PER_ROOM = 8
const E2EE_GRANT_SWEEP_MS = 15_000
const WS_HEARTBEAT_INTERVAL_MS = 30_000
const MAX_CLIENTS_PER_ROOM = 30
const MAX_BRIDGES_PER_ROOM = 16
const MAX_P2P_SIGNAL_BYTES = 64 * 1024
const SAFE_SIGNAL_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/
const WS_MSG_RATE_PER_SEC = 120
const WS_MSG_BURST = 300
const WS_MSG_VIOLATION_CLOSE = 30
const WS_MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const WS_MAX_BACKPRESSURE_DROPS = 5

function createWsRateBucket(ratePerSec = WS_MSG_RATE_PER_SEC, burst = WS_MSG_BURST) {
  let tokens = burst
  let lastRefill = Date.now()
  let violations = 0
  return {
    consume() {
      const now = Date.now()
      const elapsedSec = (now - lastRefill) / 1000
      if (elapsedSec > 0) {
        tokens = Math.min(burst, tokens + elapsedSec * ratePerSec)
        lastRefill = now
      }
      if (tokens >= 1) {
        tokens -= 1
        violations = 0
        return { ok: true, terminate: false }
      }
      violations += 1
      return { ok: false, terminate: violations >= WS_MSG_VIOLATION_CLOSE }
    },
  }
}

function sanitizeBridgeApps(rawApps) {
  if (!Array.isArray(rawApps)) return []
  const out = []
  const seen = new Set()
  for (const a of rawApps) {
    if (!a || typeof a !== 'object') continue
    const app = typeof a.app === 'string' ? a.app.trim() : ''
    if (!ALLOWED_APPS.has(app) || seen.has(app)) continue
    seen.add(app)
    const activeNum = Number(a.activeCount)
    out.push({
      app,
      available: Boolean(a.available),
      writable: Boolean(a.writable),
      activeCount: Number.isFinite(activeNum) ? Math.max(0, Math.min(9999, Math.floor(activeNum))) : 0,
    })
    if (out.length >= APP_LIST.length) break
  }
  return out
}

function sanitizeBridgeE2ee(rawE2ee) {
  if (!rawE2ee || typeof rawE2ee !== 'object') return null
  const rawKeyId = String(rawE2ee.keyId || '').trim()
  const keyId = /^[0-9a-f]{16}$/i.test(rawKeyId) ? rawKeyId.toLowerCase() : ''
  const vNum = Number(rawE2ee.v)
  return {
    enabled: Boolean(rawE2ee.enabled),
    v: Number.isFinite(vNum) && vNum > 0 ? Math.floor(vNum) : 1,
    keyId,
  }
}

function sanitizeBridgeConnectMeta(meta, roomId, bridgeId) {
  const src = meta && typeof meta === 'object' ? meta : {}
  const e2ee = src.e2ee ? sanitizeBridgeE2ee(src.e2ee) : null
  return {
    roomId,
    bridgeId,
    deviceId: String(src.deviceId || '').trim().slice(0, 64),
    label: String(src.label || '').trim().slice(0, 64),
    hostname: String(src.hostname || bridgeId).trim().slice(0, 64) || bridgeId,
    platform: String(src.platform || 'unknown').trim().slice(0, 32) || 'unknown',
    mode: String(src.mode || 'desktop').trim().slice(0, 32) || 'desktop',
    p2pEngine: String(src.p2pEngine || '').trim().slice(0, 32),
    ip: String(src.ip || '').trim().slice(0, 64),
    apps: Array.isArray(src.apps) ? sanitizeBridgeApps(src.apps) : [],
    ...(e2ee && e2ee.keyId ? { e2ee } : {}),
  }
}

/**
 * Parse raw client `dev` tag and HTTP `User-Agent` into a clean human-readable device name & category.
 */
export function parseClientDeviceInfo(rawDev = '', userAgent = '', explicitKind = '') {
  const dev = String(rawDev || '').trim()
  const ua = String(userAgent || '').trim()
  const cleanKind = explicitKind === 'desktop' || explicitKind === 'mobile' || explicitKind === 'web'
    ? explicitKind
    : ''

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

function isValidE2eeEnvelope(env) {
  if (!env || typeof env !== 'object') return false
  if (env.v !== 1) return false
  const kid = String(env.kid || '').trim()
  const iv = String(env.iv || '').trim()
  const ct = String(env.ct || '').trim()
  return Boolean(kid && iv && ct)
}

/**
 * Pure Control-Plane Hub (v1.0 — Zero Data-Plane Relay):
 *  - Account-isolated room presence (online PC bridges & controlling terminals)
 *  - Zero-knowledge E2EE device key grant signaling (`e2ee.grant.*`, `e2ee.qr.nudge`)
 *  - Strictly unicast, E2EE-wrapped WebRTC P2P signaling (`p2p.signal`)
 *  - Instant device revocation broadcasts (`client.revoked`) so PC bridges kill kicked P2P peers in < 200ms
 *
 * NEVER relays chats, RPC payloads, images, or file bytes.
 */
export class RelayHub {
  constructor({ log = console, getRoomDevices = null, getIceServers = null, getTurnQuota = null, iceRefreshIntervalMs = 0 } = {}) {
    this.log = log
    this.getRoomDevices = typeof getRoomDevices === 'function' ? getRoomDevices : null
    this.getIceServers = typeof getIceServers === 'function' ? getIceServers : () => []
    this.getTurnQuota = typeof getTurnQuota === 'function' ? getTurnQuota : () => null
    this.iceRefreshIntervalMs = Number(iceRefreshIntervalMs) > 0 ? Number(iceRefreshIntervalMs) : 0
    /** @type {Map<string, { roomId: string, bridgeId: string, ws: import('ws').WebSocket, meta: any, connectedAt: number, lastSeen: number, isAlive: boolean }>} */
    this.bridges = new Map() // key = `${roomId}::${bridgeId}`
    /** @type {Map<string, any>} */
    this.clients = new Map()
    /** @type {Map<string, Set<string>>} O(1) room -> clientIds index */
    this.roomClients = new Map()
    /** @type {Map<string, { signalCount: number, lastActivityAt: number }>} */
    this.roomStats = new Map()
    this.globalStats = {
      startedAt: Date.now(),
      totalSignals: 0,
      totalBridgeConnects: 0,
      totalClientConnects: 0,
    }
    this.activityLog = []
    this._activitySeq = 0
    /** @type {Map<string, Map<string, any>>} Partitioned per-room E2EE grants: roomId -> Map<reqId, grant> */
    this.e2eeGrants = new Map()

    this._grantSweepTimer = setInterval(() => {
      if (this.e2eeGrants.size > 0) this.pruneExpiredGrants()
    }, E2EE_GRANT_SWEEP_MS)
    this._grantSweepTimer.unref()

    this._heartbeatTimer = setInterval(() => {
      for (const entry of this.bridges.values()) {
        if (entry.ws.readyState !== 1) continue
        if (entry.isAlive === false) {
          this.log.warn?.(`[control] Bridge heartbeat timeout: room=${entry.roomId} id=${entry.bridgeId}`)
          try { entry.ws.terminate() } catch {}
          continue
        }
        entry.isAlive = false
        try { entry.ws.ping() } catch {}
      }
      for (const [cid, entry] of this.clients.entries()) {
        if (entry.ws.readyState !== 1) continue
        if (entry.isAlive === false) {
          this.log.warn?.(`[control] Client heartbeat timeout: room=${entry.roomId} client=${cid}`)
          try { entry.ws.terminate() } catch {}
          continue
        }
        entry.isAlive = false
        try { entry.ws.ping() } catch {}
      }
    }, WS_HEARTBEAT_INTERVAL_MS)
    this._heartbeatTimer.unref()

    this._iceRefreshTimer = null
    if (this.iceRefreshIntervalMs > 0) {
      this._iceRefreshTimer = setInterval(() => {
        const activeRooms = new Set()
        for (const b of this.bridges.values()) {
          if (b.ws.readyState === 1) activeRooms.add(b.roomId)
        }
        for (const c of this.clients.values()) {
          if (c.ws.readyState === 1) activeRooms.add(c.roomId)
        }
        for (const rid of activeRooms) {
          this.pushIceUpdate(rid, { quotaExceeded: false })
        }
      }, this.iceRefreshIntervalMs)
      this._iceRefreshTimer.unref()
    }
  }

  _getRoomGrantMap(roomId, create = false) {
    const rid = String(roomId || '').trim()
    if (!rid) return null
    let roomMap = this.e2eeGrants.get(rid)
    if (!roomMap && create) {
      roomMap = new Map()
      this.e2eeGrants.set(rid, roomMap)
    }
    return roomMap || null
  }

  _deleteGrant(roomId, reqId) {
    const roomMap = this.e2eeGrants.get(roomId)
    if (!roomMap) return false
    const deleted = roomMap.delete(reqId)
    if (roomMap.size === 0) this.e2eeGrants.delete(roomId)
    return deleted
  }

  pruneExpiredGrantsForRoom(roomId, now = Date.now()) {
    const roomMap = this.e2eeGrants.get(roomId)
    if (!roomMap) return
    for (const [reqId, g] of roomMap.entries()) {
      if (now >= g.expiresAt || !this.clients.has(g.requesterClientId)) {
        roomMap.delete(reqId)
        this.pushRoomGrantEvent(g.roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId, reason: 'expired' })
      }
    }
    if (roomMap.size === 0) this.e2eeGrants.delete(roomId)
  }

  pruneExpiredGrants(now = Date.now()) {
    for (const roomId of [...this.e2eeGrants.keys()]) {
      this.pruneExpiredGrantsForRoom(roomId, now)
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
      ...(g.commit ? { commit: g.commit } : {}),
      createdAt: g.createdAt,
      expiresAt: g.expiresAt,
    }
  }

  getPendingGrantsForClient(roomId, excludeClientId = '') {
    const rid = String(roomId || '').trim()
    if (!rid) return []
    const now = Date.now()
    this.pruneExpiredGrantsForRoom(rid, now)
    const roomMap = this.e2eeGrants.get(rid)
    if (!roomMap || roomMap.size === 0) return []
    const out = []
    for (const g of roomMap.values()) {
      if (excludeClientId && g.requesterClientId === excludeClientId) continue
      if (g.expiresAt <= now) continue
      out.push(this.sanitizeGrantPublic(g))
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  _safeSend(ws, data, { critical = false } = {}) {
    if (!ws || ws.readyState !== 1) return false
    const buffered = Number(ws.bufferedAmount) || 0
    if (buffered > WS_MAX_BUFFERED_BYTES) {
      ws._bpDrops = (ws._bpDrops || 0) + 1
      if (critical || buffered > WS_MAX_BUFFERED_BYTES * 2 || ws._bpDrops >= WS_MAX_BACKPRESSURE_DROPS) {
        this.log.warn?.(`[control] Terminating stalled WS consumer (bufferedAmount=${buffered})`)
        try { ws.terminate() } catch {}
      }
      return false
    }
    ws._bpDrops = 0
    try {
      ws.send(data)
      return true
    } catch {
      return false
    }
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
    if (set.size === 0) this.roomClients.delete(roomId)
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
      this._safeSend(c.ws, frame)
    }
  }

  cancelClientGrants(clientId, reason = 'disconnected', roomId = '') {
    const rid = String(roomId || '').trim()
    const targetRooms = rid ? [rid] : [...this.e2eeGrants.keys()]
    for (const r of targetRooms) {
      const roomMap = this.e2eeGrants.get(r)
      if (!roomMap) continue
      for (const [reqId, g] of [...roomMap.entries()]) {
        if (g.requesterClientId === clientId) {
          roomMap.delete(reqId)
          this.pushRoomGrantEvent(g.roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId, reason }, clientId)
        } else if (g.offeredByClientId === clientId) {
          g.offeredByClientId = ''
          g.approverPubKey = ''
          g.approverNonce = ''
          this.sendToClient(g.requesterClientId, {
            type: 'event',
            ts: Date.now(),
            bridgeId: '',
            event: EVENTS.E2EE_GRANT_CANCEL,
            payload: { reqId, reason: 'approver_disconnected', reopen: true },
          })
        }
      }
      if (roomMap.size === 0) this.e2eeGrants.delete(r)
    }
  }

  /**
   * Immediately notify all online PC bridges in `roomId` to tear down active P2P DataChannels
   * for revoked/kicked `clientIds`, `sids`, `all`, or `allExceptSids`.
   */
  notifyBridgesClientRevoked(
    roomId,
    clientIds = [],
    reason = 'revoked',
    { sids = [], all = false, allExceptSids = [] } = {},
  ) {
    const rid = String(roomId || '').trim()
    const ids = Array.isArray(clientIds) ? [...new Set(clientIds.map((x) => String(x || '').trim()).filter(Boolean))] : []
    const cleanSids = Array.isArray(sids) ? [...new Set(sids.map((x) => String(x || '').trim()).filter(Boolean))] : []
    const exceptSids = Array.isArray(allExceptSids)
      ? [...new Set(allExceptSids.map((x) => String(x || '').trim()).filter(Boolean))]
      : []
    if (!rid || (ids.length === 0 && cleanSids.length === 0 && !all && exceptSids.length === 0)) return
    const frame = JSON.stringify({
      type: EVENTS.CLIENT_REVOKED,
      clientIds: ids,
      ...(cleanSids.length > 0 ? { sids: cleanSids } : {}),
      ...(all ? { all: true } : {}),
      ...(exceptSids.length > 0 ? { allExceptSids: exceptSids } : {}),
      reason: String(reason || 'revoked'),
      ts: Date.now(),
    })
    for (const b of this.bridges.values()) {
      if (b.roomId !== rid || b.ws.readyState !== 1) continue
      this._safeSend(b.ws, frame, { critical: true })
    }
  }

  getActiveRoomIds() {
    const activeRooms = new Set()
    for (const b of this.bridges.values()) {
      if (b.ws.readyState === 1) activeRooms.add(b.roomId)
    }
    for (const c of this.clients.values()) {
      if (c.ws.readyState === 1) activeRooms.add(c.roomId)
    }
    return [...activeRooms]
  }

  getOrCreateRoomStats(roomId) {
    const rid = String(roomId || '').trim()
    let st = this.roomStats.get(rid)
    if (!st) {
      if (this.roomStats.size >= ROOM_STATS_MAX) {
        const oldestKey = this.roomStats.keys().next().value
        if (oldestKey) this.roomStats.delete(oldestKey)
      }
      st = { signalCount: 0, lastActivityAt: 0 }
      this.roomStats.set(rid, st)
    }
    return st
  }

  getRoomStats(roomId) {
    const rid = String(roomId || '').trim()
    const st = this.roomStats.get(rid)
    return st ? { ...st } : { signalCount: 0, lastActivityAt: 0 }
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
        mode: b.meta?.mode || 'desktop',
        p2pEngine: b.meta?.p2pEngine || '',
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
        p2pEngine: b.meta?.p2pEngine || '',
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

  registerBridge(ws, meta = {}, { req = null } = {}) {
    ws.on('error', (err) => {
      this.log.warn?.(
        `[control] Bridge WS error (room=${String(meta?.roomId || '').trim()}, id=${String(meta?.bridgeId || '').trim()}): ${err?.message || err}`,
      )
      try { ws.terminate() } catch {}
    })
    const roomId = String(meta.roomId || '').trim()
    if (!roomId.startsWith('usr_')) {
      try { ws.close(4401, 'Invalid account room') } catch {}
      return
    }
    const bridgeId = String(meta.bridgeId || 'home-pc').trim().slice(0, 64) || 'home-pc'
    const safeMeta = sanitizeBridgeConnectMeta(meta, roomId, bridgeId)
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
      try { existing.ws.close(4001, 'Replaced by newer bridge connection') } catch {}
    }

    const now = Date.now()
    const rateBucket = createWsRateBucket()
    const entry = { roomId, bridgeId, ws, meta: safeMeta, connectedAt: now, lastSeen: now, isAlive: true }
    this.bridges.set(key, entry)
    this.globalStats.totalBridgeConnects += 1
    this.getOrCreateRoomStats(roomId).lastActivityAt = now
    this.recordActivity({
      type: 'bridge.online',
      roomId,
      label: safeMeta.label || safeMeta.hostname || bridgeId,
      detail: `${safeMeta.platform || 'unknown'} · ${safeMeta.mode || 'bridge'}`,
      ip: safeMeta.ip || '',
    })
    this.log.info(
      `[control] Bridge connected: room=${roomId} id=${bridgeId} (${safeMeta.hostname || 'unknown'}, mode=${safeMeta.mode || 'unknown'})`,
    )

    const bridges = this.getBridgeList(roomId)
    const devices = this.resolveRoomDevices(roomId, bridges)
    this.sendRaw(ws, {
      type: 'bridge.welcome',
      protocolVersion: P2P_PROTOCOL_VERSION,
      mode: 'p2p-only',
      roomId,
      bridgeId,
      iceServers: this.getIceServers(req, roomId),
      ts: now,
    })
    this.broadcastControlEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
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
      const rl = rateBucket.consume()
      if (!rl.ok) {
        if (rl.terminate) {
          this.log.warn?.(`[control] Closing flooding bridge WS: room=${roomId} id=${bridgeId}`)
          try { ws.close(4029, 'Message rate limit exceeded') } catch {}
        }
        return
      }
      const rawBytes = typeof raw === 'string' ? Buffer.byteLength(raw) : (raw?.byteLength ?? raw?.length ?? 0)
      if (rawBytes > MAX_P2P_SIGNAL_BYTES + 4096) return
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      this.handleBridgeMessage(roomId, bridgeId, msg, ws, rawBytes)
    })

    ws.on('close', () => {
      if (this.bridges.get(key)?.ws === ws) {
        this.bridges.delete(key)
        this.recordActivity({
          type: 'bridge.offline',
          roomId,
          label: entry.meta?.label || entry.meta?.hostname || bridgeId,
          detail: entry.meta?.platform || '',
          ip: entry.meta?.ip || '',
        })
        this.log.info(`[control] Bridge disconnected: room=${roomId} id=${bridgeId}`)
        const bridgesAfter = this.getBridgeList(roomId)
        const devicesAfter = this.resolveRoomDevices(roomId, bridgesAfter)
        this.broadcastControlEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
          bridgeId,
          online: false,
          bridges: bridgesAfter,
          ...(devicesAfter ? { devices: devicesAfter } : {}),
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
        this._safeSend(client.ws, frame)
      }
    }
  }

  registerClient(ws, user, { ip = '', userAgent = '', req = null } = {}) {
    const clientId = randomUUID()
    ws.on('error', (err) => {
      this.log.warn?.(
        `[control] Client WS error (room=${String(user?.room || '').trim()}, client=${clientId}): ${err?.message || err}`,
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
    this.getOrCreateRoomStats(roomId).lastActivityAt = now
    this.recordActivity({
      type: 'client.online',
      roomId,
      label: parsed.deviceName,
      detail: parsed.clientKind,
      ip: entry.ip,
    })
    this.log.info(`[control] Client connected: ${clientId} (room=${roomId}, dev=${parsed.deviceName}, ip=${entry.ip || 'unknown'})`)

    const bridges = this.getBridgeList(roomId)
    const devices = this.resolveRoomDevices(roomId, bridges)
    const clients = this.getClientList(roomId)
    const pendingGrants = this.getPendingGrantsForClient(roomId, clientId)
    const turnQuota = this.getTurnQuota(roomId)
    this.sendRaw(ws, {
      type: 'hello',
      protocolVersion: P2P_PROTOCOL_VERSION,
      mode: 'p2p-only',
      clientId,
      sid: entry.sid,
      roomId,
      iceServers: this.getIceServers(req, roomId),
      ...(turnQuota ? { turnQuota } : {}),
      bridges,
      ...(devices ? { devices } : {}),
      clients,
      onlineClientCount: clients.length,
      pendingGrants,
      ts: now,
    })

    this.broadcastRoomClients(roomId)

    const rateBucket = createWsRateBucket()

    ws.on('pong', () => {
      entry.isAlive = true
      entry.lastSeenAt = Date.now()
    })

    ws.on('message', (raw) => {
      entry.isAlive = true
      entry.lastSeenAt = Date.now()
      const rl = rateBucket.consume()
      if (!rl.ok) {
        if (rl.terminate) {
          this.log.warn?.(`[control] Closing flooding client WS: room=${roomId} client=${clientId}`)
          try { ws.close(4029, 'Message rate limit exceeded') } catch {}
        }
        return
      }
      const rawBytes = typeof raw === 'string' ? Buffer.byteLength(raw) : (raw?.byteLength ?? raw?.length ?? 0)
      if (rawBytes > MAX_P2P_SIGNAL_BYTES + 4096) return
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      this.handleClientMessage(clientId, msg, rawBytes)
    })

    ws.on('close', () => {
      this.cancelClientGrants(clientId, 'disconnected', roomId)
      const hadQrNudge = Boolean(entry.lastQrNudgeAt)
      const existed = this.clients.delete(clientId)
      this._unindexRoomClient(roomId, clientId)
      this.log.info(`[control] Client disconnected: ${clientId} (room=${roomId})`)
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
      const incoming = msg.meta && typeof msg.meta === 'object' ? msg.meta : {}
      const safePatch = {}
      if (typeof incoming.hostname === 'string' && incoming.hostname.trim()) {
        safePatch.hostname = incoming.hostname.trim().slice(0, 64)
      }
      if (typeof incoming.platform === 'string' && incoming.platform.trim()) {
        safePatch.platform = incoming.platform.trim().slice(0, 32)
      }
      if (typeof incoming.mode === 'string' && incoming.mode.trim()) {
        safePatch.mode = incoming.mode.trim().slice(0, 32)
      }
      if (typeof incoming.p2pEngine === 'string') {
        safePatch.p2pEngine = incoming.p2pEngine.trim().slice(0, 32)
      }
      if (Array.isArray(incoming.apps)) {
        safePatch.apps = sanitizeBridgeApps(incoming.apps)
      }
      if ('e2ee' in incoming) {
        safePatch.e2ee = sanitizeBridgeE2ee(incoming.e2ee)
      }
      const nextMeta = { ...activeBridge.meta, ...safePatch }
      if (!nextMeta.e2ee?.enabled || !nextMeta.e2ee?.keyId) {
        this.log.warn?.(`[control] Closing non-E2EE bridge: room=${roomId} id=${bridgeId}`)
        try {
          activeBridge.ws.close(4008, 'E2EE required')
        } catch {}
        return
      }
      activeBridge.meta = nextMeta
      const bridges = this.getBridgeList(roomId)
      const devices = this.resolveRoomDevices(roomId, bridges)
      this.broadcastControlEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
        bridgeId,
        online: true,
        bridges,
        ...(devices ? { devices } : {}),
      })
      return
    }

    // Strictly unicast E2EE WebRTC P2P signaling (Bridge -> target Client in the SAME room)
    if (msg.type === EVENTS.P2P_SIGNAL) {
      if (rawBytes > MAX_P2P_SIGNAL_BYTES) return
      const targetClientId = String(msg.clientId || '').trim()
      const sessionId = String(msg.sessionId || '').trim()
      if (!targetClientId || !SAFE_SIGNAL_ID_RE.test(sessionId) || !isValidE2eeEnvelope(msg.e2ee)) {
        return
      }
      const targetClient = this.clients.get(targetClientId)
      if (!targetClient || targetClient.roomId !== roomId || targetClient.ws.readyState !== 1) {
        return
      }
      this.globalStats.totalSignals += 1
      const rStats = this.getOrCreateRoomStats(roomId)
      rStats.signalCount += 1
      rStats.lastActivityAt = Date.now()
      this.sendRaw(targetClient.ws, {
        type: EVENTS.P2P_SIGNAL,
        bridgeId,
        sessionId,
        e2ee: msg.e2ee,
        ts: Date.now(),
      })
      return
    }

    // Reject any legacy data-plane frames cleanly (zero relay data plane in v1.0)
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

    // Strictly unicast E2EE WebRTC P2P signaling (Client -> target Bridge in the SAME room)
    if (msg.type === EVENTS.P2P_SIGNAL) {
      if (rawBytes > MAX_P2P_SIGNAL_BYTES) return
      const requestedBridgeId = String(msg.bridgeId || '').trim()
      const sessionId = String(msg.sessionId || '').trim()
      if (!SAFE_SIGNAL_ID_RE.test(sessionId) || !isValidE2eeEnvelope(msg.e2ee)) return
      const bridge = this.getPrimaryBridge(roomId, requestedBridgeId)
      if (!bridge) {
        this.sendToClient(clientId, {
          type: 'p2p.signal.error',
          bridgeId: requestedBridgeId,
          sessionId,
          code: 'BRIDGE_OFFLINE',
          message: requestedBridgeId
            ? `目标电脑（${requestedBridgeId}）当前未在线，请确认该电脑已开机并启动桥接。`
            : '你的电脑端桥接服务未在线，请确认电脑已开机并启动 All in One。',
        })
        return
      }
      this.globalStats.totalSignals += 1
      const rStats = this.getOrCreateRoomStats(roomId)
      rStats.signalCount += 1
      rStats.lastActivityAt = Date.now()
      this.sendRaw(bridge.ws, {
        type: EVENTS.P2P_SIGNAL,
        clientId,
        ...(client.sid ? { sid: client.sid } : {}),
        sessionId,
        e2ee: msg.e2ee,
        ts: Date.now(),
      })
      return
    }

    // Zero-knowledge device-to-device E2EE key grant signaling (strictly same-room, blind courier)
    if (msg.type === 'e2ee.grant.req') {
      const reqId = String(msg.reqId || '').trim().toLowerCase()
      const pubKey = String(msg.pubKey || '').trim()
      const wantedKeyId = String(msg.wantedKeyId || '').trim().toLowerCase()
      const commit = String(msg.commit || '').trim().toLowerCase()
      if (!/^[0-9a-f]{16,32}$/.test(reqId) || !/^[A-Za-z0-9_-]{80,100}$/.test(pubKey)) return
      if (wantedKeyId && !/^[0-9a-f]{16}$/.test(wantedKeyId)) return
      if (commit && !/^[0-9a-f]{64}$/.test(commit)) return
      const now = Date.now()
      this.pruneExpiredGrantsForRoom(roomId, now)
      const roomMap = this._getRoomGrantMap(roomId, true)
      if (roomMap.has(reqId)) return
      const roomGrants = [...roomMap.values()].sort((a, b) => a.createdAt - b.createdAt)
      while (roomGrants.length >= E2EE_GRANT_MAX_PER_ROOM) {
        const oldest = roomGrants.shift()
        if (!oldest) break
        roomMap.delete(oldest.reqId)
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
        commit,
        createdAt: now,
        expiresAt: now + E2EE_GRANT_TTL_MS,
        offeredByClientId: '',
        approverPubKey: '',
        approverNonce: '',
      }
      roomMap.set(reqId, grant)
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
      const approverNonce = String(msg.approverNonce || '').trim()
      if (!/^[0-9a-f]{16,32}$/.test(reqId) || !/^[A-Za-z0-9_-]{80,100}$/.test(approverPubKey)) return
      if (approverNonce && !/^[A-Za-z0-9_-]{16,44}$/.test(approverNonce)) return
      const now = Date.now()
      this.pruneExpiredGrantsForRoom(roomId, now)
      const grant = this.e2eeGrants.get(roomId)?.get(reqId)
      if (!grant || grant.roomId !== roomId || grant.requesterClientId === clientId || grant.expiresAt <= now) return
      if (grant.offeredByClientId && !this.clients.has(grant.offeredByClientId)) {
        grant.offeredByClientId = ''
        grant.approverPubKey = ''
        grant.approverNonce = ''
      }
      if (grant.offeredByClientId && grant.offeredByClientId !== clientId) return
      grant.offeredByClientId = clientId
      grant.approverPubKey = approverPubKey
      grant.approverNonce = approverNonce
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
          ...(approverNonce ? { approverNonce } : {}),
        },
      })
      return
    }

    if (msg.type === 'e2ee.grant.reveal') {
      const reqId = String(msg.reqId || '').trim().toLowerCase()
      const requesterNonce = String(msg.requesterNonce || '').trim()
      if (!/^[0-9a-f]{16,32}$/.test(reqId) || !/^[A-Za-z0-9_-]{16,44}$/.test(requesterNonce)) return
      const now = Date.now()
      this.pruneExpiredGrantsForRoom(roomId, now)
      const grant = this.e2eeGrants.get(roomId)?.get(reqId)
      if (!grant || grant.roomId !== roomId || grant.requesterClientId !== clientId || grant.expiresAt <= now) return
      if (!grant.offeredByClientId || !this.clients.has(grant.offeredByClientId)) return
      this.sendToClient(grant.offeredByClientId, {
        type: 'event',
        ts: now,
        bridgeId: '',
        event: EVENTS.E2EE_GRANT_REVEAL || 'e2ee.grant.reveal',
        payload: {
          reqId,
          requesterNonce,
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
      this.pruneExpiredGrantsForRoom(roomId, now)
      const grant = this.e2eeGrants.get(roomId)?.get(reqId)
      if (!grant || grant.roomId !== roomId || grant.requesterClientId === clientId || grant.expiresAt <= now) return
      if (grant.offeredByClientId && !this.clients.has(grant.offeredByClientId)) {
        grant.offeredByClientId = ''
        grant.approverPubKey = ''
        grant.approverNonce = ''
      }
      if (grant.offeredByClientId && (grant.offeredByClientId !== clientId || grant.approverPubKey !== appPub)) {
        return
      }
      const requester = this.clients.get(grant.requesterClientId)
      if (!requester || requester.ws?.readyState !== 1) return
      this._deleteGrant(roomId, reqId)
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
          envelope: {
            v: 1,
            reqId,
            approverPubKey: appPub,
            iv,
            ct,
            ...(env.mode === 'qr' ? { mode: 'qr' } : {}),
          },
        },
      })
      this.pushRoomGrantEvent(roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId, reason: 'delivered' }, grant.requesterClientId)
      return
    }

    if (msg.type === 'e2ee.grant.reject') {
      const reqId = String(msg.reqId || '').trim().toLowerCase()
      const now = Date.now()
      this.pruneExpiredGrantsForRoom(roomId, now)
      const grant = this.e2eeGrants.get(roomId)?.get(reqId)
      if (!grant || grant.roomId !== roomId || grant.requesterClientId === clientId || grant.expiresAt <= now) return
      this._deleteGrant(roomId, reqId)
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
      const grant = this.e2eeGrants.get(roomId)?.get(reqId)
      if (!grant || grant.roomId !== roomId || grant.requesterClientId !== clientId) return
      this._deleteGrant(roomId, reqId)
      this.pushRoomGrantEvent(roomId, EVENTS.E2EE_GRANT_CANCEL, { reqId, reason: 'cancelled' }, clientId)
      return
    }

    if (msg.type === 'e2ee.qr.nudge') {
      const action = msg.action === 'done' ? 'done' : 'scanning'
      const wantedKeyId = String(msg.wantedKeyId || '').trim().toLowerCase()
      if (wantedKeyId && !/^[0-9a-f]{16}$/.test(wantedKeyId)) return
      const now = Date.now()
      if (action === 'scanning' && client.lastQrNudgeAt && now - client.lastQrNudgeAt < 4_000) {
        return
      }
      if (action === 'scanning') client.lastQrNudgeAt = now
      else client.lastQrNudgeAt = 0
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
    }
  }

  broadcastControlEvent(roomId, bridgeId, event, payload) {
    const rid = String(roomId || '').trim()
    if (!rid) return
    const now = Date.now()
    this.getOrCreateRoomStats(rid).lastActivityAt = now
    const frame = JSON.stringify({
      type: 'event',
      ts: now,
      bridgeId,
      event,
      payload,
    })
    for (const [, client] of this._getRoomClientEntries(rid)) {
      if (client.ws.readyState === 1) {
        this._safeSend(client.ws, frame)
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
    return this._safeSend(ws, JSON.stringify(payload))
  }

  updateBridgeLabel(roomId, bridgeId, newLabel) {
    const rid = String(roomId || '').trim()
    const bid = String(bridgeId || '').trim()
    const clean = String(newLabel || '').trim().slice(0, 64)
    if (!rid || !bid || !clean) return false
    const entry = this.bridges.get(this.bridgeKey(rid, bid))
    if (!entry) return false
    entry.meta = { ...entry.meta, label: clean }
    return true
  }

  broadcastRoomDevices(roomId) {
    const rid = String(roomId || '').trim()
    if (!rid) return
    const bridges = this.getBridgeList(rid)
    const devices = this.resolveRoomDevices(rid, bridges)
    this.broadcastControlEvent(rid, '', EVENTS.BRIDGE_STATUS, {
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
    this.recordActivity({
      type: 'bridge.offline',
      roomId: rid,
      label: entry.meta?.label || entry.meta?.hostname || bid,
      detail: entry.meta?.platform || '',
      ip: entry.meta?.ip || '',
    })
    this.log.info(`[control] Bridge disconnected: room=${rid} id=${bid}`)
    try { entry.ws.close(code, reason) } catch {}
    const bridges = this.getBridgeList(rid)
    const devices = this.resolveRoomDevices(rid, bridges)
    this.broadcastControlEvent(rid, bid, EVENTS.BRIDGE_STATUS, {
      bridgeId: bid,
      online: false,
      bridges,
      ...(devices ? { devices } : {}),
    })
    return true
  }

  _dropClients(targets, code = 4401, reason = 'Session revoked', grantReason = 'revoked', { notifyBridges = true } = {}) {
    if (!targets.length) return 0
    /** @type {Map<string, { ids: string[], sids: string[] }>} */
    const revokedByRoom = new Map()
    for (const [cid, client] of targets) {
      this.clients.delete(cid)
      this._unindexRoomClient(client.roomId, cid)
      if (grantReason === 'revoked') {
        const entry = revokedByRoom.get(client.roomId) || { ids: [], sids: [] }
        entry.ids.push(cid)
        if (client.sid) entry.sids.push(client.sid)
        revokedByRoom.set(client.roomId, entry)
      }
      try { client.ws.close(code, reason) } catch {}
    }
    for (const [cid, client] of targets) {
      this.cancelClientGrants(cid, grantReason, client.roomId)
    }
    if (notifyBridges) {
      for (const [rid, entry] of revokedByRoom.entries()) {
        this.notifyBridgesClientRevoked(rid, entry.ids, reason, { sids: entry.sids })
      }
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
    const disconnected = this._dropClients(targets, code, reason, 'revoked', { notifyBridges: false })
    const droppedIds = targets.map(([cid]) => cid)
    const droppedSids = [...new Set([targetSid, ...targets.map(([, c]) => c.sid)].filter(Boolean))]
    if (droppedIds.length > 0 || droppedSids.length > 0) {
      this.notifyBridgesClientRevoked(rid, droppedIds, reason, { sids: droppedSids })
    }
    if (disconnected > 0) {
      this.log.info(`[control] Kicked ${disconnected} client connection(s) in room=${rid}`)
      this.broadcastRoomClients(rid)
    }
    return disconnected
  }

  disconnectOtherRoomClients(roomId, { keepClientId = '', keepSid = '', newSidForKept = '' } = {}, code = 4401, reason = 'Session revoked') {
    const rid = String(roomId || '').trim()
    if (!rid) return 0
    const keepCid = String(keepClientId || '').trim()
    const keepSession = String(keepSid || '').trim()
    const nextKeepSid = String(newSidForKept || '').trim()
    const targets = []
    for (const [cid, client] of this._getRoomClientEntries(rid)) {
      if ((keepCid && cid === keepCid) || (keepSession && client.sid && client.sid === keepSession)) {
        if (nextKeepSid) client.sid = nextKeepSid
        continue
      }
      targets.push([cid, client])
    }
    const disconnected = this._dropClients(targets, code, reason, 'revoked', { notifyBridges: false })
    const droppedIds = targets.map(([cid]) => cid)
    const droppedSids = targets.map(([, c]) => c.sid).filter(Boolean)
    const keepSids = [keepSession, nextKeepSid].filter(Boolean)
    this.notifyBridgesClientRevoked(rid, droppedIds, reason, {
      sids: droppedSids,
      ...(keepSids.length > 0 ? { allExceptSids: keepSids } : { all: true }),
    })
    if (disconnected > 0) {
      this.log.info(`[control] Kicked ${disconnected} other client(s) in room=${rid}`)
      this.broadcastRoomClients(rid)
    }
    return disconnected
  }

  disconnectRoomClients(roomId, code = 4401, reason = 'Session revoked') {
    const rid = String(roomId || '').trim()
    if (!rid) return 0
    const targets = this._getRoomClientEntries(rid)
    const disconnected = this._dropClients(targets, code, reason, 'revoked', { notifyBridges: false })
    const droppedIds = targets.map(([cid]) => cid)
    const droppedSids = targets.map(([, c]) => c.sid).filter(Boolean)
    this.notifyBridgesClientRevoked(rid, droppedIds, reason, { sids: droppedSids, all: true })
    if (disconnected > 0) {
      this.log.info(`[control] Revoked and disconnected ${disconnected} client(s) in room=${rid}`)
    }
    return disconnected
  }

  pushIceUpdate(roomId, { quotaExceeded = false } = {}) {
    const rid = String(roomId || '').trim()
    if (!rid) return
    const iceServers = this.getIceServers(null, rid)
    const turnQuota = this.getTurnQuota(rid)
    const msg = {
      type: 'ice.update',
      iceServers,
      ...(turnQuota ? { turnQuota } : {}),
      quotaExceeded: Boolean(quotaExceeded || turnQuota?.exceeded),
      ts: Date.now(),
    }
    const frame = JSON.stringify(msg)
    for (const b of this.bridges.values()) {
      if (b.roomId === rid && b.ws.readyState === 1) {
        this._safeSend(b.ws, frame)
      }
    }
    for (const [, client] of this._getRoomClientEntries(rid)) {
      if (client.ws.readyState === 1) {
        this._safeSend(client.ws, frame)
      }
    }
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
    if (this._iceRefreshTimer) {
      clearInterval(this._iceRefreshTimer)
      this._iceRefreshTimer = null
    }
    for (const b of this.bridges.values()) {
      try { b.ws.close(1001, 'Server shutting down') } catch {}
    }
    for (const c of this.clients.values()) {
      try { c.ws.close(1001, 'Server shutting down') } catch {}
    }
  }
}
