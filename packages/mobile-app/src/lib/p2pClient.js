import {
  decryptAutoStream,
  decryptBinaryJson,
  decryptJson,
  encryptBinaryJson,
  encryptChunkedBytes,
  encryptJson,
  isCompressibleFile,
} from '@allinone/shared/e2ee'
import {
  BULK_FLAG_EOF,
  BULK_SLICE_BYTES,
  P2P_BULK_LABEL,
  P2P_CTRL_LABEL,
  createBulkWindowController,
  createCtrlCodec,
  createSerializedChannelWriter,
  decodeBulkFrame,
  encodeBulkFrame,
  sendWithBackpressure,
} from '@allinone/shared/p2p-mux'
import { bi, getCurrentLang } from './i18n.js'

const L = (zh, en) => bi(getCurrentLang(), zh, en)

const P2P_CONNECT_TIMEOUT_MS = 15_000
const P2P_KEEPALIVE_MS = 20_000
const P2P_KEEPALIVE_TIMEOUT_MS = 45_000
const P2P_DISCONNECTED_RESTART_MS = 3_000
const P2P_BULK_INITIAL_WINDOW_BYTES = 8 * 1024 * 1024 // 8 MB receiver credit window
const P2P_BULK_WINDOW_REPLENISH_BYTES = 256 * 1024 // Replenish every >= 256 KB actually consumed
const P2P_BULK_MAX_QUEUE_BYTES = 24 * 1024 * 1024 // 24 MB hard safety cap against misbehaving peer
const MAX_P2P_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB local disk safety cap (0 bytes via server)

function createAsyncByteQueue(maxBytes = P2P_BULK_MAX_QUEUE_BYTES, { onConsume = null } = {}) {
  const cap = Math.max(1024 * 1024, Number(maxBytes) || P2P_BULK_MAX_QUEUE_BYTES)
  const chunks = []
  let queuedBytes = 0
  let waiter = null
  let ended = false
  let error = null

  const push = (u8) => {
    if (ended || error) return false
    if (u8 && u8.byteLength > 0) {
      if (waiter) {
        const w = waiter
        waiter = null
        w.resolve({ value: u8, done: false })
      } else {
        if (queuedBytes + u8.byteLength > cap) {
          fail(
            new Error(
              L(
                'P2P 下载缓冲区超出安全上限，已中止传输',
                'P2P download buffer exceeded safety limit; stream aborted',
              ),
            ),
          )
          return false
        }
        chunks.push(u8)
        queuedBytes += u8.byteLength
      }
    }
    return true
  }
  const end = () => {
    if (ended || error) return
    ended = true
    if (waiter) {
      const w = waiter
      waiter = null
      w.resolve({ value: undefined, done: true })
    }
  }
  const fail = (err) => {
    if (ended || error) return
    error = err || new Error(L('P2P 传输已中断', 'P2P transfer aborted'))
    chunks.length = 0
    queuedBytes = 0
    if (waiter) {
      const w = waiter
      waiter = null
      w.reject(error)
    }
  }

  const iterable = {
    [Symbol.asyncIterator]() {
      let lastDeliveredBytes = 0
      const notifyConsumed = () => {
        if (lastDeliveredBytes > 0) {
          const consumed = lastDeliveredBytes
          lastDeliveredBytes = 0
          try { onConsume?.(consumed) } catch {}
        }
      }
      return {
        next() {
          // Previous delivered chunk has now been fully processed by decryptAutoStream / onPlainChunk
          notifyConsumed()
          if (chunks.length > 0) {
            const nextChunk = chunks.shift()
            queuedBytes = Math.max(0, queuedBytes - nextChunk.byteLength)
            lastDeliveredBytes = nextChunk.byteLength
            return Promise.resolve({ value: nextChunk, done: false })
          }
          if (error) return Promise.reject(error)
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve, reject) => {
            waiter = {
              resolve: (item) => {
                if (!item.done && item.value) {
                  lastDeliveredBytes = item.value.byteLength
                }
                resolve(item)
              },
              reject,
            }
          })
        },
      }
    },
  }

  return {
    push,
    end,
    fail,
    iterable,
    get queuedBytes() {
      return queuedBytes
    },
  }
}

function makeUnreachableError(detail = '') {
  const msg = detail
    ? L(
        `P2P 直连失败（${detail}），当前网络可能拦截了 UDP 穿透，请切换 Wi-Fi / 5G 后重试`,
        `Direct P2P connection failed (${detail}). Your network may block UDP NAT traversal. Switch Wi-Fi / 5G and retry.`,
      )
    : L(
        'P2P 直连受当前网络防火墙限制，请切换 Wi-Fi / 5G 后点击重试',
        'Direct P2P connection is blocked by the current network firewall. Switch Wi-Fi / 5G and tap Retry.',
      )
  const err = new Error(msg)
  err.code = 'P2P_UNREACHABLE'
  return err
}

/**
 * Browser/Mobile-side WebRTC Direct P2P Peer Session (`AIO-P2P v1`).
 *
 * Establishes an E2EE-signaled direct RTCPeerConnection to a single PC bridge with 2 channels:
 *  - `aio-ctrl`: Ordered JSON control channel (E2EE RPCs, E2EE streaming events, E2EE bulk control)
 *  - `aio-bulk`: Ordered binary channel (E2EE AIO2 4MB-chunked files/images sliced into 64KB frames)
 *
 * ZERO server data-plane relay fallback: all chat, RPCs, images, and files flow 100% peer-to-peer.
 */
export class P2PPeerSession {
  constructor({
    bridgeId,
    roomId,
    getClientId,
    getE2eeContext,
    getIceServers,
    sendSignal,
    onStateChange,
    onEvent,
    initialEventSeq = 0,
    bridgeBootId = '',
    onEventSeq = null,
    onBridgeBootId = null,
  }) {
    this.bridgeId = String(bridgeId || '').trim()
    this.roomId = String(roomId || '').trim()
    this.getClientId = typeof getClientId === 'function' ? getClientId : () => ''
    this.getE2eeContext = getE2eeContext
    this.getIceServers = getIceServers || (() => [])
    this.sendSignal = sendSignal
    this.onStateChange = onStateChange || (() => {})
    this.onEvent = onEvent || (() => {})
    this.onEventSeq = typeof onEventSeq === 'function' ? onEventSeq : null
    this.onBridgeBootId = typeof onBridgeBootId === 'function' ? onBridgeBootId : null

    this.sessionId = `p2p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.state = 'idle' // 'idle' | 'connecting' | 'connected' | 'failed' | 'closed'
    this.error = ''
    this.errorCode = ''
    this.remoteEngine = ''
    this.transportType = '' // 'direct' | 'relay' | ''
    this.closed = false

    this.pc = null
    this.ctrlDc = null
    this.bulkDc = null
    this.ctrlCodec = createCtrlCodec()
    this.ctrlWriter = createSerializedChannelWriter(() => this.ctrlDc)
    this.remoteIceQueue = []
    this.remoteDescSet = false

    this._readyChecking = false
    this._readyPromise = null
    this._readyResolve = null
    this._readyReject = null
    this._connectTimer = null
    this._keepaliveTimer = null
    this._wakeGraceTimer = null
    this._disconnectTimer = null
    this._transportRecheckTimer = null
    this._lastPongAt = 0
    this._lastEventSeq = Math.max(0, Number(initialEventSeq) || 0)
    this._bridgeBootId = String(bridgeBootId || '').trim()
    this._syncSent = false

    this._reqSeq = 1
    this._uploadStreamSeq = 1
    this._pendingRpcs = new Map()
    this._activeDownloads = new Map() // streamId -> { queue, headerResolve, headerReject, receivedBytes, consumedUnackedBytes, totalSize, onProgress, cancelDownload }
    this._activeUploads = new Map() // transferId -> { streamId, readyResolve, readyReject, doneResolve, doneReject, windowCtrl, remoteError }
    this._inboundEventQueue = Promise.resolve()
    this._bulkCtrlQueue = Promise.resolve()
    this._ctrlDecodeQueue = Promise.resolve()
    this._bulkDecodeQueue = Promise.resolve()
  }

  isOpen() {
    return (
      !this.closed &&
      this.state === 'connected' &&
      this.ctrlDc?.readyState === 'open' &&
      this.bulkDc?.readyState === 'open'
    )
  }

  _setState(nextState, errorMsg = '', forceEmit = false, errorCode = '') {
    if (!forceEmit && this.state === nextState && this.error === errorMsg && this.errorCode === errorCode) return
    this.state = nextState
    this.error = errorMsg
    this.errorCode = errorCode
    try {
      this.onStateChange({
        bridgeId: this.bridgeId,
        state: this.state,
        error: this.error,
        errorCode: this.errorCode,
        engine: this.remoteEngine,
        transport: this.transportType,
      })
    } catch {}
  }

  _applyRemoteBootId(rawBootId) {
    const nextBootId = String(rawBootId || '').trim()
    if (!nextBootId) return
    if (this._bridgeBootId && this._bridgeBootId !== nextBootId) {
      this._bridgeBootId = nextBootId
      this._lastEventSeq = 0
      try { this.onBridgeBootId?.(nextBootId, true) } catch {}
      return
    }
    if (!this._bridgeBootId) {
      this._bridgeBootId = nextBootId
      try { this.onBridgeBootId?.(nextBootId, false) } catch {}
    }
  }

  _maybeSendEventSync() {
    if (this._syncSent || this.closed || this.ctrlDc?.readyState !== 'open') return
    if (this._lastEventSeq <= 0) return
    this._syncSent = true
    void this._sendCtrlJson({
      type: 'sync.sinceSeq',
      sinceSeq: this._lastEventSeq,
      ...(this._bridgeBootId ? { bridgeBootId: this._bridgeBootId } : {}),
    }).catch(() => {})
  }

  async _detectIceTransport() {
    if (this.closed || !this.pc || typeof this.pc.getStats !== 'function') return
    try {
      const stats = await this.pc.getStats()
      if (this.closed || !stats) return
      let selectedPair = null
      stats.forEach((rep) => {
        if (rep.type === 'transport' && rep.selectedCandidatePairId) {
          selectedPair = stats.get(rep.selectedCandidatePairId) || selectedPair
        }
      })
      if (!selectedPair) {
        let nominatedPair = null
        stats.forEach((rep) => {
          if (rep.type !== 'candidate-pair') return
          if (rep.selected) {
            selectedPair = rep
          } else if (!selectedPair && rep.nominated && rep.state === 'succeeded') {
            nominatedPair = nominatedPair || rep
          }
        })
        if (!selectedPair) selectedPair = nominatedPair
      }
      if (!selectedPair) return
      const localCand = selectedPair.localCandidateId ? stats.get(selectedPair.localCandidateId) : null
      const remoteCand = selectedPair.remoteCandidateId ? stats.get(selectedPair.remoteCandidateId) : null
      const isRelay = localCand?.candidateType === 'relay' || remoteCand?.candidateType === 'relay'
      const nextTransport = isRelay ? 'relay' : 'direct'
      if (nextTransport !== this.transportType && !this.closed) {
        this.transportType = nextTransport
        this._setState(this.state, this.error, true)
      }
    } catch {}
  }

  _getRequiredE2ee() {
    const ctx = this.getE2eeContext(this.bridgeId)
    if (!ctx?.ready || !ctx.key) {
      const err = new Error(
        L(
          '该电脑已开启端到端加密，请先扫描电脑端二维码同步密钥',
          'This computer requires End-to-End Encryption. Scan its QR code to sync the key.',
        ),
      )
      err.code = 'E2EE_KEY_REQUIRED'
      err.keyId = ctx?.keyId || ''
      throw err
    }
    return ctx
  }

  async _sendEncryptedSignal(inner, { allowWhenClosing = false } = {}) {
    if (this.closed && !allowWhenClosing) return
    const ctx = this._getRequiredE2ee()
    const clientId = String(this.getClientId?.() || '').trim()
    const payload = {
      ...inner,
      ...(clientId ? { clientId } : {}),
      sessionId: this.sessionId,
      ts: Date.now(),
    }
    const e2ee = await encryptJson(ctx.key, payload, { kind: 'p2p.signal', roomId: this.roomId })
    if (this.closed && !allowWhenClosing) return
    this.sendSignal({
      bridgeId: this.bridgeId,
      sessionId: this.sessionId,
      e2ee,
    })
  }

  _sendCtrlJson(obj) {
    if (this.closed || this.ctrlDc?.readyState !== 'open') {
      return Promise.reject(new Error(L('P2P 控制通道未就绪', 'P2P control channel is not open')))
    }
    let frames
    try {
      frames = this.ctrlCodec.encode(obj)
    } catch (err) {
      return Promise.reject(err)
    }
    const writes = frames.map((frame) => this.ctrlWriter.send(frame))
    return Promise.all(writes).then(() => true)
  }

  async _sendBulkCtrl(inner) {
    if (this.closed || this.ctrlDc?.readyState !== 'open') {
      throw new Error(L('P2P 控制通道未就绪', 'P2P control channel is not open'))
    }
    const ctx = this._getRequiredE2ee()
    const enc = await encryptBinaryJson(ctx.key, inner, { kind: 'p2p.bulk', roomId: this.roomId })
    await this._sendCtrlJson({ type: 'bulk.ctrl', bin: enc.bytes })
  }

  _checkChannelsReady() {
    if (this.closed || this.state === 'connected' || this._readyChecking) return
    if (this.ctrlDc?.readyState === 'open' && this.bulkDc?.readyState === 'open') {
      this._readyChecking = true
      if (this._connectTimer) {
        clearTimeout(this._connectTimer)
        this._connectTimer = null
      }
      this._startKeepalive()
      const finalize = () => {
        if (this.closed || this.state === 'connected') return
        this._setState('connected', '', true)
        if (!this.transportType && !this._transportRecheckTimer) {
          this._transportRecheckTimer = setTimeout(() => {
            this._transportRecheckTimer = null
            if (!this.closed && !this.transportType) {
              void this._detectIceTransport()
            }
          }, 1000)
        }
        if (this._readyResolve) {
          const res = this._readyResolve
          this._readyResolve = null
          this._readyReject = null
          res(this)
        }
      }
      // Detect direct vs TURN relay before signaling connected (~2ms locally) so Relay Data-Saver never races
      Promise.race([
        this._detectIceTransport(),
        new Promise((r) => setTimeout(r, 250)),
      ])
        .catch(() => {})
        .finally(finalize)
    }
  }

  _startKeepalive() {
    this._stopKeepalive()
    this._lastPongAt = Date.now()
    this._lastKeepaliveTickAt = this._lastPongAt
    this._keepaliveTimer = setInterval(() => {
      if (!this.isOpen()) return
      const now = Date.now()
      const tickGap = now - (this._lastKeepaliveTickAt || now)
      this._lastKeepaliveTickAt = now
      // Detect OS/mobile sleep jump (> 2.5x keepalive interval): send probe ping and check liveness in 6s
      if (tickGap > P2P_KEEPALIVE_MS * 2.5) {
        this.probeLiveness(6_000)
        return
      }
      if (this._wakeGraceTimer) return
      if (this._lastPongAt > 0 && now - this._lastPongAt > P2P_KEEPALIVE_TIMEOUT_MS) {
        this._failAndTeardown(
          new Error(L('P2P 直连心跳超时，请重试连接', 'P2P keepalive timed out. Please reconnect.')),
          'failed',
        )
        return
      }
      void this._sendCtrlJson({ type: 'ping', ts: now }).catch(() => {})
    }, P2P_KEEPALIVE_MS)
  }

  /**
   * Immediately probe DataChannel liveness (e.g. after mobile app resume / OS wake) with a short one-shot deadline.
   */
  probeLiveness(graceMs = 6_000) {
    if (this.closed) return
    const iceState = this.pc?.iceConnectionState
    if (iceState === 'failed' || iceState === 'closed') {
      this._failAndTeardown(makeUnreachableError(`ICE ${iceState}`), 'failed')
      return
    }
    if (!this.isOpen() || this._wakeGraceTimer) return
    const prevPong = this._lastPongAt
    void this._sendCtrlJson({ type: 'ping', ts: Date.now() }).catch(() => {})
    this._wakeGraceTimer = setTimeout(() => {
      this._wakeGraceTimer = null
      if (this.closed || !this.isOpen()) return
      if (this._lastPongAt <= prevPong) {
        this._failAndTeardown(
          new Error(L('休眠唤醒后 P2P 直连已中断，请重试连接', 'P2P connection dropped after device wake.')),
          'failed',
        )
      }
    }, graceMs)
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer)
      this._keepaliveTimer = null
    }
    if (this._wakeGraceTimer) {
      clearTimeout(this._wakeGraceTimer)
      this._wakeGraceTimer = null
    }
    if (this._disconnectTimer) {
      clearTimeout(this._disconnectTimer)
      this._disconnectTimer = null
    }
  }

  _failAndTeardown(err, finalState = 'failed') {
    if (this.closed && this.state === 'closed') return
    const reason = err instanceof Error ? err : new Error(String(err || L('P2P 直连已断开', 'P2P connection closed')))
    this.closed = true
    if (this._connectTimer) {
      clearTimeout(this._connectTimer)
      this._connectTimer = null
    }
    if (this._transportRecheckTimer) {
      clearTimeout(this._transportRecheckTimer)
      this._transportRecheckTimer = null
    }
    this._stopKeepalive()
    this.ctrlCodec.clear()
    try { this.ctrlWriter.close() } catch {}

    if (this._readyReject) {
      const rej = this._readyReject
      this._readyResolve = null
      this._readyReject = null
      rej(reason)
    }

    for (const p of this._pendingRpcs.values()) {
      clearTimeout(p.timer)
      p.reject(reason)
    }
    this._pendingRpcs.clear()

    for (const dl of this._activeDownloads.values()) {
      try { dl.headerReject?.(reason) } catch {}
      try { dl.queue.fail(reason) } catch {}
    }
    this._activeDownloads.clear()

    for (const up of this._activeUploads.values()) {
      try { up.windowCtrl?.abort(reason) } catch {}
      try { up.readyReject?.(reason) } catch {}
      try { up.doneReject?.(reason) } catch {}
    }
    this._activeUploads.clear()

    try { this.ctrlDc?.close?.() } catch {}
    try { this.bulkDc?.close?.() } catch {}
    try { this.pc?.close?.() } catch {}
    this.ctrlDc = null
    this.bulkDc = null
    this.pc = null

    this._setState(
      finalState,
      finalState === 'failed' ? reason.message : '',
      false,
      finalState === 'failed' ? String(reason.code || '') : '',
    )
  }

  connect() {
    if (this.isOpen()) return Promise.resolve(this)
    if (this._readyPromise) return this._readyPromise
    if (this.closed) return Promise.reject(makeUnreachableError())

    if (typeof RTCPeerConnection === 'undefined') {
      const err = new Error(L('当前浏览器环境不支持 WebRTC P2P 直连', 'WebRTC P2P is not supported in this browser'))
      err.code = 'P2P_UNSUPPORTED'
      this._failAndTeardown(err, 'failed')
      return Promise.reject(err)
    }

    try {
      this._getRequiredE2ee()
    } catch (err) {
      return Promise.reject(err)
    }

    this._setState('connecting', '')

    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve
      this._readyReject = reject
    })
    // Prevent unhandled rejection noise if background auto-connect fails before any explicit RPC awaits it
    this._readyPromise.catch(() => {})

    const iceServers = this.getIceServers()
    const pc = new RTCPeerConnection({
      iceServers: Array.isArray(iceServers) ? iceServers : [],
      iceCandidatePoolSize: 2,
    })
    this.pc = pc

    const ctrlDc = pc.createDataChannel(P2P_CTRL_LABEL, { ordered: true })
    const bulkDc = pc.createDataChannel(P2P_BULK_LABEL, { ordered: true })
    ctrlDc.binaryType = 'arraybuffer'
    bulkDc.binaryType = 'arraybuffer'
    this.ctrlDc = ctrlDc
    this.bulkDc = bulkDc

    ctrlDc.onopen = () => {
      this._maybeSendEventSync()
      this._checkChannelsReady()
    }
    bulkDc.onopen = () => this._checkChannelsReady()

    const feedCtrlBytes = (u8) => {
      if (this.closed) return
      const msg = this.ctrlCodec.decode(u8)
      if (msg) this._handleCtrlMessage(msg)
    }

    ctrlDc.onmessage = (ev) => {
      if (this.closed) return
      const data = ev.data
      if (data instanceof ArrayBuffer) {
        feedCtrlBytes(new Uint8Array(data))
      } else if (ArrayBuffer.isView(data)) {
        feedCtrlBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        this._ctrlDecodeQueue = this._ctrlDecodeQueue
          .then(() => data.arrayBuffer())
          .then((buf) => {
            if (!this.closed) feedCtrlBytes(new Uint8Array(buf))
          })
          .catch(() => {})
      }
    }

    bulkDc.onmessage = (ev) => {
      if (this.closed) return
      const data = ev.data
      if (data instanceof ArrayBuffer) {
        this._handleBulkBytes(new Uint8Array(data))
      } else if (ArrayBuffer.isView(data)) {
        this._handleBulkBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        this._bulkDecodeQueue = this._bulkDecodeQueue
          .then(() => data.arrayBuffer())
          .then((buf) => {
            if (!this.closed) this._handleBulkBytes(new Uint8Array(buf))
          })
          .catch(() => {})
      }
    }

    const onChannelClosed = () => {
      if (this.closed) return
      this._failAndTeardown(
        this.state === 'connected'
          ? new Error(L('P2P 直连通道已断开', 'P2P direct channel disconnected'))
          : makeUnreachableError(),
        'failed',
      )
    }
    ctrlDc.onclose = onChannelClosed
    bulkDc.onclose = onChannelClosed
    ctrlDc.onerror = () => {}
    bulkDc.onerror = () => {}

    const localIceQueue = []
    let offerSent = false
    pc.onicecandidate = (ev) => {
      if (this.closed || !ev.candidate) return
      const cand =
        typeof ev.candidate.toJSON === 'function'
          ? ev.candidate.toJSON()
          : {
              candidate: ev.candidate.candidate,
              sdpMid: ev.candidate.sdpMid,
              sdpMLineIndex: ev.candidate.sdpMLineIndex,
            }
      if (!cand?.candidate) return
      if (!offerSent) {
        localIceQueue.push(cand)
        return
      }
      void this._sendEncryptedSignal({ kind: 'ice', candidate: cand }).catch(() => {})
    }

    pc.onconnectionstatechange = () => {
      if (this.closed || !this.pc) return
      const st = this.pc.connectionState
      if (st === 'connected') {
        void this._detectIceTransport()
      } else if (st === 'failed') {
        this._failAndTeardown(makeUnreachableError('ICE failed'), 'failed')
      } else if (st === 'closed') {
        this._failAndTeardown(new Error(L('P2P 连接已关闭', 'P2P connection closed')), 'failed')
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (this.closed || !this.pc) return
      const st = this.pc.iceConnectionState
      if (st === 'connected' || st === 'completed') {
        if (this._disconnectTimer) {
          clearTimeout(this._disconnectTimer)
          this._disconnectTimer = null
        }
        void this._detectIceTransport()
      } else if (st === 'disconnected') {
        if (!this._disconnectTimer) {
          this._disconnectTimer = setTimeout(() => {
            this._disconnectTimer = null
            if (this.closed || !this.pc) return
            if (this.pc.iceConnectionState === 'disconnected') {
              // Fail cleanly after brief jitter grace so MobileRelayClient rebuilds a fresh peer
              this._failAndTeardown(makeUnreachableError('ICE disconnected'), 'failed')
            }
          }, P2P_DISCONNECTED_RESTART_MS)
        }
      } else if (st === 'failed') {
        this._failAndTeardown(makeUnreachableError('ICE failed'), 'failed')
      }
    }

    this._connectTimer = setTimeout(() => {
      if (this.closed || this.isOpen()) return
      this._failAndTeardown(makeUnreachableError('timeout'), 'failed')
    }, P2P_CONNECT_TIMEOUT_MS)

    void (async () => {
      try {
        const offer = await pc.createOffer()
        if (this.closed) return
        await pc.setLocalDescription(offer)
        if (this.closed) return
        await this._sendEncryptedSignal({ kind: 'offer', sdp: offer.sdp })
        offerSent = true
        while (localIceQueue.length > 0 && !this.closed) {
          const cand = localIceQueue.shift()
          void this._sendEncryptedSignal({ kind: 'ice', candidate: cand }).catch(() => {})
        }
      } catch (err) {
        if (!this.closed) {
          this._failAndTeardown(err, 'failed')
        }
      }
    })()

    return this._readyPromise
  }

  async handleEncryptedSignal({ sessionId, e2ee }) {
    if (this.closed || !this.pc) return
    if (sessionId && sessionId !== this.sessionId) return
    if (!e2ee) return

    let ctx
    try {
      ctx = this._getRequiredE2ee()
    } catch {
      return
    }

    let inner
    try {
      inner = await decryptJson(ctx.key, e2ee, { kind: 'p2p.signal', roomId: this.roomId })
    } catch (decErr) {
      try {
        this.onEvent('p2p.signal.decrypt_error', {
          bridgeId: this.bridgeId,
          code: decErr?.code || 'E2EE_DECRYPT_FAILED',
          message: String(decErr?.message || L('端到端信令解密失败，请核对密钥指纹', 'Failed to decrypt P2P signal')),
        })
      } catch {}
      return
    }
    if (this.closed || !this.pc || !inner || typeof inner !== 'object') return
    if (inner.sessionId && String(inner.sessionId) !== this.sessionId) return

    if (inner.kind === 'close') {
      this._failAndTeardown(new Error(L('电脑端已关闭 P2P 连接', 'Computer closed the P2P connection')), 'failed')
      return
    }

    if (inner.kind === 'answer' && inner.sdp) {
      this.remoteEngine = String(inner.engine || '')
      if (inner.bridgeBootId || inner.bootId) {
        this._applyRemoteBootId(inner.bridgeBootId || inner.bootId)
      }
      try {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: inner.sdp })
        this.remoteDescSet = true
        while (this.remoteIceQueue.length > 0 && !this.closed && this.pc) {
          const cand = this.remoteIceQueue.shift()
          await this.pc.addIceCandidate(cand).catch(() => {})
        }
      } catch (err) {
        this._failAndTeardown(err, 'failed')
      }
      return
    }

    if (inner.kind === 'ice' && inner.candidate) {
      if (!this.remoteDescSet) {
        this.remoteIceQueue.push(inner.candidate)
      } else {
        await this.pc.addIceCandidate(inner.candidate).catch(() => {})
      }
    }
  }

  handleSignalError({ sessionId, code, message }) {
    if (this.closed) return
    if (sessionId && sessionId !== this.sessionId) return
    const err = new Error(message || L('电脑端当前不在线', 'Target computer is offline'))
    err.code = code || 'BRIDGE_OFFLINE'
    this._failAndTeardown(err, 'failed')
  }

  _handleCtrlMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    this._lastPongAt = Date.now()

    if (msg.type === 'pong') return
    if (msg.type === 'ping') {
      void this._sendCtrlJson({ type: 'pong', ts: Date.now() }).catch(() => {})
      return
    }
    if (msg.type === 'p2p.hello') {
      this._applyRemoteBootId(msg.bridgeBootId || msg.bootId)
      this._maybeSendEventSync()
      return
    }
    if (msg.type === 'sync.reset') {
      this._lastEventSeq = 0
      this._applyRemoteBootId(msg.bridgeBootId || msg.bootId)
      return
    }

    if (msg.type === 'rpc.res') {
      const p = this._pendingRpcs.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this._pendingRpcs.delete(msg.id)

      if (msg.bin) {
        const ctx = this.getE2eeContext(this.bridgeId)
        const key = p.e2eeKey || ctx?.key || ''
        if (!key) {
          const err = new Error(L('缺少端到端解密密钥', 'Missing E2EE decryption key'))
          err.code = 'E2EE_KEY_REQUIRED'
          p.reject(err)
          return
        }
        decryptBinaryJson(key, msg.bin, { kind: 'rpc.res', roomId: this.roomId })
          .then((inner) => {
            if (p.cid && inner?.cid && inner.cid !== p.cid) {
              const err = new Error(L('端到端响应编号校验失败', 'E2EE response correlation mismatch'))
              err.code = 'E2EE_CORRELATION_MISMATCH'
              p.reject(err)
              return
            }
            if (inner?.ok) p.resolve(inner.result)
            else {
              const err = new Error(inner?.error?.message || L('RPC 执行失败', 'RPC execution failed'))
              if (inner?.error?.code) err.code = inner.error.code
              p.reject(err)
            }
          })
          .catch((err) => p.reject(err))
        return
      }

      if (msg.ok) {
        const err = new Error(L('拒绝接收未加密的异常响应', 'Rejected unexpected plaintext response'))
        err.code = 'E2EE_UNEXPECTED_PLAINTEXT'
        p.reject(err)
        return
      }
      const err = new Error(msg.error?.message || L('RPC 执行失败', 'RPC execution failed'))
      if (msg.error?.code) err.code = msg.error.code
      if (msg.error?.keyId) err.keyId = msg.error.keyId
      p.reject(err)
      return
    }

    if (msg.type === 'event' && msg.bin) {
      const ctx = this.getE2eeContext(this.bridgeId)
      const key = ctx?.key || ''
      if (!key) return
      const binSnap = msg.bin
      const rawMsg = { ...msg, bridgeId: this.bridgeId, transport: 'p2p' }
      this._inboundEventQueue = this._inboundEventQueue
        .then(async () => {
          if (this.closed) return
          const inner = await decryptBinaryJson(key, binSnap, { kind: 'event', roomId: this.roomId })
          if (this.closed || !inner?.event) return
          if (inner.event === 'p2p.hello') {
            this._applyRemoteBootId(inner.payload?.bridgeBootId || inner.payload?.bootId)
            return
          }
          const seqNum =
            typeof inner.seq === 'number'
              ? inner.seq
              : typeof msg.seq === 'number'
                ? msg.seq
                : null
          if (seqNum !== null && Number.isFinite(seqNum)) {
            if (seqNum <= this._lastEventSeq) {
              return
            }
            this._lastEventSeq = seqNum
            try { this.onEventSeq?.(seqNum) } catch {}
          }
          try {
            this.onEvent(inner.event, inner.payload, rawMsg)
          } catch {}
        })
        .catch(() => {})
      return
    }

    if (msg.type === 'bulk.ctrl' && msg.bin) {
      const ctx = this.getE2eeContext(this.bridgeId)
      const key = ctx?.key || ''
      if (!key) return
      const binSnap = msg.bin
      this._bulkCtrlQueue = this._bulkCtrlQueue
        .then(async () => {
          if (this.closed) return
          const inner = await decryptBinaryJson(key, binSnap, { kind: 'p2p.bulk', roomId: this.roomId })
          if (!this.closed && inner && typeof inner === 'object') {
            this._handleBulkCtrl(inner)
          }
        })
        .catch(() => {})
    }
  }

  _handleBulkCtrl(inner) {
    if (inner.action === 'download.header') {
      const streamId = Number(inner.streamId)
      const dl = this._activeDownloads.get(streamId)
      if (dl && dl.headerResolve) {
        const res = dl.headerResolve
        dl.headerResolve = null
        dl.headerReject = null
        res(inner)
      }
      return
    }

    if (inner.action === 'download.error') {
      const streamId = Number(inner.streamId)
      const dl = this._activeDownloads.get(streamId)
      if (dl) {
        const err = new Error(inner.message || L('电脑端读取文件失败', 'Computer failed to read file'))
        dl.headerReject?.(err)
        dl.headerResolve = null
        dl.headerReject = null
        dl.queue.fail(err)
        this._activeDownloads.delete(streamId)
      }
      return
    }

    if (inner.action === 'upload.ready' || inner.action === 'upload_ready') {
      const up = this._activeUploads.get(String(inner.transferId || ''))
      if (up && up.readyResolve) {
        const res = up.readyResolve
        up.readyResolve = null
        up.readyReject = null
        res(inner)
      }
      return
    }

    if (inner.action === 'window') {
      const streamId = Number(inner.streamId)
      const credits = Number(inner.bytes || 0)
      if (credits > 0 && (!inner.direction || inner.direction === 'upload')) {
        for (const up of this._activeUploads.values()) {
          if (up.streamId === streamId && up.windowCtrl) {
            up.windowCtrl.grant(credits)
            break
          }
        }
      }
      return
    }

    if (inner.action === 'upload.done') {
      const transferId = String(inner.transferId || '')
      const up = this._activeUploads.get(transferId)
      if (up) {
        this._activeUploads.delete(transferId)
        up.windowCtrl?.abort(new Error('Upload complete'))
        up.doneResolve?.(inner)
      }
      return
    }

    if (inner.action === 'upload.error') {
      const transferId = String(inner.transferId || '')
      const up = this._activeUploads.get(transferId)
      if (up) {
        this._activeUploads.delete(transferId)
        const err = new Error(inner.message || L('P2P 上传失败', 'P2P upload failed'))
        up.remoteError = err
        up.windowCtrl?.abort(err)
        up.readyReject?.(err)
        up.doneReject?.(err)
      }
    }
  }

  _handleBulkBytes(u8) {
    this._lastPongAt = Date.now()
    const frame = decodeBulkFrame(u8)
    if (!frame) return
    const dl = this._activeDownloads.get(frame.streamId)
    if (!dl) return
    if (frame.payload.byteLength > 0) {
      dl.receivedBytes += frame.payload.byteLength
      const accepted = dl.queue.push(frame.payload)
      if (!accepted) {
        this._activeDownloads.delete(frame.streamId)
        dl.headerReject?.(
          new Error(
            L(
              'P2P 下载缓冲区超出安全上限，已中止传输',
              'P2P download buffer exceeded safety limit; stream aborted',
            ),
          ),
        )
        dl.headerResolve = null
        dl.headerReject = null
        dl.cancelDownload?.()
        return
      }
      if (typeof dl.onProgress === 'function') {
        try {
          dl.onProgress({ loaded: dl.receivedBytes, total: dl.totalSize || 0 })
        } catch {}
      }
    }
    if (frame.eof) {
      dl.queue.end()
    }
  }

  async rpc(method, params = {}, timeoutMs = 45_000) {
    await this.connect()
    const ctx = this._getRequiredE2ee()
    if (!this.isOpen()) {
      throw makeUnreachableError()
    }

    const id = `p-${this._reqSeq++}-${Date.now()}`
    const enc = await encryptBinaryJson(
      ctx.key,
      { method, params, cid: id, ts: Date.now() },
      { kind: 'rpc.req', roomId: this.roomId },
    )

    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        reject(makeUnreachableError())
        return
      }
      const timer = setTimeout(() => {
        if (!this._pendingRpcs.has(id)) return
        this._pendingRpcs.delete(id)
        reject(new Error(L('P2P 请求超时，请检查电脑端连接状态', 'P2P request timed out. Check your computer connection.')))
      }, timeoutMs)

      this._pendingRpcs.set(id, {
        resolve,
        reject,
        timer,
        cid: id,
        e2eeKey: ctx.key,
      })

      this._sendCtrlJson({ type: 'rpc.req', id, bin: enc.bytes }).catch((sendErr) => {
        const pending = this._pendingRpcs.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this._pendingRpcs.delete(id)
        pending.reject(
          sendErr instanceof Error
            ? sendErr
            : new Error(L('P2P 通道发送失败', 'Failed to send request over P2P channel')),
        )
      })
    })
  }

  /**
   * Pull an ACL-verified file directly from the PC over `aio-bulk` (AIO2 4MB chunked E2EE + 64KB slices).
   */
  async downloadBulkStream(
    streamId,
    { mimeType = 'application/octet-stream', size = 0, onProgress = null, onPlainChunk = null, signal = null } = {},
  ) {
    const cleanId = Number(streamId)
    if (!Number.isInteger(cleanId) || cleanId <= 0) {
      throw new Error(L('无效的 P2P 文件流编号', 'Invalid P2P file stream ID'))
    }
    await this.connect()
    const ctx = this._getRequiredE2ee()

    let cancelSent = false
    const sendDownloadCancel = () => {
      if (cancelSent) return
      cancelSent = true
      void this._sendBulkCtrl({ action: 'cancel', streamId: cleanId, direction: 'download' }).catch(() => {})
    }

    let consumedUnackedBytes = 0
    const onQueueConsumed = (consumedBytes) => {
      if (this.closed || !this._activeDownloads.has(cleanId)) return
      consumedUnackedBytes += consumedBytes
      if (consumedUnackedBytes >= P2P_BULK_WINDOW_REPLENISH_BYTES) {
        const grantBytes = consumedUnackedBytes
        consumedUnackedBytes = 0
        void this._sendBulkCtrl({
          action: 'window',
          streamId: cleanId,
          direction: 'download',
          bytes: grantBytes,
        }).catch(() => {})
      }
    }

    const queue = createAsyncByteQueue(P2P_BULK_MAX_QUEUE_BYTES, { onConsume: onQueueConsumed })
    let headerResolve = null
    let headerReject = null
    const headerPromise = new Promise((res, rej) => {
      headerResolve = res
      headerReject = rej
    })
    headerPromise.catch(() => {})

    const dl = {
      queue,
      headerResolve,
      headerReject,
      receivedBytes: 0,
      totalSize: Number(size || 0),
      onProgress,
      cancelDownload: sendDownloadCancel,
    }
    this._activeDownloads.set(cleanId, dl)

    const onAbort = () => {
      const err = new Error(L('已取消文件传输', 'File transfer cancelled'))
      err.name = 'AbortError'
      dl.headerReject?.(err)
      queue.fail(err)
      this._activeDownloads.delete(cleanId)
      sendDownloadCancel()
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        throw Object.assign(new Error('Transfer aborted'), { name: 'AbortError' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    let completedNormally = false
    try {
      await this._sendBulkCtrl({ action: 'pull', streamId: cleanId, windowBytes: P2P_BULK_INITIAL_WINDOW_BYTES })

      const headerTimer = setTimeout(() => {
        dl.headerReject?.(new Error(L('等待电脑端开始发送文件超时', 'Timed out waiting for computer file stream')))
      }, 30_000)

      let header
      try {
        header = await headerPromise
      } finally {
        clearTimeout(headerTimer)
      }

      if (!header?.e2ee?.iv) {
        throw new Error(L('缺少端到端解密文件头', 'Missing E2EE stream header'))
      }

      const dec = await decryptAutoStream(ctx.key, queue.iterable, {
        iv: header.e2ee.iv,
        kid: header.e2ee.kid || '',
        kind: 'upload',
        roomId: this.roomId,
        chunked: Boolean(header.e2ee.chunked),
        compressed: Boolean(header.e2ee.compressed),
        ...(typeof onPlainChunk === 'function' ? { onPlainChunk } : {}),
      })

      completedNormally = true
      return {
        blob: typeof onPlainChunk === 'function' ? null : new Blob(dec.chunks || [], { type: mimeType || 'application/octet-stream' }),
        size: dec.totalPlainBytes,
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      this._activeDownloads.delete(cleanId)
      if (!completedNormally) {
        sendDownloadCancel()
      }
    }
  }

  /**
   * Stream a local File/Blob directly from Phone/Browser to PC over `aio-bulk` (0 bytes via server!).
   * Returns `{ id: p2pToken, p2pToken, filename, mimeType, size, localPreviewUrl? }`.
   */
  async uploadFileBulk(file, { onProgress = null, signal = null } = {}) {
    if (!file) throw new Error(L('未选择文件', 'No file selected'))
    const totalSize = Number(file.size || 0)
    if (totalSize > MAX_P2P_UPLOAD_BYTES) {
      throw new Error(L('单个文件超过本机安全上限 (2 GB)', 'File exceeds local safety cap (2 GB)'))
    }
    await this.connect()
    const ctx = this._getRequiredE2ee()
    if (!this.isOpen()) throw makeUnreachableError()

    const transferId = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const streamId = this._uploadStreamSeq++
    const realMime = String(file.type || 'application/octet-stream')
    const filename = String(file.name || 'upload.bin')

    let readyResolve = null
    let readyReject = null
    let doneResolve = null
    let doneReject = null
    const readyPromise = new Promise((res, rej) => {
      readyResolve = res
      readyReject = rej
    })
    readyPromise.catch(() => {})
    const donePromise = new Promise((res, rej) => {
      doneResolve = res
      doneReject = rej
    })
    donePromise.catch(() => {})

    const uploadEntry = {
      streamId,
      readyResolve,
      readyReject,
      doneResolve,
      doneReject,
      windowCtrl: null,
      remoteError: null,
    }
    this._activeUploads.set(transferId, uploadEntry)

    let cancelSent = false
    let uploadStarted = false
    let completed = false
    const sendUploadCancel = () => {
      if (cancelSent) return
      cancelSent = true
      void this._sendBulkCtrl({ action: 'cancel', streamId, direction: 'upload' }).catch(() => {})
    }

    const onAbort = () => {
      const err = new Error(L('已取消文件上传', 'File upload cancelled'))
      err.name = 'AbortError'
      uploadEntry.windowCtrl?.abort(err)
      readyReject?.(err)
      doneReject?.(err)
      this._activeUploads.delete(transferId)
      sendUploadCancel()
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        throw Object.assign(new Error('Transfer aborted'), { name: 'AbortError' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const waitReadyWithTimeout = async () => {
      let timer = null
      try {
        return await Promise.race([
          readyPromise,
          new Promise((_, rej) => {
            timer = setTimeout(
              () => rej(new Error(L('等待电脑端接收通道就绪超时', 'Timed out waiting for computer upload receiver'))),
              20_000,
            )
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    try {
      let seq = 0
      let sentBytes = 0

      await encryptChunkedBytes(ctx.key, file, {
        kind: 'upload',
        roomId: this.roomId,
        compress: isCompressibleFile(realMime, filename),
        onHeader: async (e2eeMeta) => {
          uploadStarted = true
          await this._sendBulkCtrl({
            action: 'upload.start',
            transferId,
            streamId,
            filename,
            mimeType: realMime,
            size: totalSize,
            e2ee: e2eeMeta,
          })
          const readyInfo = await waitReadyWithTimeout()
          const initialWin = Number(readyInfo?.windowBytes || 0)
          if (Number.isFinite(initialWin) && initialWin > 0) {
            uploadEntry.windowCtrl = createBulkWindowController({
              initialWindowBytes: initialWin,
              timeoutMs: 45_000,
            })
          }
        },
        onChunk: async (cipherChunk) => {
          for (let off = 0; off < cipherChunk.byteLength; off += BULK_SLICE_BYTES) {
            if (uploadEntry.remoteError) throw uploadEntry.remoteError
            if (signal?.aborted || this.closed) {
              const err = new Error('Transfer aborted')
              err.name = 'AbortError'
              throw err
            }
            const slice = cipherChunk.subarray(off, Math.min(cipherChunk.byteLength, off + BULK_SLICE_BYTES))
            if (uploadEntry.windowCtrl) {
              await uploadEntry.windowCtrl.consume(slice.byteLength, signal)
            }
            if (uploadEntry.remoteError) throw uploadEntry.remoteError
            const frame = encodeBulkFrame(streamId, seq++, slice, 0)
            await sendWithBackpressure(this.bulkDc, frame, { signal })
            sentBytes += slice.byteLength
            if (typeof onProgress === 'function') {
              try { onProgress({ loaded: Math.min(sentBytes, totalSize), total: totalSize }) } catch {}
            }
          }
        },
      })
      if (typeof onProgress === 'function') {
        try { onProgress({ loaded: totalSize, total: totalSize }) } catch {}
      }

      if (uploadEntry.remoteError) throw uploadEntry.remoteError
      const eofFrame = encodeBulkFrame(streamId, seq++, new Uint8Array(0), BULK_FLAG_EOF)
      await sendWithBackpressure(this.bulkDc, eofFrame, { signal })

      let doneTimer = null
      let done
      try {
        done = await Promise.race([
          donePromise,
          new Promise((_, rej) => {
            doneTimer = setTimeout(
              () => rej(new Error(L('等待电脑端完成校验超时', 'Timed out waiting for computer upload confirmation'))),
              60_000,
            )
          }),
        ])
      } finally {
        if (doneTimer) clearTimeout(doneTimer)
      }

      completed = true

      const localPreviewUrl =
        realMime.startsWith('image/') &&
        totalSize <= 50 * 1024 * 1024 &&
        typeof URL?.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : ''

      return {
        id: done.p2pToken,
        p2pToken: done.p2pToken,
        filename: done.filename || filename,
        mimeType: done.mimeType || realMime,
        size: Number(done.size ?? totalSize),
        ...(localPreviewUrl ? { localPreviewUrl } : {}),
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      uploadEntry.windowCtrl?.abort(new Error('Upload closed'))
      this._activeUploads.delete(transferId)
      if (!completed && uploadStarted) {
        sendUploadCancel()
      }
    }
  }

  close(notifyPeer = true) {
    if (this.closed) return Promise.resolve()
    let notifyPromise = Promise.resolve()
    if (notifyPeer && this.pc) {
      notifyPromise = this._sendEncryptedSignal({ kind: 'close' }, { allowWhenClosing: true }).catch(() => {})
    }
    this._failAndTeardown(new Error(L('连接已关闭', 'Connection closed')), 'closed')
    return notifyPromise
  }
}
