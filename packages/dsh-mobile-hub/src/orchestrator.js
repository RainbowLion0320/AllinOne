import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  APPS,
  APP_LIST,
  EVENTS,
  RPC,
  assertSafeSessionId,
  assertSafeWorkspaceCwd,
  getWindowsSystemRootNorm,
  makeCompositeId,
  parseCompositeId,
} from './protocol.js'
import { ensureRichPath } from './helpers/bin-finder.js'
import { InboundAttachmentStore } from './inbound-store.js'
import { BoundedLruMap } from './primitives/lru.js'
import { DshAdapter } from './adapters/dsh.js'
import { CodexAdapter } from './adapters/codex.js'
import { ClaudeAdapter } from './adapters/claude.js'
import { AntigravityAdapter } from './adapters/antigravity.js'
import { WorkBuddyAdapter } from './adapters/workbuddy.js'

const MAX_P2P_DOCUMENT_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB local safety cap
const MAX_P2P_IMAGE_BYTES = 100 * 1024 * 1024 // 100 MB image cap
const ADAPTER_SCAN_TIMEOUT_MS = 10_000
const ADAPTER_MODELS_TIMEOUT_MS = 25_000
const DISPOSE_BUDGET_MS = 1_800

const CODEX_SANDBOX_RANK = {
  'read-only': 1,
  'workspace-write': 2,
  'danger-full-access': 3,
}
const CODEX_APPROVAL_RANK = {
  'untrusted': 1,
  'on-request': 2,
  'on-failure': 3,
  'never': 4,
}

function clampCodexSandbox(requested, hostConfigured) {
  const host = String(hostConfigured || 'workspace-write').trim()
  const req = String(requested || '').trim()
  if (!req || !(req in CODEX_SANDBOX_RANK)) return undefined
  const hostRank = CODEX_SANDBOX_RANK[host] ?? CODEX_SANDBOX_RANK['workspace-write']
  return CODEX_SANDBOX_RANK[req] <= hostRank ? req : host
}

function clampCodexApprovalPolicy(requested, hostConfigured) {
  const host = String(hostConfigured || 'on-request').trim()
  const req = String(requested || '').trim()
  if (!req || !(req in CODEX_APPROVAL_RANK)) return undefined
  const hostRank = CODEX_APPROVAL_RANK[host] ?? CODEX_APPROVAL_RANK['on-request']
  return CODEX_APPROVAL_RANK[req] <= hostRank ? req : host
}

function withTimeout(promise, ms, fallbackFn) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(typeof fallbackFn === 'function' ? fallbackFn() : fallbackFn), ms)
      timer.unref?.()
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function computeRpcEtag(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

function getNormalizedHomeReal() {
  try {
    const h = existsSync(homedir()) ? realpathSync(homedir()) : homedir()
    return process.platform === 'win32' || process.platform === 'darwin' ? h.toLowerCase() : h
  } catch {
    const h = homedir()
    return process.platform === 'win32' || process.platform === 'darwin' ? h.toLowerCase() : h
  }
}

/**
 * Central multi-app orchestrator powering BOTH:
 *   1) Direct WebRTC P2P RPC requests from Mobile / Web / Desktop clients
 *   2) DeepSeek Harness Master Dispatch Tools (`allinone_*`)
 */
export class MultiAppOrchestrator {
  constructor({ ctx = null, config = {}, log = console, onEvent, onlyDsh = false } = {}) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.onEvent = onEvent || (() => {})
    this.onlyDsh = Boolean(onlyDsh)
    this.inboundDir = config.inboundDir || join(
      String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh'),
      'allinone-uploads',
    )
    this.inboundStore = new InboundAttachmentStore({
      inboundDir: this.inboundDir,
      maxDiskBytes: config.maxInboundDiskBytes,
      log,
    })

    /** @type {Map<string, any>} */
    this.pendingApprovals = new Map()
    /** @type {BoundedLruMap<string, any>} */
    this.dispatches = new BoundedLruMap(200)
    /** @type {BoundedLruMap<string, string>} Authoritative local project roots discovered from real native adapter sessions */
    this.knownSessionRoots = new BoundedLruMap(500)
    this._sessionRootsSyncedAt = 0
    this._inFlightAppsStatus = null
    this._inFlightModels = null

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

    if (this.onlyDsh) {
      this.adapters = {
        [APPS.DSH]: new DshAdapter({ ctx, config, log, emitEvent, onApprovalRequest }),
      }
    } else {
      this.adapters = {
        [APPS.DSH]: new DshAdapter({ ctx, config, log, emitEvent, onApprovalRequest }),
        [APPS.CODEX]: new CodexAdapter({ config, log, emitEvent, onApprovalRequest }),
        [APPS.CLAUDE]: new ClaudeAdapter({ config, log, emitEvent, onApprovalRequest }),
        [APPS.ANTIGRAVITY]: new AntigravityAdapter({ config, log, emitEvent, onApprovalRequest }),
        [APPS.WORKBUDDY]: new WorkBuddyAdapter({ config, log, emitEvent, onApprovalRequest }),
      }
    }
    this.enabledApps = Object.keys(this.adapters)
  }

  get p2pUploads() {
    return this.inboundStore.tokens
  }

  _isPathInsideInboundDir(filePath, opts) {
    return this.inboundStore.isPathInside(filePath, opts)
  }

  registerP2pUpload(meta) {
    return this.inboundStore.registerUpload(meta)
  }

  pruneInboundDir(maxAgeMs) {
    return this.inboundStore.pruneExpiredFiles(maxAgeMs)
  }

  async materializeAttachments(attachments = [], opts = {}) {
    return this.inboundStore.materializeAttachments(attachments, opts)
  }

  getAdapter(app) {
    const adapter = this.adapters[app]
    if (!adapter) throw new Error(`不支持的应用类型：${app}（可选：${this.enabledApps.join(', ')}）`)
    return adapter
  }

  refreshEnvironment() {
    ensureRichPath(true)
    for (const app of this.enabledApps) {
      try {
        this.adapters[app]?.refreshBinary?.()
      } catch {}
    }
  }

  async getAppsStatus({ forceQuota = false } = {}) {
    if (!forceQuota && this._inFlightAppsStatus) {
      return this._inFlightAppsStatus
    }
    const run = Promise.all(
      this.enabledApps.map(async (app) => {
        try {
          return await withTimeout(
            this.adapters[app].getStatus({ forceQuota }),
            ADAPTER_SCAN_TIMEOUT_MS,
            () => ({
              app,
              available: false,
              writable: false,
              mode: 'timeout',
              detail: '应用状态探测超时',
              activeCount: 0,
            }),
          )
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
    if (!forceQuota) {
      this._inFlightAppsStatus = run
      run.finally(() => {
        if (this._inFlightAppsStatus === run) this._inFlightAppsStatus = null
      })
    }
    return run
  }

  rememberSessionRoot(rawCwd) {
    const clean = String(rawCwd || '').trim()
    if (!clean) return
    try {
      const safe = assertSafeWorkspaceCwd(clean, { allowEmpty: true })
      if (!safe || !existsSync(safe)) return
      const real = realpathSync(safe)
      const key = process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real
      if (!key || key === '/' || key === '\\' || /^[a-z]:[\\/]?$/i.test(key)) return
      const homeNorm = getNormalizedHomeReal()
      if (homeNorm && key === homeNorm) return
      this.knownSessionRoots.set(key, real)
    } catch {}
  }

  async listWorkspaces() {
    const needSessionDiscovery =
      this.knownSessionRoots.size === 0 || Date.now() - this._sessionRootsSyncedAt > 60_000

    // Query workspace providers dynamically via adapter capabilities instead of hardcoding app names
    const workspacePromises = []
    for (const app of this.enabledApps) {
      const adapter = this.adapters[app]
      if (typeof adapter?.listWorkspaces === 'function' && (adapter.capabilities?.supportsWorkspaces !== false)) {
        workspacePromises.push(
          withTimeout(adapter.listWorkspaces().catch(() => []), ADAPTER_SCAN_TIMEOUT_MS, () => []),
        )
      }
    }
    if (needSessionDiscovery) {
      workspacePromises.push(
        withTimeout(this.listSessions({ app: 'all', limit: 160 }).catch(() => []), ADAPTER_SCAN_TIMEOUT_MS, () => [])
          .then(() => []),
      )
    }
    const workspaceBatches = await Promise.all(workspacePromises)
    const homeNorm = getNormalizedHomeReal()

    const map = new Map()
    for (const batch of workspaceBatches) {
      for (const w of batch || []) {
        if (w?.path) {
          const k = w.path.toLowerCase()
          if (homeNorm && k === homeNorm) continue
          if (!map.has(k)) map.set(k, w)
        }
      }
    }
    for (const rootPath of this.knownSessionRoots.values()) {
      const k = rootPath.toLowerCase()
      if (homeNorm && k === homeNorm) continue
      if (!map.has(k) && existsSync(rootPath)) {
        map.set(k, {
          name: basename(rootPath) || rootPath,
          path: rootPath,
          source: 'session',
        })
      }
    }
    if (this.config.cwd && existsSync(this.config.cwd)) {
      let cfgReal = this.config.cwd
      try { cfgReal = realpathSync(this.config.cwd) } catch {}
      const k = cfgReal.toLowerCase()
      if ((!homeNorm || k !== homeNorm) && !map.has(k)) {
        map.set(k, {
          name: basename(cfgReal) || cfgReal,
          path: cfgReal,
          source: 'default',
        })
      }
    }
    return [...map.values()]
  }

  async listSessions({ app = 'all', limit = 100, search = '' } = {}) {
    const isAll = !app || app === 'all'
    const targets = isAll ? this.enabledApps : [app]
    const perAppLimit = isAll ? Math.max(10, Math.ceil(limit / Math.max(1, targets.length))) : limit

    const settled = await Promise.allSettled(
      targets.map((a) =>
        withTimeout(this.getAdapter(a).listSessions({ limit: perAppLimit, search }), ADAPTER_SCAN_TIMEOUT_MS, () => []),
      ),
    )

    const all = []
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        for (const s of r.value) {
          if (s?.cwd) this.rememberSessionRoot(s.cwd)
          all.push(s)
        }
      }
    }
    if (isAll) {
      this._sessionRootsSyncedAt = Date.now()
    }
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return isAll ? all : all.slice(0, limit)
  }

  async readSession({ id, app, sessionId, limit = 25, cursor = null } = {}) {
    const parsed = id ? parseCompositeId(id) : { app: app || APPS.DSH, sessionId }
    if (!parsed.sessionId) throw new Error('缺少 sessionId')
    const session = await this.getAdapter(parsed.app).readSession(parsed.sessionId, { limit, cursor })
    if (session?.cwd) this.rememberSessionRoot(session.cwd)
    return session
  }

  async listModels({ app = 'all' } = {}) {
    const isAll = !app || app === 'all'
    if (isAll && this._inFlightModels) return this._inFlightModels
    const targets = isAll ? this.enabledApps : [app]
    const run = (async () => {
      const catalog = {}
      await Promise.all(
        targets.map(async (a) => {
          try {
            const adapter = this.getAdapter(a)
            if (typeof adapter.listModels === 'function') {
              catalog[a] = await withTimeout(
                adapter.listModels(),
                ADAPTER_MODELS_TIMEOUT_MS,
                () => ({ app: a, defaultModel: '', defaultEffort: '', supportsMidChatSwitch: false, models: [], error: '模型列表查询超时' }),
              )
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
    })()
    if (isAll) {
      this._inFlightModels = run
      run.finally(() => {
        if (this._inFlightModels === run) this._inFlightModels = null
      })
    }
    return run
  }

  async createSession({ app = APPS.DSH, cwd, title, model, provider, reasoningEffort, sandbox, approvalPolicy } = {}) {
    const safeCwd = assertSafeWorkspaceCwd(cwd, { allowEmpty: true }) || undefined
    // Enforce host ceiling on Codex sandbox & approvalPolicy so remote callers cannot escalate privileges
    const effectiveSandbox =
      app === APPS.CODEX ? clampCodexSandbox(sandbox, this.config.codexSandbox) : undefined
    const effectiveApproval =
      app === APPS.CODEX ? clampCodexApprovalPolicy(approvalPolicy, this.config.codexApprovalPolicy) : undefined

    const created = await this.getAdapter(app).createSession({
      cwd: safeCwd,
      title,
      model,
      provider,
      reasoningEffort,
      sandbox: effectiveSandbox,
      approvalPolicy: effectiveApproval,
    })
    this.onEvent(EVENTS.SESSION_UPDATED, { session: created })
    return created
  }

  _isAdapterSessionBusy(adapter, sessionId) {
    if (!adapter || !sessionId) return false
    if (typeof adapter.isSessionBusy === 'function') return adapter.isSessionBusy(sessionId)
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
        approvalPolicy:
          parsed.app === APPS.CODEX
            ? clampCodexApprovalPolicy(approvalPolicy, this.config.codexApprovalPolicy)
            : approvalPolicy,
        permissionMode,
        taskMode,
        model,
        provider,
        reasoningEffort,
      })
      return result
    } catch (err) {
      if (burned.length > 0 && (err?.code === 'SESSION_BUSY' || !err?._streamErrorEmitted)) {
        this.inboundStore.restoreTokens(burned)
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
        if (err?.code !== 'APPROVAL_TRANSPORT_CLOSED') {
          this.pendingApprovals.set(id, req)
        }
        throw err
      }
    }
    return { resolved: true, id, decision }
  }

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
      throw new Error(`无效的目标应用：${app}（可选：${this.enabledApps.join(', ')}）`)
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

  async readLocalFile({ path: rawPath, cwd = '', mode = 'image', sessionId = '' } = {}, { mintDownloadTicket = null } = {}) {
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
    if ((p.startsWith('<') && p.endsWith('>')) || (p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1).trim()
    }

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
        if (!existsSync(p)) {
          try { p = decodeURIComponent(p) } catch {}
        }
      }
    }

    if (p.startsWith('~/') || p.startsWith('~\\')) {
      p = join(homedir(), p.slice(2))
    }

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
      normReal.includes('/.workbuddy/auth') ||
      normReal.includes('/.codebuddy/auth') ||
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
      /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts|shadow|passwd|accounts\.json|accounts\.db|allinone-dsh-ipc\.json|e2ee-key\.html)(?:\.|$)/i.test(fileName) ||
      /^(?:secrets?|credentials?|passwords?|tokens?)\.(?:txt|csv|md|zip)$/i.test(fileName) ||
      /\.(?:pem|key|p12|pfx|kdbx)$/i.test(fileName)
    if (isBlockedDir || isBlockedName) {
      throw new Error('出于安全限制，禁止远程下载系统敏感目录或凭据文件')
    }

    {
      const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin'
      const cmpPath = (targetPath) => (caseInsensitiveFs ? targetPath.toLowerCase() : targetPath)
      const normTarget = cmpPath(realPath)
      const home = homedir()
      const homeRealNorm = getNormalizedHomeReal()
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

      // Narrow fastRoots: only explicit artifact subdirectories under agent state homes (not entire ~/.codex or ~/.claude)
      const fastRoots = [
        this.config.cwd,
        this.inboundDir,
        join(home, 'Desktop'),
        join(home, 'Downloads'),
        join(home, 'Documents'),
        ...(!isDocumentMode ? [join(home, 'Pictures')] : []),
        join(home, '.gemini', 'antigravity', 'brain'),
        join(home, '.dsh', 'allinone-uploads'),
        join(home, 'WorkBuddy'),
      ]
      let inAllowedRoot = checkRoots(fastRoots)
      if (!inAllowedRoot && this.knownSessionRoots.size > 0) {
        inAllowedRoot = checkRoots([...this.knownSessionRoots.values()])
      }
      if (!inAllowedRoot) {
        try {
          const workspaces = await this.listWorkspaces()
          inAllowedRoot = checkRoots(workspaces.map((w) => w?.path))
        } catch {}
      }
      if (!inAllowedRoot && sessionId) {
        try {
          const sess = await this.readSession({ id: String(sessionId).trim(), limit: 1 })
          if (sess?.cwd) {
            inAllowedRoot = checkRoots([sess.cwd])
          }
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

    const publicMeta = {
      ok: true,
      kind: isDocumentMode ? 'document' : 'image',
      transferMode: 'p2p-bulk',
      filename: basename(realPath),
      mimeType: realMimeType,
      size: st.size,
      mtimeMs: st.mtimeMs,
      path: realPath,
    }
    if (typeof mintDownloadTicket === 'function') {
      const streamId = mintDownloadTicket({
        realPath,
        size: st.size,
        maxBytes: MAX_BYTES,
        mimeType: realMimeType,
        filename: publicMeta.filename,
      })
      return { ...publicMeta, streamId }
    }
    return publicMeta
  }

  /** Unified RPC handler for incoming direct P2P requests. */
  async handleRpc(method, params = {}, ctx = {}) {
    switch (method) {
      case RPC.BRIDGE_PING:
        return { ok: true, ts: Date.now() }
      case RPC.FILE_READ:
        return await this.readLocalFile(params, { mintDownloadTicket: ctx?.mintDownloadTicket || null })
      case RPC.APPS_STATUS:
        return { apps: await this.getAppsStatus({ forceQuota: Boolean(params?.forceQuota) }) }
      case RPC.APP_SETUP: {
        const app = String(params?.app || '').trim()
        if (!app || !this.adapters[app]) {
          throw new Error(`不支持的应用类型：${app}`)
        }
        const adapter = this.adapters[app]
        if (typeof adapter.runSetup !== 'function') {
          throw new Error(`应用 ${app} 不支持远程一键配置`)
        }
        const action = String(params?.action || 'setup').trim()
        const methodId = String(params?.methodId || 'internal').trim()
        if (!['setup', 'login', 'status'].includes(action)) {
          throw new Error('非法的 setup action 参数')
        }
        if (!['internal', 'external'].includes(methodId)) {
          throw new Error('非法的登录方式参数')
        }
        const res = await adapter.runSetup({ action, methodId })
        if (res?.writable) {
          this.refreshEnvironment()
        }
        return res
      }
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
        // Strictly allowlist public fields on SESSION_CREATE
        return {
          session: await this.createSession({
            app: params?.app,
            cwd: params?.cwd,
            title: params?.title,
            model: params?.model,
            provider: params?.provider,
            reasoningEffort: params?.reasoningEffort,
            sandbox: params?.sandbox,
            approvalPolicy: params?.approvalPolicy,
          }),
        }
      case RPC.SESSION_SEND: {
        const targetId = params?.id || makeCompositeId(params?.app || APPS.DSH, params?.sessionId)
        const parsed = parseCompositeId(targetId)
        assertSafeSessionId(parsed.sessionId, 'sessionId')
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
        assertSafeWorkspaceCwd(publicParams.cwd, { allowEmpty: true })
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
          if (err?._streamErrorEmitted) return
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
        // Strictly allowlist public fields on DISPATCH_CREATE
        return {
          task: await this.dispatchTask({
            app: params?.app,
            sessionId: params?.sessionId,
            cwd: params?.cwd,
            title: params?.title,
            prompt: params?.prompt,
            wait: Boolean(params?.wait),
            issuedBy: 'mobile',
          }),
        }
      case RPC.DISPATCH_STATUS:
        return { task: this.getDispatchStatus(params.taskId) }
      default:
        throw new Error(`未知 RPC 方法：${method}`)
    }
  }

  async dispose() {
    const adapterList = Object.values(this.adapters)
    await withTimeout(
      Promise.allSettled(adapterList.map((adapter) => Promise.resolve().then(() => adapter.dispose?.()))),
      DISPOSE_BUDGET_MS,
      () => undefined,
    )
  }
}
