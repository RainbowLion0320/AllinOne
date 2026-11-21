import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { APPS, APP_LIST, EVENTS, RPC, makeCompositeId, parseCompositeId } from './protocol.js'
import { DshAdapter } from './adapters/dsh.js'
import { CodexAdapter } from './adapters/codex.js'
import { ClaudeAdapter } from './adapters/claude.js'
import { AntigravityAdapter } from './adapters/antigravity.js'

/**
 * Central multi-app orchestrator powering BOTH:
 *   1) Mobile App RPC requests over Relay Server
 *   2) DeepSeek Harness Master Dispatch Tools (`allinone_*`)
 */
export class MultiAppOrchestrator {
  constructor({ ctx = null, config = {}, log = console, onEvent } = {}) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.onEvent = onEvent || (() => {})
    this.relayHttpBase = this.deriveHttpBase(config.relayUrl)
    this.bridgeSecret = config.secret || ''
    this.roomId = config.roomId || ''
    this.inboundDir = config.inboundDir || join(
      String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh'),
      'allinone-uploads',
    )

    /** @type {Map<string, any>} */
    this.pendingApprovals = new Map()
    /** @type {Map<string, any>} */
    this.dispatches = new Map()

    const emitEvent = (event, payload) => {
      try {
        this.onEvent(event, payload)
      } catch {}
    }

    const onApprovalRequest = (req) => {
      this.pendingApprovals.set(req.id, req)
      emitEvent(EVENTS.APPROVAL_REQUEST, req)
    }

    this.adapters = {
      [APPS.DSH]: new DshAdapter({ ctx, config, log, emitEvent }),
      [APPS.CODEX]: new CodexAdapter({ config, log, emitEvent, onApprovalRequest }),
      [APPS.CLAUDE]: new ClaudeAdapter({ config, log, emitEvent }),
      [APPS.ANTIGRAVITY]: new AntigravityAdapter({ config, log, emitEvent }),
    }
  }

  deriveHttpBase(wsUrl) {
    if (!wsUrl) return ''
    try {
      const u = new URL(wsUrl)
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
      u.pathname = u.pathname.replace(/\/ws\/bridge\/?$/, '')
      u.search = ''
      return u.toString().replace(/\/$/, '')
    } catch {
      return ''
    }
  }

  getAdapter(app) {
    const adapter = this.adapters[app]
    if (!adapter) throw new Error(`不支持的应用类型：${app}（可选：${APP_LIST.join(', ')}）`)
    return adapter
  }

  async getAppsStatus() {
    const results = await Promise.all(
      APP_LIST.map(async (app) => {
        try {
          return await this.adapters[app].getStatus()
        } catch (err) {
          return {
            app,
            available: false,
            writable: false,
            mode: 'error',
            detail: String(err?.message || err),
            activeCount: 0,
          }
        }
      }),
    )
    return results
  }

  async listWorkspaces() {
    const dshWs = await this.adapters[APPS.DSH].listWorkspaces().catch(() => [])
    // Deduplicate by normalized path
    const map = new Map()
    for (const w of dshWs) {
      if (w.path) map.set(w.path.toLowerCase(), w)
    }
    if (this.config.cwd && existsSync(this.config.cwd)) {
      const k = this.config.cwd.toLowerCase()
      if (!map.has(k)) {
        map.set(k, {
          name: basename(this.config.cwd) || this.config.cwd,
          path: this.config.cwd,
          source: 'default',
        })
      }
    }
    return [...map.values()]
  }

  async listSessions({ app = 'all', limit = 100, search = '' } = {}) {
    const isAll = !app || app === 'all'
    const targets = isAll ? APP_LIST : [app]
    const perAppLimit = isAll ? Math.max(10, Math.ceil(limit / APP_LIST.length)) : limit

    const settled = await Promise.allSettled(
      targets.map((a) => this.getAdapter(a).listSessions({ limit: perAppLimit, search })),
    )

    const all = []
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        all.push(...r.value)
      }
    }
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return isAll ? all : all.slice(0, limit)
  }

  async readSession({ id, app, sessionId, limit = 25, cursor = null } = {}) {
    const parsed = id ? parseCompositeId(id) : { app: app || APPS.DSH, sessionId }
    if (!parsed.sessionId) throw new Error('缺少 sessionId')
    return this.getAdapter(parsed.app).readSession(parsed.sessionId, { limit, cursor })
  }

  async listModels({ app = 'all' } = {}) {
    const targets = app && app !== 'all' ? [app] : APP_LIST
    const catalog = {}
    await Promise.all(
      targets.map(async (a) => {
        try {
          const adapter = this.getAdapter(a)
          if (typeof adapter.listModels === 'function') {
            catalog[a] = await adapter.listModels()
          } else {
            catalog[a] = { app: a, defaultModel: '', defaultEffort: '', supportsMidChatSwitch: false, models: [] }
          }
        } catch (err) {
          catalog[a] = {
            app: a,
            defaultModel: '',
            defaultEffort: '',
            supportsMidChatSwitch: false,
            models: [],
            error: String(err?.message || err),
          }
        }
      }),
    )
    return catalog
  }

  async createSession({ app = APPS.DSH, cwd, title, model, provider, reasoningEffort, sandbox, approvalPolicy } = {}) {
    const created = await this.getAdapter(app).createSession({
      cwd,
      title,
      model,
      provider,
      reasoningEffort,
      sandbox,
      approvalPolicy,
    })
    this.onEvent(EVENTS.SESSION_UPDATED, { session: created })
    return created
  }

  /**
   * Download any relay-hosted attachments to local PC disk before handing them to local agents.
   */
  async materializeAttachments(attachments = []) {
    if (!Array.isArray(attachments) || attachments.length === 0) return []
    mkdirSync(this.inboundDir, { recursive: true })
    const out = []

    for (const att of attachments) {
      if (att.localPath) {
        out.push(att)
        continue
      }
      if (att.url && this.relayHttpBase) {
        try {
          const fullUrl = att.url.startsWith('http') ? att.url : `${this.relayHttpBase}${att.url}`
          const headers = { 'X-Bridge-Secret': this.bridgeSecret }
          if (this.roomId) headers['X-Room-Id'] = this.roomId
          const res = await fetch(fullUrl, { headers })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const arrBuf = await res.arrayBuffer()
          const safe = String(att.filename || 'upload.bin').replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, '_')
          const localPath = join(this.inboundDir, `${Date.now()}-${safe}`)
          writeFileSync(localPath, Buffer.from(arrBuf))
          out.push({ ...att, localPath })
        } catch (err) {
          this.log.warn?.(`mobile-hub: failed downloading attachment ${att.filename}: ${String(err)}`)
        }
      }
    }
    return out
  }

  async sendMessage({ id, app, sessionId, text, cwd, title, attachments = [], approvalPolicy, permissionMode, model, provider, reasoningEffort } = {}) {
    const parsed = id ? parseCompositeId(id) : { app: app || APPS.DSH, sessionId }
    if (!parsed.sessionId) throw new Error('缺少 sessionId')
    const materialized = await this.materializeAttachments(attachments)
    const adapter = this.getAdapter(parsed.app)
    const result = await adapter.sendMessage(parsed.sessionId, {
      text,
      cwd,
      title,
      attachments: materialized,
      approvalPolicy,
      permissionMode,
      model,
      provider,
      reasoningEffort,
    })
    return result
  }

  async interruptSession({ id, app, sessionId } = {}) {
    const parsed = id ? parseCompositeId(id) : { app: app || APPS.DSH, sessionId }
    if (!parsed.sessionId) throw new Error('缺少 sessionId')
    return this.getAdapter(parsed.app).interrupt(parsed.sessionId)
  }

  listApprovals() {
    return [...this.pendingApprovals.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  async resolveApproval({ id, decision } = {}) {
    const req = this.pendingApprovals.get(id)
    if (!req) throw new Error(`审批请求不存在或已处理：${id}`)
    this.pendingApprovals.delete(id)
    const adapter = this.getAdapter(req.app)
    if (typeof adapter.resolveApproval === 'function') {
      return adapter.resolveApproval(id, decision)
    }
    return { resolved: true, id, decision }
  }

  /**
   * Dispatch a task to any app (used by BOTH DSH Master Dispatch Tools AND Mobile Dispatch Board).
   * Supports synchronous wait (`wait: true`) or background fire-and-monitor (`wait: false`).
   */
  async dispatchTask({
    app,
    sessionId = '',
    cwd = '',
    title = '',
    prompt,
    wait = false,
    issuedBy = 'mobile',
  }) {
    if (!app || !this.adapters[app]) {
      throw new Error(`无效的目标应用：${app}（可选：dsh, codex, claude, antigravity）`)
    }
    if (!String(prompt || '').trim()) {
      throw new Error('派单任务内容 prompt 不能为空')
    }

    let targetNativeId = sessionId
    if (targetNativeId && targetNativeId.includes(':')) {
      targetNativeId = parseCompositeId(targetNativeId).sessionId
    }

    if (!targetNativeId) {
      const created = await this.createSession({
        app,
        cwd: cwd || this.config.cwd,
        title: title || `总控派单 · ${String(prompt).trim().slice(0, 24)}`,
      })
      targetNativeId = created.nativeId
    }

    const taskId = `task-${randomUUID().slice(0, 10)}`
    const compositeId = makeCompositeId(app, targetNativeId)
    const task = {
      taskId,
      app,
      sessionId: compositeId,
      nativeId: targetNativeId,
      cwd: cwd || this.config.cwd || '',
      prompt: String(prompt),
      issuedBy,
      status: 'running',
      result: '',
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
    }
    this.dispatches.set(taskId, task)
    this.onEvent(EVENTS.DISPATCH_UPDATED, { task })

    const runPromise = this.sendMessage({
      app,
      sessionId: targetNativeId,
      text: prompt,
      cwd,
    })
      .then((res) => {
        task.status = res.aborted ? 'aborted' : 'completed'
        task.result = res.finalText || ''
        if (res.sessionId) task.sessionId = res.sessionId
        if (res.nativeId) task.nativeId = res.nativeId
        task.completedAt = Date.now()
        task.updatedAt = Date.now()
        this.onEvent(EVENTS.DISPATCH_UPDATED, { task })
        return task
      })
      .catch((err) => {
        task.status = 'error'
        task.error = String(err?.message || err)
        task.completedAt = Date.now()
        task.updatedAt = Date.now()
        this.onEvent(EVENTS.DISPATCH_UPDATED, { task })
        return task
      })

    if (wait) {
      return runPromise
    }

    // Prevent unhandled rejection in background mode
    runPromise.catch(() => {})
    return task
  }

  listDispatches({ limit = 40 } = {}) {
    return [...this.dispatches.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
  }

  getDispatchStatus(taskId) {
    const task = this.dispatches.get(taskId)
    if (!task) throw new Error(`找不到派单任务：${taskId}`)
    return task
  }

  /**
   * Read a local image file on the PC so the mobile client can display screenshots / generated images.
   * Strictly limited to image extensions and <= 20MB for security and stability.
   */
  async readLocalFile({ path: rawPath, cwd = '' } = {}) {
    const IMAGE_MIMES = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.avif': 'image/avif',
      '.ico': 'image/x-icon',
    }
    const MAX_IMAGE_BYTES = 20 * 1024 * 1024

    let p = String(rawPath || '').trim()
    if (!p) throw new Error('缺少图片路径')
    // Strip wrapping quotes or angle brackets
    if ((p.startsWith('<') && p.endsWith('>')) || (p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1).trim()
    }
    // Strip query/hash fragments if any
    p = p.replace(/[?#].*$/, '')

    // Convert file:/// URI to native filesystem path
    if (/^file:\/\//i.test(p)) {
      p = p.replace(/^file:\/\/(?:localhost)?/i, '')
      try { p = decodeURIComponent(p) } catch {}
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
        p = p.slice(1)
      }
    } else if (/%[0-9A-Fa-f]{2}/.test(p)) {
      // Only decode percent-encoded paths if the raw path does not exist directly
      if (!existsSync(p)) {
        try { p = decodeURIComponent(p) } catch {}
      }
    }

    // Expand leading ~/
    if (p.startsWith('~/') || p.startsWith('~\\')) {
      p = join(homedir(), p.slice(2))
    }

    // Normalize slashes and resolve relative paths against session cwd
    let resolved = p
    if (process.platform === 'win32') {
      resolved = resolved.replace(/\//g, '\\')
    }
    if (!isAbsolute(resolved)) {
      const baseDir = String(cwd || '').trim() || this.config.cwd || process.cwd()
      resolved = resolve(baseDir, resolved)
    } else {
      resolved = resolve(resolved)
    }

    const ext = extname(resolved).toLowerCase()
    const mimeType = IMAGE_MIMES[ext]
    if (!mimeType) {
      throw new Error(`出于安全限制，仅允许远程预览图片文件（不支持 ${ext || '未知格式'}）`)
    }
    if (!existsSync(resolved)) {
      throw new Error(`找不到本机图片文件：${resolved}`)
    }
    const st = statSync(resolved)
    if (!st.isFile()) {
      throw new Error('目标路径不是文件')
    }
    if (st.size <= 0 || st.size > MAX_IMAGE_BYTES) {
      throw new Error(`图片文件大小超出限制（${Math.round(st.size / 1024 / 1024)}MB / 最大 20MB）`)
    }

    const buf = readFileSync(resolved)
    return {
      ok: true,
      filename: basename(resolved),
      mimeType,
      size: buf.length,
      mtimeMs: st.mtimeMs,
      path: resolved,
      dataBase64: buf.toString('base64'),
    }
  }

  /** Unified RPC handler for incoming requests from Relay Server. */
  async handleRpc(method, params = {}) {
    switch (method) {
      case RPC.BRIDGE_PING:
        return { ok: true, ts: Date.now() }
      case RPC.FILE_READ:
        return await this.readLocalFile(params)
      case RPC.APPS_STATUS:
        return { apps: await this.getAppsStatus() }
      case RPC.MODELS_LIST:
        return { catalog: await this.listModels(params) }
      case RPC.WORKSPACES_LIST:
        return { workspaces: await this.listWorkspaces() }
      case RPC.SESSIONS_LIST:
        return { sessions: await this.listSessions(params) }
      case RPC.SESSION_READ:
        return { session: await this.readSession(params) }
      case RPC.SESSION_CREATE:
        return { session: await this.createSession(params) }
      case RPC.SESSION_SEND: {
        const targetId = params.id || makeCompositeId(params.app || APPS.DSH, params.sessionId)
        const parsed = parseCompositeId(targetId)
        if (params.wait === true) {
          return await this.sendMessage(params)
        }
        void this.sendMessage(params).catch((err) => {
          const msg = String(err?.message || err)
          this.log.warn?.(`mobile-hub: async sendMessage(${targetId}) error: ${msg}`)
          // Guarantee mobile UI always exits the loading spinner even if an adapter threw early
          this.onEvent(EVENTS.STREAM_ERROR, {
            sessionId: targetId,
            app: parsed.app,
            message: msg,
          })
        })
        return { accepted: true, sessionId: targetId }
      }
      case RPC.SESSION_INTERRUPT:
        return await this.interruptSession(params)
      case RPC.APPROVAL_LIST:
        return { approvals: this.listApprovals() }
      case RPC.APPROVAL_RESOLVE:
        return await this.resolveApproval(params)
      case RPC.DISPATCH_LIST:
        return { tasks: this.listDispatches(params) }
      case RPC.DISPATCH_CREATE:
        return { task: await this.dispatchTask(params) }
      case RPC.DISPATCH_STATUS:
        return { task: this.getDispatchStatus(params.taskId) }
      default:
        throw new Error(`未知 RPC 方法：${method}`)
    }
  }

  async dispose() {
    for (const adapter of Object.values(this.adapters)) {
      try {
        await adapter.dispose?.()
      } catch {}
    }
  }
}
