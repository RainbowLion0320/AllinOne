import { randomUUID } from 'node:crypto'
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { APPS, EVENTS, assertPathWithinDir, assertSafeCliToken, assertSafeSessionId, makeCompositeId, toEpochMs } from '../protocol.js'
import { parseDshConfiguredModels } from '../helpers/dsh-models.js'
import { createFileParseCache, mergeAndCompactMessages } from '../helpers/history-normalize.js'
import { findExecutable, getClaudeCandidates, spawnCrossPlatform } from '../helpers/bin-finder.js'
import { normalizeResolvePayload, normalizeSingleAnswer } from '../helpers/interactive-schema.js'

const claudeParseCache = createFileParseCache(16)

function getClaudeHome() {
  return join(homedir(), '.claude')
}

function findClaudeCommand(configured) {
  const candidates = getClaudeCandidates(homedir(), process.platform, process.env, configured)
  if (process.platform === 'win32') {
    return findExecutable(['claude.exe', 'claude.cmd', 'claude'], candidates) || 'claude.exe'
  }
  return findExecutable(['claude'], candidates) || 'claude'
}

function spawnClaude(bin, args, options = {}) {
  return spawnCrossPlatform(bin, args, options)
}

/** Read head + tail bytes of a potentially large jsonl file quickly for listing. */
function readHeadAndTailLines(filePath, headBytes = 32_768, tailBytes = 32_768) {
  const st = statSync(filePath)
  const size = st.size
  if (size <= headBytes + tailBytes) {
    return readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
  }
  const fd = openSync(filePath, 'r')
  try {
    const headBuf = Buffer.alloc(headBytes)
    const hRead = readSync(fd, headBuf, 0, headBytes, 0)
    const tailBuf = Buffer.alloc(tailBytes)
    const tRead = readSync(fd, tailBuf, 0, tailBytes, Math.max(0, size - tailBytes))
    const headLines = headBuf.subarray(0, hRead).toString('utf8').split(/\r?\n/)
    const tailLines = tailBuf.subarray(0, tRead).toString('utf8').split(/\r?\n/)
    // Drop potentially truncated boundary lines
    if (headLines.length > 1) headLines.pop()
    if (tailLines.length > 1) tailLines.shift()
    return [...headLines, ...tailLines].filter(Boolean)
  } finally {
    closeSync(fd)
  }
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      if (typeof b === 'string') return b
      if (b?.type === 'text' && typeof b.text === 'string') return b.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function scanClaudeSessionSummary(filePath, fallbackProjectName) {
  let st
  try {
    st = statSync(filePath)
  } catch {
    return null
  }
  const sessionId = basename(filePath, '.jsonl')
  if (sessionId.startsWith('agent-')) return null // skip internal subagent sidecar logs

  let lines = []
  try {
    lines = readHeadAndTailLines(filePath)
  } catch {
    return null
  }

  let cwd = ''
  let aiTitle = ''
  let firstUserText = ''
  let lastPrompt = ''
  let lastAssistantText = ''
  let model = ''
  let createdAt = st.birthtimeMs || st.mtimeMs

  for (const line of lines) {
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!cwd && typeof obj.cwd === 'string' && obj.cwd.length > 0) cwd = obj.cwd
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
      aiTitle = obj.aiTitle.trim()
    }
    if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string' && obj.lastPrompt.trim()) {
      lastPrompt = obj.lastPrompt.trim()
    }
    if (obj.type === 'user' && !obj.isMeta && !obj.isSidechain) {
      const txt = extractTextFromContent(obj.message?.content).trim()
      if (txt && !txt.startsWith('<command-name>') && !firstUserText) {
        firstUserText = txt
        if (obj.timestamp) createdAt = toEpochMs(obj.timestamp) || createdAt
      }
    }
    if (obj.type === 'assistant' && !obj.isSidechain) {
      if (obj.message?.model) model = obj.message.model
      const txt = extractTextFromContent(obj.message?.content).trim()
      if (txt) lastAssistantText = txt
    }
  }

  if (!firstUserText && !aiTitle && !lastPrompt && !lastAssistantText) return null

  const title = aiTitle || firstUserText.replace(/\s+/g, ' ').slice(0, 56) || lastPrompt.slice(0, 56) || sessionId
  const preview = (lastAssistantText || lastPrompt || firstUserText).replace(/\s+/g, ' ').slice(0, 120)

  return {
    id: makeCompositeId(APPS.CLAUDE, sessionId),
    app: APPS.CLAUDE,
    nativeId: sessionId,
    title,
    preview,
    cwd,
    workspace: cwd ? basename(cwd) : fallbackProjectName,
    model,
    status: 'idle',
    writable: true,
    filePath,
    createdAt: toEpochMs(createdAt),
    updatedAt: st.mtimeMs,
  }
}

const CLAUDE_MAX_FULL_PARSE_BYTES = 32 * 1024 * 1024
const CLAUDE_TAIL_FALLBACK_BYTES = 4 * 1024 * 1024

function readClaudeFileForParse(filePath) {
  const st = statSync(filePath)
  if (st.size <= CLAUDE_MAX_FULL_PARSE_BYTES) {
    return { headLines: [], bodyLines: readFileSync(filePath, 'utf8').split(/\r?\n/) }
  }
  const fd = openSync(filePath, 'r')
  try {
    const headLen = Math.min(st.size, 32 * 1024)
    const headBuf = Buffer.alloc(headLen)
    const headRead = readSync(fd, headBuf, 0, headLen, 0)
    const headLines = headBuf.subarray(0, headRead).toString('utf8').split(/\r?\n/)
    if (headLines.length > 1) headLines.pop()

    const tailLen = Math.min(st.size, CLAUDE_TAIL_FALLBACK_BYTES)
    const tailOffset = Math.max(0, st.size - tailLen)
    const tailBuf = Buffer.alloc(tailLen)
    const tailRead = readSync(fd, tailBuf, 0, tailLen, tailOffset)
    const bodyLines = tailBuf.subarray(0, tailRead).toString('utf8').split(/\r?\n/)
    if (tailOffset > 0 && bodyLines.length > 0) bodyLines.shift()
    return { headLines, bodyLines }
  } finally {
    closeSync(fd)
  }
}

function parseClaudeJsonlMessages(filePath) {
  return claudeParseCache.getOrParse(filePath, () => {
    const { headLines, bodyLines } = readClaudeFileForParse(filePath)
    const messages = []
    const toolIndex = new Map()
    let cwd = ''
    let title = ''
    let model = ''

    for (const line of headLines) {
      if (!line.trim()) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
      if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle
      if (!model && obj.type === 'assistant' && obj.message?.model) model = obj.message.model
    }

    for (const line of bodyLines) {
      if (!line.trim()) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
      if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle
      if (obj.isSidechain) continue

      const ts = toEpochMs(obj.timestamp || Date.now())

      if (obj.type === 'user' && !obj.isMeta) {
        const content = obj.message?.content
        if (Array.isArray(content)) {
          let hasText = false
          const textParts = []
          const images = []
          for (const b of content) {
            if (b?.type === 'tool_result' && b.tool_use_id) {
              const target = toolIndex.get(b.tool_use_id)
              if (target) {
                target.status = b.is_error ? 'error' : 'completed'
                const resText = extractTextFromContent(b.content) || (typeof b.content === 'string' ? b.content : '')
                target.output = resText.slice(0, 800)
              }
            } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              hasText = true
              textParts.push(b.text)
            } else if (b?.type === 'image') {
              if (b.source?.type === 'base64' && b.source?.data) {
                images.push({
                  url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`,
                  name: 'image',
                })
              } else if (b.source?.url) {
                images.push({ url: b.source.url, name: 'image' })
              }
            }
          }
          if (hasText || images.length > 0) {
            const joined = textParts.join('\n').trim()
            if (!title && joined) title = joined.slice(0, 56)
            messages.push({
              id: obj.uuid || `cld-u-${messages.length}`,
              role: 'user',
              text: joined,
              ...(images.length > 0 ? { images } : {}),
              ts,
            })
          }
        } else if (typeof content === 'string' && content.trim()) {
          if (!title) title = content.trim().slice(0, 56)
          messages.push({ id: obj.uuid || `cld-u-${messages.length}`, role: 'user', text: content.trim(), ts })
        }
        continue
      }

      if (obj.type === 'assistant') {
        if (obj.message?.model) model = obj.message.model
        const blocks = Array.isArray(obj.message?.content) ? obj.message.content : []
        const thinkingParts = []
        const textParts = []
        const tools = []

        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'thinking' && b.thinking) thinkingParts.push(b.thinking)
          else if (b.type === 'text' && b.text) textParts.push(b.text)
          else if (b.type === 'tool_use') {
            const toolObj = {
              id: b.id || `cld-t-${messages.length}-${tools.length}`,
              name: b.name || 'tool',
              input: b.input ?? {},
              status: 'completed',
              output: '',
            }
            tools.push(toolObj)
            toolIndex.set(toolObj.id, toolObj)
          }
        }

        if (textParts.length > 0 || thinkingParts.length > 0 || tools.length > 0) {
          messages.push({
            id: obj.uuid || `cld-a-${messages.length}`,
            role: 'assistant',
            text: textParts.join('\n').trim(),
            thinking: thinkingParts.join('\n').trim() || undefined,
            tools: tools.length > 0 ? tools : undefined,
            ts,
          })
        }
      }
    }

    return { messages: mergeAndCompactMessages(messages), cwd, title, model }
  })
}

/**
 * Claude Code / Claude Desktop Local Code Sessions Adapter.
 * Uses official `claude -p --output-format stream-json --verbose [--resume <id>]`.
 */
export class ClaudeAdapter {
  constructor({ config = {}, log = console, emitEvent, onApprovalRequest }) {
    this.configuredBin = config.claudeBin
    this.claudeBin = findClaudeCommand(this.configuredBin)
    this.claudeHome = getClaudeHome()
    this.defaultCwd = config.cwd || process.cwd()
    this.permissionMode = config.claudePermissionMode || 'acceptEdits'
    this.log = log
    this.emitEvent = emitEvent || (() => {})
    this.onApprovalRequest = onApprovalRequest || (() => {})
    this.activeProcs = new Map() // sessionId -> { proc, aborted }
    this.pendingControlRequests = new Map() // approvalId -> { proc, requestId, toolName, toolInput, questions, sessionId }
    this.pendingCreated = new Map() // sessionId -> summary (before first turn persists jsonl)
    this.sessionPrefs = new Map() // sessionId -> { model, reasoningEffort }
  }

  refreshBinary() {
    this.claudeBin = findClaudeCommand(this.configuredBin)
    return this.claudeBin
  }

  async listModels() {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
    const baseModels = [
      { id: 'default', name: '默认模型 (Auto)', efforts, defaultEffort: 'high' },
      { id: 'opus', name: 'Claude Opus (Alias)', efforts, defaultEffort: 'high' },
      { id: 'sonnet', name: 'Claude Sonnet (Alias)', efforts, defaultEffort: 'medium' },
      { id: 'haiku', name: 'Claude Haiku (Alias)', efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
    ]
    const seen = new Set(baseModels.map((m) => m.id))
    // Enrich with real claude-* model IDs configured in the user's local gateway
    try {
      const dshCatalog = parseDshConfiguredModels()
      for (const m of dshCatalog.models || []) {
        if (!/^claude-/i.test(m.id) || seen.has(m.id)) continue
        seen.add(m.id)
        baseModels.push({
          id: m.id,
          name: m.name || m.id,
          efforts: m.efforts?.length ? m.efforts.filter((e) => e !== 'off') : efforts,
          defaultEffort: m.defaultEffort && m.defaultEffort !== 'off' ? m.defaultEffort : 'high',
        })
      }
    } catch {}
    return {
      app: APPS.CLAUDE,
      defaultModel: 'default',
      defaultEffort: 'high',
      supportsMidChatSwitch: true,
      models: baseModels,
    }
  }

  findSessionFile(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'Claude sessionId')
    const projectsDir = join(this.claudeHome, 'projects')
    if (!existsSync(projectsDir)) return null
    for (const proj of readdirSync(projectsDir)) {
      const projDir = join(projectsDir, proj)
      const candidate = assertPathWithinDir(join(projDir, `${sessionId}.jsonl`), projDir, 'Claude session file')
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  async getStatus() {
    this.claudeBin = findClaudeCommand(this.configuredBin)
    const projectsExists = existsSync(join(this.claudeHome, 'projects'))
    const cliAvailable = await new Promise((resolvePromise) => {
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
        done(false)
      }, 6_000)
      timer.unref?.()
      try {
        proc = spawnClaude(this.claudeBin, ['--version'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        let out = ''
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => { out += d })
        proc.on('close', (code) => done(code === 0 ? out.trim() : false))
        proc.on('error', () => done(false))
      } catch {
        done(false)
      }
    })

    return {
      app: APPS.CLAUDE,
      available: Boolean(cliAvailable) || projectsExists,
      writable: Boolean(cliAvailable),
      mode: cliAvailable ? 'claude-cli-stream' : 'readonly',
      detail: cliAvailable
        ? `已连接本地 ${cliAvailable}（支持全部本地 Claude Code / Desktop Code 会话流式续聊；注：纯网页云端 Chat 暂不支持）`
        : '未检测到 claude CLI，仅支持历史只读',
      activeCount: this.activeProcs.size,
    }
  }

  async listSessions({ limit = 80, search = '' } = {}) {
    const projectsDir = join(this.claudeHome, 'projects')
    const results = []
    const seen = new Set()

    // Include freshly created sessions not yet written to disk
    for (const pending of this.pendingCreated.values()) {
      seen.add(pending.nativeId)
      results.push({
        ...pending,
        status: this.activeProcs.has(pending.nativeId) ? 'running' : 'idle',
      })
    }

    if (existsSync(projectsDir)) {
      const allFiles = []
      for (const proj of readdirSync(projectsDir)) {
        const pDir = join(projectsDir, proj)
        let stat
        try { stat = statSync(pDir) } catch { continue }
        if (!stat.isDirectory()) continue
        for (const f of readdirSync(pDir)) {
          if (!f.endsWith('.jsonl')) continue
          const fp = join(pDir, f)
          try {
            const fst = statSync(fp)
            allFiles.push({ fp, proj, mtimeMs: fst.mtimeMs })
          } catch {}
        }
      }
      allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)

      // Scan most recent 150 files for crisp latency
      for (const entry of allFiles.slice(0, 150)) {
        const summary = scanClaudeSessionSummary(entry.fp, entry.proj)
        if (!summary || seen.has(summary.nativeId)) continue
        seen.add(summary.nativeId)
        delete summary.filePath
        if (this.activeProcs.has(summary.nativeId)) summary.status = 'running'
        results.push(summary)
      }
    }

    let filtered = results
    const q = String(search || '').trim().toLowerCase()
    if (q) {
      filtered = results.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.workspace.toLowerCase().includes(q),
      )
    }
    filtered.sort((a, b) => b.updatedAt - a.updatedAt)
    return filtered.slice(0, limit)
  }

  async readSession(sessionId, { limit = 25, cursor = null } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'Claude sessionId')
    const fp = this.findSessionFile(sessionId)
    if (!fp) {
      const pending = this.pendingCreated.get(sessionId)
      if (pending) {
        return {
          ...pending,
          messages: [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
        }
      }
      throw new Error(`找不到 Claude 会话：${sessionId}`)
    }
    const parsed = parseClaudeJsonlMessages(fp)
    const pref = this.sessionPrefs.get(sessionId)
    const total = parsed.messages.length
    const pageSize = Math.max(10, Math.min(Number(limit) || 25, 200))
    const endIdx =
      cursor !== null && cursor !== undefined && cursor !== '' && Number.isFinite(Number(cursor))
        ? Math.max(0, Math.min(total, Number(cursor)))
        : total
    const startIdx = Math.max(0, endIdx - pageSize)

    return {
      id: makeCompositeId(APPS.CLAUDE, sessionId),
      app: APPS.CLAUDE,
      nativeId: sessionId,
      title: parsed.title || sessionId,
      cwd: parsed.cwd,
      model: pref?.model || parsed.model || 'default',
      reasoningEffort: pref?.reasoningEffort || '',
      writable: true,
      status: this.activeProcs.has(sessionId) ? 'running' : 'idle',
      messages: parsed.messages.slice(startIdx, endIdx),
      hasMore: startIdx > 0,
      nextCursor: startIdx > 0 ? String(startIdx) : null,
      totalCount: total,
    }
  }

  async createSession({ cwd, title, model, reasoningEffort } = {}) {
    const sessionId = randomUUID()
    const targetCwd = String(cwd || '').trim() || this.defaultCwd
    if (model || reasoningEffort) {
      this.sessionPrefs.set(sessionId, { model: model || 'default', reasoningEffort: reasoningEffort || '' })
    }
    const summary = {
      id: makeCompositeId(APPS.CLAUDE, sessionId),
      app: APPS.CLAUDE,
      nativeId: sessionId,
      title: title || '新 Claude Code 对话',
      preview: '',
      cwd: targetCwd,
      workspace: basename(targetCwd),
      model: model || 'default',
      reasoningEffort: reasoningEffort || '',
      status: 'idle',
      writable: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.pendingCreated.set(sessionId, summary)
    return summary
  }

  async sendMessage(sessionId, { text, cwd, attachments = [], permissionMode, model, reasoningEffort } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'Claude sessionId')
    if (this.activeProcs.has(sessionId)) {
      const err = new Error('该 Claude 会话正在运行中，请等待完成或先点击停止。')
      err.code = 'SESSION_BUSY'
      throw err
    }

    const existingFile = this.findSessionFile(sessionId)
    let targetCwd = String(cwd || '').trim()
    if (!targetCwd && existingFile) {
      const sum = scanClaudeSessionSummary(existingFile, '')
      targetCwd = sum?.cwd || ''
    }
    if (!targetCwd) {
      targetCwd = this.pendingCreated.get(sessionId)?.cwd || this.defaultCwd
    }
    if (!existsSync(targetCwd)) targetCwd = this.defaultCwd

    let prompt = String(text || '').trim()
    if (attachments.length > 0) {
      const lines = attachments.map((a) => `- 附件文件：${a.localPath || a.filename}`)
      prompt = `${prompt}\n\n[手机端上传的附件，可直接读取]\n${lines.join('\n')}`
    }
    if (!prompt) throw new Error('消息内容不能为空')

    const pref = this.sessionPrefs.get(sessionId)
    const effectiveModel = assertSafeCliToken(model || pref?.model || '', 'model')
    const effectiveEffort = assertSafeCliToken(reasoningEffort || pref?.reasoningEffort || '', 'reasoningEffort')
    const effectivePermissionMode = assertSafeCliToken(
      permissionMode || this.permissionMode,
      'permissionMode',
      { allowEmpty: false },
    )
    if (effectiveModel || effectiveEffort) {
      this.sessionPrefs.set(sessionId, { model: effectiveModel || 'default', reasoningEffort: effectiveEffort || '' })
    }

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--permission-mode',
      effectivePermissionMode,
    ]
    if (effectiveModel && effectiveModel !== 'default') {
      args.push('--model', effectiveModel)
    }
    if (effectiveEffort && effectiveEffort !== 'off') {
      args.push('--effort', effectiveEffort)
    }
    // Preserve live Windows/OS ANTHROPIC_BASE_URL & credentials over any stale ~/.claude/settings.json proxy
    const envOverride = {}
    if (process.env.ANTHROPIC_BASE_URL) envOverride.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL
    if (process.env.ANTHROPIC_AUTH_TOKEN) envOverride.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN
    if (process.env.ANTHROPIC_API_KEY) envOverride.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    if (Object.keys(envOverride).length > 0) {
      args.push('--settings', JSON.stringify({ env: envOverride }))
    }
    if (existingFile) {
      args.push('--resume', sessionId)
    } else {
      args.push('--session-id', sessionId)
    }

    const compositeId = makeCompositeId(APPS.CLAUDE, sessionId)
    this.emitEvent(EVENTS.STREAM_START, {
      sessionId: compositeId,
      app: APPS.CLAUDE,
      nativeId: sessionId,
    })

    return new Promise((resolvePromise, rejectPromise) => {
      const proc = spawnClaude(this.claudeBin, args, {
        cwd: targetCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      proc.stdout.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')

      const state = { proc, aborted: false }
      this.activeProcs.set(sessionId, state)

      let stdoutBuf = ''
      let stderrBuf = ''
      let finalText = ''
      let seenResult = false
      const emittedTextByMsg = new Map()
      const emittedThinkByMsg = new Map()
      let lastTextMsgId = null
      let lastThinkMsgId = null
      const seenToolIds = new Set()
      let resultError = ''

      const handleJsonLine = (line) => {
        let obj
        try {
          obj = JSON.parse(line)
        } catch {
          return
        }

        if (obj.type === 'assistant') {
          const msgId = String(obj.message?.id || '__default__')
          const blocks = Array.isArray(obj.message?.content) ? obj.message.content : []
          let fullText = ''
          let fullThink = ''
          for (const b of blocks) {
            if (b?.type === 'thinking' && b.thinking) {
              fullThink += b.thinking
            } else if (b?.type === 'tool_use' && b.id && !seenToolIds.has(b.id)) {
              seenToolIds.add(b.id)
              this.emitEvent(EVENTS.STREAM_TOOL_START, {
                sessionId: compositeId,
                app: APPS.CLAUDE,
                tool: { id: b.id, name: b.name || 'tool', input: b.input ?? {} },
              })
            } else if (b?.type === 'text' && typeof b.text === 'string') {
              fullText += b.text
            }
          }
          const prevThink = emittedThinkByMsg.get(msgId) || ''
          if (fullThink) {
            if (prevThink && fullThink.startsWith(prevThink)) {
              const rawThinkDelta = fullThink.slice(prevThink.length)
              if (rawThinkDelta) {
                emittedThinkByMsg.set(msgId, fullThink)
                lastThinkMsgId = msgId
                this.emitEvent(EVENTS.STREAM_THINKING, {
                  sessionId: compositeId,
                  app: APPS.CLAUDE,
                  delta: rawThinkDelta,
                })
              }
            } else if (fullThink !== prevThink) {
              const thinkPrefix = lastThinkMsgId ? '\n\n' : ''
              emittedThinkByMsg.set(msgId, fullThink)
              lastThinkMsgId = msgId
              this.emitEvent(EVENTS.STREAM_THINKING, {
                sessionId: compositeId,
                app: APPS.CLAUDE,
                delta: `${thinkPrefix}${fullThink}`,
              })
            }
          }
          const prevText = emittedTextByMsg.get(msgId) || ''
          if (fullText) {
            if (prevText && fullText.startsWith(prevText)) {
              const rawDelta = fullText.slice(prevText.length)
              if (rawDelta) {
                emittedTextByMsg.set(msgId, fullText)
                lastTextMsgId = msgId
                finalText += rawDelta
                this.emitEvent(EVENTS.STREAM_DELTA, {
                  sessionId: compositeId,
                  app: APPS.CLAUDE,
                  delta: rawDelta,
                })
              }
            } else if (fullText !== prevText) {
              const textPrefix = finalText ? '\n\n' : ''
              const delta = `${textPrefix}${fullText}`
              emittedTextByMsg.set(msgId, fullText)
              lastTextMsgId = msgId
              finalText += delta
              this.emitEvent(EVENTS.STREAM_DELTA, {
                sessionId: compositeId,
                app: APPS.CLAUDE,
                delta,
              })
            }
          }
        } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
          for (const b of obj.message.content) {
            if (b?.type === 'tool_result' && b.tool_use_id) {
              this.emitEvent(EVENTS.STREAM_TOOL_END, {
                sessionId: compositeId,
                app: APPS.CLAUDE,
                toolId: b.tool_use_id,
                status: b.is_error ? 'error' : 'completed',
                output: extractTextFromContent(b.content).slice(0, 3000),
              })
            }
          }
        } else if (obj.type === 'control_request' && obj.request_id && obj.request) {
          this.handleControlRequest(proc, sessionId, compositeId, targetCwd, obj)
        } else if (obj.type === 'result') {
          seenResult = true
          if (obj.is_error) {
            resultError = String(obj.result || obj.error || 'Claude 执行返回错误')
          } else if (typeof obj.result === 'string' && obj.result.length > 0) {
            const trimmedResult = obj.result.trim()
            if (!lastTextMsgId) {
              finalText = obj.result
              this.emitEvent(EVENTS.STREAM_DELTA, {
                sessionId: compositeId,
                app: APPS.CLAUDE,
                delta: obj.result,
              })
            } else if (trimmedResult && !finalText.trimEnd().endsWith(trimmedResult)) {
              const lastEmitted = emittedTextByMsg.get(lastTextMsgId) || ''
              if (
                lastEmitted &&
                obj.result.startsWith(lastEmitted) &&
                obj.result.length > lastEmitted.length &&
                finalText.endsWith(lastEmitted)
              ) {
                const suffix = obj.result.slice(lastEmitted.length)
                emittedTextByMsg.set(lastTextMsgId, obj.result)
                finalText += suffix
                this.emitEvent(EVENTS.STREAM_DELTA, {
                  sessionId: compositeId,
                  app: APPS.CLAUDE,
                  delta: suffix,
                })
              } else {
                const delta = `${finalText ? '\n\n' : ''}${obj.result}`
                emittedTextByMsg.set(lastTextMsgId, obj.result)
                finalText += delta
                this.emitEvent(EVENTS.STREAM_DELTA, {
                  sessionId: compositeId,
                  app: APPS.CLAUDE,
                  delta,
                })
              }
            }
          }
          // Close stdin cleanly once the turn finishes so the bidirectional stream-json process exits
          try { proc.stdin.end() } catch {}
        }
      }

      proc.stdin?.on('error', () => {})

      proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk
        let idx
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim()
          stdoutBuf = stdoutBuf.slice(idx + 1)
          if (line) handleJsonLine(line)
        }
      })

      proc.stderr.on('data', (chunk) => {
        stderrBuf = (stderrBuf + chunk).slice(-4096)
      })

      proc.on('error', (err) => {
        if (this.activeProcs.get(sessionId) === state) {
          this.activeProcs.delete(sessionId)
        }
        this.clearPendingControlRequests(proc)
        if (err && typeof err === 'object') err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: APPS.CLAUDE,
          message: String(err?.message || err),
        })
        rejectPromise(err)
      })

      proc.on('close', (code) => {
        if (stdoutBuf.trim()) handleJsonLine(stdoutBuf.trim())
        if (this.activeProcs.get(sessionId) === state) {
          this.activeProcs.delete(sessionId)
        }
        this.clearPendingControlRequests(proc)

        if (resultError && !state.aborted) {
          if (this.findSessionFile(sessionId)) {
            this.pendingCreated.delete(sessionId)
          }
          const err = new Error(resultError)
          err._streamErrorEmitted = true
          this.emitEvent(EVENTS.STREAM_ERROR, {
            sessionId: compositeId,
            app: APPS.CLAUDE,
            message: resultError,
          })
          rejectPromise(err)
          return
        }

        if (code !== 0 && !state.aborted && !seenResult) {
          if (this.findSessionFile(sessionId)) {
            this.pendingCreated.delete(sessionId)
          }
          const errMsg = stderrBuf.trim() || `claude 进程退出（code=${code}）`
          const err = new Error(errMsg)
          err._streamErrorEmitted = true
          this.emitEvent(EVENTS.STREAM_ERROR, {
            sessionId: compositeId,
            app: APPS.CLAUDE,
            message: errMsg,
          })
          rejectPromise(err)
          return
        }

        if (!state.aborted || this.findSessionFile(sessionId)) {
          this.pendingCreated.delete(sessionId)
        }

        this.emitEvent(EVENTS.STREAM_DONE, {
          sessionId: compositeId,
          app: APPS.CLAUDE,
          nativeId: sessionId,
          finalText,
          aborted: state.aborted,
        })
        resolvePromise({
          sessionId: compositeId,
          nativeId: sessionId,
          finalText,
          aborted: state.aborted,
        })
      })

      // Feed turn cleanly via bidirectional NDJSON stream-json protocol (keep stdin open for control_response!)
      const userFrame = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      })
      proc.stdin.write(`${userFrame}\n`, 'utf8')
    })
  }

  clearPendingControlRequests(proc) {
    for (const [aprId, entry] of this.pendingControlRequests.entries()) {
      if (entry.proc === proc) {
        this.pendingControlRequests.delete(aprId)
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, { id: aprId, app: APPS.CLAUDE, decision: 'cancel' })
      }
    }
  }

  writeControlResponse(proc, requestId, responseBody) {
    if (!proc || !proc.stdin?.writable) return false
    const frame = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: responseBody,
      },
    })
    proc.stdin.write(`${frame}\n`, 'utf8')
    return true
  }

  handleControlRequest(proc, sessionId, compositeId, cwd, obj) {
    const requestId = String(obj.request_id)
    const req = obj.request || {}
    if (req.subtype !== 'can_use_tool') {
      // Acknowledge non-tool control requests safely
      this.writeControlResponse(proc, requestId, { behavior: 'allow' })
      return
    }

    const toolName = String(req.tool_name || 'tool')
    const toolInput = req.input && typeof req.input === 'object' ? req.input : {}

    if (toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions) && toolInput.questions.length > 0) {
      const aprId = `cld-q-${randomUUID().slice(0, 10)}`
      const questions = toolInput.questions.map((q, idx) => {
        const opts = Array.isArray(q?.options)
          ? q.options
              .filter((o) => o && typeof o.label === 'string')
              .map((o) => ({
                value: o.label,
                label: o.label,
                description: typeof o.description === 'string' ? o.description : '',
              }))
          : []
        return {
          id: String(q?.id || `q_${idx}`),
          origQuestion: String(q?.question || ''),
          header: String(q?.header || '').trim(),
          question: String(q?.question || '').trim() || `问题 ${idx + 1}`,
          description: '',
          multiSelect: Boolean(q?.multiSelect),
          allowOther: true,
          inputType: opts.length > 0 ? 'select' : 'text',
          required: true,
          options: opts,
        }
      })

      this.pendingControlRequests.set(aprId, {
        proc,
        requestId,
        toolName,
        toolInput,
        questions,
        sessionId,
      })

      this.onApprovalRequest({
        id: aprId,
        app: APPS.CLAUDE,
        sessionId: compositeId,
        kind: 'question',
        title: 'Claude 需要你做选择',
        detail: '',
        questions: questions.map(({ origQuestion: _drop, ...publicQ }) => publicQ),
        createdAt: Date.now(),
      })
      return
    }

    if (toolName === 'ExitPlanMode') {
      const aprId = `cld-plan-${randomUUID().slice(0, 10)}`
      this.pendingControlRequests.set(aprId, {
        proc,
        requestId,
        toolName,
        toolInput,
        sessionId,
      })
      this.onApprovalRequest({
        id: aprId,
        app: APPS.CLAUDE,
        sessionId: compositeId,
        kind: 'permissions',
        title: 'Claude 计划已就绪',
        detail: String(toolInput.plan || '是否批准当前计划并开始执行？').slice(0, 1500),
        cwd,
        options: [
          { value: 'allow', label: '批准执行', style: 'primary' },
          { value: 'deny', label: '拒绝', style: 'danger' },
        ],
        createdAt: Date.now(),
      })
      return
    }

    const aprId = `cld-apr-${randomUUID().slice(0, 10)}`
    this.pendingControlRequests.set(aprId, {
      proc,
      requestId,
      toolName,
      toolInput,
      sessionId,
    })

    const detail =
      toolInput.command ||
      toolInput.file_path ||
      toolInput.path ||
      toolInput.description ||
      JSON.stringify(toolInput, null, 2)

    this.onApprovalRequest({
      id: aprId,
      app: APPS.CLAUDE,
      sessionId: compositeId,
      kind: toolName === 'Edit' || toolName === 'Write' ? 'file_change' : 'command',
      title: `Claude 请求使用 ${toolName}`,
      detail: String(detail || toolName).slice(0, 1200),
      cwd,
      options: [
        { value: 'allow', label: '允许', style: 'primary' },
        { value: 'deny', label: '拒绝', style: 'danger' },
      ],
      createdAt: Date.now(),
    })
  }

  async resolveApproval(approvalId, decisionOrPayload) {
    const entry = this.pendingControlRequests.get(approvalId)
    if (!entry) return { resolved: false, reason: 'approval not found' }
    this.pendingControlRequests.delete(approvalId)

    const { decision, answers } = normalizeResolvePayload(decisionOrPayload)

    if (entry.toolName === 'AskUserQuestion') {
      const cancelled = decision === 'cancel' || decision === 'decline' || decision === 'deny'
      if (cancelled) {
        this.writeControlResponse(entry.proc, entry.requestId, {
          behavior: 'deny',
          message: 'User cancelled the question',
        })
      } else {
        const claudeAnswers = {}
        for (const q of entry.questions || []) {
          const ans = normalizeSingleAnswer(answers[q.id])
          const key = q.origQuestion || q.question
          claudeAnswers[key] = q.multiSelect
            ? ans.combined.join(', ')
            : (ans.selected[0] || ans.custom || '')
        }
        this.writeControlResponse(entry.proc, entry.requestId, {
          behavior: 'allow',
          updatedInput: {
            ...entry.toolInput,
            questions: entry.toolInput?.questions || [],
            answers: claudeAnswers,
          },
        })
      }
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
        id: approvalId,
        app: APPS.CLAUDE,
        decision: cancelled ? 'cancel' : 'submit',
      })
      return { resolved: true, id: approvalId, decision: cancelled ? 'cancel' : 'submit' }
    }

    const allowed = decision === 'allow' || decision === 'accept' || decision === 'acceptForSession'
    this.writeControlResponse(
      entry.proc,
      entry.requestId,
      allowed
        ? { behavior: 'allow', updatedInput: entry.toolInput || {} }
        : { behavior: 'deny', message: 'User denied tool execution' },
    )
    this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
      id: approvalId,
      app: APPS.CLAUDE,
      decision: allowed ? 'allow' : 'deny',
    })
    return { resolved: true, id: approvalId, decision: allowed ? 'allow' : 'deny' }
  }

  async interrupt(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'Claude sessionId')
    const active = this.activeProcs.get(sessionId)
    if (!active) return { interrupted: false, sessionId }
    active.aborted = true
    this.clearPendingControlRequests(active.proc)
    const proc = active.proc
    try {
      proc.stdin?.end()
    } catch {}
    try {
      proc.kill('SIGTERM')
    } catch {}
    if (proc.exitCode === null && proc.signalCode === null) {
      const killTimer = setTimeout(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) return
        if (process.platform === 'win32' && proc.pid) {
          try {
            const tk = spawnCrossPlatform('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            })
            tk.on('error', () => {})
          } catch {}
        }
        try { proc.kill('SIGKILL') } catch {}
      }, 2_000)
      killTimer.unref?.()
      proc.once('close', () => clearTimeout(killTimer))
    }
    return { interrupted: true, sessionId }
  }

  async dispose() {
    for (const active of this.activeProcs.values()) {
      try { active.proc.kill() } catch {}
    }
    this.activeProcs.clear()
  }
}
