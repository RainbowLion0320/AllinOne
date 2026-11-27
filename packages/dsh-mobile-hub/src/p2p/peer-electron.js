import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { createSerializedChannelWriter } from '@allinone/shared/p2p-mux'

const FRAME_JSON = 1
const FRAME_BIN = 2
const CTRL_HIGH_WATER_BYTES = 1024 * 1024
const CTRL_LOW_WATER_BYTES = 256 * 1024

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
  if (pidBuf.length > 255) {
    throw new RangeError(`ElectronWebRtcClient peerId exceeds 255 bytes (${pidBuf.length})`)
  }
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const bodyLen = 1 + 1 + pidBuf.length + 1 + raw.length
  const out = Buffer.allocUnsafe(4 + bodyLen)
  out.writeUInt32BE(bodyLen, 0)
  out[4] = FRAME_BIN
  out[5] = pidBuf.length
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
    this._connectingSocket = null
    this._connectTimer = null
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
      this._connectingSocket = sock
      sock.setNoDelay(true)
      let authed = false
      let settled = false
      const rxChunks = []
      let rxLen = 0
      const pullBytes = (n) => {
        if (rxChunks.length === 1 && rxChunks[0].length === n) {
          const only = rxChunks.pop()
          rxLen = 0
          return only
        }
        const out = Buffer.allocUnsafe(n)
        let off = 0
        while (off < n && rxChunks.length > 0) {
          const head = rxChunks[0]
          const take = Math.min(head.length, n - off)
          head.copy(out, off, 0, take)
          off += take
          if (take === head.length) rxChunks.shift()
          else rxChunks[0] = head.subarray(take)
        }
        rxLen -= n
        return out
      }
      const peekUInt32BE = () => {
        if (rxChunks[0].length >= 4) return rxChunks[0].readUInt32BE(0)
        const hdr = Buffer.allocUnsafe(4)
        let off = 0
        for (const c of rxChunks) {
          const take = Math.min(c.length, 4 - off)
          c.copy(hdr, off, 0, take)
          off += take
          if (off === 4) break
        }
        return hdr.readUInt32BE(0)
      }

      const clearConnectRefs = () => {
        clearTimeout(timer)
        if (this._connectTimer === timer) this._connectTimer = null
        if (this._connectingSocket === sock) this._connectingSocket = null
        if (this.connectPromise === connPromise) {
          this.connectPromise = null
        }
      }

      const rejectOnce = (err) => {
        if (settled) return
        settled = true
        clearConnectRefs()
        rejectConn(err)
      }

      const resolveOnce = () => {
        if (settled) return
        settled = true
        clearConnectRefs()
        if (this.disposed || sock.destroyed) {
          try { sock.destroy() } catch {}
          rejectConn(new Error('ElectronWebRtcClient disposed'))
          return
        }
        this.socket = sock
        resolveConn(sock)
      }

      const timer = setTimeout(() => {
        try { sock.destroy() } catch {}
        rejectOnce(new Error('Electron WebRTC proxy connect timeout'))
      }, 8_000)
      timer.unref?.()
      this._connectTimer = timer

      sock.on('connect', () => {
        if (this.disposed) {
          try { sock.destroy() } catch {}
          rejectOnce(new Error('ElectronWebRtcClient disposed'))
          return
        }
        sock.write(encodeJsonFrame({ type: 'auth', token: this.token }))
      })

      sock.on('data', (chunk) => {
        if (!chunk || chunk.length === 0) return
        rxChunks.push(chunk)
        rxLen += chunk.length
        while (rxLen >= 4) {
          const len = peekUInt32BE()
          if (len <= 0 || len > 16 * 1024 * 1024) {
            sock.destroy()
            return
          }
          if (rxLen < 4 + len) break
          const frame = pullBytes(4 + len)
          const kind = frame[4]
          const payload = frame.subarray(5)

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
      timer.unref?.()
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
    let unackedBulkBytes = 0
    const effectiveBulkBuffered = () => bulkBuffered + unackedBulkBytes
    const drainWaiters = []
    const socketDrainWaiters = []
    const ctrlCloseListeners = new Set()
    const ctrlDrainMap = new Map() // fn -> { sock, handler }

    const notifyCtrlClosed = () => {
      for (const fn of [...ctrlCloseListeners]) {
        try { fn() } catch {}
      }
      ctrlCloseListeners.clear()
      for (const { sock, handler } of ctrlDrainMap.values()) {
        try { sock.off('drain', handler) } catch {}
      }
      ctrlDrainMap.clear()
    }

    const ctrlChannel = {
      get readyState() {
        return !closed && ctrlOpen && self.socket && !self.socket.destroyed && self.socket.writable ? 'open' : 'closed'
      },
      get bufferedAmount() {
        return self.socket && !self.socket.destroyed ? Number(self.socket.writableLength || 0) : 0
      },
      addEventListener(type, fn) {
        if (typeof fn !== 'function') return
        if (type === 'close') {
          ctrlCloseListeners.add(fn)
        } else if (type === 'bufferedamountlow' && self.socket && !self.socket.destroyed) {
          if (ctrlDrainMap.has(fn)) return
          const sock = self.socket
          const handler = () => fn()
          ctrlDrainMap.set(fn, { sock, handler })
          sock.on('drain', handler)
        }
      },
      removeEventListener(type, fn) {
        if (type === 'close') {
          ctrlCloseListeners.delete(fn)
        } else if (type === 'bufferedamountlow') {
          const rec = ctrlDrainMap.get(fn)
          if (rec) {
            ctrlDrainMap.delete(fn)
            try { rec.sock.off('drain', rec.handler) } catch {}
          }
        }
      },
      send(data) {
        if (closed || !ctrlOpen || !self.socket || self.socket.destroyed || !self.socket.writable) {
          throw new Error('Control DataChannel is not open')
        }
        if (typeof data === 'string') {
          self.socket.write(encodeJsonFrame({ type: 'dc.sendText', peerId, role: 'ctrl', data }))
        } else {
          const raw = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          self.socket.write(encodeBinFrame(peerId, 'ctrl', raw))
        }
      },
    }

    const ctrlWriter = createSerializedChannelWriter(null, {
      highWaterMark: CTRL_HIGH_WATER_BYTES,
      lowWaterMark: CTRL_LOW_WATER_BYTES,
      timeoutMs: 30_000,
    })
    const bulkWriter = createSerializedChannelWriter()
    const self = this

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
      if (effectiveBulkBuffered() > 1024 * 1024) return
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
      ctrlWriter,
      bulkWriter,
      getCtrlChannel: () => (ctrlOpen ? ctrlChannel : null),
      _fireClosed: () => {
        notifyProxyClose()
        if (closed) return
        closed = true
        ctrlOpen = false
        bulkOpen = false
        notifyCtrlClosed()
        ctrlWriter.close()
        bulkWriter.close()
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
            ctrlWriter.setChannel(ctrlChannel)
            try { opts.onCtrlOpen?.() } catch {}
          } else if (msg.role === 'bulk') {
            bulkOpen = true
            try { opts.onBulkOpen?.() } catch {}
          }
        } else if (msg.type === 'dc.close') {
          if (msg.role === 'ctrl') {
            ctrlOpen = false
            notifyCtrlClosed()
            peer._fireClosed()
          } else if (msg.role === 'bulk') {
            bulkOpen = false
            bulkWriter.close()
            rejectAllWaiters(new Error('Bulk DataChannel closed'))
          }
        } else if (msg.type === 'dc.error') {
          peer._fireClosed()
        } else if (msg.type === 'dc.text' && msg.role === 'ctrl') {
          try { opts.onCtrlMessage?.(String(msg.data || '')) } catch {}
        } else if (msg.type === 'dc.buffered' && msg.role === 'bulk') {
          bulkBuffered = Number(msg.bufferedAmount || 0)
          if (msg.ackedBytes !== undefined) {
            unackedBulkBytes = Math.max(0, unackedBulkBytes - Number(msg.ackedBytes || 0))
          } else {
            unackedBulkBytes = 0
          }
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
          try { opts.onCtrlMessage?.(bytes) } catch {}
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
      sendCtrl: (data) => {
        if (closed || !ctrlOpen || !this.socket || this.socket.destroyed) return false
        try {
          if (typeof data === 'string') {
            this.socket.write(encodeJsonFrame({ type: 'dc.sendText', peerId, role: 'ctrl', data }))
          } else {
            const raw = Buffer.isBuffer(data)
              ? data
              : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            this.socket.write(encodeBinFrame(peerId, 'ctrl', raw))
          }
          return true
        } catch {
          return false
        }
      },
      sendBulk: (bytes, { signal = null } = {}) =>
        bulkWriter.enqueue(async () => {
          assertBulkReady(signal)
          while (effectiveBulkBuffered() >= 2 * 1024 * 1024) {
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
              }, 45_000)
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
          unackedBulkBytes += raw.length
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
        }),
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
    if (this._connectTimer) {
      clearTimeout(this._connectTimer)
      this._connectTimer = null
    }
    if (this._connectingSocket) {
      try { this._connectingSocket.destroy() } catch {}
      this._connectingSocket = null
    }
    this.connectPromise = null
    for (const [reqId, p] of this.pendingReqs.entries()) {
      clearTimeout(p.timer)
      p.reject(new Error('ElectronWebRtcClient disposed'))
      this.pendingReqs.delete(reqId)
    }
    for (const peer of [...this.peers.values()]) {
      peer._fireClosed()
    }
    if (this.socket) {
      try { this.socket.destroy() } catch {}
      this.socket = null
    }
  }
}
