import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { APPS, EVENTS, makeCompositeId, toEpochMs } from '../protocol.js'
import { parseDshConfiguredModels } from '../helpers/dsh-models.js'
import { mergeAndCompactMessages } from '../helpers/history-normalize.js'

/**
 * Build a properly identified DSH UserMessage.
 * Required by DSH's session store (`agent.followup`) so loaded sessions remain readable.
 */
function buildDshUserMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

function getDshHome() {
  return String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function extractDshImageBlock(b) {
  if (!b || typeof b !== 'object') return null
  if (b.type === 'image') {
    if (b.source?.type === 'base64' && b.source?.data) {
      const mt = b.source.media_type || b.source.mediaType || 'image/png'
      return { url: `data:${mt};base64,${b.source.data}`, name: b.name || 'image' }
    }
    if (b.data && typeof b.data === 'string') {
      const mt = b.mimeType || b.media_type || 'image/png'
      return {
        url: b.data.startsWith('data:') ? b.data : `data:${mt};base64,${b.data}`,
        name: b.name || 'image',
      }
    }
    if (b.path || b.filePath) {
      const p = b.path || b.filePath
      return { path: p, name: basename(p) }
    }
    if (b.url) return { url: b.url, name: b.name || 'image' }
  }
  if (b.type === 'image_url') {
    const u = typeof b.image_url === 'string' ? b.image_url : b.image_url?.url
    if (u) return { url: u, name: 'image' }
  }
  return null
}

/**
 * Extract normalized messages from live DSH `session.ownEvents()`.
 */
function parseDshEvents(events) {
  const messages = []
  const toolIndex = new Map()

  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue
    const ts = toEpochMs(ev.timestamp || ev.at || ev.createdAt || Date.now())

    if (ev.type === 'user/message') {
      const blocks = ev.data?.message?.content ?? ev.data?.content ?? []
      const images = []
      const text = Array.isArray(blocks)
        ? blocks
            .map((b) => {
              if (b?.type === 'text' && typeof b.text === 'string') return b.text
              const img = extractDshImageBlock(b)
              if (img) images.push(img)
              return ''
            })
            .filter(Boolean)
            .join('\n')
        : String(ev.data?.text ?? '')
      if (text.trim().length > 0 || images.length > 0) {
        messages.push({
          id: ev.data?.message?.id || ev.data?.id || `u-${ev.seq}`,
          role: 'user',
          text,
          ...(images.length > 0 ? { images } : {}),
          ts,
          seq: ev.seq,
        })
      }
      continue
    }

    if (ev.type === 'assistant/message') {
      const blocks = ev.data?.message?.content ?? ev.data?.content ?? []
      if (!Array.isArray(blocks)) continue
      const thinkingParts = []
      const textParts = []
      const tools = []
      const images = []

      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'thinking' || b.type === 'reasoning') {
          const t = b.thinking ?? b.reasoning ?? b.text ?? ''
          if (t) thinkingParts.push(t)
        } else if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text)
        } else if (b.type === 'tool_use' || b.type === 'tool_call') {
          const toolObj = {
            id: b.id || `tool-${ev.seq}-${tools.length}`,
            name: b.name || 'tool',
            input: b.input ?? b.arguments ?? {},
            status: 'running',
            output: null,
          }
          tools.push(toolObj)
          toolIndex.set(toolObj.id, toolObj)
        } else {
          const img = extractDshImageBlock(b)
          if (img) images.push(img)
        }
      }

      if (textParts.length > 0 || thinkingParts.length > 0 || tools.length > 0 || images.length > 0) {
        messages.push({
          id: ev.data?.message?.id || `a-${ev.seq}`,
          role: 'assistant',
          text: textParts.join('\n').trim(),
          thinking: thinkingParts.join('\n').trim() || undefined,
          tools: tools.length > 0 ? tools : undefined,
          ...(images.length > 0 ? { images } : {}),
          ts,
          seq: ev.seq,
        })
      }
      continue
    }

    if (ev.type === 'tool/result' || ev.type === 'tool_result') {
      const callId = ev.data?.toolCallId || ev.data?.id || ev.data?.callId
      const target = callId ? toolIndex.get(callId) : null
      const resultBlocks = ev.data?.content ?? ev.data?.output ?? ev.data?.result
      const summary = typeof resultBlocks === 'string'
        ? resultBlocks
        : Array.isArray(resultBlocks)
          ? resultBlocks.map((b) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('\n')
          : resultBlocks !== undefined
            ? JSON.stringify(resultBlocks, null, 2)
            : ''
      if (target) {
        target.status = ev.data?.isError ? 'error' : 'completed'
        target.output = summary.slice(0, 4000)
      }
    }
  }

  return messages
}

/**
 * Fallback parser from `~/.dsh/storages/session_projcache/sessions/<id>.json`.
 */
function parseProjCacheMessages(cacheRecord) {
  const turns = cacheRecord?.record?.rows?.turnOutline?.val?.turns
  if (!Array.isArray(turns)) return []
  const created = toEpochMs(cacheRecord?.record?.identity?.createdAt)
  const messages = []
  for (const t of turns) {
    if (typeof t.prompt === 'string' && t.prompt.trim().length > 0) {
      messages.push({
        id: `cache-u-${t.turn}-${t.seq}`,
        role: 'user',
        text: t.prompt,
        ts: created,
      })
    }
    if (typeof t.response === 'string' && t.response.trim().length > 0) {
      messages.push({
        id: `cache-a-${t.turn}-${t.seq}`,
        role: 'assistant',
        text: t.response,
        ts: created,
      })
    }
  }
  return messages
}

export class DshAdapter {
  constructor({ ctx = null, config = {}, log = console, emitEvent }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.emitEvent = emitEvent || (() => {})
    this.dshHome = getDshHome()
    this.defaultCwd = resolve(
      String(config.cwd ?? '').trim() ||
        ctx?.get?.('workingDirectory')?.defaultDirectory ||
        process.cwd(),
    )
    this.permissionPreset = String(config.permissionPreset ?? 'danger-full-access').trim()
    this.agentPreset = String(config.agentPreset ?? '').trim() || undefined
    this.activeTurns = new Map() // sessionId -> { agent, aborting, startedAt }
    this.ownedHandles = new Map()
    this.sessionModels = new Map() // sessionId -> { provider, model, reasoningEffort }
  }

  async listModels() {
    const parsed = parseDshConfiguredModels()
    return {
      app: APPS.DSH,
      defaultProvider: parsed.defaultProvider,
      defaultModel: parsed.defaultModel,
      defaultEffort: parsed.defaultEffort,
      providers: parsed.providers || [],
      supportsMidChatSwitch: true,
      models: parsed.models,
    }
  }

  async applyModelSelection(agent, sessionId, { provider, model, reasoningEffort } = {}) {
    if (!model && !reasoningEffort) return
    const parsed = parseDshConfiguredModels()
    const matched = parsed.models.find((m) => m.id === model && (!provider || m.provider === provider))
    const resolvedProvider = provider || matched?.provider || parsed.defaultProvider
    const normalizedEffort = reasoningEffort === 'off' ? null : reasoningEffort || null
    const selection = {
      provider: resolvedProvider,
      model: model || parsed.defaultModel,
      reasoningEffort: normalizedEffort,
    }
    this.sessionModels.set(sessionId, selection)
    if (!this.ctx) return

    // Probe official DSH Cordis model-selection hooks safely across versions
    try {
      const controller = this.ctx.get?.('sessionController')
      if (typeof controller?.selectModel === 'function') {
        await controller.selectModel(sessionId, selection)
        return
      }
      if (typeof controller?.setModelSelection === 'function') {
        await controller.setModelSelection(sessionId, selection)
        return
      }
      if (typeof this.ctx.agents?.selectForNextRequest === 'function') {
        await this.ctx.agents.selectForNextRequest(sessionId, selection)
        return
      }
      if (typeof this.ctx.agents?.selectModel === 'function') {
        await this.ctx.agents.selectModel(sessionId, selection)
        return
      }
      const sess = agent?.session || this.ctx.get?.('sessions')?.get?.(sessionId)
      const modelSvc = this.ctx.get?.('modelSelection') || this.ctx.get?.('agentModelSelection')
      if (modelSvc && sess) {
        if (typeof modelSvc.select === 'function') {
          await modelSvc.select(sess, selection)
          return
        }
        if (typeof modelSvc.setPending === 'function') {
          await modelSvc.setPending(sess, selection)
          return
        }
        if (typeof modelSvc.set === 'function') {
          await modelSvc.set(sess, selection)
          return
        }
      }
      if (typeof agent?.selectModel === 'function') {
        await agent.selectModel(selection)
        return
      }
      if (typeof agent?.setModel === 'function') {
        await agent.setModel(selection)
        return
      }
      this.log.info?.(
        `mobile-hub: DSH model selection cached (${selection.provider}/${selection.model} effort=${selection.reasoningEffort ?? 'off'}); no live Cordis setter matched`,
      )
    } catch (err) {
      this.log.warn?.(`mobile-hub: DSH applyModelSelection(${sessionId}) failed: ${String(err)}`)
    }
  }

  isLive() {
    return Boolean(this.ctx && (this.ctx.agents || this.ctx.get?.('sessionController')))
  }

  async getStatus() {
    const storagesExists = existsSync(join(this.dshHome, 'storages'))
    return {
      app: APPS.DSH,
      available: this.isLive() || storagesExists,
      writable: this.isLive(),
      mode: this.isLive() ? 'cordis-live' : 'standalone-readonly',
      detail: this.isLive()
        ? '已挂载到 DeepSeek Harness 核心引擎（零侵入纯桥接，0 额外 Token 与工具注入）'
        : '独立调试模式（可浏览 DSH 历史；在 DeepSeek Harness 内启用插件后即可原位续聊）',
      activeCount: this.activeTurns.size,
    }
  }

  async listWorkspaces() {
    const wsPath = join(this.dshHome, 'storages', 'workspace.json')
    const data = readJsonSafe(wsPath)
    const tables = data?.tables?.workspaces || {}
    const list = Object.entries(tables).map(([id, row]) => ({
      id,
      path: row.path || '',
      title: row.title || basename(row.path || id),
      sessionCount: Array.isArray(row.sessionIds) ? row.sessionIds.length : 0,
      updatedAt: toEpochMs(row.updatedAt || row.createdAt),
    }))
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    return list
  }

  async listSessions({ limit = 80, search = '', includeArchived = false } = {}) {
    const wsPath = join(this.dshHome, 'storages', 'workspace.json')
    const wsData = readJsonSafe(wsPath)
    const archivedSet = new Set(wsData?.global?.archivedSessionIds || [])
    const pinnedSet = new Set(wsData?.global?.pinnedSessionIds || [])

    // Map sessionId -> workspace info
    const sessionWsMap = new Map()
    for (const row of Object.values(wsData?.tables?.workspaces || {})) {
      for (const sid of row.sessionIds || []) {
        sessionWsMap.set(sid, { path: row.path, title: row.title })
      }
    }

    const cacheDir = join(this.dshHome, 'storages', 'session_projcache', 'sessions')
    const byId = new Map()

    if (existsSync(cacheDir)) {
      for (const file of readdirSync(cacheDir)) {
        if (!file.endsWith('.json')) continue
        const sessionId = file.slice(0, -5)
        const archived = archivedSet.has(sessionId)
        if (!includeArchived && archived) continue
        const fp = join(cacheDir, file)
        const rec = readJsonSafe(fp)
        if (!rec?.record) continue

        let mtimeMs = 0
        try { mtimeMs = statSync(fp).mtimeMs } catch {}

        const identity = rec.record.identity || {}
        const rows = rec.record.rows || {}
        const wsInfo = sessionWsMap.get(sessionId)
        const cwd = identity.cwd || wsInfo?.path || ''
        const turns = rows.turnOutline?.val?.turns || []
        const firstPrompt = turns[0]?.prompt || ''
        const lastTurn = turns[turns.length - 1]
        const rawTitle = rows.title?.val || ''
        const title = rawTitle.trim() || firstPrompt.trim().slice(0, 48) || sessionId
        const preview = (lastTurn?.response || lastTurn?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        const modelInfo = rows.modelSelection?.val?.lastUsed
        const model = modelInfo ? `${modelInfo.model || ''}`.trim() : ''
        const isRunning = this.activeTurns.has(sessionId) || Boolean(rows.approvalState?.val?.turnOpen)

        byId.set(sessionId, {
          id: makeCompositeId(APPS.DSH, sessionId),
          app: APPS.DSH,
          nativeId: sessionId,
          title,
          preview,
          cwd,
          workspace: wsInfo?.title || (cwd ? basename(cwd) : ''),
          model,
          turnCount: rows.sessionStats?.val?.turns ?? turns.length,
          status: isRunning ? 'running' : 'idle',
          pinned: pinnedSet.has(sessionId),
          archived,
          writable: this.isLive(),
          createdAt: toEpochMs(identity.createdAt) || mtimeMs,
          updatedAt: mtimeMs || toEpochMs(identity.createdAt),
        })
      }
    }

    // Merge live in-memory sessions not yet flushed to projcache
    if (this.ctx) {
      try {
        const sessionsSvc = this.ctx.get?.('sessions')
        const titlesSvc = this.ctx.get?.('sessionTitle')
        const iter = typeof sessionsSvc?.values === 'function'
          ? sessionsSvc.values()
          : typeof sessionsSvc?.list === 'function'
            ? sessionsSvc.list()
            : []
        for (const sess of iter || []) {
          const sid = sess?.id
          if (!sid) continue
          const existing = byId.get(sid)
          const liveTitle = titlesSvc?.get?.(sess)?.title || existing?.title || sid
          const isRunning = this.activeTurns.has(sid)
          if (existing) {
            existing.title = liveTitle
            if (isRunning) existing.status = 'running'
          } else {
            byId.set(sid, {
              id: makeCompositeId(APPS.DSH, sid),
              app: APPS.DSH,
              nativeId: sid,
              title: liveTitle,
              preview: '',
              cwd: sess?.meta?.cwd || this.defaultCwd,
              workspace: basename(sess?.meta?.cwd || this.defaultCwd),
              model: '',
              turnCount: 0,
              status: isRunning ? 'running' : 'idle',
              pinned: false,
              archived: false,
              writable: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            })
          }
        }
      } catch {}
    }

    let items = [...byId.values()]
    const q = String(search || '').trim().toLowerCase()
    if (q) {
      items = items.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.workspace.toLowerCase().includes(q),
      )
    }
    items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    return items.slice(0, limit)
  }

  async readSession(sessionId, { limit = 25, cursor = null } = {}) {
    let messages = []
    let title = sessionId
    let cwd = ''
    let model = ''
    let liveLoaded = false

    // 1) Try live Cordis session first for rich events (thinking + tool calls)
    if (this.ctx) {
      try {
        let session = this.ctx.get?.('sessions')?.get?.(sessionId)
        if (!session) {
          const controller = this.ctx.get?.('sessionController')
          if (controller) {
            const resolved = await controller.resolveAgent(sessionId)
            if (resolved && !('error' in resolved)) {
              session = resolved.agent?.session
            }
          }
        }
        if (session && typeof session.ownEvents === 'function') {
          messages = parseDshEvents(session.ownEvents())
          const t = this.ctx.get?.('sessionTitle')?.get?.(session)
          if (t?.title) title = t.title
          cwd = session.meta?.cwd || cwd
          liveLoaded = true
        }
      } catch (err) {
        this.log.warn?.(`mobile-hub: live readSession(${sessionId}) fallback to cache: ${String(err)}`)
      }
    }

    // 2) Enrich or fallback from projcache JSON
    const cacheFile = join(this.dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    const cacheRec = readJsonSafe(cacheFile)
    let provider = ''
    let reasoningEffort = ''
    if (cacheRec?.record) {
      cwd = cwd || cacheRec.record.identity?.cwd || ''
      const cachedTitle = cacheRec.record.rows?.title?.val
      if (cachedTitle && title === sessionId) title = cachedTitle
      const lu = cacheRec.record.rows?.modelSelection?.val?.lastUsed
      model = lu?.model || ''
      provider = lu?.provider || ''
      reasoningEffort = lu?.reasoningEffort || ''
      if (!liveLoaded || messages.length === 0) {
        messages = parseProjCacheMessages(cacheRec)
      }
    }
    const overridden = this.sessionModels.get(sessionId)
    if (overridden) {
      model = overridden.model || model
      provider = overridden.provider || provider
      reasoningEffort = overridden.reasoningEffort ?? reasoningEffort
    }

    const normalized = mergeAndCompactMessages(messages)
    const total = normalized.length
    const pageSize = Math.max(8, Math.min(Number(limit) || 14, 100))
    const endIdx =
      cursor !== null && cursor !== undefined && cursor !== '' && Number.isFinite(Number(cursor))
        ? Math.max(0, Math.min(total, Number(cursor)))
        : total
    const startIdx = Math.max(0, endIdx - pageSize)
    const pageMessages = normalized.slice(startIdx, endIdx)

    return {
      id: makeCompositeId(APPS.DSH, sessionId),
      app: APPS.DSH,
      nativeId: sessionId,
      title,
      cwd,
      model,
      provider,
      reasoningEffort,
      writable: this.isLive(),
      status: this.activeTurns.has(sessionId) ? 'running' : 'idle',
      messages: pageMessages,
      hasMore: startIdx > 0,
      nextCursor: startIdx > 0 ? String(startIdx) : null,
      totalCount: total,
    }
  }

  async ensureAgent(sessionId, cwd, title) {
    if (!this.isLive()) {
      throw new Error('当前以独立模式运行，未挂载在 DeepSeek Harness 内部。请将 dsh-mobile-hub 链接进 DeepSeek Harness desktop profile 后重启 DSH 即可控制 DSH 会话。')
    }
    const targetCwd = resolve(String(cwd || '').trim() || this.defaultCwd)
    const controller = this.ctx.get?.('sessionController')

    if (controller !== undefined) {
      if (sessionId) {
        const found = await controller.resolveAgent(sessionId)
        if (found && !('error' in found)) {
          return { agent: found.agent, sessionId: found.agent.id || sessionId, created: false }
        }
      }
      const created = await controller.create({
        ...(sessionId ? { sessionId } : {}),
        cwd: targetCwd,
        ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}),
      })
      const sid = created.sessionId
      const resolved = await controller.resolveAgent(sid)
      if ('error' in resolved) throw resolved.error
      await this.afterCreate(sid, targetCwd, title)
      return { agent: resolved.agent, sessionId: sid, created: true }
    }

    const sid = sessionId || `mobile-${randomUUID()}`
    const live = this.ctx.agents.get(sid)
    if (live !== undefined) return { agent: live, sessionId: sid, created: false }
    const handle = await this.ctx.agents.create({
      sessionId: sid,
      meta: { cwd: targetCwd, ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}) },
    })
    this.ownedHandles.set(sid, handle)
    await this.afterCreate(sid, targetCwd, title)
    return { agent: handle.agent, sessionId: sid, created: true }
  }

  async afterCreate(sessionId, cwd, title) {
    const registry = this.ctx?.get?.('workspaceRegistry')
    if (registry) {
      try {
        const ws = await registry.resolveByPath(cwd)
        await ws?.attachSession(sessionId)
      } catch {}
    }
    const session = this.ctx?.get?.('sessions')?.get?.(sessionId)
    if (!session) return

    if (this.permissionPreset) {
      try {
        this.ctx?.get?.('permissionPresets')?.set?.(session, this.permissionPreset)
      } catch {}
    }

    if (title) {
      try {
        this.ctx?.get?.('sessionTitle')?.rename?.(session, title)
      } catch {}
    }
  }

  async createSession({ cwd, title, model, provider, reasoningEffort } = {}) {
    const targetCwd = resolve(String(cwd || '').trim() || this.defaultCwd)
    const sid = `mobile-${randomUUID().slice(0, 12)}`
    const { agent, sessionId } = await this.ensureAgent(sid, targetCwd, title || '手机端总控对话')
    if (model || reasoningEffort) {
      await this.applyModelSelection(agent, sessionId, { provider, model, reasoningEffort })
    }
    return {
      id: makeCompositeId(APPS.DSH, sessionId),
      app: APPS.DSH,
      nativeId: sessionId,
      title: title || '手机端总控对话',
      cwd: targetCwd,
      model: model || '',
      provider: provider || '',
      reasoningEffort: reasoningEffort || '',
      writable: true,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  async sendMessage(sessionId, { text, cwd, title, attachments = [], model, provider, reasoningEffort } = {}) {
    const compositeId = makeCompositeId(APPS.DSH, sessionId)
    const { agent, sessionId: resolvedId } = await this.ensureAgent(sessionId, cwd, title)
    const realCompositeId = makeCompositeId(APPS.DSH, resolvedId)
    if (model || reasoningEffort) {
      await this.applyModelSelection(agent, resolvedId, { provider, model, reasoningEffort })
    }

    let prompt = String(text || '').trim()
    if (attachments.length > 0) {
      const lines = attachments.map((a) => `- 附件：${a.localPath || a.filename} (${a.mimeType || 'file'})`)
      prompt = `${prompt}\n\n[手机端上传的附件，可用文件/图片工具直接读取]\n${lines.join('\n')}`
    }

    const fromSeq = agent.session?.seq ?? 0
    let cursorSeq = fromSeq
    const emittedTextMap = new Map()
    const emittedThinkMap = new Map()
    const seenToolStarts = new Set()
    const seenToolEnds = new Set()

    const turnState = { agent, startedAt: Date.now(), aborted: false }
    this.activeTurns.set(resolvedId, turnState)
    this.emitEvent(EVENTS.STREAM_START, {
      sessionId: realCompositeId,
      app: APPS.DSH,
      nativeId: resolvedId,
    })

    const flushNewEvents = () => {
      if (typeof agent.session?.ownEvents !== 'function') return
      const events = agent.session.ownEvents()
      for (const ev of events) {
        if (!ev || ev.seq <= cursorSeq) continue
        if (ev.type === 'assistant/message') {
          const msgId = ev.data?.message?.id || `a-${ev.seq}`
          const blocks = ev.data?.message?.content ?? []
          let fullThink = ''
          let fullText = ''
          for (const b of blocks) {
            if (b?.type === 'thinking' || b?.type === 'reasoning') {
              fullThink += b.thinking ?? b.reasoning ?? b.text ?? ''
            } else if (b?.type === 'text' && typeof b.text === 'string') {
              fullText += b.text
            } else if ((b?.type === 'tool_use' || b?.type === 'tool_call') && b.id && !seenToolStarts.has(b.id)) {
              seenToolStarts.add(b.id)
              this.emitEvent(EVENTS.STREAM_TOOL_START, {
                sessionId: realCompositeId,
                app: APPS.DSH,
                tool: { id: b.id, name: b.name || 'tool', input: b.input ?? b.arguments ?? {} },
              })
            }
          }
          const prevThink = emittedThinkMap.get(msgId) || ''
          if (fullThink.length > prevThink.length) {
            emittedThinkMap.set(msgId, fullThink)
            this.emitEvent(EVENTS.STREAM_THINKING, {
              sessionId: realCompositeId,
              app: APPS.DSH,
              delta: fullThink.slice(prevThink.length),
            })
          }
          const prevText = emittedTextMap.get(msgId) || ''
          if (fullText.length > prevText.length) {
            emittedTextMap.set(msgId, fullText)
            this.emitEvent(EVENTS.STREAM_DELTA, {
              sessionId: realCompositeId,
              app: APPS.DSH,
              delta: fullText.slice(prevText.length),
            })
          }
        } else if (ev.type === 'tool/result' || ev.type === 'tool_result') {
          const callId = ev.data?.toolCallId || ev.data?.id || ev.data?.callId
          if (callId && !seenToolEnds.has(callId)) {
            seenToolEnds.add(callId)
            const rawOut = ev.data?.content ?? ev.data?.output ?? ev.data?.result ?? ''
            const output = typeof rawOut === 'string'
              ? rawOut
              : Array.isArray(rawOut)
                ? rawOut.map((b) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('\n')
                : JSON.stringify(rawOut)
            this.emitEvent(EVENTS.STREAM_TOOL_END, {
              sessionId: realCompositeId,
              app: APPS.DSH,
              toolId: callId,
              status: ev.data?.isError ? 'error' : 'completed',
              output: output.slice(0, 3000),
            })
          }
        }
        cursorSeq = Math.max(cursorSeq, ev.seq)
      }
    }

    const pollTimer = setInterval(flushNewEvents, 250)
    try {
      agent.followup(buildDshUserMessage(prompt))
      await agent.whenIdle()
      flushNewEvents()

      // Final assistant text extraction
      let finalText = ''
      const events = typeof agent.session?.ownEvents === 'function' ? agent.session.ownEvents() : []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i]
        if (ev.seq <= fromSeq) break
        if (ev.type !== 'assistant/message') continue
        const blocks = ev.data?.message?.content ?? []
        const joined = blocks
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim()
        if (joined.length > 0) {
          finalText = joined
          break
        }
      }

      this.emitEvent(EVENTS.STREAM_DONE, {
        sessionId: realCompositeId,
        app: APPS.DSH,
        nativeId: resolvedId,
        finalText,
        aborted: turnState.aborted,
      })

      return {
        sessionId: realCompositeId,
        nativeId: resolvedId,
        finalText,
        aborted: turnState.aborted,
      }
    } catch (err) {
      this.emitEvent(EVENTS.STREAM_ERROR, {
        sessionId: compositeId,
        app: APPS.DSH,
        message: String(err?.message || err),
      })
      throw err
    } finally {
      clearInterval(pollTimer)
      this.activeTurns.delete(resolvedId)
    }
  }

  async interrupt(sessionId) {
    const active = this.activeTurns.get(sessionId)
    const agent = active?.agent || this.ctx?.agents?.get?.(sessionId)
    if (active) active.aborted = true
    if (agent) {
      if (typeof agent.abort === 'function') await agent.abort()
      else if (typeof agent.cancel === 'function') await agent.cancel()
      else if (typeof agent.interrupt === 'function') await agent.interrupt()
      return { interrupted: true, sessionId }
    }
    return { interrupted: false, sessionId }
  }

  async dispose() {
    for (const handle of this.ownedHandles.values()) {
      try { await handle.dispose?.() } catch {}
    }
    this.ownedHandles.clear()
  }
}
