import os from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { EVENTS } from './protocol.js'
import {
  E2EE_VERSION,
  computeE2eeKeyId,
  normalizeE2eeKey,
} from './helpers/e2ee.js'
import { P2PBridgeManager } from './p2p/manager.js'

/**
 * Pure Control-Plane WebSocket link (PC Bridge <-> Control Server) + Pure WebRTC P2P Data Plane (`P2PBridgeManager`).
 *
 * Control WS handles ONLY:
 *  - Device presence (`bridge.meta`)
 *  - E2EE-wrapped WebRTC signaling (`p2p.signal`)
 *  - Instant device kick notifications (`client.revoked`)
 *
 * ALL RPCs, streaming chat events, images, and files run directly Peer-to-Peer over `P2PBridgeManager`.
 */
export class RelayBridgeLink {
  constructor({
    relayUrl,
    secret,
    roomId = '',
    bridgeId = 'home-pc',
    mode = 'desktop',
    e2eeKey = '',
    inboundDir = '',
    log = console,
    onRpc,
    onRegisterP2pUpload,
    onState,
  }) {
    const cleanRoomId = String(roomId || '').trim()
    if (!cleanRoomId.startsWith('usr_')) {
      throw new Error('RelayBridgeLink requires an account roomId (usr_*)')
    }
    const cleanE2eeKey = normalizeE2eeKey(e2eeKey)
    if (!cleanE2eeKey) {
      throw new Error('RelayBridgeLink requires a valid 256-bit E2EE key')
    }
    this.relayUrl = relayUrl
    this.secret = secret
    this.roomId = cleanRoomId
    this.bridgeId = bridgeId
    this.mode = mode
    this.e2eeKey = cleanE2eeKey
    this.e2eeKeyId = ''
    this.e2eeReady = computeE2eeKeyId(this.e2eeKey).then((kid) => {
      this.e2eeKeyId = kid
      return kid
    })
    this.e2eeReady.catch((err) => {
      this.log.error?.(`mobile-hub: failed computing E2EE keyId: ${String(err?.message || err)}`)
    })
    this.log = log
    this.onRpc = onRpc
    this.onState = onState
    this.ws = null
    this.stopped = false
    this.attempt = 0
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.lastPongAt = 0
    this.metaApps = []
    this.iceServers = []

    const resolvedInboundDir = inboundDir || join(
      String(process.env.DSH_HOME ?? '').trim() || join(os.homedir(), '.dsh'),
      'allinone-uploads',
    )

    this.p2p = new P2PBridgeManager({
      roomId: this.roomId,
      e2eeKey: this.e2eeKey,
      getE2eeKeyId: async () => this.e2eeKeyId || (await this.e2eeReady),
      getIceServers: () => this.iceServers,
      sendSignal: ({ clientId, sessionId, e2ee }) => {
        this.send({ type: EVENTS.P2P_SIGNAL, clientId, sessionId, e2ee })
      },
      onRpc: (method, params, ctx) => this.onRpc(method, params, ctx),
      onRegisterP2pUpload,
      inboundDir: resolvedInboundDir,
      log: this.log,
    })
  }

  getAadRoomId() {
    return this.roomId
  }

  async sendBridgeMeta() {
    if (!this.e2eeKeyId) {
      await this.e2eeReady
    }
    const meta = {
      ...(this.metaApps.length > 0 ? { apps: this.metaApps } : {}),
      p2pEngine: this.p2p.getEngineName(),
      e2ee: { enabled: true, v: E2EE_VERSION, keyId: this.e2eeKeyId },
    }
    this.send({ type: 'bridge.meta', meta })
  }

  setAppsMeta(apps) {
    // Strip E2EE-only subscription quota details before sending plaintext bridge.meta to Control Server
    this.metaApps = Array.isArray(apps)
      ? apps.map((item) => {
          if (!item || typeof item !== 'object') return item
          const { quota: _dropQuota, ...publicItem } = item
          return publicItem
        })
      : []
    this.sendBridgeMeta().catch((err) => {
      this.log.warn?.(`mobile-hub: failed sending bridge.meta: ${String(err?.message || err)}`)
    })
  }

  start() {
    this.stopped = false
    this.e2eeReady
      .then(() => {
        if (!this.stopped) this.connect()
      })
      .catch((err) => {
        this.emitState('error', String(err?.message || err))
      })
    return () => this.stop()
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearHeartbeat()
    if (this.ws) {
      try { this.ws.close(1000, 'Bridge stopping') } catch {}
      this.ws = null
    }
    const disposePromise = this.p2p?.dispose?.().catch(() => {}) || Promise.resolve()
    this.emitState('stopped', 'Bridge stopped')
    return disposePromise
  }

  emitState(state, detail = '') {
    try {
      this.onState?.(state, detail)
    } catch {}
  }

  buildUrl() {
    const u = new URL(this.relayUrl)
    u.searchParams.set('bridgeId', this.bridgeId)
    u.searchParams.set('hostname', os.hostname())
    u.searchParams.set('platform', process.platform)
    u.searchParams.set('mode', this.mode)
    u.searchParams.set('roomId', this.roomId)
    if (this.e2eeKeyId) u.searchParams.set('e2eeKeyId', this.e2eeKeyId)
    return u.toString()
  }

  connect() {
    if (this.stopped) return
    if (this.ws) {
      const prevWs = this.ws
      this.ws = null
      this.clearHeartbeat()
      try { prevWs.terminate() } catch {}
    }
    this.emitState('connecting', this.relayUrl)

    let ws
    try {
      const headers = {
        'X-Bridge-Secret': this.secret,
        'X-Room-Id': this.roomId,
        ...(this.e2eeKeyId ? { 'X-E2EE-Key-Id': this.e2eeKeyId } : {}),
      }
      ws = new WebSocket(this.buildUrl(), {
        headers,
        handshakeTimeout: 15_000,
      })
    } catch (err) {
      this.log.error?.(`mobile-hub: invalid control URL ${this.relayUrl}: ${String(err)}`)
      this.emitState('error', String(err))
      this.scheduleReconnect()
      return
    }

    this.ws = ws
    let authRejected = false

    ws.on('unexpected-response', (_req, res) => {
      if (this.ws !== ws) {
        try { res?.resume?.() } catch {}
        try { ws.terminate() } catch {}
        return
      }
      const statusCode = Number(res?.statusCode || 0)
      try { res?.resume?.() } catch {}
      if (statusCode === 401) {
        authRejected = true
        this.clearHeartbeat()
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }
        this.ws = null
        try { ws.terminate() } catch {}
        if (this.stopped) return
        const detail = 'HTTP 401 Unauthorized'
        this.log.warn?.(`mobile-hub: control server rejected bridge (${detail})`)
        this.emitState('unauthorized', detail)
        return
      }
      const detail = `Unexpected server response: ${statusCode || 'unknown'}`
      this.clearHeartbeat()
      this.ws = null
      try { ws.terminate() } catch {}
      if (this.stopped) return
      this.log.warn?.(`mobile-hub: control server ${detail}`)
      this.emitState('error', detail)
      this.emitState('disconnected', detail)
      this.scheduleReconnect()
    })

    ws.on('open', async () => {
      if (this.ws !== ws || this.stopped) {
        try { ws.close() } catch {}
        return
      }
      try {
        this.attempt = 0
        this.lastPongAt = Date.now()
        this.log.info?.(
          `mobile-hub: connected to control server ${this.relayUrl} as "${this.bridgeId}" (P2P ${this.p2p.getEngineName()} + E2EE AES-256-GCM)`,
        )
        this.emitState('connected', this.relayUrl)
        await this.sendBridgeMeta()
        if (this.ws !== ws || this.stopped) return
        this.startHeartbeat()
      } catch (err) {
        this.log.warn?.(`mobile-hub: control open handler error: ${String(err?.message || err)}`)
      }
    })

    ws.on('message', async (raw) => {
      if (this.ws !== ws || this.stopped) return
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }

      if (msg.type === 'pong') {
        this.lastPongAt = Date.now()
        return
      }

      if (msg.type === 'bridge.welcome') {
        if (Array.isArray(msg.iceServers)) {
          this.iceServers = msg.iceServers
        }
        return
      }

      if (msg.type === EVENTS.CLIENT_REVOKED) {
        this.p2p.revokeClients(msg.clientIds || [])
        return
      }

      if (msg.type === EVENTS.P2P_SIGNAL) {
        try {
          await this.p2p.handleEncryptedSignal({
            clientId: msg.clientId,
            sessionId: msg.sessionId,
            e2ee: msg.e2ee,
          })
        } catch (err) {
          this.log.warn?.(`mobile-hub: p2p.signal error: ${String(err?.message || err)}`)
        }
      }
    })

    ws.on('close', (code, reasonBuf) => {
      if (this.ws !== ws || authRejected) return
      const reason = reasonBuf ? reasonBuf.toString('utf8') : ''
      this.clearHeartbeat()
      this.ws = null
      if (this.stopped) return
      if (code === 4401) {
        const detail = reason || 'Device unbound or credential revoked'
        this.log.warn?.(`mobile-hub: control server rejected bridge (${detail})`)
        this.emitState('unauthorized', detail)
        return
      }
      const detail = `closed code=${code}${reason ? ` (${reason})` : ''}`
      this.log.warn?.(`mobile-hub: control server ${detail}`)
      this.emitState('disconnected', detail)
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      if (this.ws !== ws || authRejected) return
      this.log.warn?.(`mobile-hub: control socket error: ${String(err?.message || err)}`)
      this.emitState('error', String(err?.message || err))
    })
  }

  startHeartbeat() {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPongAt > 65_000) {
        this.log.warn?.('mobile-hub: control heartbeat timed out, reconnecting')
        try { this.ws.terminate() } catch {}
        return
      }
      this.send({ type: 'ping', ts: Date.now() })
    }, 20_000)
    this.heartbeatTimer.unref?.()
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const delayMs = Math.min(30_000, 1_500 * Math.pow(1.6, Math.min(this.attempt, 8)))
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  /**
   * Push streaming AI events directly to connected P2P peers (0 bytes through Control Server!).
   */
  pushEvent(event, payload) {
    if (this.stopped) return
    this.p2p.broadcastEvent(event, payload)
  }
}
