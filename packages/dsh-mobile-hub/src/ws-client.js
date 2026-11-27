import os from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION, WS_MSG } from '@allinone/shared'
import { EVENTS } from './protocol.js'
import {
  E2EE_VERSION,
  computeE2eeKeyId,
  normalizeE2eeKey,
} from '@allinone/shared/e2ee'
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
    bridgeVersion = '',
    e2eeKey = '',
    inboundDir = '',
    inboundStore = null,
    webrtcProxy = null,
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
    this.bridgeVersion = String(bridgeVersion || (typeof __ALLINONE_VERSION__ === 'string' ? __ALLINONE_VERSION__ : '') || '').trim()
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
    this.stableResetTimer = null
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
        this.send({ type: WS_MSG.P2P_SIGNAL, clientId, sessionId, e2ee })
      },
      onRpc: (method, params, ctx) => this.onRpc(method, params, ctx),
      onRegisterP2pUpload,
      inboundDir: resolvedInboundDir,
      inboundStore,
      webrtcProxy,
      log: this.log,
    })
  }

  async sendBridgeMeta() {
    if (!this.e2eeKeyId) {
      await this.e2eeReady
    }
    const meta = {
      ...(this.metaApps.length > 0 ? { apps: this.metaApps } : {}),
      ...(this.bridgeVersion ? { bridgeVersion: this.bridgeVersion } : {}),
      protocolVersion: PROTOCOL_VERSION,
      capabilities: PROTOCOL_CAPABILITIES,
      bridgeBootId: this.p2p.bridgeBootId,
      p2pEngine: this.p2p.getEngineName(),
      e2ee: { enabled: true, v: E2EE_VERSION, keyId: this.e2eeKeyId },
    }
    this.send({ type: WS_MSG.BRIDGE_META, meta })
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
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer)
      this.stableResetTimer = null
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

  close() {
    return this.stop()
  }

  /**
   * Called after OS wake/resume: immediately probe the control WS and tear it down if no pong arrives in 4s.
   */
  probeOrReconnect(reason = 'resume') {
    if (this.stopped) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.attempt = 0
      this.connect()
      return
    }
    const wsRef = this.ws
    const prevPongAt = this.lastPongAt
    this.send({ type: WS_MSG.PING, ts: Date.now() })
    const probeTimer = setTimeout(() => {
      if (this.stopped || this.ws !== wsRef) return
      if (this.lastPongAt <= prevPongAt) {
        this.log.warn?.(`mobile-hub: control socket unresponsive after ${reason}; reconnecting immediately`)
        try { wsRef.terminate() } catch {}
      }
    }, 4_000)
    probeTimer.unref?.()
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
        void this.p2p?.dispose?.().catch(() => {})
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
        if (this.stableResetTimer) clearTimeout(this.stableResetTimer)
        // Only reset exponential backoff once the connection stays healthy for 20s (prevents 1.5s 4001 kick-war storms)
        this.stableResetTimer = setTimeout(() => {
          this.stableResetTimer = null
          if (this.ws === ws && !this.stopped) this.attempt = 0
        }, 20_000)
        this.stableResetTimer.unref?.()
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

      if (msg.type === WS_MSG.PONG) {
        this.lastPongAt = Date.now()
        return
      }

      if (msg.type === WS_MSG.BRIDGE_WELCOME) {
        if (msg.protocolVersion && Number(msg.protocolVersion) !== PROTOCOL_VERSION) {
          this.log.warn?.(
            `mobile-hub: relay protocolVersion=${msg.protocolVersion} differs from local PROTOCOL_VERSION=${PROTOCOL_VERSION}`,
          )
        }
        if (Array.isArray(msg.iceServers)) {
          this.iceServers = msg.iceServers
        }
        return
      }

      if (msg.type === WS_MSG.ICE_UPDATE) {
        if (Array.isArray(msg.iceServers)) {
          this.iceServers = msg.iceServers
        }
        if (msg.quotaExceeded) {
          this.p2p.dropRelayedSessions()
        }
        return
      }

      if (msg.type === EVENTS.CLIENT_REVOKED) {
        this.p2p.revokeClients(msg.clientIds || [], {
          sids: msg.sids || [],
          all: Boolean(msg.all),
          allExceptSids: msg.allExceptSids || [],
        })
        return
      }

      if (msg.type === WS_MSG.P2P_SIGNAL) {
        try {
          await this.p2p.handleEncryptedSignal({
            clientId: msg.clientId,
            sid: msg.sid || '',
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
      if (this.stableResetTimer) {
        clearTimeout(this.stableResetTimer)
        this.stableResetTimer = null
      }
      this.ws = null
      if (this.stopped) return
      if (code === 4401) {
        void this.p2p?.dispose?.().catch(() => {})
        const detail = reason || 'Device unbound or credential revoked'
        this.log.warn?.(`mobile-hub: control server rejected bridge (${detail})`)
        this.emitState('unauthorized', detail)
        return
      }
      if (code === 4008) {
        void this.p2p?.dispose?.().catch(() => {})
        const detail = reason || 'E2EE required by control server'
        this.log.warn?.(`mobile-hub: control server rejected bridge (${detail})`)
        this.emitState('fatal', detail)
        return
      }
      const detail = `closed code=${code}${reason ? ` (${reason})` : ''}`
      this.log.warn?.(`mobile-hub: control server ${detail}`)
      this.emitState('disconnected', detail)
      if (code === 4001 || code === 4029) {
        // Back off heavily when replaced by another bridge instance or over room cap to avoid 1.5s kick-war storms
        this.attempt = Math.max(this.attempt, 6)
        this.scheduleReconnect(30_000 + Math.floor(Math.random() * 10_000))
        return
      }
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
      this.send({ type: WS_MSG.PING, ts: Date.now() })
    }, 20_000)
    this.heartbeatTimer.unref?.()
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  scheduleReconnect(minDelayMs = 0) {
    if (this.stopped || this.reconnectTimer) return
    const baseDelay = Math.min(30_000, 1_500 * Math.pow(1.6, Math.min(this.attempt, 8)))
    const delayMs = Math.max(minDelayMs, baseDelay)
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
