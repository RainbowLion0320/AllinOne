import os from 'node:os'
import WebSocket from 'ws'

/**
 * Resilient outbound WebSocket client connecting home PC (DSH plugin) -> Relay Server.
 * Uses `ws` library (same proven approach as dsh-wecom-bot) with heartbeat & exponential backoff.
 */
export class RelayBridgeLink {
  constructor({
    relayUrl,
    secret,
    roomId = '',
    bridgeId = 'home-pc',
    mode = 'dsh-plugin',
    log = console,
    onRpc,
    onState,
  }) {
    this.relayUrl = relayUrl
    this.secret = secret
    this.roomId = roomId
    this.bridgeId = bridgeId
    this.mode = mode
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
  }

  setAppsMeta(apps) {
    this.metaApps = apps
    this.send({ type: 'bridge.meta', meta: { apps } })
  }

  start() {
    this.stopped = false
    this.connect()
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
      try {
        this.ws.close(1000, 'Bridge stopping')
      } catch {}
      this.ws = null
    }
    this.emitState('stopped', 'Bridge stopped')
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
    if (this.roomId) u.searchParams.set('roomId', this.roomId)
    return u.toString()
  }

  connect() {
    if (this.stopped) return
    this.emitState('connecting', this.relayUrl)

    let ws
    try {
      const headers = {
        'X-Bridge-Secret': this.secret,
      }
      if (this.roomId) headers['X-Room-Id'] = this.roomId
      ws = new WebSocket(this.buildUrl(), {
        headers,
        handshakeTimeout: 15_000,
      })
    } catch (err) {
      this.log.error?.(`mobile-hub: invalid relayUrl ${this.relayUrl}: ${String(err)}`)
      this.emitState('error', String(err))
      this.scheduleReconnect()
      return
    }

    this.ws = ws

    ws.on('open', () => {
      this.attempt = 0
      this.lastPongAt = Date.now()
      this.log.info?.(`mobile-hub: connected to relay ${this.relayUrl} as "${this.bridgeId}"`)
      this.emitState('connected', this.relayUrl)
      if (this.metaApps.length > 0) {
        this.send({ type: 'bridge.meta', meta: { apps: this.metaApps } })
      }
      this.startHeartbeat()
    })

    ws.on('message', async (raw) => {
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

      if (msg.type === 'rpc.req') {
        const id = msg.id
        try {
          const result = await this.onRpc(msg.method, msg.params || {})
          this.send({ type: 'rpc.res', id, ok: true, result })
        } catch (err) {
          this.send({
            type: 'rpc.res',
            id,
            ok: false,
            error: {
              code: err?.code || 'RPC_ERROR',
              message: String(err?.message || err),
            },
          })
        }
      }
    })

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString('utf8') : ''
      this.clearHeartbeat()
      if (this.ws === ws) this.ws = null
      if (this.stopped) return
      const detail = `closed code=${code}${reason ? ` (${reason})` : ''}`
      this.log.warn?.(`mobile-hub: relay ${detail}`)
      this.emitState('disconnected', detail)
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      this.log.warn?.(`mobile-hub: relay socket error: ${String(err?.message || err)}`)
      this.emitState('error', String(err?.message || err))
    })
  }

  startHeartbeat() {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPongAt > 65_000) {
        this.log.warn?.('mobile-hub: relay heartbeat timed out, reconnecting')
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

  pushEvent(event, payload) {
    this.send({ type: 'event', event, payload })
  }
}
