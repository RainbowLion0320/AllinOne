import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { APPS, EVENTS, assertSafeSessionId, makeCompositeId, toEpochMs } from '../protocol.js'
import { mergeAndCompactMessages } from '../helpers/history-normalize.js'
import { findExecutable, isExecutableFile, spawnCrossPlatform } from '../helpers/bin-finder.js'

/**
 * Fallback discovery on macOS/Linux: if Codex Desktop / ChatGPT app is currently running
 * from a custom or newly reorganized app bundle path, extract the live `codex` binary path.
 */
function findRunningCodexBinary() {
  if (process.platform === 'win32') return null
  try {
    const out = execFileSync('ps', ['-axo', 'command='], {
      timeout: 1200,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const rawLine of out.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || !/codex/i.test(line)) continue
      // Match an absolute path ending with `/codex` followed by space + args (e.g. `app-server`, `exec-server`)
      const m = line.match(/^(\/[^\0\n]*?\/codex)(?:\s|$)/)
      if (m && m[1] && isExecutableFile(m[1])) {
        return m[1]
      }
    }
  } catch {}
  return null
}

function findCodexBinary(configuredBin) {
  const home = homedir()
  const candidates = [
    configuredBin,
    process.env.CODEX_BIN,
    join(home, '.codex', '.sandbox-bin', 'codex.exe'),
    join(home, '.codex', '.sandbox-bin', 'codex'),
  ]
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'),
      join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
      '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'),
      join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
      join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
      '/Applications/Codex.app/Contents/Resources/bin/codex',
      join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'bin', 'codex'),
    )
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    const localApp = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    candidates.push(
      join(appData, 'npm', 'codex.cmd'),
      join(appData, 'npm', 'codex.exe'),
      join(localApp, 'Programs', 'ChatGPT', 'resources', 'codex-cli', 'codex.exe'),
      join(localApp, 'Programs', 'Codex', 'resources', 'codex.exe'),
    )
  }
  return (
    findExecutable(process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'], candidates) ||
    findRunningCodexBinary() ||
    'codex'
  )
}

function normalizeThreadSummary(t) {
  const title = (t.name && t.name.trim()) || (t.preview && t.preview.trim().slice(0, 56)) || t.id
  const cwd = typeof t.cwd === 'string' ? t.cwd : ''
  const rawStatus = typeof t.status === 'string'
    ? t.status
    : t.status?.type || 'idle'
  const isRunning = rawStatus === 'active' || rawStatus === 'running' || rawStatus === 'inProgress'

  return {
    id: makeCompositeId(APPS.CODEX, t.id),
    app: APPS.CODEX,
    nativeId: t.id,
    title,
    preview: (t.preview || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    cwd,
    workspace: cwd ? basename(cwd) : '',
    model: t.model || '',
    status: isRunning ? 'running' : 'idle',
    writable: true,
    createdAt: toEpochMs(t.createdAt),
    updatedAt: toEpochMs(t.updatedAt || t.recencyAt || t.createdAt),
  }
}

export function normalizeCodexTurns(turns = []) {
  const messages = []
  let milestoneEpoch = 0
  for (const turn of turns) {
    let currentAssistant = null
    const ensureAssistant = (ts, fallbackId) => {
      if (!currentAssistant) {
        currentAssistant = {
          id: fallbackId || `cdx-a-${turn.id}-${messages.length}`,
          role: 'assistant',
          text: '',
          thinking: '',
          tools: [],
          branchEpoch: milestoneEpoch,
          ts: toEpochMs(ts || turn.startedAt || Date.now()),
        }
        messages.push(currentAssistant)
      }
      return currentAssistant
    }

    for (const item of turn.items || []) {
      const ts = toEpochMs(item.startedAtMs || item.completedAtMs || turn.startedAt || Date.now())
      if (item.type === 'userMessage') {
        currentAssistant = null
        const images = []
        const text = (item.content || [])
          .map((c) => {
            if (c.type === 'text') return c.text || ''
            if (c.type === 'localImage') {
              if (c.path) images.push({ path: c.path, name: basename(c.path) })
              return ''
            }
            if (c.type === 'image') {
              const u = c.url || c.image_url || c.imageUrl || ''
              if (u) images.push({ url: u, name: 'image' })
              return ''
            }
            if (c.type === 'mention') return `@${c.name || c.path || ''}`
            return ''
          })
          .filter(Boolean)
          .join('\n')
        if (text.trim().length > 0 || images.length > 0) {
          messages.push({
            id: item.id || `cdx-u-${messages.length}`,
            role: 'user',
            text,
            ...(images.length > 0 ? { images } : {}),
            ts,
          })
        }
      } else if (item.type === 'imageView') {
        if (item.path) {
          const a = ensureAssistant(ts, item.id)
          a.tools.push({
            id: item.id || `cdx-iv-${turn.id}-${a.tools.length}`,
            name: 'view_image',
            input: { path: item.path },
            status: 'completed',
            output: item.path,
          })
        }
      } else if (item.type === 'reasoning') {
        const a = ensureAssistant(ts, item.id)
        const parts = [...(item.summary || []), ...(item.content || [])].filter(Boolean)
        if (parts.length > 0) {
          a.thinking = a.thinking ? `${a.thinking}\n${parts.join('\n')}` : parts.join('\n')
        }
      } else if (item.type === 'agentMessage') {
        const a = ensureAssistant(ts, item.id)
        if (item.text) {
          a.text = a.text ? `${a.text}\n\n${item.text}` : item.text
          a.ts = ts || a.ts
          // Close this assistant milestone bubble so long autonomous multi-step runs render
          // each progress update chronologically with its preceding commands (matching Codex Desktop).
          milestoneEpoch += 1
          currentAssistant = null
        }
      } else if (item.type === 'commandExecution') {
        const a = ensureAssistant(ts)
        a.tools.push({
          id: item.id,
          name: 'command',
          input: { command: item.command, cwd: item.cwd },
          status: item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'error' : 'running',
          output: (item.aggregatedOutput || '').slice(0, 3000),
        })
      } else if (item.type === 'fileChange') {
        const a = ensureAssistant(ts)
        a.tools.push({
          id: item.id,
          name: 'file_change',
          input: { files: (item.changes || []).map((c) => c.path || c.file || 'file') },
          status: item.status === 'applied' || item.status === 'completed' ? 'completed' : 'running',
          output: `${(item.changes || []).length} 个文件变更`,
        })
      } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
        const a = ensureAssistant(ts)
        a.tools.push({
          id: item.id,
          name: item.server ? `${item.server}.${item.tool}` : item.tool || 'tool',
          input: item.arguments ?? {},
          status: item.error ? 'error' : 'completed',
          output: item.error
            ? JSON.stringify(item.error)
            : item.result
              ? JSON.stringify(item.result).slice(0, 2000)
              : '',
        })
      } else if (item.type === 'webSearch') {
        const a = ensureAssistant(ts)
        a.tools.push({
          id: item.id,
          name: 'web_search',
          input: { query: item.query || '' },
          status: 'completed',
          output: '',
        })
      }
    }
  }

  return messages.map((m) => {
    const out = { ...m }
    if (!out.thinking) delete out.thinking
    if (!out.tools || out.tools.length === 0) delete out.tools
    return out
  })
}

/**
 * Zero-OOM tail-seek fallback for giant / legacy Codex JSONL rollout files (even >2 GB)
 * when `codex app-server` fails to deserialize an older stored thread item across CLI upgrades.
 * Reads ONLY the tail `maxBytes` (default 2 MB) directly from disk in <5 ms.
 */
export function readCodexRolloutTail(rawPath, { maxBytes = 2 * 1024 * 1024, limit = 14 } = {}) {
  const cleanPath = String(rawPath || '').replace(/^\\\\\?\\/, '').trim()
  if (!cleanPath || !cleanPath.toLowerCase().endsWith('.jsonl') || !existsSync(cleanPath)) {
    return []
  }
  let fd = null
  try {
    fd = openSync(cleanPath, 'r')
    const totalSize = fstatSync(fd).size
    if (totalSize <= 0) return []
    const readLen = Math.min(totalSize, maxBytes)
    const startOffset = totalSize - readLen
    const buf = Buffer.alloc(readLen)
    readSync(fd, buf, 0, readLen, startOffset)
    const rawText = buf.toString('utf8')
    const lines = rawText.split(/\r?\n/)
    // Drop first partial line if we started mid-file
    if (startOffset > 0 && lines.length > 0) lines.shift()

    const messages = []
    let milestoneEpoch = 0
    let currentAssistant = null
    const ensureAssistant = (ts, idHint) => {
      if (!currentAssistant) {
        currentAssistant = {
          id: idHint || `cdx-tail-a-${messages.length}`,
          role: 'assistant',
          text: '',
          thinking: '',
          tools: [],
          branchEpoch: milestoneEpoch,
          ts: toEpochMs(ts || Date.now()),
        }
        messages.push(currentAssistant)
      }
      return currentAssistant
    }

    for (const line of lines) {
      if (!line || line[0] !== '{') continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const ts = toEpochMs(obj.timestamp || Date.now())
      if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
        const p = obj.payload
        if (p.type === 'message') {
          const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : ''
          if (!role) continue
          const text = (Array.isArray(p.content) ? p.content : [])
            .map((c) => (c?.type === 'output_text' || c?.type === 'input_text' || c?.type === 'text' ? c.text || '' : ''))
            .filter(Boolean)
            .join('\n')
            .trim()
          if (!text) continue
          if (role === 'user') {
            currentAssistant = null
            messages.push({ id: p.id || `cdx-tail-u-${messages.length}`, role: 'user', text, ts })
          } else {
            const a = ensureAssistant(ts, p.id)
            a.text = a.text ? `${a.text}\n\n${text}` : text
            a.ts = ts
            milestoneEpoch += 1
            currentAssistant = null
          }
        } else if (p.type === 'reasoning') {
          const summaries = (Array.isArray(p.summary) ? p.summary : [])
            .map((s) => (typeof s === 'string' ? s : s?.text || ''))
            .filter(Boolean)
          if (summaries.length > 0) {
            const a = ensureAssistant(ts, p.id)
            a.thinking = a.thinking ? `${a.thinking}\n${summaries.join('\n')}` : summaries.join('\n')
          }
        } else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
          const a = ensureAssistant(ts, p.call_id || p.id)
          a.tools.push({
            id: p.call_id || p.id || `cdx-tail-t-${a.tools.length}`,
            name: p.name || (p.type === 'local_shell_call' ? 'command' : 'tool'),
            input: p.input ?? p.arguments ?? p.action ?? {},
            status: 'completed',
            output: '',
          })
        }
      } else if (obj.type === 'event_msg' && obj.payload?.type === 'agent_message' && obj.payload?.message) {
        const a = ensureAssistant(ts)
        a.text = a.text ? `${a.text}\n\n${obj.payload.message}` : String(obj.payload.message)
        a.ts = ts
        milestoneEpoch += 1
        currentAssistant = null
      }
    }

    const compacted = mergeAndCompactMessages(messages)
    const sliceLen = Math.max(6, Math.min(Number(limit) || 14, 30))
    return compacted.slice(-sliceLen)
  } catch {
    return []
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * Lightweight JSON-RPC 2.0 client wrapping a single `codex app-server --stdio` subprocess.
 * Used in two distinct roles:
 *   1) A persistent read-only `reader` (never calls thread/start or thread/resume -> NEVER locks any thread!)
 *   2) Short-lived per-thread `writer` instances that gracefully exit after each turn finishes,
 *      immediately releasing Codex's single-writer thread lock so Codex Desktop on PC can continue seamlessly!
 */
class CodexRpcClient {
  constructor({ codexBin, log = console, label = 'codex', onServerRequest, onNotification, onExit }) {
    this.codexBin = codexBin
    this.log = log
    this.label = label
    this.onServerRequest = onServerRequest || null
    this.onNotification = onNotification || null
    this.onExit = onExit || null

    this.proc = null
    this.readyPromise = null
    this.nextRpcId = 1
    this.pendingRpc = new Map()
    this.stdoutBuf = ''
    this.stderrTail = ''
    this.closing = false
  }

  async ensureStarted() {
    if (this.proc && !this.proc.killed && this.readyPromise) {
      return this.readyPromise
    }

    this.closing = false
    this.stderrTail = ''
    this.readyPromise = new Promise((resolveReady, rejectReady) => {
      let proc
      try {
        proc = spawnCrossPlatform(this.codexBin, ['app-server', '--stdio'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        this.readyPromise = null
        rejectReady(err)
        return
      }

      this.proc = proc
      this.stdoutBuf = ''

      // Prevent uncaught EPIPE if the child exits while a JSON-RPC line is being written
      proc.stdin?.on('error', () => {})

      proc.stdout.on('data', (chunk) => {
        this.stdoutBuf += chunk.toString('utf8')
        let idx
        while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
          const line = this.stdoutBuf.slice(0, idx).trim()
          this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            this.handleMessage(msg)
          } catch {}
        }
      })

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8')
        this.stderrTail = `${this.stderrTail}${text}`.slice(-1200)
        const line = text.trim()
        if (line) this.log.debug?.(`[codex-${this.label}] ${line}`)
      })

      proc.on('error', (err) => {
        if (!this.closing) {
          this.log.error?.(`mobile-hub: codex(${this.label}) failed: ${String(err)}`)
        }
        this.cleanup(err)
        rejectReady(err)
      })

      proc.on('exit', (code, signal) => {
        if (!this.closing) {
          this.log.warn?.(`mobile-hub: codex(${this.label}) exited (code=${code}, signal=${signal})`)
        }
        const stderrHint = !this.closing && this.stderrTail.trim()
          ? ` — ${this.stderrTail.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 240)}`
          : ''
        const err = new Error(`codex(${this.label}) exited (code=${code}${signal ? `, signal=${signal}` : ''})${stderrHint}`)
        this.cleanup(err)
        try {
          this.onExit?.(err, this)
        } catch (cbErr) {
          this.log.error?.(`mobile-hub: codex(${this.label}) onExit error: ${String(cbErr)}`)
        }
      })

      this.callRaw('initialize', {
        clientInfo: { name: 'allinone-dsh-mobile', version: '0.4.4' },
        capabilities: null,
      })
        .then((res) => {
          this.sendRaw({ jsonrpc: '2.0', method: 'initialized', params: {} })
          resolveReady(res)
        })
        .catch((err) => {
          this.cleanup(err)
          rejectReady(err)
        })
    })

    return this.readyPromise
  }

  cleanup(err) {
    this.proc = null
    this.readyPromise = null
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pendingRpc.clear()
  }

  sendRaw(msg) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error(`codex(${this.label}) is not running`)
    }
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  callRaw(method, params = {}, timeoutMs = 45_000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = this.nextRpcId++
      const timer = setTimeout(() => {
        if (!this.pendingRpc.has(id)) return
        this.pendingRpc.delete(id)
        rejectPromise(new Error(`codex RPC "${method}" timed out`))
      }, timeoutMs)
      this.pendingRpc.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      try {
        this.sendRaw({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pendingRpc.delete(id)
        rejectPromise(err)
      }
    })
  }

  async rpc(method, params = {}, timeoutMs = 45_000) {
    await this.ensureStarted()
    return this.callRaw(method, params, timeoutMs)
  }

  handleMessage(msg) {
    if (msg.id !== undefined && !msg.method) {
      const pending = this.pendingRpc.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pendingRpc.delete(msg.id)
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (msg.id !== undefined && msg.method) {
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

    if (msg.method && this.onNotification) {
      this.onNotification(msg.method, msg.params || {})
    }
  }

  async closeGracefully() {
    this.closing = true
    const proc = this.proc
    if (!proc) return
    await new Promise((resolveDone) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        resolveDone()
      }
      proc.once('exit', finish)
      const killTimer = setTimeout(() => {
        try { proc.kill() } catch {}
        setTimeout(finish, 150)
      }, 600)
      try {
        proc.stdin.end()
      } catch {
        try { proc.kill() } catch {}
        finish()
      }
    })
  }

  killImmediate() {
    this.closing = true
    if (this.proc) {
      try { this.proc.kill() } catch {}
      this.proc = null
      this.readyPromise = null
    }
  }
}

/**
 * Official Codex Adapter using:
 *  - Persistent read-only `codex app-server --stdio` for 3ms thread listing, pagination & model discovery
 *  - Auto-releasing per-thread writer process that gracefully shuts down after each turn completes,
 *    ensuring Codex Desktop on PC NEVER gets stuck on "已在另一个应用中打开"!
 */
export class CodexAdapter {
  constructor({ config = {}, log = console, emitEvent, onApprovalRequest }) {
    this.configuredBin = config.codexBin
    this.codexBin = findCodexBinary(this.configuredBin)
    this.defaultCwd = config.cwd || process.cwd()
    this.log = log
    this.emitEvent = emitEvent || (() => {})
    this.onApprovalRequest = onApprovalRequest || (() => {})

    this.reader = new CodexRpcClient({
      codexBin: this.codexBin,
      log: this.log,
      label: 'reader',
    })
    this.activeTurns = new Map() // threadId -> { writer, turnId, resolve, reject, textBuffer, aborted }
    this.pendingNewWriters = new Map() // threadId -> { writer, summary, timer }
    this.pendingServerRequests = new Map() // approvalId -> { writer, rpcId, method, threadId }
    this.sessionPrefs = new Map() // threadId -> { model, reasoningEffort }
    this.modelsCache = null
    this.modelsCacheAt = 0
  }

  refreshBinary() {
    this.codexBin = findCodexBinary(this.configuredBin)
    if (this.reader) {
      this.reader.codexBin = this.codexBin
    }
    this.modelsCache = null
    this.modelsCacheAt = 0
    return this.codexBin
  }

  /** Read-only RPC via persistent reader daemon (never acquires write locks). */
  async rpc(method, params = {}, timeoutMs = 45_000) {
    return this.reader.rpc(method, params, timeoutMs)
  }

  createWriter(threadHint = 'writer') {
    const writer = new CodexRpcClient({
      codexBin: this.codexBin,
      log: this.log,
      label: `w-${String(threadHint).slice(0, 8)}`,
      onServerRequest: (reqWriter, msg) => this.handleServerRequest(reqWriter, msg),
      onNotification: (method, params) => this.handleNotification(method, params),
      onExit: (err, exitedClient) => {
        const targetWriter = exitedClient || writer
        // Fail any active turn bound to this writer if it crashed unexpectedly
        for (const [tid, active] of this.activeTurns.entries()) {
          if (active.writer === targetWriter && !targetWriter.closing) {
            this.activeTurns.delete(tid)
            this.emitEvent(EVENTS.STREAM_ERROR, {
              sessionId: makeCompositeId(APPS.CODEX, tid),
              app: APPS.CODEX,
              message: String(err?.message || err),
            })
            active.reject(err)
          }
        }
      },
    })
    return writer
  }

  async releaseWriter(writer, threadId) {
    if (!writer) return
    try {
      if (threadId && writer.proc && !writer.proc.killed) {
        await writer.rpc('thread/unsubscribe', { threadId }, 3_000).catch(() => {})
      }
    } catch {}
    await writer.closeGracefully().catch(() => {})
  }

  async listModels() {
    if (this.modelsCache && Date.now() - this.modelsCacheAt < 5 * 60_000) {
      return this.modelsCache
    }
    const res = await this.rpc('model/list', {})
    const raw = res?.data || res?.models || []
    let defaultModel = ''
    let defaultEffort = ''
    const models = raw.map((m) => {
      const id = m.id || m.model || ''
      const efforts = (m.supportedReasoningEfforts || m.reasoningEfforts || [])
        .map((e) => (typeof e === 'string' ? e : e?.reasoningEffort))
        .filter(Boolean)
      const defEff = m.defaultReasoningEffort || efforts[0] || ''
      if (m.isDefault) {
        defaultModel = id
        defaultEffort = defEff
      }
      return {
        id,
        name: m.displayName || m.name || id,
        efforts,
        defaultEffort: defEff,
        isDefault: Boolean(m.isDefault),
      }
    })
    if (!defaultModel && models[0]) {
      defaultModel = models[0].id
      defaultEffort = models[0].defaultEffort
    }
    this.modelsCache = {
      app: APPS.CODEX,
      defaultModel,
      defaultEffort,
      supportsMidChatSwitch: true,
      models,
    }
    this.modelsCacheAt = Date.now()
    return this.modelsCache
  }

  handleServerRequest(writer, msg) {
    const method = msg.method
    const params = msg.params || {}
    const threadId = params.threadId || params.conversationId || ''
    const approvalId = `cdx-apr-${randomUUID().slice(0, 10)}`

    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'execCommandApproval' ||
      method === 'applyPatchApproval'
    ) {
      this.pendingServerRequests.set(approvalId, {
        writer,
        rpcId: msg.id,
        method,
        threadId,
      })

      const isCommand = method.includes('command') || method.includes('Command')
      const summary = isCommand
        ? params.command || (Array.isArray(params.commandArgs) ? params.commandArgs.join(' ') : '执行终端命令')
        : params.reason || '修改工作区文件'

      const request = {
        id: approvalId,
        app: APPS.CODEX,
        sessionId: threadId ? makeCompositeId(APPS.CODEX, threadId) : '',
        kind: isCommand ? 'command' : 'file_change',
        title: isCommand ? 'Codex 请求执行命令' : 'Codex 请求修改文件',
        detail: summary,
        cwd: params.cwd || '',
        createdAt: Date.now(),
        options: [
          { value: 'accept', label: '允许一次', style: 'primary' },
          { value: 'acceptForSession', label: '本会话自动允许', style: 'secondary' },
          { value: 'decline', label: '拒绝', style: 'danger' },
        ],
      }
      this.onApprovalRequest(request)
      return
    }

    try {
      writer.sendRaw({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unsupported client serverRequest: ${method}` },
      })
    } catch {}
  }

  async resolveApproval(approvalId, decision) {
    const entry = this.pendingServerRequests.get(approvalId)
    if (!entry) return { resolved: false, reason: 'approval not found' }
    this.pendingServerRequests.delete(approvalId)

    const validDecision = ['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)
      ? decision
      : 'decline'

    entry.writer.sendRaw({
      jsonrpc: '2.0',
      id: entry.rpcId,
      result: { decision: validDecision },
    })

    this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
      id: approvalId,
      app: APPS.CODEX,
      decision: validDecision,
    })
    return { resolved: true, id: approvalId, decision: validDecision }
  }

  handleNotification(method, params) {
    const threadId = params.threadId
    if (!threadId) return
    const compositeId = makeCompositeId(APPS.CODEX, threadId)
    const active = this.activeTurns.get(threadId)

    if (method === 'item/agentMessage/delta') {
      const delta = params.delta || ''
      if (active) active.textBuffer += delta
      this.emitEvent(EVENTS.STREAM_DELTA, {
        sessionId: compositeId,
        app: APPS.CODEX,
        turnId: params.turnId,
        delta,
      })
      return
    }

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.emitEvent(EVENTS.STREAM_THINKING, {
        sessionId: compositeId,
        app: APPS.CODEX,
        turnId: params.turnId,
        delta: params.delta || '',
      })
      return
    }

    if (method === 'item/started') {
      const item = params.item || {}
      if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'webSearch') {
        this.emitEvent(EVENTS.STREAM_TOOL_START, {
          sessionId: compositeId,
          app: APPS.CODEX,
          tool: {
            id: item.id,
            name: item.type === 'commandExecution' ? 'command' : item.type === 'fileChange' ? 'file_change' : item.tool || item.type,
            input: item.command ? { command: item.command, cwd: item.cwd } : item.arguments ?? item.query ?? {},
          },
        })
      }
      return
    }

    if (method === 'item/completed') {
      const item = params.item || {}
      if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'webSearch') {
        this.emitEvent(EVENTS.STREAM_TOOL_END, {
          sessionId: compositeId,
          app: APPS.CODEX,
          toolId: item.id,
          status: item.status === 'failed' || item.error ? 'error' : 'completed',
          output: (item.aggregatedOutput || (item.result ? JSON.stringify(item.result) : '')).slice(0, 3000),
        })
      } else if (item.type === 'agentMessage' && item.text && active && !active.textBuffer) {
        active.textBuffer = item.text
      }
      return
    }

    if (method === 'turn/completed') {
      const turn = params.turn || {}
      const finalText = active?.textBuffer || ''
      const aborted = turn.status === 'interrupted' || Boolean(active?.aborted)
      if (turn.error && !aborted) {
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: APPS.CODEX,
          message: turn.error.message || JSON.stringify(turn.error),
        })
      }
      this.emitEvent(EVENTS.STREAM_DONE, {
        sessionId: compositeId,
        app: APPS.CODEX,
        nativeId: threadId,
        finalText,
        aborted,
      })
      if (active) {
        this.activeTurns.delete(threadId)
        active.resolve({ sessionId: compositeId, nativeId: threadId, finalText, aborted })
      }
    }
  }

  async getStatus() {
    try {
      // Re-resolve binary if previously missing (e.g. user installed Codex after starting bridge)
      if (!this.reader.proc) {
        const resolved = findCodexBinary(this.configuredBin)
        this.codexBin = resolved
        this.reader.codexBin = resolved
      }
      await this.reader.ensureStarted()
      return {
        app: APPS.CODEX,
        available: true,
        writable: true,
        mode: 'app-server-rpc',
        detail: `已连接官方 codex app-server（${basename(this.codexBin)}，每轮自动释放写入锁，可与电脑端无缝切换）`,
        activeCount: this.activeTurns.size,
      }
    } catch (err) {
      return {
        app: APPS.CODEX,
        available: false,
        writable: false,
        mode: 'unavailable',
        detail: `未找到 codex CLI（请安装 Codex Desktop 或运行 npm i -g @openai/codex 后点击刷新）：${String(err?.message || err)}`,
        activeCount: 0,
      }
    }
  }

  async listSessions({ limit = 80, search = '' } = {}) {
    const res = await this.rpc('thread/list', {
      limit,
      useStateDbOnly: true,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      ...(search ? { searchTerm: search } : {}),
    })
    const items = (res?.data || []).map(normalizeThreadSummary)
    const seen = new Set(items.map((x) => x.nativeId))
    for (const [tid, entry] of this.pendingNewWriters.entries()) {
      if (!seen.has(tid) && entry.summary) {
        items.unshift(entry.summary)
      }
    }
    for (const item of items) {
      if (this.activeTurns.has(item.nativeId)) item.status = 'running'
    }
    return items
  }

  async readSession(threadId, { limit = 25, cursor = null } = {}) {
    threadId = assertSafeSessionId(threadId, 'Codex threadId')
    const pendingNew = this.pendingNewWriters.get(threadId)
    let t = {}
    try {
      const metaRes = await this.rpc('thread/read', { threadId, includeTurns: false })
      t = metaRes?.thread || {}
    } catch (err) {
      if (pendingNew?.summary) {
        return {
          ...pendingNew.summary,
          messages: [],
          hasMore: false,
          nextCursor: null,
        }
      }
      throw err
    }

    let messages = []
    let nextCursor = null
    let hasMore = false

    const targetBubbles = Math.max(6, Math.min(Number(limit) || 12, 30))
    const maxRawBatches = 16 // up to 1,600 raw items per page so heavy tool runs stay fast & complete
    let hitDeserializationBoundary = false

    {
      const collectedDesc = []
      let curCursor = cursor || null
      let userCount = 0
      let agentTextCount = 0

      for (let batch = 0; batch < maxRawBatches; batch += 1) {
        let itemsRes = null
        try {
          itemsRes = await this.rpc('thread/items/list', {
            threadId,
            limit: 100,
            sortDirection: 'desc',
            ...(curCursor ? { cursor: curCursor } : {}),
          })
        } catch (batchErr) {
          // If batch 0 fails because a legacy corrupt item sits inside the newest 100 items,
          // retry once with a smaller window (20 items) to still rescue the latest replies.
          if (batch === 0 && collectedDesc.length === 0) {
            try {
              itemsRes = await this.rpc('thread/items/list', {
                threadId,
                limit: 20,
                sortDirection: 'desc',
                ...(curCursor ? { cursor: curCursor } : {}),
              })
            } catch {
              itemsRes = null
            }
          }
          if (!itemsRes) {
            // Preserve every valid item already fetched in earlier batches!
            hitDeserializationBoundary = true
            curCursor = null
            this.log.warn?.(
              `codex: thread/items/list stopped at batch ${batch} for ${threadId} (kept ${collectedDesc.length} items): ${String(batchErr?.message || batchErr)}`,
            )
            break
          }
        }
        const chunk = Array.isArray(itemsRes?.data) ? itemsRes.data : []
        if (chunk.length > 0) {
          collectedDesc.push(...chunk)
          for (const entry of chunk) {
            const it = entry?.item?.type
            if (it === 'userMessage') userCount += 1
            else if (it === 'agentMessage') agentTextCount += 1
          }
        }
        curCursor = itemsRes?.nextCursor || null
        if (!curCursor || chunk.length === 0) break
        // Stop once we have enough real Q&A turns OR enough autonomous assistant milestones
        if (userCount >= Math.max(3, Math.ceil(targetBubbles / 2))) break
        if (userCount >= 2 && agentTextCount >= targetBubbles) break
        if (agentTextCount >= Math.max(6, targetBubbles)) break
      }

      nextCursor = hitDeserializationBoundary ? null : curCursor ? String(curCursor) : null
      hasMore = Boolean(nextCursor)

      const entries = collectedDesc.slice().reverse()
      if (entries.length > 0) {
        const turns = []
        const byTurn = new Map()
        for (const entry of entries) {
          const turnId = entry.turnId || 'default'
          let turnObj = byTurn.get(turnId)
          if (!turnObj) {
            turnObj = { id: turnId, startedAt: entry.startedAtMs, items: [] }
            byTurn.set(turnId, turnObj)
            turns.push(turnObj)
          }
          if (entry.item) {
            turnObj.items.push({
              ...entry.item,
              startedAtMs: entry.startedAtMs ?? entry.item.startedAtMs,
              completedAtMs: entry.completedAtMs ?? entry.item.completedAtMs,
            })
          }
        }
        messages = mergeAndCompactMessages(normalizeCodexTurns(turns))
      }
    }

    if (messages.length === 0 && !cursor && !pendingNew) {
      try {
        const fullRes = await this.rpc('thread/read', { threadId, includeTurns: true }, 12_000)
        const all = mergeAndCompactMessages(normalizeCodexTurns(fullRes?.thread?.turns || []))
        const start = Math.max(0, all.length - targetBubbles)
        messages = all.slice(start)
        hasMore = start > 0
        nextCursor = null
      } catch {}
    }

    // Final safety net: zero-OOM tail-seek JSONL reader for giant/legacy rollout files
    // (also rescues fuller recent history when a corrupt schema item sits near the newest items)
    if (!cursor && !pendingNew && t.path && (messages.length === 0 || (hitDeserializationBoundary && messages.length < 4))) {
      const tailMsgs = readCodexRolloutTail(t.path, { limit: targetBubbles })
      if (tailMsgs.length > messages.length) {
        messages = tailMsgs
        hasMore = false
        nextCursor = null
      }
    }

    const pref = this.sessionPrefs.get(threadId)
    return {
      id: makeCompositeId(APPS.CODEX, threadId),
      app: APPS.CODEX,
      nativeId: threadId,
      title: (t.name && t.name.trim()) || (t.preview && t.preview.trim().slice(0, 56)) || pendingNew?.summary?.title || threadId,
      cwd: t.cwd || pendingNew?.summary?.cwd || '',
      model: pref?.model || t.model || '',
      reasoningEffort: pref?.reasoningEffort || t.reasoningEffort || '',
      writable: true,
      status: this.activeTurns.has(threadId) ? 'running' : 'idle',
      messages,
      hasMore,
      nextCursor,
    }
  }

  async createSession({ cwd, title, model, reasoningEffort, sandbox, approvalPolicy } = {}) {
    const targetCwd = String(cwd || '').trim() || this.defaultCwd
    const writer = this.createWriter('new')
    try {
      const res = await writer.rpc('thread/start', {
        cwd: targetCwd,
        ...(model ? { model } : {}),
        ...(sandbox ? { sandbox } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
      })
      const t = res?.thread || {}
      if (t.id) {
        if (model || reasoningEffort) {
          this.sessionPrefs.set(t.id, { model: model || t.model || '', reasoningEffort: reasoningEffort || '' })
        }
        if (title && String(title).trim()) {
          await writer.rpc('thread/name/set', { threadId: t.id, name: String(title).trim() }).catch(() => {})
          t.name = String(title).trim()
        }
      }
      const summary = normalizeThreadSummary(t)
      if (title && String(title).trim()) summary.title = String(title).trim()
      if (model) summary.model = model
      if (reasoningEffort) summary.reasoningEffort = reasoningEffort

      if (t.id) {
        // Hold this temporary writer ONLY until Turn 1 completes (or 3 min idle) so empty threads can start Turn 1 cleanly
        const timer = setTimeout(() => {
          const entry = this.pendingNewWriters.get(t.id)
          if (entry && entry.writer === writer) {
            this.pendingNewWriters.delete(t.id)
            void this.releaseWriter(writer, t.id)
          }
        }, 3 * 60_000)
        timer.unref?.()
        this.pendingNewWriters.set(t.id, { writer, summary, timer })
      } else {
        await this.releaseWriter(writer, '')
      }
      return summary
    } catch (err) {
      await this.releaseWriter(writer, '')
      throw err
    }
  }

  async sendMessage(threadId, { text, cwd, attachments = [], approvalPolicy, model, reasoningEffort } = {}) {
    threadId = assertSafeSessionId(threadId, 'Codex threadId')
    const compositeId = makeCompositeId(APPS.CODEX, threadId)
    if (this.activeTurns.has(threadId)) {
      const err = new Error('该 Codex 对话正在运行中，请等待完成或先中断当前任务。')
      this.emitEvent(EVENTS.STREAM_ERROR, { sessionId: compositeId, app: APPS.CODEX, message: err.message })
      throw err
    }

    // Reuse pending new-thread writer if Turn 1; otherwise spawn a fresh per-turn writer
    const pendingNew = this.pendingNewWriters.get(threadId)
    let writer = null
    let alreadyLoaded = false
    if (pendingNew) {
      clearTimeout(pendingNew.timer)
      this.pendingNewWriters.delete(threadId)
      writer = pendingNew.writer
      alreadyLoaded = true
    } else {
      writer = this.createWriter(threadId)
    }

    try {
      if (!alreadyLoaded) {
        try {
          await writer.rpc('thread/resume', {
            threadId,
            excludeTurns: true,
            ...(cwd ? { cwd } : {}),
          })
        } catch (resumeErr) {
          const msg = String(resumeErr?.message || resumeErr)
          if (/already has an active writer|thread-store conflict/i.test(msg)) {
            throw new Error(
              '该对话当前正被电脑端 Codex 桌面窗口占用（Codex 同一时间只允许一端写入）。请在电脑端 Codex 里切到其他对话后再试，或在手机端新建对话继续。',
            )
          }
          if (!/no rollout found/i.test(msg)) {
            throw resumeErr
          }
        }
      }

      const input = []
      const trimmedText = String(text || '').trim()
      if (trimmedText.length > 0) {
        input.push({ type: 'text', text: String(text), text_elements: [] })
      }
      for (const att of attachments) {
        if (att.localPath && String(att.mimeType || '').startsWith('image/')) {
          input.push({ type: 'localImage', path: att.localPath })
        } else if (att.localPath) {
          input.push({ type: 'text', text: `[附件文件: ${att.localPath}]`, text_elements: [] })
        }
      }
      if (input.length === 0) {
        throw new Error('消息内容不能为空')
      }

      this.emitEvent(EVENTS.STREAM_START, {
        sessionId: compositeId,
        app: APPS.CODEX,
        nativeId: threadId,
      })

      let resolveTurn
      let rejectTurn
      const turnDone = new Promise((res, rej) => {
        resolveTurn = res
        rejectTurn = rej
      })
      // Prevent unhandled rejection if writer exits during `turn/start` before `await turnDone`
      turnDone.catch(() => {})

      const turnState = {
        writer,
        turnId: null,
        textBuffer: '',
        aborted: false,
        resolve: resolveTurn,
        reject: rejectTurn,
      }
      this.activeTurns.set(threadId, turnState)

      const pref = this.sessionPrefs.get(threadId)
      const effectiveModel = model || pref?.model || undefined
      const effectiveEffort = reasoningEffort || pref?.reasoningEffort || undefined
      if (effectiveModel || effectiveEffort) {
        this.sessionPrefs.set(threadId, { model: effectiveModel || '', reasoningEffort: effectiveEffort || '' })
      }

      const startRes = await writer.rpc('turn/start', {
        threadId,
        input,
        ...(cwd ? { cwd } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort && effectiveEffort !== 'off' ? { effort: effectiveEffort } : {}),
      })
      turnState.turnId = startRes?.turn?.id || null

      return await turnDone
    } catch (err) {
      this.activeTurns.delete(threadId)
      this.emitEvent(EVENTS.STREAM_ERROR, {
        sessionId: compositeId,
        app: APPS.CODEX,
        message: String(err?.message || err),
      })
      throw err
    } finally {
      // ALWAYS release the writer process once the turn completes or errors so Codex Desktop
      // on PC can immediately take over without "已在另一个应用中打开"!
      this.activeTurns.delete(threadId)
      for (const [aprId, entry] of this.pendingServerRequests.entries()) {
        if (entry.writer === writer) this.pendingServerRequests.delete(aprId)
      }
      await this.releaseWriter(writer, threadId)
    }
  }

  async interrupt(threadId) {
    threadId = assertSafeSessionId(threadId, 'Codex threadId')
    const active = this.activeTurns.get(threadId)
    if (!active) return { interrupted: false, sessionId: threadId }
    active.aborted = true
    if (active.turnId && active.writer) {
      await active.writer.rpc('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => {})
    }
    return { interrupted: true, sessionId: threadId }
  }

  async dispose() {
    for (const [tid, entry] of this.pendingNewWriters.entries()) {
      clearTimeout(entry.timer)
      entry.writer.killImmediate()
      this.pendingNewWriters.delete(tid)
    }
    for (const active of this.activeTurns.values()) {
      active.writer?.killImmediate()
    }
    this.activeTurns.clear()
    this.reader.killImmediate()
  }
}
