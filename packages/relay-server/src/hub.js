import { randomUUID } from 'node:crypto'
import { EVENTS } from '@allinone/shared'

const EVENT_BUFFER_SIZE = 200
const DEFAULT_RPC_TIMEOUT_MS = 120_000

/**
 * Strictly room-isolated multi-tenant WebSocket hub connecting:
 *  - PC Bridges (each bound to a single `roomId`: `'owner'` or `'rm_<id>'`)
 *  - Mobile App WebSocket clients (each JWT-bound to a single `roomId`)
 *
 * Guarantees Room A can NEVER see Room B's bridges, events, RPCs, or files.
 */
export class RelayHub {
  constructor({ log = console } = {}) {
    this.log = log
    /** @type {Map<string, { roomId: string, bridgeId: string, ws: import('ws').WebSocket, meta: any, connectedAt: number, lastSeen: number }>} */
    this.bridges = new Map() // key = `${roomId}::${bridgeId}`
    /** @type {Map<string, { roomId: string, ws: import('ws').WebSocket, user: any, connectedAt: number }>} */
    this.clients = new Map()
    /** @type {Map<string, any>} */
    this.pendingRpc = new Map()
    /** @type {Map<string, { seq: number, buffer: any[] }>} */
    this.roomEvents = new Map()
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
    if (requestedId) {
      const b = this.bridges.get(this.bridgeKey(rid, requestedId))
      if (b && b.ws.readyState === 1) return b
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

    this.broadcastEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
      bridgeId,
      online: true,
      bridges: this.getBridgeList(roomId),
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
        this.broadcastEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
          bridgeId,
          online: false,
          bridges: this.getBridgeList(roomId),
        })
      }
    })
  }

  registerClient(ws, user, { lastSeq = 0 } = {}) {
    const clientId = randomUUID()
    const roomId = String(user?.room || 'owner').trim() || 'owner'
    this.clients.set(clientId, { roomId, ws, user, connectedAt: Date.now() })
    this.log.info(`[relay] Mobile client connected: ${clientId} (room=${roomId}, dev=${user?.dev || 'mobile'})`)

    const evState = this.getRoomEventState(roomId)

    this.sendRaw(ws, {
      type: 'hello',
      clientId,
      roomId,
      seq: evState.seq,
      bridges: this.getBridgeList(roomId),
      ts: Date.now(),
    })

    if (Number.isFinite(lastSeq) && lastSeq > 0 && lastSeq < evState.seq) {
      for (const item of evState.buffer) {
        if (item.seq > lastSeq) {
          this.sendRaw(ws, { type: 'event', ...item })
        }
      }
    }

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      this.handleClientMessage(clientId, msg)
    })

    ws.on('close', () => {
      this.clients.delete(clientId)
      this.log.info(`[relay] Mobile client disconnected: ${clientId} (room=${roomId})`)
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
        this.broadcastEvent(roomId, bridgeId, EVENTS.BRIDGE_STATUS, {
          bridgeId,
          online: true,
          bridges: this.getBridgeList(roomId),
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
      const bridge = this.getPrimaryBridge(roomId, msg.bridgeId)
      if (!bridge) {
        this.sendToClient(clientId, {
          type: 'rpc.res',
          id: clientReqId,
          ok: false,
          error: {
            code: 'BRIDGE_OFFLINE',
            message: '你的电脑端桥接服务未在线，请确认电脑已开机并启动 All in One 电脑端桥接。',
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
    return new Promise((resolvePromise, rejectPromise) => {
      const bridge = this.getPrimaryBridge(rid, bridgeId)
      if (!bridge) {
        const err = new Error('电脑端桥接未在线')
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
