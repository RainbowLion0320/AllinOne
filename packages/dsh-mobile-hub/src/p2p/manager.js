import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  constants as fsConstants,
  createWriteStream,
  realpathSync,
} from 'node:fs'
import { open as openAsync, unlink as unlinkAsync } from 'node:fs/promises'
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
  createBulkWindowController,
  createCtrlCodec,
  createSerializedChannelWriter,
  decodeBulkFrame,
  encodeBulkFrame,
} from '@allinone/shared/p2p-mux'
import { EVENTS } from '../protocol.js'
import { InboundAttachmentStore } from '../inbound-store.js'
import { BoundedLruMap } from '../primitives/lru.js'
import { ElectronWebRtcClient } from './peer-electron.js'
import { createWeriftPeer } from './peer-werift.js'

const REPLAY_WINDOW_MS = 10 * 60 * 1000
const SIGNAL_FRESHNESS_WINDOW_MS = 90_000
const MAX_SEEN_IVS_PER_CLIENT = 2000
const MAX_TRACKED_REPLAY_CLIENTS = 64
const MAX_SEEN_SIGNAL_IVS = 4000
const MAX_ACTIVE_PEERS = 24
const REVOKED_TTL_MS = 24 * 60 * 60 * 1000
const DOWNLOAD_TICKET_TTL_MS = 120_000
const MAX_UPLOADS_PER_PEER = 2
const MAX_GLOBAL_UPLOADS = 4
const MAX_DOWNLOADS_PER_PEER = 4
const MAX_GLOBAL_DOWNLOADS = 6
const MAX_PENDING_DOWNLOADS = 32
const MAX_CONCURRENT_RPCS_PER_PEER = 16
const MAX_PENDING_BROADCASTS = 512
const MAX_REPLAY_EVENTS = 256
const DEFAULT_INBOUND_DISK_QUOTA_BYTES = 4 * 1024 * 1024 * 1024 // 4 GB total inboundDir quota
const MAX_INBOUND_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB plaintext safety cap
const MAX_INBOUND_CIPHER_OVERHEAD_BYTES = 4 * 1024 * 1024 // headroom for AIO2 framing & GCM tags
const MAX_NON_CHUNKED_UPLOAD_BYTES = E2EE_CHUNKED_THRESHOLD + 64 * 1024 // prevent non-chunked in-memory OOM
const MAX_UPLOAD_QUEUE_BYTES = 32 * 1024 * 1024 // cap RAM buffered ahead of disk/AES-GCM
const STREAM_COALESCE_WINDOW_MS = 60
const STREAM_COALESCE_MAX_CHARS = 16 * 1024

const STATE_REPLAYABLE_EVENTS = new Set([
  EVENTS.STREAM_START,
  EVENTS.STREAM_DONE,
  EVENTS.STREAM_ERROR,
  EVENTS.STREAM_TOOL_START,
  EVENTS.STREAM_TOOL_END,
  EVENTS.STREAM_TASK_STATE,
  EVENTS.SESSION_UPDATED,
  EVENTS.APPROVAL_REQUEST,
  EVENTS.APPROVAL_RESOLVED,
  EVENTS.DISPATCH_UPDATED,
  EVENTS.BRIDGE_STATUS,
])

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
 */
export class P2PBridgeManager {
  constructor({
    roomId,
    e2eeKey,
    getE2eeKeyId,
    getIceServers,
    sendSignal,
    onRpc,
    onRegisterP2pUpload = null,
    inboundDir = '',
    inboundStore = null,
    maxInboundDiskBytes = DEFAULT_INBOUND_DISK_QUOTA_BYTES,
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
    this.inboundStore =
      inboundStore ||
      new InboundAttachmentStore({
        inboundDir,
        maxDiskBytes: maxInboundDiskBytes,
        log,
      })
    this.inboundDir = this.inboundStore.inboundDir
    this.maxInboundDiskBytes = this.inboundStore.maxDiskBytes
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
    /** @type {BoundedLruMap<string, { seenIvs: Map<string, { seenAt: number, reqTs: number }>, minAcceptedTs: number }>} */
    this.clientReplayState = new BoundedLruMap(MAX_TRACKED_REPLAY_CLIENTS)
    /** @type {Map<string, number>} signal iv -> seenAt */
    this.seenSignalIvs = new Map()
    /** @type {Map<string, Promise<void>>} clientId -> serialized signal chain */
    this._signalChains = new Map()
    this._eventSeq = 0
    this._streamSeq = 1
    this._eventQueue = Promise.resolve()
    this._pendingBroadcasts = 0
    /** @type {Array<{ seq: number, event: string, payload: any, ts: number }>} */
    this._eventRing = []
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

  _getClientReplayBucket(clientId) {
    const key = String(clientId || '__default__')
    let bucket = this.clientReplayState.get(key)
    if (!bucket) {
      bucket = { seenIvs: new Map(), minAcceptedTs: 0 }
      this.clientReplayState.set(key, bucket)
    }
    return bucket
  }

  _pruneClientSeenIvs(bucket, now = Date.now()) {
    if (bucket.seenIvs.size < MAX_SEEN_IVS_PER_CLIENT) return
    for (const [iv, rec] of bucket.seenIvs.entries()) {
      if (now - rec.seenAt > REPLAY_WINDOW_MS) bucket.seenIvs.delete(iv)
    }
    while (bucket.seenIvs.size >= MAX_SEEN_IVS_PER_CLIENT) {
      const oldest = bucket.seenIvs.keys().next().value
      if (!oldest) break
      const rec = bucket.seenIvs.get(oldest)
      bucket.seenIvs.delete(oldest)
      if (rec && now - rec.seenAt <= REPLAY_WINDOW_MS && Number.isFinite(rec.reqTs)) {
        bucket.minAcceptedTs = Math.max(bucket.minAcceptedTs, rec.reqTs)
      }
    }
  }

  pruneSeenSignalIvs(now = Date.now()) {
    if (this.seenSignalIvs.size < MAX_SEEN_SIGNAL_IVS) return
    for (const [iv, ts] of this.seenSignalIvs.entries()) {
      if (now - ts > REPLAY_WINDOW_MS) this.seenSignalIvs.delete(iv)
    }
    while (this.seenSignalIvs.size >= MAX_SEEN_SIGNAL_IVS) {
      const oldest = this.seenSignalIvs.keys().next().value
      if (!oldest) break
      this.seenSignalIvs.delete(oldest)
    }
  }

  _countGlobalActiveUploads() {
    let count = 0
    for (const s of this.sessions.values()) count += s.activeUploads.size
    return count
  }

  _countGlobalActiveDownloads() {
    let count = 0
    for (const s of this.sessions.values()) count += s.activeDownloads.size
    return count
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
    sess.ctrlWriter?.close?.()
    sess.ctrlCodec?.clear?.()
    for (const dl of sess.activeDownloads.values()) {
      try { dl.ac?.abort() } catch {}
      try { dl.windowCtrl?.abort(new Error('P2P session closed')) } catch {}
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
    if (sess.ctrlWriter) {
      void sess.ctrlWriter.enqueue(() => {
        if (sess.closed || !sess.peer?.isCtrlOpen?.()) return false
        for (const f of frames) {
          if (!sess.peer.sendCtrl(f)) return false
        }
        return true
      }).catch(() => {})
      return true
    }
    for (const f of frames) {
      if (!sess.peer.sendCtrl(f)) return false
    }
    return true
  }

  async sendEncryptedSignal(clientId, sessionId, payload) {
    if (this.disposed) return
    const innerPayload = {
      ...(payload && typeof payload === 'object' ? payload : {}),
      clientId: String(clientId || '').trim(),
      sessionId: String(sessionId || '').trim(),
      ts: Date.now(),
    }
    const enc = await encryptJson(this.e2eeKey, innerPayload, { kind: 'p2p.signal', roomId: this.roomId })
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
    if (isRevokedOrDisposed()) return

    const expectedKid = await this.getE2eeKeyId()
    if (isRevokedOrDisposed()) return
    if (e2ee.kid && expectedKid && e2ee.kid !== expectedKid) return

    const sigIv = typeof e2ee.iv === 'string' ? e2ee.iv.trim() : ''
    const nowBeforeDecrypt = Date.now()
    if (sigIv) {
      const prevSigSeen = this.seenSignalIvs.get(sigIv)
      if (prevSigSeen && nowBeforeDecrypt - prevSigSeen <= REPLAY_WINDOW_MS) return
    }

    let inner
    try {
      inner = await decryptJson(this.e2eeKey, e2ee, { kind: 'p2p.signal', roomId: this.roomId })
    } catch {
      return
    }
    if (isRevokedOrDisposed()) return
    if (!inner || typeof inner !== 'object') return

    const now = Date.now()
    if (inner.ts !== undefined) {
      if (
        typeof inner.ts !== 'number' ||
        !Number.isFinite(inner.ts) ||
        Math.abs(now - inner.ts) > SIGNAL_FRESHNESS_WINDOW_MS
      ) {
        return
      }
    }
    if (inner.clientId !== undefined && String(inner.clientId).trim() !== cid) return
    if (inner.sessionId !== undefined && String(inner.sessionId).trim() !== sid) return
    if (sigIv) {
      this.pruneSeenSignalIvs(now)
      const prevSigSeen = this.seenSignalIvs.get(sigIv)
      if (prevSigSeen && now - prevSigSeen <= REPLAY_WINDOW_MS) return
      this.seenSignalIvs.set(sigIv, now)
    }

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
        ctrlWriter: createSerializedChannelWriter(),
        peer: null,
        inFlightRpcs: 0,
        pendingDownloads: new Map(), // streamId -> { realPath, size, maxBytes, mimeType, filename, createdAt }
        activeDownloads: new Map(),  // streamId -> { ac, windowCtrl }
        activeUploads: new Map(),    // streamId -> { transferId, queue, ... }
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

  async _replayEventsSince(sess, sinceSeq) {
    const cleanSeq = Number(sinceSeq)
    if (!Number.isFinite(cleanSeq) || cleanSeq < 0 || sess.closed) return
    const missed = this._eventRing.filter((item) => item.seq > cleanSeq)
    for (const item of missed) {
      if (sess.closed || !sess.peer?.isCtrlOpen?.()) return
      try {
        const enc = await encryptBinaryJson(
          this.e2eeKey,
          { event: item.event, payload: item.payload, seq: item.seq, ts: item.ts, replay: true },
          { kind: 'event', roomId: this.roomId },
        )
        this.sendCtrlJson(sess, { type: 'event', seq: item.seq, bin: enc.bytes })
      } catch {}
    }
  }

  async handleCtrlMessage(sess, msg) {
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'ping') {
      this.sendCtrlJson(sess, { type: 'pong', ts: Date.now() })
      return
    }

    if (msg.type === 'sync.sinceSeq') {
      void this._replayEventsSince(sess, msg.sinceSeq)
      return
    }

    if (msg.type === 'rpc.req') {
      await this.handleP2pRpc(sess, msg)
      return
    }

    if (msg.type === 'bulk.ctrl' && msg.bin instanceof Uint8Array) {
      let inner
      try {
        inner = await decryptBinaryJson(this.e2eeKey, msg.bin, { kind: 'p2p.bulk', roomId: this.roomId })
      } catch {
        return
      }
      if (!inner || typeof inner !== 'object') return

      if (inner.action === 'pull') {
        const streamId = Number(inner.streamId)
        const initialWindowBytes = Number(inner.windowBytes || 0)
        void this.startBulkDownload(sess, streamId, { initialWindowBytes })
        return
      }
      if (inner.action === 'window') {
        const streamId = Number(inner.streamId)
        const credits = Number(inner.bytes || 0)
        const dl = sess.activeDownloads.get(streamId)
        if (dl?.windowCtrl && credits > 0) {
          dl.windowCtrl.grant(credits)
        }
        return
      }
      if (inner.action === 'cancel') {
        const streamId = Number(inner.streamId)
        const dir = String(inner.direction || '').trim().toLowerCase()
        if (dir !== 'upload') {
          const dl = sess.activeDownloads.get(streamId)
          if (dl) {
            try { dl.ac?.abort() } catch {}
            try { dl.windowCtrl?.abort(new Error('Download cancelled')) } catch {}
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

  _mintDownloadTicket(sess, { realPath, size = 0, maxBytes = MAX_INBOUND_UPLOAD_BYTES, mimeType, filename }) {
    const now = Date.now()
    const streamId = this._streamSeq++
    for (const [k, v] of sess.pendingDownloads.entries()) {
      if (now - v.createdAt > DOWNLOAD_TICKET_TTL_MS) sess.pendingDownloads.delete(k)
    }
    while (sess.pendingDownloads.size >= MAX_PENDING_DOWNLOADS) {
      const oldestKey = sess.pendingDownloads.keys().next().value
      if (oldestKey === undefined) break
      sess.pendingDownloads.delete(oldestKey)
    }
    sess.pendingDownloads.set(streamId, {
      realPath,
      size: Number(size || 0),
      maxBytes: Number(maxBytes || MAX_INBOUND_UPLOAD_BYTES),
      mimeType,
      filename,
      createdAt: now,
    })
    return streamId
  }

  async handleP2pRpc(sess, msg) {
    const id = String(msg.id || '')
    const expectedKid = await this.getE2eeKeyId()

    if (sess.inFlightRpcs >= MAX_CONCURRENT_RPCS_PER_PEER) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'RPC_CONCURRENCY_LIMIT', message: '并发 RPC 请求数过多，请稍后重试' },
      })
      return
    }

    if (msg.bin == null) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'E2EE_KEY_REQUIRED', keyId: expectedKid, message: '强制端到端加密：拒绝明文请求' },
      })
      return
    }
    if (!(msg.bin instanceof Uint8Array)) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'E2EE_DECRYPT_FAILED', keyId: expectedKid, message: '端到端二进制密文类型无效' },
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

    // Per-client replay tracking prevents clock skew or high-volume bursts on Device A from rejecting Device B
    const now = Date.now()
    const ivKey = hdr.iv
    const replayBucket = this._getClientReplayBucket(sess.clientId)
    this._pruneClientSeenIvs(replayBucket, now)
    const prevSeen = replayBucket.seenIvs.get(ivKey)
    if (prevSeen && now - prevSeen.seenAt <= REPLAY_WINDOW_MS) {
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
    if (replayBucket.minAcceptedTs > 0 && decrypted.ts <= replayBucket.minAcceptedTs) {
      this.sendCtrlJson(sess, {
        type: 'rpc.res',
        id,
        ok: false,
        error: { code: 'E2EE_REPLAY_DETECTED', message: '加密请求时间戳已超出防重放窗口，已拒绝执行' },
      })
      return
    }
    replayBucket.seenIvs.set(ivKey, { seenAt: now, reqTs: decrypted.ts })

    const cid = String(decrypted?.cid || '')
    let innerRes
    sess.inFlightRpcs += 1
    try {
      const result = await this.onRpc(decrypted.method, decrypted.params || {}, {
        clientId: sess.clientId,
        mintDownloadTicket: (meta) => this._mintDownloadTicket(sess, meta),
      })
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
    } finally {
      sess.inFlightRpcs = Math.max(0, sess.inFlightRpcs - 1)
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
  async startBulkDownload(sess, streamId, { initialWindowBytes = 0 } = {}) {
    const ticket = sess.pendingDownloads.get(streamId)
    sess.pendingDownloads.delete(streamId)
    if (!ticket || Date.now() - Number(ticket.createdAt || 0) > DOWNLOAD_TICKET_TTL_MS) {
      await this.sendBulkCtrl(sess, { action: 'download.error', streamId, message: '文件传输凭证不存在或已过期' }).catch(() => {})
      return
    }
    if (sess.activeDownloads.size >= MAX_DOWNLOADS_PER_PEER || this._countGlobalActiveDownloads() >= MAX_GLOBAL_DOWNLOADS) {
      await this.sendBulkCtrl(sess, { action: 'download.error', streamId, message: '并发下载数超出上限，请稍后重试' }).catch(() => {})
      return
    }
    const ac = new AbortController()
    const windowCtrl =
      initialWindowBytes > 0 ? createBulkWindowController({ initialWindowBytes, timeoutMs: 45_000 }) : null
    sess.activeDownloads.set(streamId, { ac, windowCtrl })

    let fh = null
    try {
      let liveRealPath = ''
      try {
        liveRealPath = realpathSync(ticket.realPath)
      } catch {
        throw new Error('目标文件已不存在或无法访问')
      }
      if (liveRealPath !== ticket.realPath) {
        throw new Error('出于安全限制，目标文件路径已变更，已中止下载')
      }
      const openFlags =
        process.platform !== 'win32'
          ? fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
          : 'r'
      fh = await openAsync(liveRealPath, openFlags)
      const liveStat = await fh.stat()
      if (!liveStat.isFile() || liveStat.size <= 0) {
        throw new Error('目标文件不可读或已变为空文件')
      }
      const maxAllowedBytes = Number(ticket.maxBytes || MAX_INBOUND_UPLOAD_BYTES)
      if (liveStat.size > maxAllowedBytes) {
        throw new Error('目标文件大小超出传输安全上限，已中止下载')
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
              if (windowCtrl) {
                await windowCtrl.consume(slice.byteLength, ac.signal)
              }
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
      windowCtrl?.abort(new Error('Transfer closed'))
      sess.activeDownloads.delete(streamId)
    }
  }

  /**
   * Receive an E2EE-encrypted attachment streamed over `aio-bulk` directly into `InboundAttachmentStore`.
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
    if (Number.isFinite(declaredSize) && declaredSize > MAX_INBOUND_UPLOAD_BYTES) {
      await this.sendBulkCtrl(sess, {
        action: 'upload.error',
        transferId,
        streamId,
        message: '文件超过本机安全上限 (2GB)',
      }).catch(() => {})
      return
    }
    if (!isChunked && declaredSize > MAX_NON_CHUNKED_UPLOAD_BYTES) {
      await this.sendBulkCtrl(sess, {
        action: 'upload.error',
        transferId,
        streamId,
        message: '大于 32MB 的上传必须启用 AIO2 分块加密',
      }).catch(() => {})
      return
    }

    const replacingExisting = sess.activeUploads.has(streamId)
    const peerActiveCount = replacingExisting ? sess.activeUploads.size - 1 : sess.activeUploads.size
    if (peerActiveCount >= MAX_UPLOADS_PER_PEER) {
      await this.sendBulkCtrl(sess, {
        action: 'upload.error',
        transferId,
        streamId,
        message: '当前设备并发上传数超出上限，请等待现有上传完成',
      }).catch(() => {})
      return
    }
    const globalActiveCount = this._countGlobalActiveUploads() - (replacingExisting ? 1 : 0)
    if (globalActiveCount >= MAX_GLOBAL_UPLOADS) {
      await this.sendBulkCtrl(sess, {
        action: 'upload.error',
        transferId,
        streamId,
        message: '本机并发上传任务数超出上限，请稍后重试',
      }).catch(() => {})
      return
    }

    const reservationKey = `${sess.clientId}:${streamId}:${randomUUID().slice(0, 6)}`
    const quotaCheck = this.inboundStore.reserveUploadSpace(reservationKey, declaredSize > 0 ? declaredSize : 0)
    if (!quotaCheck.ok) {
      await this.sendBulkCtrl(sess, {
        action: 'upload.error',
        transferId,
        streamId,
        message: '本机上传缓存目录空间已达配额上限，请清理后再试',
      }).catch(() => {})
      return
    }
    const baseDiskBytes = quotaCheck.usedBytes

    const prevUpload = sess.activeUploads.get(streamId)
    if (prevUpload) {
      try { prevUpload.queue.fail(new Error('Upload superseded by new stream')) } catch {}
    }
    const queue = createAsyncByteQueue()
    const entry = { transferId, queue, receivedBytes: 0, writtenPlainBytes: 0, maxCipherBytes, isChunked }
    sess.activeUploads.set(streamId, entry)

    let localPath = ''
    let ws = null
    let wsClosed = false
    let wsClosePromise = null
    try {
      await this.sendBulkCtrl(sess, { action: 'upload.ready', transferId, streamId })

      const allocated = this.inboundStore.allocateFilePath(meta.filename || 'upload.bin')
      localPath = allocated.localPath
      const safeName = allocated.safeName
      this.inboundStore.attachLocalPath(reservationKey, localPath)

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
          entry.writtenPlainBytes = writtenPlainBytes
          if (writtenPlainBytes > MAX_INBOUND_UPLOAD_BYTES) {
            throw new Error('文件超过本机安全上限 (2GB)')
          }
          if (!this.inboundStore.updateWrittenAndCheckQuota(reservationKey, writtenPlainBytes, baseDiskBytes)) {
            throw new Error('本机上传缓存目录空间已达配额上限，请清理后再试')
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

      const uploadMeta = {
        clientId: sess.clientId,
        localPath,
        filename: safeName,
        mimeType: String(meta.mimeType || 'application/octet-stream'),
        size: dec.totalPlainBytes,
      }
      const p2pToken =
        typeof this.onRegisterP2pUpload === 'function'
          ? this.onRegisterP2pUpload(uploadMeta)
          : this.inboundStore.registerUpload(uploadMeta)
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
      this.inboundStore.releaseUploadSpace(reservationKey)
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

  _recordReplayableEvent(seq, event, payload, ts) {
    if (!STATE_REPLAYABLE_EVENTS.has(event)) return
    this._eventRing.push({ seq, event, payload, ts })
    if (this._eventRing.length > MAX_REPLAY_EVENTS) {
      this._eventRing.splice(0, this._eventRing.length - MAX_REPLAY_EVENTS)
    }
  }

  _enqueueBroadcastEvent(event, payload) {
    if (this.disposed) return
    const isDelta = event === EVENTS.STREAM_DELTA || event === EVENTS.STREAM_THINKING
    if (isDelta && this._pendingBroadcasts >= MAX_PENDING_BROADCASTS) {
      // Shed excessive streaming delta backlog under severe saturation; final STREAM_DONE/state events still deliver
      return
    }
    const seq = ++this._eventSeq
    const ts = Date.now()
    this._recordReplayableEvent(seq, event, payload, ts)
    if (this.sessions.size === 0) return

    this._pendingBroadcasts += 1
    this._eventQueue = this._eventQueue
      .then(async () => {
        if (this.disposed || this.sessions.size === 0) return
        const targets = []
        for (const sess of this.sessions.values()) {
          if (!sess.closed && sess.peer?.isCtrlOpen?.()) targets.push(sess)
        }
        if (targets.length === 0) return
        const enc = await encryptBinaryJson(
          this.e2eeKey,
          { event, payload, seq, ts },
          { kind: 'event', roomId: this.roomId },
        )
        const frameObj = { type: 'event', seq, bin: enc.bytes }
        for (const sess of targets) {
          this.sendCtrlJson(sess, frameObj)
        }
      })
      .catch(() => {})
      .finally(() => {
        this._pendingBroadcasts = Math.max(0, this._pendingBroadcasts - 1)
      })
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

  broadcastEvent(event, payload) {
    if (this.disposed) return
    const sid = String(payload?.sessionId || payload?.session?.id || payload?.task?.sessionId || '')
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

    if (this.sessions.size === 0) return

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
    this._eventRing.length = 0
    for (const cid of [...this.sessions.keys()]) {
      await this.destroySession(cid)
    }
    this.electronClient?.dispose?.()
  }
}
