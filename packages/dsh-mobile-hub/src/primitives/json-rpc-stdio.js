import { killProcessTree, spawnCrossPlatform } from '../helpers/bin-finder.js'

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024 // 16 MB safety cap against rogue stdout lines

/**
 * Shared NDJSON JSON-RPC 2.0 / ACP stdio transport client.
 * Replaces duplicated stdio RPC clients across Codex, Antigravity, and WorkBuddy ACP setup.
 *
 * Guarantees:
 *  - Bounded stdout line accumulation (`maxLineBytes`) to prevent OOM
 *  - Bounded stderr ring buffer (`maxStderrChars`)
 *  - `.unref()` on all RPC / close timers so Bridge exits cleanly
 *  - Sliding timeout support for long streaming turns
 *  - Cross-platform process-tree teardown via `killProcessTree`
 */
export class JsonRpcStdioClient {
  constructor({
    bin,
    args = [],
    cwd = undefined,
    env = undefined,
    label = 'rpc',
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    maxStderrChars = 4096,
    log = console,
    onNotification = null,
    onServerRequest = null,
    onNonJsonLine = null,
    onStderrChunk = null,
    onExit = null,
  }) {
    this.bin = bin
    this.args = Array.isArray(args) ? args : []
    this.cwd = cwd
    this.env = env
    this.label = label
    this.maxLineBytes = Math.max(64 * 1024, Math.floor(Number(maxLineBytes) || DEFAULT_MAX_LINE_BYTES))
    this.maxStderrChars = Math.max(512, Math.floor(Number(maxStderrChars) || 4096))
    this.log = log
    this.onNotification = onNotification
    this.onServerRequest = onServerRequest
    this.onNonJsonLine = onNonJsonLine
    this.onStderrChunk = onStderrChunk
    this.onExit = onExit

    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.stdoutBuf = ''
    this.droppingOversizedLine = false
    this.stderrTail = ''
    this.closing = false
  }

  isAlive() {
    return Boolean(this.proc && !this.proc.killed && !this.closing && this.proc.stdin?.writable)
  }

  setNotificationHandler(fn) {
    this.onNotification = fn || null
  }

  setServerRequestHandler(fn) {
    this.onServerRequest = fn || null
  }

  touchSlidingTimeouts() {
    for (const [id, p] of this.pending.entries()) {
      if (!p.sliding || !p.timeoutMs) continue
      clearTimeout(p.timer)
      p.timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        p.reject(new Error(`${this.label} RPC "${p.method}" 长时间无响应超时`))
      }, p.timeoutMs)
      p.timer.unref?.()
    }
  }

  spawnProcess() {
    if (this.proc && !this.proc.killed) return this.proc
    this.closing = false
    this.stdoutBuf = ''
    this.droppingOversizedLine = false
    this.stderrTail = ''

    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(this.env ? { env: this.env } : {}),
    }
    const proc = spawnCrossPlatform(this.bin, this.args, spawnOpts)
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdin?.on('error', () => {})

    proc.stdout.on('data', (chunk) => {
      if (this.proc !== proc) return
      const text = String(chunk || '')
      if (this.droppingOversizedLine) {
        const nl = text.indexOf('\n')
        if (nl === -1) return
        this.droppingOversizedLine = false
        this.stdoutBuf = text.slice(nl + 1)
      } else {
        this.stdoutBuf += text
      }

      let idx
      while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
        const line = this.stdoutBuf.slice(0, idx).trim()
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
        if (line) this.handleLine(line)
      }

      if (this.stdoutBuf.length > this.maxLineBytes) {
        this.log.warn?.(`mobile-hub: ${this.label} stdout line exceeded ${this.maxLineBytes} chars; dropping oversized frame`)
        this.stdoutBuf = ''
        this.droppingOversizedLine = true
      }
    })

    proc.stderr?.on('data', (chunk) => {
      if (this.proc !== proc) return
      const text = String(chunk || '')
      this.stderrTail = `${this.stderrTail}${text}`.slice(-this.maxStderrChars)
      try {
        this.onStderrChunk?.(text)
      } catch {}
    })

    proc.on('error', (err) => {
      if (this.proc !== proc) return
      if (!this.closing) {
        this.log.error?.(`mobile-hub: ${this.label} process error: ${String(err?.message || err)}`)
      }
      this.proc = null
      this.failAll(err)
      try {
        this.onExit?.({ code: null, signal: null, error: err, stderrTail: this.stderrTail }, this)
      } catch {}
    })

    proc.on('close', (code, signal) => {
      if (this.proc !== proc) return
      const tail = this.droppingOversizedLine ? '' : this.stdoutBuf.trim()
      this.stdoutBuf = ''
      this.droppingOversizedLine = false
      if (tail) this.handleLine(tail)
      if (!this.closing) {
        this.log.warn?.(`mobile-hub: ${this.label} exited (code=${code}, signal=${signal})`)
      }
      const stderrHint = !this.closing && this.stderrTail.trim()
        ? ` — ${this.stderrTail.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 240)}`
        : ''
      const err = new Error(`${this.label} exited (code=${code}${signal ? `, signal=${signal}` : ''})${stderrHint}`)
      this.proc = null
      this.failAll(err)
      try {
        this.onExit?.({ code, signal, error: err, stderrTail: this.stderrTail }, this)
      } catch (cbErr) {
        this.log.error?.(`mobile-hub: ${this.label} onExit error: ${String(cbErr)}`)
      }
    })

    return proc
  }

  handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      try {
        this.onNonJsonLine?.(line)
      } catch {}
      return
    }
    if (!msg || typeof msg !== 'object') return

    // Response to an outbound request
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) {
        const errMsg = msg.error?.data?.details || msg.error?.message || JSON.stringify(msg.error)
        const err = new Error(errMsg)
        if (msg.error?.code !== undefined) err.rpcCode = msg.error.code
        p.reject(err)
      } else {
        p.resolve(msg.result)
      }
      return
    }

    // Server-to-client request
    if (msg.id !== undefined && msg.method) {
      this.touchSlidingTimeouts()
      if (this.onServerRequest) {
        this.onServerRequest(this, msg)
      } else {
        try {
          this.sendRaw({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Unsupported serverRequest on ${this.label}: ${msg.method}` },
          })
        } catch {}
      }
      return
    }

    // Notification
    if (msg.method) {
      this.touchSlidingTimeouts()
      try {
        this.onNotification?.(msg.method, msg.params || {}, msg)
      } catch {}
    }
  }

  failAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  sendRaw(obj) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || !this.proc.stdin.writable) {
      throw new Error(`${this.label} is not running`)
    }
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  notify(method, params = {}) {
    try {
      this.sendRaw({ jsonrpc: '2.0', method, params })
      return true
    } catch {
      return false
    }
  }

  callRaw(method, params = {}, timeoutMs = 45_000, { sliding = false } = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        rejectPromise(new Error(`${this.label} RPC "${method}" timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
        method,
        timeoutMs,
        sliding,
      })
      try {
        this.sendRaw({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        rejectPromise(err)
      }
    })
  }

  async closeGracefully({ graceMs = 500, forceAfterMs = 450, preClose = null } = {}) {
    this.closing = true
    const proc = this.proc
    if (!proc) return
    if (typeof preClose === 'function') {
      try { await preClose() } catch {}
    }
    if (this.proc !== proc || proc.exitCode !== null || proc.signalCode !== null) return
    await new Promise((resolveDone) => {
      let settled = false
      let forceTimer = null
      let doneTimer = null
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        if (forceTimer) clearTimeout(forceTimer)
        if (doneTimer) clearTimeout(doneTimer)
        resolveDone()
      }
      proc.once('close', finish)
      const killTimer = setTimeout(() => {
        killProcessTree(proc, { force: false })
        forceTimer = setTimeout(() => {
          killProcessTree(proc, { force: true })
          doneTimer = setTimeout(finish, 150)
          doneTimer.unref?.()
        }, forceAfterMs)
        forceTimer.unref?.()
      }, graceMs)
      killTimer.unref?.()
      try {
        proc.stdin?.end()
      } catch {
        killProcessTree(proc, { force: true })
        finish()
      }
    })
  }

  killImmediate(reason = '') {
    this.closing = true
    const proc = this.proc
    this.proc = null
    if (proc) {
      killProcessTree(proc, { force: true })
    }
    this.failAll(new Error(reason || `${this.label} disposed`))
  }
}
