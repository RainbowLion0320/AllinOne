import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { APPS, EVENTS, assertPathWithinDir, assertSafeSessionId, makeCompositeId, toEpochMs } from '../protocol.js'
import { createFileParseCache, mergeAndCompactMessages } from '../helpers/history-normalize.js'
import { findExecutable, spawnCrossPlatform } from '../helpers/bin-finder.js'

const AGY_APP_DATA_DIR = 'antigravity'
const transcriptCache = createFileParseCache(16)
const WARM_IDLE_CLOSE_MS = 45_000             // Release SQLite WAL promptly once truly idle (no bg tasks)
const WARM_IDLE_EXCESS_CLOSE_MS = 25_000      // Tighter idle close when >3 warm sessions exist
const WARM_BUSY_HARD_CAP_MS = 2 * 60 * 60_000 // Allow background tasks up to 2 hours
const MAX_IDLE_WARM_SESSIONS = 3
const WATCH_POLL_INTERVAL_MS = 2_000          // Lightweight active-session external sync poll
const WATCH_TTL_MS = 15 * 60_000              // Stop watching inactive sessions after 15 min
const MAX_WATCHED_SESSIONS = 3
const DESKTOP_PROC_CACHE_TTL_MS = 10_000

let desktopProcCache = { running: false, checkedAt: 0 }

function getTranscriptPathSafe(agyHome, conversationId) {
  const safeId = assertSafeSessionId(conversationId, 'Antigravity conversationId')
  const brainDir = join(agyHome, 'brain')
  return assertPathWithinDir(
    join(brainDir, safeId, '.system_generated', 'logs', 'transcript.jsonl'),
    brainDir,
    'Antigravity transcript',
  )
}

function getTranscriptFingerprint(agyHome, conversationId) {
  if (!conversationId) return { mtimeMs: 0, size: 0 }
  try {
    const st = statSync(getTranscriptPathSafe(agyHome, conversationId))
    return { mtimeMs: st.mtimeMs || 0, size: st.size || 0 }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

async function isAntigravityDesktopRunning(force = false) {
  const now = Date.now()
  if (!force && now - desktopProcCache.checkedAt < DESKTOP_PROC_CACHE_TTL_MS) {
    return desktopProcCache.running
  }
  const running = await new Promise((resolvePromise) => {
    let settled = false
    const done = (val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(Boolean(val))
    }
    let proc = null
    const timer = setTimeout(() => {
      try { proc?.kill() } catch {}
      done(false)
    }, 1_500)
    try {
      if (process.platform === 'win32') {
        proc = spawnCrossPlatform('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        let out = ''
        proc.stdout.on('data', (d) => { out += d.toString('utf8') })
        proc.on('close', () => done(/Antigravity\.exe/i.test(out)))
        proc.on('error', () => done(false))
      } else {
        const pattern = process.platform === 'darwin'
          ? 'Antigravity\\.app/Contents/'
          : 'antigravity.*language_server|/antigravity/antigravity'
        proc = spawnCrossPlatform('pgrep', ['-f', pattern], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        let out = ''
        proc.stdout.on('data', (d) => { out += d.toString('utf8') })
        proc.on('close', (code) => done(code === 0 && out.trim().length > 0))
        proc.on('error', () => done(false))
      }
    } catch {
      done(false)
    }
  })
  desktopProcCache = { running, checkedAt: Date.now() }
  return running
}

async function queryAgyConversationState(dbPath, conversationId) {
  if (!conversationId || !existsSync(dbPath)) return null
  try {
    const sqlite = await import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db
        .prepare('SELECT status, not_fully_idle, step_count FROM conversation_summaries WHERE conversation_id = ? LIMIT 1')
        .get(conversationId)
      if (!row) return null
      return {
        status: String(row.status || ''),
        notFullyIdle: Boolean(row.not_fully_idle),
        stepCount: Number(row.step_count || 0),
      }
    } finally {
      db.close()
    }
  } catch {
    // Fallback to Python sqlite3 read-only query
  }

  const pyCode = [
    'import sqlite3, json, sys',
    'db_path, cid = sys.argv[1], sys.argv[2]',
    'con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)',
    'con.row_factory = sqlite3.Row',
    'row = con.execute("SELECT status, not_fully_idle, step_count FROM conversation_summaries WHERE conversation_id = ? LIMIT 1", (cid,)).fetchone()',
    'print(json.dumps(dict(row) if row else None))',
  ].join('\n')
  const pyBin = findExecutable(process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) ||
    (process.platform === 'win32' ? 'python' : 'python3')

  return new Promise((resolvePromise) => {
    const proc = spawnCrossPlatform(pyBin, ['-c', pyCode, dbPath, conversationId], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    proc.stdout.on('data', (d) => { out += d.toString('utf8') })
    proc.on('close', () => {
      try {
        const row = JSON.parse(out)
        if (!row) return resolvePromise(null)
        resolvePromise({
          status: String(row.status || ''),
          notFullyIdle: Boolean(row.not_fully_idle),
          stepCount: Number(row.step_count || 0),
        })
      } catch {
        resolvePromise(null)
      }
    })
    proc.on('error', () => resolvePromise(null))
  })
}

function getAgyHome() {
  return join(homedir(), '.gemini', AGY_APP_DATA_DIR)
}

function findAgyBinary(configuredBin) {
  const home = homedir()
  const candidates = [configuredBin, process.env.AGY_BIN]
  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    candidates.push(
      join(localApp, 'agy', 'bin', 'agy.exe'),
      join(localApp, 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
      join(localApp, 'Programs', 'Antigravity', 'resources', 'app', 'bin', 'agy.cmd'),
    )
    return findExecutable(['agy.exe', 'agy.cmd', 'agy'], candidates) || 'agy.exe'
  }
  candidates.push(
    join(home, '.local', 'bin', 'agy'),
    join(home, '.antigravity', 'antigravity', 'bin', 'agy'),
    join(home, '.antigravity', 'bin', 'agy'),
    join(home, '.agy', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  )
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app/bin/agy',
      join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin', 'agy'),
    )
  }
  return findExecutable(['agy'], candidates) || 'agy'
}

export function parseWorkspaceUri(raw) {
  if (!raw || typeof raw !== 'string') return ''
  let first = raw.trim()
  if (first.startsWith('[')) {
    try {
      const arr = JSON.parse(first)
      first = Array.isArray(arr) && arr[0] ? String(arr[0]) : ''
    } catch {}
  } else if (first.includes(',')) {
    first = first.split(',')[0].trim()
  }
  if (/^file:\/\//i.test(first)) {
    try {
      let decoded = decodeURIComponent(first.replace(/^file:\/\/(?:localhost)?/i, ''))
      if (process.platform === 'win32') {
        if (/^\/[a-zA-Z]:/.test(decoded)) decoded = decoded.slice(1)
        return decoded.replace(/\//g, '\\')
      }
      return decoded
    } catch {}
  }
  return first
}

/**
 * Query Antigravity's local SQLite conversation index read-only (top-level chats only).
 * Uses Node 24 built-in `node:sqlite` first; falls back to Python `sqlite3` for Electron compatibility.
 */
async function queryAgySummariesDb(dbPath, limit = 80, search = '') {
  if (!existsSync(dbPath)) return []

  try {
    const sqlite = await import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      let sql = `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle
                 FROM conversation_summaries
                 WHERE nesting_depth = 0 AND (parent_conversation_id IS NULL OR parent_conversation_id = '')`
      const args = []
      if (search) {
        sql += ` AND (title LIKE ? OR preview LIKE ? OR workspace_uris LIKE ?)`
        const pattern = `%${search}%`
        args.push(pattern, pattern, pattern)
      }
      sql += ` ORDER BY last_modified_time DESC LIMIT ?`
      args.push(limit)
      const stmt = db.prepare(sql)
      return stmt.all(...args)
    } finally {
      db.close()
    }
  } catch {
    // Fallback to Python sqlite3 read-only query
  }

  const pyCode = [
    'import sqlite3, json, sys',
    'db_path, limit, search = sys.argv[1], int(sys.argv[2]), sys.argv[3]',
    'con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)',
    'con.row_factory = sqlite3.Row',
    'cur = con.cursor()',
    'sql = "SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, not_fully_idle FROM conversation_summaries WHERE nesting_depth = 0 AND (parent_conversation_id IS NULL OR parent_conversation_id = \'\')"',
    'args = []',
    'if search: sql += " AND (title LIKE ? OR preview LIKE ? OR workspace_uris LIKE ?)"; p = f"%{search}%"; args = [p, p, p]',
    'sql += " ORDER BY last_modified_time DESC LIMIT ?"',
    'args.append(limit)',
    'rows = [dict(r) for r in cur.execute(sql, args).fetchall()]',
    'print(json.dumps(rows, ensure_ascii=False))',
  ].join('\n')

  const pyBin = findExecutable(process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) ||
    (process.platform === 'win32' ? 'python' : 'python3')

  return new Promise((resolvePromise) => {
    const proc = spawnCrossPlatform(pyBin, ['-c', pyCode, dbPath, String(limit), search || ''], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    proc.stdout.on('data', (d) => { out += d.toString('utf8') })
    proc.on('close', () => {
      try {
        resolvePromise(JSON.parse(out))
      } catch {
        resolvePromise([])
      }
    })
    proc.on('error', () => resolvePromise([]))
  })
}

/**
 * Parse an Antigravity `transcript.jsonl` payload safely.
 * Detects `step_index` regressions (split-brain writes when Antigravity Desktop resumes from
 * stale in-memory state after an external `agy acp` turn), isolates branch epochs so consecutive
 * assistant turns never fuse across branches, and guarantees globally unique message/tool IDs.
 */
export function parseAgyTranscriptContent(raw) {
  const messages = []
  const usedIds = new Set()
  let maxStepIndex = -1
  let latestStepIndex = -1
  let branchEpoch = 0
  let divergence = null

  const lines = String(raw || '').split(/\r?\n/)
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx]
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    const rawStep = obj.step_index
    const stepNum = rawStep !== undefined && rawStep !== null && Number.isFinite(Number(rawStep))
      ? Number(rawStep)
      : null
    const ts = toEpochMs(obj.created_at || Date.now())

    if (stepNum !== null) {
      if (maxStepIndex >= 0 && stepNum < maxStepIndex) {
        branchEpoch += 1
        divergence = {
          count: (divergence?.count || 0) + 1,
          lastFromStep: maxStepIndex,
          lastToStep: stepNum,
          lastAt: ts,
        }
        maxStepIndex = stepNum
      } else if (stepNum > maxStepIndex) {
        maxStepIndex = stepNum
      }
      latestStepIndex = stepNum
    }

    const mediaImages = Array.isArray(obj.media)
      ? obj.media
          .filter((m) => m && m.uri && (!m.mime_type || String(m.mime_type).startsWith('image/')))
          .map((m) => ({ path: m.uri, name: basename(String(m.uri)) }))
      : []

    const makeUniqueId = (roleChar) => {
      const stepPart = stepNum !== null ? String(stepNum) : String(messages.length)
      const baseId = branchEpoch > 0 ? `agy-${roleChar}-b${branchEpoch}-${stepPart}` : `agy-${roleChar}-${stepPart}`
      let candidate = baseId
      if (usedIds.has(candidate)) {
        candidate = `${baseId}-l${lineIdx}`
      }
      usedIds.add(candidate)
      return candidate
    }

    if (obj.type === 'USER_INPUT') {
      let text = String(obj.content || '').trim()
      // Unwrap Antigravity's internal <USER_REQUEST> wrapper if present in raw transcript logs
      const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
      if (reqMatch) text = reqMatch[1].trim()
      if (text || mediaImages.length > 0) {
        messages.push({
          id: makeUniqueId('u'),
          role: 'user',
          text,
          ...(mediaImages.length > 0 ? { images: mediaImages } : {}),
          branchEpoch,
          ts,
        })
      }
    } else if (obj.type === 'PLANNER_RESPONSE') {
      const text = String(obj.content || '').trim()
      const thinking = String(obj.thinking || '').trim()
      const tools = Array.isArray(obj.tool_calls)
        ? obj.tool_calls.map((tc, idx) => ({
            id: tc.id || (branchEpoch > 0 ? `agy-t-b${branchEpoch}-${obj.step_index}-${idx}` : `agy-t-${obj.step_index}-${idx}`),
            name: tc.name || tc.tool || 'tool',
            input: tc.args ?? tc.arguments ?? {},
            status: 'completed',
            output: '',
          }))
        : []
      if (text || thinking || tools.length > 0 || mediaImages.length > 0) {
        messages.push({
          id: makeUniqueId('a'),
          role: 'assistant',
          text,
          thinking: thinking || undefined,
          tools: tools.length > 0 ? tools : undefined,
          ...(mediaImages.length > 0 ? { images: mediaImages } : {}),
          branchEpoch,
          ts,
        })
      }
    }
  }

  return {
    messages: mergeAndCompactMessages(messages),
    divergence,
    latestStepIndex,
    branchEpoch,
  }
}

function parseDesktopTranscript(conversationId, agyHome = getAgyHome()) {
  const transcriptPath = getTranscriptPathSafe(agyHome, conversationId)
  if (!existsSync(transcriptPath)) {
    return { messages: [], divergence: null, latestStepIndex: -1, branchEpoch: 0 }
  }
  return transcriptCache.getOrParse(transcriptPath, () => {
    const raw = readFileSync(transcriptPath, 'utf8')
    return parseAgyTranscriptContent(raw)
  })
}

function extractAcpText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content.text === 'string') return content.text
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c?.type === 'text' && typeof c.text === 'string') return c.text
        if (c?.content?.type === 'text' && typeof c.content.text === 'string') return c.content.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Warm-pooled Agent Client Protocol (ACP) JSON-RPC client for official `agy acp`.
 * Uses `--app-data-dir antigravity` so mobile and Antigravity Desktop share the EXACT SAME
 * conversation store, trajectory UUIDs, and server-side prompt cache (`cachedReadTokens`)
 * with ZERO handoff prompts and ZERO extra tokens.
 *
 * Keeps the ACP worker alive while background tasks / subagents / timers are active
 * (`not_fully_idle = 1`) so reactive wakeups complete uninterrupted and stream live to mobile!
 */
class AgyAcpClient {
  constructor({ agyBin, cwd, autoApprove = true, log = console, onSessionUpdate, onExit }) {
    this.agyBin = agyBin
    this.cwd = cwd
    this.autoApprove = autoApprove
    this.log = log
    this.onSessionUpdate = onSessionUpdate || null
    this.onExit = onExit || null
    this.proc = null
    this.nextId = 1
    this.pending = new Map()
    this.stdoutBuf = ''
    this.stderrBuf = ''
    this.closing = false
  }

  isAlive() {
    return Boolean(this.proc && !this.proc.killed && !this.closing && this.proc.stdin?.writable)
  }

  setSessionUpdateHandler(fn) {
    this.onSessionUpdate = fn || null
  }

  touchSlidingTimeouts() {
    for (const [id, p] of this.pending.entries()) {
      if (!p.sliding || !p.timeoutMs) continue
      clearTimeout(p.timer)
      p.timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        p.reject(new Error(`Antigravity ACP "${p.method}" 长时间无响应超时`))
      }, p.timeoutMs)
    }
  }

  async start() {
    const args = ['acp', '--app-data-dir', AGY_APP_DATA_DIR]
    if (this.autoApprove) args.push('--dangerously-skip-permissions')

    const proc = spawnCrossPlatform(this.agyBin, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc = proc
    proc.stdin?.on('error', () => {})

    proc.stdout.on('data', (chunk) => {
      this.stdoutBuf += chunk.toString('utf8')
      let idx
      while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
        const line = this.stdoutBuf.slice(0, idx).trim()
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
        if (!line) continue
        this.handleLine(line)
      }
    })

    proc.stderr.on('data', (chunk) => {
      this.stderrBuf += chunk.toString('utf8')
    })

    proc.on('error', (err) => {
      this.failAll(err)
    })

    proc.on('exit', (code) => {
      const msg = this.stderrBuf.trim() || `agy acp 进程退出（code=${code}）`
      this.failAll(new Error(msg))
      this.proc = null
      try {
        this.onExit?.(code, this)
      } catch {}
    })

    await this.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} }, 25_000)
  }

  handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) {
        const errMsg = msg.error?.data?.details || msg.error?.message || JSON.stringify(msg.error)
        p.reject(new Error(errMsg))
      } else {
        p.resolve(msg.result)
      }
      return
    }

    if (msg.method === 'session/update') {
      this.touchSlidingTimeouts()
      this.onSessionUpdate?.(msg.params || {})
      return
    }

    // Handle any unexpected permission request safely if autoApprove wasn't enough
    if (msg.id !== undefined && msg.method) {
      if (msg.method === 'session/request_permission' && this.autoApprove) {
        const opts = msg.params?.options || []
        const allow = opts.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') || opts[0]
        this.sendRaw({
          jsonrpc: '2.0',
          id: msg.id,
          result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } },
        })
      } else {
        this.sendRaw({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
        })
      }
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
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('agy acp 未运行')
    }
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  notify(method, params = {}) {
    try {
      this.sendRaw({ jsonrpc: '2.0', method, params })
    } catch {}
  }

  rpc(method, params = {}, timeoutMs = 600_000, { sliding = false } = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        rejectPromise(new Error(`Antigravity ACP "${method}" 超时`))
      }, timeoutMs)
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

  async close(sessionId) {
    this.closing = true
    const proc = this.proc
    if (!proc) return
    if (sessionId) {
      await this.rpc('session/close', { sessionId }, 3_000).catch(() => {})
    }
    await new Promise((resolveDone) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(killTimer)
        resolveDone()
      }
      proc.once('exit', finish)
      const killTimer = setTimeout(() => {
        try { proc.kill() } catch {}
        setTimeout(finish, 150)
      }, 500)
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
    }
  }
}

/**
 * Zero-invasion Antigravity Adapter backed by official `agy acp --app-data-dir antigravity`.
 * Shares the EXACT SAME conversation store, UUIDs, history, and server prompt cache with Antigravity Desktop:
 *  - ZERO handoff prompt rewriting
 *  - ZERO extra token overhead
 *  - Warm ACP session pool keeps background tasks, subagents, timers, and reactive wakeups alive
 *    without premature `session/close`, and auto-reaps truly idle sessions cleanly!
 */
export class AntigravityAdapter {
  constructor({ config = {}, log = console, emitEvent }) {
    this.agyHome = String(config.agyHome || '').trim() || getAgyHome()
    this.configuredBin = config.agyBin
    this.agyBin = findAgyBinary(this.configuredBin)
    this.defaultCwd = config.cwd || process.cwd()
    this.autoApprove = config.agyAutoApprove !== false
    this.log = log
    this.emitEvent = emitEvent || (() => {})
    this.activeTurns = new Map() // conversationId -> { client, aborted }
    this.warmSessions = new Map() // conversationId -> warm entry keeping background tasks alive
    this.pendingCreated = new Map() // conversationId -> summary (before first turn hits conversation_summaries.db)
    this.sessionPrefs = new Map() // conversationId -> { model, reasoningEffort }
    this.bridgeWrittenSessions = new Map() // conversationId -> { writtenAt, stepCount }
    this.watchedSessions = new Map() // conversationId -> live external-change watch snapshot
    this.watchPollIntervalMs = Math.max(200, Number(config.watchPollIntervalMs) || WATCH_POLL_INTERVAL_MS)
    this.watchTimer = null
    this.watchPollInFlight = false
    this.cliVersionCache = null
    this.modelsCache = null
    this.modelsCacheAt = 0
    this.reaperTimer = null
  }

  refreshBinary() {
    this.agyBin = findAgyBinary(this.configuredBin)
    this.cliVersionCache = null
    this.modelsCache = null
    this.modelsCacheAt = 0
    return this.agyBin
  }

  parseModelPairs(pairs = []) {
    const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']
    const familyMap = new Map()
    const familyOrder = []

    for (const { id: rawId, label: rawLabel } of pairs) {
      const id = String(rawId || '').trim()
      if (!id) continue
      const label = String(rawLabel || '').trim()
      const m = id.match(/^(.+)-(low|medium|high|xhigh|max)$/i)
      if (m) {
        const baseId = m[1]
        const eff = m[2].toLowerCase()
        const cleanName = (label || baseId).replace(/\s*\((Low|Medium|High|XHigh|Max)\)\s*$/i, '').trim()
        let entry = familyMap.get(baseId)
        if (!entry) {
          entry = { id: baseId, name: cleanName, efforts: [], effortModelIds: {}, defaultEffort: '' }
          familyMap.set(baseId, entry)
          familyOrder.push(baseId)
        }
        if (!entry.efforts.includes(eff)) entry.efforts.push(eff)
        entry.effortModelIds[eff] = id
      } else {
        if (!familyMap.has(id)) {
          familyMap.set(id, { id, name: label || id, efforts: [], effortModelIds: {}, defaultEffort: '' })
          familyOrder.push(id)
        }
      }
    }

    return familyOrder.map((key) => {
      const e = familyMap.get(key)
      e.efforts.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
      e.defaultEffort = e.efforts.includes('high')
        ? 'high'
        : e.efforts.includes('medium')
          ? 'medium'
          : e.efforts[0] || ''
      return e
    })
  }

  async listModelsViaAcpFallback() {
    const client = new AgyAcpClient({
      agyBin: this.agyBin,
      cwd: this.defaultCwd,
      autoApprove: this.autoApprove,
      log: this.log,
    })
    let sessionId = ''
    try {
      await client.start()
      const res = await client.rpc('session/new', { cwd: this.defaultCwd, mcpServers: [] }, 15_000)
      sessionId = res?.sessionId || ''
      const raw = res?.models?.availableModels || res?.availableModels || []
      return raw
        .map((m) => ({
          id: m?.modelId || m?.id || '',
          label: m?.name || m?.displayName || m?.modelId || '',
        }))
        .filter((x) => x.id)
    } catch (err) {
      this.log.warn?.(`mobile-hub: agy ACP model fallback failed: ${String(err?.message || err)}`)
      return []
    } finally {
      await client.close(sessionId).catch(() => {})
    }
  }

  async listModels() {
    if (this.modelsCache && this.modelsCache.models?.length > 0 && Date.now() - this.modelsCacheAt < 5 * 60_000) {
      return this.modelsCache
    }
    const cliVer = await this.checkCliVersion()
    if (!cliVer) {
      return {
        app: APPS.ANTIGRAVITY,
        defaultModel: '',
        defaultEffort: '',
        supportsMidChatSwitch: false,
        models: [],
        hint: process.platform === 'win32'
          ? '需先安装 Antigravity CLI (irm https://antigravity.google/cli/install.ps1 | iex)'
          : '需先安装 Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash)',
      }
    }

    const rawText = await new Promise((resolvePromise) => {
      let settled = false
      const done = (val) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(val)
      }
      let proc = null
      const timer = setTimeout(() => {
        try { proc?.kill() } catch {}
        done('')
      }, 15_000)
      try {
        proc = spawnCrossPlatform(this.agyBin, ['models'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        let out = ''
        proc.stdout.on('data', (d) => { out += d.toString('utf8') })
        proc.on('close', () => done(out))
        proc.on('error', () => done(''))
      } catch {
        done('')
      }
    })

    const cliPairs = []
    for (const rawLine of rawText.split(/\r?\n/)) {
      // Strip any ANSI escape codes or carriage-return spinner fragments
      const cleaned = rawLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split('\r').pop() || ''
      const trimmed = cleaned.trim()
      if (!trimmed || /^fetching\b/i.test(trimmed)) continue
      const cols = trimmed.includes('\t')
        ? trimmed.split('\t').map((s) => s.trim()).filter(Boolean)
        : trimmed.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)
      if (cols.length >= 2 && /^[a-z0-9._-]+$/i.test(cols[0])) {
        cliPairs.push({ id: cols[0], label: cols.slice(1).join(' ') })
      }
    }

    let models = this.parseModelPairs(cliPairs)
    if (models.length === 0) {
      // Fallback: query models directly from Desktop's shared `--app-data-dir antigravity` ACP auth!
      const acpPairs = await this.listModelsViaAcpFallback()
      models = this.parseModelPairs(acpPairs)
    }

    const catalog = {
      app: APPS.ANTIGRAVITY,
      defaultModel: models[0]?.id || '',
      defaultEffort: models[0]?.defaultEffort || '',
      supportsMidChatSwitch: models.length > 0,
      models,
    }
    if (models.length > 0) {
      this.modelsCache = catalog
      this.modelsCacheAt = Date.now()
    }
    return catalog
  }

  async resolveAcpModelId(model, reasoningEffort) {
    if (!model) return ''
    try {
      const catalog = await this.listModels()
      const matched = catalog.models.find((m) => m.id === model)
      if (matched && reasoningEffort && matched.effortModelIds?.[reasoningEffort]) {
        return matched.effortModelIds[reasoningEffort]
      }
      if (matched && matched.defaultEffort && matched.effortModelIds?.[matched.defaultEffort]) {
        return matched.effortModelIds[matched.defaultEffort]
      }
    } catch {}
    return model
  }

  async checkCliVersion() {
    if (this.cliVersionCache) return this.cliVersionCache
    this.agyBin = findAgyBinary(this.configuredBin)
    const ver = await new Promise((resolvePromise) => {
      let settled = false
      const done = (val) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(val)
      }
      let proc = null
      const timer = setTimeout(() => {
        try { proc?.kill() } catch {}
        done('')
      }, 6_000)
      try {
        proc = spawnCrossPlatform(this.agyBin, ['--version'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        let out = ''
        proc.stdout.on('data', (d) => { out += d.toString('utf8') })
        proc.on('close', (code) => done(code === 0 ? out.trim() : ''))
        proc.on('error', () => done(''))
      } catch {
        done('')
      }
    })
    if (ver) this.cliVersionCache = ver
    return ver
  }

  async getStatus() {
    const dbExists = existsSync(join(this.agyHome, 'conversation_summaries.db'))
    const cliVer = await this.checkCliVersion()
    const writable = Boolean(cliVer)
    return {
      app: APPS.ANTIGRAVITY,
      available: dbExists || writable,
      writable,
      mode: writable ? 'agy-acp-shared' : 'desktop-history-readonly',
      detail: writable
        ? `已直连 Antigravity 官方 ACP (v${cliVer})，与桌面端原生共享同一会话与缓存（零额外 Token）`
        : '仅支持 Antigravity 桌面端历史浏览；安装官方 Antigravity CLI (`agy`) 后即可原位续聊',
      activeCount: this.activeTurns.size,
    }
  }

  async listSessions({ limit = 80, search = '' } = {}) {
    const results = []
    const cliReady = Boolean(await this.checkCliVersion())
    const seen = new Set()

    const dbPath = join(this.agyHome, 'conversation_summaries.db')
    const rows = await queryAgySummariesDb(dbPath, limit, search)
    for (const r of rows) {
      seen.add(r.conversation_id)
      const cwd = parseWorkspaceUri(r.workspace_uris)
      const pref = this.sessionPrefs.get(r.conversation_id)
      results.push({
        id: makeCompositeId(APPS.ANTIGRAVITY, r.conversation_id),
        app: APPS.ANTIGRAVITY,
        nativeId: r.conversation_id,
        title: (r.title && r.title.trim()) || (r.preview && r.preview.trim().slice(0, 56)) || r.conversation_id,
        preview: String(r.preview || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        cwd,
        workspace: cwd ? basename(cwd) : 'Antigravity',
        model: pref?.model || '',
        reasoningEffort: pref?.reasoningEffort || '',
        status: this.activeTurns.has(r.conversation_id) || r.not_fully_idle ? 'running' : 'idle',
        writable: cliReady,
        readOnlyDesktop: false,
        createdAt: toEpochMs(r.last_modified_time),
        updatedAt: toEpochMs(r.last_modified_time),
      })
    }

    // Include brand-new mobile-created ACP conversations not yet indexed into conversation_summaries.db
    for (const pending of this.pendingCreated.values()) {
      if (seen.has(pending.nativeId)) {
        this.pendingCreated.delete(pending.nativeId)
        continue
      }
      if (search) {
        const q = search.toLowerCase()
        const hay = `${pending.title} ${pending.cwd}`.toLowerCase()
        if (!hay.includes(q)) continue
      }
      results.push({
        ...pending,
        status: this.activeTurns.has(pending.nativeId) ? 'running' : 'idle',
      })
    }

    results.sort((a, b) => b.updatedAt - a.updatedAt)
    return results.slice(0, limit)
  }

  async readSession(conversationId, { limit = 25, cursor = null } = {}) {
    conversationId = assertSafeSessionId(conversationId, 'Antigravity conversationId')
    const cliReady = Boolean(await this.checkCliVersion())
    const pageSize = Math.max(10, Math.min(Number(limit) || 25, 200))

    const dbPath = join(this.agyHome, 'conversation_summaries.db')
    const [allRecent, desktopRunning] = await Promise.all([
      queryAgySummariesDb(dbPath, 200, ''),
      isAntigravityDesktopRunning(),
    ])
    const meta = allRecent.find((r) => r.conversation_id === conversationId)
    const pending = this.pendingCreated.get(conversationId)
    const parsed = parseDesktopTranscript(conversationId, this.agyHome)
    const messages = parsed.messages
    const cwd = parseWorkspaceUri(meta?.workspace_uris) || pending?.cwd || ''
    const pref = this.sessionPrefs.get(conversationId)
    const fp = getTranscriptFingerprint(this.agyHome, conversationId)

    const warmEntry = this.warmSessions.get(conversationId)
    const selfActive = this.activeTurns.has(conversationId) || Boolean(warmEntry?.wakeup)
    const recentlyModified = fp.mtimeMs > 0 && Date.now() - fp.mtimeMs < 90_000
    const dbRunning = meta?.status === 'CASCADE_RUN_STATUS_RUNNING'
    const externalRunning = Boolean(
      !selfActive &&
      desktopRunning &&
      (dbRunning || (Boolean(meta?.not_fully_idle) && recentlyModified)),
    )
    const bridgeWritten = this.bridgeWrittenSessions.get(conversationId) || null
    const bridgeWrittenWithDesktopOpen = Boolean(bridgeWritten && desktopRunning)
    const diverged = Boolean(parsed.divergence)

    let syncWarning = ''
    if (diverged) {
      syncWarning =
        '检测到该对话曾发生桌面端与远程端双写分叉（已保留双方完整记录）。如需切回 Antigravity 桌面端续聊，请先重启桌面端以避免旧内存再次覆盖。'
    } else if (bridgeWrittenWithDesktopOpen) {
      syncWarning =
        '已通过 All in One 续聊本对话。Antigravity 桌面端不会热重载外部写入，如需切回桌面端继续聊，请先重启 Antigravity 桌面端。'
    }

    const title = meta?.title || pending?.title || conversationId
    const status = selfActive || externalRunning ? 'running' : 'idle'

    this.watchSession(conversationId, {
      title,
      cwd,
      cliReady,
      fp,
      status: String(meta?.status || ''),
      notFullyIdle: Boolean(meta?.not_fully_idle),
      stepCount: Number(meta?.step_count || 0),
    })

    const total = messages.length
    const endIdx =
      cursor !== null && cursor !== undefined && cursor !== '' && Number.isFinite(Number(cursor))
        ? Math.max(0, Math.min(total, Number(cursor)))
        : total
    const startIdx = Math.max(0, endIdx - pageSize)

    return {
      id: makeCompositeId(APPS.ANTIGRAVITY, conversationId),
      app: APPS.ANTIGRAVITY,
      nativeId: conversationId,
      title,
      cwd,
      model: pref?.model || '',
      reasoningEffort: pref?.reasoningEffort || '',
      writable: cliReady,
      readOnlyDesktop: false,
      status,
      syncState: {
        externalRunning,
        desktopRunning,
        diverged,
        divergence: parsed.divergence,
        bridgeWrittenWithDesktopOpen,
        latestStepIndex: parsed.latestStepIndex,
      },
      ...(syncWarning ? { syncWarning } : {}),
      messages: messages.slice(startIdx, endIdx),
      hasMore: startIdx > 0,
      nextCursor: startIdx > 0 ? String(startIdx) : null,
      totalCount: total,
    }
  }

  watchSession(conversationId, snapshot = {}) {
    if (!conversationId) return
    const fp = snapshot.fp || getTranscriptFingerprint(this.agyHome, conversationId)
    const existing = this.watchedSessions.get(conversationId)
    this.watchedSessions.delete(conversationId)
    this.watchedSessions.set(conversationId, {
      conversationId,
      lastSeenAt: Date.now(),
      mtimeMs: fp.mtimeMs,
      size: fp.size,
      status: snapshot.status ?? existing?.status ?? '',
      notFullyIdle: snapshot.notFullyIdle ?? existing?.notFullyIdle ?? false,
      stepCount: snapshot.stepCount ?? existing?.stepCount ?? 0,
      title: snapshot.title || existing?.title || conversationId,
      cwd: snapshot.cwd || existing?.cwd || '',
      cliReady: snapshot.cliReady ?? existing?.cliReady ?? true,
    })
    while (this.watchedSessions.size > MAX_WATCHED_SESSIONS) {
      const oldest = this.watchedSessions.keys().next().value
      if (!oldest) break
      this.watchedSessions.delete(oldest)
    }
    this.ensureWatcherRunning()
  }

  updateWatchSnapshot(conversationId, { fp = null, dbState = null } = {}) {
    const w = this.watchedSessions.get(conversationId)
    if (!w) return
    const nextFp = fp || getTranscriptFingerprint(this.agyHome, conversationId)
    w.mtimeMs = nextFp.mtimeMs
    w.size = nextFp.size
    if (dbState) {
      w.status = String(dbState.status || '')
      w.notFullyIdle = Boolean(dbState.notFullyIdle)
      w.stepCount = Number(dbState.stepCount || 0)
    }
    w.lastSeenAt = Date.now()
  }

  ensureWatcherRunning() {
    if (this.watchTimer || this.watchedSessions.size === 0) return
    this.watchTimer = setInterval(() => {
      void this.pollWatchedSessions().catch(() => {})
    }, this.watchPollIntervalMs)
    this.watchTimer.unref?.()
  }

  async pollWatchedSessions() {
    if (this.watchPollInFlight) return
    if (this.watchedSessions.size === 0) {
      if (this.watchTimer) {
        clearInterval(this.watchTimer)
        this.watchTimer = null
      }
      return
    }
    this.watchPollInFlight = true
    try {
      const now = Date.now()
      const dbPath = join(this.agyHome, 'conversation_summaries.db')
      for (const [sid, w] of [...this.watchedSessions.entries()]) {
        if (now - w.lastSeenAt > WATCH_TTL_MS) {
          this.watchedSessions.delete(sid)
          continue
        }
        if (this.activeTurns.has(sid) || this.warmSessions.get(sid)?.wakeup) {
          // Bridge is actively streaming this session itself; keep snapshot aligned without echoing
          const curFp = getTranscriptFingerprint(this.agyHome, sid)
          w.mtimeMs = curFp.mtimeMs
          w.size = curFp.size
          continue
        }

        const curFp = getTranscriptFingerprint(this.agyHome, sid)
        const dbState = await queryAgyConversationState(dbPath, sid)
        const nextStatus = String(dbState?.status || '')
        const nextNotIdle = Boolean(dbState?.notFullyIdle)
        const nextStepCount = Number(dbState?.stepCount || 0)

        const fileChanged = curFp.size !== w.size || curFp.mtimeMs !== w.mtimeMs
        const statusChanged =
          nextStatus !== w.status ||
          nextNotIdle !== w.notFullyIdle ||
          nextStepCount !== w.stepCount

        if (!fileChanged && !statusChanged) continue

        w.mtimeMs = curFp.mtimeMs
        w.size = curFp.size
        w.status = nextStatus
        w.notFullyIdle = nextNotIdle
        w.stepCount = nextStepCount

        const pref = this.sessionPrefs.get(sid)
        const isRunning = nextStatus === 'CASCADE_RUN_STATUS_RUNNING'
        this.emitEvent(EVENTS.SESSION_UPDATED, {
          historyChanged: fileChanged,
          statusChanged,
          externalUpdate: true,
          session: {
            id: makeCompositeId(APPS.ANTIGRAVITY, sid),
            app: APPS.ANTIGRAVITY,
            nativeId: sid,
            title: w.title,
            cwd: w.cwd,
            workspace: w.cwd ? basename(w.cwd) : 'Antigravity',
            model: pref?.model || '',
            reasoningEffort: pref?.reasoningEffort || '',
            status: isRunning ? 'running' : 'idle',
            writable: w.cliReady,
            readOnlyDesktop: false,
            updatedAt: curFp.mtimeMs || now,
          },
        })
      }

      if (this.watchedSessions.size === 0 && this.watchTimer) {
        clearInterval(this.watchTimer)
        this.watchTimer = null
      }
    } finally {
      this.watchPollInFlight = false
    }
  }

  async createSession({ cwd, title, model, reasoningEffort } = {}) {
    const cliVer = await this.checkCliVersion()
    if (!cliVer) {
      throw new Error(
        process.platform === 'win32'
          ? '本机未检测到 Antigravity CLI（请运行 irm https://antigravity.google/cli/install.ps1 | iex 安装）'
          : '本机未检测到 Antigravity CLI（请运行 curl -fsSL https://antigravity.google/cli/install.sh | bash 安装）',
      )
    }
    const targetCwd = String(cwd || '').trim() && existsSync(String(cwd).trim())
      ? String(cwd).trim()
      : this.defaultCwd

    const client = new AgyAcpClient({
      agyBin: this.agyBin,
      cwd: targetCwd,
      autoApprove: this.autoApprove,
      log: this.log,
    })

    let sessionId = ''
    const entry = this.registerWarmSession('', targetCwd, client)
    try {
      await client.start()
      const res = await client.rpc('session/new', { cwd: targetCwd, mcpServers: [] }, 25_000)
      sessionId = res?.sessionId || ''
      if (!sessionId) throw new Error('Antigravity ACP 未返回有效 sessionId')

      // Re-key warm entry under the authoritative sessionId
      this.warmSessions.delete('')
      entry.sessionId = sessionId
      entry.lastActivityAt = Date.now()
      this.warmSessions.set(sessionId, entry)

      if (model || reasoningEffort) {
        this.sessionPrefs.set(sessionId, { model: model || '', reasoningEffort: reasoningEffort || '' })
        const resolvedModel = await this.resolveAcpModelId(model, reasoningEffort)
        if (resolvedModel) {
          await client.rpc('session/set_model', { sessionId, modelId: resolvedModel }, 10_000).catch((err) => {
            this.log.warn?.(`mobile-hub: agy session/set_model(${resolvedModel}) failed: ${String(err?.message || err)}`)
          })
        }
      }
      this.ensureReaperRunning()
    } catch (err) {
      this.warmSessions.delete(sessionId || '')
      await client.close(sessionId).catch(() => {})
      throw err
    }

    const now = Date.now()
    const summary = {
      id: makeCompositeId(APPS.ANTIGRAVITY, sessionId),
      app: APPS.ANTIGRAVITY,
      nativeId: sessionId,
      title: title || '新 Antigravity 对话',
      preview: '',
      cwd: targetCwd,
      workspace: basename(targetCwd),
      model: model || '',
      reasoningEffort: reasoningEffort || '',
      status: 'idle',
      writable: true,
      readOnlyDesktop: false,
      createdAt: now,
      updatedAt: now,
    }
    this.pendingCreated.set(sessionId, summary)
    return summary
  }

  registerWarmSession(sessionId, cwd, client) {
    const fp = getTranscriptFingerprint(this.agyHome, sessionId)
    const entry = {
      sessionId,
      cwd,
      client,
      fgTurn: null,
      wakeup: null,
      lastActivityAt: Date.now(),
      lastTranscriptMtimeMs: fp.mtimeMs,
      lastTranscriptSize: fp.size,
      lastStepCount: 0,
      sawBackgroundTask: false,
    }
    client.setSessionUpdateHandler((params) => this.handleWarmSessionUpdate(entry, params))
    client.onExit = () => {
      if (entry.wakeup?.settleTimer) clearTimeout(entry.wakeup.settleTimer)
      if (entry.wakeup) {
        const compositeId = makeCompositeId(APPS.ANTIGRAVITY, entry.sessionId)
        this.emitEvent(EVENTS.STREAM_DONE, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          nativeId: entry.sessionId,
          finalText: entry.wakeup.finalText.trim(),
          aborted: false,
        })
        entry.wakeup = null
      }
      if (this.warmSessions.get(entry.sessionId) === entry) {
        this.warmSessions.delete(entry.sessionId)
      }
    }
    if (sessionId) this.warmSessions.set(sessionId, entry)
    return entry
  }

  ensureReaperRunning() {
    if (this.reaperTimer) return
    this.reaperTimer = setInterval(() => {
      void this.reapIdleSessions().catch(() => {})
    }, 30_000)
    this.reaperTimer.unref?.()
  }

  async closeWarmSession(sessionId) {
    const entry = this.warmSessions.get(sessionId)
    if (!entry) return
    this.warmSessions.delete(sessionId)
    if (entry.wakeup?.settleTimer) {
      clearTimeout(entry.wakeup.settleTimer)
      entry.wakeup.settleTimer = null
    }
    await entry.client.close(sessionId).catch(() => {})
  }

  async reapIdleSessions() {
    if (this.warmSessions.size === 0) {
      if (this.reaperTimer) {
        clearInterval(this.reaperTimer)
        this.reaperTimer = null
      }
      return
    }

    const dbPath = join(this.agyHome, 'conversation_summaries.db')
    const now = Date.now()
    const idleCandidates = []

    for (const [sid, entry] of this.warmSessions.entries()) {
      if (!entry.client.isAlive()) {
        this.warmSessions.delete(sid)
        continue
      }
      if (entry.fgTurn || entry.wakeup || this.activeTurns.has(sid)) continue

      const idleMs = now - entry.lastActivityAt
      if (idleMs < 20_000) continue // Grace window for SQLite summary write flush

      const dbState = await queryAgyConversationState(dbPath, sid)
      const busyInDb = Boolean(dbState?.notFullyIdle || dbState?.status === 'CASCADE_RUN_STATUS_RUNNING')
      if (busyInDb) {
        // NEVER kill active background tasks / subagents / timers unless exceeding 2h safety cap
        if (idleMs >= WARM_BUSY_HARD_CAP_MS) {
          this.log.warn?.(`mobile-hub: closing agy warm session ${sid} after 2h safety cap`)
          await this.closeWarmSession(sid)
        }
        continue
      }
      idleCandidates.push({ sid, idleMs })
    }

    idleCandidates.sort((a, b) => b.idleMs - a.idleMs)
    const ttlMs = idleCandidates.length > MAX_IDLE_WARM_SESSIONS ? WARM_IDLE_EXCESS_CLOSE_MS : WARM_IDLE_CLOSE_MS
    for (const { sid, idleMs } of idleCandidates) {
      if (idleMs >= ttlMs) {
        await this.closeWarmSession(sid)
      }
    }
  }

  finalizeWakeupTurn(entry) {
    if (!entry.wakeup) return
    const wk = entry.wakeup
    entry.wakeup = null
    if (wk.settleTimer) clearTimeout(wk.settleTimer)
    entry.lastActivityAt = Date.now()
    const fp = getTranscriptFingerprint(this.agyHome, entry.sessionId)
    entry.lastTranscriptMtimeMs = fp.mtimeMs
    entry.lastTranscriptSize = fp.size
    this.bridgeWrittenSessions.set(entry.sessionId, { writtenAt: Date.now(), stepCount: entry.lastStepCount || 0 })
    this.updateWatchSnapshot(entry.sessionId, { fp })
    const compositeId = makeCompositeId(APPS.ANTIGRAVITY, entry.sessionId)
    this.emitEvent(EVENTS.STREAM_DONE, {
      sessionId: compositeId,
      app: APPS.ANTIGRAVITY,
      nativeId: entry.sessionId,
      finalText: wk.finalText.trim(),
      aborted: false,
    })
  }

  scheduleWakeupSettle(entry) {
    const wk = entry.wakeup
    if (!wk) return
    if (wk.settleTimer) clearTimeout(wk.settleTimer)
    wk.settleTimer = setTimeout(async () => {
      if (entry.wakeup !== wk || entry.fgTurn) return
      const dbPath = join(this.agyHome, 'conversation_summaries.db')
      const dbState = await queryAgyConversationState(dbPath, entry.sessionId)
      const stillRunning = dbState?.status === 'CASCADE_RUN_STATUS_RUNNING'
      const silentMs = Date.now() - entry.lastActivityAt
      if (!stillRunning || silentMs >= 12_000) {
        this.finalizeWakeupTurn(entry)
      } else {
        this.scheduleWakeupSettle(entry)
      }
    }, 2_500)
    wk.settleTimer.unref?.()
  }

  handleWarmSessionUpdate(entry, params) {
    if (!entry.sessionId) return
    entry.lastActivityAt = Date.now()

    const compositeId = makeCompositeId(APPS.ANTIGRAVITY, entry.sessionId)
    const u = params?.update || {}
    const kind = u.sessionUpdate

    // Detect background task / subagent / schedule launches so we keep the ACP worker warm
    const rawToolName = String(u.name || u.title || '').toLowerCase()
    if (
      rawToolName === 'invoke_subagent' ||
      rawToolName === 'schedule' ||
      rawToolName === 'run_workflow' ||
      rawToolName === 'swarm'
    ) {
      entry.sawBackgroundTask = true
    }

    // Determine target stream state: active foreground `session/prompt` OR spontaneous reactive wakeup!
    let target = entry.fgTurn
    const isWakeup = !target
    if (isWakeup) {
      if (kind === 'turn_complete' || kind === 'done') {
        this.finalizeWakeupTurn(entry)
        return
      }
      if (
        kind !== 'agent_message_chunk' &&
        kind !== 'agent_thought_chunk' &&
        kind !== 'tool_call' &&
        kind !== 'tool_call_update'
      ) {
        return
      }
      if (!entry.wakeup) {
        entry.wakeup = {
          finalText: '',
          seenToolStarts: new Set(),
          seenToolEnds: new Set(),
          settleTimer: null,
          startedAt: Date.now(),
        }
        this.emitEvent(EVENTS.STREAM_START, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          nativeId: entry.sessionId,
        })
      }
      target = entry.wakeup
      this.scheduleWakeupSettle(entry)
    }

    if (kind === 'agent_message_chunk') {
      const delta = extractAcpText(u.content)
      if (delta) {
        target.finalText += delta
        this.emitEvent(EVENTS.STREAM_DELTA, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          delta,
        })
      }
      return
    }

    if (kind === 'agent_thought_chunk') {
      const delta = extractAcpText(u.content)
      if (delta) {
        this.emitEvent(EVENTS.STREAM_THINKING, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          delta,
        })
      }
      return
    }

    if (kind === 'tool_call') {
      const toolId = u.toolCallId || `agy-tool-${Date.now()}`
      if (!target.seenToolStarts.has(toolId)) {
        target.seenToolStarts.add(toolId)
        this.emitEvent(EVENTS.STREAM_TOOL_START, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          tool: {
            id: toolId,
            name: u.name || u.title || 'tool',
            input: u.args ?? u.rawInput ?? {},
          },
        })
      }
      return
    }

    if (kind === 'tool_call_update') {
      const toolId = u.toolCallId
      if (!toolId) return
      if (!target.seenToolStarts.has(toolId)) {
        target.seenToolStarts.add(toolId)
        this.emitEvent(EVENTS.STREAM_TOOL_START, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          tool: {
            id: toolId,
            name: u.name || u.title || 'tool',
            input: u.args ?? u.rawInput ?? {},
          },
        })
      }
      const outStr = extractAcpText(u.content) ||
        (typeof u.rawOutput === 'string' ? u.rawOutput : u.rawOutput ? JSON.stringify(u.rawOutput) : '')
      if (/running as a background task|background task with task id/i.test(String(outStr))) {
        entry.sawBackgroundTask = true
      }
      if ((u.status === 'completed' || u.status === 'failed' || u.status === 'error') && !target.seenToolEnds.has(toolId)) {
        target.seenToolEnds.add(toolId)
        this.emitEvent(EVENTS.STREAM_TOOL_END, {
          sessionId: compositeId,
          app: APPS.ANTIGRAVITY,
          toolId,
          status: u.status === 'failed' || u.status === 'error' ? 'error' : 'completed',
          output: String(outStr || '').slice(0, 3000),
        })
      }
    }
  }

  async acquireWarmSession(sessionId, targetCwd) {
    const dbPath = join(this.agyHome, 'conversation_summaries.db')
    const existing = this.warmSessions.get(sessionId)
    if (existing && existing.client.isAlive()) {
      const dbState = await queryAgyConversationState(dbPath, sessionId)
      const curFp = getTranscriptFingerprint(this.agyHome, sessionId)
      const busyInDb = Boolean(dbState?.notFullyIdle || dbState?.status === 'CASCADE_RUN_STATUS_RUNNING')

      // Exact disk change check: if Antigravity Desktop wrote even a single step since our ACP
      // worker's last write (size, mtime, or step_count changed), close the stale ACP process
      // and resume fresh from disk so mobile NEVER runs on stale context!
      const fileChanged =
        (existing.lastTranscriptSize > 0 && curFp.size !== existing.lastTranscriptSize) ||
        (existing.lastTranscriptMtimeMs > 0 && curFp.mtimeMs !== existing.lastTranscriptMtimeMs) ||
        (existing.lastStepCount > 0 && dbState?.stepCount > 0 && dbState.stepCount !== existing.lastStepCount)

      const desktopModified = !existing.wakeup && !existing.sawBackgroundTask && fileChanged

      if (!desktopModified && !(busyInDb && fileChanged)) {
        existing.lastActivityAt = Date.now()
        return existing
      }
      await this.closeWarmSession(sessionId)
    } else if (existing) {
      this.warmSessions.delete(sessionId)
    }

    const client = new AgyAcpClient({
      agyBin: this.agyBin,
      cwd: targetCwd,
      autoApprove: this.autoApprove,
      log: this.log,
    })
    const entry = this.registerWarmSession(sessionId, targetCwd, client)
    try {
      await client.start()
      await client.rpc('session/resume', { sessionId, cwd: targetCwd, mcpServers: [] }, 30_000)
      const [fp, dbState] = await Promise.all([
        Promise.resolve(getTranscriptFingerprint(this.agyHome, sessionId)),
        queryAgyConversationState(dbPath, sessionId),
      ])
      entry.lastTranscriptMtimeMs = fp.mtimeMs
      entry.lastTranscriptSize = fp.size
      entry.lastStepCount = Number(dbState?.stepCount || 0)
      entry.lastActivityAt = Date.now()
      this.ensureReaperRunning()
      return entry
    } catch (err) {
      if (this.warmSessions.get(sessionId) === entry) {
        this.warmSessions.delete(sessionId)
      }
      await client.close(sessionId).catch(() => {})
      throw err
    }
  }

  async sendMessage(sessionId, { text, cwd, attachments = [], model, reasoningEffort } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'Antigravity conversationId')
    const compositeId = makeCompositeId(APPS.ANTIGRAVITY, sessionId)

    let entry = null
    let failedHard = false
    try {
      const cliVer = await this.checkCliVersion()
      if (!cliVer) {
        throw new Error(
        process.platform === 'win32'
          ? '本机未检测到 Antigravity CLI（请运行 irm https://antigravity.google/cli/install.ps1 | iex 安装）'
          : '本机未检测到 Antigravity CLI（请运行 curl -fsSL https://antigravity.google/cli/install.sh | bash 安装）',
      )
      }
      if (this.activeTurns.has(sessionId)) {
        throw new Error('该 Antigravity 对话正在运行中，请等待完成或先点击停止。')
      }

      // Guard against concurrent split-brain writes when Antigravity Desktop is actively executing this exact turn!
      const dbPath = join(this.agyHome, 'conversation_summaries.db')
      const existingWarm = this.warmSessions.get(sessionId)
      if (!existingWarm?.wakeup && !existingWarm?.sawBackgroundTask) {
        const [dbState, desktopRunning] = await Promise.all([
          queryAgyConversationState(dbPath, sessionId),
          isAntigravityDesktopRunning(true),
        ])
        const fp = getTranscriptFingerprint(this.agyHome, sessionId)
        const bridgeWrite = this.bridgeWrittenSessions.get(sessionId)
        const writtenByExternal = !bridgeWrite || fp.mtimeMs > bridgeWrite.writtenAt + 1_500
        const recentlyWritten = fp.mtimeMs > 0 && Date.now() - fp.mtimeMs < 90_000
        const desktopActivelyRunning =
          desktopRunning &&
          writtenByExternal &&
          recentlyWritten &&
          (dbState?.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(dbState?.notFullyIdle))
        if (desktopActivelyRunning) {
          throw new Error(
            'Antigravity 桌面端正在处理当前对话，请等待桌面端本轮回复完成后再发送（All in One 会自动实时同步进度），避免双端同时写入导致记录分叉。',
          )
        }
      }

      // Resolve real workspace directory from Desktop summary DB or pending map
      let targetCwd = String(cwd || '').trim()
      if (!targetCwd) {
        const pending = this.pendingCreated.get(sessionId)
        targetCwd = pending?.cwd || ''
      }
      if (!targetCwd) {
        const allRecent = await queryAgySummariesDb(join(this.agyHome, 'conversation_summaries.db'), 200, '')
        const meta = allRecent.find((r) => r.conversation_id === sessionId)
        targetCwd = parseWorkspaceUri(meta?.workspace_uris) || ''
      }
      if (!targetCwd || !existsSync(targetCwd)) targetCwd = this.defaultCwd

      // Build native ACP multimodal prompt (ZERO injected wrapper text!)
      const promptBlocks = []
      const fileLines = []
      for (const att of attachments) {
        if (att.localPath && existsSync(att.localPath) && String(att.mimeType || '').startsWith('image/')) {
          try {
            const b64 = readFileSync(att.localPath).toString('base64')
            promptBlocks.push({
              type: 'image',
              data: b64,
              mimeType: att.mimeType || 'image/png',
            })
            continue
          } catch {}
        }
        if (att.localPath || att.filename) {
          fileLines.push(`- 附件：${att.localPath || att.filename}`)
        }
      }

      let promptText = String(text || '').trim()
      if (fileLines.length > 0) {
        promptText = `${promptText}${promptText ? '\n\n' : ''}${fileLines.join('\n')}`
      }
      if (promptText) {
        promptBlocks.unshift({ type: 'text', text: promptText })
      }
      if (promptBlocks.length === 0) {
        throw new Error('消息内容不能为空')
      }

      const pref = this.sessionPrefs.get(sessionId)
      const effectiveModel = model || pref?.model || ''
      const effectiveEffort = reasoningEffort !== undefined ? reasoningEffort : pref?.reasoningEffort || ''
      if (effectiveModel || effectiveEffort) {
        this.sessionPrefs.set(sessionId, { model: effectiveModel, reasoningEffort: effectiveEffort })
      }

      entry = await this.acquireWarmSession(sessionId, targetCwd)
      // If a spontaneous wakeup was still finalizing, close its bubble cleanly before starting user's new turn
      if (entry.wakeup) {
        this.finalizeWakeupTurn(entry)
      }

      const fgTurn = {
        finalText: '',
        seenToolStarts: new Set(),
        seenToolEnds: new Set(),
        aborted: false,
      }
      entry.fgTurn = fgTurn

      const turnState = { client: entry.client, aborted: false }
      this.activeTurns.set(sessionId, turnState)

      this.emitEvent(EVENTS.STREAM_START, {
        sessionId: compositeId,
        app: APPS.ANTIGRAVITY,
        nativeId: sessionId,
      })

      if (effectiveModel) {
        const resolvedModel = await this.resolveAcpModelId(effectiveModel, effectiveEffort)
        if (resolvedModel) {
          await entry.client.rpc('session/set_model', { sessionId, modelId: resolvedModel }, 10_000).catch((err) => {
            this.log.warn?.(`mobile-hub: agy session/set_model(${resolvedModel}) failed: ${String(err?.message || err)}`)
          })
        }
      }

      // Sliding 15-min inactivity timeout (resets on every session/update chunk!)
      const promptRes = await entry.client.rpc(
        'session/prompt',
        { sessionId, prompt: promptBlocks },
        15 * 60_000,
        { sliding: true },
      )

      const aborted = turnState.aborted || promptRes?.stopReason === 'cancelled'
      const cleanFinal = fgTurn.finalText.trim()
      this.pendingCreated.delete(sessionId)

      this.emitEvent(EVENTS.STREAM_DONE, {
        sessionId: compositeId,
        app: APPS.ANTIGRAVITY,
        nativeId: sessionId,
        finalText: cleanFinal,
        aborted,
      })

      return {
        sessionId: compositeId,
        nativeId: sessionId,
        finalText: cleanFinal,
        aborted,
        usage: promptRes?.usage || null,
      }
    } catch (err) {
      failedHard = !entry?.client?.isAlive()
      this.emitEvent(EVENTS.STREAM_ERROR, {
        sessionId: compositeId,
        app: APPS.ANTIGRAVITY,
        message: String(err?.message || err),
      })
      throw err
    } finally {
      this.activeTurns.delete(sessionId)
      if (entry) {
        entry.fgTurn = null
        entry.lastActivityAt = Date.now()
        const dbPath = join(this.agyHome, 'conversation_summaries.db')
        const snapNow = async () => {
          const fp = getTranscriptFingerprint(this.agyHome, sessionId)
          const dbState = await queryAgyConversationState(dbPath, sessionId).catch(() => null)
          entry.lastTranscriptMtimeMs = fp.mtimeMs
          entry.lastTranscriptSize = fp.size
          if (dbState?.stepCount) entry.lastStepCount = Number(dbState.stepCount)
          this.bridgeWrittenSessions.set(sessionId, {
            writtenAt: Date.now(),
            stepCount: Number(dbState?.stepCount || entry.lastStepCount || 0),
          })
          this.updateWatchSnapshot(sessionId, { fp, dbState })
        }
        await snapNow()
        // Re-snapshot shortly after turn end to capture trailing SQLite/transcript flush
        const settleSnap = setTimeout(() => { void snapNow().catch(() => {}) }, 450)
        settleSnap.unref?.()

        if (failedHard) {
          await this.closeWarmSession(sessionId)
        } else {
          // Keep warm ACP worker alive so background tasks / subagents / timers NEVER get canceled on turn end!
          this.ensureReaperRunning()
        }
      }
    }
  }

  async interrupt(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'Antigravity conversationId')
    const active = this.activeTurns.get(sessionId)
    if (active) {
      active.aborted = true
      active.client?.notify('session/cancel', { sessionId })
      return { interrupted: true, sessionId }
    }
    const warm = this.warmSessions.get(sessionId)
    if (warm?.client?.isAlive()) {
      warm.client.notify('session/cancel', { sessionId })
      return { interrupted: true, sessionId }
    }
    return { interrupted: false, sessionId }
  }

  async dispose() {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = null
    }
    if (this.watchTimer) {
      clearInterval(this.watchTimer)
      this.watchTimer = null
    }
    this.watchedSessions.clear()
    for (const active of this.activeTurns.values()) {
      active.client?.killImmediate()
    }
    this.activeTurns.clear()
    for (const entry of this.warmSessions.values()) {
      if (entry.wakeup?.settleTimer) clearTimeout(entry.wakeup.settleTimer)
      entry.client?.killImmediate()
    }
    this.warmSessions.clear()
  }
}
