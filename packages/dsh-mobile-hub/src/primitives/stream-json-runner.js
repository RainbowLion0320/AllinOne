import { randomUUID } from 'node:crypto'
import { EVENTS } from '../protocol.js'
import { killProcessTree, spawnCrossPlatform } from '../helpers/bin-finder.js'
import { normalizeResolvePayload, normalizeSingleAnswer } from '../helpers/interactive-schema.js'
import { createTaskStateTracker } from '../helpers/task-state.js'

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024

/**
 * Shared bidirectional `--input-format stream-json --output-format stream-json` turn executor
 * & `control_request` / `control_response` interactive approval manager.
 *
 * Powers BOTH `ClaudeAdapter` and `WorkBuddyAdapter`, eliminating ~1,000 lines of duplication
 * while guaranteeing:
 *  - Pre-await session reservation (prevents async TOCTOU double-spawn)
 *  - Sliding turn inactivity timeout & stdout `maxLineBytes` OOM guard
 *  - `APPROVAL_TRANSPORT_CLOSED` error when stdin is dead (no silent fake resolution)
 *  - `sessionId` included on `APPROVAL_RESOLVED` events
 *  - Clean `killProcessTree` teardown (no raw `proc.kill()` orphans)
 */
export class StreamJsonCliRunner {
  constructor({
    app,
    displayName,
    idPrefix,
    emitEvent,
    onApprovalRequest,
    sessionTaskStates,
    spawnFn = null,
    extractToolOutput = null,
    log = console,
  }) {
    this.app = app
    this.displayName = displayName
    this.idPrefix = idPrefix
    this.emitEvent = emitEvent || (() => {})
    this.onApprovalRequest = onApprovalRequest || (() => {})
    this.sessionTaskStates = sessionTaskStates || new Map()
    this.spawnFn = spawnFn || ((bin, args, opts) => spawnCrossPlatform(bin, args, opts))
    this.extractToolOutput = extractToolOutput || ((c) => (typeof c === 'string' ? c : JSON.stringify(c ?? '')))
    this.log = log

    /** @type {Map<string, any>} sessionId -> active turn state or reservation placeholder */
    this.activeProcs = new Map()
    /** @type {Map<string, any>} approvalId -> pending control_request */
    this.pendingControlRequests = new Map()
  }

  isSessionBusy(sessionId) {
    return this.activeProcs.has(sessionId)
  }

  /**
   * Atomically reserve a session slot BEFORE any async pre-checks (kills TOCTOU double-spawn).
   * Throws `SESSION_BUSY` if another turn or reservation is already active.
   */
  reserveSession(sessionId, busyMessage = '') {
    if (this.activeProcs.has(sessionId)) {
      const err = new Error(busyMessage || `该 ${this.displayName} 会话正在运行中，请等待完成或先点击停止。`)
      err.code = 'SESSION_BUSY'
      throw err
    }
    const token = { reserved: true, proc: null, aborted: false }
    this.activeProcs.set(sessionId, token)
    return token
  }

  releaseReservation(sessionId, token) {
    if (this.activeProcs.get(sessionId) === token) {
      this.activeProcs.delete(sessionId)
    }
  }

  runTurn({
    sessionId,
    compositeId,
    bin,
    args,
    cwd,
    env = undefined,
    prompt,
    effectivePermissionMode = 'default',
    reservationToken = null,
    inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    onRateLimit = null,
    onInspectAssistantText = null,
    formatError = null,
    onCleanup = null,
    onAfterDone = null,
    onSessionPersisted = null,
  }) {
    const cleanError = (raw) =>
      typeof formatError === 'function' ? formatError(raw) : (String(raw || '').trim() || `${this.displayName} 执行返回错误`)

    this.emitEvent(EVENTS.STREAM_START, {
      sessionId: compositeId,
      app: this.app,
      nativeId: sessionId,
    })

    return new Promise((resolvePromise, rejectPromise) => {
      let proc
      try {
        proc = this.spawnFn(bin, args, {
          cwd,
          ...(env ? { env } : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        if (reservationToken) this.releaseReservation(sessionId, reservationToken)
        try { onCleanup?.() } catch {}
        if (err && typeof err === 'object') err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: this.app,
          message: String(err?.message || err),
        })
        rejectPromise(err)
        return
      }
      proc.stdout.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')

      const taskTracker = createTaskStateTracker(this.sessionTaskStates.get(sessionId) || null)
      if (effectivePermissionMode === 'plan') {
        taskTracker.setMode('plan', Date.now())
      } else if (taskTracker.snapshot()?.mode === 'plan') {
        taskTracker.setMode(null, Date.now())
      }
      const emitTaskState = () => {
        const diff = taskTracker.consumeChanged()
        if (!diff.changed) return
        this.sessionTaskStates.set(sessionId, diff.taskState)
        this.emitEvent(EVENTS.STREAM_TASK_STATE, {
          sessionId: compositeId,
          app: this.app,
          taskState: diff.taskState,
        })
      }

      const state = {
        proc,
        aborted: Boolean(reservationToken?.aborted),
        taskTracker,
        emitTaskState,
        cleanup: onCleanup,
        inactivityTimer: null,
      }
      this.activeProcs.set(sessionId, state)
      if (state.aborted) {
        killProcessTree(proc, { force: false })
      }
      emitTaskState()

      let stdoutBuf = ''
      let droppingOversizedLine = false
      let stderrBuf = ''
      let finalText = ''
      let seenResult = false
      let settled = false
      const emittedTextByMsg = new Map()
      const emittedThinkByMsg = new Map()
      let lastTextMsgId = null
      let lastThinkMsgId = null
      const seenToolIds = new Set()
      let resultError = ''

      const clearInactivityTimer = () => {
        if (state.inactivityTimer) {
          clearTimeout(state.inactivityTimer)
          state.inactivityTimer = null
        }
      }

      const touchInactivityTimer = () => {
        clearInactivityTimer()
        if (!inactivityTimeoutMs || inactivityTimeoutMs <= 0) return
        state.inactivityTimer = setTimeout(() => {
          if (settled) return
          // Do not timeout while awaiting an interactive approval/question response from user
          for (const entry of this.pendingControlRequests.values()) {
            if (entry.proc === proc) {
              touchInactivityTimer()
              return
            }
          }
          resultError = `${this.displayName} 响应超时（超过 ${Math.round(inactivityTimeoutMs / 60_000)} 分钟无输出）`
          killProcessTree(proc, { force: true })
        }, inactivityTimeoutMs)
        state.inactivityTimer.unref?.()
      }
      touchInactivityTimer()

      const handleJsonLine = (line) => {
        let obj
        try {
          obj = JSON.parse(line)
        } catch {
          return
        }
        touchInactivityTimer()

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
                app: this.app,
                tool: { id: b.id, name: b.name || 'tool', input: b.input ?? {} },
              })
              if (taskTracker.applyClaudeTool(b.name || 'tool', b.input ?? {}, Date.now())) {
                emitTaskState()
              }
            } else if (b?.type === 'text' && typeof b.text === 'string') {
              fullText += b.text
            }
          }

          if (typeof onInspectAssistantText === 'function') {
            const interceptedError = onInspectAssistantText(fullText, finalText)
            if (interceptedError) {
              resultError = interceptedError
              return
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
                  app: this.app,
                  delta: rawThinkDelta,
                })
              }
            } else if (fullThink !== prevThink) {
              const thinkPrefix = lastThinkMsgId ? '\n\n' : ''
              emittedThinkByMsg.set(msgId, fullThink)
              lastThinkMsgId = msgId
              this.emitEvent(EVENTS.STREAM_THINKING, {
                sessionId: compositeId,
                app: this.app,
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
                  app: this.app,
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
                app: this.app,
                delta,
              })
            }
          }
        } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
          for (const b of obj.message.content) {
            if (b?.type === 'tool_result' && b.tool_use_id) {
              this.emitEvent(EVENTS.STREAM_TOOL_END, {
                sessionId: compositeId,
                app: this.app,
                toolId: b.tool_use_id,
                status: b.is_error ? 'error' : 'completed',
                output: String(this.extractToolOutput(b.content) || '').slice(0, 3000),
              })
            }
          }
        } else if (obj.type === 'rate_limit_event' && obj.rate_limit_info) {
          try { onRateLimit?.(obj.rate_limit_info) } catch {}
        } else if (obj.type === 'control_request' && obj.request_id && obj.request) {
          this.handleControlRequest(proc, sessionId, compositeId, cwd, obj)
        } else if (obj.type === 'result') {
          seenResult = true
          if (obj.is_error) {
            resultError = cleanError(resultError || obj.result || obj.error)
          } else if (typeof obj.result === 'string' && obj.result.length > 0) {
            const trimmedResult = obj.result.trim()
            if (!lastTextMsgId) {
              finalText = obj.result
              this.emitEvent(EVENTS.STREAM_DELTA, {
                sessionId: compositeId,
                app: this.app,
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
                  app: this.app,
                  delta: suffix,
                })
              } else {
                const delta = `${finalText ? '\n\n' : ''}${obj.result}`
                emittedTextByMsg.set(lastTextMsgId, obj.result)
                finalText += delta
                this.emitEvent(EVENTS.STREAM_DELTA, {
                  sessionId: compositeId,
                  app: this.app,
                  delta,
                })
              }
            }
          }
          try { proc.stdin?.end() } catch {}
        }
      }

      proc.stdin?.on('error', () => {})

      proc.stdout.on('data', (chunk) => {
        const text = String(chunk || '')
        if (droppingOversizedLine) {
          const nl = text.indexOf('\n')
          if (nl === -1) return
          droppingOversizedLine = false
          stdoutBuf = text.slice(nl + 1)
        } else {
          stdoutBuf += text
        }
        let idx
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim()
          stdoutBuf = stdoutBuf.slice(idx + 1)
          if (line) handleJsonLine(line)
        }
        if (stdoutBuf.length > maxLineBytes) {
          this.log.warn?.(`mobile-hub: ${this.displayName} stdout line exceeded ${maxLineBytes} chars; dropping frame`)
          stdoutBuf = ''
          droppingOversizedLine = true
        }
      })

      proc.stderr?.on('data', (chunk) => {
        stderrBuf = (stderrBuf + String(chunk || '')).slice(-4096)
      })

      proc.on('exit', () => {
        try { onCleanup?.() } catch {}
      })

      proc.on('error', (err) => {
        clearInactivityTimer()
        try { onCleanup?.() } catch {}
        if (settled) return
        settled = true
        if (this.activeProcs.get(sessionId) === state) {
          this.activeProcs.delete(sessionId)
        }
        this.clearPendingControlRequests(proc)
        if (err && typeof err === 'object') err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: this.app,
          message: String(err?.message || err),
        })
        rejectPromise(err)
      })

      proc.on('close', (code) => {
        clearInactivityTimer()
        try { onCleanup?.() } catch {}
        if (settled) return
        settled = true
        const tail = droppingOversizedLine ? '' : stdoutBuf.trim()
        if (tail) handleJsonLine(tail)
        if (this.activeProcs.get(sessionId) === state) {
          this.activeProcs.delete(sessionId)
        }
        this.clearPendingControlRequests(proc)

        if (resultError && !state.aborted) {
          try { onSessionPersisted?.(sessionId, false) } catch {}
          const err = new Error(resultError)
          err._streamErrorEmitted = true
          this.emitEvent(EVENTS.STREAM_ERROR, {
            sessionId: compositeId,
            app: this.app,
            message: resultError,
          })
          rejectPromise(err)
          return
        }

        if (code !== 0 && !state.aborted && !seenResult) {
          try { onSessionPersisted?.(sessionId, false) } catch {}
          const errMsg = cleanError(stderrBuf.trim() || `${this.app} 进程退出（code=${code}）`)
          const err = new Error(errMsg)
          err._streamErrorEmitted = true
          this.emitEvent(EVENTS.STREAM_ERROR, {
            sessionId: compositeId,
            app: this.app,
            message: errMsg,
          })
          rejectPromise(err)
          return
        }

        try { onSessionPersisted?.(sessionId, !state.aborted) } catch {}

        this.emitEvent(EVENTS.STREAM_DONE, {
          sessionId: compositeId,
          app: this.app,
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
        try { onAfterDone?.() } catch {}
      })

      const userFrame = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      })
      try {
        proc.stdin.write(`${userFrame}\n`, 'utf8')
      } catch (err) {
        killProcessTree(proc, { force: true })
        clearInactivityTimer()
        if (!settled) {
          settled = true
          if (this.activeProcs.get(sessionId) === state) this.activeProcs.delete(sessionId)
          if (err && typeof err === 'object') err._streamErrorEmitted = true
          this.emitEvent(EVENTS.STREAM_ERROR, {
            sessionId: compositeId,
            app: this.app,
            message: String(err?.message || err),
          })
          rejectPromise(err)
        }
      }
    })
  }

  clearPendingControlRequests(proc) {
    for (const [aprId, entry] of this.pendingControlRequests.entries()) {
      if (entry.proc === proc) {
        this.pendingControlRequests.delete(aprId)
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: aprId,
          app: this.app,
          sessionId: entry.compositeId || '',
          decision: 'cancel',
        })
      }
    }
  }

  writeControlResponse(proc, requestId, responseBody) {
    if (!proc || !proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded || !proc.stdin.writable) {
      return false
    }
    try {
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
    } catch {
      return false
    }
  }

  handleControlRequest(proc, sessionId, compositeId, cwd, obj) {
    const requestId = String(obj.request_id)
    const req = obj.request || {}
    if (req.subtype !== 'can_use_tool') {
      this.writeControlResponse(proc, requestId, { behavior: 'allow' })
      return
    }

    const toolName = String(req.tool_name || 'tool')
    const toolInput = req.input && typeof req.input === 'object' ? req.input : {}

    if (toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions) && toolInput.questions.length > 0) {
      const aprId = `${this.idPrefix}-q-${randomUUID().slice(0, 10)}`
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
        compositeId,
      })

      this.onApprovalRequest({
        id: aprId,
        app: this.app,
        sessionId: compositeId,
        kind: 'question',
        title: `${this.displayName} 需要你做选择`,
        detail: '',
        questions: questions.map(({ origQuestion: _drop, ...publicQ }) => publicQ),
        createdAt: Date.now(),
      })
      return
    }

    if (toolName === 'ExitPlanMode') {
      const active = this.activeProcs.get(sessionId)
      if (active?.taskTracker && active.taskTracker.applyClaudeTool('ExitPlanMode', toolInput, Date.now())) {
        active.emitTaskState?.()
      }
      const aprId = `${this.idPrefix}-plan-${randomUUID().slice(0, 10)}`
      this.pendingControlRequests.set(aprId, {
        proc,
        requestId,
        toolName,
        toolInput,
        sessionId,
        compositeId,
      })
      this.onApprovalRequest({
        id: aprId,
        app: this.app,
        sessionId: compositeId,
        kind: 'permissions',
        title: `${this.displayName} 计划已就绪`,
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

    const aprId = `${this.idPrefix}-apr-${randomUUID().slice(0, 10)}`
    this.pendingControlRequests.set(aprId, {
      proc,
      requestId,
      toolName,
      toolInput,
      sessionId,
      compositeId,
    })

    const detail =
      toolInput.command ||
      toolInput.file_path ||
      toolInput.path ||
      toolInput.description ||
      JSON.stringify(toolInput, null, 2)

    this.onApprovalRequest({
      id: aprId,
      app: this.app,
      sessionId: compositeId,
      kind: toolName === 'Edit' || toolName === 'Write' ? 'file_change' : 'command',
      title: `${this.displayName} 请求使用 ${toolName}`,
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

    const assertWritten = (ok) => {
      if (!ok) {
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: approvalId,
          app: this.app,
          sessionId: entry.compositeId || '',
          decision: 'cancel',
        })
        const err = new Error(`${this.displayName} 进程已关闭，无法写入审批响应`)
        err.code = 'APPROVAL_TRANSPORT_CLOSED'
        throw err
      }
    }

    if (entry.toolName === 'AskUserQuestion') {
      const cancelled = decision === 'cancel' || decision === 'decline' || decision === 'deny'
      if (cancelled) {
        assertWritten(
          this.writeControlResponse(entry.proc, entry.requestId, {
            behavior: 'deny',
            message: 'User cancelled the question',
          }),
        )
      } else {
        const mappedAnswers = {}
        for (const q of entry.questions || []) {
          const ans = normalizeSingleAnswer(answers[q.id])
          const key = q.origQuestion || q.question
          mappedAnswers[key] = q.multiSelect
            ? ans.combined.join(', ')
            : (ans.selected[0] || ans.custom || '')
        }
        assertWritten(
          this.writeControlResponse(entry.proc, entry.requestId, {
            behavior: 'allow',
            updatedInput: {
              ...entry.toolInput,
              questions: entry.toolInput?.questions || [],
              answers: mappedAnswers,
            },
          }),
        )
      }
      const finalDecision = cancelled ? 'cancel' : 'submit'
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
        id: approvalId,
        app: this.app,
        sessionId: entry.compositeId || '',
        decision: finalDecision,
      })
      return { resolved: true, id: approvalId, decision: finalDecision }
    }

    const allowed = decision === 'allow' || decision === 'accept' || decision === 'acceptForSession'
    if (entry.toolName === 'ExitPlanMode' && allowed && entry.sessionId) {
      const active = this.activeProcs.get(entry.sessionId)
      if (active?.taskTracker) {
        active.taskTracker.setMode(null, Date.now())
        active.emitTaskState?.()
      }
    }
    assertWritten(
      this.writeControlResponse(
        entry.proc,
        entry.requestId,
        allowed
          ? { behavior: 'allow', updatedInput: entry.toolInput || {} }
          : { behavior: 'deny', message: 'User denied tool execution' },
      ),
    )
    const finalDecision = allowed ? 'allow' : 'deny'
    this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
      id: approvalId,
      app: this.app,
      sessionId: entry.compositeId || '',
      decision: finalDecision,
    })
    return { resolved: true, id: approvalId, decision: finalDecision }
  }

  interrupt(sessionId) {
    const active = this.activeProcs.get(sessionId)
    if (!active) return { interrupted: false, sessionId }
    active.aborted = true
    const proc = active.proc
    if (!proc) return { interrupted: true, sessionId }
    this.clearPendingControlRequests(proc)
    try { proc.stdin?.end() } catch {}
    killProcessTree(proc, { force: false })
    if (proc.exitCode === null && proc.signalCode === null) {
      const killTimer = setTimeout(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) return
        killProcessTree(proc, { force: true })
      }, 2_000)
      killTimer.unref?.()
      proc.once('close', () => clearTimeout(killTimer))
    }
    return { interrupted: true, sessionId }
  }

  dispose() {
    for (const active of this.activeProcs.values()) {
      active.aborted = true
      if (active.inactivityTimer) {
        clearTimeout(active.inactivityTimer)
        active.inactivityTimer = null
      }
      try { active.cleanup?.() } catch {}
      if (active.proc) {
        try { this.clearPendingControlRequests(active.proc) } catch {}
        killProcessTree(active.proc, { force: true })
      }
    }
    this.activeProcs.clear()
    this.pendingControlRequests.clear()
  }
}
