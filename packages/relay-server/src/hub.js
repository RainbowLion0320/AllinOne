import { randomUUID } from 'node:crypto'
import { EVENTS } from '@allinone/shared'

const EVENT_BUFFER_SIZE = 200
const DEFAULT_RPC_TIMEOUT_MS = 120_000

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
 * Strictly room-isolated multi-tenant WebSocket hub connecting:
 *  - PC Bridges (each bound to a single `roomId`: `'owner'` or `'rm_<id>'`)
 *  - Mobile App WebSocket clients (each JWT-bound to a single `roomId`)
 *
 * Guarantees Room A can NEVER see Room B's bridges, events, RPCs, or files.
 */
export class RelayHub {
  constructor({ log = console, getRoomDevices = null } = {}) {
    this.log = log
    this.getRoomDevices = typeof getRoomDevices === 'function' ? getRoomDevices : null
    /** @type {Map<string, { roomId: string, bridgeId: string, ws: import('ws').WebSocket, meta: any, connectedAt: number, lastSeen: number }>} */
    this.bridges = new Map() // key = `${roomId}::${bridgeId}`
    /** @type {Map<string, { roomId: string, ws: import('ws').WebSocket, user: any, connectedAt: number }>} */
    this.clients = new Map()
    /** @type {Map<string, any>} */
    this.pendingRpc = new Map()
    /** @type {Map<string, { seq: number, buffer: any[] }>} */
    this.roomEvents = new Map()
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
    return `${roomId || 'owner'}::${bridgeId || 'home-pc'}`
  }

  getRoomEventState(roomId) {
    const rid = roomId || 'owner'
    let st = this.roomEvents.get(rid)
    if (!st) {
      st = { seq: 0, buffer: [] }
      this.roomEvents.set(rid, st)
    }
    return st
  }

  getOnlineBridgeCount() {
    let n = 0
    for (const b of this.bridges.values()) {
      if (b.ws.readyState === 1) n += 1
    }
    return n
  }

  getBridgeList(roomId = 'owner') {
    const rid = roomId || 'owner'
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
        mode: b.meta?.mode || 'dsh-plugin',
        apps: b.meta?.apps || [],
        connectedAt: b.connectedAt,
        lastSeen: b.lastSeen,
      })
    }
    return out
  }

  getPrimaryBridge(roomId = 'owner', requestedId) {
    const rid = roomId || 'owner'
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
    const roomId = String(meta.roomId || 'owner').trim() || 'owner'
    const bridgeId = String(meta.bridgeId || 'home-pc').trim() || 'home-pc'
    const key = this.bridgeKey(roomId, bridgeId)
    const existing = this.bridges.get(key)
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(4001, 'Replaced by newer bridge connection')
      } catch {}
    }

    const now = Date.now()
    const entry = { roomId, bridgeId, ws, meta, connectedAt: now, lastSeen: now }
    this.bridges.set(key, entry)
    this.log.info(
      `[relay] Bridge connected: room=${roomId} id=${bridgeId} (${meta.hostname || 'unknown'}, mode=${meta.mode || 'unknown'})`,
    )

    const bridges = this.getBridgeList(roomId)
    const devices = this.resolveRoomDevices(roomId, bridges)
    this.broadcastEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
      bridgeId,
      online: true,
      bridges,
      ...(devices ? { devices } : {}),
    })

    ws.on('message', (raw) => {
      entry.lastSeen = Date.now()
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      this.handleBridgeMessage(roomId, bridgeId, msg)
    })

    ws.on('close', () => {
      if (this.bridges.get(key)?.ws === ws) {
        this.bridges.delete(key)
        this.log.info(`[relay] Bridge disconnected: room=${roomId} id=${bridgeId}`)
        for (const [relayReqId, pending] of this.pendingRpc.entries()) {
          if (pending.bridgeKey === key) {
            clearTimeout(pending.timer)
            this.pendingRpc.delete(relayReqId)
            if (pending.reject) {
              pending.reject(new Error('电脑端连接已断开，请稍后重试'))
            } else {
              this.sendToClient(pending.clientId, {
                type: 'rpc.res',
                id: pending.clientReqId,
                ok: false,
                error: { code: 'BRIDGE_DISCONNECTED', message: '电脑端连接已断开，请稍后重试' },
              })
            }
          }
        }
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

  getClientList(roomId = 'owner') {
    const rid = roomId || 'owner'
    const out = []
    for (const [clientId, c] of this.clients.entries()) {
      if (c.roomId !== rid || c.ws.readyState !== 1) continue
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
    const rid = String(roomId || 'owner').trim() || 'owner'
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
    for (const client of this.clients.values()) {
      if (client.roomId === rid && client.ws.readyState === 1) {
        try {
          client.ws.send(frame)
        } catch {}
      }
    }
  }

  registerClient(ws, user, { lastSeq = 0, ip = '', userAgent = '' } = {}) {
    const clientId = randomUUID()
    const roomId = String(user?.room || 'owner').trim() || 'owner'
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
    }
    this.clients.set(clientId, entry)
    this.log.info(`[relay] Mobile client connected: ${clientId} (room=${roomId}, dev=${parsed.deviceName}, ip=${entry.ip || 'unknown'})`)

    const evState = this.getRoomEventState(roomId)

    const bridges = this.getBridgeList(roomId)
    const devices = this.resolveRoomDevices(roomId, bridges)
    const clients = this.getClientList(roomId)
    this.sendRaw(ws, {
      type: 'hello',
      clientId,
      sid: entry.sid,
      roomId,
      seq: evState.seq,
      bridges,
      ...(devices ? { devices } : {}),
      clients,
      onlineClientCount: clients.length,
      ts: Date.now(),
    })

    // Notify sibling clients in this room immediately that another controlling client connected
    this.broadcastRoomClients(roomId)

    if (Number.isFinite(lastSeq) && lastSeq > 0 && lastSeq < evState.seq) {
      for (const item of evState.buffer) {
        if (item.seq > lastSeq) {
          this.sendRaw(ws, { type: 'event', ...item })
        }
      }
    }

    ws.on('message', (raw) => {
      entry.lastSeenAt = Date.now()
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      this.handleClientMessage(clientId, msg)
    })

    ws.on('close', () => {
      const existed = this.clients.delete(clientId)
      this.log.info(`[relay] Mobile client disconnected: ${clientId} (room=${roomId})`)
      if (existed) {
        this.broadcastRoomClients(roomId)
      }
    })
  }

  handleBridgeMessage(roomId, bridgeId, msg) {
    if (!msg || typeof msg !== 'object') return
    const key = this.bridgeKey(roomId, bridgeId)

    if (msg.type === 'ping') {
      const bridge = this.bridges.get(key)
      if (bridge) this.sendRaw(bridge.ws, { type: 'pong', ts: Date.now() })
      return
    }

    if (msg.type === 'bridge.meta') {
      const bridge = this.bridges.get(key)
      if (bridge) {
        bridge.meta = { ...bridge.meta, ...(msg.meta || {}) }
        const bridges = this.getBridgeList(roomId)
        const devices = this.resolveRoomDevices(roomId, bridges)
        this.broadcastEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
          bridgeId,
          online: true,
          bridges,
          ...(devices ? { devices } : {}),
        })
      }
      return
    }

    if (msg.type === 'rpc.res') {
      const pending = this.pendingRpc.get(msg.id)
      if (!pending || pending.roomId !== roomId) return
      clearTimeout(pending.timer)
      this.pendingRpc.delete(msg.id)
      if (pending.resolve) {
        if (msg.ok) pending.resolve(msg.result)
        else pending.reject(new Error(msg.error?.message || 'RPC 执行失败'))
      } else {
        this.sendToClient(pending.clientId, {
          type: 'rpc.res',
          id: pending.clientReqId,
          ok: Boolean(msg.ok),
          result: msg.result,
          error: msg.error,
        })
      }
      return
    }

    if (msg.type === 'event') {
      this.broadcastEvent(roomId, bridgeId, msg.event, msg.payload)
    }
  }

  handleClientMessage(clientId, msg) {
    if (!msg || typeof msg !== 'object') return
    const client = this.clients.get(clientId)
    if (!client) return
    const roomId = client.roomId

    if (msg.type === 'ping') {
      this.sendToClient(clientId, { type: 'pong', ts: Date.now() })
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
      })

      this.sendRaw(bridge.ws, {
        type: 'rpc.req',
        id: relayReqId,
        method: msg.method,
        params: msg.params ?? {},
      })
    }
  }

  /**
   * Direct Promise-based RPC call from Relay HTTP routes (e.g. `/api/bridge-file`)
   * strictly scoped to the authenticated caller's `roomId`.
   */
  callBridge(roomId, method, params = {}, { bridgeId, timeoutMs = 30_000 } = {}) {
    const rid = roomId || 'owner'
    const requestedBridgeId = String(bridgeId || '').trim()
    return new Promise((resolvePromise, rejectPromise) => {
      const bridge = this.getPrimaryBridge(rid, requestedBridgeId)
      if (!bridge) {
        const err = new Error(
          requestedBridgeId ? `目标电脑（${requestedBridgeId}）桥接未在线` : '电脑端桥接未在线',
        )
        err.code = 'BRIDGE_OFFLINE'
        rejectPromise(err)
        return
      }
      const relayReqId = randomUUID()
      const timer = setTimeout(() => {
        if (!this.pendingRpc.has(relayReqId)) return
        this.pendingRpc.delete(relayReqId)
        const err = new Error('读取电脑端文件超时')
        err.code = 'RPC_TIMEOUT'
        rejectPromise(err)
      }, timeoutMs)

      this.pendingRpc.set(relayReqId, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
        roomId: rid,
        bridgeKey: this.bridgeKey(rid, bridge.bridgeId),
      })

      this.sendRaw(bridge.ws, {
        type: 'rpc.req',
        id: relayReqId,
        method,
        params,
      })
    })
  }

  broadcastEvent(roomId, bridgeId, event, payload) {
    const rid = roomId || 'owner'
    const evState = this.getRoomEventState(rid)
    evState.seq += 1
    const envelope = {
      seq: evState.seq,
      ts: Date.now(),
      bridgeId,
      event,
      payload,
    }
    evState.buffer.push(envelope)
    if (evState.buffer.length > EVENT_BUFFER_SIZE) {
      evState.buffer.shift()
    }
    const frame = JSON.stringify({ type: 'event', ...envelope })
    for (const client of this.clients.values()) {
      if (client.roomId === rid && client.ws.readyState === 1) {
        try {
          client.ws.send(frame)
        } catch {}
      }
    }
  }

  sendToClient(clientId, payload) {
    const client = this.clients.get(clientId)
    if (!client) return
    this.sendRaw(client.ws, payload)
  }

  sendRaw(ws, payload) {
    if (ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify(payload))
    } catch {}
  }

  broadcastRoomDevices(roomId) {
    const rid = String(roomId || 'owner').trim() || 'owner'
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
    const rid = String(roomId || 'owner').trim() || 'owner'
    const bid = String(bridgeId || '').trim()
    if (!bid) return false
    const key = this.bridgeKey(rid, bid)
    const entry = this.bridges.get(key)
    if (!entry) return false
    try {
      entry.ws.close(code, reason)
    } catch {}
    return true
  }

  disconnectClient(roomId, { clientId = '', sid = '' } = {}, code = 4401, reason = 'Session revoked') {
    const rid = String(roomId || 'owner').trim() || 'owner'
    const targetCid = String(clientId || '').trim()
    const targetSid = String(sid || '').trim()
    if (!targetCid && !targetSid) return 0
    let disconnected = 0
    const droppedClientIds = new Set()
    for (const [cid, client] of this.clients.entries()) {
      if (client.roomId !== rid) continue
      const matchCid = targetCid && cid === targetCid
      const matchSid = targetSid && client.sid && client.sid === targetSid
      if (!matchCid && !matchSid) continue
      droppedClientIds.add(cid)
      this.clients.delete(cid)
      disconnected += 1
      try {
        client.ws.close(code, reason)
      } catch {}
    }
    for (const [relayReqId, pending] of this.pendingRpc.entries()) {
      if (pending.roomId === rid && pending.clientId && droppedClientIds.has(pending.clientId)) {
        clearTimeout(pending.timer)
        this.pendingRpc.delete(relayReqId)
      }
    }
    if (disconnected > 0) {
      this.log.info(`[relay] Kicked ${disconnected} client connection(s) in room=${rid}`)
      this.broadcastRoomClients(rid)
    }
    return disconnected
  }

  disconnectOtherRoomClients(roomId, { keepClientId = '', keepSid = '', newSidForKept = '' } = {}, code = 4401, reason = 'Session revoked') {
    const rid = String(roomId || 'owner').trim() || 'owner'
    const keepCid = String(keepClientId || '').trim()
    const keepSession = String(keepSid || '').trim()
    let disconnected = 0
    const droppedClientIds = new Set()
    for (const [cid, client] of this.clients.entries()) {
      if (client.roomId !== rid) continue
      if (keepCid && cid === keepCid) {
        if (newSidForKept) client.sid = String(newSidForKept)
        continue
      }
      if (keepSession && client.sid && client.sid === keepSession) {
        if (newSidForKept) client.sid = String(newSidForKept)
        continue
      }
      droppedClientIds.add(cid)
      this.clients.delete(cid)
      disconnected += 1
      try {
        client.ws.close(code, reason)
      } catch {}
    }
    for (const [relayReqId, pending] of this.pendingRpc.entries()) {
      if (pending.roomId === rid && pending.clientId && droppedClientIds.has(pending.clientId)) {
        clearTimeout(pending.timer)
        this.pendingRpc.delete(relayReqId)
      }
    }
    if (disconnected > 0) {
      this.log.info(`[relay] Kicked ${disconnected} other client(s) in room=${rid}`)
      this.broadcastRoomClients(rid)
    }
    return disconnected
  }

  disconnectRoomClients(roomId, code = 4401, reason = 'Session revoked') {
    const rid = String(roomId || 'owner').trim() || 'owner'
    let disconnected = 0
    const droppedClientIds = new Set()
    for (const [cid, client] of this.clients.entries()) {
      if (client.roomId !== rid) continue
      droppedClientIds.add(cid)
      this.clients.delete(cid)
      disconnected += 1
      try {
        client.ws.close(code, reason)
      } catch {}
    }
    for (const [relayReqId, pending] of this.pendingRpc.entries()) {
      if (pending.roomId === rid && pending.clientId && droppedClientIds.has(pending.clientId)) {
        clearTimeout(pending.timer)
        this.pendingRpc.delete(relayReqId)
      }
    }
    this.roomEvents.delete(rid)
    if (disconnected > 0) {
      this.log.info(`[relay] Revoked and disconnected ${disconnected} client(s) in room=${rid}`)
    }
    return disconnected
  }

  shutdown() {
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
