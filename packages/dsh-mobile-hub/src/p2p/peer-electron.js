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
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve(this.socket)
    }
    if (this.connectPromise) {
      return this.connectPromise
    }
    const connPromise = new Promise((resolveConn, rejectConn) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port })
      sock.setNoDelay(true)
      let authed = false
      let settled = false
      let buf = Buffer.alloc(0)

      const rejectOnce = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.connectPromise === connPromise) {
          this.connectPromise = null
        }
        rejectConn(err)
      }

      const resolveOnce = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.socket = sock
        resolveConn(sock)
      }

      const timer = setTimeout(() => {
        try { sock.destroy() } catch {}
        rejectOnce(new Error('Electron WebRTC proxy connect timeout'))
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
              resolveOnce()
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
        if (!authed) {
          rejectOnce(err)
        }
      })

      sock.on('close', () => {
        clearTimeout(timer)
        if (!authed) {
          rejectOnce(new Error('Electron WebRTC proxy closed during auth'))
          return
        }
        if (this.socket !== sock) return
        this.socket = null
        if (this.connectPromise === connPromise) {
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
    this.connectPromise = connPromise
    return connPromise
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
    if (!sock || sock.destroyed) {
      throw new Error('Electron WebRTC proxy closed')
    }
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
    let proxyNotifiedClosed = false
    let bulkBuffered = 0
    const drainWaiters = []
    const socketDrainWaiters = []

    const makeAbortError = () => {
      const err = new Error('Transfer aborted')
      err.name = 'AbortError'
      return err
    }

    const assertBulkReady = (signal) => {
      if (signal?.aborted) throw makeAbortError()
      if (closed || !bulkOpen || !this.socket || this.socket.destroyed) {
        throw new Error('Bulk DataChannel is not open')
      }
    }

    const flushDrainWaiters = () => {
      if (bulkBuffered > 512 * 1024) return
      while (drainWaiters.length > 0) {
        const w = drainWaiters.shift()
        w.resolve()
      }
    }

    const rejectAllWaiters = (err) => {
      while (drainWaiters.length > 0) {
        drainWaiters.shift().reject(err)
      }
      while (socketDrainWaiters.length > 0) {
        socketDrainWaiters.shift()(err)
      }
    }

    const notifyProxyClose = () => {
      if (proxyNotifiedClosed) return
      proxyNotifiedClosed = true
      if (this.socket && !this.socket.destroyed) {
        try {
          this.socket.write(encodeJsonFrame({ type: 'peer.close', peerId }))
        } catch {}
      }
    }

    const peer = {
      engine: 'electron-chromium',
      _fireClosed: () => {
        notifyProxyClose()
        if (closed) return
        closed = true
        ctrlOpen = false
        bulkOpen = false
        this.peers.delete(peerId)
        rejectAllWaiters(new Error('WebRTC peer closed'))
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
            rejectAllWaiters(new Error('Bulk DataChannel closed'))
          }
        } else if (msg.type === 'dc.error') {
          peer._fireClosed()
        } else if (msg.type === 'dc.text' && msg.role === 'ctrl') {
          try { opts.onCtrlMessage?.(String(msg.data || '')) } catch {}
        } else if (msg.type === 'dc.buffered' && msg.role === 'bulk') {
          bulkBuffered = Number(msg.bufferedAmount || 0)
          flushDrainWaiters()
        } else if (msg.type === 'transport' && msg.transport) {
          try { opts.onTransportChange?.(String(msg.transport)) } catch {}
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
        assertBulkReady(signal)
        while (bulkBuffered >= 2 * 1024 * 1024) {
          await new Promise((resolveWait, rejectWait) => {
            let done = false
            const cleanup = () => {
              clearTimeout(timer)
              const idx = drainWaiters.indexOf(entry)
              if (idx !== -1) drainWaiters.splice(idx, 1)
              if (signal) signal.removeEventListener('abort', onAbort)
            }
            const finishResolve = () => {
              if (done) return
              done = true
              cleanup()
              resolveWait()
            }
            const finishReject = (err) => {
              if (done) return
              done = true
              cleanup()
              rejectWait(err)
            }
            const onAbort = () => finishReject(makeAbortError())
            const timer = setTimeout(() => {
              finishReject(new Error('Bulk DataChannel backpressure stall timeout'))
            }, 15_000)
            timer.unref?.()
            const entry = { resolve: finishResolve, reject: finishReject }
            drainWaiters.push(entry)
            if (signal) {
              if (signal.aborted) {
                onAbort()
                return
              }
              signal.addEventListener('abort', onAbort, { once: true })
            }
          })
          assertBulkReady(signal)
        }
        const sock = this.socket
        const raw = Buffer.isBuffer(bytes)
          ? bytes
          : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const frame = encodeBinFrame(peerId, 'bulk', raw)
        const ok = sock.write(frame)
        if (!ok) {
          await new Promise((resolveDrain, rejectDrain) => {
            let done = false
            const cleanup = () => {
              sock.off('drain', onDrain)
              sock.off('close', onClose)
              sock.off('error', onError)
              const idx = socketDrainWaiters.indexOf(onPeerClosed)
              if (idx !== -1) socketDrainWaiters.splice(idx, 1)
              if (signal) signal.removeEventListener('abort', onAbort)
            }
            const onDrain = () => {
              if (done) return
              done = true
              cleanup()
              resolveDrain()
            }
            const onClose = () => {
              if (done) return
              done = true
              cleanup()
              rejectDrain(new Error('Electron WebRTC proxy closed'))
            }
            const onError = (err) => {
              if (done) return
              done = true
              cleanup()
              rejectDrain(err || new Error('Electron WebRTC proxy socket error'))
            }
            const onPeerClosed = (err) => {
              if (done) return
              done = true
              cleanup()
              rejectDrain(err || new Error('WebRTC peer closed'))
            }
            const onAbort = () => {
              if (done) return
              done = true
              cleanup()
              rejectDrain(makeAbortError())
            }
            if (sock.destroyed || closed || !bulkOpen) {
              onClose()
              return
            }
            if (signal?.aborted) {
              onAbort()
              return
            }
            socketDrainWaiters.push(onPeerClosed)
            sock.once('drain', onDrain)
            sock.once('close', onClose)
            sock.once('error', onError)
            if (signal) signal.addEventListener('abort', onAbort, { once: true })
          })
          assertBulkReady(signal)
        }
      },
      close: async () => {
        notifyProxyClose()
        if (closed) return
        peer._fireClosed()
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
