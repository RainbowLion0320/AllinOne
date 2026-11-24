import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { APPS, APP_LIST, EVENTS, RPC, makeCompositeId, parseCompositeId } from './protocol.js'
import { ensureRichPath } from './helpers/bin-finder.js'
import { decryptBytes, normalizeE2eeKey } from './helpers/e2ee.js'
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
    this.e2eeKey = normalizeE2eeKey(config.e2eeKey || '')
    this.inboundDir = config.inboundDir || join(
      String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh'),
      'allinone-uploads',
    )

    /** @type {Map<string, any>} */
    this.pendingApprovals = new Map()
    /** @type {Map<string, any>} */
    this.dispatches = new Map()
    this._lastInboundPruneAt = 0
    this._activeDocReads = 0

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

  deriveHttpBase(wsUrl) {
    if (!wsUrl) return ''
    try {
      const u = new URL(wsUrl)
      u.protocol = (u.protocol === 'wss:' || u.protocol === 'https:') ? 'https:' : 'http:'
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
   * Security:
   *  - NEVER trusts caller-supplied `att.localPath` (prevents arbitrary local file injection).
   *  - Strictly validates `att.url` matches `/api/uploads/<uuid>` and ALWAYS fetches from `this.relayHttpBase`
   *    with `redirect: 'error'` so `X-Bridge-Secret` can NEVER be leaked to third-party hosts (SSRF defense).
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

  async materializeAttachments(attachments = []) {
    if (!Array.isArray(attachments) || attachments.length === 0) return []
    const RELAY_UPLOAD_PATH_RE = /^\/api\/uploads\/[a-f0-9-]{8,64}$/i
    const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024
    mkdirSync(this.inboundDir, { recursive: true })
    try { chmodSync(this.inboundDir, 0o700) } catch {}
    this.pruneInboundDir()
    const out = []

    for (const att of attachments.slice(0, 12)) {
      if (!att || typeof att !== 'object') continue
      const rawUrl = String(att.url || '').trim()
      if (!rawUrl || !this.relayHttpBase) continue
      if (!RELAY_UPLOAD_PATH_RE.test(rawUrl)) {
        this.log.warn?.(`mobile-hub: rejected untrusted attachment URL: ${rawUrl.slice(0, 120)}`)
        continue
      }
      if (!this.e2eeKey || !att.e2ee?.iv) {
        this.log.warn?.(`mobile-hub: rejected unencrypted attachment: ${String(att.filename || '').slice(0, 64)}`)
        continue
      }
      try {
        const isImage = String(att.mimeType || '').toLowerCase().startsWith('image/')
        // Ephemeral cleanup: consume non-image uploads on relay immediately after PC downloads them
        const fullUrl = `${this.relayHttpBase}${rawUrl}${isImage ? '' : '?consume=1'}`
        const headers = { 'X-Bridge-Secret': this.bridgeSecret }
        if (this.roomId) headers['X-Room-Id'] = this.roomId
        const res = await fetch(fullUrl, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const declaredLen = Number(res.headers.get('content-length') || 0)
        if (declaredLen > MAX_DOWNLOAD_BYTES) {
          throw new Error('Attachment exceeds 15MB limit')
        }
        const arrBuf = await res.arrayBuffer()
        if (arrBuf.byteLength === 0 || arrBuf.byteLength > MAX_DOWNLOAD_BYTES + 64) {
          throw new Error('Attachment size invalid or exceeds 15MB limit')
        }
        const plainBytes = await decryptBytes(this.e2eeKey, new Uint8Array(arrBuf), {
          iv: att.e2ee.iv,
          kid: att.e2ee.kid || '',
          kind: 'upload',
          roomId: this.roomId,
        })
        const rawBase = basename(String(att.filename || 'upload.bin'))
        const safe = rawBase
          .replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_')
          .replace(/^\.+/, '')
          .slice(0, 100) || 'upload.bin'
        const localPath = join(this.inboundDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`)
        writeFileSync(localPath, Buffer.from(plainBytes.buffer, plainBytes.byteOffset, plainBytes.byteLength), { mode: 0o600 })
        out.push({
          id: att.id,
          filename: safe,
          mimeType: att.mimeType || 'application/octet-stream',
          size: plainBytes.byteLength,
          url: rawUrl,
          localPath,
        })
      } catch (err) {
        this.log.warn?.(`mobile-hub: failed downloading attachment ${att.filename}: ${String(err)}`)
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
        this.pendingApprovals.set(id, req)
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
   * Read a local image or deliverable document file on the PC so the remote client
   * can preview images/HTML or download office deliverables over E2EE WS RPC.
   * - Image mode (default): image extensions only, <= 20MB.
   * - Document mode (`mode: 'document'`): deliverable extensions only (HTML/PDF/Word/Excel/PPT/CSV/MD/TXT/RTF/EPUB/ZIP),
   *   <= 10MB, max 2 concurrent reads, sensitive-path blocklist, allowed-root scope guard, and symlink re-validation.
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
    const MAX_BYTES = isDocumentMode ? 10 * 1024 * 1024 : 20 * 1024 * 1024
    const MAX_CONCURRENT_DOC_READS = 2

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

    if (isDocumentMode) {
      const normReal = realPath.replace(/\\/g, '/').toLowerCase()
      const segments = normReal.split('/').filter(Boolean)
      const fileName = basename(realPath).toLowerCase()
      const BLOCKED_SEGMENTS = new Set([
        '.ssh',
        '.aws',
        '.gnupg',
        '.kube',
        '.docker',
        '.npm',
        '.allinone',
        '.dsh-mobile',
        '.dsh',
        '.git',
        'keychains',
      ])
      const isBlockedDir =
        segments.some((seg) => BLOCKED_SEGMENTS.has(seg)) ||
        normReal.includes('/.gemini/config/') ||
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
        normReal.startsWith('c:/windows/')
      const isBlockedName =
        /^\.env(?:\.|$)/i.test(fileName) ||
        /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts|shadow|passwd|accounts\.json)(?:\.|$)/i.test(fileName) ||
        /^(?:secrets?|credentials?|passwords?|tokens?)\.(?:txt|csv|md|zip)$/i.test(fileName) ||
        /\.(?:pem|key|p12|pfx|kdbx)$/i.test(fileName)
      if (isBlockedDir || isBlockedName) {
        throw new Error('出于安全限制，禁止远程下载系统敏感目录或凭据文件')
      }

      const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin'
      const cmpPath = (targetPath) => (caseInsensitiveFs ? targetPath.toLowerCase() : targetPath)
      const normTarget = cmpPath(realPath)
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
          const prefix = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`
          if (normTarget === normRoot || normTarget.startsWith(prefix)) {
            return true
          }
        }
        return false
      }

      const home = homedir()
      const fastRoots = [
        cwd,
        this.config.cwd,
        join(home, 'Desktop'),
        join(home, 'Downloads'),
        join(home, 'Documents'),
        join(home, '.gemini', 'antigravity', 'brain'),
        tmpdir(),
        process.platform !== 'win32' ? '/tmp' : '',
      ]
      let inAllowedRoot = checkRoots(fastRoots)
      if (!inAllowedRoot) {
        try {
          const workspaces = await this.listWorkspaces()
          inAllowedRoot = checkRoots(workspaces.map((w) => w?.path))
        } catch {}
      }
      if (!inAllowedRoot) {
        throw new Error('出于安全限制，仅允许远程下载当前工作目录、已识别项目目录或桌面/文档/下载目录中的交付文件')
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
      const limitMb = Math.round(MAX_BYTES / 1024 / 1024)
      throw new Error(
        isDocumentMode
          ? `文件大小超出限制（${actualMb}MB / 最大 ${limitMb}MB），请在电脑端直接查看`
          : `图片文件大小超出限制（${Math.round(st.size / 1024 / 1024)}MB / 最大 ${limitMb}MB）`,
      )
    }

    let buf
    if (isDocumentMode) {
      if (this._activeDocReads >= MAX_CONCURRENT_DOC_READS) {
        throw new Error('当前有其他文档正在传输，请稍后再试')
      }
      this._activeDocReads += 1
      try {
        buf = await readFileAsync(realPath)
      } finally {
        this._activeDocReads = Math.max(0, this._activeDocReads - 1)
      }
    } else {
      buf = readFileSync(realPath)
    }

    return {
      ok: true,
      kind: isDocumentMode ? 'document' : 'image',
      filename: basename(realPath),
      mimeType: realMimeType,
      size: buf.length,
      mtimeMs: st.mtimeMs,
      path: realPath,
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
          // Never duplicate adapter-emitted STREAM_ERROR or kill an active stream UI spinner on SESSION_BUSY
          if (err?._streamErrorEmitted || err?.code === 'SESSION_BUSY' || /正在运行中/.test(msg)) {
            return
          }
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
