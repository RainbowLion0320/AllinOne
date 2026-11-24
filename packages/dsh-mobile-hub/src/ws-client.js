import os from 'node:os'
import WebSocket from 'ws'
import {
  E2EE_EVENT_MARKER,
  E2EE_IV_BYTES,
  E2EE_VERSION,
  base64UrlToBytes,
  bytesToBase64Url,
  computeE2eeKeyId,
  decryptJson,
  encryptJson,
  normalizeE2eeKey,
} from './helpers/e2ee.js'

const REPLAY_WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const MAX_SEEN_IVS = 4000

/**
 * Resilient outbound WebSocket client connecting home PC -> Relay Server.
 * Mandatory Zero-Knowledge AES-256-GCM End-to-End Encryption (E2EE):
 * every RPC request/response and streaming event is end-to-end encrypted
 * before touching the Relay Server, and unencrypted RPCs are strictly rejected.
 */
export class RelayBridgeLink {
  constructor({
    relayUrl,
    secret,
    roomId = '',
    bridgeId = 'home-pc',
    mode = 'desktop',
    e2eeKey = '',
    log = console,
    onRpc,
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
    this.seenReqIvs = new Map()
    this._eventQueue = Promise.resolve()
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

  getAadRoomId() {
    return this.roomId
  }

  async sendBridgeMeta() {
    if (!this.e2eeKeyId) {
      await this.e2eeReady
    }
    const meta = {
      ...(this.metaApps.length > 0 ? { apps: this.metaApps } : {}),
      e2ee: { enabled: true, v: E2EE_VERSION, keyId: this.e2eeKeyId },
    }
    this.send({ type: 'bridge.meta', meta })
  }

  setAppsMeta(apps) {
    this.metaApps = apps
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
    u.searchParams.set('roomId', this.roomId)
    if (this.e2eeKeyId) u.searchParams.set('e2eeKeyId', this.e2eeKeyId)
    return u.toString()
  }

  pruneSeenIvs(now) {
    if (this.seenReqIvs.size < MAX_SEEN_IVS) return
    for (const [iv, seenAt] of this.seenReqIvs.entries()) {
      if (now - seenAt > REPLAY_WINDOW_MS) this.seenReqIvs.delete(iv)
    }
    while (this.seenReqIvs.size >= MAX_SEEN_IVS) {
      const oldest = this.seenReqIvs.keys().next().value
      if (!oldest) break
      this.seenReqIvs.delete(oldest)
    }
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
      this.log.error?.(`mobile-hub: invalid relayUrl ${this.relayUrl}: ${String(err)}`)
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
        this.log.warn?.(`mobile-hub: relay rejected bridge (${detail})`)
        this.emitState('unauthorized', detail)
        return
      }
      const detail = `Unexpected server response: ${statusCode || 'unknown'}`
      this.clearHeartbeat()
      this.ws = null
      try { ws.terminate() } catch {}
      if (this.stopped) return
      this.log.warn?.(`mobile-hub: relay ${detail}`)
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
          `mobile-hub: connected to relay ${this.relayUrl} as "${this.bridgeId}" (E2EE AES-256-GCM)`,
        )
        this.emitState('connected', this.relayUrl)
        await this.sendBridgeMeta()
        if (this.ws !== ws || this.stopped) return
        this.startHeartbeat()
      } catch (err) {
        this.log.warn?.(`mobile-hub: relay open handler error: ${String(err?.message || err)}`)
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

      if (msg.type === 'rpc.req') {
        try {
          await this.handleEncryptedRpc(msg.id, msg)
        } catch (err) {
          this.log.warn?.(`mobile-hub: unhandled rpc.req(${msg.id}) error: ${String(err?.message || err)}`)
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
        this.log.warn?.(`mobile-hub: relay rejected bridge (${detail})`)
        this.emitState('unauthorized', detail)
        return
      }
      const detail = `closed code=${code}${reason ? ` (${reason})` : ''}`
      this.log.warn?.(`mobile-hub: relay ${detail}`)
      this.emitState('disconnected', detail)
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      if (this.ws !== ws || authRejected) return
      this.log.warn?.(`mobile-hub: relay socket error: ${String(err?.message || err)}`)
      this.emitState('error', String(err?.message || err))
    })
  }

  async handleEncryptedRpc(id, msg) {
    if (!this.e2eeKeyId) await this.e2eeReady
    const aadRoom = this.getAadRoomId()

    // Strictly reject unencrypted RPCs (including any relay-initiated plaintext calls)
    if (!msg.e2ee) {
      this.send({
        type: 'rpc.res',
        id,
        ok: false,
        error: {
          code: 'E2EE_KEY_REQUIRED',
          keyId: this.e2eeKeyId,
          message: '该电脑已开启端到端加密，请先扫描电脑端二维码同步端到端密钥',
        },
      })
      return
    }

    if (msg.e2ee.kid && msg.e2ee.kid !== this.e2eeKeyId) {
      this.send({
        type: 'rpc.res',
        id,
        ok: false,
        error: {
          code: 'E2EE_KEY_MISMATCH',
          keyId: this.e2eeKeyId,
          message: '端到端密钥不匹配，请重新扫描电脑端二维码同步最新密钥',
        },
      })
      return
    }

    let decrypted
    try {
      decrypted = await decryptJson(this.e2eeKey, msg.e2ee, { kind: 'rpc.req', roomId: aadRoom })
    } catch (err) {
      this.send({
        type: 'rpc.res',
        id,
        ok: false,
        error: {
          code: err?.code || 'E2EE_DECRYPT_FAILED',
          keyId: this.e2eeKeyId,
          message: String(err?.message || '端到端解密失败'),
        },
      })
      return
    }

    const now = Date.now()
    const ivBytes = base64UrlToBytes(msg.e2ee.iv)
    const ivKey = ivBytes && ivBytes.byteLength === E2EE_IV_BYTES ? bytesToBase64Url(ivBytes) : ''
    if (!ivKey) {
      this.send({
        type: 'rpc.res',
        id,
        ok: false,
        error: {
          code: 'E2EE_DECRYPT_FAILED',
          keyId: this.e2eeKeyId,
          message: '端到端密文 IV 无效',
        },
      })
      return
    }
    this.pruneSeenIvs(now)
    const prevSeen = this.seenReqIvs.get(ivKey)
    if (prevSeen && now - prevSeen <= REPLAY_WINDOW_MS) {
      this.send({
        type: 'rpc.res',
        id,
        ok: false,
        error: {
          code: 'E2EE_REPLAY_DETECTED',
          message: '检测到重复的加密请求，已拒绝执行',
        },
      })
      return
    }
    if (!Number.isFinite(decrypted?.ts) || Math.abs(now - decrypted.ts) > REPLAY_WINDOW_MS) {
      this.send({
        type: 'rpc.res',
        id,
        ok: false,
        error: {
          code: 'E2EE_STALE_TIMESTAMP',
          message: '加密请求时间偏差过大，请校准本机与手机系统时间后重试',
        },
      })
      return
    }
    this.seenReqIvs.set(ivKey, now)

    const cid = String(decrypted?.cid || '')
    let innerRes
    try {
      const result = await this.onRpc(decrypted.method, decrypted.params || {})
      innerRes = { ok: true, cid, result }
    } catch (err) {
      innerRes = {
        ok: false,
        cid,
        error: {
          code: err?.code || 'RPC_ERROR',
          message: String(err?.message || err),
        },
      }
    }

    try {
      const enc = await encryptJson(this.e2eeKey, innerRes, { kind: 'rpc.res', roomId: aadRoom })
      this.send({ type: 'rpc.res', id, ok: true, e2ee: enc })
    } catch (err) {
      this.log.warn?.(`mobile-hub: failed encrypting rpc.res: ${String(err?.message || err)}`)
      this.send({
        type: 'rpc.res',
        id,
        ok: false,
        error: {
          code: 'E2EE_ENCRYPT_FAILED',
          message: '端到端响应加密失败',
        },
      })
    }
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
    const aadRoom = this.getAadRoomId()
    // Preserve strict FIFO ordering across async AES-GCM encryptions for streaming deltas
    this._eventQueue = this._eventQueue
      .then(async () => {
        if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
        if (!this.e2eeKeyId) await this.e2eeReady
        const enc = await encryptJson(this.e2eeKey, { event, payload }, { kind: 'event', roomId: aadRoom })
        this.send({ type: 'event', event: E2EE_EVENT_MARKER, e2ee: enc })
      })
      .catch((err) => {
        this.log.warn?.(`mobile-hub: failed encrypting event ${event}: ${String(err?.message || err)}`)
      })
  }
}
