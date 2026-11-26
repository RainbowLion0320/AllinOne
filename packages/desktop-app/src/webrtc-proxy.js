/**
 * Electron Main-Process Local Loopback WebRTC Proxy (`127.0.0.1` + 256-bit Token).
 *
 * Bridges the pure-Node embedded bridge child process (`allinone-bridge.mjs`) to Electron's
 * built-in native Chromium C++ `libwebrtc` via an on-demand hidden `BrowserWindow`:
 *  - Zero extra npm dependencies (`node:net` binary length-prefixed frames)
 *  - Zero idle RAM (worker window created lazily on first P2P peer, destroyed after 2 min idle)
 *  - Native C++ WebRTC throughput (80-100+ MB/s on LAN) & 100% iOS Safari / Chrome interop
 *
 * Wire framing over loopback TCP:
 *   [4B uint32 BE totalLen][1B kind][payload]
 *     kind = 0x01: UTF-8 JSON control message
 *     kind = 0x02: Binary DataChannel frame: [1B peerIdLen][peerId UTF-8][1B roleByte (0=ctrl,1=bulk)][raw bytes]
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import { join } from 'node:path'

const FRAME_JSON = 1
const FRAME_BIN = 2
const IDLE_DESTROY_MS = 120_000
const AUTH_TIMEOUT_MS = 5_000

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

export class DesktopWebRtcProxy {
  constructor({ BrowserWindow, ipcMain, srcDir, log = console }) {
    this.BrowserWindow = BrowserWindow
    this.ipcMain = ipcMain
    this.srcDir = srcDir
    this.log = log
    this.token = randomBytes(32).toString('hex')
    this.tokenBuf = Buffer.from(this.token, 'utf8')
    this.server = null
    this.port = 0
    this.workerWin = null
    this.workerReadyPromise = null
    this.activeSocket = null
    this.activePeerIds = new Set()
    this.pendingReqIds = new Set()
    this.idleTimer = null
    this.disposed = false

    this._onWorkerControl = (ev, msg) => this.handleWorkerControl(msg, ev)
    this._onWorkerBinary = (ev, payload) => this.handleWorkerBinary(payload, ev)
  }

  async start() {
    if (this.server) return { port: this.port, token: this.token }
    this.ipcMain.on('webrtc-worker:control', this._onWorkerControl)
    this.ipcMain.on('webrtc-worker:binary', this._onWorkerBinary)

    await new Promise((resolveStart, rejectStart) => {
      const srv = net.createServer((socket) => this.handleClientSocket(socket))
      srv.once('error', rejectStart)
      srv.listen(0, '127.0.0.1', () => {
        srv.off('error', rejectStart)
        const addr = srv.address()
        this.server = srv
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        resolveStart()
      })
    })
    return { port: this.port, token: this.token }
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  scheduleIdleDestroy() {
    this.clearIdleTimer()
    if (this.activePeerIds.size > 0 || !this.workerWin) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.activePeerIds.size === 0 && this.workerWin && !this.workerWin.isDestroyed()) {
        try { this.workerWin.destroy() } catch {}
        this.workerWin = null
        this.workerReadyPromise = null
      }
    }, IDLE_DESTROY_MS)
  }

  async ensureWorker() {
    if (this.disposed) throw new Error('WebRTC proxy disposed')
    this.clearIdleTimer()
    if (this.workerWin && !this.workerWin.isDestroyed() && this.workerReadyPromise) {
      return this.workerReadyPromise
    }

    const win = new this.BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        preload: join(this.srcDir, 'webrtc-worker-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    this.workerWin = win

    const readyPromise = new Promise((resolveReady, rejectReady) => {
      let settled = false
      const cleanupWorker = () => {
        if (this.workerWin === win) {
          this.workerWin = null
        }
        if (this.workerReadyPromise === readyPromise) {
          this.workerReadyPromise = null
        }
        if (!win.isDestroyed()) {
          try { win.destroy() } catch {}
        }
      }
      const failOnce = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ipcMain.removeListener('webrtc-worker:control', onReady)
        cleanupWorker()
        this.log.warn?.(`[webrtc-proxy] worker init failed: ${String(err?.message || err)}`)
        rejectReady(err)
      }
      const succeedOnce = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ipcMain.removeListener('webrtc-worker:control', onReady)
        resolveReady(win)
      }

      const timer = setTimeout(() => failOnce(new Error('WebRTC worker init timeout')), 10_000)
      const onReady = (ev, msg) => {
        if (msg?.type === 'worker.ready' && (!ev?.sender || ev.sender === win.webContents)) {
          succeedOnce()
        }
      }
      this.ipcMain.on('webrtc-worker:control', onReady)

      win.webContents?.on?.('did-fail-load', (_ev, code, desc) => {
        failOnce(new Error(`WebRTC worker failed to load (${code}: ${desc})`))
      })
      win.webContents?.on?.('render-process-gone', (_ev, details) => {
        const reason = details?.reason || 'gone'
        if (!settled) {
          failOnce(new Error(`WebRTC worker render process ${reason}`))
        } else if (this.workerWin === win) {
          this.log.warn?.(`[webrtc-proxy] worker render process ${reason}; resetting worker`)
          cleanupWorker()
          this.activePeerIds.clear()
          this.clearIdleTimer()
          const sock = this.activeSocket
          const errMsg = `WebRTC worker crashed (${reason})`
          if (sock && !sock.destroyed) {
            for (const reqId of this.pendingReqIds) {
              try {
                sock.write(encodeJsonFrame({ type: 'res', reqId, ok: false, error: errMsg }))
              } catch {}
            }
          }
          this.pendingReqIds.clear()
          if (sock) {
            this.activeSocket = null
            try { sock.end() } catch {}
            const destroyTimer = setTimeout(() => {
              if (!sock.destroyed) {
                try { sock.destroy() } catch {}
              }
            }, 100)
            destroyTimer.unref?.()
          }
        }
      })

      win.once('closed', () => {
        clearTimeout(timer)
        this.ipcMain.removeListener('webrtc-worker:control', onReady)
        if (!settled) {
          settled = true
          if (this.workerWin === win) this.workerWin = null
          if (this.workerReadyPromise === readyPromise) this.workerReadyPromise = null
          rejectReady(new Error('WebRTC worker closed before ready'))
          return
        }
        if (this.workerWin === win) {
          this.workerWin = null
          if (this.workerReadyPromise === readyPromise) {
            this.workerReadyPromise = null
          }
        }
      })
      win.loadFile(join(this.srcDir, 'webrtc-worker.html')).catch((err) => {
        failOnce(err)
      })
    })
    this.workerReadyPromise = readyPromise

    return readyPromise
  }

  handleWorkerControl(msg, ev = null) {
    if (!msg || msg.type === 'worker.ready') return
    if (ev?.sender && (!this.workerWin || this.workerWin.isDestroyed() || ev.sender !== this.workerWin.webContents)) {
      return
    }
    if (msg.type === 'res' && msg.reqId) {
      this.pendingReqIds.delete(msg.reqId)
    }
    const isPeerClosed =
      ((msg.type === 'state' || msg.type === 'iceState') && (msg.state === 'closed' || msg.state === 'failed')) ||
      (msg.type === 'dc.close' && msg.role === 'ctrl')
    if (isPeerClosed && msg.peerId) {
      this.activePeerIds.delete(msg.peerId)
      if (this.activePeerIds.size === 0) this.scheduleIdleDestroy()
    }
    if (this.activeSocket && !this.activeSocket.destroyed) {
      try {
        this.activeSocket.write(encodeJsonFrame(msg))
      } catch {}
    }
  }

  handleWorkerBinary(payload, ev = null) {
    if (!payload?.bytes || !this.activeSocket || this.activeSocket.destroyed) return
    if (ev?.sender && (!this.workerWin || this.workerWin.isDestroyed() || ev.sender !== this.workerWin.webContents)) {
      return
    }
    try {
      this.activeSocket.write(encodeBinFrame(payload.peerId, payload.role, payload.bytes))
    } catch {}
  }

  handleClientSocket(socket) {
    socket.setNoDelay(true)
    let authed = false
    let buf = Buffer.alloc(0)
    let frameQueue = Promise.resolve()
    let queuedFrameBytes = 0
    let socketPaused = false
    const MAX_QUEUED_FRAME_BYTES = 4 * 1024 * 1024
    const RESUME_QUEUED_FRAME_BYTES = 1 * 1024 * 1024

    let authTimer = setTimeout(() => {
      authTimer = null
      if (!authed && !socket.destroyed) {
        try { socket.destroy() } catch {}
      }
    }, AUTH_TIMEOUT_MS)
    authTimer.unref?.()
    const clearAuthTimer = () => {
      if (authTimer) {
        clearTimeout(authTimer)
        authTimer = null
      }
    }

    const processFrame = async (kind, payload) => {
      if (socket.destroyed) return
      if (!authed) {
        if (kind !== FRAME_JSON) {
          clearAuthTimer()
          socket.destroy()
          return
        }
        let msg
        try { msg = JSON.parse(payload.toString('utf8')) } catch { clearAuthTimer(); socket.destroy(); return }
        const cand = Buffer.from(String(msg?.token || ''), 'utf8')
        if (cand.length !== this.tokenBuf.length || !timingSafeEqual(cand, this.tokenBuf)) {
          clearAuthTimer()
          socket.destroy()
          return
        }
        clearAuthTimer()
        authed = true
        if (this.activeSocket && this.activeSocket !== socket) {
          const prevSocket = this.activeSocket
          this.activePeerIds.clear()
          this.pendingReqIds.clear()
          if (this.workerWin && !this.workerWin.isDestroyed()) {
            try { this.workerWin.webContents.send('webrtc-worker:cmd', { type: 'peer.closeAll' }) } catch {}
          }
          this.scheduleIdleDestroy()
          try { prevSocket.destroy() } catch {}
        }
        this.activeSocket = socket
        socket.write(encodeJsonFrame({ type: 'auth.ok' }))
        return
      }

      if (kind === FRAME_JSON) {
        let cmd
        try { cmd = JSON.parse(payload.toString('utf8')) } catch { return }
        const isCreatingCmd = cmd.type === 'peer.offer'
        if (isCreatingCmd && cmd.peerId) {
          this.activePeerIds.add(cmd.peerId)
          this.clearIdleTimer()
        } else if (cmd.type === 'peer.close' && cmd.peerId) {
          this.activePeerIds.delete(cmd.peerId)
        } else if (cmd.type === 'peer.closeAll') {
          this.activePeerIds.clear()
        }

        // Never cold-start a hidden Chromium worker (or cancel idle destroy!) for non-creating commands
        if (!isCreatingCmd) {
          if (!this.workerWin || this.workerWin.isDestroyed()) {
            if (cmd.reqId && !socket.destroyed) {
              socket.write(encodeJsonFrame({ type: 'res', reqId: cmd.reqId, ok: true }))
            }
            return
          }
          if (cmd.reqId) {
            this.pendingReqIds.add(cmd.reqId)
          }
          try {
            const win = this.workerReadyPromise ? await this.workerReadyPromise : this.workerWin
            if (win && !win.isDestroyed()) {
              win.webContents.send('webrtc-worker:cmd', cmd)
            } else if (cmd.reqId) {
              this.pendingReqIds.delete(cmd.reqId)
              if (!socket.destroyed) {
                socket.write(encodeJsonFrame({ type: 'res', reqId: cmd.reqId, ok: true }))
              }
            }
          } catch (err) {
            if (cmd.reqId) {
              this.pendingReqIds.delete(cmd.reqId)
              if (!socket.destroyed) {
                socket.write(encodeJsonFrame({ type: 'res', reqId: cmd.reqId, ok: false, error: String(err?.message || err) }))
              }
            }
          }
          if ((cmd.type === 'peer.close' || cmd.type === 'peer.closeAll') && this.activePeerIds.size === 0) {
            this.scheduleIdleDestroy()
          }
          return
        }

        if (cmd.reqId) {
          this.pendingReqIds.add(cmd.reqId)
        }
        try {
          const win = await this.ensureWorker()
          if (win.isDestroyed()) {
            throw new Error('WebRTC worker destroyed before command dispatch')
          }
          win.webContents.send('webrtc-worker:cmd', cmd)
        } catch (err) {
          if (cmd.reqId) {
            this.pendingReqIds.delete(cmd.reqId)
          }
          if (cmd.type === 'peer.offer' && cmd.peerId) {
            this.activePeerIds.delete(cmd.peerId)
            if (this.activePeerIds.size === 0) this.scheduleIdleDestroy()
          }
          if (cmd.reqId && !socket.destroyed) {
            socket.write(encodeJsonFrame({ type: 'res', reqId: cmd.reqId, ok: false, error: String(err?.message || err) }))
          }
        }
        return
      }

      if (kind === FRAME_BIN) {
        if (payload.length < 3) return
        const pidLen = payload[0]
        if (payload.length < 2 + pidLen) return
        const peerId = payload.subarray(1, 1 + pidLen).toString('utf8')
        const role = payload[1 + pidLen] === 1 ? 'bulk' : 'ctrl'
        const bytes = Buffer.from(payload.subarray(2 + pidLen))
        if (this.workerWin && !this.workerWin.isDestroyed()) {
          this.workerWin.webContents.send('webrtc-worker:send-binary', { peerId, role, bytes })
        }
      }
    }

    socket.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0)
        if (len <= 0 || len > 16 * 1024 * 1024) {
          socket.destroy()
          return
        }
        if (buf.length < 4 + len) break
        const kind = buf[4]
        const payload = Buffer.from(buf.subarray(5, 4 + len))
        const frameBytes = payload.length
        buf = buf.subarray(4 + len)
        queuedFrameBytes += frameBytes
        if (!socketPaused && queuedFrameBytes >= MAX_QUEUED_FRAME_BYTES) {
          socketPaused = true
          try { socket.pause() } catch {}
        }
        frameQueue = frameQueue
          .then(() => processFrame(kind, payload))
          .catch((err) => {
            this.log.warn?.(`[webrtc-proxy] frame error: ${String(err?.message || err)}`)
          })
          .finally(() => {
            queuedFrameBytes = Math.max(0, queuedFrameBytes - frameBytes)
            if (socketPaused && queuedFrameBytes <= RESUME_QUEUED_FRAME_BYTES && !socket.destroyed) {
              socketPaused = false
              try { socket.resume() } catch {}
            }
          })
      }
    })

    socket.on('close', () => {
      clearAuthTimer()
      if (this.activeSocket === socket) {
        this.activeSocket = null
        this.activePeerIds.clear()
        this.pendingReqIds.clear()
        if (this.workerWin && !this.workerWin.isDestroyed()) {
          try { this.workerWin.webContents.send('webrtc-worker:cmd', { type: 'peer.closeAll' }) } catch {}
        }
        this.scheduleIdleDestroy()
      }
    })
    socket.on('error', () => {
      clearAuthTimer()
      try { socket.destroy() } catch {}
    })
  }

  async dispose() {
    this.disposed = true
    this.clearIdleTimer()
    this.activePeerIds.clear()
    this.pendingReqIds.clear()
    this.ipcMain.removeListener('webrtc-worker:control', this._onWorkerControl)
    this.ipcMain.removeListener('webrtc-worker:binary', this._onWorkerBinary)
    if (this.activeSocket) {
      try { this.activeSocket.destroy() } catch {}
      this.activeSocket = null
    }
    if (this.workerWin && !this.workerWin.isDestroyed()) {
      try { this.workerWin.destroy() } catch {}
      this.workerWin = null
    }
    if (this.server) {
      await new Promise((r) => {
        try { this.server.close(() => r()) } catch { r() }
      })
      this.server = null
    }
  }
}
