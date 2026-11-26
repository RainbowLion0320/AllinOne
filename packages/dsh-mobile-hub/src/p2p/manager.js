import { randomUUID } from 'node:crypto'
import { chmodSync, createWriteStream, mkdirSync, realpathSync } from 'node:fs'
import { open as openAsync, unlink as unlinkAsync } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  E2EE_CHUNKED_THRESHOLD,
  decryptAutoStream,
  decryptBinaryJson,
  decryptJson,
  encryptBinaryJson,
  encryptChunkedBytes,
  encryptJson,
  isCompressibleFile,
  parseBinaryE2eeHeader,
} from '@allinone/shared/e2ee'
import {
  BULK_FLAG_EOF,
  BULK_SLICE_BYTES,
  createCtrlCodec,
  decodeBulkFrame,
  encodeBulkFrame,
} from '@allinone/shared/p2p-mux'
import { EVENTS } from '../protocol.js'
import { ElectronWebRtcClient } from './peer-electron.js'
import { createWeriftPeer } from './peer-werift.js'

const REPLAY_WINDOW_MS = 10 * 60 * 1000
const MAX_SEEN_IVS = 4000
const MAX_ACTIVE_PEERS = 24
const REVOKED_TTL_MS = 24 * 60 * 60 * 1000
const DOWNLOAD_TICKET_TTL_MS = 120_000
const MAX_INBOUND_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB plaintext safety cap
const MAX_INBOUND_CIPHER_OVERHEAD_BYTES = 4 * 1024 * 1024 // headroom for AIO2 framing & GCM tags
const MAX_NON_CHUNKED_UPLOAD_BYTES = E2EE_CHUNKED_THRESHOLD + 64 * 1024 // prevent non-chunked in-memory OOM
const MAX_UPLOAD_QUEUE_BYTES = 32 * 1024 * 1024 // cap RAM buffered ahead of disk/AES-GCM
const STREAM_COALESCE_WINDOW_MS = 60
const STREAM_COALESCE_MAX_CHARS = 16 * 1024

/**
 * Push-pull async byte queue feeding `decryptAutoStream()` from incoming `aio-bulk` 64KB slices.
 */
function createAsyncByteQueue(maxQueuedBytes = MAX_UPLOAD_QUEUE_BYTES) {
  const chunks = []
  let queuedBytes = 0
  let waiter = null
  let ended = false
  let error = null

  const push = (u8) => {
    if (ended || error) return true
    if (u8 && u8.byteLength > 0) {
      if (waiter) {
        const w = waiter
        waiter = null
        w.resolve({ value: u8, done: false })
      } else {
        if (queuedBytes + u8.byteLength > maxQueuedBytes) {
          fail(new Error('上传写入速度过慢，缓冲区超出内存上限'))
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
    error = err || new Error('Stream aborted')
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
      return {
        next() {
          if (chunks.length > 0) {
            const nextChunk = chunks.shift()
            queuedBytes = Math.max(0, queuedBytes - nextChunk.byteLength)
            return Promise.resolve({ value: nextChunk, done: false })
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

/**
 * PC-side P2P Data Plane Manager (`AIO-P2P v1`).
 *
 * Responsibilities:
 *  - Dual-engine WebRTC peer factory: Electron native Chromium `libwebrtc` (when running inside
 *    All in One Desktop) or pure-JS `werift` (when running as standalone CLI / Linux headless).
 *  - E2EE-wrapped WebRTC signaling (`p2p.signal`: offer / answer / ice / close).
 *  - Instant device revocation (`revokeClients`) killing kicked peers in < 50ms.
 *  - Direct E2EE RPC execution & streaming event broadcast over `aio-ctrl`.
 *  - Streaming E2EE PC -> Phone file downloads & Phone -> PC attachment uploads over `aio-bulk`.
 */
export class P2PBridgeManager {
  constructor({
    roomId,
    e2eeKey,
    getE2eeKeyId,
    getIceServers,
    sendSignal,
    onRpc,
    onRegisterP2pUpload,
    inboundDir,
    webrtcProxy = null,
    log = console,
  }) {
    this.roomId = roomId
    this.e2eeKey = e2eeKey
    this.getE2eeKeyId = getE2eeKeyId
    this.getIceServers = getIceServers || (() => [])
    this.sendSignal = sendSignal
    this.onRpc = onRpc
    this.onRegisterP2pUpload = onRegisterP2pUpload
    this.inboundDir = inboundDir
    this.log = log

    const proxyPort = Number(webrtcProxy?.port || process.env.ALLINONE_WEBRTC_PROXY_PORT || 0)
    const proxyToken = String(webrtcProxy?.token || process.env.ALLINONE_WEBRTC_PROXY_TOKEN || '').trim()
    this.electronClient =
      proxyPort > 0 && proxyToken
        ? new ElectronWebRtcClient({ port: proxyPort, token: proxyToken, log })
        : null

    /** @type {Map<string, any>} clientId -> peer session */
    this.sessions = new Map()
    /** @type {Map<string, number>} revokedClientId -> revokedAt */
    this.revokedClients = new Map()
    /** @type {Map<string, number>} revokedSid -> revokedAt */
    this.revokedSids = new Map()
    /** @type {Map<string, number>} iv -> seenAt */
    this.seenReqIvs = new Map()
    /** @type {Map<string, Promise<void>>} clientId -> serialized signal chain */
    this._signalChains = new Map()
    this._eventSeq = 0
    this._streamSeq = 1
    this._eventQueue = Promise.resolve()
    /** @type {Map<string, { event: string, payload: any, timer: any }>} */
    this._pendingDeltas = new Map()
    this.disposed = false
  }

  getEngineName() {
    return this.electronClient ? 'electron-chromium' : 'werift'
  }

  pruneRevoked(now = Date.now()) {
    for (const [cid, ts] of this.revokedClients.entries()) {
      if (now - ts > REVOKED_TTL_MS) this.revokedClients.delete(cid)
    }
    for (const [sid, ts] of this.revokedSids.entries()) {
      if (now - ts > REVOKED_TTL_MS) this.revokedSids.delete(sid)
    }
  }

  pruneSeenIvs(now = Date.now()) {
    if (this.seenReqIvs.size < MAX_SEEN_IVS) return
    for (const [iv, ts] of this.seenReqIvs.entries()) {
      if (now - ts > REPLAY_WINDOW_MS) this.seenReqIvs.delete(iv)
    }
    while (this.seenReqIvs.size >= MAX_SEEN_IVS) {
      const oldest = this.seenReqIvs.keys().next().value
      if (!oldest) break
      this.seenReqIvs.delete(oldest)
    }
  }

  /**
   * Immediately kill active P2P DataChannels and abort any in-flight file transfers for revoked clients / auth sids.
   */
  revokeClients(clientIds = [], { sids = [], all = false, allExceptSids = [] } = {}) {
    const now = Date.now()
    this.pruneRevoked(now)
    const idSet = new Set(
      (Array.isArray(clientIds) ? clientIds : []).map((x) => String(x || '').trim()).filter(Boolean),
    )
    const sidSet = new Set(
      (Array.isArray(sids) ? sids : []).map((x) => String(x || '').trim()).filter(Boolean),
    )
    const exceptSidSet = new Set(
      (Array.isArray(allExceptSids) ? allExceptSids : []).map((x) => String(x || '').trim()).filter(Boolean),
    )
    for (const cid of idSet) this.revokedClients.set(cid, now)
    for (const sid of sidSet) this.revokedSids.set(sid, now)

    for (const [cid, sess] of [...this.sessions.entries()]) {
      const matchId = idSet.has(cid)
      const matchSid = Boolean(sess.authSid && sidSet.has(sess.authSid))
      const matchAll = Boolean(all)
      const matchExcept = exceptSidSet.size > 0 && (!sess.authSid || !exceptSidSet.has(sess.authSid))
      if (matchId || matchSid || matchAll || matchExcept) {
        this.revokedClients.set(cid, now)
        if (sess.authSid && !exceptSidSet.has(sess.authSid)) this.revokedSids.set(sess.authSid, now)
        this.log.info?.(`mobile-hub: [p2p] immediately closing revoked peer clientId=${cid}${sess.authSid ? ` sid=${sess.authSid}` : ''}`)
        void this.destroySession(cid, sess)
      }
    }
  }

  /**
   * Drop any active TURN-relayed sessions when the account crosses its monthly TURN quota,
   * while leaving direct P2P sessions (LAN / STUN) and freshly handshaking unclassified peers untouched.
   */
  dropRelayedSessions() {
    const now = Date.now()
    for (const [cid, sess] of [...this.sessions.entries()]) {
      const isRelayed = sess.transport === 'relay' || (!sess.transport && now - (sess.createdAt || 0) > 5_000)
      if (isRelayed) {
        this.log.info?.(`mobile-hub: [p2p] closing relayed peer clientId=${cid} due to monthly TURN quota limit`)
        void this.destroySession(cid, sess)
      }
    }
  }

  async destroySession(clientId, expectedSess = null) {
    const sess = this.sessions.get(clientId)
    if (!sess) return
    if (expectedSess && sess !== expectedSess) return
    this.sessions.delete(clientId)
    sess.closed = true
    sess.ctrlCodec?.clear?.()
    for (const ac of sess.activeDownloads.values()) {
      try { ac.abort() } catch {}
    }
    sess.activeDownloads.clear()
    sess.pendingDownloads.clear()
    for (const up of sess.activeUploads.values()) {
      try { up.queue.fail(new Error('P2P session closed')) } catch {}
    }
    sess.activeUploads.clear()
    try { await sess.peer?.close?.() } catch {}
  }

  sendCtrlJson(sess, obj) {
    if (!sess || sess.closed || !sess.peer?.isCtrlOpen?.()) return false
    const frames = sess.ctrlCodec.encode(obj)
    for (const f of frames) {
      if (!sess.peer.sendCtrl(f)) return false
    }
    return true
  }

  async sendEncryptedSignal(clientId, sessionId, payload) {
    if (this.disposed) return
    const enc = await encryptJson(this.e2eeKey, payload, { kind: 'p2p.signal', roomId: this.roomId })
    this.sendSignal({ clientId, sessionId, e2ee: enc })
  }

  handleEncryptedSignal(payload) {
    if (this.disposed) return Promise.resolve()
    const cid = String(payload?.clientId || '').trim()
    if (!cid) return Promise.resolve()
    const prev = this._signalChains.get(cid) || Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this._processEncryptedSignal(payload))
    this._signalChains.set(cid, next)
    next.finally(() => {
      if (this._signalChains.get(cid) === next) {
        this._signalChains.delete(cid)
      }
    })
    return next
  }

  async _processEncryptedSignal({ clientId, sid: authSidRaw = '', sessionId, e2ee }) {
    if (this.disposed) return
    const cid = String(clientId || '').trim()
    const authSid = String(authSidRaw || '').trim()
    const sid = String(sessionId || '').trim()
    if (!cid || !sid || !e2ee) return

    const isRevokedOrDisposed = () =>
      this.disposed || this.revokedClients.has(cid) || (authSid && this.revokedSids.has(authSid))

    this.pruneRevoked()
    if (isRevokedOrDisposed()) {
      return
    }

    const expectedKid = await this.getE2eeKeyId()
    if (isRevokedOrDisposed()) return
    if (e2ee.kid && expectedKid && e2ee.kid !== expectedKid) {
      return
    }

    let inner
    try {
      inner = await decryptJson(this.e2eeKey, e2ee, { kind: 'p2p.signal', roomId: this.roomId })
    } catch {
      return
    }
    if (isRevokedOrDisposed()) return

    if (!inner || typeof inner !== 'object') return

    if (inner.kind === 'close') {
      const existing = this.sessions.get(cid)
      if (existing && existing.sessionId === sid) {
        await this.destroySession(cid, existing)
      }
      return
    }

    if (inner.kind === 'ice') {
      const existing = this.sessions.get(cid)
      if (existing && existing.sessionId === sid && inner.candidate) {
        if (!existing.offerReady || !existing.peer) {
          existing.pendingIce.push(inner.candidate)
        } else {
          await existing.peer.addIceCandidate(inner.candidate)
        }
      }
      return
    }

    if (inner.kind === 'offer' && inner.sdp) {
      const prev = this.sessions.get(cid)
      if (prev) {
        await this.destroySession(cid, prev)
      }
      if (isRevokedOrDisposed()) return
      // Evict oldest session if over cap
      while (this.sessions.size >= MAX_ACTIVE_PEERS) {
        const oldestCid = this.sessions.keys().next().value
        if (!oldestCid) break
        await this.destroySession(oldestCid)
      }
      if (isRevokedOrDisposed()) return

      const sess = {
        clientId: cid,
        authSid,
        sessionId: sid,
        createdAt: Date.now(),
        closed: false,
        offerReady: false,
        transport: '',
        pendingIce: [],
        ctrlCodec: createCtrlCodec(),
        peer: null,
        pendingDownloads: new Map(), // streamId -> { realPath, size, mimeType, filename, createdAt }
        activeDownloads: new Map(),  // streamId -> AbortController
        activeUploads: new Map(),    // streamId -> { transferId, queue, donePromise }
      }
      this.sessions.set(cid, sess)

      const peerOpts = {
        iceServers: this.getIceServers(),
        onIceCandidate: (candidate) => {
          if (sess.closed || this.sessions.get(cid) !== sess || isRevokedOrDisposed()) return
          void this.sendEncryptedSignal(cid, sid, { kind: 'ice', candidate }).catch(() => {})
        },
        onStateChange: (st) => {
          if (st === 'failed' || st === 'closed') {
            void this.destroySession(cid, sess)
          }
        },
        onTransportChange: (tr) => {
          if (!sess.closed) sess.transport = String(tr || '')
        },
        onCtrlMessage: (rawText) => {
          if (sess.closed) return
          const msg = sess.ctrlCodec.decode(rawText)
          if (msg) {
            void this.handleCtrlMessage(sess, msg).catch((err) => {
              this.log.warn?.(`mobile-hub: [p2p] ctrl message error: ${String(err?.message || err)}`)
            })
          }
        },
        onBulkMessage: (rawBytes) => {
          if (sess.closed) return
          this.handleBulkBinary(sess, rawBytes)
        },
        onClose: () => {
          void this.destroySession(cid, sess)
        },
      }

      try {
        sess.peer = this.electronClient
          ? this.electronClient.createPeer(peerOpts)
          : createWeriftPeer(peerOpts)

        const answer = await sess.peer.handleOffer(inner.sdp)
        if (sess.closed || this.sessions.get(cid) !== sess || isRevokedOrDisposed()) {
          await this.destroySession(cid, sess)
          return
        }
        sess.offerReady = true
        await this.sendEncryptedSignal(cid, sid, {
          kind: 'answer',
          sdp: answer.sdp,
          engine: sess.peer.engine,
        })
        while (sess.pendingIce.length > 0 && !sess.closed && this.sessions.get(cid) === sess && !isRevokedOrDisposed()) {
          const cand = sess.pendingIce.shift()
          await sess.peer.addIceCandidate(cand).catch(() => {})
        }
      } catch (err) {
        this.log.warn?.(`mobile-hub: [p2p] offer handling failed (${cid}): ${String(err?.message || err)}`)
        await this.destroySession(cid, sess)
      }
    }
  }

  async handleCtrlMessage(sess, msg) {
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'ping') {
      this.sendCtrlJson(sess, { type: 'pong', ts: Date.now() })
      return
    }

    if (msg.type === 'rpc.req') {
      await this.handleP2pRpc(sess, msg)
      return
    }

    // Encrypted bulk control messages (bulk.pull / bulk.cancel / bulk.upload.start)
    if (msg.type === 'bulk.ctrl' && msg.bin) {
      let inner
      try {
        inner = await decryptBinaryJson(this.e2eeKey, msg.bin, { kind: 'p2p.bulk', roomId: this.roomId })
      } catch {
        return
      }
      if (!inner || typeof inner !== 'object') return

      if (inner.action === 'pull') {
        const streamId = Number(inner.streamId)
        void this.startBulkDownload(sess, streamId)
        return
      }
      if (inner.action === 'cancel') {
        const streamId = Number(inner.streamId)
        const dir = String(inner.direction || '').trim().toLowerCase()
        if (dir !== 'upload') {
          const ac = sess.activeDownloads.get(streamId)
          if (ac) {
            try { ac.abort() } catch {}
            sess.activeDownloads.delete(streamId)
          }
          sess.pendingDownloads.delete(streamId)
        }
        if (dir !== 'download') {
          const up = sess.activeUploads.get(streamId)
          if (up) {
            try { up.queue.fail(new Error('Upload cancelled by client')) } catch {}
            if (sess.activeUploads.get(streamId) === up) {
              sess.activeUploads.delete(streamId)
            }
          }
        }
        return
      }
      if (inner.action === 'upload.start') {
        void this.startBulkUploadReceiver(sess, inner)
      }
    }
  }

  async handleP2pRpc(sess, msg) {
    const id = String(msg.id || '')
    const expectedKid = await this.getE2eeKeyId()

    if (!msg.bin) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'E2EE_KEY_REQUIRED', keyId: expectedKid, message: '强制端到端加密：拒绝明文请求' },
      })
      return
    }
    const hdr = parseBinaryE2eeHeader(msg.bin)
    if (!hdr) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'E2EE_DECRYPT_FAILED', keyId: expectedKid, message: '端到端二进制密文格式无效' },
      })
      return
    }
    if (hdr.kid && expectedKid && hdr.kid !== expectedKid) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'E2EE_KEY_MISMATCH', keyId: expectedKid, message: '端到端密钥不匹配，请重新同步密钥' },
      })
      return
    }

    let decrypted
    try {
      decrypted = await decryptBinaryJson(this.e2eeKey, msg.bin, { kind: 'rpc.req', roomId: this.roomId })
    } catch (err) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: err?.code || 'E2EE_DECRYPT_FAILED', keyId: expectedKid, message: String(err?.message || '解密失败') },
      })
      return
    }

    const now = Date.now()
    const ivKey = hdr.iv
    this.pruneSeenIvs(now)
    const prevSeen = this.seenReqIvs.get(ivKey)
    if (prevSeen && now - prevSeen <= REPLAY_WINDOW_MS) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'E2EE_REPLAY_DETECTED', message: '检测到重复的加密请求，已拒绝执行' },
      })
      return
    }
    if (!Number.isFinite(decrypted?.ts) || Math.abs(now - decrypted.ts) > REPLAY_WINDOW_MS) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'E2EE_STALE_TIMESTAMP', message: '加密请求时间偏差过大' },
      })
      return
    }
    this.seenReqIvs.set(ivKey, now)

    const cid = String(decrypted?.cid || '')
    let innerRes
    try {
      let result = await this.onRpc(decrypted.method, decrypted.params || {}, { clientId: sess.clientId })
      // Intercept p2p-bulk FILE_READ descriptors to mint an ephemeral streamId scoped to this P2P session
      if (result && result.transferMode === 'p2p-bulk' && result._localRealPath) {
        const streamId = this._streamSeq++
        const { _localRealPath, ...publicMeta } = result
        // Prune expired pending download tickets
        for (const [k, v] of sess.pendingDownloads.entries()) {
          if (now - v.createdAt > DOWNLOAD_TICKET_TTL_MS) sess.pendingDownloads.delete(k)
        }
        sess.pendingDownloads.set(streamId, {
          realPath: _localRealPath,
          size: Number(publicMeta.size || 0),
          mimeType: publicMeta.mimeType,
          filename: publicMeta.filename,
          createdAt: now,
        })
        result = { ...publicMeta, streamId }
      }
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
      const enc = await encryptBinaryJson(this.e2eeKey, innerRes, { kind: 'rpc.res', roomId: this.roomId })
      this.sendCtrlJson(sess, { type: 'rpc.res', id, ok: true, bin: enc.bytes })
    } catch (err) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'E2EE_ENCRYPT_FAILED', message: String(err?.message || '响应加密失败') },
      })
    }
  }

  async sendBulkCtrl(sess, innerPayload) {
    if (sess.closed) return
    const enc = await encryptBinaryJson(this.e2eeKey, innerPayload, { kind: 'p2p.bulk', roomId: this.roomId })
    this.sendCtrlJson(sess, { type: 'bulk.ctrl', bin: enc.bytes })
  }

  /**
   * Stream a previously ACL-verified local PC file over `aio-bulk` using AIO2 4MB chunked E2EE + 64KB SCTP slices.
   */
  async startBulkDownload(sess, streamId) {
    const ticket = sess.pendingDownloads.get(streamId)
    sess.pendingDownloads.delete(streamId)
    if (!ticket || Date.now() - Number(ticket.createdAt || 0) > DOWNLOAD_TICKET_TTL_MS) {
      await this.sendBulkCtrl(sess, { action: 'download.error', streamId, message: '文件传输凭证不存在或已过期' }).catch(() => {})
      return
    }
    const ac = new AbortController()
    sess.activeDownloads.set(streamId, ac)

    let fh = null
    try {
      // TOCTOU re-check: ensure path was not swapped for a symlink pointing elsewhere before opening
      let liveRealPath = ''
      try {
        liveRealPath = realpathSync(ticket.realPath)
      } catch {
        throw new Error('目标文件已不存在或无法访问')
      }
      if (liveRealPath !== ticket.realPath) {
        throw new Error('出于安全限制，目标文件路径已变更，已中止下载')
      }
      fh = await openAsync(liveRealPath, 'r')
      const liveStat = await fh.stat()
      if (!liveStat.isFile() || liveStat.size <= 0) {
        throw new Error('目标文件不可读或已变为空文件')
      }
      const liveSize = liveStat.size
      let seq = 0

      await encryptChunkedBytes(
        this.e2eeKey,
        {
          totalSize: liveSize,
          readSlice: async (offset, len) => {
            if (ac.signal.aborted) {
              const err = new Error('Transfer aborted')
              err.name = 'AbortError'
              throw err
            }
            const b = Buffer.allocUnsafe(len)
            let pos = 0
            while (pos < len) {
              const { bytesRead } = await fh.read(b, pos, len - pos, offset + pos)
              if (bytesRead <= 0) break
              pos += bytesRead
            }
            if (pos < len) {
              throw new Error('文件在传输过程中发生截断或变动，请重试')
            }
            return new Uint8Array(b.buffer, b.byteOffset, pos)
          },
        },
        {
          kind: 'upload',
          roomId: this.roomId,
          compress: isCompressibleFile(ticket.mimeType, ticket.filename),
          onHeader: async (e2eeMeta) => {
            await this.sendBulkCtrl(sess, {
              action: 'download.header',
              streamId,
              e2ee: e2eeMeta,
              size: liveSize,
            })
          },
          onChunk: async (cipherChunk) => {
            for (let off = 0; off < cipherChunk.byteLength; off += BULK_SLICE_BYTES) {
              if (ac.signal.aborted || sess.closed) {
                const err = new Error('Transfer aborted')
                err.name = 'AbortError'
                throw err
              }
              const slice = cipherChunk.subarray(off, Math.min(cipherChunk.byteLength, off + BULK_SLICE_BYTES))
              const frame = encodeBulkFrame(streamId, seq++, slice, 0)
              await sess.peer.sendBulk(frame, { signal: ac.signal })
            }
          },
        },
      )

      if (!ac.signal.aborted && !sess.closed) {
        const eofFrame = encodeBulkFrame(streamId, seq++, new Uint8Array(0), BULK_FLAG_EOF)
        await sess.peer.sendBulk(eofFrame, { signal: ac.signal })
      }
    } catch (err) {
      if (err?.name !== 'AbortError' && !sess.closed) {
        await this.sendBulkCtrl(sess, {
          action: 'download.error',
          streamId,
          message: String(err?.message || err),
        }).catch(() => {})
      }
    } finally {
      if (fh) await fh.close().catch(() => {})
      sess.activeDownloads.delete(streamId)
    }
  }

  /**
   * Receive an E2EE-encrypted attachment streamed over `aio-bulk` from a phone/browser directly
   * onto local PC disk (`inboundDir`), and return an opaque `p2pToken` (never caller-supplied path!).
   */
  async startBulkUploadReceiver(sess, meta) {
    const transferId = String(meta.transferId || '')
    const streamId = Number(meta.streamId)
    if (!transferId || !Number.isInteger(streamId) || streamId <= 0 || !meta.e2ee?.iv) {
      await this.sendBulkCtrl(sess, {
        action: 'upload.error',
        transferId,
        streamId,
        message: '无效的加密上传元数据',
      }).catch(() => {})
      return
    }

    const isChunked = Boolean(meta.e2ee.chunked)
    const maxCipherBytes = isChunked
      ? MAX_INBOUND_UPLOAD_BYTES + MAX_INBOUND_CIPHER_OVERHEAD_BYTES
      : MAX_NON_CHUNKED_UPLOAD_BYTES
    const declaredSize = Number(meta.size || 0)
    if (!isChunked && declaredSize > MAX_NON_CHUNKED_UPLOAD_BYTES) {
      await this.sendBulkCtrl(sess, {
        action: 'upload.error',
        transferId,
        streamId,
        message: '大于 32MB 的上传必须启用 AIO2 分块加密',
      }).catch(() => {})
      return
    }

    const prevUpload = sess.activeUploads.get(streamId)
    if (prevUpload) {
      try { prevUpload.queue.fail(new Error('Upload superseded by new stream')) } catch {}
    }
    const queue = createAsyncByteQueue()
    const entry = { transferId, queue, receivedBytes: 0, maxCipherBytes, isChunked }
    sess.activeUploads.set(streamId, entry)

    let localPath = ''
    let ws = null
    let wsClosed = false
    let wsClosePromise = null
    try {
      // Acknowledge readiness immediately so client can begin streaming binary slices
      await this.sendBulkCtrl(sess, { action: 'upload.ready', transferId, streamId })

      mkdirSync(this.inboundDir, { recursive: true })
      try { chmodSync(this.inboundDir, 0o700) } catch {}
      const rawBase = basename(String(meta.filename || 'upload.bin'))
      const safeName = rawBase
        .replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 100) || 'upload.bin'
      localPath = join(this.inboundDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`)

      ws = createWriteStream(localPath, { mode: 0o600 })
      let wsErr = null
      wsClosePromise = new Promise((resolveClose) => {
        ws.once('close', () => {
          wsClosed = true
          resolveClose()
        })
      })
      ws.on('error', (e) => { wsErr = e })
      const writePlain = (chunk) =>
        new Promise((resolveW, rejectW) => {
          if (wsErr) return rejectW(wsErr)
          const ok = ws.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          if (ok) return resolveW()
          const onDrain = () => { ws.off('error', onErr); resolveW() }
          const onErr = (e) => { ws.off('drain', onDrain); rejectW(e) }
          ws.once('drain', onDrain)
          ws.once('error', onErr)
        })

      let writtenPlainBytes = 0
      const dec = await decryptAutoStream(this.e2eeKey, queue.iterable, {
        iv: meta.e2ee.iv,
        kid: meta.e2ee.kid || '',
        kind: 'upload',
        roomId: this.roomId,
        chunked: isChunked,
        compressed: Boolean(meta.e2ee.compressed),
        onPlainChunk: async (plainChunk) => {
          writtenPlainBytes += plainChunk.byteLength
          if (writtenPlainBytes > MAX_INBOUND_UPLOAD_BYTES) {
            throw new Error('文件超过本机安全上限 (2GB)')
          }
          await writePlain(plainChunk)
        },
      })

      await new Promise((resolveEnd, rejectEnd) => {
        if (wsErr) return rejectEnd(wsErr)
        const onErr = (e) => rejectEnd(e)
        ws.once('error', onErr)
        ws.end(() => {
          ws.off('error', onErr)
          resolveEnd()
        })
      })
      if (!wsClosed && wsClosePromise) {
        await Promise.race([wsClosePromise, new Promise((r) => setTimeout(r, 2000))])
      }
      try { chmodSync(localPath, 0o600) } catch {}

      const p2pToken = this.onRegisterP2pUpload?.({
        clientId: sess.clientId,
        localPath,
        filename: safeName,
        mimeType: String(meta.mimeType || 'application/octet-stream'),
        size: dec.totalPlainBytes,
      })
      if (!p2pToken) throw new Error('Failed to register local P2P upload token')

      await this.sendBulkCtrl(sess, {
        action: 'upload.done',
        transferId,
        streamId,
        p2pToken,
        filename: safeName,
        mimeType: String(meta.mimeType || 'application/octet-stream'),
        size: dec.totalPlainBytes,
      })
    } catch (err) {
      if (ws && !wsClosed) {
        try { ws.destroy() } catch {}
        if (wsClosePromise) {
          await Promise.race([wsClosePromise, new Promise((r) => setTimeout(r, 2000))])
        }
      }
      if (localPath) await unlinkAsync(localPath).catch(() => {})
      if (!sess.closed) {
        await this.sendBulkCtrl(sess, {
          action: 'upload.error',
          transferId,
          streamId,
          message: String(err?.message || err),
        }).catch(() => {})
      }
    } finally {
      if (sess.activeUploads.get(streamId) === entry) {
        sess.activeUploads.delete(streamId)
      }
    }
  }

  handleBulkBinary(sess, rawBytes) {
    const frame = decodeBulkFrame(rawBytes)
    if (!frame) return
    const up = sess.activeUploads.get(frame.streamId)
    if (!up) return
    if (frame.payload.byteLength > 0) {
      up.receivedBytes += frame.payload.byteLength
      const limit = up.maxCipherBytes || (MAX_INBOUND_UPLOAD_BYTES + MAX_INBOUND_CIPHER_OVERHEAD_BYTES)
      if (up.receivedBytes > limit) {
        up.queue.fail(
          new Error(up.isChunked ? '文件超过本机安全上限 (2GB)' : '非分块加密上传超过 32MB 上限'),
        )
        if (sess.activeUploads.get(frame.streamId) === up) {
          sess.activeUploads.delete(frame.streamId)
        }
        return
      }
      if (!up.queue.push(frame.payload)) {
        if (sess.activeUploads.get(frame.streamId) === up) {
          sess.activeUploads.delete(frame.streamId)
        }
        return
      }
    }
    if (frame.eof) {
      up.queue.end()
    }
  }

  _enqueueBroadcastEvent(event, payload) {
    if (this.disposed || this.sessions.size === 0) return
    this._eventQueue = this._eventQueue
      .then(async () => {
        if (this.disposed || this.sessions.size === 0) return
        const targets = []
        for (const sess of this.sessions.values()) {
          if (!sess.closed && sess.peer?.isCtrlOpen?.()) targets.push(sess)
        }
        if (targets.length === 0) return
        const seq = ++this._eventSeq
        const enc = await encryptBinaryJson(
          this.e2eeKey,
          { event, payload, seq, ts: Date.now() },
          { kind: 'event', roomId: this.roomId },
        )
        const frameObj = { type: 'event', seq, bin: enc.bytes }
        for (const sess of targets) {
          this.sendCtrlJson(sess, frameObj)
        }
      })
      .catch(() => {})
  }

  _flushPendingDelta(sessionId) {
    const sid = String(sessionId || '')
    if (!sid) return
    const pending = this._pendingDeltas.get(sid)
    if (!pending) return
    this._pendingDeltas.delete(sid)
    if (pending.timer) clearTimeout(pending.timer)
    this._enqueueBroadcastEvent(pending.event, pending.payload)
  }

  /**
   * Broadcast an E2EE streaming event directly to all open P2P clients over `aio-ctrl` (0 bytes via server!).
   * Coalesces consecutive `stream.delta` / `stream.thinking` events per session within a 60ms window
   * and flushes immediately before any state-transition event so ordering is strictly preserved.
   */
  broadcastEvent(event, payload) {
    if (this.disposed || this.sessions.size === 0) return
    const sid = String(payload?.sessionId || payload?.session?.id || '')
    const isCoalesceable =
      Boolean(sid) &&
      (event === EVENTS.STREAM_DELTA || event === EVENTS.STREAM_THINKING) &&
      typeof payload?.delta === 'string'

    if (!isCoalesceable) {
      if (sid && this._pendingDeltas.has(sid)) {
        this._flushPendingDelta(sid)
      }
      this._enqueueBroadcastEvent(event, payload)
      return
    }

    const existing = this._pendingDeltas.get(sid)
    if (existing && existing.event === event) {
      const mergedDelta = String(existing.payload.delta || '') + payload.delta
      existing.payload = { ...existing.payload, ...payload, delta: mergedDelta }
      if (mergedDelta.length >= STREAM_COALESCE_MAX_CHARS) {
        this._flushPendingDelta(sid)
      }
      return
    }
    if (existing) {
      this._flushPendingDelta(sid)
    }

    const entry = {
      event,
      payload: { ...payload },
      timer: setTimeout(() => {
        this._flushPendingDelta(sid)
      }, STREAM_COALESCE_WINDOW_MS),
    }
    entry.timer.unref?.()
    this._pendingDeltas.set(sid, entry)
    if (payload.delta.length >= STREAM_COALESCE_MAX_CHARS) {
      this._flushPendingDelta(sid)
    }
  }

  async dispose() {
    this.disposed = true
    for (const pending of this._pendingDeltas.values()) {
      if (pending.timer) clearTimeout(pending.timer)
    }
    this._pendingDeltas.clear()
    this._signalChains.clear()
    for (const cid of [...this.sessions.keys()]) {
      await this.destroySession(cid)
    }
    this.electronClient?.dispose?.()
  }
}
