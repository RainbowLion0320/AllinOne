import { randomUUID } from 'node:crypto'
import net from 'node:net'

const FRAME_JSON = 1
const FRAME_BIN = 2

function encodeJsonFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  const out = Buffer.allocUnsafe(5 + payload.length)
  out.writeUInt32BE(1 + payload.length, 0)
  out[4] = FRAME_JSON
  payload.copy(out, 5)
  return out
}

function encodeBinFrame(peerId, role, bytes) {
  const pidBuf = Buffer.from(String(peerId || ''), 'utf8')
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const bodyLen = 1 + 1 + pidBuf.length + 1 + raw.length
  const out = Buffer.allocUnsafe(4 + bodyLen)
  out.writeUInt32BE(bodyLen, 0)
  out[4] = FRAME_BIN
  out[5] = pidBuf.length & 0xff
  pidBuf.copy(out, 6)
  out[6 + pidBuf.length] = role === 'bulk' ? 1 : 0
  raw.copy(out, 7 + pidBuf.length)
  return out
}

/**
 * Persistent loopback TCP client connecting `allinone-bridge.mjs` to Electron's native Chromium
 * `libwebrtc` hidden worker (`DesktopWebRtcProxy`).
 */
export class ElectronWebRtcClient {
  constructor({ port, token, log = console }) {
    this.port = Number(port)
    this.token = String(token || '')
    this.log = log
    this.socket = null
    this.connectPromise = null
    this.pendingReqs = new Map()
    this.peers = new Map()
    this.disposed = false
  }

  ensureConnected() {
    if (this.disposed) return Promise.reject(new Error('ElectronWebRtcClient disposed'))
    if (this.socket && !this.socket.destroyed && this.connectPromise) {
      return this.connectPromise
    }
    this.connectPromise = new Promise((resolveConn, rejectConn) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port })
      sock.setNoDelay(true)
      let authed = false
      let buf = Buffer.alloc(0)
      const timer = setTimeout(() => {
        try { sock.destroy() } catch {}
        rejectConn(new Error('Electron WebRTC proxy connect timeout'))
      }, 8_000)

      sock.on('connect', () => {
        sock.write(encodeJsonFrame({ type: 'auth', token: this.token }))
      })

      sock.on('data', (chunk) => {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0)
          if (len <= 0 || len > 16 * 1024 * 1024) {
            sock.destroy()
            return
          }
          if (buf.length < 4 + len) break
          const kind = buf[4]
          const payload = buf.subarray(5, 4 + len)
          buf = buf.subarray(4 + len)

          if (kind === FRAME_JSON) {
            let msg
            try { msg = JSON.parse(payload.toString('utf8')) } catch { continue }
            if (!authed && msg.type === 'auth.ok') {
              authed = true
              this.socket = sock
              clearTimeout(timer)
              resolveConn(sock)
              continue
            }
            this.handleMessage(msg)
          } else if (kind === FRAME_BIN && authed) {
            if (payload.length < 3) continue
            const pidLen = payload[0]
            if (payload.length < 2 + pidLen) continue
            const peerId = payload.subarray(1, 1 + pidLen).toString('utf8')
            const role = payload[1 + pidLen] === 1 ? 'bulk' : 'ctrl'
            const bytes = new Uint8Array(payload.subarray(2 + pidLen))
            const peer = this.peers.get(peerId)
            if (peer) peer._onBinary(role, bytes)
          }
        }
      })

      sock.on('error', (err) => {
        clearTimeout(timer)
        if (!authed) rejectConn(err)
      })

      sock.on('close', () => {
        clearTimeout(timer)
        if (this.socket === sock) {
          this.socket = null
          this.connectPromise = null
        }
        for (const [reqId, p] of this.pendingReqs.entries()) {
          clearTimeout(p.timer)
          p.reject(new Error('Electron WebRTC proxy closed'))
          this.pendingReqs.delete(reqId)
        }
        for (const peer of [...this.peers.values()]) {
          peer._fireClosed()
        }
      })
    })
    return this.connectPromise
  }

  handleMessage(msg) {
    if (msg.type === 'res' && msg.reqId) {
      const p = this.pendingReqs.get(msg.reqId)
      if (p) {
        clearTimeout(p.timer)
        this.pendingReqs.delete(msg.reqId)
        if (msg.ok) p.resolve(msg)
        else p.reject(new Error(msg.error || 'WebRTC worker error'))
      }
      return
    }
    const peer = msg.peerId ? this.peers.get(msg.peerId) : null
    if (!peer) return
    peer._onControl(msg)
  }

  async sendCommand(cmd, expectReply = false) {
    const sock = await this.ensureConnected()
    if (!expectReply) {
      sock.write(encodeJsonFrame(cmd))
      return null
    }
    const reqId = randomUUID()
    return await new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pendingReqs.delete(reqId)
        rejectReq(new Error(`WebRTC worker command timeout: ${cmd.type}`))
      }, 15_000)
      this.pendingReqs.set(reqId, { resolve: resolveReq, reject: rejectReq, timer })
      sock.write(encodeJsonFrame({ ...cmd, reqId }))
    })
  }

  createPeer(opts = {}) {
    const peerId = randomUUID().slice(0, 12)
    let ctrlOpen = false
    let bulkOpen = false
    let closed = false
    let bulkBuffered = 0
    const drainWaiters = []

    const flushDrainWaiters = () => {
      if (bulkBuffered > 512 * 1024) return
      while (drainWaiters.length > 0) {
        const w = drainWaiters.shift()
        w.resolve()
      }
    }

    const peer = {
      engine: 'electron-chromium',
      _fireClosed: () => {
        if (closed) return
        closed = true
        ctrlOpen = false
        bulkOpen = false
        this.peers.delete(peerId)
        while (drainWaiters.length > 0) {
          drainWaiters.shift().reject(new Error('WebRTC peer closed'))
        }
        try { opts.onClose?.() } catch {}
      },
      _onControl: (msg) => {
        if (closed) return
        if (msg.type === 'ice' && msg.candidate) {
          try { opts.onIceCandidate?.(msg.candidate) } catch {}
        } else if (msg.type === 'state' || msg.type === 'iceState') {
          try { opts.onStateChange?.(String(msg.state || '')) } catch {}
          if (msg.state === 'failed' || msg.state === 'closed') peer._fireClosed()
        } else if (msg.type === 'dc.open') {
          if (msg.role === 'ctrl') {
            ctrlOpen = true
            try { opts.onCtrlOpen?.() } catch {}
          } else if (msg.role === 'bulk') {
            bulkOpen = true
            try { opts.onBulkOpen?.() } catch {}
          }
        } else if (msg.type === 'dc.close') {
          if (msg.role === 'ctrl') {
            ctrlOpen = false
            peer._fireClosed()
          } else if (msg.role === 'bulk') {
            bulkOpen = false
          }
        } else if (msg.type === 'dc.text' && msg.role === 'ctrl') {
          try { opts.onCtrlMessage?.(String(msg.data || '')) } catch {}
        } else if (msg.type === 'dc.buffered' && msg.role === 'bulk') {
          bulkBuffered = Number(msg.bufferedAmount || 0)
          flushDrainWaiters()
        }
      },
      _onBinary: (role, bytes) => {
        if (closed) return
        if (role === 'bulk') {
          try { opts.onBulkMessage?.(bytes) } catch {}
        } else {
          try { opts.onCtrlMessage?.(Buffer.from(bytes).toString('utf8')) } catch {}
        }
      },
      handleOffer: async (sdp) => {
        const res = await this.sendCommand(
          { type: 'peer.offer', peerId, sdp: String(sdp || ''), iceServers: opts.iceServers || [] },
          true,
        )
        return res.answer
      },
      addIceCandidate: async (candidate) => {
        if (closed || !candidate?.candidate) return
        await this.sendCommand({ type: 'peer.ice', peerId, candidate }, false).catch(() => {})
      },
      isCtrlOpen: () => !closed && ctrlOpen,
      isBulkOpen: () => !closed && bulkOpen,
      sendCtrl: (text) => {
        if (closed || !ctrlOpen || !this.socket || this.socket.destroyed) return false
        try {
          this.socket.write(encodeJsonFrame({ type: 'dc.sendText', peerId, role: 'ctrl', data: String(text) }))
          return true
        } catch {
          return false
        }
      },
      sendBulk: async (bytes, { signal = null } = {}) => {
        if (closed || !bulkOpen || !this.socket || this.socket.destroyed) {
          throw new Error('Bulk DataChannel is not open')
        }
        if (signal?.aborted) {
          const err = new Error('Transfer aborted')
          err.name = 'AbortError'
          throw err
        }
        if (bulkBuffered >= 2 * 1024 * 1024) {
          await new Promise((resolveWait, rejectWait) => {
            const entry = { resolve: resolveWait, reject: rejectWait }
            drainWaiters.push(entry)
            const t = setTimeout(() => {
              const i = drainWaiters.indexOf(entry)
              if (i !== -1) drainWaiters.splice(i, 1)
              bulkBuffered = 0
              resolveWait()
            }, 2_000)
            entry.resolve = () => { clearTimeout(t); resolveWait() }
            entry.reject = (e) => { clearTimeout(t); rejectWait(e) }
          })
        }
        const raw = Buffer.isBuffer(bytes)
          ? bytes
          : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const frame = encodeBinFrame(peerId, 'bulk', raw)
        const ok = this.socket.write(frame)
        if (!ok) {
          await new Promise((resolveDrain) => this.socket.once('drain', resolveDrain))
        }
      },
      close: async () => {
        if (closed) return
        const wasOpen = Boolean(this.socket && !this.socket.destroyed)
        peer._fireClosed()
        if (wasOpen) {
          try { this.socket.write(encodeJsonFrame({ type: 'peer.close', peerId })) } catch {}
        }
      },
    }

    this.peers.set(peerId, peer)
    return peer
  }

  dispose() {
    this.disposed = true
    for (const peer of [...this.peers.values()]) {
      peer._fireClosed()
    }
    if (this.socket) {
      try { this.socket.destroy() } catch {}
      this.socket = null
    }
  }
}
