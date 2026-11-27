import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import WebSocket from 'ws'
import {
  APPS,
  EVENTS,
  assertSafeCliToken,
  assertSafeSessionId,
  makeCompositeId,
  toEpochMs,
} from '../protocol.js'
import { mergeAndCompactMessages } from '../helpers/history-normalize.js'
import {
  findKimiDataDir,
  findKimiDesktopLogDir,
} from '../helpers/bin-finder.js'
import { createTaskStateTracker, normalizeGoalStatus, normalizeTaskMode } from '../helpers/task-state.js'
import { BaseAdapter } from './base-adapter.js'
import {
  getDatabaseSync,
  readTailLinesZeroOom,
  runPythonSqliteJson,
} from '../primitives/io-utils.js'
import { BoundedLruMap } from '../primitives/lru.js'
import { QuotaCacheManager } from '../primitives/quota-cache.js'

const KIMI_DEFAULT_SESSION_KEY = 'agent:main:main'
const KIMI_RPC_TIMEOUT_MS = 15_000
const KIMI_CONNECT_TIMEOUT_MS = 3_500
const KIMI_TURN_INACTIVITY_TIMEOUT_MS = 15 * 60_000
const KIMI_QUOTA_CACHE_TTL_MS = 30_000
const KIMI_LOG_TAIL_BYTES = 512 * 1024
const KIMI_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60

const KIMI_VALID_THINKING_LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'xhigh', 'max'])

const KIMI_FALLBACK_MODELS = Object.freeze([
  {
    id: 'k3-agent',
    name: 'Kimi K3 Agent',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'k3d1-agent',
    name: 'Kimi K3.1 Agent',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'k2d8-preview',
    name: 'Kimi K2.8 Preview',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  },
])

const KIMI_MODEL_LABELS = new Map([
  ['k3-agent', 'Kimi K3 Agent'],
  ['k3d1-agent', 'Kimi K3.1 Agent'],
  ['k2d8-preview', 'Kimi K2.8 Preview'],
  ['k2.5', 'Kimi K2.5'],
  ['k2-thinking', 'Kimi K2 Thinking'],
])

const KIMI_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Format a Kimi model alias into a clean display label.
 */
export function formatKimiModelName(rawId, rawLabel = '') {
  const id = String(rawId || '').trim()
  const label = String(rawLabel || '').trim()
  if (label && label !== id) return label
  if (!id) return 'Kimi'
  const known = KIMI_MODEL_LABELS.get(id.toLowerCase())
  if (known) return known
  // Convert patterns like `k3d1-agent` -> `Kimi K3.1 Agent`
  const versionMatch = /^k(\d+)d(\d+)(?:-(.+))?$/i.exec(id)
  if (versionMatch) {
    const suffix = versionMatch[3]
      ? ` ${versionMatch[3].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`
      : ''
    return `Kimi K${versionMatch[1]}.${versionMatch[2]}${suffix}`
  }
  const majorMatch = /^k(\d+)(?:-(.+))?$/i.exec(id)
  if (majorMatch) {
    const suffix = majorMatch[2]
      ? ` ${majorMatch[2].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`
      : ''
    return `Kimi K${majorMatch[1]}${suffix}`
  }
  return id
}

/**
 * Clamp a requested thinking/reasoning effort into Kimi's valid enum and model-supported efforts.
 */
export function normalizeKimiThinkingLevel(rawEffort, supportedEfforts = [], defaultEffort = 'high') {
  const raw = String(rawEffort || '').trim().toLowerCase()
  if (!raw) return ''
  const allowed = Array.isArray(supportedEfforts) && supportedEfforts.length > 0
    ? supportedEfforts.map((v) => String(v).trim().toLowerCase()).filter((v) => KIMI_VALID_THINKING_LEVELS.includes(v))
    : [...KIMI_VALID_THINKING_LEVELS]
  if (allowed.includes(raw)) return raw
  if ((raw === 'disabled' || raw === 'none') && allowed.includes('off')) return 'off'
  if ((raw === 'disabled' || raw === 'none' || raw === 'off') && allowed.includes('low')) return 'low'
  if ((raw === 'medium' || raw === 'enabled') && allowed.includes('high')) return 'high'
  if (raw === 'xhigh' && allowed.includes('max')) return 'max'
  if (raw === 'minimal' && allowed.includes('low')) return 'low'
  const def = String(defaultEffort || '').trim().toLowerCase()
  if (def && allowed.includes(def)) return def
  return allowed[0] || ''
}

/**
 * Validate that a Kimi Control WebSocket endpoint URL targets localhost/loopback only,
 * preventing bearer tokens read from `runner.state.json` from ever leaving the machine.
 */
export function assertLoopbackControlUrl(rawUrl) {
  const s = String(rawUrl || '').trim()
  if (!s) throw new Error('Kimi Control URL 为空')
  let parsed
  try {
    parsed = new URL(s)
  } catch {
    throw new Error('Kimi Control URL 格式非法')
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Kimi Control URL 协议不受支持：${parsed.protocol}`)
  }
  const host = parsed.hostname.toLowerCase()
  if (!KIMI_LOOPBACK_HOSTS.has(host)) {
    throw new Error(`出于安全限制，拒绝连接非本机回环地址的 Kimi Control 端点：${host}`)
  }
  return parsed.toString()
}

/**
 * Strip Kimi's internal injected `<system>...</system>` / `<system-reminder>...</system-reminder>`
 * wrapper blocks from raw `wire.jsonl` user turns.
 */
export function stripKimiInjectedPromptBlocks(rawText) {
  let s = String(rawText ?? '')
  if (!s) return ''
  // Remove leading/standalone <system>...</system> and <system-reminder>...</system-reminder> blocks
  s = s.replace(/<system>[\s\S]*?<\/system>\s*/gi, '')
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi, '')
  return s.trim()
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function parseToolArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return {}
  if (typeof rawArgs === 'object') return rawArgs
  const s = String(rawArgs).trim()
  if (!s) return {}
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    const parsed = safeJsonParse(s, null)
    if (parsed !== null) return parsed
  }
  return { raw: s }
}

function normalizeControlParts(parts = []) {
  const textChunks = []
  const thinkChunks = []
  const tools = []
  const toolById = new Map()

  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue
    const kind = String(part.kind || part.type || '').trim()
    if (kind === 'text') {
      const t = typeof part.text === 'string' ? part.text : ''
      if (t) textChunks.push(t)
    } else if (kind === 'reasoning' || kind === 'think' || kind === 'thinking') {
      const r = typeof part.text === 'string'
        ? part.text
        : typeof part.think === 'string'
          ? part.think
          : ''
      if (r) thinkChunks.push(r)
    } else if (kind === 'tool-call') {
      const id = String(part.toolCallId || part.id || `tool-${tools.length}`)
      const rec = {
        id,
        name: String(part.toolName || part.name || 'tool'),
        input: parseToolArgs(part.args ?? part.input),
        status: 'running',
        output: '',
      }
      tools.push(rec)
      toolById.set(id, rec)
    } else if (kind === 'tool-result') {
      const id = String(part.toolCallId || part.id || '')
      const output = String(part.summary ?? part.output ?? part.text ?? '')
      const status = part.isError ? 'error' : 'completed'
      const existing = id ? toolById.get(id) : null
      if (existing) {
        existing.status = status
        if (output) existing.output = output
      } else {
        tools.push({
          id: id || `tool-res-${tools.length}`,
          name: String(part.toolName || part.name || 'tool'),
          input: {},
          status,
          output,
        })
      }
    }
  }

  return {
    text: textChunks.join('\n').trim(),
    thinking: thinkChunks.join('\n\n').trim(),
    tools,
  }
}

/**
 * Normalize messages returned by Kimi Control RPC `conversations.getMessages`.
 */
export function normalizeKimiControlMessages(rawMessages = []) {
  const out = []
  for (let i = 0; i < (Array.isArray(rawMessages) ? rawMessages.length : 0); i++) {
    const m = rawMessages[i]
    if (!m || typeof m !== 'object') continue
    const role = String(m.role || '').trim().toLowerCase()
    if (role !== 'user' && role !== 'assistant') continue
    const parsed = normalizeControlParts(m.parts)
    const text = role === 'user' ? stripKimiInjectedPromptBlocks(parsed.text) : parsed.text
    if (!text && !parsed.thinking && parsed.tools.length === 0) continue
    // Mark historical tools completed unless explicitly errored
    for (const tool of parsed.tools) {
      if (tool.status === 'running' && m.status !== 'streaming' && m.status !== 'running') {
        tool.status = 'completed'
      }
    }
    out.push({
      id: String(m.id || `kimi-${i}`),
      role,
      text,
      thinking: parsed.thinking,
      tools: parsed.tools,
      ts: toEpochMs(m.updatedAt || m.createdAt || 0),
    })
  }
  return mergeAndCompactMessages(out)
}

/**
 * Normalize offline conversation history from Kimi's `wire.jsonl` file.
 */
export function normalizeKimiWireJsonl(jsonlText) {
  const lines = String(jsonlText || '').split(/\r?\n/)
  const out = []
  const toolIndex = new Map()
  let idx = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const obj = safeJsonParse(trimmed, null)
    if (!obj || typeof obj !== 'object') continue
    if (obj.type !== 'agent.message.appended') continue

    const inner = obj.message?.message || obj.message
    if (!inner || typeof inner !== 'object') continue
    const role = String(inner.role || '').trim().toLowerCase()
    const ts = toEpochMs(obj.time || obj.message?.time || 0)

    if (role === 'tool') {
      const tcId = String(inner.toolCallId || inner.tool_call_id || '')
      const content = Array.isArray(inner.content)
        ? inner.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n')
        : typeof inner.content === 'string'
          ? inner.content
          : ''
      if (tcId && toolIndex.has(tcId)) {
        const rec = toolIndex.get(tcId)
        rec.status = inner.isError ? 'error' : 'completed'
        if (content) rec.output = content
      }
      continue
    }

    if (role !== 'user' && role !== 'assistant') continue

    const textParts = []
    const thinkParts = []
    const tools = []
    const contentArr = Array.isArray(inner.content)
      ? inner.content
      : typeof inner.content === 'string'
        ? [{ type: 'text', text: inner.content }]
        : []

    for (const part of contentArr) {
      if (!part || typeof part !== 'object') continue
      const t = String(part.type || part.kind || '').toLowerCase()
      if (t === 'text' && typeof part.text === 'string') {
        textParts.push(part.text)
      } else if ((t === 'think' || t === 'thinking' || t === 'reasoning') && typeof (part.think ?? part.text) === 'string') {
        thinkParts.push(part.think ?? part.text)
      }
    }

    for (const tc of Array.isArray(inner.toolCalls) ? inner.toolCalls : []) {
      if (!tc || typeof tc !== 'object') continue
      const id = String(tc.id || tc.toolCallId || `wire-tool-${idx}-${tools.length}`)
      const name = String(tc.function?.name || tc.name || 'tool')
      const args = parseToolArgs(tc.function?.arguments ?? tc.arguments ?? tc.input)
      const rec = { id, name, input: args, status: 'completed', output: '' }
      tools.push(rec)
      toolIndex.set(id, rec)
    }

    let text = textParts.join('\n').trim()
    if (role === 'user') {
      text = stripKimiInjectedPromptBlocks(text)
    }
    const thinking = thinkParts.join('\n\n').trim()
    if (!text && !thinking && tools.length === 0) continue

    out.push({
      id: `wire-${idx++}`,
      role,
      text,
      thinking,
      tools,
      ts,
    })
  }

  return mergeAndCompactMessages(out)
}

/**
 * Passively parse Kimi Desktop's `logs/main.log` for real-time subscription usage (`omniRatio`, `resetAt`, `isMember`).
 */
export function readKimiQuotaFromLogs(logDir) {
  if (!logDir) return null
  const logFile = join(logDir, 'main.log')
  if (!existsSync(logFile)) return null
  const lines = readTailLinesZeroOom(logFile, KIMI_LOG_TAIL_BYTES)
  if (!lines || lines.length === 0) return null

  const subRe =
    /^\[([^\]]+)\].*\[SubscriptionManager\]\s+refreshed\(sub\):\s+level=(\S+)\s+isMember=(true|false)\s+omniRatio=([0-9.eE+-]+)\s+exhausted=(true|false)\s+resetAt=(\S+)/
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = subRe.exec(lines[i])
    if (!m) continue
    const tsStr = m[1]
    const level = Number(m[2])
    const isMember = m[3] === 'true'
    const omniRatio = Number(m[4])
    const exhausted = m[5] === 'true'
    const resetAtRaw = m[6]
    if (!Number.isFinite(omniRatio)) continue

    const usedFraction = Math.max(0, Math.min(1, omniRatio))
    const remainingPercent = exhausted
      ? 0
      : Math.max(0, Math.min(100, Math.round((1 - usedFraction) * 100)))
    const resetsAt = resetAtRaw && resetAtRaw !== 'none' && resetAtRaw !== 'null'
      ? toEpochMs(resetAtRaw)
      : 0
    const updatedAt = toEpochMs(tsStr.replace(' ', 'T')) || Date.now()

    let planType = 'Free'
    if (isMember) {
      planType = Number.isFinite(level) && level >= 30 ? 'Ultra' : 'Member'
    }

    return {
      planType,
      windowKind: 'weekly',
      windowMinutes: KIMI_WEEKLY_WINDOW_MINUTES,
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetsAt,
      exhausted,
      updatedAt,
      source: 'kimi-desktop-log',
    }
  }
  return null
}

function readKimiConfigFile(kimiDataDir) {
  if (!kimiDataDir) return null
  const cfgPath = join(kimiDataDir, 'config.json')
  if (!existsSync(cfgPath)) return null
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch {
    return null
  }
}

function readKimiRunnerEndpoint(kimiDataDir) {
  if (!kimiDataDir) return null
  const statePath = join(kimiDataDir, 'agents', 'main', 'runner.state.json')
  if (!existsSync(statePath)) return null
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    const ep = raw?.control?.endpoint
    if (!ep?.url) return null
    const url = assertLoopbackControlUrl(ep.url)
    const token = String(ep?.auth?.token || '').trim()
    return {
      url,
      token,
      pid: Number(raw?.pid || 0) || 0,
      updatedAt: toEpochMs(raw?.updatedAt || raw?.startedAt || 0),
    }
  } catch {
    return null
  }
}

function buildInlineAttachmentPrompt(text, attachments = []) {
  const cleanText = String(text || '').trim()
  const lines = []
  for (const att of Array.isArray(attachments) ? attachments : []) {
    if (!att) continue
    const localPath = String(att.localPath || att.path || '').trim()
    if (!localPath) continue
    const mime = String(att.mimeType || '').toLowerCase()
    const isMedia = mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')
    const hint = isMedia ? '（请使用 ReadMediaFile 查看）' : '（请使用 Read 查看）'
    lines.push(`[附件] ${localPath} ${hint}`)
  }
  if (lines.length === 0) return cleanText
  return cleanText ? `${lines.join('\n')}\n\n${cleanText}` : lines.join('\n')
}

function normalizeKimiGoalToTaskState(goalObj) {
  if (!goalObj || typeof goalObj !== 'object') return null
  const objective = String(goalObj.objective || goalObj.title || goalObj.text || '').trim()
  if (!objective) return null
  return {
    mode: 'goal',
    goal: {
      objective,
      status: normalizeGoalStatus(goalObj.status || goalObj.state || 'active'),
    },
  }
}

function formatKimiError(err) {
  const raw = String(err?.message || err || '').trim()
  if (!raw) return 'Kimi 执行失败'
  if (/ECONNREFUSED|ENOTFOUND|closed|not connected|socket hang up/i.test(raw)) {
    return 'Kimi 桌面端未运行或连接已断开，请先打开本机 Kimi 桌面端后重试。'
  }
  if (/ATTACHMENTS_UNSUPPORTED/i.test(raw)) {
    return '当前 Kimi 桌面端版本暂不支持直接二进制附件参数，请重试。'
  }
  if (/unauthorized|401|403|invalid token/i.test(raw)) {
    return 'Kimi 桌面端本地控制鉴权已过期，请刷新后重试。'
  }
  return raw
}

export class KimiAdapter extends BaseAdapter {
  constructor({ config = {}, log = console, emitEvent, onApprovalRequest } = {}) {
    super(APPS.KIMI, {
      config,
      log,
      emitEvent,
      onApprovalRequest,
      capabilities: {
        supportsWorkspaces: true,
        supportsSetup: false,
        supportsApproval: true,
        supportsMidChatSwitch: true,
        supportsAttachments: true,
        supportsQuota: true,
      },
    })

    this.configuredDataDir = String(config.kimiDataDir || process.env.KIMI_DAIMON_DIR || '').trim()
    this.kimiDataDir = findKimiDataDir({ configuredDir: this.configuredDataDir })
    this.kimiLogDir = findKimiDesktopLogDir({
      kimiDataDir: this.kimiDataDir,
      strict: Boolean(this.configuredDataDir),
    })

    /** @type {WebSocket | null} */
    this.ws = null
    this.wsEndpointUrl = ''
    this.wsEndpointToken = ''
    this._connectPromise = null
    this._rpcNextId = 1
    /** @type {Map<string, { resolve: Function, reject: Function, timer: any }>} */
    this._pendingRpc = new Map()

    /** @type {BoundedLruMap<string, string>} conversationId -> conversationKey */
    this.convKeyById = new BoundedLruMap(512)
    /** @type {BoundedLruMap<string, any>} conversationId -> summary metadata */
    this.convMetaById = new BoundedLruMap(512)
    /** @type {Map<string, any>} nativeId -> active turn state */
    this.activeTurns = new Map()
    /** @type {Map<string, any>} interactionId -> pending interaction */
    this.pendingInteractions = new Map()
    /** @type {Map<string, any>} external streaming state keyed by conversationKey */
    this._externalStreams = new Map()

    this._modelsCache = null
    this._modelsCacheAt = 0

    this.quotaCache = new QuotaCacheManager({
      app: APPS.KIMI,
      ttlMs: KIMI_QUOTA_CACHE_TTL_MS,
      emitEvent: this.emitEvent,
      fetcher: async () => {
        this._refreshDirs()
        return readKimiQuotaFromLogs(this.kimiLogDir)
      },
    })
  }

  _refreshDirs() {
    const nextData = findKimiDataDir({ configuredDir: this.configuredDataDir })
    if (nextData || this.configuredDataDir) this.kimiDataDir = nextData
    const nextLog = findKimiDesktopLogDir({
      kimiDataDir: this.kimiDataDir,
      strict: Boolean(this.configuredDataDir),
    })
    if (nextLog || this.configuredDataDir) this.kimiLogDir = nextLog
  }

  refreshBinary() {
    this._refreshDirs()
    this._modelsCache = null
    this._modelsCacheAt = 0
  }

  _getSqlitePath() {
    if (!this.kimiDataDir) return ''
    return join(this.kimiDataDir, 'agents', 'main', 'sessions', 'hosted-logical', 'conversations.sqlite')
  }

  _isControlConnected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN)
  }

  _closeWs(reason = 'Kimi Control 连接已关闭') {
    const ws = this.ws
    this.ws = null
    this.wsEndpointUrl = ''
    this.wsEndpointToken = ''
    for (const [id, entry] of this._pendingRpc.entries()) {
      this.clearTrackedTimer(entry.timer)
      entry.reject(new Error(reason))
      this._pendingRpc.delete(id)
    }
    for (const [nativeId, turn] of this.activeTurns.entries()) {
      if (turn.settled) continue
      turn.settled = true
      this.clearTrackedTimer(turn.inactivityTimer)
      const err = new Error(formatKimiError(reason))
      this.emitEvent(EVENTS.STREAM_ERROR, {
        app: APPS.KIMI,
        sessionId: makeCompositeId(APPS.KIMI, nativeId),
        nativeId,
        error: err.message,
      })
      err._streamErrorEmitted = true
      turn.reject(err)
      this.activeTurns.delete(nativeId)
    }
    for (const interactionId of [...this.pendingInteractions.keys()]) {
      this.pendingInteractions.delete(interactionId)
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, { id: interactionId, app: APPS.KIMI, cancelled: true })
    }
    this._externalStreams.clear()
    if (ws) {
      try { ws.removeAllListeners() } catch {}
      try { ws.terminate() } catch {}
    }
  }

  async _ensureConnected({ forceReloadEndpoint = false } = {}) {
    if (this.disposed) throw new Error('KimiAdapter 已释放')
    this._refreshDirs()
    const ep = readKimiRunnerEndpoint(this.kimiDataDir)
    if (!ep) {
      this._closeWs('Kimi 桌面端未运行')
      throw new Error('Kimi 桌面端未运行（未检测到 runner.state.json）')
    }

    if (
      !forceReloadEndpoint &&
      this._isControlConnected() &&
      this.wsEndpointUrl === ep.url &&
      this.wsEndpointToken === ep.token
    ) {
      return this.ws
    }

    if (this.ws && (this.wsEndpointUrl !== ep.url || this.wsEndpointToken !== ep.token || forceReloadEndpoint)) {
      this._closeWs('Kimi Control 端点已变更，正在重连')
    }

    if (this._connectPromise) return this._connectPromise

    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false
      const headers = ep.token ? { Authorization: `Bearer ${ep.token}` } : {}
      const ws = new WebSocket(ep.url, {
        headers,
        handshakeTimeout: KIMI_CONNECT_TIMEOUT_MS,
      })
      const timer = this.setTrackedTimeout(() => {
        if (settled) return
        settled = true
        try { ws.terminate() } catch {}
        reject(new Error('连接 Kimi 桌面端本地控制服务超时'))
      }, KIMI_CONNECT_TIMEOUT_MS + 500)

      ws.once('open', () => {
        if (settled || this.disposed) {
          try { ws.close() } catch {}
          return
        }
        settled = true
        this.clearTrackedTimer(timer)
        this.ws = ws
        this.wsEndpointUrl = ep.url
        this.wsEndpointToken = ep.token

        ws.on('message', (data) => this._handleWsMessage(data))
        ws.on('close', () => {
          if (this.ws === ws) this._closeWs('Kimi 桌面端连接已断开')
        })
        ws.on('error', () => {
          if (this.ws === ws) this._closeWs('Kimi 桌面端连接异常')
        })
        resolve(ws)
      })

      ws.once('error', (err) => {
        if (settled) return
        settled = true
        this.clearTrackedTimer(timer)
        try { ws.terminate() } catch {}
        reject(new Error(formatKimiError(err)))
      })

      ws.once('close', () => {
        if (settled) return
        settled = true
        this.clearTrackedTimer(timer)
        reject(new Error('Kimi 桌面端拒绝了本地控制连接'))
      })
    }).finally(() => {
      this._connectPromise = null
    })

    return this._connectPromise
  }

  async _rpc(method, params = {}, { timeoutMs = KIMI_RPC_TIMEOUT_MS } = {}) {
    const ws = await this._ensureConnected()
    return new Promise((resolve, reject) => {
      const id = String(this._rpcNextId++)
      const timer = this.setTrackedTimeout(() => {
        this._pendingRpc.delete(id)
        reject(new Error(`Kimi RPC 超时：${method}`))
      }, timeoutMs)

      this._pendingRpc.set(id, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (err) {
        this.clearTrackedTimer(timer)
        this._pendingRpc.delete(id)
        reject(err)
      }
    })
  }

  _rememberConversation(conv) {
    if (!conv || typeof conv !== 'object') return null
    const nativeId = String(conv.conversationId || conv.conversation_id || '').trim()
    const convKey = String(conv.conversationKey || conv.conversation_key || '').trim()
    if (!nativeId || !convKey) return null
    this.convKeyById.set(nativeId, convKey)
    this.convMetaById.set(nativeId, {
      conversationId: nativeId,
      conversationKey: convKey,
      sessionKey: String(conv.sessionKey || conv.session_key || KIMI_DEFAULT_SESSION_KEY),
      title: String(conv.title || conv.firstUserText || conv.first_user_text || 'Kimi 对话').trim(),
      cwd: String(conv.workspacePath || conv.workspace_path || '').trim(),
      kernelRecordsPath: String(conv.kernelRecordsPath || conv.kernel_records_path || '').trim(),
      createdAt: toEpochMs(conv.createdAt || conv.created_at_ms || 0),
      updatedAt: toEpochMs(conv.updatedAt || conv.updated_at_ms || 0),
      model: String(conv.extra?.runtimePreferences?.modelAlias || '').trim(),
      reasoningEffort: String(conv.extra?.runtimePreferences?.thinkingLevel || '').trim(),
    })
    return nativeId
  }

  _extractNativeIdFromConversationKey(conversationKey) {
    const key = String(conversationKey || '').trim()
    if (!key) return ''
    for (const [id, storedKey] of this.convKeyById.entries()) {
      if (storedKey === key) return id
    }
    const idx = key.lastIndexOf(':conversation:')
    if (idx !== -1) {
      const candidate = key.slice(idx + ':conversation:'.length).trim()
      if (candidate) {
        this.convKeyById.set(candidate, key)
        return candidate
      }
    }
    return ''
  }

  _resolveConversationKey(nativeId) {
    const cleanId = assertSafeSessionId(nativeId, 'Kimi sessionId')
    const cached = this.convKeyById.get(cleanId)
    if (cached) return cached
    if (cleanId.startsWith('agent:')) return cleanId
    return `${KIMI_DEFAULT_SESSION_KEY}:conversation:${cleanId}`
  }

  _handleWsMessage(rawData) {
    const msg = safeJsonParse(String(rawData ?? ''), null)
    if (!msg || typeof msg !== 'object') return

    // JSON-RPC Response
    if (msg.id !== undefined && msg.id !== null) {
      const id = String(msg.id)
      const pending = this._pendingRpc.get(id)
      if (!pending) return
      this._pendingRpc.delete(id)
      this.clearTrackedTimer(pending.timer)
      if (msg.error) {
        const err = new Error(String(msg.error?.message || msg.error || 'Kimi RPC Error'))
        err.code = msg.error?.code
        err.data = msg.error?.data
        pending.reject(err)
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    // JSON-RPC Notification
    const method = String(msg.method || '').trim()
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
    if (!method) return

    if (method === 'conversations.message.delta') {
      this._handleMessageDelta(params)
    } else if (method === 'conversations.message.snapshot') {
      this._handleMessageSnapshot(params)
    } else if (method === 'conversations.message.complete') {
      this._handleMessageComplete(params)
    } else if (method === 'conversations.message.error') {
      this._handleMessageError(params)
    } else if (method === 'conversations.message.cancelled') {
      this._handleMessageCancelled(params)
    } else if (method === 'conversations.changed') {
      const convKey = String(params.conversationKey || params.envelope?.conversationKey || '').trim()
      const nativeId = this._extractNativeIdFromConversationKey(convKey)
      this.emitEvent(EVENTS.SESSION_UPDATED, {
        app: APPS.KIMI,
        ...(nativeId ? { sessionId: makeCompositeId(APPS.KIMI, nativeId), nativeId } : {}),
      })
    } else if (method === 'conversations.goal.changed') {
      this._handleGoalChanged(params)
    } else if (method === 'interaction.pending') {
      this._handleInteractionPending(params)
    } else if (method === 'interaction.cancelled' || method === 'interaction.expired') {
      const interactionId = String(params.interactionId || '').trim()
      if (interactionId && this.pendingInteractions.has(interactionId)) {
        this.pendingInteractions.delete(interactionId)
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: interactionId,
          app: APPS.KIMI,
          cancelled: true,
        })
      }
    }
  }

  _resetTurnInactivity(turn) {
    if (!turn || turn.settled) return
    if (turn.inactivityTimer) this.clearTrackedTimer(turn.inactivityTimer)
    turn.inactivityTimer = this.setTrackedTimeout(() => {
      if (turn.settled) return
      turn.settled = true
      this.activeTurns.delete(turn.nativeId)
      const err = new Error('Kimi 响应超时（15 分钟无输出）')
      this.emitEvent(EVENTS.STREAM_ERROR, {
        app: APPS.KIMI,
        sessionId: turn.compositeId,
        nativeId: turn.nativeId,
        error: err.message,
      })
      err._streamErrorEmitted = true
      turn.reject(err)
    }, KIMI_TURN_INACTIVITY_TIMEOUT_MS)
  }

  _getStreamStateForNotification(params) {
    const convKey = String(params.conversationKey || '').trim()
    if (!convKey) return null
    const nativeId = this._extractNativeIdFromConversationKey(convKey)
    if (!nativeId) return null

    const active = this.activeTurns.get(nativeId)
    if (active) {
      // Match turnId if already bound; bind if turnId arrived before RPC response returned
      const incomingTurnId = String(params.turnId || '').trim()
      if (!active.turnId && incomingTurnId) active.turnId = incomingTurnId
      if (!incomingTurnId || !active.turnId || active.turnId === incomingTurnId) {
        this._resetTurnInactivity(active)
        return active
      }
    }

    // Unsolicited stream initiated directly in Kimi Desktop -> real-time mirror!
    let ext = this._externalStreams.get(convKey)
    if (!ext) {
      ext = {
        external: true,
        nativeId,
        compositeId: makeCompositeId(APPS.KIMI, nativeId),
        conversationKey: convKey,
        turnId: String(params.turnId || ''),
        text: '',
        thinking: '',
        partBuffers: new Map(),
        tools: new Map(),
        taskTracker: createTaskStateTracker(this.sessionTaskStates.get(nativeId)),
      }
      this._externalStreams.set(convKey, ext)
      this.emitEvent(EVENTS.STREAM_START, {
        app: APPS.KIMI,
        sessionId: ext.compositeId,
        nativeId,
      })
    }
    return ext
  }

  _applyPartDelta(state, { messageId = '', partKind = 'text', append = '' }) {
    if (!append) return
    const normKind = partKind === 'text' ? 'text' : 'reasoning'
    const msgKey = `${messageId || 'default'}:${normKind}`
    const prev = state.partBuffers.get(msgKey) || ''
    state.partBuffers.set(msgKey, prev + append)

    if (normKind === 'reasoning') {
      state.thinking += append
      this.emitEvent(EVENTS.STREAM_THINKING, {
        app: APPS.KIMI,
        sessionId: state.compositeId,
        nativeId: state.nativeId,
        delta: append,
      })
    } else if (normKind === 'text') {
      state.text += append
      this.emitEvent(EVENTS.STREAM_DELTA, {
        app: APPS.KIMI,
        sessionId: state.compositeId,
        nativeId: state.nativeId,
        delta: append,
      })
    }
  }

  _handleMessageDelta(params) {
    const state = this._getStreamStateForNotification(params)
    if (!state) return
    const kind = String(params.partKind || 'text')
    if (kind !== 'text' && kind !== 'reasoning' && kind !== 'think' && kind !== 'thinking') return
    this._applyPartDelta(state, {
      messageId: String(params.messageId || ''),
      partKind: kind,
      append: String(params.append || ''),
    })
  }

  _applyMessageSnapshotParts(state, message) {
    if (!message || typeof message !== 'object') return
    if (message.role && String(message.role).toLowerCase() !== 'assistant') return
    const messageId = String(message.id || 'default')
    const parts = Array.isArray(message.parts) ? message.parts : []

    const fullTextChunks = []
    const fullThinkChunks = []

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!part || typeof part !== 'object') continue
      const kind = String(part.kind || part.type || '').trim()

      if (kind === 'text') {
        const s = String(part.text ?? '')
        if (s) fullTextChunks.push(s)
      } else if (kind === 'reasoning' || kind === 'think' || kind === 'thinking') {
        const s = String(part.text ?? part.think ?? '')
        if (s) fullThinkChunks.push(s)
      } else if (kind === 'tool-call') {
        const toolId = String(part.toolCallId || part.id || `kimi-tool-${i}`)
        const toolName = String(part.toolName || part.name || 'tool')
        const input = parseToolArgs(part.args ?? part.input)
        if (!state.tools.has(toolId)) {
          state.tools.set(toolId, { id: toolId, name: toolName, input, status: 'running' })
          this.emitEvent(EVENTS.STREAM_TOOL_START, {
            app: APPS.KIMI,
            sessionId: state.compositeId,
            nativeId: state.nativeId,
            tool: { id: toolId, name: toolName, input, status: 'running' },
          })
          // Sync TodoList / Plan tools into unified taskState bar
          if (state.taskTracker && typeof state.taskTracker.applyToolUse === 'function') {
            const changed = state.taskTracker.applyToolUse(toolName, input)
            if (changed) {
              const snap = state.taskTracker.snapshot()
              this.sessionTaskStates.set(state.nativeId, snap)
              this.emitEvent(EVENTS.STREAM_TASK_STATE, {
                app: APPS.KIMI,
                sessionId: state.compositeId,
                nativeId: state.nativeId,
                taskState: snap,
              })
            }
          }
        }
      } else if (kind === 'tool-result') {
        const toolId = String(part.toolCallId || part.id || '')
        const existing = toolId ? state.tools.get(toolId) : null
        if (existing && existing.status === 'running') {
          existing.status = part.isError ? 'error' : 'completed'
          existing.output = String(part.summary ?? part.output ?? '').slice(0, 800)
          this.emitEvent(EVENTS.STREAM_TOOL_END, {
            app: APPS.KIMI,
            sessionId: state.compositeId,
            nativeId: state.nativeId,
            tool: existing,
          })
        }
      }
    }

    const syncAggregate = (normKind, fullStr) => {
      if (!fullStr) return
      const msgKey = `${messageId}:${normKind}`
      const prev = state.partBuffers.get(msgKey) || ''
      if (fullStr === prev) return
      if (fullStr.startsWith(prev)) {
        this._applyPartDelta(state, {
          messageId,
          partKind: normKind,
          append: fullStr.slice(prev.length),
        })
      } else if (!prev) {
        this._applyPartDelta(state, {
          messageId,
          partKind: normKind,
          append: fullStr,
        })
      }
    }

    syncAggregate('reasoning', fullThinkChunks.join('\n\n'))
    syncAggregate('text', fullTextChunks.join('\n'))
  }

  _handleMessageSnapshot(params) {
    const state = this._getStreamStateForNotification(params)
    if (!state) return
    this._applyMessageSnapshotParts(state, params.message)
  }

  _handleMessageComplete(params) {
    const convKey = String(params.conversationKey || '').trim()
    const nativeId = this._extractNativeIdFromConversationKey(convKey)
    if (!nativeId) return

    const active = this.activeTurns.get(nativeId)
    if (active && (!active.turnId || !params.turnId || active.turnId === String(params.turnId))) {
      this._applyMessageSnapshotParts(active, params.message)
      if (!active.settled) {
        active.settled = true
        this.clearTrackedTimer(active.inactivityTimer)
        this.activeTurns.delete(nativeId)
        this.emitEvent(EVENTS.STREAM_DONE, {
          app: APPS.KIMI,
          sessionId: active.compositeId,
          nativeId,
          text: active.text,
          aborted: false,
        })
        this.emitEvent(EVENTS.SESSION_UPDATED, {
          app: APPS.KIMI,
          sessionId: active.compositeId,
          nativeId,
        })
        active.resolve({
          sessionId: active.compositeId,
          nativeId,
          finalText: active.text,
          aborted: false,
        })
      }
      return
    }

    const ext = this._externalStreams.get(convKey)
    if (ext) {
      this._applyMessageSnapshotParts(ext, params.message)
      this._externalStreams.delete(convKey)
      this.emitEvent(EVENTS.STREAM_DONE, {
        app: APPS.KIMI,
        sessionId: ext.compositeId,
        nativeId,
        text: ext.text,
        aborted: false,
      })
      this.emitEvent(EVENTS.SESSION_UPDATED, {
        app: APPS.KIMI,
        sessionId: ext.compositeId,
        nativeId,
      })
    }
  }

  _handleMessageError(params) {
    const convKey = String(params.conversationKey || '').trim()
    const nativeId = this._extractNativeIdFromConversationKey(convKey)
    if (!nativeId) return
    const errText = formatKimiError(params.error?.message || params.error || 'Kimi 执行出错')

    const active = this.activeTurns.get(nativeId)
    if (active && !active.settled) {
      active.settled = true
      this.clearTrackedTimer(active.inactivityTimer)
      this.activeTurns.delete(nativeId)
      const err = new Error(errText)
      this.emitEvent(EVENTS.STREAM_ERROR, {
        app: APPS.KIMI,
        sessionId: active.compositeId,
        nativeId,
        error: errText,
      })
      err._streamErrorEmitted = true
      active.reject(err)
      return
    }

    if (this._externalStreams.has(convKey)) {
      this._externalStreams.delete(convKey)
      this.emitEvent(EVENTS.STREAM_ERROR, {
        app: APPS.KIMI,
        sessionId: makeCompositeId(APPS.KIMI, nativeId),
        nativeId,
        error: errText,
      })
    }
  }

  _handleMessageCancelled(params) {
    const convKey = String(params.conversationKey || '').trim()
    const nativeId = this._extractNativeIdFromConversationKey(convKey)
    if (!nativeId) return

    const active = this.activeTurns.get(nativeId)
    if (active && !active.settled) {
      active.settled = true
      this.clearTrackedTimer(active.inactivityTimer)
      this.activeTurns.delete(nativeId)
      this.emitEvent(EVENTS.STREAM_DONE, {
        app: APPS.KIMI,
        sessionId: active.compositeId,
        nativeId,
        text: active.text,
        aborted: true,
      })
      active.resolve({
        sessionId: active.compositeId,
        nativeId,
        finalText: active.text,
        aborted: true,
      })
      return
    }

    if (this._externalStreams.has(convKey)) {
      const ext = this._externalStreams.get(convKey)
      this._externalStreams.delete(convKey)
      this.emitEvent(EVENTS.STREAM_DONE, {
        app: APPS.KIMI,
        sessionId: ext.compositeId,
        nativeId,
        text: ext.text,
        aborted: true,
      })
    }
  }

  _handleGoalChanged(params) {
    const convKey = String(params.conversationKey || params.envelope?.conversationKey || '').trim()
    const nativeId = this._extractNativeIdFromConversationKey(convKey)
    if (!nativeId) return
    const goal = params.goal || params.envelope?.goal || null
    const taskState = normalizeKimiGoalToTaskState(goal)
    if (taskState) {
      this.sessionTaskStates.set(nativeId, taskState)
    } else {
      this.sessionTaskStates.delete(nativeId)
    }
    this.emitEvent(EVENTS.STREAM_TASK_STATE, {
      app: APPS.KIMI,
      sessionId: makeCompositeId(APPS.KIMI, nativeId),
      nativeId,
      taskState,
    })
  }

  _handleInteractionPending(params) {
    const interaction = params.interaction && typeof params.interaction === 'object'
      ? params.interaction
      : params
    const interactionId = String(interaction.interactionId || interaction.id || '').trim()
    if (!interactionId) return
    const convKey = String(interaction.conversationKey || '').trim()
    const nativeId = this._extractNativeIdFromConversationKey(convKey)
    const compositeId = nativeId ? makeCompositeId(APPS.KIMI, nativeId) : ''

    const kind = String(interaction.kind || '').toLowerCase()
    const rawOptions = Array.isArray(interaction.options) ? interaction.options : []
    const rawQuestions = Array.isArray(interaction.questions) ? interaction.questions : []

    this.pendingInteractions.set(interactionId, {
      interactionId,
      kind,
      options: rawOptions,
      questions: rawQuestions,
      conversationKey: convKey,
      nativeId,
    })

    const approvalPayload = {
      id: interactionId,
      app: APPS.KIMI,
      sessionId: compositeId,
      nativeId,
      kind: rawQuestions.length > 0 || kind === 'question' ? 'question' : 'permission',
      title: String(interaction.title || interaction.toolName || 'Kimi 需要确认'),
      description: String(interaction.prompt || interaction.description || interaction.message || ''),
      options: rawOptions.map((o) => ({
        id: String(o.optionId || o.id || o.value || ''),
        label: String(o.label || o.title || o.optionId || ''),
        description: String(o.description || ''),
      })),
      questions: rawQuestions,
      createdAt: Date.now(),
    }

    this.onApprovalRequest(approvalPayload)
  }

  async resolveApproval(id, decisionOrPayload) {
    const rec = this.pendingInteractions.get(id)
    if (!rec) {
      const err = new Error(`Kimi 审批请求已过期或不存在：${id}`)
      err.code = 'APPROVAL_TRANSPORT_CLOSED'
      throw err
    }
    this.pendingInteractions.delete(id)

    const isObj = decisionOrPayload && typeof decisionOrPayload === 'object'
    const decision = isObj ? String(decisionOrPayload.decision || '') : String(decisionOrPayload || '')
    const answers = isObj && decisionOrPayload.answers && typeof decisionOrPayload.answers === 'object'
      ? decisionOrPayload.answers
      : null

    try {
      if (decision === 'cancel' || decision === 'reject' || decision === 'deny' || decision === 'decline') {
        const denyOpt = rec.options.find((o) =>
          /deny|reject|decline|cancel|no/i.test(String(o.optionId || o.id || o.kind || o.label || '')),
        )
        if (denyOpt) {
          await this._rpc('interaction.respond', {
            interactionId: id,
            optionId: String(denyOpt.optionId || denyOpt.id),
          })
        } else {
          await this._rpc('interaction.cancel', { interactionId: id })
        }
      } else if (answers) {
        await this._rpc('interaction.respond', {
          interactionId: id,
          response: { answers },
        })
      } else {
        const exact = rec.options.find((o) => String(o.optionId || o.id || '') === decision)
        const allowOpt = exact || rec.options.find((o) =>
          /allow|approve|accept|yes|once|always/i.test(String(o.optionId || o.id || o.kind || o.label || '')),
        ) || rec.options[0]
        if (allowOpt) {
          await this._rpc('interaction.respond', {
            interactionId: id,
            optionId: String(allowOpt.optionId || allowOpt.id),
          })
        } else {
          await this._rpc('interaction.respond', {
            interactionId: id,
            response: { decision: decision || 'approve' },
          })
        }
      }
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, { id, app: APPS.KIMI, decision })
      return { resolved: true, id, decision }
    } catch (err) {
      const wrapped = new Error(formatKimiError(err))
      wrapped.code = 'APPROVAL_TRANSPORT_CLOSED'
      throw wrapped
    }
  }

  _querySqliteConversations(limit = 100) {
    const dbPath = this._getSqlitePath()
    if (!dbPath || !existsSync(dbPath)) return []
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100))

    const DatabaseSync = getDatabaseSync()
    if (DatabaseSync) {
      let db = null
      try {
        db = new DatabaseSync(dbPath, { readOnly: true })
        const rows = db
          .prepare(
            `SELECT conversation_key, conversation_id, session_key, title, workspace_path,
                    kernel_records_path, first_user_text, first_assistant_text,
                    created_at_ms, updated_at_ms, extra_json
             FROM conversations
             WHERE COALESCE(archived_at_ms, 0) = 0
             ORDER BY updated_at_ms DESC
             LIMIT ?`,
          )
          .all(safeLimit)
        return Array.isArray(rows) ? rows : []
      } catch {
        // Fall through to python sqlite fallback
      } finally {
        try { db?.close() } catch {}
      }
    }

    const sql =
      `SELECT conversation_key, conversation_id, session_key, title, workspace_path, ` +
      `kernel_records_path, first_user_text, first_assistant_text, ` +
      `created_at_ms, updated_at_ms, extra_json ` +
      `FROM conversations WHERE COALESCE(archived_at_ms, 0) = 0 ` +
      `ORDER BY updated_at_ms DESC LIMIT ${safeLimit}`
    const rows = runPythonSqliteJson(dbPath, sql)
    return Array.isArray(rows) ? rows : []
  }

  _formatSessionSummary(conv, { writable = true } = {}) {
    const nativeId = this._rememberConversation(conv)
    if (!nativeId) return null
    const cwd = String(conv.workspacePath || conv.workspace_path || '').trim()
    const title =
      String(conv.title || '').trim() ||
      String(conv.firstUserText || conv.first_user_text || '').trim().slice(0, 60) ||
      'Kimi 对话'
    const preview = String(conv.firstAssistantText || conv.first_assistant_text || conv.firstUserText || conv.first_user_text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140)
    const extra =
      conv.extra && typeof conv.extra === 'object'
        ? conv.extra
        : typeof conv.extra_json === 'string'
          ? safeJsonParse(conv.extra_json, {})
          : {}
    const isRunning = this.activeTurns.has(nativeId) || this._externalStreams.has(this.convKeyById.get(nativeId))
    return {
      id: makeCompositeId(APPS.KIMI, nativeId),
      app: APPS.KIMI,
      nativeId,
      title,
      preview,
      cwd,
      workspace: cwd ? basename(cwd) : 'Kimi',
      status: isRunning ? 'running' : 'idle',
      writable,
      source: writable ? 'kimi-control' : 'kimi-desktop',
      model: String(extra?.runtimePreferences?.modelAlias || '').trim() || undefined,
      reasoningEffort: String(extra?.runtimePreferences?.thinkingLevel || '').trim() || undefined,
      createdAt: toEpochMs(conv.createdAt || conv.created_at_ms || 0),
      updatedAt: toEpochMs(conv.updatedAt || conv.updated_at_ms || 0),
    }
  }

  async getStatus({ forceQuota = false } = {}) {
    this._refreshDirs()
    const quota =
      (await this.quotaCache.refreshInBackground({ force: forceQuota })) ||
      this.quotaCache.getValid()

    if (!this.kimiDataDir) {
      return {
        app: APPS.KIMI,
        available: false,
        writable: false,
        mode: 'unavailable',
        detail: '未检测到 Kimi 桌面端',
        activeCount: 0,
        ...(quota ? { quota } : {}),
      }
    }

    try {
      await this._ensureConnected()
      return {
        app: APPS.KIMI,
        available: true,
        writable: true,
        mode: 'kimi-control-ws',
        detail: 'Kimi 桌面端实时双向直连（官方本地控制协议）',
        activeCount: this.activeTurns.size + this._externalStreams.size,
        ...(quota ? { quota } : {}),
      }
    } catch {
      const hasHistory =
        existsSync(this._getSqlitePath()) ||
        existsSync(join(this.kimiDataDir, 'config.json'))
      if (hasHistory) {
        return {
          app: APPS.KIMI,
          available: true,
          writable: false,
          mode: 'kimi-desktop-ro',
          detail: '已同步 Kimi 桌面端历史（只读 · 打开 Kimi 桌面端后自动解锁实时收发）',
          activeCount: 0,
          ...(quota ? { quota } : {}),
        }
      }
      return {
        app: APPS.KIMI,
        available: false,
        writable: false,
        mode: 'unavailable',
        detail: '未检测到 Kimi 桌面端运行状态',
        activeCount: 0,
        ...(quota ? { quota } : {}),
      }
    }
  }

  async listModels() {
    if (this._modelsCache && Date.now() - this._modelsCacheAt < 30_000) {
      return this._modelsCache
    }
    this._refreshDirs()
    const cfg = readKimiConfigFile(this.kimiDataDir)
    const configCurrent = String(cfg?.model?.current || '').trim()
    const configThinking = String(cfg?.model?.thinkingLevel || 'high').trim().toLowerCase()

    let rpcModelsList = null
    let rpcKimiModels = null
    try {
      const [mList, kList] = await Promise.all([
        this._rpc('models.list', {}),
        this._rpc('conversations.getKimiModelList', {}).catch(() => null),
      ])
      rpcModelsList = mList
      rpcKimiModels = kList
    } catch {
      // Offline fallback to config.json
    }

    const effortsByModel = new Map()
    const kimiSpecList = Array.isArray(rpcKimiModels?.models)
      ? rpcKimiModels.models
      : Array.isArray(cfg?.model?.models)
        ? cfg.model.models
        : []
    for (const item of kimiSpecList) {
      const id = String(item?.model || item?.id || '').trim()
      if (!id) continue
      const efforts = Array.isArray(item?.supportEfforts) && item.supportEfforts.length > 0
        ? item.supportEfforts.map((v) => String(v).trim().toLowerCase()).filter((v) => KIMI_VALID_THINKING_LEVELS.includes(v))
        : ['low', 'high', 'max']
      const defEff = normalizeKimiThinkingLevel(
        configThinking || item?.defaultEffort || 'high',
        efforts,
        'high',
      )
      effortsByModel.set(id.toLowerCase(), { efforts, defaultEffort: defEff })
    }

    const models = []
    const seen = new Set()
    const rawList = Array.isArray(rpcModelsList?.models) ? rpcModelsList.models : []
    for (const m of rawList) {
      const id = String(m?.alias || m?.id || '').trim()
      if (!id || seen.has(id.toLowerCase())) continue
      seen.add(id.toLowerCase())
      const spec = effortsByModel.get(id.toLowerCase()) || {
        efforts: ['low', 'high', 'max'],
        defaultEffort: normalizeKimiThinkingLevel(configThinking, ['low', 'high', 'max'], 'high'),
      }
      models.push({
        id,
        name: formatKimiModelName(id, m?.label),
        provider: String(m?.providerId || 'daimon-kimi-code'),
        providerName: 'Moonshot Kimi',
        efforts: spec.efforts,
        defaultEffort: spec.defaultEffort,
      })
    }

    // Fallback to config.json / curated list when offline
    if (models.length === 0) {
      for (const item of kimiSpecList) {
        const id = String(item?.model || item?.id || '').trim()
        if (!id || seen.has(id.toLowerCase())) continue
        seen.add(id.toLowerCase())
        const spec = effortsByModel.get(id.toLowerCase()) || { efforts: ['low', 'high', 'max'], defaultEffort: 'high' }
        models.push({
          id,
          name: formatKimiModelName(id),
          provider: 'daimon-kimi-code',
          providerName: 'Moonshot Kimi',
          efforts: spec.efforts,
          defaultEffort: spec.defaultEffort,
        })
      }
    }

    if (models.length === 0) {
      for (const fb of KIMI_FALLBACK_MODELS) {
        models.push({
          ...fb,
          provider: 'daimon-kimi-code',
          providerName: 'Moonshot Kimi',
        })
      }
    }

    const defaultModel =
      String(rpcModelsList?.current || configCurrent || models[0]?.id || 'k3-agent').trim()
    const matchedDef = models.find((m) => m.id === defaultModel) || models[0]
    const defaultEffort = normalizeKimiThinkingLevel(
      configThinking,
      matchedDef?.efforts || ['low', 'high', 'max'],
      matchedDef?.defaultEffort || 'high',
    )

    const result = {
      app: APPS.KIMI,
      defaultModel: matchedDef?.id || defaultModel,
      defaultEffort,
      supportsMidChatSwitch: true,
      models,
    }
    this._modelsCache = result
    this._modelsCacheAt = Date.now()
    return result
  }

  async listWorkspaces() {
    const out = []
    const seen = new Set()
    const addPath = (rawPath, name = '', source = 'kimi') => {
      const p = String(rawPath || '').trim()
      if (!p || !existsSync(p)) return
      const key = p.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      out.push({
        name: name || basename(p) || p,
        path: p,
        source,
      })
    }

    try {
      const [rootRes, projRes] = await Promise.all([
        this._rpc('workspace.getRoot', {}).catch(() => null),
        this._rpc('workspace.listProjects', {}).catch(() => null),
      ])
      if (rootRes?.endpointPath) {
        addPath(rootRes.endpointPath, basename(rootRes.endpointPath) || 'Kimi Workspace', 'kimi-workspace')
      }
      for (const proj of Array.isArray(projRes?.projects) ? projRes.projects : []) {
        addPath(proj?.path || proj?.workspacePath || proj?.endpointPath, proj?.name || '', 'kimi-project')
      }
    } catch {
      // Offline fallback: collect recent conversation workspaces from SQLite
    }

    for (const row of this._querySqliteConversations(30)) {
      if (row?.workspace_path) {
        addPath(row.workspace_path, basename(row.workspace_path), 'kimi-session')
      }
    }
    return out
  }

  async listSessions({ limit = 100, search = '' } = {}) {
    this._refreshDirs()
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100))
    const q = String(search || '').trim().toLowerCase()
    const sessions = []

    try {
      const res = await this._rpc('conversations.list', {
        sessionKey: KIMI_DEFAULT_SESSION_KEY,
        limit: safeLimit,
      })
      for (const conv of Array.isArray(res?.conversations) ? res.conversations : []) {
        if (conv?.archivedAt) continue
        const s = this._formatSessionSummary(conv, { writable: true })
        if (s) sessions.push(s)
      }
    } catch {
      // Offline read-only fallback from SQLite
      const rows = this._querySqliteConversations(safeLimit)
      for (const row of rows) {
        const s = this._formatSessionSummary(row, { writable: false })
        if (s) sessions.push(s)
      }
    }

    // Merge pending newly-created local placeholders if not yet returned
    for (const [nativeId, pending] of this.pendingCreated.entries()) {
      if (!sessions.some((s) => s.nativeId === nativeId)) {
        sessions.unshift(pending)
      }
    }

    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.preview.toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q),
        )
      : sessions

    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return filtered.slice(0, safeLimit)
  }

  async readSession(nativeId, { limit = 25, cursor = null } = {}) {
    const cleanId = assertSafeSessionId(nativeId, 'Kimi sessionId')
    this._refreshDirs()
    const convKey = this._resolveConversationKey(cleanId)
    const meta = this.convMetaById.get(cleanId) || this.pendingCreated.get(cleanId) || null
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 25))

    let messages = []
    let writable = false
    let taskState = this.sessionTaskStates.get(cleanId) || null

    try {
      const res = await this._rpc('conversations.getMessages', {
        conversationKey: convKey,
        limit: 200,
      })
      writable = true
      messages = normalizeKimiControlMessages(res?.messages || [])

      // Fetch active goal state if available
      const goalRes = await this._rpc('conversations.goal.get', { conversationKey: convKey }).catch(() => null)
      if (goalRes?.goal) {
        const mapped = normalizeKimiGoalToTaskState(goalRes.goal)
        if (mapped) {
          taskState = mapped
          this.sessionTaskStates.set(cleanId, mapped)
        }
      }
    } catch {
      // Offline fallback: locate wire.jsonl from metadata or SQLite
      let wirePath = meta?.kernelRecordsPath || ''
      if (!wirePath) {
        const rows = this._querySqliteConversations(200)
        const found = rows.find((r) => String(r.conversation_id) === cleanId)
        if (found) {
          this._rememberConversation(found)
          wirePath = String(found.kernel_records_path || '')
        }
      }
      if (wirePath && existsSync(wirePath)) {
        messages = this.parseCache.getOrParse(wirePath, () => {
          const st = statSync(wirePath)
          if (st.size > 32 * 1024 * 1024) return []
          return normalizeKimiWireJsonl(readFileSync(wirePath, 'utf8'))
        })
      }
    }

    const total = messages.length
    const endIdx = cursor !== null && cursor !== undefined && Number.isFinite(Number(cursor))
      ? Math.max(0, Math.min(total, Math.floor(Number(cursor))))
      : total
    const startIdx = Math.max(0, endIdx - safeLimit)
    const pageMessages = messages.slice(startIdx, endIdx)
    const freshMeta = this.convMetaById.get(cleanId) || meta || {}
    const pref = this.sessionPrefs.get(cleanId) || {}
    const isRunning = this.activeTurns.has(cleanId) || this._externalStreams.has(convKey)

    return {
      id: makeCompositeId(APPS.KIMI, cleanId),
      app: APPS.KIMI,
      nativeId: cleanId,
      title: freshMeta.title || 'Kimi 对话',
      cwd: freshMeta.cwd || '',
      workspace: freshMeta.cwd ? basename(freshMeta.cwd) : 'Kimi',
      status: isRunning ? 'running' : 'idle',
      writable,
      source: writable ? 'kimi-control' : 'kimi-desktop',
      model: pref.model || freshMeta.model || undefined,
      reasoningEffort: pref.reasoningEffort || freshMeta.reasoningEffort || undefined,
      messages: pageMessages,
      totalMessages: total,
      hasMore: startIdx > 0,
      nextCursor: startIdx > 0 ? startIdx : null,
      ...(taskState ? { taskState } : {}),
      createdAt: freshMeta.createdAt || 0,
      updatedAt: freshMeta.updatedAt || Date.now(),
    }
  }

  async createSession({ cwd, title, model, reasoningEffort } = {}) {
    const cleanModel = assertSafeCliToken(model, 'model', { allowEmpty: true })
    const cleanEffort = assertSafeCliToken(reasoningEffort, 'reasoningEffort', { allowEmpty: true })
    const cleanTitle = String(title || '').trim()

    const params = {
      sessionKey: KIMI_DEFAULT_SESSION_KEY,
      origin: 'client',
      activate: false,
      ...(cwd ? { workspacePath: cwd } : {}),
    }

    const res = await this._rpc('conversations.create', params)
    const conv = res?.conversation || res
    const nativeId = this._rememberConversation(conv) || String(conv?.conversationId || randomUUID())
    const convKey = this.convKeyById.get(nativeId) || String(conv?.conversationKey || `${KIMI_DEFAULT_SESSION_KEY}:conversation:${nativeId}`)
    this.convKeyById.set(nativeId, convKey)

    if (cleanTitle) {
      await this._rpc('conversations.rename', {
        conversationKey: convKey,
        title: cleanTitle,
      }).catch(() => {})
    }

    const catalog = await this.listModels().catch(() => null)
    const matchedModel = catalog?.models?.find((m) => m.id === cleanModel)
    const normEffort = cleanEffort
      ? normalizeKimiThinkingLevel(cleanEffort, matchedModel?.efforts, matchedModel?.defaultEffort)
      : ''

    if (cleanModel) {
      await this._rpc('conversations.setModel', {
        conversationKey: convKey,
        modelAlias: cleanModel,
      }).catch(() => {})
    }
    if (normEffort) {
      await this._rpc('conversations.setThinking', {
        conversationKey: convKey,
        thinkingLevel: normEffort,
      }).catch(() => {})
    }

    if (cleanModel || normEffort) {
      this.sessionPrefs.set(nativeId, {
        ...(cleanModel ? { model: cleanModel } : {}),
        ...(normEffort ? { reasoningEffort: normEffort } : {}),
      })
    }

    const now = Date.now()
    const summary = {
      id: makeCompositeId(APPS.KIMI, nativeId),
      app: APPS.KIMI,
      nativeId,
      title: cleanTitle || String(conv?.title || '').trim() || 'Kimi 新对话',
      preview: '',
      cwd: String(conv?.workspacePath || cwd || ''),
      workspace: (conv?.workspacePath || cwd) ? basename(String(conv?.workspacePath || cwd)) : 'Kimi',
      status: 'idle',
      writable: true,
      source: 'kimi-control',
      model: cleanModel || undefined,
      reasoningEffort: normEffort || undefined,
      createdAt: toEpochMs(conv?.createdAt) || now,
      updatedAt: toEpochMs(conv?.updatedAt) || now,
    }
    this.pendingCreated.set(nativeId, summary)
    return summary
  }

  async sendMessage(
    nativeId,
    {
      text = '',
      attachments = [],
      model,
      reasoningEffort,
      taskMode,
    } = {},
  ) {
    const cleanId = assertSafeSessionId(nativeId, 'Kimi sessionId')
    if (this.activeTurns.has(cleanId)) {
      const err = new Error('当前 Kimi 对话正在执行中，请稍候或先点击停止')
      err.code = 'SESSION_BUSY'
      throw err
    }

    const finalPrompt = buildInlineAttachmentPrompt(text, attachments)
    if (!finalPrompt) {
      throw new Error('消息内容不能为空')
    }

    const cleanModel = assertSafeCliToken(model, 'model', { allowEmpty: true })
    const cleanEffort = assertSafeCliToken(reasoningEffort, 'reasoningEffort', { allowEmpty: true })
    const mode = normalizeTaskMode(taskMode)

    const convKey = this._resolveConversationKey(cleanId)
    const compositeId = makeCompositeId(APPS.KIMI, cleanId)

    const catalog = cleanModel || cleanEffort ? await this.listModels().catch(() => null) : null
    const matchedModel = catalog?.models?.find((m) => m.id === (cleanModel || catalog?.defaultModel))
    const normEffort = cleanEffort
      ? normalizeKimiThinkingLevel(cleanEffort, matchedModel?.efforts, matchedModel?.defaultEffort)
      : ''

    if (cleanModel || normEffort) {
      const prev = this.sessionPrefs.get(cleanId) || {}
      this.sessionPrefs.set(cleanId, {
        ...prev,
        ...(cleanModel ? { model: cleanModel } : {}),
        ...(normEffort ? { reasoningEffort: normEffort } : {}),
      })
    }

    await this._ensureConnected()

    const turnState = {
      nativeId: cleanId,
      compositeId,
      conversationKey: convKey,
      turnId: '',
      text: '',
      thinking: '',
      partBuffers: new Map(),
      tools: new Map(),
      taskTracker: createTaskStateTracker(this.sessionTaskStates.get(cleanId)),
      settled: false,
      inactivityTimer: null,
      resolve: null,
      reject: null,
    }

    const turnPromise = new Promise((resolve, reject) => {
      turnState.resolve = resolve
      turnState.reject = reject
    })

    this.activeTurns.set(cleanId, turnState)
    this._resetTurnInactivity(turnState)
    this.emitEvent(EVENTS.STREAM_START, {
      app: APPS.KIMI,
      sessionId: compositeId,
      nativeId: cleanId,
    })

    const sendParams = {
      conversationKey: convKey,
      text: finalPrompt,
      ...(cleanModel ? { modelAlias: cleanModel } : {}),
      ...(normEffort ? { thinkingLevel: normEffort } : {}),
      ...(mode === 'plan' ? { planMode: true } : {}),
      ...(mode === 'goal' ? { goal: { objective: finalPrompt } } : {}),
    }

    try {
      const sendRes = await this._rpc('conversations.send', sendParams)
      if (sendRes?.turnId) {
        turnState.turnId = String(sendRes.turnId)
      }
      this.pendingCreated.delete(cleanId)
    } catch (err) {
      if (!turnState.settled) {
        turnState.settled = true
        this.clearTrackedTimer(turnState.inactivityTimer)
        this.activeTurns.delete(cleanId)
        const formatted = new Error(formatKimiError(err))
        this.emitEvent(EVENTS.STREAM_ERROR, {
          app: APPS.KIMI,
          sessionId: compositeId,
          nativeId: cleanId,
          error: formatted.message,
        })
        formatted._streamErrorEmitted = true
        throw formatted
      }
    }

    return turnPromise
  }

  async interrupt(nativeId) {
    const cleanId = assertSafeSessionId(nativeId, 'Kimi sessionId')
    const convKey = this._resolveConversationKey(cleanId)
    const compositeId = makeCompositeId(APPS.KIMI, cleanId)
    const hadActive = this.activeTurns.has(cleanId) || this._externalStreams.has(convKey)
    try {
      await this._rpc('conversations.cancel', {
        conversationKey: convKey,
        cancelInitiator: 'user',
      })
      return { interrupted: true, sessionId: compositeId }
    } catch {
      return { interrupted: hadActive, sessionId: compositeId }
    }
  }

  dispose() {
    this.quotaCache.dispose()
    this._closeWs('KimiAdapter 已停止')
    this.disposeBase()
  }
}
