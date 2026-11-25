import {
  E2EE_CHUNKED_THRESHOLD,
  decryptAutoStream,
  decryptJson,
  encryptBytes,
  encryptChunkedBytes,
  encryptJson,
} from '@allinone/shared/e2ee'
import {
  BULK_FLAG_EOF,
  BULK_SLICE_BYTES,
  P2P_BULK_LABEL,
  P2P_CTRL_LABEL,
  createCtrlCodec,
  decodeBulkFrame,
  encodeBulkFrame,
  sendWithBackpressure,
} from '@allinone/shared/p2p-mux'
import { bi, getCurrentLang } from './i18n.js'

const L = (zh, en) => bi(getCurrentLang(), zh, en)

const P2P_CONNECT_TIMEOUT_MS = 15_000
const P2P_KEEPALIVE_MS = 20_000
const MAX_P2P_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB local disk safety cap (0 bytes via server)

function createAsyncByteQueue() {
  const chunks = []
  let waiter = null
  let ended = false
  let error = null

  const push = (u8) => {
    if (ended || error) return
    if (u8 && u8.byteLength > 0) {
      if (waiter) {
        const w = waiter
        waiter = null
        w.resolve({ value: u8, done: false })
      } else {
        chunks.push(u8)
      }
    }
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
    if (waiter) {
      const w = waiter
      waiter = null
      w.reject(error)
    }
  }

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (chunks.length > 0) {
            return Promise.resolve({ value: chunks.shift(), done: false })
          }
          if (error) return Promise.reject(error)
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve, reject) => {
            waiter = { resolve, reject }
          })
        },
      }
    },
  }

  return { push, end, fail, iterable }
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
    getE2eeContext,
    getIceServers,
    sendSignal,
    onStateChange,
    onEvent,
  }) {
    this.bridgeId = String(bridgeId || '').trim()
    this.roomId = String(roomId || '').trim()
    this.getE2eeContext = getE2eeContext
    this.getIceServers = getIceServers || (() => [])
    this.sendSignal = sendSignal
    this.onStateChange = onStateChange || (() => {})
    this.onEvent = onEvent || (() => {})

    this.sessionId = `p2p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.state = 'idle' // 'idle' | 'connecting' | 'connected' | 'failed' | 'closed'
    this.error = ''
    this.remoteEngine = ''
    this.transportType = '' // 'direct' | 'relay' | ''
    this.closed = false

    this.pc = null
    this.ctrlDc = null
    this.bulkDc = null
    this.ctrlCodec = createCtrlCodec()
    this.remoteIceQueue = []
    this.remoteDescSet = false

    this._readyPromise = null
    this._readyResolve = null
    this._readyReject = null
    this._connectTimer = null
    this._keepaliveTimer = null

    this._reqSeq = 1
    this._uploadStreamSeq = 1
    this._pendingRpcs = new Map()
    this._activeDownloads = new Map() // streamId -> { queue, headerResolve, headerReject, receivedBytes, totalSize, onProgress }
    this._activeUploads = new Map() // transferId -> { streamId, readyResolve, readyReject, doneResolve, doneReject }
    this._inboundEventQueue = Promise.resolve()
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

  _setState(nextState, errorMsg = '', forceEmit = false) {
    if (!forceEmit && this.state === nextState && this.error === errorMsg) return
    this.state = nextState
    this.error = errorMsg
    try {
      this.onStateChange({
        bridgeId: this.bridgeId,
        state: this.state,
        error: this.error,
        engine: this.remoteEngine,
        transport: this.transportType,
      })
    } catch {}
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
        stats.forEach((rep) => {
          if (rep.type === 'candidate-pair' && (rep.selected || (rep.nominated && rep.state === 'succeeded'))) {
            selectedPair = rep
          }
        })
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

  async _sendEncryptedSignal(inner) {
    if (this.closed) return
    const ctx = this._getRequiredE2ee()
    const e2ee = await encryptJson(ctx.key, inner, { kind: 'p2p.signal', roomId: this.roomId })
    if (this.closed) return
    this.sendSignal({
      bridgeId: this.bridgeId,
      sessionId: this.sessionId,
      e2ee,
    })
  }

  _sendCtrlJson(obj) {
    if (this.closed || this.ctrlDc?.readyState !== 'open') return false
    const frames = this.ctrlCodec.encode(obj)
    for (const f of frames) {
      try {
        this.ctrlDc.send(f)
      } catch {
        return false
      }
    }
    return true
  }

  async _sendBulkCtrl(inner) {
    if (this.closed || this.ctrlDc?.readyState !== 'open') {
      throw new Error(L('P2P 控制通道未就绪', 'P2P control channel is not open'))
    }
    const ctx = this._getRequiredE2ee()
    const e2ee = await encryptJson(ctx.key, inner, { kind: 'p2p.bulk', roomId: this.roomId })
    if (!this._sendCtrlJson({ type: 'bulk.ctrl', e2ee })) {
      throw new Error(L('P2P 发送控制指令失败', 'Failed to send P2P bulk control message'))
    }
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
    this._keepaliveTimer = setInterval(() => {
      if (this.isOpen()) {
        this._sendCtrlJson({ type: 'ping', ts: Date.now() })
      }
    }, P2P_KEEPALIVE_MS)
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer)
      this._keepaliveTimer = null
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
    this._stopKeepalive()
    this.ctrlCodec.clear()

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

    this._setState(finalState, finalState === 'failed' ? reason.message : '')
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
    bulkDc.binaryType = 'arraybuffer'
    this.ctrlDc = ctrlDc
    this.bulkDc = bulkDc

    ctrlDc.onopen = () => this._checkChannelsReady()
    bulkDc.onopen = () => this._checkChannelsReady()

    ctrlDc.onmessage = (ev) => {
      if (this.closed) return
      const msg = this.ctrlCodec.decode(ev.data)
      if (msg) this._handleCtrlMessage(msg)
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
      if (st === 'failed') {
        this._failAndTeardown(makeUnreachableError('ICE failed'), 'failed')
      } else if (st === 'closed') {
        this._failAndTeardown(new Error(L('P2P 连接已关闭', 'P2P connection closed')), 'failed')
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (this.closed || !this.pc) return
      if (this.pc.iceConnectionState === 'failed') {
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
    } catch {
      return
    }
    if (this.closed || !this.pc || !inner || typeof inner !== 'object') return

    if (inner.kind === 'close') {
      this._failAndTeardown(new Error(L('电脑端已关闭 P2P 连接', 'Computer closed the P2P connection')), 'failed')
      return
    }

    if (inner.kind === 'answer' && inner.sdp) {
      this.remoteEngine = String(inner.engine || '')
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

    if (msg.type === 'pong') return
    if (msg.type === 'ping') {
      this._sendCtrlJson({ type: 'pong', ts: Date.now() })
      return
    }

    if (msg.type === 'rpc.res') {
      const p = this._pendingRpcs.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this._pendingRpcs.delete(msg.id)

      if (msg.e2ee) {
        const ctx = this.getE2eeContext(this.bridgeId)
        const key = p.e2eeKey || ctx?.key || ''
        if (!key) {
          const err = new Error(L('缺少端到端解密密钥', 'Missing E2EE decryption key'))
          err.code = 'E2EE_KEY_REQUIRED'
          p.reject(err)
          return
        }
        decryptJson(key, msg.e2ee, { kind: 'rpc.res', roomId: this.roomId })
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

    if (msg.type === 'event' && msg.e2ee) {
      const ctx = this.getE2eeContext(this.bridgeId)
      const key = ctx?.key || ''
      if (!key) return
      const envSnap = msg.e2ee
      const rawMsg = { ...msg, bridgeId: this.bridgeId, transport: 'p2p' }
      this._inboundEventQueue = this._inboundEventQueue
        .then(async () => {
          if (this.closed) return
          const inner = await decryptJson(key, envSnap, { kind: 'event', roomId: this.roomId })
          if (this.closed || !inner?.event) return
          try {
            this.onEvent(inner.event, inner.payload, rawMsg)
          } catch {}
        })
        .catch(() => {})
      return
    }

    if (msg.type === 'bulk.ctrl' && msg.e2ee) {
      const ctx = this.getE2eeContext(this.bridgeId)
      const key = ctx?.key || ''
      if (!key) return
      decryptJson(key, msg.e2ee, { kind: 'p2p.bulk', roomId: this.roomId })
        .then((inner) => {
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

    if (inner.action === 'upload.ready') {
      const up = this._activeUploads.get(String(inner.transferId || ''))
      if (up && up.readyResolve) {
        const res = up.readyResolve
        up.readyResolve = null
        up.readyReject = null
        res(inner)
      }
      return
    }

    if (inner.action === 'upload.done') {
      const transferId = String(inner.transferId || '')
      const up = this._activeUploads.get(transferId)
      if (up) {
        this._activeUploads.delete(transferId)
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
        up.readyReject?.(err)
        up.doneReject?.(err)
      }
    }
  }

  _handleBulkBytes(u8) {
    const frame = decodeBulkFrame(u8)
    if (!frame) return
    const dl = this._activeDownloads.get(frame.streamId)
    if (!dl) return
    if (frame.payload.byteLength > 0) {
      dl.receivedBytes += frame.payload.byteLength
      dl.queue.push(frame.payload)
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
    const e2ee = await encryptJson(
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

      if (!this._sendCtrlJson({ type: 'rpc.req', id, e2ee })) {
        clearTimeout(timer)
        this._pendingRpcs.delete(id)
        reject(new Error(L('P2P 通道发送失败', 'Failed to send request over P2P channel')))
      }
    })
  }

  /**
   * Pull an ACL-verified file directly from the PC over `aio-bulk` (AIO2 4MB chunked E2EE + 64KB slices).
   */
  async downloadBulkStream(
    streamId,
    { mimeType = 'application/octet-stream', size = 0, onProgress = null, signal = null } = {},
  ) {
    const cleanId = Number(streamId)
    if (!Number.isInteger(cleanId) || cleanId <= 0) {
      throw new Error(L('无效的 P2P 文件流编号', 'Invalid P2P file stream ID'))
    }
    await this.connect()
    const ctx = this._getRequiredE2ee()

    const queue = createAsyncByteQueue()
    let headerResolve = null
    let headerReject = null
    const headerPromise = new Promise((res, rej) => {
      headerResolve = res
      headerReject = rej
    })

    const dl = {
      queue,
      headerResolve,
      headerReject,
      receivedBytes: 0,
      totalSize: Number(size || 0),
      onProgress,
    }
    this._activeDownloads.set(cleanId, dl)

    const onAbort = () => {
      const err = new Error(L('已取消文件传输', 'File transfer cancelled'))
      err.name = 'AbortError'
      dl.headerReject?.(err)
      queue.fail(err)
      this._activeDownloads.delete(cleanId)
      void this._sendBulkCtrl({ action: 'cancel', streamId: cleanId }).catch(() => {})
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        throw Object.assign(new Error('Transfer aborted'), { name: 'AbortError' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      await this._sendBulkCtrl({ action: 'pull', streamId: cleanId })

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
      })

      return {
        blob: new Blob(dec.chunks || [], { type: mimeType || 'application/octet-stream' }),
        size: dec.totalPlainBytes,
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      this._activeDownloads.delete(cleanId)
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
    const donePromise = new Promise((res, rej) => {
      doneResolve = res
      doneReject = rej
    })
    donePromise.catch(() => {})

    this._activeUploads.set(transferId, {
      streamId,
      readyResolve,
      readyReject,
      doneResolve,
      doneReject,
    })

    const onAbort = () => {
      const err = new Error(L('已取消文件上传', 'File upload cancelled'))
      err.name = 'AbortError'
      readyReject?.(err)
      doneReject?.(err)
      this._activeUploads.delete(transferId)
      void this._sendBulkCtrl({ action: 'cancel', streamId }).catch(() => {})
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
        await Promise.race([
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

      if (totalSize > E2EE_CHUNKED_THRESHOLD) {
        await encryptChunkedBytes(ctx.key, file, {
          kind: 'upload',
          roomId: this.roomId,
          onHeader: async (e2eeMeta) => {
            await this._sendBulkCtrl({
              action: 'upload.start',
              transferId,
              streamId,
              filename,
              mimeType: realMime,
              size: totalSize,
              e2ee: e2eeMeta,
            })
            await waitReadyWithTimeout()
          },
          onChunk: async (cipherChunk) => {
            for (let off = 0; off < cipherChunk.byteLength; off += BULK_SLICE_BYTES) {
              if (signal?.aborted || this.closed) {
                const err = new Error('Transfer aborted')
                err.name = 'AbortError'
                throw err
              }
              const slice = cipherChunk.subarray(off, Math.min(cipherChunk.byteLength, off + BULK_SLICE_BYTES))
              const frame = encodeBulkFrame(streamId, seq++, slice, 0)
              await sendWithBackpressure(this.bulkDc, frame, { signal })
              sentBytes += slice.byteLength
              if (typeof onProgress === 'function') {
                try { onProgress({ loaded: Math.min(sentBytes, totalSize), total: totalSize }) } catch {}
              }
            }
          },
        })
      } else {
        const rawBytes = new Uint8Array(await file.arrayBuffer())
        const enc = await encryptBytes(ctx.key, rawBytes, {
          kind: 'upload',
          roomId: this.roomId,
        })
        await this._sendBulkCtrl({
          action: 'upload.start',
          transferId,
          streamId,
          filename,
          mimeType: realMime,
          size: totalSize,
          e2ee: { v: enc.v, kid: enc.kid, iv: enc.iv },
        })
        await waitReadyWithTimeout()
        const cipher = enc.ciphertext
        for (let off = 0; off < cipher.byteLength; off += BULK_SLICE_BYTES) {
          const slice = cipher.subarray(off, Math.min(cipher.byteLength, off + BULK_SLICE_BYTES))
          const frame = encodeBulkFrame(streamId, seq++, slice, 0)
          await sendWithBackpressure(this.bulkDc, frame, { signal })
          sentBytes += slice.byteLength
        }
        if (typeof onProgress === 'function') {
          try { onProgress({ loaded: totalSize, total: totalSize }) } catch {}
        }
      }

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
      this._activeUploads.delete(transferId)
    }
  }

  close(notifyPeer = true) {
    if (this.closed) return
    if (notifyPeer && this.pc) {
      void this._sendEncryptedSignal({ kind: 'close' }).catch(() => {})
    }
    this._failAndTeardown(new Error(L('连接已关闭', 'Connection closed')), 'closed')
  }
}
