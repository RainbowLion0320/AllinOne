import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { APPS, EVENTS, assertPathWithinDir, assertSafeSessionId, makeCompositeId, toEpochMs } from '../protocol.js'
import { parseDshConfiguredModels } from '../helpers/dsh-models.js'
import { mergeAndCompactMessages } from '../helpers/history-normalize.js'
import { normalizeResolvePayload, normalizeSingleAnswer } from '../helpers/interactive-schema.js'
import { createTaskStateTracker } from '../helpers/task-state.js'
import { DshLocalIpcClient } from '../dsh-local-ipc.js'

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
 * Identify synthetic runtime/system injections that DSH stores as `user/message` events
 * (e.g. `runtime-context`, `skill-catalog`, `time-context`, `agent-instructions`, `tool-jobs`),
 * so they never render as fake user bubbles in All in One.
 */
function isDshInternalSystemUserMessage(ev, text) {
  const srcKind = String(ev?.data?.message?.source?.kind ?? ev?.data?.source?.kind ?? '')
    .trim()
    .toLowerCase()
  if (srcKind && srcKind !== 'user') return true
  const trimmed = String(text || '').trim()
  if (!trimmed) return false
  if (/^<system-reminder>[\s\S]*<\/system-reminder>$/i.test(trimmed)) return true
  if (/^Time sampled while preparing turn \d+, step \d+:/i.test(trimmed)) return true
  return false
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
      if (isDshInternalSystemUserMessage(ev, text)) {
        continue
      }
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

function extractDshTaskState(events) {
  const tracker = createTaskStateTracker()
  for (const ev of events || []) {
    if (!ev || ev.type !== 'assistant/message') continue
    const ts = toEpochMs(ev.timestamp || ev.at || ev.createdAt || Date.now())
    const blocks = ev.data?.message?.content ?? ev.data?.content ?? []
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b && (b.type === 'tool_use' || b.type === 'tool_call')) {
        tracker.applyDshTool(b.name || 'tool', b.input ?? b.arguments ?? {}, ts)
      }
    }
  }
  return tracker.snapshot()
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

/**
 * Wrap `request.signal` with a child AbortController before forwarding a Cordis waterfall
 * (`user-questions/request` / `approval/request`) to DSH Desktop (`next()`).
 * - Parent aborts propagate straight into the child signal so DSH Desktop clears normally.
 * - When All in One answers first, `abortDesktop()` aborts ONLY the downstream child signal,
 *   causing DSH's `dsh-api-gateway` to drop `pendingRemoteEvents` and send `{ type: 'cancel' }`
 *   to silently dismiss DSH Desktop's pending question / approval card without aborting the
 *   parent tool call or Turn.
 */
function attachDownstreamDesktopSignal(request) {
  const origSignal = request?.signal
  const desktopAc = new AbortController()
  const onOrigAbort = () => {
    if (!desktopAc.signal.aborted) {
      desktopAc.abort(origSignal?.reason ?? new Error('request aborted'))
    }
  }
  if (origSignal) {
    if (origSignal.aborted) {
      desktopAc.abort(origSignal.reason)
    } else {
      try { origSignal.addEventListener('abort', onOrigAbort, { once: true }) } catch {}
    }
  }

  let swapped = false
  let hadOwnSignal = false
  let origDesc = null

  const install = () => {
    if (swapped || !request || typeof request !== 'object') return false
    try {
      hadOwnSignal = Object.prototype.hasOwnProperty.call(request, 'signal')
      origDesc = hadOwnSignal ? Object.getOwnPropertyDescriptor(request, 'signal') : null
      if (!hadOwnSignal || origDesc?.writable) {
        request.signal = desktopAc.signal
        swapped = true
      } else if (origDesc?.configurable) {
        Object.defineProperty(request, 'signal', {
          value: desktopAc.signal,
          writable: true,
          enumerable: origDesc.enumerable,
          configurable: true,
        })
        swapped = true
      }
    } catch {}
    return swapped
  }

  const restore = () => {
    if (!swapped || !request || typeof request !== 'object') return
    swapped = false
    try {
      if (hadOwnSignal && origDesc) {
        Object.defineProperty(request, 'signal', origDesc)
      } else if (hadOwnSignal) {
        request.signal = origSignal
      } else {
        delete request.signal
      }
    } catch {}
  }

  const detachParent = () => {
    if (origSignal) {
      try { origSignal.removeEventListener('abort', onOrigAbort) } catch {}
    }
  }

  const abortDesktop = (reason = 'Answered remotely via All in One') => {
    if (!desktopAc.signal.aborted) {
      try {
        desktopAc.abort(new Error(reason))
      } catch {}
    }
  }

  return {
    origSignal,
    desktopSignal: desktopAc.signal,
    install,
    restore,
    detachParent,
    abortDesktop,
  }
}

export class DshAdapter {
  constructor({ ctx = null, config = {}, log = console, emitEvent, onApprovalRequest }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.emitEvent = emitEvent || (() => {})
    this.onApprovalRequest = onApprovalRequest || (() => {})
    this.dshHome = String(config.dshHome ?? '').trim() || getDshHome()
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
    this.pendingApprovals = new Map() // id -> { req, resolveMobile, rejectMobile }
    this.cordisDisposers = []
    this.ipcClient = this.ctx
      ? null
      : new DshLocalIpcClient({
          dshHome: this.dshHome,
          emitEvent: (event, payload) => {
            if (event === EVENTS.APPROVAL_REQUEST && payload?.id) {
              this.onApprovalRequest(payload)
              return
            }
            this.emitEvent(event, payload)
          },
          log: this.log,
        })
    if (this.ctx) {
      this.attachCordisInteractiveHooks()
    }
  }

  /**
   * Bridge DSH's native Cordis waterfall seams (`user-questions/request` and `approval/request`)
   * to mobile/remote clients while racing cleanly against DSH Desktop UI (`next()`).
   * Whichever side answers first wins, and the other surface clears immediately!
   */
  attachCordisInteractiveHooks() {
    if (!this.ctx || typeof this.ctx.on !== 'function') return
    try {
      const disposeQ = this.ctx.on(
        'user-questions/request',
        (request, next) => this.handleCordisUserQuestions(request, next),
        { prepend: true, global: true },
      )
      if (typeof disposeQ === 'function') this.cordisDisposers.push(disposeQ)
    } catch (err) {
      this.log.warn?.(`mobile-hub: failed hooking DSH user-questions/request: ${String(err)}`)
    }
    try {
      const disposeA = this.ctx.on(
        'approval/request',
        (request, next) => this.handleCordisApprovalRequest(request, next),
        { prepend: true, global: true },
      )
      if (typeof disposeA === 'function') this.cordisDisposers.push(disposeA)
    } catch (err) {
      this.log.warn?.(`mobile-hub: failed hooking DSH approval/request: ${String(err)}`)
    }
  }

  handleCordisUserQuestions(request, next) {
    const rawQuestions = Array.isArray(request?.questions) ? request.questions : []
    if (rawQuestions.length === 0) return next()

    const nativeSessionId = String(request?.agent?.session?.id || request?.agent?.id || '').trim()
    const compositeId = nativeSessionId ? makeCompositeId(APPS.DSH, nativeSessionId) : ''
    const aprId = `dsh-q-${randomUUID().slice(0, 10)}`

    // Detect DSH single-question approval / plan-review intent for crisp button presentation
    const single = rawQuestions.length === 1 ? rawQuestions[0] : null
    const isApprovalIntent = Boolean(single?.intent?.kind === 'approval')

    let card
    if (isApprovalIntent) {
      const intent = single.intent
      const options = (Array.isArray(single.options) ? single.options : []).map((opt) => ({
        value: String(opt?.label || ''),
        label: String(opt?.label || ''),
        description: String(opt?.description || ''),
        style:
          opt?.label === intent.reject
            ? 'danger'
            : opt?.label === intent.approve
              ? 'primary'
              : 'secondary',
      }))
      card = {
        id: aprId,
        app: APPS.DSH,
        sessionId: compositeId,
        kind: 'command',
        title: String(single.question || single.header || 'DeepSeek 请求确认').trim(),
        detail: String(single.detail || '').trim(),
        options,
        createdAt: Date.now(),
      }
    } else {
      const questions = rawQuestions.map((q, idx) => {
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
          header: String(q?.header || '').trim(),
          question: String(q?.question || '').trim() || `问题 ${idx + 1}`,
          description: String(q?.detail || '').trim(),
          multiSelect: Boolean(q?.multiSelect),
          allowOther: true,
          inputType: opts.length > 0 ? 'select' : 'text',
          required: false,
          options: opts,
        }
      })
      card = {
        id: aprId,
        app: APPS.DSH,
        sessionId: compositeId,
        kind: 'question',
        title: single?.intent?.kind === 'plan-review' ? 'DeepSeek 计划确认' : 'DeepSeek 需要你做选择',
        detail: '',
        questions,
        createdAt: Date.now(),
      }
    }

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      let desktopForwarded = false
      let desktopSettled = false
      let flushTimer = null
      const desktopRace = attachDownstreamDesktopSignal(request)
      const origSignal = desktopRace.origSignal

      const cleanup = (resolvedDecision = '') => {
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        this.pendingApprovals.delete(aprId)
        desktopRace.detachParent()
        if (origSignal && onAbort) {
          try { origSignal.removeEventListener('abort', onAbort) } catch {}
        }
        if (resolvedDecision) {
          this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
            id: aprId,
            app: APPS.DSH,
            decision: resolvedDecision,
          })
        }
      }

      const finishResolve = (result, resolvedDecision, { cancelDesktop = false } = {}) => {
        if (settled) return
        settled = true
        cleanup(resolvedDecision)
        const shouldCancelDesktop = cancelDesktop && desktopForwarded && !desktopSettled
        if (shouldCancelDesktop) {
          desktopRace.abortDesktop()
          // Non-timed questions with a durable `wait.callId` rely on DSH Desktop's `reconcile()`
          // running AFTER the loopback `{ type: 'cancel' }` frame clears `card.hasRequest()` and
          // `card.pending.hasWaterfall()`. Giving the cancel frame 50ms avoids racing the
          // `userQuestions` projection patch. For `wait.timed === true`, resolve immediately so
          // `TimedQuestionWait` never fires `ASK_TIMED_OUT` when desktop releases its claim.
          if (request?.wait?.callId && !request?.wait?.timed) {
            flushTimer = setTimeout(() => {
              flushTimer = null
              desktopRace.restore()
              resolvePromise(result)
            }, 50)
            flushTimer.unref?.()
            return
          }
          // Defer signal restoration to next macrotask so any queued gateway microtask still
          // observes the aborted `desktopSignal`.
          const restoreTimer = setTimeout(() => desktopRace.restore(), 0)
          restoreTimer.unref?.()
          resolvePromise(result)
          return
        }
        desktopRace.restore()
        resolvePromise(result)
      }

      const finishReject = (err, resolvedDecision) => {
        if (settled) return
        settled = true
        cleanup(resolvedDecision)
        desktopRace.restore()
        rejectPromise(err)
      }

      const onAbort = () => {
        finishReject(origSignal?.reason || new Error('ask_user_question aborted'), 'cancel')
      }
      if (origSignal) {
        if (origSignal.aborted) {
          onAbort()
          return
        }
        try { origSignal.addEventListener('abort', onAbort, { once: true }) } catch {}
      }

      this.pendingApprovals.set(aprId, {
        req: card,
        type: 'user-questions',
        rawQuestions,
        isApprovalIntent,
        resolveMobile: (decisionOrPayload) => {
          const { decision, answers } = normalizeResolvePayload(decisionOrPayload)
          if (isApprovalIntent && single) {
            const chosen = decision && decision !== 'cancel'
              ? [decision]
              : single.intent?.reject
                ? [single.intent.reject]
                : []
            finishResolve(
              { answers: [{ id: single.id, selected: chosen }] },
              decision || 'cancel',
              { cancelDesktop: true },
            )
            return { resolved: true, id: aprId, decision: decision || 'cancel' }
          }
          const cancelled = decision === 'cancel' || decision === 'decline'
          const outAnswers = rawQuestions.map((q, idx) => {
            const qKey = String(q?.id || `q_${idx}`)
            if (cancelled) return { id: qKey, selected: [] }
            const ans = normalizeSingleAnswer(answers[qKey])
            return {
              id: qKey,
              selected: ans.selected,
              ...(ans.custom ? { custom: ans.custom } : {}),
            }
          })
          finishResolve(
            { answers: outAnswers },
            cancelled ? 'cancel' : 'submit',
            { cancelDesktop: true },
          )
          return { resolved: true, id: aprId, decision: cancelled ? 'cancel' : 'submit' }
        },
      })

      this.onApprovalRequest(card)

      // Race against DSH Desktop UI (`next()`): absorb NO_PROVIDER so headless DSH still waits for mobile!
      Promise.resolve()
        .then(() => {
          if (settled) return undefined
          desktopRace.install()
          desktopForwarded = true
          return next()
        })
        .then(
          (desktopRes) => {
            desktopSettled = true
            if (desktopRes && Array.isArray(desktopRes.answers)) {
              finishResolve(desktopRes, 'desktop')
            }
          },
          (err) => {
            desktopSettled = true
            if (settled) return
            if (err?.code === 'NO_PROVIDER') return
            finishReject(err, 'cancel')
          },
        )
    })
  }

  handleCordisApprovalRequest(request, next) {
    const nativeSessionId = String(request?.agent?.session?.id || request?.agent?.id || '').trim()
    const compositeId = nativeSessionId ? makeCompositeId(APPS.DSH, nativeSessionId) : ''
    const aprId = `dsh-apr-${randomUUID().slice(0, 10)}`
    const toolName = String(request?.toolName || 'tool')
    const card = {
      id: aprId,
      app: APPS.DSH,
      sessionId: compositeId,
      kind: 'command',
      title: `DeepSeek 请求执行：${toolName}`,
      detail: String(request?.reason || toolName).trim(),
      cwd: String(request?.agent?.session?.meta?.cwd || '').trim(),
      options: [
        { value: 'allowed-once', label: '允许一次', style: 'primary' },
        { value: 'rejected', label: '拒绝', style: 'danger' },
      ],
      createdAt: Date.now(),
    }

    return new Promise((resolvePromise) => {
      let settled = false
      let desktopForwarded = false
      let desktopSettled = false
      const desktopRace = attachDownstreamDesktopSignal(request)
      const origSignal = desktopRace.origSignal

      const cleanup = (resolvedDecision = '') => {
        this.pendingApprovals.delete(aprId)
        desktopRace.detachParent()
        if (origSignal && onAbort) {
          try { origSignal.removeEventListener('abort', onAbort) } catch {}
        }
        if (resolvedDecision) {
          this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
            id: aprId,
            app: APPS.DSH,
            decision: resolvedDecision,
          })
        }
      }

      const finish = (outcome, resolvedDecision, { cancelDesktop = false } = {}) => {
        if (settled) return
        settled = true
        cleanup(resolvedDecision)
        const shouldCancelDesktop = cancelDesktop && desktopForwarded && !desktopSettled
        if (shouldCancelDesktop) {
          desktopRace.abortDesktop()
          const restoreTimer = setTimeout(() => desktopRace.restore(), 0)
          restoreTimer.unref?.()
        } else {
          desktopRace.restore()
        }
        resolvePromise(outcome)
      }

      const onAbort = () => finish('cancelled', 'cancel')
      if (origSignal) {
        if (origSignal.aborted) {
          onAbort()
          return
        }
        try { origSignal.addEventListener('abort', onAbort, { once: true }) } catch {}
      }

      this.pendingApprovals.set(aprId, {
        req: card,
        type: 'approval',
        resolveMobile: (decisionOrPayload) => {
          const { decision } = normalizeResolvePayload(decisionOrPayload)
          const outcome =
            decision === 'allowed-once' || decision === 'accept' || decision === 'allow'
              ? 'allowed-once'
              : decision === 'cancel' || decision === 'cancelled'
                ? 'cancelled'
                : 'rejected'
          finish(outcome, outcome, { cancelDesktop: true })
          return { resolved: true, id: aprId, decision: outcome }
        },
      })

      this.onApprovalRequest(card)

      Promise.resolve()
        .then(() => {
          if (settled) return undefined
          desktopRace.install()
          desktopForwarded = true
          return next()
        })
        .then(
          (desktopOutcome) => {
            desktopSettled = true
            if (
              desktopOutcome === 'allowed-once' ||
              desktopOutcome === 'rejected' ||
              desktopOutcome === 'cancelled'
            ) {
              finish(desktopOutcome, desktopOutcome)
            }
          },
          () => {
            desktopSettled = true
          },
        )
    })
  }

  async listPendingApprovals() {
    if (this.ctx) {
      return [...this.pendingApprovals.values()].map((entry) => entry.req)
    }
    if (this.ipcClient) {
      const ipc = await this.ipcClient.checkHealth()
      if (ipc) {
        try {
          const list = await this.ipcClient.call('listApprovals', {}, { timeoutMs: 5_000 })
          return Array.isArray(list) ? list : []
        } catch {
          return null
        }
      }
    }
    return null
  }

  async resolveApproval(approvalId, decisionOrPayload) {
    if (this.ctx) {
      const entry = this.pendingApprovals.get(approvalId)
      if (!entry) return { resolved: false, reason: 'approval not found' }
      return entry.resolveMobile(decisionOrPayload)
    }
    if (this.ipcClient) {
      const normalized = normalizeResolvePayload(decisionOrPayload)
      return this.ipcClient.call(
        'resolveApproval',
        { id: approvalId, decision: normalized.decision, answers: normalized.answers },
        { timeoutMs: 15_000 },
      )
    }
    return { resolved: false, reason: 'DSH IPC not available' }
  }

  hasDshPluginConfigured() {
    const pkgPath = join(this.dshHome, 'profiles', 'desktop', 'package.json')
    const pkg = readJsonSafe(pkgPath)
    const bundles = pkg?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return false
    return bundles.includes('dsh-mobile-hub') || bundles.includes('allinone-dsh-ipc')
  }

  getIpcUnavailableMessage() {
    if (this.hasDshPluginConfigured()) {
      return '未检测到运行中的 DeepSeek Harness 本地桥接服务。请先打开或重启一次 DeepSeek Harness 桌面端，之后即可直接新建并操控 DSH 对话。'
    }
    return 'DeepSeek Harness 尚需加载本机轻量桥接插件（All in One 正在后台自动配置）。请稍候片刻并重启一次 DeepSeek Harness 桌面端即可读写控制 DSH 会话。'
  }

  async listModels() {
    const parsed = parseDshConfiguredModels(this.dshHome)
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
    const parsed = parseDshConfiguredModels(this.dshHome)
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
    if (this.isLive()) {
      return {
        app: APPS.DSH,
        available: true,
        writable: true,
        mode: 'cordis-live',
        detail: '已挂载到 DeepSeek Harness 核心引擎（零侵入纯桥接，0 额外 Token 与工具注入）',
        activeCount: this.activeTurns.size,
      }
    }
    const ipc = await this.ipcClient?.checkHealth()
    if (ipc) {
      return {
        app: APPS.DSH,
        available: true,
        writable: true,
        mode: 'dsh-local-ipc',
        detail: '已通过本机安全 IPC 连接到运行中的 DeepSeek Harness 引擎（读写就绪）',
        activeCount: ipc.activeCount || 0,
      }
    }
    return {
      app: APPS.DSH,
      available: storagesExists,
      writable: false,
      mode: 'standalone-readonly',
      detail: this.hasDshPluginConfigured()
        ? '只读模式（打开或重启 DeepSeek Harness 桌面端后自动切换为读写就绪）'
        : '只读模式（可浏览 DSH 历史；All in One 将自动安装本机 DSH 桥接插件，重启 DSH 后即可读写控制）',
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
    if (!this.isLive() && this.ipcClient) {
      const ipc = await this.ipcClient.checkHealth()
      if (ipc) {
        try {
          return await this.ipcClient.call('listSessions', { limit, search, includeArchived })
        } catch {}
      }
    }
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
        const isLocalActive = this.activeTurns.has(sessionId)
        const desktopTurnOpen = Boolean(rows.approvalState?.val?.turnOpen)
        const externalRunning = Boolean(!isLocalActive && desktopTurnOpen)
        const isRunning = isLocalActive || externalRunning

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
          syncState: { externalRunning },
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

  resolveWorkspaceInfo(sessionId = '', cwd = '') {
    const wsPath = join(this.dshHome, 'storages', 'workspace.json')
    const wsData = readJsonSafe(wsPath)
    const rows = Object.values(wsData?.tables?.workspaces || {})
    if (sessionId) {
      for (const row of rows) {
        if (Array.isArray(row?.sessionIds) && row.sessionIds.includes(sessionId)) {
          return { path: row.path || '', title: row.title || '' }
        }
      }
    }
    const cleanCwd = String(cwd || '').trim().replace(/[\\/]+$/, '').toLowerCase()
    if (cleanCwd) {
      for (const row of rows) {
        const rp = String(row?.path || '').trim().replace(/[\\/]+$/, '').toLowerCase()
        if (rp && rp === cleanCwd) {
          return { path: row.path || '', title: row.title || '' }
        }
      }
    }
    return null
  }

  async readSession(sessionId, { limit = 25, cursor = null } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'DSH sessionId')
    if (!this.isLive() && this.ipcClient) {
      const ipc = await this.ipcClient.checkHealth()
      if (ipc) {
        try {
          return await this.ipcClient.call('readSession', {
            sessionId,
            options: { limit, cursor },
          })
        } catch {}
      }
    }
    let messages = []
    let taskState = null
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
          const ownEvents = session.ownEvents()
          messages = parseDshEvents(ownEvents)
          taskState = extractDshTaskState(ownEvents)
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
    const cacheDir = join(this.dshHome, 'storages', 'session_projcache', 'sessions')
    const cacheFile = assertPathWithinDir(join(cacheDir, `${sessionId}.json`), cacheDir, 'DSH session cache')
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

    const isLocalActive = this.activeTurns.has(sessionId)
    const desktopTurnOpen = Boolean(cacheRec?.record?.rows?.approvalState?.val?.turnOpen)
    const externalRunning = Boolean(!isLocalActive && desktopTurnOpen)
    const wsInfo = this.resolveWorkspaceInfo(sessionId, cwd)
    if (!cwd && wsInfo?.path) cwd = wsInfo.path
    const workspace = wsInfo?.title || (cwd ? basename(cwd) : '')

    return {
      id: makeCompositeId(APPS.DSH, sessionId),
      app: APPS.DSH,
      nativeId: sessionId,
      title,
      cwd,
      workspace,
      model,
      provider,
      reasoningEffort,
      writable: this.isLive(),
      status: isLocalActive || externalRunning ? 'running' : 'idle',
      taskState,
      syncState: { externalRunning },
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
    if (!this.isLive()) {
      const ipc = await this.ipcClient?.checkHealth({ force: true })
      if (ipc) {
        return this.ipcClient.call(
          'createSession',
          { cwd, title, model, provider, reasoningEffort },
          { timeoutMs: 30_000 },
        )
      }
      throw new Error(this.getIpcUnavailableMessage())
    }
    const targetCwd = resolve(String(cwd || '').trim() || this.defaultCwd)
    const sid = `mobile-${randomUUID().slice(0, 12)}`
    const { agent, sessionId } = await this.ensureAgent(sid, targetCwd, title || '手机端总控对话')
    if (model || reasoningEffort) {
      await this.applyModelSelection(agent, sessionId, { provider, model, reasoningEffort })
    }
    const wsInfo = this.resolveWorkspaceInfo(sessionId, targetCwd)
    return {
      id: makeCompositeId(APPS.DSH, sessionId),
      app: APPS.DSH,
      nativeId: sessionId,
      title: title || '手机端总控对话',
      cwd: targetCwd,
      workspace: wsInfo?.title || basename(targetCwd),
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
    sessionId = assertSafeSessionId(sessionId, 'DSH sessionId')
    if (this.activeTurns.has(sessionId)) {
      const err = new Error('该 DeepSeek Harness 对话正在运行中，请等待完成或先点击停止。')
      err.code = 'SESSION_BUSY'
      throw err
    }

    const turnState = { agent: null, startedAt: Date.now(), aborted: false }
    this.activeTurns.set(sessionId, turnState)
    let lockedId = sessionId

    if (!this.isLive()) {
      try {
        const ipc = await this.ipcClient?.checkHealth({ force: true })
        if (ipc) {
          return await this.ipcClient.call(
            'sendMessage',
            {
              sessionId,
              payload: { text, cwd, title, attachments, model, provider, reasoningEffort },
            },
            { timeoutMs: 30 * 60 * 1000, waitForEvents: true },
          )
        }
        throw new Error(this.getIpcUnavailableMessage())
      } finally {
        if (this.activeTurns.get(lockedId) === turnState) {
          this.activeTurns.delete(lockedId)
        }
      }
    }

    let realCompositeId = makeCompositeId(APPS.DSH, sessionId)
    let pollTimer = null
    try {
      const { agent, sessionId: resolvedId } = await this.ensureAgent(sessionId, cwd, title)
      if (resolvedId && resolvedId !== lockedId) {
        if (this.activeTurns.has(resolvedId)) {
          const err = new Error('该 DeepSeek Harness 对话正在运行中，请等待完成或先点击停止。')
          err.code = 'SESSION_BUSY'
          throw err
        }
        if (this.activeTurns.get(lockedId) === turnState) {
          this.activeTurns.delete(lockedId)
        }
        lockedId = resolvedId
        this.activeTurns.set(lockedId, turnState)
      }
      turnState.agent = agent
      realCompositeId = makeCompositeId(APPS.DSH, lockedId)

      if (model || reasoningEffort) {
        await this.applyModelSelection(agent, lockedId, { provider, model, reasoningEffort })
      }
      if (turnState.aborted) {
        return { sessionId: realCompositeId, nativeId: lockedId, finalText: '', aborted: true, usage: null }
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
      const taskTracker = createTaskStateTracker(
        typeof agent.session?.ownEvents === 'function' ? extractDshTaskState(agent.session.ownEvents()) : null,
      )

      this.emitEvent(EVENTS.STREAM_START, {
        sessionId: realCompositeId,
        app: APPS.DSH,
        nativeId: lockedId,
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
                const toolInput = b.input ?? b.arguments ?? {}
                this.emitEvent(EVENTS.STREAM_TOOL_START, {
                  sessionId: realCompositeId,
                  app: APPS.DSH,
                  tool: { id: b.id, name: b.name || 'tool', input: toolInput },
                })
                if (taskTracker.applyDshTool(b.name || 'tool', toolInput, Date.now())) {
                  const diff = taskTracker.consumeChanged()
                  if (diff.changed) {
                    this.emitEvent(EVENTS.STREAM_TASK_STATE, {
                      sessionId: realCompositeId,
                      app: APPS.DSH,
                      taskState: diff.taskState,
                    })
                  }
                }
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

      pollTimer = setInterval(flushNewEvents, 250)
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
        nativeId: lockedId,
        finalText,
        aborted: turnState.aborted,
      })

      return {
        sessionId: realCompositeId,
        nativeId: lockedId,
        finalText,
        aborted: turnState.aborted,
      }
    } catch (err) {
      const errObj = err && typeof err === 'object' ? err : new Error(String(err))
      if (errObj.code !== 'SESSION_BUSY' && !errObj._streamErrorEmitted) {
        try { errObj._streamErrorEmitted = true } catch {}
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: realCompositeId,
          app: APPS.DSH,
          message: String(errObj.message || errObj),
        })
      }
      throw errObj
    } finally {
      if (pollTimer) clearInterval(pollTimer)
      if (this.activeTurns.get(lockedId) === turnState) {
        this.activeTurns.delete(lockedId)
      }
    }
  }

  async interrupt(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'DSH sessionId')
    if (!this.isLive() && this.ipcClient) {
      const ipc = await this.ipcClient.checkHealth()
      if (ipc) {
        return this.ipcClient.call('interrupt', { sessionId }, { timeoutMs: 10_000 })
      }
    }
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
    for (const disposeFn of this.cordisDisposers) {
      try { disposeFn() } catch {}
    }
    this.cordisDisposers = []
    for (const [id, entry] of this.pendingApprovals.entries()) {
      try { entry.resolveMobile({ decision: 'cancel' }) } catch {}
      this.pendingApprovals.delete(id)
    }
    this.ipcClient?.dispose()
    for (const handle of this.ownedHandles.values()) {
      try { await handle.dispose?.() } catch {}
    }
    this.ownedHandles.clear()
  }
}
