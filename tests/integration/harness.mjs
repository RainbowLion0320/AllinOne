/**
 * Shared test harness for All in One integration test suites (`tests/integration/*.test.mjs`).
 *
 * Provides isolated temp directories, ephemeral port-0 relay servers, mock SMTP,
 * lightweight mock bridge WS, full WebRTC/P2P ticket client WS, and mock Electron safeStorage.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { RTCIceCandidate, RTCPeerConnection } from 'werift'
import { createRelayServer } from '../../packages/relay-server/src/index.js'
import {
  BULK_FLAG_EOF,
  BULK_SLICE_BYTES,
  P2P_BULK_LABEL,
  P2P_CTRL_LABEL,
  createCtrlCodec,
  decodeBulkFrame,
  encodeBulkFrame,
  sendWithBackpressure,
} from '../../packages/shared/src/p2p-mux.js'
import {
  decryptAutoStream,
  decryptBinaryJson,
  decryptJson,
  encryptBinaryJson,
  encryptChunkedBytes,
  encryptJson,
  isCompressibleFile,
} from '../../packages/shared/src/e2ee.js'

export const TEST_BOOTSTRAP_TOKEN = 'smoke-bootstrap-token-123'
export const SMOKE_ADMIN_PASS = 'SmokeAdminPass99!'

export function createTempDir(prefix = 'allinone-int-') {
  const dir = mkdtempSync(join(os.tmpdir(), prefix))
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

export async function startTestRelay(tmpDir, options = {}) {
  const accountsFile = options.accountsFile || join(tmpDir, 'accounts.json')
  const relay = createRelayServer({
    port: 0,
    host: '127.0.0.1',
    jwtSecret: 'smoke-test-jwt-secret-0123456789',
    adminBootstrapToken: TEST_BOOTSTRAP_TOKEN,
    accountsFile,
    stunEnabled: false,
    ...options,
  })
  const started = await relay.start()
  const { port } = started
  const httpBase = `http://127.0.0.1:${port}`
  const wsBridgeUrl = `ws://127.0.0.1:${port}/ws/bridge`
  return {
    relay,
    port,
    stunPort: started.stunPort,
    httpBase,
    wsBridgeUrl,
    accountsFile,
    async close() {
      await relay.close()
    },
  }
}

export async function createIsolatedRelayEnv(prefix = 'allinone-int-', relayOptions = {}) {
  const temp = createTempDir(prefix)
  try {
    const started = await startTestRelay(temp.dir, relayOptions)
    return {
      tmpDir: temp.dir,
      ...started,
      async cleanup() {
        try {
          await started.close()
        } finally {
          temp.cleanup()
        }
      },
    }
  } catch (err) {
    temp.cleanup()
    throw err
  }
}

export function createSmokeByteQueue() {
  const chunks = []
  let waiter = null
  let ended = false
  let error = null
  return {
    push(u8) {
      if (ended || error || !u8?.byteLength) return
      if (waiter) {
        const w = waiter
        waiter = null
        w.resolve({ value: u8, done: false })
      } else {
        chunks.push(u8)
      }
    },
    end() {
      if (ended || error) return
      ended = true
      if (waiter) {
        const w = waiter
        waiter = null
        w.resolve({ value: undefined, done: true })
      }
    },
    fail(err) {
      if (ended || error) return
      error = err || new Error('aborted')
      if (waiter) {
        const w = waiter
        waiter = null
        w.reject(error)
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (chunks.length > 0) return Promise.resolve({ value: chunks.shift(), done: false })
            if (error) return Promise.reject(error)
            if (ended) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve, reject) => {
              waiter = { resolve, reject }
            })
          },
        }
      },
    },
  }
}

export function createMockSecretStore() {
  return {
    isAvailable: () => true,
    encrypt: (plain) => `enc_v1:${Buffer.from(String(plain), 'utf8').toString('base64')}`,
    decrypt: (enc) => {
      if (!String(enc || '').startsWith('enc_v1:')) throw new Error('bad cipher')
      return Buffer.from(enc.slice(7), 'base64').toString('utf8')
    },
  }
}

export async function createMockSmtpServer() {
  const inbox = []
  const server = net.createServer((sock) => {
    let buf = ''
    let state = 'cmd'
    let cur = { authUser: '', authPass: '', mailFrom: '', rcptTo: '', rawData: '' }
    sock.write('220 mock-smtp.local ESMTP Ready\r\n')
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      while (true) {
        if (state === 'data') {
          const endIdx = buf.indexOf('\r\n.\r\n')
          if (endIdx === -1) break
          cur.rawData = buf.slice(0, endIdx)
          buf = buf.slice(endIdx + 5)
          const b64Match = cur.rawData.match(
            /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/,
          )
          const decodedText = b64Match
            ? Buffer.from(b64Match[1].replace(/\r?\n/g, ''), 'base64').toString('utf8')
            : cur.rawData
          const codeMatch = decodedText.match(/\b(\d{6})\b/)
          inbox.push({ ...cur, decodedText, code: codeMatch ? codeMatch[1] : '' })
          cur = { authUser: cur.authUser, authPass: cur.authPass, mailFrom: '', rcptTo: '', rawData: '' }
          state = 'cmd'
          sock.write('250 2.0.0 OK queued\r\n')
          continue
        }
        const nl = buf.indexOf('\n')
        if (nl === -1) break
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (state === 'auth_user') {
          cur.authUser = Buffer.from(line, 'base64').toString('utf8')
          state = 'auth_pass'
          sock.write('334 UGFzc3dvcmQ6\r\n')
        } else if (state === 'auth_pass') {
          cur.authPass = Buffer.from(line, 'base64').toString('utf8')
          state = 'cmd'
          sock.write('235 2.7.0 Authentication successful\r\n')
        } else if (/^EHLO /i.test(line)) {
          sock.write('250-mock-smtp.local\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n')
        } else if (/^AUTH LOGIN$/i.test(line)) {
          state = 'auth_user'
          sock.write('334 VXNlcm5hbWU6\r\n')
        } else if (/^MAIL FROM:/i.test(line)) {
          cur.mailFrom = line.slice(10).trim()
          sock.write('250 OK\r\n')
        } else if (/^RCPT TO:/i.test(line)) {
          cur.rcptTo = line.slice(8).trim()
          sock.write('250 OK\r\n')
        } else if (/^DATA$/i.test(line)) {
          state = 'data'
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (/^QUIT$/i.test(line)) {
          sock.write('221 Bye\r\n')
          sock.end()
        } else {
          sock.write('250 OK\r\n')
        }
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    inbox,
    close: () => new Promise((r) => server.close(r)),
  }
}

export function connectMockBridgeWs(
  port,
  { roomId, deviceSecret, bridgeId, hostname = 'mock-pc', platform = 'darwin', apps = [], keyId = '0123456789abcdef' },
) {
  return new Promise((resolveBr, rejectBr) => {
    const qs = new URLSearchParams({ roomId, bridgeId, hostname, platform, mode: 'desktop' })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/bridge?${qs.toString()}`, {
      headers: { 'X-Room-Id': roomId, 'X-Bridge-Secret': deviceSecret },
    })
    let closedCode = null
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'bridge.meta', meta: { apps, e2ee: { enabled: true, v: 1, keyId } } }))
      resolveBr({ ws, getClosedCode: () => closedCode })
    })
    ws.on('close', (code) => {
      closedCode = code
    })
    ws.on('error', rejectBr)
  })
}

export async function openTicketClientWs(httpBase, port, token, { deviceName = 'smoke-client', clientKind = 'web' } = {}) {
  const ticketRes = await (
    await fetch(`${httpBase}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceName, clientKind }),
    })
  ).json()
  assert.equal(ticketRes.ok, true, 'POST /api/auth/ws-ticket should succeed')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client?ticket=${encodeURIComponent(ticketRes.ticket)}`)
  const inbox = []
  const events = []
  const p2pEvents = []
  const waiters = []
  const peers = new Map()
  let hello = null
  let closedCode = null

  const waitNext = (pred, timeoutMs = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer)
        if (idx !== -1) waiters.splice(idx, 1)
        reject(new Error('Timed out waiting for WS message'))
      }, timeoutMs)
      waiters.push({ pred, resolve, timer })
    })

  const waitFor = (pred, timeoutMs = 4000) => {
    const existing = inbox.find(pred)
    if (existing) return Promise.resolve(existing)
    return waitNext(pred, timeoutMs)
  }

  await new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      inbox.push(msg)
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].pred(msg)) {
          const w = waiters.splice(i, 1)[0]
          clearTimeout(w.timer)
          w.resolve(msg)
        }
      }
      if (msg.type === 'hello') {
        hello = msg
        resolve()
        return
      }
      if (msg.type === 'p2p.signal') {
        const p = peers.get(String(msg.bridgeId || ''))
        if (p) void p.handleSignal(msg)
        return
      }
      if (msg.type === 'p2p.signal.error') {
        const p = peers.get(String(msg.bridgeId || ''))
        if (p) p.handleSignalError(msg)
        return
      }
      if (msg.type === 'event') {
        events.push(msg)
      }
    })
    ws.on('close', (code) => {
      closedCode = code
    })
    ws.on('error', reject)
  })

  let reqSeq = 1
  let uploadStreamSeq = 1

  const connectP2p = async ({ bridgeId, e2eeKey, roomId }) => {
    const bid = String(bridgeId || hello?.bridges?.[0]?.bridgeId || '')
    const existing = peers.get(bid)
    if (existing && !existing.closed) {
      await existing.ready
      return existing
    }

    const sessionId = `smoke-p2p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const pc = new RTCPeerConnection({ iceServers: [] })
    const ctrlDc = pc.createDataChannel(P2P_CTRL_LABEL, { ordered: true })
    const bulkDc = pc.createDataChannel(P2P_BULK_LABEL, { ordered: true })
    const ctrlCodec = createCtrlCodec()
    const pendingRpcs = new Map()
    const activeDownloads = new Map()
    const activeUploads = new Map()
    const remoteIceQueue = []
    let remoteDescSet = false
    let resolveReady
    let rejectReady
    const ready = new Promise((res, rej) => {
      resolveReady = res
      rejectReady = rej
    })
    ready.catch(() => {})

    const peerObj = {
      bridgeId: bid,
      sessionId,
      pc,
      ctrlDc,
      bulkDc,
      ready,
      closed: false,
      e2eeKey,
      roomId,
      sendCtrlJson(obj) {
        if (peerObj.closed || ctrlDc.readyState !== 'open') return false
        for (const f of ctrlCodec.encode(obj)) {
          ctrlDc.send(Buffer.from(f.buffer, f.byteOffset, f.byteLength))
        }
        return true
      },
      async sendBulkCtrl(inner) {
        const enc = await encryptBinaryJson(e2eeKey, inner, { kind: 'p2p.bulk', roomId })
        assert.equal(peerObj.sendCtrlJson({ type: 'bulk.ctrl', bin: enc.bytes }), true, 'bulk.ctrl send should succeed')
      },
      async close() {
        if (peerObj.closed) return
        peerObj.closed = true
        rejectReady(new Error('P2P closed'))
        for (const p of pendingRpcs.values()) {
          clearTimeout(p.timer)
          p.reject(new Error('P2P closed'))
        }
        pendingRpcs.clear()
        for (const dl of activeDownloads.values()) {
          dl.headerReject?.(new Error('P2P closed'))
          dl.queue.fail(new Error('P2P closed'))
        }
        activeDownloads.clear()
        for (const up of activeUploads.values()) {
          up.readyReject?.(new Error('P2P closed'))
          up.doneReject?.(new Error('P2P closed'))
        }
        activeUploads.clear()
        try { ctrlDc.close() } catch {}
        try { bulkDc.close() } catch {}
        try { await pc.close() } catch {}
      },
      handleSignalError(msg) {
        if (msg.sessionId && msg.sessionId !== sessionId) return
        const err = new Error(msg.message || msg.code || 'P2P signal error')
        err.code = msg.code || 'BRIDGE_OFFLINE'
        rejectReady(err)
        void peerObj.close()
      },
      async handleSignal(msg) {
        if (peerObj.closed || (msg.sessionId && msg.sessionId !== sessionId)) return
        let inner
        try {
          inner = await decryptJson(e2eeKey, msg.e2ee, { kind: 'p2p.signal', roomId })
        } catch {
          return
        }
        if (inner.kind === 'answer' && inner.sdp) {
          await pc.setRemoteDescription({ type: 'answer', sdp: inner.sdp })
          remoteDescSet = true
          while (remoteIceQueue.length > 0) {
            await pc.addIceCandidate(new RTCIceCandidate(remoteIceQueue.shift())).catch(() => {})
          }
        } else if (inner.kind === 'ice' && inner.candidate) {
          if (!remoteDescSet) remoteIceQueue.push(inner.candidate)
          else await pc.addIceCandidate(new RTCIceCandidate(inner.candidate)).catch(() => {})
        } else if (inner.kind === 'close') {
          await peerObj.close()
        }
      },
      async sendRawCtrlRpc(frame) {
        await ready
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRpcs.delete(frame.id)
            reject(new Error(`Raw P2P RPC timeout: ${frame.id}`))
          }, 15_000)
          pendingRpcs.set(frame.id, {
            resolve: (m) => {
              clearTimeout(timer)
              resolve(m)
            },
            reject: (e) => {
              clearTimeout(timer)
              reject(e)
            },
            timer,
          })
          if (!peerObj.sendCtrlJson(frame)) {
            clearTimeout(timer)
            pendingRpcs.delete(frame.id)
            reject(new Error('P2P channel closed'))
          }
        })
      },
      async sendEncryptedRpc(method, params = {}) {
        const id = `t-${reqSeq++}`
        const enc = await encryptBinaryJson(
          e2eeKey,
          { method, params, cid: id, ts: Date.now() },
          { kind: 'rpc.req', roomId },
        )
        const rawRes = await peerObj.sendRawCtrlRpc({ type: 'rpc.req', id, bin: enc.bytes })
        if (rawRes.bin) {
          const dec = await decryptBinaryJson(e2eeKey, rawRes.bin, { kind: 'rpc.res', roomId })
          assert.equal(dec.cid, id, 'Decrypted RPC response cid must match request id')
          if (dec.ok) return dec.result
          const err = new Error(dec.error?.message || 'RPC error')
          err.code = dec.error?.code || 'RPC_ERROR'
          throw err
        }
        const err = new Error(rawRes.error?.message || 'RPC error')
        err.code = rawRes.error?.code || 'RPC_ERROR'
        throw err
      },
      async downloadBulkStream(streamId) {
        await ready
        const queue = createSmokeByteQueue()
        let headerResolve
        let headerReject
        const headerPromise = new Promise((res, rej) => {
          headerResolve = res
          headerReject = rej
        })
        activeDownloads.set(streamId, { queue, headerResolve, headerReject })
        try {
          await peerObj.sendBulkCtrl({ action: 'pull', streamId })
          const header = await headerPromise
          const dec = await decryptAutoStream(e2eeKey, queue.iterable, {
            iv: header.e2ee.iv,
            kid: header.e2ee.kid || '',
            kind: 'upload',
            roomId,
            chunked: Boolean(header.e2ee.chunked),
            compressed: Boolean(header.e2ee.compressed),
          })
          return Buffer.concat((dec.chunks || []).map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
        } finally {
          activeDownloads.delete(streamId)
        }
      },
      async uploadFileBulk(buf, { filename = 'upload.bin', mimeType = 'application/octet-stream' } = {}) {
        await ready
        const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
        const transferId = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const streamId = uploadStreamSeq++
        let readyResolve
        let readyReject
        let doneResolve
        let doneReject
        const readyPromise = new Promise((res, rej) => {
          readyResolve = res
          readyReject = rej
        })
        const donePromise = new Promise((res, rej) => {
          doneResolve = res
          doneReject = rej
        })
        activeUploads.set(transferId, { streamId, readyResolve, readyReject, doneResolve, doneReject })
        try {
          let seq = 0
          await encryptChunkedBytes(
            e2eeKey,
            {
              totalSize: raw.length,
              readSlice: async (offset, len) => new Uint8Array(raw.buffer, raw.byteOffset + offset, len),
            },
            {
              kind: 'upload',
              roomId,
              compress: isCompressibleFile(mimeType, filename),
              onHeader: async (e2eeMeta) => {
                await peerObj.sendBulkCtrl({
                  action: 'upload.start',
                  transferId,
                  streamId,
                  filename,
                  mimeType,
                  size: raw.length,
                  e2ee: e2eeMeta,
                })
                await readyPromise
              },
              onChunk: async (cipherChunk) => {
                for (let off = 0; off < cipherChunk.byteLength; off += BULK_SLICE_BYTES) {
                  const slice = cipherChunk.subarray(off, Math.min(cipherChunk.byteLength, off + BULK_SLICE_BYTES))
                  const f = encodeBulkFrame(streamId, seq++, slice, 0)
                  await sendWithBackpressure(bulkDc, Buffer.from(f.buffer, f.byteOffset, f.byteLength))
                }
              },
            },
          )
          const eofF = encodeBulkFrame(streamId, seq++, new Uint8Array(0), BULK_FLAG_EOF)
          await sendWithBackpressure(bulkDc, Buffer.from(eofF.buffer, eofF.byteOffset, eofF.byteLength))
          return await donePromise
        } finally {
          activeUploads.delete(transferId)
        }
      },
    }

    const checkOpen = () => {
      if (ctrlDc.readyState === 'open' && bulkDc.readyState === 'open') resolveReady(peerObj)
    }
    ctrlDc.stateChanged.subscribe((st) => {
      if (st === 'open') checkOpen()
      if (st === 'closed' || st === 'closing') void peerObj.close()
    })
    bulkDc.stateChanged.subscribe((st) => {
      if (st === 'open') checkOpen()
      if (st === 'closed' || st === 'closing') void peerObj.close()
    })
    ctrlDc.onMessage.subscribe((raw) => {
      const u8 = Buffer.isBuffer(raw)
        ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        : raw instanceof Uint8Array
          ? raw
          : new Uint8Array(raw)
      const msg = ctrlCodec.decode(u8)
      if (!msg) return
      if (msg.type === 'rpc.res') {
        const p = pendingRpcs.get(msg.id)
        if (p) {
          pendingRpcs.delete(msg.id)
          p.resolve(msg)
        }
      } else if (msg.type === 'event' && msg.bin) {
        p2pEvents.push({ ...msg, bridgeId: bid })
      } else if (msg.type === 'bulk.ctrl' && msg.bin) {
        decryptBinaryJson(e2eeKey, msg.bin, { kind: 'p2p.bulk', roomId })
          .then((inner) => {
            if (inner.action === 'download.header') {
              activeDownloads.get(Number(inner.streamId))?.headerResolve?.(inner)
            } else if (inner.action === 'download.error') {
              const dl = activeDownloads.get(Number(inner.streamId))
              const err = new Error(inner.message || 'download error')
              dl?.headerReject?.(err)
              dl?.queue?.fail(err)
            } else if (inner.action === 'upload.ready') {
              activeUploads.get(String(inner.transferId))?.readyResolve?.(inner)
            } else if (inner.action === 'upload.done') {
              activeUploads.get(String(inner.transferId))?.doneResolve?.(inner)
            } else if (inner.action === 'upload.error') {
              const up = activeUploads.get(String(inner.transferId))
              const err = new Error(inner.message || 'upload error')
              up?.readyReject?.(err)
              up?.doneReject?.(err)
            }
          })
          .catch(() => {})
      }
    })
    bulkDc.onMessage.subscribe((raw) => {
      const u8 = Buffer.isBuffer(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw)
      const frame = decodeBulkFrame(u8)
      if (!frame) return
      const dl = activeDownloads.get(frame.streamId)
      if (!dl) return
      if (frame.payload.byteLength > 0) dl.queue.push(frame.payload)
      if (frame.eof) dl.queue.end()
    })

    const localIceQueue = []
    let offerSent = false
    pc.onIceCandidate.subscribe(async (cand) => {
      if (!cand || peerObj.closed || ws.readyState !== WebSocket.OPEN) return
      const cObj = { candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex }
      if (!offerSent) {
        localIceQueue.push(cObj)
        return
      }
      const e2ee = await encryptJson(e2eeKey, { kind: 'ice', candidate: cObj }, { kind: 'p2p.signal', roomId })
      if (!peerObj.closed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'p2p.signal', bridgeId: bid, sessionId, e2ee }))
      }
    })
    pc.connectionStateChange.subscribe((st) => {
      if (st === 'failed' || st === 'closed') void peerObj.close()
    })

    peers.set(bid, peerObj)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const offerEnc = await encryptJson(e2eeKey, { kind: 'offer', sdp: offer.sdp }, { kind: 'p2p.signal', roomId })
    ws.send(JSON.stringify({ type: 'p2p.signal', bridgeId: bid, sessionId, e2ee: offerEnc }))
    offerSent = true
    while (localIceQueue.length > 0 && !peerObj.closed && ws.readyState === WebSocket.OPEN) {
      const cObj = localIceQueue.shift()
      const e2ee = await encryptJson(e2eeKey, { kind: 'ice', candidate: cObj }, { kind: 'p2p.signal', roomId })
      if (!peerObj.closed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'p2p.signal', bridgeId: bid, sessionId, e2ee }))
      }
    }

    const timeout = setTimeout(() => {
      rejectReady(new Error(`P2P connect timeout to bridge ${bid}`))
      void peerObj.close()
    }, 10_000)
    try {
      await ready
    } finally {
      clearTimeout(timeout)
    }
    return peerObj
  }

  const sendEncryptedRpc = async (method, params = {}, { e2eeKey, roomId, bridgeId = '' } = {}) => {
    const peer = await connectP2p({ bridgeId, e2eeKey, roomId })
    return peer.sendEncryptedRpc(method, params)
  }

  const closeAll = async () => {
    for (const p of peers.values()) await p.close()
    peers.clear()
    try { ws.close() } catch {}
  }

  return {
    ws,
    hello,
    inbox,
    events,
    p2pEvents,
    waitFor,
    waitNext,
    connectP2p,
    sendEncryptedRpc,
    closeAll,
    getClosedCode: () => closedCode,
  }
}
