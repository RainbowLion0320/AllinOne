import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  APPS,
  APP_LIST,
  EVENTS,
  RPC,
  assertSafeWorkspaceCwd,
  getWindowsSystemRootNorm,
  makeCompositeId,
  parseCompositeId,
} from './protocol.js'
import { ensureRichPath } from './helpers/bin-finder.js'
import { DshAdapter } from './adapters/dsh.js'
import { CodexAdapter } from './adapters/codex.js'
import { ClaudeAdapter } from './adapters/claude.js'
import { AntigravityAdapter } from './adapters/antigravity.js'

const P2P_UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_P2P_UPLOADS = 128
const MAX_P2P_DOCUMENT_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB local safety cap
const MAX_P2P_IMAGE_BYTES = 100 * 1024 * 1024 // 100 MB image cap

function computeRpcEtag(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

/**
 * Central multi-app orchestrator powering BOTH:
 *   1) Direct WebRTC P2P RPC requests from Mobile / Web / Desktop clients
 *   2) DeepSeek Harness Master Dispatch Tools (`allinone_*`)
 */
export class MultiAppOrchestrator {
  constructor({ ctx = null, config = {}, log = console, onEvent } = {}) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.onEvent = onEvent || (() => {})
    this.inboundDir = config.inboundDir || join(
      String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh'),
      'allinone-uploads',
    )

    /** @type {Map<string, any>} */
    this.pendingApprovals = new Map()
    /** @type {Map<string, any>} */
    this.dispatches = new Map()
    /** @type {Map<string, { clientId: string, localPath: string, filename: string, mimeType: string, size: number, createdAt: number }>} */
    this.p2pUploads = new Map()
    this._lastInboundPruneAt = 0

    const emitEvent = (event, payload) => {
      if (event === EVENTS.APPROVAL_RESOLVED && payload?.id) {
        this.pendingApprovals.delete(payload.id)
      }
      try {
        this.onEvent(event, payload)
      } catch {}
    }

    const onApprovalRequest = (req) => {
      if (!req?.id) return
      this.pendingApprovals.set(req.id, req)
      emitEvent(EVENTS.APPROVAL_REQUEST, req)
    }

    this.adapters = {
      [APPS.DSH]: new DshAdapter({ ctx, config, log, emitEvent, onApprovalRequest }),
      [APPS.CODEX]: new CodexAdapter({ config, log, emitEvent, onApprovalRequest }),
      [APPS.CLAUDE]: new ClaudeAdapter({ config, log, emitEvent, onApprovalRequest }),
      [APPS.ANTIGRAVITY]: new AntigravityAdapter({ config, log, emitEvent, onApprovalRequest }),
    }
  }

  _isPathInsideInboundDir(filePath, { requireExists = true } = {}) {
    const raw = String(filePath || '').trim()
    if (!raw) return false
    const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
    const cmp = (p) => (caseInsensitive ? p.toLowerCase() : p)
    const baseDir = resolve(this.inboundDir)
    const cleanPath = resolve(raw)
    const basePrefix = cmp(baseDir).endsWith(sep) ? cmp(baseDir) : `${cmp(baseDir)}${sep}`
    if (!cmp(cleanPath).startsWith(basePrefix)) return false
    if (existsSync(cleanPath)) {
      try {
        const realBase = realpathSync(baseDir)
        const realPath = realpathSync(cleanPath)
        const realPrefix = cmp(realBase).endsWith(sep) ? cmp(realBase) : `${cmp(realBase)}${sep}`
        return cmp(realPath).startsWith(realPrefix)
      } catch {
        return false
      }
    }
    return !requireExists
  }

  /**
   * Register a verified P2P uploaded file inside `inboundDir` and return an opaque token.
   * Ensures callers can NEVER inject arbitrary local file paths in `RPC.SESSION_SEND`.
   */
  registerP2pUpload({ clientId = '', localPath, filename, mimeType = 'application/octet-stream', size = 0 } = {}) {
    const now = Date.now()
    for (const [tok, rec] of this.p2pUploads.entries()) {
      if (now - rec.createdAt > P2P_UPLOAD_TOKEN_TTL_MS) this.p2pUploads.delete(tok)
    }
    while (this.p2pUploads.size >= MAX_P2P_UPLOADS) {
      const oldest = this.p2pUploads.keys().next().value
      if (!oldest) break
      this.p2pUploads.delete(oldest)
    }
    const cleanPath = resolve(String(localPath || ''))
    if (!this._isPathInsideInboundDir(cleanPath, { requireExists: false })) {
      throw new Error('Rejected P2P upload path outside inbound directory')
    }
    const token = `p2p_${randomUUID().replace(/-/g, '')}`
    this.p2pUploads.set(token, {
      clientId: String(clientId || '').trim(),
      localPath: cleanPath,
      filename: String(filename || basename(cleanPath)),
      mimeType: String(mimeType || 'application/octet-stream'),
      size: Number(size || 0),
      createdAt: now,
    })
    return token
  }

  getAdapter(app) {
    const adapter = this.adapters[app]
    if (!adapter) throw new Error(`不支持的应用类型：${app}（可选：${APP_LIST.join(', ')}）`)
    return adapter
  }

  refreshEnvironment() {
    ensureRichPath(true)
    for (const app of APP_LIST) {
      try {
        this.adapters[app]?.refreshBinary?.()
      } catch {}
    }
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
    const [dshWs, claudeWs] = await Promise.all([
      this.adapters[APPS.DSH].listWorkspaces().catch(() => []),
      typeof this.adapters[APPS.CLAUDE]?.listWorkspaces === 'function'
        ? this.adapters[APPS.CLAUDE].listWorkspaces().catch(() => [])
        : Promise.resolve([]),
    ])
    // Deduplicate by normalized path
    const map = new Map()
    for (const w of [...dshWs, ...claudeWs]) {
      if (w?.path) {
        const k = w.path.toLowerCase()
        if (!map.has(k)) map.set(k, w)
      }
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
    const safeCwd = assertSafeWorkspaceCwd(cwd, { allowEmpty: true }) || undefined
    const created = await this.getAdapter(app).createSession({
      cwd: safeCwd,
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
   * Prune expired inbound P2P attachment files from local PC disk.
   */
  pruneInboundDir(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now()
    if (now - this._lastInboundPruneAt < 10 * 60_000) return
    this._lastInboundPruneAt = now
    try {
      if (!existsSync(this.inboundDir)) return
      for (const name of readdirSync(this.inboundDir)) {
        const fp = join(this.inboundDir, name)
        try {
          const st = statSync(fp)
          if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
            unlinkSync(fp)
          }
        } catch {}
      }
    } catch {}
  }

  /**
   * Resolve P2P-uploaded attachments strictly from our verified `p2pUploads` registry.
   * Security: NEVER trusts caller-supplied `localPath` or arbitrary URLs, and enforces
   * single-use + uploading-client ownership (`clientId`) when present.
   */
  async materializeAttachments(attachments = [], { clientId = '', strict = false, _burnedOut = null } = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) return []
    this.pruneInboundDir()
    const now = Date.now()
    const callerClientId = String(clientId || '').trim()
    const out = []
    let rejectedTokens = 0

    for (const att of attachments.slice(0, 12)) {
      if (!att || typeof att !== 'object') continue
      const token = String(att.p2pToken || '').trim()
      if (!token || !token.startsWith('p2p_')) {
        this.log.warn?.('mobile-hub: rejected untrusted attachment without valid p2pToken')
        continue
      }
      const rec = this.p2pUploads.get(token)
      if (!rec || now - rec.createdAt > P2P_UPLOAD_TOKEN_TTL_MS || !existsSync(rec.localPath)) {
        this.p2pUploads.delete(token)
        this.log.warn?.('mobile-hub: rejected expired or unknown p2pToken')
        rejectedTokens += 1
        continue
      }
      if (rec.clientId && rec.clientId !== callerClientId) {
        this.log.warn?.('mobile-hub: rejected cross-client p2pToken attempt')
        rejectedTokens += 1
        continue
      }
      // Single-use token burn on materialization (can be restored by sendMessage on pre-turn rejection)
      this.p2pUploads.delete(token)
      if (Array.isArray(_burnedOut)) {
        _burnedOut.push({ token, rec })
      }
      out.push({
        id: att.id || token,
        filename: rec.filename,
        mimeType: rec.mimeType,
        size: rec.size,
        localPath: rec.localPath,
      })
    }
    if (strict && rejectedTokens > 0) {
      // Restore any tokens already consumed in this batch before throwing
      if (Array.isArray(_burnedOut)) {
        for (const item of _burnedOut) {
          if (item?.token && item?.rec?.localPath && this._isPathInsideInboundDir(item.rec.localPath)) {
            this.p2pUploads.set(item.token, item.rec)
          }
        }
        _burnedOut.length = 0
      }
      const err = new Error('部分附件上传凭证已过期或失效，请重新上传附件后再发送')
      err.code = 'ATTACHMENT_EXPIRED'
      throw err
    }
    return out
  }

  _isAdapterSessionBusy(adapter, sessionId) {
    if (!adapter || !sessionId) return false
    if (adapter.activeTurns instanceof Map && adapter.activeTurns.has(sessionId)) return true
    if (adapter.activeProcs instanceof Map && adapter.activeProcs.has(sessionId)) return true
    return false
  }

  async sendMessage(
    {
      id,
      app,
      sessionId,
      text,
      cwd,
      title,
      attachments = [],
      approvalPolicy,
      permissionMode,
      taskMode,
      model,
      provider,
      reasoningEffort,
    } = {},
    { clientId = '', preMaterialized = null, burnedTokens = null } = {},
  ) {
    const parsed = id ? parseCompositeId(id) : { app: app || APPS.DSH, sessionId }
    if (!parsed.sessionId) throw new Error('缺少 sessionId')
    const safeCwd = assertSafeWorkspaceCwd(cwd, { allowEmpty: true }) || undefined
    const adapter = this.getAdapter(parsed.app)
    const burned = Array.isArray(burnedTokens) ? burnedTokens : []
    const materialized = Array.isArray(preMaterialized)
      ? preMaterialized
      : await this.materializeAttachments(attachments, { clientId, strict: true, _burnedOut: burned })
    try {
      const result = await adapter.sendMessage(parsed.sessionId, {
        text,
        cwd: safeCwd,
        title,
        attachments: materialized,
        approvalPolicy,
        permissionMode,
        taskMode,
        model,
        provider,
        reasoningEffort,
      })
      return result
    } catch (err) {
      // Restore single-use p2pTokens if the turn was rejected before execution (e.g. SESSION_BUSY)
      if (burned.length > 0 && (err?.code === 'SESSION_BUSY' || !err?._streamErrorEmitted)) {
        for (const item of burned) {
          if (item?.token && item?.rec?.localPath && this._isPathInsideInboundDir(item.rec.localPath)) {
            this.p2pUploads.set(item.token, item.rec)
          }
        }
      }
      throw err
    }
  }

  async interruptSession({ id, app, sessionId } = {}) {
    const parsed = id ? parseCompositeId(id) : { app: app || APPS.DSH, sessionId }
    if (!parsed.sessionId) throw new Error('缺少 sessionId')
    return this.getAdapter(parsed.app).interrupt(parsed.sessionId)
  }

  async listApprovals() {
    // Reconcile pending approvals currently held inside a live DSH IPC process (e.g. after reconnect or desktop resolution)
    const dshAdapter = this.adapters[APPS.DSH]
    if (typeof dshAdapter?.listPendingApprovals === 'function') {
      try {
        const remote = await dshAdapter.listPendingApprovals()
        if (Array.isArray(remote)) {
          const authoritativeIds = new Set()
          for (const req of remote) {
            if (req?.id) {
              authoritativeIds.add(req.id)
              if (!this.pendingApprovals.has(req.id)) {
                this.pendingApprovals.set(req.id, req)
              }
            }
          }
          for (const [id, req] of this.pendingApprovals.entries()) {
            if (req?.app === APPS.DSH && !authoritativeIds.has(id)) {
              this.pendingApprovals.delete(id)
            }
          }
        }
      } catch {}
    }
    return [...this.pendingApprovals.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  async resolveApproval({ id, decision, answers } = {}) {
    const req = this.pendingApprovals.get(id)
    if (!req) throw new Error(`审批请求不存在或已处理：${id}`)
    this.pendingApprovals.delete(id)
    const adapter = this.getAdapter(req.app)
    if (typeof adapter.resolveApproval === 'function') {
      const payload = answers && typeof answers === 'object' ? { decision, answers } : decision
      try {
        return await adapter.resolveApproval(id, payload)
      } catch (err) {
        // Do not resurrect zombie approval cards when the underlying CLI transport has already died
        if (err?.code !== 'APPROVAL_TRANSPORT_CLOSED') {
          this.pendingApprovals.set(id, req)
        }
        throw err
      }
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
    const safeCwd = assertSafeWorkspaceCwd(cwd, { allowEmpty: true })

    let targetNativeId = sessionId
    if (targetNativeId && targetNativeId.includes(':')) {
      targetNativeId = parseCompositeId(targetNativeId).sessionId
    }

    if (!targetNativeId) {
      const created = await this.createSession({
        app,
        cwd: safeCwd || this.config.cwd,
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
      cwd: safeCwd || this.config.cwd || '',
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
    const MAX_DISPATCHES = 200
    if (this.dispatches.size > MAX_DISPATCHES) {
      for (const [k, v] of this.dispatches.entries()) {
        if (this.dispatches.size <= MAX_DISPATCHES) break
        if (v.status !== 'running') this.dispatches.delete(k)
      }
      while (this.dispatches.size > MAX_DISPATCHES) {
        const oldest = this.dispatches.keys().next().value
        if (!oldest) break
        this.dispatches.delete(oldest)
      }
    }
    this.onEvent(EVENTS.DISPATCH_UPDATED, { task })

    const runPromise = this.sendMessage({
      app,
      sessionId: targetNativeId,
      text: prompt,
      cwd: safeCwd,
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
   * Read a local image or deliverable document file on the PC so the remote client
   * can preview images/HTML or download office deliverables over direct E2EE P2P.
   * - Files <= 128 KB return inline Base64 over `aio-ctrl`; larger files return a `p2p-bulk` descriptor
   *   streamed over `aio-bulk` (AIO2 4 MB chunked E2EE + 60 KB SCTP slices).
   * - Image mode (default): image extensions only, <= 100 MB.
   * - Document mode (`mode: 'document'`): deliverable extensions only (HTML/PDF/Word/Excel/PPT/CSV/MD/TXT/RTF/EPUB/ZIP),
   *   <= 2 GB, max 4 concurrent inline reads, sensitive-path blocklist, allowed-root scope guard, and symlink re-validation.
   */
  async readLocalFile({ path: rawPath, cwd = '', mode = 'image' } = {}) {
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
    const DOCUMENT_MIMES = {
      '.html': 'text/html; charset=utf-8',
      '.htm': 'text/html; charset=utf-8',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.csv': 'text/csv; charset=utf-8',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.md': 'text/markdown; charset=utf-8',
      '.markdown': 'text/markdown; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.rtf': 'application/rtf',
      '.epub': 'application/epub+zip',
      '.zip': 'application/zip',
    }
    const isDocumentMode = String(mode || '').trim().toLowerCase() === 'document'
    const ALLOWED_MIMES = isDocumentMode ? DOCUMENT_MIMES : IMAGE_MIMES
    const MAX_BYTES = isDocumentMode ? MAX_P2P_DOCUMENT_BYTES : MAX_P2P_IMAGE_BYTES

    let p = String(rawPath || '').trim()
    if (!p) throw new Error(isDocumentMode ? '缺少文件路径' : '缺少图片路径')
    // Strip wrapping quotes or angle brackets
    if ((p.startsWith('<') && p.endsWith('>')) || (p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1).trim()
    }

    // Convert file:/// URI to native filesystem path (strip query/hash only for file:// URIs or nonexistent paths)
    if (/^file:\/\//i.test(p)) {
      p = p.replace(/[?#].*$/, '')
      p = p.replace(/^file:\/\/(?:localhost)?/i, '')
      try { p = decodeURIComponent(p) } catch {}
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
        p = p.slice(1)
      }
    } else {
      if (p.startsWith('~/') || p.startsWith('~\\')) {
        p = join(homedir(), p.slice(2))
      }
      if (/[?#]/.test(p) && !existsSync(p)) {
        const baseDir = String(cwd || '').trim() || this.config.cwd || process.cwd()
        const checkPath = isAbsolute(p) ? p : resolve(baseDir, p)
        if (!existsSync(checkPath)) {
          p = p.replace(/[?#].*$/, '')
        }
      }
      if (/%[0-9A-Fa-f]{2}/.test(p)) {
        // Only decode percent-encoded paths if the raw path does not exist directly
        if (!existsSync(p)) {
          try { p = decodeURIComponent(p) } catch {}
        }
      }
    }

    // Expand leading ~/ (in case file:// or decoded path had it)
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
    const mimeType = ALLOWED_MIMES[ext]
    if (!mimeType) {
      throw new Error(
        isDocumentMode
          ? `出于安全限制，不支持远程下载该格式文件（${ext || '未知格式'}）`
          : `出于安全限制，仅允许远程预览图片文件（不支持 ${ext || '未知格式'}）`,
      )
    }
    if (!existsSync(resolved)) {
      throw new Error(isDocumentMode ? `找不到电脑端文件：${resolved}` : `找不到本机图片文件：${resolved}`)
    }
    // Resolve symlinks and re-validate the real target's extension so `fake.pdf -> ~/.ssh/id_rsa` is blocked
    const realPath = realpathSync(resolved)
    const realExt = extname(realPath).toLowerCase()
    const realMimeType = ALLOWED_MIMES[realExt]
    if (!realMimeType) {
      throw new Error(
        isDocumentMode
          ? `出于安全限制，符号链接指向不允许的格式，已拒绝下载（${realExt || '未知格式'}）`
          : `出于安全限制，符号链接指向非图片文件，已拒绝访问（${realExt || '未知格式'}）`,
      )
    }

    // Enforce sensitive directory & credential blocklist for BOTH document and image modes
    const normReal = realPath.replace(/\\/g, '/').toLowerCase()
    const inInboundDir = this._isPathInsideInboundDir(realPath)
    const segments = inInboundDir
      ? relative(realpathSync(resolve(this.inboundDir)), realPath).replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean)
      : normReal.split('/').filter(Boolean)
    const fileName = basename(realPath).toLowerCase()
    const winSysRoot = getWindowsSystemRootNorm()
    const BLOCKED_SEGMENTS = new Set([
      '.ssh',
      '.aws',
      '.gnupg',
      '.kube',
      '.docker',
      '.npm',
      '.allinone',
      '.allinone-bridge',
      '.dsh-mobile',
      '.git',
      'keychains',
    ])
    const isBlockedDir =
      segments.some((seg) => BLOCKED_SEGMENTS.has(seg)) ||
      (!inInboundDir && (
        normReal.includes('/.dsh/profiles/') ||
        normReal.includes('/.dsh/storages/') ||
        normReal.includes('/.dsh/config/')
      )) ||
      normReal.includes('/.gemini/config/') ||
      normReal.includes('/.codex/auth') ||
      normReal.includes('/.claude/.credentials') ||
      normReal.includes('/library/application support/google/chrome/') ||
      normReal.includes('/library/application support/microsoft edge/') ||
      normReal.includes('/library/application support/firefox/') ||
      normReal.includes('/appdata/local/google/chrome/') ||
      normReal.includes('/appdata/local/microsoft/edge/') ||
      normReal.includes('/appdata/roaming/mozilla/') ||
      normReal.startsWith('/etc/') ||
      normReal.startsWith('/private/etc/') ||
      normReal.startsWith('/proc/') ||
      normReal.startsWith('/sys/') ||
      normReal.startsWith('/system/') ||
      normReal === winSysRoot ||
      normReal.startsWith(`${winSysRoot}/`) ||
      normReal.startsWith('c:/windows/')
    const isBlockedName =
      /^\.env(?:\.|$)/i.test(fileName) ||
      /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts|shadow|passwd|accounts\.json|allinone-dsh-ipc\.json|e2ee-key\.html)(?:\.|$)/i.test(fileName) ||
      /^(?:secrets?|credentials?|passwords?|tokens?)\.(?:txt|csv|md|zip)$/i.test(fileName) ||
      /\.(?:pem|key|p12|pfx|kdbx)$/i.test(fileName)
    if (isBlockedDir || isBlockedName) {
      throw new Error('出于安全限制，禁止远程下载系统敏感目录或凭据文件')
    }

    // Enforce allowed-root scope guard for BOTH document and image modes
    {
      const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin'
      const cmpPath = (targetPath) => (caseInsensitiveFs ? targetPath.toLowerCase() : targetPath)
      const normTarget = cmpPath(realPath)
      const home = homedir()
      let homeRealNorm = ''
      try {
        homeRealNorm = cmpPath(realpathSync(home))
      } catch {
        homeRealNorm = cmpPath(home)
      }
      const isOverbroadRoot = (normRoot) => {
        if (!normRoot || normRoot === '/' || normRoot === '\\' || /^[a-z]:[\\/]?$/i.test(normRoot)) return true
        return Boolean(homeRealNorm && normRoot === homeRealNorm)
      }
      const checkRoots = (roots) => {
        for (const root of roots) {
          const clean = String(root || '').trim()
          if (!clean) continue
          let rootReal = ''
          try {
            if (!existsSync(clean)) continue
            rootReal = realpathSync(clean)
          } catch {
            continue
          }
          const normRoot = cmpPath(rootReal)
          if (isOverbroadRoot(normRoot)) continue
          const prefix = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`
          if (normTarget === normRoot || normTarget.startsWith(prefix)) {
            return true
          }
        }
        return false
      }

      // Security: NEVER trust caller-supplied `cwd` or global `/tmp` as an allowed root
      const fastRoots = [
        this.config.cwd,
        this.inboundDir,
        join(home, 'Desktop'),
        join(home, 'Downloads'),
        join(home, 'Documents'),
        ...(!isDocumentMode ? [join(home, 'Pictures')] : []),
        join(home, '.dsh'),
        join(home, '.codex'),
        join(home, '.claude'),
        join(home, '.gemini'),
      ]
      let inAllowedRoot = checkRoots(fastRoots)
      if (!inAllowedRoot) {
        try {
          const workspaces = await this.listWorkspaces()
          inAllowedRoot = checkRoots(workspaces.map((w) => w?.path))
        } catch {}
      }
      if (!inAllowedRoot) {
        throw new Error(
          isDocumentMode
            ? '出于安全限制，仅允许远程下载当前工作目录、已识别项目目录或桌面/文档/下载目录中的交付文件'
            : '出于安全限制，仅允许远程预览当前工作目录、已识别项目目录、AI 产物目录或桌面/文档/下载目录中的图片文件',
        )
      }
    }

    const st = statSync(realPath)
    if (!st.isFile()) {
      throw new Error('目标路径不是文件')
    }
    if (st.size <= 0) {
      throw new Error(isDocumentMode ? '文件内容为空，无法下载' : '图片文件为空')
    }
    if (st.size > MAX_BYTES) {
      const actualMb = (st.size / 1024 / 1024).toFixed(1)
      const limitLabel = isDocumentMode ? '2GB' : '100MB'
      throw new Error(
        isDocumentMode
          ? `文件大小超出本机安全限制（${actualMb}MB / 最大 ${limitLabel}）`
          : `图片文件大小超出限制（${actualMb}MB / 最大 ${limitLabel}）`,
      )
    }

    // All files & images stream directly peer-to-peer over binary `aio-bulk` (AIO2 chunked E2EE + conditional deflate-raw)
    return {
      ok: true,
      kind: isDocumentMode ? 'document' : 'image',
      transferMode: 'p2p-bulk',
      _localRealPath: realPath,
      filename: basename(realPath),
      mimeType: realMimeType,
      size: st.size,
      mtimeMs: st.mtimeMs,
      path: realPath,
    }
  }

  /** Unified RPC handler for incoming direct P2P requests. */
  async handleRpc(method, params = {}, ctx = {}) {
    switch (method) {
      case RPC.BRIDGE_PING:
        return { ok: true, ts: Date.now() }
      case RPC.FILE_READ:
        return await this.readLocalFile(params)
      case RPC.APPS_STATUS:
        return { apps: await this.getAppsStatus() }
      case RPC.MODELS_LIST: {
        const catalog = await this.listModels(params)
        const etag = computeRpcEtag(catalog)
        const reqEtag = String(params?.etag || '').trim()
        if (reqEtag && reqEtag === etag) {
          return { unchanged: true, etag }
        }
        return { catalog, etag }
      }
      case RPC.WORKSPACES_LIST:
        return { workspaces: await this.listWorkspaces() }
      case RPC.SESSIONS_LIST:
        return { sessions: await this.listSessions(params) }
      case RPC.SESSION_READ: {
        const session = await this.readSession(params)
        if (!params?.cursor && session && typeof session === 'object') {
          const etag = computeRpcEtag({
            id: session.id,
            title: session.title,
            cwd: session.cwd,
            workspace: session.workspace,
            status: session.status,
            model: session.model,
            provider: session.provider,
            reasoningEffort: session.reasoningEffort,
            writable: session.writable,
            taskState: session.taskState ?? null,
            syncState: session.syncState ?? null,
            hasMore: Boolean(session.hasMore),
            nextCursor: session.nextCursor ?? null,
            totalCount: session.totalCount ?? null,
            messages: session.messages || [],
          })
          const reqEtag = String(params?.etag || '').trim()
          if (reqEtag && reqEtag === etag) {
            return { unchanged: true, etag }
          }
          return { session: { ...session, etag }, etag }
        }
        return { session }
      }
      case RPC.SESSION_CREATE:
        return { session: await this.createSession(params) }
      case RPC.SESSION_SEND: {
        const targetId = params?.id || makeCompositeId(params?.app || APPS.DSH, params?.sessionId)
        const parsed = parseCompositeId(targetId)
        // Strictly allowlist public fields (NEVER spread untrusted params with internal options)
        const publicParams = {
          app: parsed.app,
          sessionId: parsed.sessionId,
          text: params?.text,
          cwd: params?.cwd,
          model: params?.model,
          provider: params?.provider,
          reasoningEffort: params?.reasoningEffort,
          taskMode: params?.taskMode,
          attachments: params?.attachments,
          wait: params?.wait,
          timeoutMs: params?.timeoutMs,
        }
        const callerClientId = String(ctx?.clientId || '').trim()
        if (publicParams.wait === true) {
          return await this.sendMessage(publicParams, { clientId: callerClientId })
        }
        // Validate remote cwd synchronously before returning { accepted: true }
        assertSafeWorkspaceCwd(publicParams.cwd, { allowEmpty: true })
        // Fail fast synchronously on busy sessions or expired attachment tokens BEFORE returning { accepted: true }
        const adapter = this.getAdapter(parsed.app)
        if (this._isAdapterSessionBusy(adapter, parsed.sessionId)) {
          const err = new Error('该对话正在运行中，请等待完成或先点击停止。')
          err.code = 'SESSION_BUSY'
          throw err
        }
        const burnedTokens = []
        const preMaterialized = await this.materializeAttachments(publicParams.attachments || [], {
          clientId: callerClientId,
          strict: true,
          _burnedOut: burnedTokens,
        })
        void this.sendMessage(publicParams, {
          clientId: callerClientId,
          preMaterialized,
          burnedTokens,
        }).catch((err) => {
          const msg = String(err?.message || err)
          this.log.warn?.(`mobile-hub: async sendMessage(${targetId}) error: ${msg}`)
          if (err?._streamErrorEmitted) {
            return
          }
          // Guarantee mobile UI always exits the loading spinner even if an adapter threw early (including external SESSION_BUSY)
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
        return { approvals: await this.listApprovals() }
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
