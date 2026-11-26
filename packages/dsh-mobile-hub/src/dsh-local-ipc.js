/**
 * Secure Localhost-Only IPC Bridge between DeepSeek Harness (Cordis runtime)
 * and All in One Desktop App / Portable Bridge (`ctx === null`).
 *
 * Security invariants:
 *  - Strictly binds `127.0.0.1` on an OS-assigned ephemeral port (`0`).
 *  - Requires a 256-bit cryptographically random Bearer token stored in
 *    `~/.dsh/allinone-dsh-ipc.json` with `0600` permissions.
 *  - Rejects every request carrying a browser `Origin` header (anti-DNS-rebinding / anti-CSWSH).
 *  - Uses ONLY Node.js built-ins (`node:http`, `node:crypto`, `node:fs`) — zero external deps.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isPidAlive } from './primitives/io-utils.js'

const IPC_FILE_NAME = 'allinone-dsh-ipc.json'
const MAX_SSE_CLIENTS = 16
const IPC_BODY_READ_TIMEOUT_MS = 30_000
const ALLOWED_METHODS = new Set([
  'listModels',
  'listWorkspaces',
  'listSessions',
  'readSession',
  'createSession',
  'sendMessage',
  'interrupt',
  'listApprovals',
  'resolveApproval',
])

export function getDshIpcFilePath(dshHome = '') {
  const base = String(dshHome || process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  return join(base, IPC_FILE_NAME)
}

function safeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8')
  const bufB = Buffer.from(String(b || ''), 'utf8')
  if (bufA.length === 0 || bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024, timeoutMs = IPC_BODY_READ_TIMEOUT_MS) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let total = 0
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      const err = new Error('IPC request body timeout')
      err.code = 'ETIMEDOUT'
      rejectBody(err)
      req.destroy()
    }, timeoutMs)
    timer.unref?.()
    const finish = (err, val) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) rejectBody(err)
      else resolveBody(val)
    }
    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > maxBytes) {
        finish(new Error('IPC request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        finish(null, raw ? JSON.parse(raw) : {})
      } catch (err) {
        finish(err)
      }
    })
    req.on('error', (err) => finish(err))
  })
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Start the localhost IPC server inside DeepSeek Harness (`ctx !== null`).
 */
export async function startDshLocalIpcServer({ dshAdapter, dshHome = '', log = console } = {}) {
  if (!dshAdapter) throw new Error('startDshLocalIpcServer requires dshAdapter')
  const ipcFile = getDshIpcFilePath(dshHome)
  const token = randomBytes(32).toString('hex')
  const sseClients = new Set()
  let boundPort = 0

  const isAuthorized = (req) => {
    const auth = String(req.headers.authorization || '').trim()
    if (!auth.startsWith('Bearer ')) return false
    return safeTokenEqual(auth.slice(7).trim(), token)
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Anti-DNS-rebinding & anti-browser CSRF: reject Origin, browser Sec-Fetch-Site, and non-loopback Host headers
      if (req.headers.origin) {
        sendJson(res, 403, { ok: false, error: 'Browser origins are not allowed on local DSH IPC' })
        return
      }
      const secFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase()
      if (secFetchSite && secFetchSite !== 'none') {
        sendJson(res, 403, { ok: false, error: 'Browser cross-site requests are not allowed on local DSH IPC' })
        return
      }
      const activePort = boundPort || (typeof server.address() === 'object' ? server.address()?.port : 0) || 0
      const hostHeader = String(req.headers.host || '').trim().toLowerCase()
      const allowedHosts = new Set([
        `127.0.0.1:${activePort}`,
        `localhost:${activePort}`,
        `[::1]:${activePort}`,
      ])
      if (!activePort || !allowedHosts.has(hostHeader)) {
        sendJson(res, 403, { ok: false, error: 'Invalid Host header on local DSH IPC' })
        return
      }
      if (!isAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' })
        return
      }

      let urlObj
      try {
        urlObj = new URL(req.url || '/', 'http://127.0.0.1')
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid request URL' })
        return
      }
      const pathname = urlObj.pathname

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          writable: Boolean(dshAdapter.isLive?.()),
          activeCount: Number(dshAdapter.activeTurns?.size || 0),
        })
        return
      }

      if (req.method === 'GET' && pathname === '/events') {
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          sendJson(res, 429, { ok: false, error: 'Too many SSE clients connected' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write(': connected\n\n')
        sseClients.add(res)
        const cleanup = () => {
          sseClients.delete(res)
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
        res.on('error', cleanup)
        return
      }

      if (req.method === 'POST' && pathname === '/rpc') {
        try {
          const body = await readJsonBody(req)
          const method = String(body?.method || '').trim()
          const params = body?.params ?? {}
          if (!ALLOWED_METHODS.has(method)) {
            sendJson(res, 400, { ok: false, error: `Unsupported DSH IPC method: ${method}` })
            return
          }
          let result
          if (method === 'listModels') {
            result = await dshAdapter.listModels()
          } else if (method === 'listWorkspaces') {
            result = await dshAdapter.listWorkspaces()
          } else if (method === 'listSessions') {
            result = await dshAdapter.listSessions(params)
          } else if (method === 'readSession') {
            result = await dshAdapter.readSession(params.sessionId, params.options || {})
          } else if (method === 'createSession') {
            result = await dshAdapter.createSession(params)
          } else if (method === 'sendMessage') {
            result = await dshAdapter.sendMessage(params.sessionId, params.payload || {})
          } else if (method === 'interrupt') {
            result = await dshAdapter.interrupt(params.sessionId)
          } else if (method === 'listApprovals') {
            result = typeof dshAdapter.listPendingApprovals === 'function'
              ? await dshAdapter.listPendingApprovals()
              : []
          } else if (method === 'resolveApproval') {
            const payload = params.answers && typeof params.answers === 'object'
              ? { decision: params.decision, answers: params.answers }
              : params.decision
            result = typeof dshAdapter.resolveApproval === 'function'
              ? await dshAdapter.resolveApproval(params.id, payload)
              : { resolved: false, reason: 'resolveApproval not supported' }
          }
          if (!res.headersSent) {
            sendJson(res, 200, { ok: true, result })
          }
        } catch (err) {
          if (!res.headersSent) {
            const statusCode = err instanceof SyntaxError ? 400 : 500
            sendJson(res, statusCode, {
              ok: false,
              error: String(err?.message || err),
              ...(err?.code ? { code: String(err.code) } : {}),
              ...(err?._streamErrorEmitted ? { streamErrorEmitted: true } : {}),
            })
          }
        }
        return
      }

      sendJson(res, 404, { ok: false, error: 'Not Found' })
    } catch (err) {
      log.warn?.(`mobile-hub: DSH local IPC handler error: ${String(err?.message || err)}`)
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) })
        } catch {}
      } else {
        try { res.end() } catch {}
      }
    }
  })

  // Keep long-running agentic RPCs alive (up to 35 minutes)
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 65_000

  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n')
      } catch {
        sseClients.delete(client)
      }
    }
  }, 20_000)
  heartbeat.unref?.()

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  boundPort = port

  try {
    const ipcDir = dirname(ipcFile)
    mkdirSync(ipcDir, { recursive: true, mode: 0o700 })
    try { chmodSync(ipcDir, 0o700) } catch {}
    const payload = JSON.stringify(
      {
        port,
        token,
        pid: process.pid,
        startedAt: Date.now(),
      },
      null,
      2,
    )
    const tmpFile = `${ipcFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(tmpFile, payload, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(tmpFile, 0o600) } catch {}
    try {
      renameSync(tmpFile, ipcFile)
    } catch (renameErr) {
      try { unlinkSync(tmpFile) } catch {}
      throw renameErr
    }
    try { chmodSync(ipcFile, 0o600) } catch {}
  } catch (err) {
    log.warn?.(`mobile-hub: failed to write DSH IPC descriptor ${ipcFile}: ${String(err)}`)
  }

  log.info?.(`mobile-hub: DSH local IPC listening on 127.0.0.1:${port} (authenticated loopback)`)

  function emitEvent(event, payload) {
    if (sseClients.size === 0) return
    const frame = `data: ${JSON.stringify({ event, payload })}\n\n`
    for (const client of sseClients) {
      try {
        client.write(frame)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  async function close() {
    clearInterval(heartbeat)
    for (const client of sseClients) {
      try { client.end() } catch {}
    }
    sseClients.clear()
    try {
      if (existsSync(ipcFile)) {
        const cur = JSON.parse(readFileSync(ipcFile, 'utf8'))
        if (cur?.pid === process.pid) {
          unlinkSync(ipcFile)
        }
      }
    } catch {}
    await new Promise((resolveClose) => {
      try {
        server.closeAllConnections?.()
      } catch {}
      server.close(() => resolveClose())
    })
  }

  return { port, token, ipcFile, emitEvent, close }
}

const IPC_TRANSPORT_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND'])

/**
 * Local IPC client used by standalone / Desktop App `DshAdapter` (`ctx === null`)
 * to seamlessly control a running DeepSeek Harness instance on the same machine.
 */
export class DshLocalIpcClient {
  constructor({ dshHome = '', emitEvent = () => {}, log = console } = {}) {
    this.ipcFile = getDshIpcFilePath(dshHome)
    this.emitEvent = emitEvent
    this.log = log
    this.cachedEndpoint = null // { port, token, pid, checkedAt, ok, activeCount }
    this.sseReq = null
    this.sseEndpointKey = ''
    this.sseReadyPromise = null
    this.sseReconnectTimer = null
    this.sseReconnectAttempt = 0
    /** @type {Set<import('node:http').ClientRequest>} */
    this.inFlightReqs = new Set()
    this.disposed = false
  }

  readDescriptor() {
    if (!existsSync(this.ipcFile)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.ipcFile, 'utf8'))
      const port = Number(parsed?.port)
      const token = String(parsed?.token || '').trim()
      const pid = Number(parsed?.pid)
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) return null
      if (pid && !isPidAlive(pid)) return null
      return { port, token, pid }
    } catch {
      return null
    }
  }

  async checkHealth({ force = false } = {}) {
    if (this.disposed) return null
    const desc = this.readDescriptor()
    if (!desc) {
      this.cachedEndpoint = null
      this.closeSse()
      return null
    }
    const now = Date.now()
    if (
      !force &&
      this.cachedEndpoint &&
      this.cachedEndpoint.port === desc.port &&
      this.cachedEndpoint.token === desc.token &&
      this.cachedEndpoint.ok &&
      now - this.cachedEndpoint.checkedAt < 2500
    ) {
      this.ensureSse(desc)
      return this.cachedEndpoint
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 700)
      try {
        const res = await fetch(`http://127.0.0.1:${desc.port}/health`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${desc.token}` },
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!data?.ok || !data?.writable) throw new Error('not writable')
        this.cachedEndpoint = {
          ...desc,
          checkedAt: Date.now(),
          ok: true,
          activeCount: Number(data.activeCount || 0),
        }
        this.ensureSse(desc)
        return this.cachedEndpoint
      } finally {
        clearTimeout(timer)
      }
    } catch {
      this.cachedEndpoint = null
      this.closeSse()
      return null
    }
  }

  clearSseReconnectTimer() {
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer)
      this.sseReconnectTimer = null
    }
  }

  scheduleSseReconnect() {
    if (this.disposed || this.sseReconnectTimer) return
    const delayMs = Math.min(30_000, 1_000 * Math.pow(2, Math.min(this.sseReconnectAttempt, 5)))
    this.sseReconnectAttempt += 1
    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null
      if (this.disposed) return
      const freshDesc = this.readDescriptor()
      if (freshDesc) {
        void this.ensureSse(freshDesc)
      } else {
        this.scheduleSseReconnect()
      }
    }, delayMs)
    this.sseReconnectTimer.unref?.()
  }

  ensureSse(desc) {
    if (this.disposed || !desc) return Promise.resolve(false)
    this.clearSseReconnectTimer()
    const key = `${desc.port}:${desc.token}`
    if (this.sseReq && this.sseEndpointKey === key) {
      return this.sseReadyPromise || Promise.resolve(true)
    }
    this.closeSse()
    this.sseEndpointKey = key

    let resolveReady = () => {}
    this.sseReadyPromise = new Promise((r) => {
      resolveReady = r
    })

    let req = null
    const handleDrop = () => {
      if (this.sseReq !== req) return
      this.sseReq = null
      this.sseEndpointKey = ''
      this.sseReadyPromise = null
      if (!this.disposed) {
        this.scheduleSseReconnect()
      }
    }

    const readyTimeout = setTimeout(() => {
      resolveReady(false)
      if (this.sseReq === req) {
        const staleReq = req
        this.sseReq = null
        this.sseEndpointKey = ''
        this.sseReadyPromise = null
        try { staleReq?.destroy() } catch {}
        if (!this.disposed) {
          this.scheduleSseReconnect()
        }
      }
    }, 1200)
    readyTimeout.unref?.()

    req = http.request(
      {
        hostname: '127.0.0.1',
        port: desc.port,
        path: '/events',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${desc.token}`,
          Accept: 'text/event-stream',
        },
      },
      (res) => {
        if (this.disposed || this.sseReq !== req) {
          clearTimeout(readyTimeout)
          resolveReady(false)
          res.destroy()
          return
        }
        clearTimeout(readyTimeout)
        if (res.statusCode !== 200) {
          res.resume()
          resolveReady(false)
          handleDrop()
          return
        }
        this.sseReconnectAttempt = 0
        resolveReady(true)
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (this.disposed || this.sseReq !== req) return
          buf += chunk
          let sep
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            const dataLines = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
            if (dataLines.length === 0) continue
            try {
              const parsed = JSON.parse(dataLines.join('\n'))
              if (parsed?.event) {
                this.emitEvent(parsed.event, parsed.payload)
              }
            } catch {}
          }
        })
        res.on('end', handleDrop)
        res.on('close', handleDrop)
        res.on('error', handleDrop)
      },
    )
    req.setTimeout(0)
    req.on('error', () => {
      clearTimeout(readyTimeout)
      resolveReady(false)
      handleDrop()
    })
    req.end()
    this.sseReq = req
    return this.sseReadyPromise
  }

  closeSse() {
    this.clearSseReconnectTimer()
    const req = this.sseReq
    this.sseReq = null
    this.sseEndpointKey = ''
    this.sseReadyPromise = null
    if (req) {
      try { req.destroy() } catch {}
    }
  }

  async call(method, params = {}, { timeoutMs = 30_000, waitForEvents = false } = {}) {
    const endpoint = await this.checkHealth()
    if (!endpoint) {
      throw new Error('DSH local IPC is not available')
    }
    if (waitForEvents) {
      await this.ensureSse(endpoint)
    }

    const bodyBuf = Buffer.from(JSON.stringify({ method, params }), 'utf8')
    try {
      return await new Promise((resolveCall, rejectCall) => {
        let settled = false
        let timer = null
        let req = null
        const finishResolve = (val) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          if (req) this.inFlightReqs.delete(req)
          resolveCall(val)
        }
        const finishReject = (err) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          if (req) this.inFlightReqs.delete(req)
          rejectCall(err)
        }

        if (this.disposed) {
          finishReject(new Error('DSH IPC client disposed'))
          return
        }

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            const err = new Error(`DSH IPC call ${method} timed out (${timeoutMs}ms)`)
            err.code = 'ETIMEDOUT'
            try { req?.destroy(err) } catch {}
            finishReject(err)
          }, timeoutMs)
          timer.unref?.()
        }

        req = http.request(
          {
            hostname: '127.0.0.1',
            port: endpoint.port,
            path: '/rpc',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': bodyBuf.length,
              Authorization: `Bearer ${endpoint.token}`,
            },
          },
          (res) => {
            res.setEncoding('utf8')
            let raw = ''
            res.on('data', (chunk) => { raw += chunk })
            res.on('end', () => {
              let data = {}
              try {
                data = raw ? JSON.parse(raw) : {}
              } catch {}
              if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300 || !data?.ok) {
                const err = new Error(data?.error || `DSH IPC call ${method} failed (HTTP ${res.statusCode || 0})`)
                if (data?.code) err.code = String(data.code)
                if (data?.streamErrorEmitted) err._streamErrorEmitted = true
                finishReject(err)
                return
              }
              finishResolve(data.result)
            })
            res.on('error', finishReject)
          },
        )
        this.inFlightReqs.add(req)
        // Disable Node's default socket idle timeout so long-running agentic turns (>5 min) obey ONLY caller timeoutMs
        req.setTimeout(0)
        req.on('error', finishReject)
        req.end(bodyBuf)
      })
    } catch (err) {
      // Only invalidate cached endpoint & SSE on genuine connection errors (never on RPC/application errors or timeouts)
      if (IPC_TRANSPORT_ERROR_CODES.has(err?.code)) {
        this.cachedEndpoint = null
        this.closeSse()
      }
      throw err
    }
  }

  dispose() {
    this.disposed = true
    this.clearSseReconnectTimer()
    this.closeSse()
    for (const req of [...this.inFlightReqs]) {
      try { req.destroy(new Error('DSH IPC client disposed')) } catch {}
    }
    this.inFlightReqs.clear()
    this.cachedEndpoint = null
  }
}
