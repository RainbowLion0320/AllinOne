import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { APPS, EVENTS, assertSafeSessionId, makeCompositeId, toEpochMs } from '../protocol.js'
import { mergeAndCompactMessages } from '../helpers/history-normalize.js'
import { findExecutable, getCodexCandidates, isExecutableFile } from '../helpers/bin-finder.js'
import {
  answersToElicitationContent,
  elicitationSchemaToQuestions,
  formatPermissionProfileDetail,
  normalizeResolvePayload,
  normalizeSingleAnswer,
} from '../helpers/interactive-schema.js'
import { createTaskStateTracker, normalizeTaskMode } from '../helpers/task-state.js'
import { BaseAdapter } from './base-adapter.js'
import { readTailLinesWithMeta, readTailLinesZeroOom } from '../primitives/io-utils.js'
import { JsonRpcStdioClient } from '../primitives/json-rpc-stdio.js'
import { BoundedLruMap } from '../primitives/lru.js'
import { QuotaCacheManager } from '../primitives/quota-cache.js'
import { SessionExternalWatcher } from '../primitives/session-watcher.js'

const CODEX_CLIENT_VERSION =
  (typeof __ALLINONE_VERSION__ === 'string' && __ALLINONE_VERSION__.trim()) || '0.0.0'
const CODEX_TURN_INACTIVITY_TIMEOUT_MS = 20 * 60_000
const MAX_PENDING_NEW_WRITERS = 4

const UNTRUSTED_CODEX_DIR_PREFIXES = [
  '/tmp/',
  '/private/tmp/',
  '/var/tmp/',
  '/private/var/tmp/',
  '/dev/shm/',
]

function isSafeCodexPathMode(statObj, currentUid) {
  // Always reject world-writable files or directories
  if ((statObj.mode & 0o002) !== 0) return false
  // For group-writable entries, allow Linux User Private Groups (UPG: uid == currentUid & gid == currentGid)
  // and macOS user-owned package dirs (e.g. Homebrew 0775 user:admin); reject shared/foreign group-writable paths.
  if ((statObj.mode & 0o020) !== 0) {
    const currentGid = typeof process.getgid === 'function' ? process.getgid() : -1
    const isLinuxUpg = statObj.uid === currentUid && currentGid >= 0 && statObj.gid === currentGid
    const isDarwinUserOwned = process.platform === 'darwin' && statObj.uid === currentUid
    if (!isLinuxUpg && !isDarwinUserOwned) return false
  }
  return true
}

function isTrustedCodexExecutable(candidate, currentUid) {
  if (!candidate || !isExecutableFile(candidate)) return false
  const lowerCand = candidate.toLowerCase()
  if (UNTRUSTED_CODEX_DIR_PREFIXES.some((prefix) => lowerCand.startsWith(prefix))) {
    return false
  }
  let realPath = ''
  try {
    realPath = realpathSync(candidate)
  } catch {
    return false
  }
  const lowerReal = realPath.toLowerCase()
  if (UNTRUSTED_CODEX_DIR_PREFIXES.some((prefix) => lowerReal.startsWith(prefix))) {
    return false
  }
  try {
    const st = statSync(realPath)
    if (!st.isFile()) return false
    if (st.uid !== currentUid && st.uid !== 0) return false
    if (!isSafeCodexPathMode(st, currentUid)) return false

    const parentDirs = new Set([dirname(realPath), dirname(candidate)])
    for (const dir of parentDirs) {
      const pSt = statSync(dir)
      if (pSt.uid !== currentUid && pSt.uid !== 0) return false
      if (!isSafeCodexPathMode(pSt, currentUid)) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Fallback discovery on macOS/Linux: if Codex Desktop / ChatGPT app is currently running
 * from a custom or newly reorganized app bundle path, extract the live `codex` binary path.
 */
function findRunningCodexBinary() {
  if (process.platform === 'win32') return null
  if (typeof process.getuid !== 'function') return null
  const uid = process.getuid()
  try {
    const out = execFileSync('ps', ['-u', String(uid), '-o', 'command='], {
      timeout: 1200,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const rawLine of out.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || !/codex/i.test(line)) continue
      // Match an absolute path ending with `/codex` followed by space + args (e.g. `app-server`, `exec-server`)
      const m = line.match(/^(\/[^\0\n]*?\/codex)(?:\s|$)/)
      if (m && m[1] && isTrustedCodexExecutable(m[1], uid)) {
        return m[1]
      }
    }
  } catch {}
  return null
}

function findCodexBinary(configuredBin) {
  const candidates = getCodexCandidates(undefined, process.platform, process.env, configuredBin)
  return (
    findExecutable(process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'], candidates) ||
    findRunningCodexBinary() ||
    'codex'
  )
}

function normalizeThreadSummary(t) {
  const title = (t.name && t.name.trim()) || (t.preview && t.preview.trim().slice(0, 56)) || t.id
  const cwd = typeof t.cwd === 'string' ? t.cwd : ''
  const rawStatus = typeof t.status === 'string'
    ? t.status
    : t.status?.type || 'idle'
  const isRunning = rawStatus === 'active' || rawStatus === 'running' || rawStatus === 'inProgress'

  return {
    id: makeCompositeId(APPS.CODEX, t.id),
    app: APPS.CODEX,
    nativeId: t.id,
    title,
    preview: (t.preview || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    cwd,
    workspace: cwd ? basename(cwd) : '',
    model: t.model || '',
    status: isRunning ? 'running' : 'idle',
    writable: true,
    createdAt: toEpochMs(t.createdAt),
    updatedAt: toEpochMs(t.updatedAt || t.recencyAt || t.createdAt),
  }
}

const CODEX_QUESTION_REPLY_RE = /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/i

/**
 * Parse a Codex `<send_user_message_question_reply>` user message payload.
 * Returns `{ entries: Array<{ callId, questionItemId, question, answer }>, callIds: Set<string> }` or `null`.
 */
export function parseCodexQuestionReply(rawText) {
  const text = String(rawText || '')
  const m = text.match(CODEX_QUESTION_REPLY_RE)
  if (!m) return null
  try {
    const arr = JSON.parse(m[1])
    if (!Array.isArray(arr) || arr.length === 0) return null
    const callIds = new Set()
    const entries = arr
      .filter((x) => x && typeof x === 'object')
      .map((x) => {
        let callId = ''
        if (typeof x.questionItemId === 'string') {
          try {
            const parsedId = JSON.parse(x.questionItemId)
            if (Array.isArray(parsedId) && typeof parsedId[1] === 'string') {
              callId = parsedId[1]
            }
          } catch {}
        }
        if (callId) callIds.add(callId)
        return {
          callId,
          questionItemId: String(x.questionItemId || ''),
          question: String(x.question || '').trim(),
          answer: String(x.answer ?? '').trim(),
        }
      })
    if (entries.length === 0) return null
    return { entries, callIds }
  } catch {
    return null
  }
}

/**
 * Format Codex `<send_user_message_question_reply>` XML/JSON blocks into clean, human-readable text.
 */
export function formatCodexQuestionReplyForDisplay(rawText) {
  const text = String(rawText || '')
  const parsed = parseCodexQuestionReply(text)
  if (!parsed) return text
  const remainder = text.replace(CODEX_QUESTION_REPLY_RE, '').trim()
  const formatted =
    parsed.entries.length === 1
      ? parsed.entries[0].answer
        ? `已选择：${parsed.entries[0].answer}`
        : '已跳过该问题'
      : parsed.entries
          .map((e) => {
            const ans = e.answer || '（已跳过）'
            return e.question ? `• ${e.question}：${ans}` : `• ${ans}`
          })
          .join('\n')
  return remainder ? `${formatted}\n\n${remainder}` : formatted
}

/**
 * Build Codex's native `<send_user_message_question_reply>` wire payload for `request_user_input_async`.
 */
export function buildCodexQuestionReplyText(callId, questions = [], answers = {}, { cancelled = false } = {}) {
  const entries = (Array.isArray(questions) ? questions : []).map((q, idx) => {
    const ans = cancelled ? { combined: [] } : normalizeSingleAnswer(answers[q.id])
    const answerText = cancelled ? '' : (ans.combined || []).join(', ').trim()
    return {
      questionItemId: JSON.stringify(['request_user_input_async', String(callId || ''), idx]),
      question: String(q.question || q.title || '').trim(),
      answer: answerText,
    }
  })
  return `<send_user_message_question_reply>\n${JSON.stringify(entries)}\n</send_user_message_question_reply>\n`
}

/**
 * Normalize a Codex `agentMessage` containing `questions` (from `request_user_input_async`)
 * into an All in One interactive prompt card.
 */
export function normalizeCodexAsyncQuestionCard(threadId, item, { externalRunning = false } = {}) {
  if (!threadId || !item || !Array.isArray(item.questions) || item.questions.length === 0) return null
  const callId = String(item.id || '').trim()
  if (!callId) return null
  const questions = item.questions
    .filter((q) => q && typeof q.title === 'string' && q.title.trim())
    .map((q, idx) => {
      const opts = Array.isArray(q.options)
        ? q.options
            .map((o) => (typeof o === 'string' ? o : o?.label || ''))
            .map((s) => String(s).trim())
            .filter(Boolean)
            .map((label) => ({ value: label, label, description: '' }))
        : []
      return {
        id: `q_${idx}`,
        header: '',
        question: q.title.trim(),
        description: '',
        multiSelect: false,
        allowOther: true,
        inputType: opts.length > 0 ? 'select' : 'text',
        required: true,
        options: opts,
      }
    })
  if (questions.length === 0) return null
  return {
    id: `cdx-aq-${callId}`,
    app: APPS.CODEX,
    sessionId: makeCompositeId(APPS.CODEX, threadId),
    kind: 'question',
    asyncQuestion: true,
    callId,
    title: 'ChatGPT 需要你做选择',
    detail: externalRunning
      ? '电脑端 ChatGPT 正在运行此轮：可直接去电脑端点击，或等待本轮暂停后在此提交。'
      : '',
    ...(externalRunning ? { readOnlyHint: 'desktop-running' } : {}),
    questions,
    createdAt: toEpochMs(item.completedAtMs || item.startedAtMs || Date.now()),
  }
}

/**
 * Scan the tail of a Codex rollout `.jsonl` file (zero-OOM) for an unanswered `request_user_input_async` item.
 */
export function extractPendingCodexAsyncQuestionFromRollout(rawPath, { tailBytes = 128 * 1024 } = {}) {
  const cleanPath = String(rawPath || '').replace(/^\\\\\?\\/, '').trim()
  if (!cleanPath || !cleanPath.toLowerCase().endsWith('.jsonl') || !existsSync(cleanPath)) {
    return null
  }
  try {
    const lines = readTailLinesZeroOom(cleanPath, tailBytes)
    if (!lines.length) return null

    const answeredCallIds = new Set()
    let latestItem = null
    for (const line of lines) {
      if (!line || line[0] !== '{') continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (obj.type === 'event_msg' && obj.payload?.type === 'item_completed') {
        const it = obj.payload.item
        if (!it || typeof it !== 'object') continue
        if (it.type === 'UserMessage') {
          const text = (Array.isArray(it.content) ? it.content : [])
            .map((c) => (c?.type === 'text' ? c.text || '' : ''))
            .join('\n')
          const reply = parseCodexQuestionReply(text)
          if (reply) {
            for (const cid of reply.callIds) answeredCallIds.add(cid)
            if (latestItem && reply.callIds.has(latestItem.id)) {
              latestItem = null
            }
          } else if (text.trim().length > 0) {
            // A subsequent normal user message supersedes earlier unanswered async prompts
            latestItem = null
          }
        } else if (it.type === 'AgentMessage' && Array.isArray(it.questions) && it.questions.length > 0 && it.id) {
          if (!answeredCallIds.has(String(it.id))) {
            latestItem = {
              id: String(it.id),
              questions: it.questions,
              startedAtMs: obj.payload.started_at_ms,
              completedAtMs: obj.payload.completed_at_ms,
            }
          }
        }
      }
    }
    return latestItem && !answeredCallIds.has(latestItem.id) ? latestItem : null
  } catch {
    return null
  }
}

/**
 * Zero-OOM tail-seek extractor for Codex rollout `.jsonl` plan steps, collaboration mode (`plan`/`default`),
 * and goal triggers. Safe on multi-GB rollouts.
 */
export function extractCodexTaskStateFromRollout(rawPath, { maxBytes = 512 * 1024, parseCache = null } = {}) {
  const cleanPath = String(rawPath || '').replace(/^\\\\\?\\/, '').trim()
  if (!cleanPath || !cleanPath.toLowerCase().endsWith('.jsonl') || !existsSync(cleanPath)) {
    return null
  }
  const parse = () => {
    const lines = readTailLinesZeroOom(cleanPath, maxBytes)
    if (!lines.length) return null

    const tracker = createTaskStateTracker()
    for (const line of lines) {
      if (!line || line[0] !== '{') continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const ts = toEpochMs(obj.timestamp || Date.now())
      if (obj.type === 'event_msg' && obj.payload && typeof obj.payload === 'object') {
        const p = obj.payload
        if (p.type === 'task_started') {
          tracker.applyCodexTurnMode(p.collaboration_mode_kind, p.turn_attribution?.turn_trigger, ts)
        } else if (p.type === 'plan_update') {
          tracker.applyCodexPlanUpdate(p, ts)
        } else if (p.type === 'item_completed' && p.item && (p.item.type === 'Plan' || p.item.type === 'plan')) {
          tracker.applyCodexPlanItem(p.item, ts)
        }
      } else if (obj.type === 'turn_context' && obj.payload && typeof obj.payload === 'object') {
        const modeKind = obj.payload.collaboration_mode_kind || obj.payload.collaboration_mode?.mode || ''
        if (modeKind) tracker.applyCodexTurnMode(modeKind, '', ts)
      } else if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
        const p = obj.payload
        if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.name === 'update_plan') {
          tracker.applyCodexPlanUpdate(p.arguments ?? p.input, ts)
        }
      }
    }
    return tracker.snapshot()
  }
  try {
    if (parseCache && typeof parseCache.getOrParse === 'function') {
      return parseCache.getOrParse(cleanPath, parse, { keyPrefix: `cdx-task:${maxBytes}` })
    }
    return parse()
  } catch {
    return null
  }
}

export function normalizeCodexTurns(turns = []) {
  const messages = []
  let milestoneEpoch = 0
  for (const turn of turns) {
    let currentAssistant = null
    const ensureAssistant = (ts, fallbackId) => {
      if (!currentAssistant) {
        currentAssistant = {
          id: fallbackId || `cdx-a-${turn.id}-${messages.length}`,
          role: 'assistant',
          text: '',
          thinking: '',
          tools: [],
          branchEpoch: milestoneEpoch,
          ts: toEpochMs(ts || turn.startedAt || Date.now()),
        }
        messages.push(currentAssistant)
      }
      return currentAssistant
    }

    for (const item of turn.items || []) {
      const ts = toEpochMs(item.startedAtMs || item.completedAtMs || turn.startedAt || Date.now())
      if (item.type === 'userMessage') {
        currentAssistant = null
        const images = []
        const text = (item.content || [])
          .map((c) => {
            if (c.type === 'text') return c.text || ''
            if (c.type === 'localImage') {
              if (c.path) images.push({ path: c.path, name: basename(c.path) })
              return ''
            }
            if (c.type === 'image') {
              const u = c.url || c.image_url || c.imageUrl || ''
              if (u) images.push({ url: u, name: 'image' })
              return ''
            }
            if (c.type === 'mention') return `@${c.name || c.path || ''}`
            return ''
          })
          .filter(Boolean)
          .join('\n')
        if (text.trim().length > 0 || images.length > 0) {
          messages.push({
            id: item.id || `cdx-u-${messages.length}`,
            role: 'user',
            text: formatCodexQuestionReplyForDisplay(text),
            ...(images.length > 0 ? { images } : {}),
            ts,
          })
        }
      } else if (item.type === 'imageView') {
        if (item.path) {
          const a = ensureAssistant(ts, item.id)
          a.ts = Math.max(a.ts || 0, ts)
          a.tools.push({
            id: item.id || `cdx-iv-${turn.id}-${a.tools.length}`,
            name: 'view_image',
            input: { path: item.path },
            status: 'completed',
            output: item.path,
          })
        }
      } else if (item.type === 'reasoning') {
        const a = ensureAssistant(ts, item.id)
        a.ts = Math.max(a.ts || 0, ts)
        const parts = [...(item.summary || []), ...(item.content || [])].filter(Boolean)
        if (parts.length > 0) {
          a.thinking = a.thinking ? `${a.thinking}\n${parts.join('\n')}` : parts.join('\n')
        }
      } else if (item.type === 'agentMessage') {
        const a = ensureAssistant(ts, item.id)
        if (item.text) {
          a.text = a.text ? `${a.text}\n\n${item.text}` : item.text
          a.ts = Math.max(a.ts || 0, ts)
          // Close this assistant milestone bubble so long autonomous multi-step runs render
          // each progress update chronologically with its preceding commands (matching Codex Desktop).
          milestoneEpoch += 1
          currentAssistant = null
        }
      } else if (item.type === 'commandExecution') {
        const a = ensureAssistant(ts)
        a.ts = Math.max(a.ts || 0, ts)
        a.tools.push({
          id: item.id,
          name: 'command',
          input: { command: item.command, cwd: item.cwd },
          status: item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'error' : 'running',
          output: (item.aggregatedOutput || '').slice(0, 3000),
        })
      } else if (item.type === 'fileChange') {
        const a = ensureAssistant(ts)
        a.ts = Math.max(a.ts || 0, ts)
        a.tools.push({
          id: item.id,
          name: 'file_change',
          input: { files: (item.changes || []).map((c) => c.path || c.file || 'file') },
          status: item.status === 'applied' || item.status === 'completed' ? 'completed' : 'running',
          output: `${(item.changes || []).length} 个文件变更`,
        })
      } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
        const a = ensureAssistant(ts)
        a.ts = Math.max(a.ts || 0, ts)
        a.tools.push({
          id: item.id,
          name: item.server ? `${item.server}.${item.tool}` : item.tool || 'tool',
          input: item.arguments ?? {},
          status: item.error ? 'error' : 'completed',
          output: item.error
            ? JSON.stringify(item.error)
            : item.result
              ? JSON.stringify(item.result).slice(0, 2000)
              : '',
        })
      } else if (item.type === 'webSearch') {
        const a = ensureAssistant(ts)
        a.ts = Math.max(a.ts || 0, ts)
        a.tools.push({
          id: item.id,
          name: 'web_search',
          input: { query: item.query || '' },
          status: 'completed',
          output: '',
        })
      }
    }
  }

  return messages.map((m) => {
    const out = { ...m }
    if (!out.thinking) delete out.thinking
    if (!out.tools || out.tools.length === 0) delete out.tools
    return out
  })
}

const CODEX_EXTERNAL_MAX_IDLE_MS = 20 * 60_000 // Ignore crashed/abandoned rollouts untouched for >20m
const CODEX_WATCH_POLL_INTERVAL_MS = 2_500
const CODEX_WATCH_TTL_MS = 10 * 60_000
const CODEX_TRACKED_LIST_TTL_MS = 30 * 60_000
const CODEX_MAX_WATCHED_SESSIONS = 8
const CODEX_TRACKED_LIST_LIMIT = 15
const CODEX_LIST_DISCOVERY_INTERVAL_MS = 15_000

const CODEX_TERMINAL_EVENT_TYPES = new Set([
  'task_complete',
  'turn_aborted',
  'turn_complete',
  'turn_failed',
])

const CODEX_METADATA_EVENT_TYPES = new Set([
  'thread_name_updated',
  'thread_name',
  'session_configured',
  'thread_rolled_back',
])

/**
 * Zero-OOM, sub-millisecond external running-state probe for Codex `.jsonl` rollout files.
 * Works accurately even on 8 GB+ rollouts and forked `parent_child.jsonl` files where an
 * independent `codex app-server` reader process always reports `status: { type: "notLoaded" }`.
 */
export function probeCodexRolloutStatus(
  rawPath,
  { now = Date.now(), maxIdleMs = CODEX_EXTERNAL_MAX_IDLE_MS, tailBytes = 64 * 1024 } = {},
) {
  const cleanPath = String(rawPath || '').replace(/^\\\\\?\\/, '').trim()
  if (!cleanPath || !cleanPath.toLowerCase().endsWith('.jsonl')) {
    return { exists: false, running: false, size: 0, mtimeMs: 0, lastEvent: '' }
  }
  let st
  try {
    st = statSync(cleanPath)
  } catch {
    return { exists: false, running: false, size: 0, mtimeMs: 0, lastEvent: '' }
  }
  const size = Number(st.size || 0)
  const mtimeMs = Number(st.mtimeMs || 0)
  if (size <= 0) {
    return { exists: true, running: false, size, mtimeMs, lastEvent: '' }
  }
  // Stale rollouts untouched beyond maxIdleMs are never running (prevents zombie inProgress after crashes)
  if (now - mtimeMs > maxIdleMs) {
    return { exists: true, running: false, size, mtimeMs, lastEvent: 'stale' }
  }

  try {
    const maxWindowBytes = Math.max(tailBytes, 512 * 1024)
    let windowBytes = tailBytes

    while (true) {
      const meta = readTailLinesWithMeta(cleanPath, windowBytes)
      if (!meta.exists) {
        return { exists: true, running: false, size, mtimeMs, lastEvent: '' }
      }
      const actualSize = meta.size || size
      const actualMtimeMs = meta.mtimeMs || mtimeMs
      const lines = meta.lines

      let sawActiveLine = false
      let lastEvent = ''
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]
        if (!line || line[0] !== '{') continue
        let obj
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        const topType = String(obj.type || '')
        const pType = String(obj.payload?.type || '')

        if (topType === 'event_msg') {
          if (CODEX_TERMINAL_EVENT_TYPES.has(pType)) {
            return { exists: true, running: false, size: actualSize, mtimeMs: actualMtimeMs, lastEvent: pType }
          }
          if (CODEX_METADATA_EVENT_TYPES.has(pType)) {
            continue
          }
          sawActiveLine = true
          lastEvent = pType || 'event_msg'
          break
        }

        if (topType === 'session_meta') {
          continue
        }

        if (topType === 'response_item' || topType === 'token_usage_record' || topType === 'turn_context') {
          sawActiveLine = true
          lastEvent = pType || topType
          break
        }
      }

      if (sawActiveLine) {
        return { exists: true, running: true, size: actualSize, mtimeMs: actualMtimeMs, lastEvent }
      }

      // If we hit a truncated >tailBytes line with no parsed event yet, expand window up to 512KB before treating as giant_item
      if (meta.truncated) {
        if (windowBytes < maxWindowBytes) {
          windowBytes = Math.min(maxWindowBytes, windowBytes * 2)
          continue
        }
        return { exists: true, running: true, size: actualSize, mtimeMs: actualMtimeMs, lastEvent: 'giant_item' }
      }

      return { exists: true, running: false, size: actualSize, mtimeMs: actualMtimeMs, lastEvent }
    }
  } catch {
    return { exists: true, running: false, size, mtimeMs, lastEvent: '' }
  }
}

/**
 * Zero-OOM tail-seek fallback for giant / legacy Codex JSONL rollout files (even >2 GB)
 * when `codex app-server` fails to deserialize an older stored thread item across CLI upgrades.
 * Reads ONLY the tail `maxBytes` (default 2 MB) directly from disk in <5 ms.
 */
export function readCodexRolloutTail(rawPath, { maxBytes = 2 * 1024 * 1024, limit = 14, parseCache = null } = {}) {
  const cleanPath = String(rawPath || '').replace(/^\\\\\?\\/, '').trim()
  if (!cleanPath || !cleanPath.toLowerCase().endsWith('.jsonl') || !existsSync(cleanPath)) {
    return []
  }
  const sliceLen = Math.max(6, Math.min(Number(limit) || 14, 30))
  const parse = () => {
    const lines = readTailLinesZeroOom(cleanPath, maxBytes)
    if (!lines.length) return []

    const messages = []
    let milestoneEpoch = 0
    let currentAssistant = null
    const ensureAssistant = (ts, idHint) => {
      if (!currentAssistant) {
        currentAssistant = {
          id: idHint || `cdx-tail-a-${messages.length}`,
          role: 'assistant',
          text: '',
          thinking: '',
          tools: [],
          branchEpoch: milestoneEpoch,
          ts: toEpochMs(ts || Date.now()),
        }
        messages.push(currentAssistant)
      }
      return currentAssistant
    }

    for (const line of lines) {
      if (!line || line[0] !== '{') continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const ts = toEpochMs(obj.timestamp || Date.now())
      if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
        const p = obj.payload
        if (p.type === 'message') {
          const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : ''
          if (!role) continue
          const text = (Array.isArray(p.content) ? p.content : [])
            .map((c) => (c?.type === 'output_text' || c?.type === 'input_text' || c?.type === 'text' ? c.text || '' : ''))
            .filter(Boolean)
            .join('\n')
            .trim()
          if (!text) continue
          if (role === 'user') {
            currentAssistant = null
            messages.push({
              id: p.id || `cdx-tail-u-${messages.length}`,
              role: 'user',
              text: formatCodexQuestionReplyForDisplay(text),
              ts,
            })
          } else {
            const a = ensureAssistant(ts, p.id)
            a.text = a.text ? `${a.text}\n\n${text}` : text
            a.ts = ts
            milestoneEpoch += 1
            currentAssistant = null
          }
        } else if (p.type === 'reasoning') {
          const summaries = (Array.isArray(p.summary) ? p.summary : [])
            .map((s) => (typeof s === 'string' ? s : s?.text || ''))
            .filter(Boolean)
          if (summaries.length > 0) {
            const a = ensureAssistant(ts, p.id)
            a.thinking = a.thinking ? `${a.thinking}\n${summaries.join('\n')}` : summaries.join('\n')
          }
        } else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
          const a = ensureAssistant(ts, p.call_id || p.id)
          a.tools.push({
            id: p.call_id || p.id || `cdx-tail-t-${a.tools.length}`,
            name: p.name || (p.type === 'local_shell_call' ? 'command' : 'tool'),
            input: p.input ?? p.arguments ?? p.action ?? {},
            status: 'completed',
            output: '',
          })
        }
      } else if (obj.type === 'event_msg' && obj.payload?.type === 'agent_message' && obj.payload?.message) {
        const a = ensureAssistant(ts)
        a.text = a.text ? `${a.text}\n\n${obj.payload.message}` : String(obj.payload.message)
        a.ts = ts
        milestoneEpoch += 1
        currentAssistant = null
      }
    }

    const compacted = mergeAndCompactMessages(messages)
    return compacted.slice(-sliceLen)
  }
  try {
    if (parseCache && typeof parseCache.getOrParse === 'function') {
      return parseCache.getOrParse(cleanPath, parse, { keyPrefix: `cdx-tail:${maxBytes}:${sliceLen}` })
    }
    return parse()
  } catch {
    return []
  }
}

/**
 * Thin Codex `app-server --stdio` client built on shared `JsonRpcStdioClient`.
 * Used in two distinct roles: persistent read-only `reader` and short-lived per-thread `writer`.
 */
class CodexRpcClient {
  constructor({ codexBin, log = console, label = 'codex', onServerRequest, onNotification, onExit }) {
    this.codexBin = codexBin
    this.log = log
    this.label = label
    this.onServerRequest = onServerRequest || null
    this.onNotification = onNotification || null
    this.onExit = onExit || null
    this.readyPromise = null
    this.transport = null
  }

  get proc() {
    return this.transport?.proc || null
  }

  get closing() {
    return Boolean(this.transport?.closing)
  }

  async ensureStarted() {
    if (this.transport?.isAlive() && this.readyPromise) {
      return this.readyPromise
    }
    const transport = new JsonRpcStdioClient({
      bin: this.codexBin,
      args: ['app-server', '--stdio'],
      label: `codex(${this.label})`,
      maxStderrChars: 1200,
      log: this.log,
      onServerRequest: (_t, msg) => this.onServerRequest?.(this, msg),
      onNotification: (method, params) => this.onNotification?.(method, params),
      onStderrChunk: (text) => {
        const line = text.trim()
        if (line) this.log.debug?.(`[codex-${this.label}] ${line}`)
      },
      onExit: ({ error }) => {
        if (this.transport === transport) {
          this.readyPromise = null
        }
        try {
          this.onExit?.(error, this)
        } catch (cbErr) {
          this.log.error?.(`mobile-hub: codex(${this.label}) onExit error: ${String(cbErr)}`)
        }
      },
    })
    this.transport = transport

    const ready = (async () => {
      transport.spawnProcess()
      const initClientInfo = { name: 'allinone-dsh-mobile', version: CODEX_CLIENT_VERSION }
      let res
      try {
        res = await transport.callRaw('initialize', {
          clientInfo: initClientInfo,
          capabilities: { experimentalApi: true },
        })
      } catch (firstErr) {
        if (this.transport !== transport || transport.closing) throw firstErr
        res = await transport.callRaw('initialize', {
          clientInfo: initClientInfo,
          capabilities: null,
        })
      }
      if (this.transport !== transport || !transport.isAlive()) {
        throw new Error(`codex(${this.label}) closed during initialization`)
      }
      transport.notify('initialized', {})
      return res
    })().catch((err) => {
      transport.killImmediate(String(err?.message || err))
      if (this.transport === transport) {
        this.readyPromise = null
      }
      throw err
    })

    this.readyPromise = ready
    return ready
  }

  sendRaw(msg) {
    if (!this.transport) throw new Error(`codex(${this.label}) is not running`)
    this.transport.sendRaw(msg)
  }

  async rpc(method, params = {}, timeoutMs = 45_000) {
    await this.ensureStarted()
    return this.transport.callRaw(method, params, timeoutMs)
  }

  async closeGracefully() {
    this.readyPromise = null
    if (this.transport) {
      await this.transport.closeGracefully({ graceMs: 600, forceAfterMs: 500 })
    }
  }

  killImmediate() {
    this.readyPromise = null
    this.transport?.killImmediate(`codex(${this.label}) disposed`)
  }
}

const CODEX_QUOTA_CACHE_TTL_MS = 45_000

/**
 * Normalize Codex subscription rate-limit snapshot (from official `account/rateLimits/read` RPC
 * or rollout `rate_limits` payload) into a uniform E2EE quota descriptor.
 * Picks the weekly window (`windowDurationMins >= 1440`, e.g. 10080 = 7d) as the primary metric
 * and preserves any shorter rolling window (e.g. 5h = 300m on Plus/Team) in `shortWindow`.
 */
export function normalizeCodexQuota(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null
  const rl = raw.rateLimits || raw.rate_limits || raw.rateLimitsByLimitId?.codex || raw
  if (!rl || typeof rl !== 'object') return null

  const parseWindow = (w) => {
    if (!w || typeof w !== 'object') return null
    const rawUsed = w.usedPercent ?? w.used_percent
    if (typeof rawUsed !== 'number' || !Number.isFinite(rawUsed)) return null
    const usedPercent = Math.max(0, Math.min(100, Math.round(rawUsed)))
    const windowMinutes = Number(w.windowDurationMins ?? w.window_minutes ?? 0) || 0
    const resetsAt = toEpochMs(w.resetsAt ?? w.resets_at ?? 0)
    return {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowMinutes,
      resetsAt,
    }
  }

  const windows = [parseWindow(rl.primary), parseWindow(rl.secondary)].filter(Boolean)
  if (windows.length === 0) return null

  // Prefer the 7-day / weekly window (>= 24h) as primary display metric
  const weekly = windows.find((w) => w.windowMinutes >= 1440) || null
  const rawShorter = windows.find((w) => w !== weekly && w.windowMinutes > 0 && w.windowMinutes < 1440) || null
  const shorter = rawShorter && !(rawShorter.resetsAt > 0 && now > rawShorter.resetsAt + 60_000) ? rawShorter : null
  const chosen = weekly || shorter || windows[0]
  if (!chosen) return null

  // Ignore clearly expired cached windows (only when no newer live snapshot)
  if (chosen.resetsAt > 0 && now > chosen.resetsAt + 60_000) {
    return null
  }

  const planType = String(rl.planType || rl.plan_type || '').trim().toLowerCase()

  // Optional extra credit balance (e.g. Pro / enterprise top-up credits)
  let extraCredits = null
  const rawCredits = rl.credits
  if (rawCredits && typeof rawCredits === 'object' && (rawCredits.hasCredits || rawCredits.unlimited)) {
    const rawBal = Number(rawCredits.balance)
    if (rawCredits.unlimited) {
      extraCredits = { unlimited: true, balance: null }
    } else if (Number.isFinite(rawBal) && rawBal > 0) {
      extraCredits = { unlimited: false, balance: Math.round(rawBal * 10) / 10 }
    }
  }

  // Optional free rate-limit reset credits (e.g. Codex Pro "Full reset" vouchers)
  let resetCredits = null
  const rawResetCredits = raw.rateLimitResetCredits || raw.rate_limit_reset_credits
  if (rawResetCredits && typeof rawResetCredits === 'object') {
    const availList = Array.isArray(rawResetCredits.credits)
      ? rawResetCredits.credits.filter((c) => c && String(c.status || '').toLowerCase() === 'available')
      : []
    const availableCount = Math.max(
      Number(rawResetCredits.availableCount ?? rawResetCredits.available_count ?? 0) || 0,
      availList.length,
    )
    if (availableCount > 0) {
      const expiries = availList
        .map((c) => toEpochMs(c.expiresAt ?? c.expires_at ?? 0))
        .filter((ts) => ts > now)
        .sort((a, b) => a - b)
      resetCredits = {
        availableCount,
        ...(expiries[0] ? { nextExpiresAt: expiries[0] } : {}),
      }
    }
  }

  // Optional secondary rate-limit pools from `rateLimitsByLimitId` (e.g. model-specific pools beyond `codex`)
  const extraPools = []
  const byLimitId = raw.rateLimitsByLimitId || raw.rate_limits_by_limit_id
  if (byLimitId && typeof byLimitId === 'object') {
    const mainId = String(rl.limitId || rl.limit_id || 'codex').trim().toLowerCase()
    for (const [id, entry] of Object.entries(byLimitId)) {
      if (!entry || typeof entry !== 'object') continue
      if (String(id).trim().toLowerCase() === mainId) continue
      const ew = [parseWindow(entry.primary), parseWindow(entry.secondary)]
        .filter(Boolean)
        .filter((w) => !(w.resetsAt > 0 && now > w.resetsAt + 60_000))
      if (ew.length === 0) continue
      ew.sort((a, b) => (a.windowMinutes || 999999) - (b.windowMinutes || 999999))
      const poolLabel = String(entry.limitName || entry.limit_name || entry.normalModelSlug || id).trim()
      extraPools.push({
        id: String(id),
        label: poolLabel,
        labelZh: poolLabel,
        windows: ew.map((w) => ({
          id: w.windowMinutes >= 1440 ? 'weekly' : 'short',
          kind: w.windowMinutes >= 1440 ? 'weekly' : 'short',
          ...w,
        })),
      })
    }
  }

  return {
    remainingPercent: chosen.remainingPercent,
    usedPercent: chosen.usedPercent,
    windowKind: chosen.windowMinutes >= 1440 ? 'weekly' : 'session',
    windowMinutes: chosen.windowMinutes,
    resetsAt: chosen.resetsAt,
    ...(planType ? { planType } : {}),
    ...(shorter
      ? {
          shortWindow: {
            remainingPercent: shorter.remainingPercent,
            usedPercent: shorter.usedPercent,
            windowMinutes: shorter.windowMinutes,
            resetsAt: shorter.resetsAt,
          },
        }
      : {}),
    ...(extraPools.length > 0
      ? {
          pools: [
            {
              id: 'codex',
              label: 'ChatGPT',
              labelZh: 'ChatGPT 主额度',
              windows: [
                ...(shorter ? [{ id: 'short', kind: 'short', ...shorter }] : []),
                {
                  id: chosen.windowMinutes >= 1440 ? 'weekly' : 'short',
                  kind: chosen.windowMinutes >= 1440 ? 'weekly' : 'short',
                  ...chosen,
                },
              ],
            },
            ...extraPools,
          ],
        }
      : {}),
    ...(extraCredits ? { extraCredits } : {}),
    ...(resetCredits ? { resetCredits } : {}),
    updatedAt: now,
  }
}

/**
 * Official Codex Adapter using:
 *  - Persistent read-only `codex app-server --stdio` for 3ms thread listing, pagination & model discovery
 *  - Auto-releasing per-thread writer process that gracefully shuts down after each turn completes,
 *    ensuring Codex Desktop on PC NEVER gets stuck on "已在另一个应用中打开"!
 */
export class CodexAdapter extends BaseAdapter {
  constructor({ config = {}, log = console, emitEvent, onApprovalRequest }) {
    super(APPS.CODEX, {
      config,
      log,
      emitEvent,
      onApprovalRequest,
      capabilities: {
        supportsApproval: true,
        supportsMidChatSwitch: true,
        supportsQuota: true,
      },
    })
    this.configuredBin = config.codexBin
    this.codexBin = findCodexBinary(this.configuredBin)
    this.defaultCwd = config.cwd || process.cwd()

    this.reader = new CodexRpcClient({
      codexBin: this.codexBin,
      log: this.log,
      label: 'reader',
      onNotification: (method, params) => {
        if (method === 'account/rateLimits/updated' && params) {
          const parsed = normalizeCodexQuota(params)
          if (parsed) {
            this.quotaManager.set(parsed, { persist: false, emit: true })
          }
        }
      },
    })
    this.activeTurns = new Map() // threadId -> { writer, turnId, resolve, reject, textBuffer, aborted, settled, touchActivity }
    this.releasingWriters = new Map() // threadId -> Promise<void> (in-flight writer release before next thread/resume)
    this.releasingWriterClients = new Set() // live writer instances mid-release so dispose() can force-kill them
    this.pendingNewWriters = new Map() // threadId -> { writer, summary, timer } (bounded to MAX_PENDING_NEW_WRITERS)
    this.pendingServerRequests = new Map() // approvalId -> { writer, rpcId, method, threadId }
    this.dismissedAsyncQuestions = new BoundedLruMap(256)
    this.answeredAsyncQuestions = new BoundedLruMap(256)
    this.sessionModes = new BoundedLruMap(256)
    this.modelsCache = null
    this.modelsCacheAt = 0
    this.watchPollIntervalMs = Math.max(200, Number(config.watchPollIntervalMs) || CODEX_WATCH_POLL_INTERVAL_MS)
    this.externalMaxIdleMs = Math.max(1000, Number(config.codexExternalMaxIdleMs) || CODEX_EXTERNAL_MAX_IDLE_MS)
    this.lastListDiscoveryAt = 0
    this.quotaManager = new QuotaCacheManager({
      app: APPS.CODEX,
      ttlMs: CODEX_QUOTA_CACHE_TTL_MS,
      errorBackoffMs: 15_000,
      emitEvent: this.emitEvent,
      fetcher: async () => {
        const now = Date.now()
        const res = await this.rpc('account/rateLimits/read', {}, 5_000)
        return normalizeCodexQuota(res, now)
      },
    })
    this.watcher = new SessionExternalWatcher({
      pollMs: this.watchPollIntervalMs,
      maxWatched: CODEX_MAX_WATCHED_SESSIONS,
      maxTracked: CODEX_TRACKED_LIST_LIMIT,
      watchTtlMs: CODEX_WATCH_TTL_MS,
      listWatchTtlMs: CODEX_TRACKED_LIST_TTL_MS,
      onPoll: (ctx) => this._pollExternalSessions(ctx),
    })
    this.watchedSessions = this.watcher.watched
    this.trackedListSessions = this.watcher.tracked
  }

  get quotaCache() {
    return this.quotaManager.quota
  }

  set quotaCache(val) {
    this.quotaManager.quota = val
  }

  get quotaCacheAt() {
    return this.quotaManager.fetchedAt
  }

  set quotaCacheAt(val) {
    this.quotaManager.fetchedAt = Number(val) || 0
  }

  get lastClientListAt() {
    return this.watcher.lastClientListAt
  }

  set lastClientListAt(val) {
    this.watcher.lastClientListAt = Number(val) || 0
  }

  refreshBinary() {
    this.codexBin = findCodexBinary(this.configuredBin)
    if (this.reader) {
      this.reader.codexBin = this.codexBin
    }
    this.modelsCache = null
    this.modelsCacheAt = 0
    return this.codexBin
  }

  /** Read-only RPC via persistent reader daemon (never acquires write locks). */
  async rpc(method, params = {}, timeoutMs = 45_000) {
    return this.reader.rpc(method, params, timeoutMs)
  }

  createWriter(threadHint = 'writer') {
    const writer = new CodexRpcClient({
      codexBin: this.codexBin,
      log: this.log,
      label: `w-${String(threadHint).slice(0, 8)}`,
      onServerRequest: (reqWriter, msg) => this.handleServerRequest(reqWriter, msg),
      onNotification: (method, params) => this.handleNotification(method, params),
      onExit: (err, exitedClient) => {
        const targetWriter = exitedClient || writer
        // Fail any active turn bound to this writer if it crashed unexpectedly
        // (STREAM_ERROR is emitted once in sendMessage's catch block to avoid duplicate error events)
        for (const [_tid, active] of this.activeTurns.entries()) {
          if (active.writer === targetWriter && !targetWriter.closing && !active.settled) {
            active.settled = true
            active.reject(err)
          }
        }
      },
    })
    return writer
  }

  async releaseWriter(writer, threadId) {
    if (!writer) return
    this.releasingWriterClients.add(writer)
    try {
      if (threadId && writer.proc && !writer.proc.killed && !this.disposed) {
        await writer.rpc('thread/unsubscribe', { threadId }, 3_000).catch(() => {})
      }
      await writer.closeGracefully().catch(() => {})
    } finally {
      this.releasingWriterClients.delete(writer)
    }
  }

  async listModels() {
    if (this.modelsCache && Date.now() - this.modelsCacheAt < 5 * 60_000) {
      return this.modelsCache
    }
    const res = await this.rpc('model/list', {})
    const raw = res?.data || res?.models || []
    let defaultModel = ''
    let defaultEffort = ''
    const models = raw.map((m) => {
      const id = m.id || m.model || ''
      const efforts = (m.supportedReasoningEfforts || m.reasoningEfforts || [])
        .map((e) => (typeof e === 'string' ? e : e?.reasoningEffort))
        .filter(Boolean)
      const defEff = m.defaultReasoningEffort || efforts[0] || ''
      if (m.isDefault) {
        defaultModel = id
        defaultEffort = defEff
      }
      return {
        id,
        name: m.displayName || m.name || id,
        efforts,
        defaultEffort: defEff,
        isDefault: Boolean(m.isDefault),
      }
    })
    if (!defaultModel && models[0]) {
      defaultModel = models[0].id
      defaultEffort = models[0].defaultEffort
    }
    this.modelsCache = {
      app: APPS.CODEX,
      defaultModel,
      defaultEffort,
      supportsMidChatSwitch: true,
      models,
    }
    this.modelsCacheAt = Date.now()
    return this.modelsCache
  }

  handleServerRequest(writer, msg) {
    const method = msg.method
    const params = msg.params || {}
    const threadId = params.threadId || params.conversationId || ''
    if (threadId) {
      this.activeTurns.get(threadId)?.touchActivity?.()
    }
    const approvalId = `cdx-apr-${randomUUID().slice(0, 10)}`

    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'execCommandApproval' ||
      method === 'applyPatchApproval'
    ) {
      this.pendingServerRequests.set(approvalId, {
        writer,
        rpcId: msg.id,
        method,
        threadId,
        params,
      })

      const isCommand = method.includes('command') || method.includes('Command')
      const summary = isCommand
        ? params.command || (Array.isArray(params.commandArgs) ? params.commandArgs.join(' ') : '执行终端命令')
        : params.reason || '修改工作区文件'

      const request = {
        id: approvalId,
        app: APPS.CODEX,
        sessionId: threadId ? makeCompositeId(APPS.CODEX, threadId) : '',
        kind: isCommand ? 'command' : 'file_change',
        title: isCommand ? 'ChatGPT 请求执行命令' : 'ChatGPT 请求修改文件',
        detail: summary,
        cwd: params.cwd || '',
        createdAt: Date.now(),
        options: [
          { value: 'accept', label: '允许一次', style: 'primary' },
          { value: 'acceptForSession', label: '本会话自动允许', style: 'secondary' },
          { value: 'decline', label: '拒绝', style: 'danger' },
        ],
      }
      this.onApprovalRequest(request)
      return
    }

    if (method === 'item/tool/requestUserInput') {
      const qId = `cdx-q-${randomUUID().slice(0, 10)}`
      const rawQuestions = Array.isArray(params.questions) ? params.questions : []
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
          description: '',
          multiSelect: false,
          allowOther: q?.isOther !== false || opts.length === 0,
          isSecret: Boolean(q?.isSecret),
          inputType: opts.length > 0 ? 'select' : 'text',
          required: true,
          options: opts,
        }
      })

      this.pendingServerRequests.set(qId, {
        writer,
        rpcId: msg.id,
        method,
        threadId,
        params,
        questions,
      })

      this.onApprovalRequest({
        id: qId,
        app: APPS.CODEX,
        sessionId: threadId ? makeCompositeId(APPS.CODEX, threadId) : '',
        kind: 'question',
        title: 'ChatGPT 需要你做选择',
        detail: '',
        questions,
        createdAt: Date.now(),
      })
      return
    }

    if (method === 'item/permissions/requestApproval') {
      const permId = `cdx-perm-${randomUUID().slice(0, 10)}`
      this.pendingServerRequests.set(permId, {
        writer,
        rpcId: msg.id,
        method,
        threadId,
        params,
      })

      this.onApprovalRequest({
        id: permId,
        app: APPS.CODEX,
        sessionId: threadId ? makeCompositeId(APPS.CODEX, threadId) : '',
        kind: 'permissions',
        title: 'ChatGPT 请求附加权限',
        detail: formatPermissionProfileDetail(params.permissions, params.reason),
        cwd: params.cwd || '',
        createdAt: Date.now(),
        options: [
          { value: 'accept', label: '允许一次', style: 'primary' },
          { value: 'acceptForSession', label: '本会话自动允许', style: 'secondary' },
          { value: 'decline', label: '拒绝', style: 'danger' },
        ],
      })
      return
    }

    if (method === 'mcpServer/elicitation/request') {
      const elicitId = `cdx-elicit-${randomUUID().slice(0, 10)}`
      const isUrlMode = params.mode === 'url'
      const questions = isUrlMode
        ? []
        : elicitationSchemaToQuestions(params.requestedSchema, params.message || '请填写所需信息')

      this.pendingServerRequests.set(elicitId, {
        writer,
        rpcId: msg.id,
        method,
        threadId,
        params,
        questions,
      })

      this.onApprovalRequest({
        id: elicitId,
        app: APPS.CODEX,
        sessionId: threadId ? makeCompositeId(APPS.CODEX, threadId) : '',
        kind: isUrlMode ? 'url_elicitation' : 'question',
        title: params.serverName ? `ChatGPT · ${params.serverName}` : 'ChatGPT 请求补充信息',
        detail: String(params.message || '').trim(),
        ...(isUrlMode && params.url ? { url: String(params.url) } : {}),
        ...(isUrlMode
          ? {
              options: [
                { value: 'accept', label: '确认继续', style: 'primary' },
                { value: 'decline', label: '拒绝', style: 'danger' },
              ],
            }
          : { questions }),
        createdAt: Date.now(),
      })
      return
    }

    try {
      writer.sendRaw({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unsupported client serverRequest: ${method}` },
      })
    } catch {}
  }

  registerAsyncQuestionPrompt(threadId, item, { externalRunning = false, cwd = '' } = {}) {
    const card = normalizeCodexAsyncQuestionCard(threadId, item, { externalRunning })
    if (!card) return null
    if (this.dismissedAsyncQuestions.has(card.callId) || this.answeredAsyncQuestions.has(card.callId)) {
      return null
    }
    // Dismiss any older async question cards on the same thread
    this.clearAsyncQuestionsForThread(threadId, { keepCallId: card.callId, decision: 'superseded' })
    const existing = this.pendingServerRequests.get(card.id)
    const nextHint = card.readOnlyHint || ''
    if (existing && existing.method === 'codex/asyncQuestion' && (existing.readOnlyHint || '') === nextHint) {
      if (cwd && !existing.cwd) existing.cwd = cwd
      return card
    }
    this.pendingServerRequests.set(card.id, {
      writer: null,
      rpcId: null,
      method: 'codex/asyncQuestion',
      threadId,
      callId: card.callId,
      cwd: cwd || existing?.cwd || '',
      questions: card.questions,
      readOnlyHint: nextHint,
    })
    this.onApprovalRequest(card)
    return card
  }

  clearAsyncQuestionsForThread(threadId, { keepCallId = '', decision = 'desktop' } = {}) {
    const sessionId = threadId ? makeCompositeId(APPS.CODEX, threadId) : ''
    for (const [aprId, entry] of [...this.pendingServerRequests.entries()]) {
      if (entry.method !== 'codex/asyncQuestion' || entry.threadId !== threadId) continue
      if (keepCallId && entry.callId === keepCallId) continue
      this.pendingServerRequests.delete(aprId)
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, { id: aprId, app: APPS.CODEX, sessionId, decision })
    }
  }

  syncAsyncQuestionFromTurns(threadId, turns = [], { externalRunning = false, cwd = '' } = {}) {
    const answeredCallIds = new Set()
    let latestItem = null
    for (const turn of turns || []) {
      for (const item of turn?.items || []) {
        if (!item || typeof item !== 'object') continue
        if (item.type === 'userMessage') {
          const text = (Array.isArray(item.content) ? item.content : [])
            .map((c) => (c?.type === 'text' ? c.text || '' : ''))
            .join('\n')
          const reply = parseCodexQuestionReply(text)
          if (reply) {
            for (const cid of reply.callIds) answeredCallIds.add(cid)
            if (latestItem && reply.callIds.has(String(latestItem.id || ''))) {
              latestItem = null
            }
          } else if (text.trim().length > 0) {
            latestItem = null
          }
        } else if (item.type === 'agentMessage' && Array.isArray(item.questions) && item.questions.length > 0 && item.id) {
          const cid = String(item.id)
          if (!answeredCallIds.has(cid)) {
            latestItem = item
          }
        }
      }
    }
    if (latestItem && !answeredCallIds.has(String(latestItem.id))) {
      this.registerAsyncQuestionPrompt(threadId, latestItem, { externalRunning, cwd })
    } else {
      this.clearAsyncQuestionsForThread(threadId, { decision: 'desktop' })
    }
  }

  async resolveApproval(approvalId, decisionOrPayload) {
    const entry = this.pendingServerRequests.get(approvalId)
    if (!entry) return { resolved: false, reason: 'approval not found' }
    this.pendingServerRequests.delete(approvalId)

    const sessionId = entry.threadId ? makeCompositeId(APPS.CODEX, entry.threadId) : ''
    if (entry.threadId) {
      this.activeTurns.get(entry.threadId)?.touchActivity?.()
    }
    const { decision, answers } = normalizeResolvePayload(decisionOrPayload)

    if (entry.method === 'codex/asyncQuestion') {
      const cancelled = decision === 'cancel' || decision === 'decline'
      const active = this.activeTurns.get(entry.threadId)
      if (active && active.writer && active.turnId && !active.settled) {
        const replyText = buildCodexQuestionReplyText(entry.callId, entry.questions, answers, { cancelled })
        try {
          await active.writer.rpc(
            'turn/steer',
            {
              threadId: entry.threadId,
              expectedTurnId: active.turnId,
              input: [{ type: 'text', text: replyText, text_elements: [] }],
            },
            15_000,
          )
        } catch (err) {
          this.pendingServerRequests.set(approvalId, entry)
          throw err
        }
        this.answeredAsyncQuestions.set(entry.callId, true)
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: approvalId,
          app: APPS.CODEX,
          sessionId,
          decision: cancelled ? 'cancel' : 'submit',
        })
        return { resolved: true, id: approvalId, decision: cancelled ? 'cancel' : 'submit', steered: true }
      }

      if (cancelled) {
        this.dismissedAsyncQuestions.set(entry.callId, true)
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: approvalId,
          app: APPS.CODEX,
          sessionId,
          decision: 'cancel',
        })
        return { resolved: true, id: approvalId, decision: 'cancel' }
      }

      const watched = this.watchedSessions.get(entry.threadId) || this.trackedListSessions.get(entry.threadId)
      if (watched?.path) {
        const cur = probeCodexRolloutStatus(watched.path, { maxIdleMs: this.externalMaxIdleMs })
        if (cur.running) {
          this.pendingServerRequests.set(approvalId, entry)
          throw new Error('电脑端 ChatGPT 正在运行此轮，请直接在电脑端点击选项，或等本轮暂停后再在手机端提交。')
        }
      }

      this.answeredAsyncQuestions.set(entry.callId, true)
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
        id: approvalId,
        app: APPS.CODEX,
        sessionId,
        decision: 'submit',
      })
      const replyText = buildCodexQuestionReplyText(entry.callId, entry.questions, answers, { cancelled: false })
      void this.sendMessage(entry.threadId, {
        text: replyText,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
      }).catch((err) => {
        this.log.warn?.(`codex: async question follow-up sendMessage failed: ${String(err?.message || err)}`)
      })
      return { resolved: true, id: approvalId, decision: 'submit', steered: false }
    }

    const sendApprovalReply = (payloadObj) => {
      try {
        entry.writer.sendRaw(payloadObj)
      } catch (err) {
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: approvalId,
          app: APPS.CODEX,
          sessionId,
          decision: 'cancel',
        })
        const transportErr = new Error(String(err?.message || 'ChatGPT 进程已退出，审批请求已失效'))
        transportErr.code = 'APPROVAL_TRANSPORT_CLOSED'
        throw transportErr
      }
    }

    if (entry.method === 'item/tool/requestUserInput') {
      const cancelled = decision === 'cancel' || decision === 'decline'
      const responseAnswers = {}
      if (!cancelled) {
        for (const q of entry.questions || []) {
          const ans = normalizeSingleAnswer(answers[q.id])
          responseAnswers[q.id] = { answers: ans.combined }
        }
      }
      sendApprovalReply({
        jsonrpc: '2.0',
        id: entry.rpcId,
        result: { answers: responseAnswers },
      })
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
        id: approvalId,
        app: APPS.CODEX,
        sessionId,
        decision: cancelled ? 'cancel' : 'submit',
      })
      return { resolved: true, id: approvalId, decision: cancelled ? 'cancel' : 'submit' }
    }

    if (entry.method === 'item/permissions/requestApproval') {
      const accepted = decision === 'accept' || decision === 'acceptForSession'
      const scope = decision === 'acceptForSession' ? 'session' : 'turn'
      sendApprovalReply({
        jsonrpc: '2.0',
        id: entry.rpcId,
        result: {
          permissions: accepted ? (entry.params?.permissions || {}) : {},
          scope,
        },
      })
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
        id: approvalId,
        app: APPS.CODEX,
        sessionId,
        decision: accepted ? decision : 'decline',
      })
      return { resolved: true, id: approvalId, decision: accepted ? decision : 'decline' }
    }

    if (entry.method === 'mcpServer/elicitation/request') {
      const action = decision === 'decline' ? 'decline' : decision === 'cancel' ? 'cancel' : 'accept'
      const result = action === 'accept'
        ? entry.params?.mode === 'url'
          ? { action: 'accept' }
          : { action: 'accept', content: answersToElicitationContent(entry.params?.requestedSchema, answers) }
        : { action }
      sendApprovalReply({
        jsonrpc: '2.0',
        id: entry.rpcId,
        result,
      })
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
        id: approvalId,
        app: APPS.CODEX,
        sessionId,
        decision: action,
      })
      return { resolved: true, id: approvalId, decision: action }
    }

    const validDecision = ['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)
      ? decision
      : 'decline'

    sendApprovalReply({
      jsonrpc: '2.0',
      id: entry.rpcId,
      result: { decision: validDecision },
    })

    this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
      id: approvalId,
      app: APPS.CODEX,
      sessionId,
      decision: validDecision,
    })
    return { resolved: true, id: approvalId, decision: validDecision }
  }

  emitTaskStateIfChanged(threadId, tracker) {
    if (!threadId || !tracker) return
    const diff = tracker.consumeChanged()
    if (!diff.changed) return
    this.sessionTaskStates.set(threadId, diff.taskState)
    this.emitEvent(EVENTS.STREAM_TASK_STATE, {
      sessionId: makeCompositeId(APPS.CODEX, threadId),
      app: APPS.CODEX,
      taskState: diff.taskState,
    })
  }

  handleNotification(method, params) {
    const threadId = params.threadId
    if (!threadId) return
    const compositeId = makeCompositeId(APPS.CODEX, threadId)
    const active = this.activeTurns.get(threadId)
    // Reset sliding turn inactivity timeout on EVERY incoming stream/tool/notification/turn event
    active?.touchActivity?.()

    if (method === 'turn/plan/updated') {
      const tracker = active?.taskTracker || createTaskStateTracker(this.sessionTaskStates.get(threadId) || null)
      if (active) active.taskTracker = tracker
      tracker.applyCodexPlanUpdate(params, Date.now())
      this.emitTaskStateIfChanged(threadId, tracker)
      return
    }

    if (method === 'thread/goal/updated' && params.goal) {
      const tracker = active?.taskTracker || createTaskStateTracker(this.sessionTaskStates.get(threadId) || null)
      if (active) active.taskTracker = tracker
      tracker.setGoal(params.goal, Date.now())
      this.emitTaskStateIfChanged(threadId, tracker)
      return
    }

    if (method === 'thread/goal/cleared') {
      const tracker = active?.taskTracker || createTaskStateTracker(this.sessionTaskStates.get(threadId) || null)
      if (active) active.taskTracker = tracker
      tracker.clearGoal(Date.now())
      this.emitTaskStateIfChanged(threadId, tracker)
      return
    }

    if (method === 'item/agentMessage/delta') {
      const delta = params.delta || ''
      if (active) active.textBuffer += delta
      this.emitEvent(EVENTS.STREAM_DELTA, {
        sessionId: compositeId,
        app: APPS.CODEX,
        turnId: params.turnId,
        delta,
      })
      return
    }

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.emitEvent(EVENTS.STREAM_THINKING, {
        sessionId: compositeId,
        app: APPS.CODEX,
        turnId: params.turnId,
        delta: params.delta || '',
      })
      return
    }

    if (method === 'item/started') {
      const item = params.item || {}
      if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'webSearch') {
        this.emitEvent(EVENTS.STREAM_TOOL_START, {
          sessionId: compositeId,
          app: APPS.CODEX,
          tool: {
            id: item.id,
            name: item.type === 'commandExecution' ? 'command' : item.type === 'fileChange' ? 'file_change' : item.tool || item.type,
            input: item.command ? { command: item.command, cwd: item.cwd } : item.arguments ?? item.query ?? {},
          },
        })
      }
      return
    }

    if (method === 'item/completed') {
      const item = params.item || {}
      if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'webSearch') {
        this.emitEvent(EVENTS.STREAM_TOOL_END, {
          sessionId: compositeId,
          app: APPS.CODEX,
          toolId: item.id,
          status: item.status === 'failed' || item.error ? 'error' : 'completed',
          output: (item.aggregatedOutput || (item.result ? JSON.stringify(item.result) : '')).slice(0, 3000),
        })
      } else if (item.type === 'plan' && item.text) {
        const tracker = active?.taskTracker || createTaskStateTracker(this.sessionTaskStates.get(threadId) || null)
        if (active) active.taskTracker = tracker
        tracker.applyCodexPlanItem(item, Date.now())
        this.emitTaskStateIfChanged(threadId, tracker)
      } else if (item.type === 'agentMessage') {
        if (item.text && active && !active.textBuffer) {
          active.textBuffer = item.text
        }
        if (Array.isArray(item.questions) && item.questions.length > 0) {
          this.registerAsyncQuestionPrompt(threadId, item, {
            externalRunning: false,
            cwd: active?.cwd || '',
          })
        }
      }
      return
    }

    if (method === 'turn/completed') {
      const turn = params.turn || {}
      const finalText = active?.textBuffer || ''
      const aborted = turn.status === 'interrupted' || Boolean(active?.aborted)
      if (turn.error && !aborted) {
        const errMsg = turn.error.message || JSON.stringify(turn.error)
        const err = new Error(errMsg)
        err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: APPS.CODEX,
          message: errMsg,
        })
        if (active && !active.settled) {
          active.settled = true
          active.reject(err)
        }
        return
      }
      this.quotaCacheAt = 0
      this.quotaManager.failedAt = 0
      this.emitEvent(EVENTS.STREAM_DONE, {
        sessionId: compositeId,
        app: APPS.CODEX,
        nativeId: threadId,
        finalText,
        aborted,
      })
      if (active && !active.settled) {
        active.settled = true
        active.resolve({ sessionId: compositeId, nativeId: threadId, finalText, aborted })
      }
    }
  }

  async readQuota({ force = false } = {}) {
    return this.quotaManager.refreshInBackground({ force })
  }

  async getStatus(opts = {}) {
    try {
      // Re-resolve binary if previously missing (e.g. user installed Codex after starting bridge)
      if (!this.reader.proc) {
        const resolved = findCodexBinary(this.configuredBin)
        this.codexBin = resolved
        this.reader.codexBin = resolved
      }
      await this.reader.ensureStarted()
      const quota = await this.readQuota({ force: Boolean(opts?.forceQuota) }).catch(() => null)
      return {
        app: APPS.CODEX,
        available: true,
        writable: true,
        mode: 'app-server-rpc',
        detail: `已连接 ChatGPT 官方 codex app-server（${basename(this.codexBin)}，每轮自动释放写入锁，可与电脑端无缝切换）`,
        activeCount: this.activeTurns.size,
        ...(quota ? { quota } : {}),
      }
    } catch (err) {
      return {
        app: APPS.CODEX,
        available: false,
        writable: false,
        mode: 'unavailable',
        detail: `未找到 ChatGPT / codex CLI（请安装 ChatGPT 桌面端或运行 npm i -g @openai/codex 后点击刷新）：${String(err?.message || err)}`,
        activeCount: 0,
      }
    }
  }

  rememberWatchedSession(threadId, snapshot = {}) {
    const cleanPath = String(snapshot.path || '').replace(/^\\\\\?\\/, '').trim()
    if (!threadId || !cleanPath) return
    const existing = this.watchedSessions.get(threadId)
    const probe = snapshot.probe || probeCodexRolloutStatus(cleanPath, { maxIdleMs: this.externalMaxIdleMs })
    this.watcher.rememberWatched(threadId, {
      threadId,
      path: cleanPath,
      lastSeenAt: Date.now(),
      size: probe.size,
      mtimeMs: probe.mtimeMs,
      externalRunning: Boolean(snapshot.externalRunning ?? probe.running),
      title: snapshot.title || existing?.title || threadId,
      preview: snapshot.preview ?? existing?.preview ?? '',
      cwd: snapshot.cwd ?? existing?.cwd ?? '',
      workspace: snapshot.workspace ?? existing?.workspace ?? (snapshot.cwd ? basename(snapshot.cwd) : ''),
      model: snapshot.model ?? existing?.model ?? '',
      createdAt: snapshot.createdAt ?? existing?.createdAt ?? 0,
    })
  }

  rememberTrackedListSession(threadId, snapshot = {}, { fromDiscovery = false } = {}) {
    const cleanPath = String(snapshot.path || '').replace(/^\\\\\?\\/, '').trim()
    if (!threadId || !cleanPath) return
    const now = Date.now()
    if (!fromDiscovery) {
      this.watcher.markListActive(now)
    }
    const existing = this.trackedListSessions.get(threadId)
    const probe = snapshot.probe || probeCodexRolloutStatus(cleanPath, { maxIdleMs: this.externalMaxIdleMs })
    this.watcher.rememberTracked(threadId, {
      threadId,
      path: cleanPath,
      lastSeenAt: fromDiscovery ? (existing?.lastSeenAt || this.lastClientListAt || now) : now,
      size: probe.size,
      mtimeMs: probe.mtimeMs,
      externalRunning: Boolean(snapshot.externalRunning ?? probe.running),
      title: snapshot.title || existing?.title || threadId,
      preview: snapshot.preview ?? existing?.preview ?? '',
      cwd: snapshot.cwd ?? existing?.cwd ?? '',
      workspace: snapshot.workspace ?? existing?.workspace ?? (snapshot.cwd ? basename(snapshot.cwd) : ''),
      model: snapshot.model ?? existing?.model ?? '',
      createdAt: snapshot.createdAt ?? existing?.createdAt ?? 0,
    })
  }

  ensureWatcherRunning() {
    this.watcher.ensureRunning()
  }

  buildSessionUpdatedPayload(entry, probe, externalRunning) {
    const pref = this.sessionPrefs.get(entry.threadId)
    const isRunning = this.activeTurns.has(entry.threadId) || externalRunning
    return {
      id: makeCompositeId(APPS.CODEX, entry.threadId),
      app: APPS.CODEX,
      nativeId: entry.threadId,
      title: entry.title || entry.threadId,
      preview: entry.preview || '',
      cwd: entry.cwd || '',
      workspace: entry.workspace || (entry.cwd ? basename(entry.cwd) : ''),
      model: pref?.model || entry.model || '',
      status: isRunning ? 'running' : 'idle',
      ...(entry.taskState !== undefined ? { taskState: entry.taskState } : {}),
      syncState: { externalRunning },
      writable: true,
      createdAt: entry.createdAt || 0,
      updatedAt: Math.round(probe.mtimeMs || Date.now()),
    }
  }

  async pollExternalSessions() {
    return this.watcher.tick()
  }

  async _pollExternalSessions({ now }) {
    if (this.watchedSessions.size === 0 && this.trackedListSessions.size === 0) return
    const emittedIds = new Set()

    // 1. Poll actively watched (opened) Codex sessions for live message/tool progress & status transitions
    for (const [tid, w] of [...this.watchedSessions.entries()]) {
      if (now - w.lastSeenAt > CODEX_WATCH_TTL_MS) {
        this.watchedSessions.delete(tid)
        continue
      }
      if (this.activeTurns.has(tid)) {
        const cur = probeCodexRolloutStatus(w.path, { now, maxIdleMs: this.externalMaxIdleMs })
        w.size = cur.size
        w.mtimeMs = cur.mtimeMs
        w.externalRunning = false
        continue
      }
      const cur = probeCodexRolloutStatus(w.path, { now, maxIdleMs: this.externalMaxIdleMs })
      const fileChanged = cur.exists && (cur.size !== w.size || cur.mtimeMs !== w.mtimeMs)
      const statusChanged = cur.running !== w.externalRunning
      if (!fileChanged && !statusChanged) continue

      w.size = cur.size
      w.mtimeMs = cur.mtimeMs
      w.externalRunning = cur.running
      const tracked = this.trackedListSessions.get(tid)
      if (tracked) {
        tracked.size = cur.size
        tracked.mtimeMs = cur.mtimeMs
        tracked.externalRunning = cur.running
      }
      emittedIds.add(tid)
      if (fileChanged) {
        const rolloutTask = extractCodexTaskStateFromRollout(w.path, { parseCache: this.parseCache })
        const goalRes = await this.rpc('thread/goal/get', { threadId: tid }, 2_000).catch(() => null)
        const tracker = createTaskStateTracker(rolloutTask)
        if (goalRes?.goal) tracker.setGoal(goalRes.goal, toEpochMs(goalRes.goal.updatedAt || Date.now()))
        w.taskState = tracker.snapshot()
        this.sessionTaskStates.set(tid, w.taskState)
        this.sessionModes.set(tid, w.taskState?.mode === 'plan' ? 'plan' : 'default')
      }
      const pendingAsync = extractPendingCodexAsyncQuestionFromRollout(w.path)
      if (pendingAsync) {
        this.registerAsyncQuestionPrompt(tid, pendingAsync, {
          externalRunning: cur.running,
          cwd: w.cwd || '',
        })
      } else {
        this.clearAsyncQuestionsForThread(tid, { decision: 'desktop' })
      }
      this.emitEvent(EVENTS.SESSION_UPDATED, {
        historyChanged: fileChanged,
        statusChanged,
        externalUpdate: true,
        session: this.buildSessionUpdatedPayload(w, cur, cur.running),
      })
    }

    // 2. Poll top recent sidebar Codex sessions so running dots flip live when Desktop starts/finishes any task
    const listExpired = this.lastClientListAt > 0 && this.watcher.isListExpired(now)
    if (listExpired) {
      this.trackedListSessions.clear()
    }
    for (const [tid, entry] of [...this.trackedListSessions.entries()]) {
      if (now - entry.lastSeenAt > CODEX_TRACKED_LIST_TTL_MS) {
        this.trackedListSessions.delete(tid)
        continue
      }
      if (emittedIds.has(tid) || this.watchedSessions.has(tid)) continue
      if (this.activeTurns.has(tid)) {
        entry.externalRunning = false
        continue
      }
      const cur = probeCodexRolloutStatus(entry.path, { now, maxIdleMs: this.externalMaxIdleMs })
      const statusChanged = cur.running !== entry.externalRunning
      entry.size = cur.size
      entry.mtimeMs = cur.mtimeMs
      if (!statusChanged) continue

      entry.externalRunning = cur.running
      this.emitEvent(EVENTS.SESSION_UPDATED, {
        historyChanged: false,
        statusChanged: true,
        externalUpdate: true,
        session: this.buildSessionUpdatedPayload(entry, cur, cur.running),
      })
    }

    // 3. Periodically discover newly started / resumed Desktop Codex threads via existing reader daemon
    if (
      !listExpired &&
      this.trackedListSessions.size > 0 &&
      this.reader.proc &&
      !this.reader.proc.killed &&
      now - this.lastListDiscoveryAt >= CODEX_LIST_DISCOVERY_INTERVAL_MS
    ) {
      this.lastListDiscoveryAt = now
      try {
        const res = await this.rpc(
          'thread/list',
          { limit: 10, useStateDbOnly: true, sortKey: 'updated_at', sortDirection: 'desc' },
          5_000,
        )
        for (const raw of res?.data || []) {
          if (!raw?.id || !raw?.path || this.activeTurns.has(raw.id)) continue
          const probe = probeCodexRolloutStatus(raw.path, { now, maxIdleMs: this.externalMaxIdleMs })
          const prev = this.trackedListSessions.get(raw.id)
          const summary = normalizeThreadSummary(raw)
          const prevRunning = Boolean(prev?.externalRunning)
          this.rememberTrackedListSession(
            raw.id,
            {
              ...summary,
              path: raw.path,
              probe,
              externalRunning: probe.running,
            },
            { fromDiscovery: true },
          )
          if ((!prev && probe.running) || (prev && prevRunning !== probe.running)) {
            const entry = this.trackedListSessions.get(raw.id)
            if (entry && !emittedIds.has(raw.id)) {
              this.emitEvent(EVENTS.SESSION_UPDATED, {
                historyChanged: false,
                statusChanged: true,
                externalUpdate: true,
                session: this.buildSessionUpdatedPayload(entry, probe, probe.running),
              })
            }
          }
        }
      } catch {}
    }
  }

  async listSessions({ limit = 80, search = '' } = {}) {
    const res = await this.rpc('thread/list', {
      limit,
      useStateDbOnly: true,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      ...(search ? { searchTerm: search } : {}),
    })
    const now = Date.now()
    const rawList = Array.isArray(res?.data) ? res.data : []
    const items = []
    for (let i = 0; i < rawList.length; i += 1) {
      const raw = rawList[i]
      const item = normalizeThreadSummary(raw)
      const isLocalActive = this.activeTurns.has(item.nativeId)
      let probe = null
      let externalRunning = false
      // Probe recent threads (top 15 or updated within maxIdleMs+5m) via zero-OOM rollout tail-seek
      if (!isLocalActive && raw?.path && (i < CODEX_TRACKED_LIST_LIMIT || now - (item.updatedAt || 0) <= this.externalMaxIdleMs + 5 * 60_000)) {
        probe = probeCodexRolloutStatus(raw.path, { now, maxIdleMs: this.externalMaxIdleMs })
        externalRunning = probe.running
        if (probe.mtimeMs > (item.updatedAt || 0)) {
          item.updatedAt = Math.round(probe.mtimeMs)
        }
      }
      if (isLocalActive) {
        item.status = 'running'
        item.syncState = { externalRunning: false }
      } else if (externalRunning) {
        item.status = 'running'
        item.syncState = { externalRunning: true }
      }
      if (!search && i < CODEX_TRACKED_LIST_LIMIT && raw?.path) {
        this.rememberTrackedListSession(item.nativeId, {
          ...item,
          path: raw.path,
          probe,
          externalRunning,
        })
      }
      items.push(item)
    }
    this.lastListDiscoveryAt = now
    this.lastClientListAt = now
    const seen = new Set(items.map((x) => x.nativeId))
    for (const [tid, entry] of this.pendingNewWriters.entries()) {
      if (!seen.has(tid) && entry.summary) {
        items.unshift(entry.summary)
      }
    }
    for (const item of items) {
      if (this.activeTurns.has(item.nativeId)) item.status = 'running'
    }
    return items
  }

  async readSession(threadId, { limit = 25, cursor = null } = {}) {
    threadId = assertSafeSessionId(threadId, 'Codex threadId')
    const pendingNew = this.pendingNewWriters.get(threadId)
    let t = {}
    try {
      const metaRes = await this.rpc('thread/read', { threadId, includeTurns: false })
      t = metaRes?.thread || {}
    } catch (err) {
      if (pendingNew?.summary) {
        return {
          ...pendingNew.summary,
          messages: [],
          hasMore: false,
          nextCursor: null,
        }
      }
      throw err
    }

    let messages = []
    let nextCursor = null
    let hasMore = false
    let loadedTurns = null

    const targetBubbles = Math.max(6, Math.min(Number(limit) || 12, 30))
    const maxRawBatches = 16 // up to 1,600 raw items per page so heavy tool runs stay fast & complete
    let hitDeserializationBoundary = false

    {
      const collectedDesc = []
      let curCursor = cursor || null
      let userCount = 0
      let agentTextCount = 0

      for (let batch = 0; batch < maxRawBatches; batch += 1) {
        let itemsRes = null
        try {
          itemsRes = await this.rpc('thread/items/list', {
            threadId,
            limit: 100,
            sortDirection: 'desc',
            ...(curCursor ? { cursor: curCursor } : {}),
          })
        } catch (batchErr) {
          // If batch 0 fails because a legacy corrupt item sits inside the newest 100 items,
          // retry once with a smaller window (20 items) to still rescue the latest replies.
          if (batch === 0 && collectedDesc.length === 0) {
            try {
              itemsRes = await this.rpc('thread/items/list', {
                threadId,
                limit: 20,
                sortDirection: 'desc',
                ...(curCursor ? { cursor: curCursor } : {}),
              })
            } catch {
              itemsRes = null
            }
          }
          if (!itemsRes) {
            // Preserve every valid item already fetched in earlier batches!
            hitDeserializationBoundary = true
            curCursor = null
            this.log.warn?.(
              `codex: thread/items/list stopped at batch ${batch} for ${threadId} (kept ${collectedDesc.length} items): ${String(batchErr?.message || batchErr)}`,
            )
            break
          }
        }
        const chunk = Array.isArray(itemsRes?.data) ? itemsRes.data : []
        if (chunk.length > 0) {
          collectedDesc.push(...chunk)
          for (const entry of chunk) {
            const it = entry?.item?.type
            if (it === 'userMessage') userCount += 1
            else if (it === 'agentMessage') agentTextCount += 1
          }
        }
        curCursor = itemsRes?.nextCursor || null
        if (!curCursor || chunk.length === 0) break
        // Stop once we have enough real Q&A turns OR enough autonomous assistant milestones
        if (userCount >= Math.max(3, Math.ceil(targetBubbles / 2))) break
        if (userCount >= 2 && agentTextCount >= targetBubbles) break
        if (agentTextCount >= Math.max(6, targetBubbles)) break
      }

      nextCursor = hitDeserializationBoundary ? null : curCursor ? String(curCursor) : null
      hasMore = Boolean(nextCursor)

      const entries = collectedDesc.slice().reverse()
      if (entries.length > 0) {
        const turns = []
        const byTurn = new Map()
        for (const entry of entries) {
          const turnId = entry.turnId || 'default'
          let turnObj = byTurn.get(turnId)
          if (!turnObj) {
            turnObj = { id: turnId, startedAt: entry.startedAtMs, items: [] }
            byTurn.set(turnId, turnObj)
            turns.push(turnObj)
          }
          if (entry.item) {
            turnObj.items.push({
              ...entry.item,
              startedAtMs: entry.startedAtMs ?? entry.item.startedAtMs,
              completedAtMs: entry.completedAtMs ?? entry.item.completedAtMs,
            })
          }
        }
        loadedTurns = turns
        messages = mergeAndCompactMessages(normalizeCodexTurns(turns))
      }
    }

    if (messages.length === 0 && !cursor && !pendingNew) {
      try {
        const fullRes = await this.rpc('thread/read', { threadId, includeTurns: true }, 12_000)
        loadedTurns = fullRes?.thread?.turns || null
        const all = mergeAndCompactMessages(normalizeCodexTurns(loadedTurns || []))
        const start = Math.max(0, all.length - targetBubbles)
        messages = all.slice(start)
        hasMore = false
        nextCursor = null
      } catch {}
    }

    // Final safety net: zero-OOM tail-seek JSONL reader for giant/legacy rollout files
    // (also rescues fuller recent history when a corrupt schema item sits near the newest items)
    if (!cursor && !pendingNew && t.path && (messages.length === 0 || (hitDeserializationBoundary && messages.length < 4))) {
      const tailMsgs = readCodexRolloutTail(t.path, { limit: targetBubbles, parseCache: this.parseCache })
      if (tailMsgs.length > messages.length) {
        messages = tailMsgs
        hasMore = false
        nextCursor = null
      }
    }

    const pref = this.sessionPrefs.get(threadId)
    const activeTurn = this.activeTurns.get(threadId)
    const isLocalActive = Boolean(activeTurn)
    const rolloutProbe = !isLocalActive && t.path
      ? probeCodexRolloutStatus(t.path, { maxIdleMs: this.externalMaxIdleMs })
      : null
    const externalRunning = Boolean(!isLocalActive && rolloutProbe?.running)

    let taskState = null
    if (isLocalActive && activeTurn?.taskTracker) {
      taskState = activeTurn.taskTracker.snapshot()
    } else if (!cursor) {
      const rolloutTask = t.path ? extractCodexTaskStateFromRollout(t.path, { parseCache: this.parseCache }) : null
      const tracker = createTaskStateTracker(rolloutTask)
      if (Array.isArray(loadedTurns)) {
        for (const turn of loadedTurns) {
          for (const item of turn?.items || []) {
            if (item?.type === 'plan' && item.text) {
              tracker.applyCodexPlanItem(item, toEpochMs(item.completedAtMs || item.startedAtMs || turn.startedAt || Date.now()))
            }
          }
        }
      }
      const goalRes = !pendingNew ? await this.rpc('thread/goal/get', { threadId }, 2_500).catch(() => null) : null
      if (goalRes?.goal) {
        tracker.setGoal(goalRes.goal, toEpochMs(goalRes.goal.updatedAt || Date.now()))
      }
      taskState = tracker.snapshot()
      this.sessionTaskStates.set(threadId, taskState)
      this.sessionModes.set(threadId, taskState?.mode === 'plan' ? 'plan' : 'default')
    } else {
      taskState = this.sessionTaskStates.get(threadId) || null
    }
    const title = (t.name && t.name.trim()) || (t.preview && t.preview.trim().slice(0, 56)) || pendingNew?.summary?.title || threadId
    const cwd = t.cwd || pendingNew?.summary?.cwd || ''
    const model = pref?.model || t.model || ''
    const updatedAt = Math.max(
      toEpochMs(t.updatedAt || t.recencyAt || t.createdAt),
      Math.round(rolloutProbe?.mtimeMs || 0),
    )

      if (!cursor) {
        if (Array.isArray(loadedTurns) && loadedTurns.length > 0) {
          this.syncAsyncQuestionFromTurns(threadId, loadedTurns, { externalRunning, cwd })
        } else if (t.path) {
          const pendingAsync = extractPendingCodexAsyncQuestionFromRollout(t.path)
          if (pendingAsync) {
            this.registerAsyncQuestionPrompt(threadId, pendingAsync, { externalRunning, cwd })
          } else {
            this.clearAsyncQuestionsForThread(threadId, { decision: 'desktop' })
          }
        }
      }

      if (!cursor && t.path) {
        this.rememberWatchedSession(threadId, {
        path: t.path,
        probe: rolloutProbe,
        externalRunning,
        title,
        preview: (t.preview || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        cwd,
        workspace: cwd ? basename(cwd) : '',
        model,
        createdAt: toEpochMs(t.createdAt),
      })
    }

    return {
      id: makeCompositeId(APPS.CODEX, threadId),
      app: APPS.CODEX,
      nativeId: threadId,
      title,
      cwd,
      workspace: cwd ? basename(cwd) : '',
      model,
      reasoningEffort: pref?.reasoningEffort || t.reasoningEffort || '',
      writable: true,
      status: isLocalActive || externalRunning ? 'running' : 'idle',
      taskState,
      syncState: { externalRunning },
      updatedAt,
      messages,
      hasMore,
      nextCursor,
    }
  }

  _evictPendingNewWritersIfNeeded(maxKeep = MAX_PENDING_NEW_WRITERS - 1) {
    while (this.pendingNewWriters.size > maxKeep) {
      const oldestTid = this.pendingNewWriters.keys().next().value
      if (!oldestTid) break
      const oldest = this.pendingNewWriters.get(oldestTid)
      this.pendingNewWriters.delete(oldestTid)
      if (oldest?.timer) this.clearTrackedTimer(oldest.timer)
      if (oldest?.writer) {
        const rel = this.releaseWriter(oldest.writer, oldestTid).finally(() => {
          if (this.releasingWriters.get(oldestTid) === rel) {
            this.releasingWriters.delete(oldestTid)
          }
        })
        this.releasingWriters.set(oldestTid, rel)
      }
    }
  }

  async createSession({ cwd, title, model, reasoningEffort, sandbox, approvalPolicy } = {}) {
    const targetCwd = String(cwd || '').trim() || this.defaultCwd
    const writer = this.createWriter('new')
    try {
      const res = await writer.rpc('thread/start', {
        cwd: targetCwd,
        ...(model ? { model } : {}),
        ...(sandbox ? { sandbox } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
      })
      const t = res?.thread || {}
      if (t.id) {
        if (model || reasoningEffort) {
          this.sessionPrefs.set(t.id, { model: model || t.model || '', reasoningEffort: reasoningEffort || '' })
        }
        if (title && String(title).trim()) {
          await writer.rpc('thread/name/set', { threadId: t.id, name: String(title).trim() }).catch(() => {})
          t.name = String(title).trim()
        }
      }
      const summary = normalizeThreadSummary(t)
      if (title && String(title).trim()) summary.title = String(title).trim()
      if (model) summary.model = model
      if (reasoningEffort) summary.reasoningEffort = reasoningEffort

      if (t.id) {
        // Bound concurrent idle new-thread writers to MAX_PENDING_NEW_WRITERS (evicting oldest first)
        this._evictPendingNewWritersIfNeeded(MAX_PENDING_NEW_WRITERS - 1)
        // Hold this temporary writer ONLY until Turn 1 completes (or 3 min idle) so empty threads can start Turn 1 cleanly
        const timer = this.setTimeout(() => {
          const entry = this.pendingNewWriters.get(t.id)
          if (entry && entry.writer === writer) {
            this.pendingNewWriters.delete(t.id)
            const rel = this.releaseWriter(writer, t.id).finally(() => {
              if (this.releasingWriters.get(t.id) === rel) {
                this.releasingWriters.delete(t.id)
              }
            })
            this.releasingWriters.set(t.id, rel)
          }
        }, 3 * 60_000)
        this.pendingNewWriters.set(t.id, { writer, summary, timer })
      } else {
        await this.releaseWriter(writer, '')
      }
      return summary
    } catch (err) {
      await this.releaseWriter(writer, '')
      throw err
    }
  }

  async sendMessage(threadId, { text, cwd, attachments = [], approvalPolicy, taskMode, model, reasoningEffort } = {}) {
    threadId = assertSafeSessionId(threadId, 'Codex threadId')
    const compositeId = makeCompositeId(APPS.CODEX, threadId)
    let effectiveTaskMode = normalizeTaskMode(taskMode)
    if (this.activeTurns.has(threadId)) {
      const err = new Error('该 ChatGPT 对话正在运行中，请等待完成或先中断当前任务。')
      err.code = 'SESSION_BUSY'
      throw err
    }

    const input = []
    let rawText = String(text || '')
    let trimmedText = rawText.trim()
    if (!effectiveTaskMode && trimmedText) {
      const slashCmd = /^\/(plan|goal)(?:\s+([\s\S]*))?$/i.exec(trimmedText)
      if (slashCmd) {
        effectiveTaskMode = slashCmd[1].toLowerCase()
        const rest = String(slashCmd[2] || '').trim()
        if (rest) {
          rawText = rest
          trimmedText = rest
        }
      }
    }
    if (trimmedText.length > 0) {
      input.push({ type: 'text', text: rawText, text_elements: [] })
    }
    for (const att of attachments) {
      if (att.localPath && String(att.mimeType || '').startsWith('image/')) {
        input.push({ type: 'localImage', path: att.localPath })
      } else if (att.localPath) {
        input.push({ type: 'text', text: `[附件文件: ${att.localPath}]`, text_elements: [] })
      }
    }
    if (input.length === 0) {
      throw new Error('消息内容不能为空')
    }

    let resolveTurn
    let rejectTurn
    const turnDone = new Promise((res, rej) => {
      resolveTurn = res
      rejectTurn = rej
    })
    // Prevent unhandled rejection if writer exits during `turn/start` before `await turnDone`
    turnDone.catch(() => {})

    // Synchronously reserve activeTurns BEFORE any await to eliminate TOCTOU races
    const turnState = {
      writer: null,
      turnId: null,
      cwd: cwd || '',
      textBuffer: '',
      taskTracker: createTaskStateTracker(this.sessionTaskStates.get(threadId) || null),
      aborted: false,
      settled: false,
      resolve: resolveTurn,
      reject: rejectTurn,
    }
    this.activeTurns.set(threadId, turnState)
    // A new user message supersedes any older unanswered async question card on this thread
    this.clearAsyncQuestionsForThread(threadId, { decision: 'superseded' })

    let writer = null
    let alreadyLoaded = false
    let streamStarted = false

    try {
      // Wait for any previous writer on this threadId to finish releasing its lock before calling thread/resume
      const inflightRelease = this.releasingWriters.get(threadId)
      if (inflightRelease) {
        await inflightRelease.catch(() => {})
      }

      if (turnState.aborted) {
        return { sessionId: compositeId, nativeId: threadId, finalText: '', aborted: true }
      }

      // Reuse pending new-thread writer if Turn 1 and still alive; otherwise spawn a fresh per-turn writer
      const pendingNew = this.pendingNewWriters.get(threadId)
      if (pendingNew) {
        this.clearTrackedTimer(pendingNew.timer)
        this.pendingNewWriters.delete(threadId)
        if (pendingNew.writer?.proc && !pendingNew.writer.proc.killed) {
          writer = pendingNew.writer
          alreadyLoaded = true
        } else {
          pendingNew.writer?.killImmediate?.()
          writer = this.createWriter(threadId)
        }
      } else {
        writer = this.createWriter(threadId)
      }
      turnState.writer = writer

      if (!alreadyLoaded) {
        try {
          await writer.rpc('thread/resume', {
            threadId,
            excludeTurns: true,
            ...(cwd ? { cwd } : {}),
          })
        } catch (resumeErr) {
          const msg = String(resumeErr?.message || resumeErr)
          if (/already has an active writer|thread-store conflict/i.test(msg)) {
            throw new Error(
              '该对话当前正被电脑端 ChatGPT 桌面窗口占用（同一时间只允许一端写入）。请在电脑端 ChatGPT 里切到其他对话后再试，或在手机端新建对话继续。',
            )
          }
          if (!/no rollout found/i.test(msg)) {
            throw resumeErr
          }
        }
      }

      if (turnState.aborted) {
        return { sessionId: compositeId, nativeId: threadId, finalText: '', aborted: true }
      }

      streamStarted = true
      this.emitEvent(EVENTS.STREAM_START, {
        sessionId: compositeId,
        app: APPS.CODEX,
        nativeId: threadId,
      })

      const pref = this.sessionPrefs.get(threadId)
      const effectiveModel = model || pref?.model || undefined
      const effectiveEffort = reasoningEffort || pref?.reasoningEffort || undefined
      if (effectiveModel || effectiveEffort) {
        this.sessionPrefs.set(threadId, { model: effectiveModel || '', reasoningEffort: effectiveEffort || '' })
      }

      const prevWasPlan =
        this.sessionModes.get(threadId) === 'plan' ||
        turnState.taskTracker.snapshot()?.mode === 'plan'

      if (effectiveTaskMode === 'goal' && trimmedText) {
        await writer
          .rpc(
            'thread/goal/set',
            {
              threadId,
              objective: trimmedText.slice(0, 1000),
              status: 'active',
              origin: 'user',
            },
            8_000,
          )
          .catch((goalErr) => {
            this.log.warn?.(`mobile-hub: codex thread/goal/set skipped: ${String(goalErr?.message || goalErr)}`)
          })
        turnState.taskTracker.setGoal({ objective: trimmedText.slice(0, 400), status: 'active' }, Date.now())
      }

      let collaborationMode
      if (effectiveTaskMode === 'plan' || (effectiveTaskMode !== 'plan' && prevWasPlan)) {
        let collabModel = effectiveModel || ''
        if (!collabModel) {
          const catalog = await this.listModels().catch(() => null)
          collabModel = catalog?.defaultModel || ''
        }
        if (collabModel) {
          collaborationMode = {
            mode: effectiveTaskMode === 'plan' ? 'plan' : 'default',
            settings: {
              model: collabModel,
              ...(effectiveEffort && effectiveEffort !== 'off' ? { reasoning_effort: effectiveEffort } : {}),
              developer_instructions: null,
            },
          }
        }
      }

      turnState.taskTracker.applyCodexTurnMode(
        effectiveTaskMode === 'plan' ? 'plan' : prevWasPlan ? 'default' : '',
        effectiveTaskMode === 'goal' ? 'goal' : '',
        Date.now(),
      )
      this.sessionModes.set(threadId, effectiveTaskMode === 'plan' ? 'plan' : 'default')
      this.emitTaskStateIfChanged(threadId, turnState.taskTracker)

      const turnStartBase = {
        threadId,
        input,
        ...(cwd ? { cwd } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort && effectiveEffort !== 'off' ? { effort: effectiveEffort } : {}),
      }
      let startRes
      if (collaborationMode) {
        try {
          startRes = await writer.rpc('turn/start', { ...turnStartBase, collaborationMode })
        } catch (collabErr) {
          const errMsg = String(collabErr?.message || collabErr)
          if (/collaborationMode|unknown field|experimental|invalid params/i.test(errMsg)) {
            this.log.warn?.(`mobile-hub: codex collaborationMode unsupported, retrying default turn/start: ${errMsg}`)
            startRes = await writer.rpc('turn/start', turnStartBase)
          } else {
            throw collabErr
          }
        }
      } else {
        startRes = await writer.rpc('turn/start', turnStartBase)
      }
      turnState.turnId = startRes?.turn?.id || null

      if (turnState.aborted && turnState.turnId) {
        await writer.rpc('turn/interrupt', { threadId, turnId: turnState.turnId }, 5_000).catch(() => {})
      }

      // Guard against hung writer turns with a sliding inactivity timeout (paused while awaiting approval)
      let turnTimer = null
      const resetTurnTimeout = () => {
        if (turnTimer) this.clearTrackedTimer(turnTimer)
        if (turnState.settled) return
        turnTimer = this.setTimeout(() => {
          if (turnState.settled) return
          for (const req of this.pendingServerRequests.values()) {
            if (req.writer === writer) {
              resetTurnTimeout()
              return
            }
          }
          turnState.settled = true
          turnState.reject?.(new Error('ChatGPT 回合响应超时（长时间无输出），已自动释放锁'))
        }, CODEX_TURN_INACTIVITY_TIMEOUT_MS)
      }
      turnState.touchActivity = resetTurnTimeout
      resetTurnTimeout()

      try {
        return await turnDone
      } finally {
        if (turnTimer) this.clearTrackedTimer(turnTimer)
      }
    } catch (err) {
      if (!err?._streamErrorEmitted) {
        if (err && typeof err === 'object') err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: APPS.CODEX,
          message: String(err?.message || err),
        })
      }
      throw err
    } finally {
      if (streamStarted && turnState.aborted && !turnState.settled) {
        turnState.settled = true
        this.emitEvent(EVENTS.STREAM_DONE, {
          sessionId: compositeId,
          app: APPS.CODEX,
          nativeId: threadId,
          finalText: turnState.textBuffer || '',
          aborted: true,
        })
      }
      if (writer) {
        for (const [aprId, entry] of this.pendingServerRequests.entries()) {
          if (entry.writer === writer) {
            this.pendingServerRequests.delete(aprId)
            this.emitEvent(EVENTS.APPROVAL_RESOLVED, { id: aprId, app: APPS.CODEX, sessionId: compositeId, decision: 'cancel' })
          }
        }
      }
      // Register releasingWriters BEFORE clearing activeTurns so fast follow-up turns wait on the release lock
      let releasePromise = null
      if (writer) {
        releasePromise = this.releaseWriter(writer, threadId).finally(() => {
          if (this.releasingWriters.get(threadId) === releasePromise) {
            this.releasingWriters.delete(threadId)
          }
        })
        this.releasingWriters.set(threadId, releasePromise)
      }
      if (this.activeTurns.get(threadId) === turnState) {
        this.activeTurns.delete(threadId)
      }
      if (releasePromise) {
        await releasePromise.catch(() => {})
      }
      // Refresh local watcher/list snapshots post-release so our own turn's writes don't trigger a false externalUpdate echo
      const now = Date.now()
      const watched = this.watchedSessions.get(threadId)
      if (watched?.path) {
        const cur = probeCodexRolloutStatus(watched.path, { now, maxIdleMs: this.externalMaxIdleMs })
        watched.size = cur.size
        watched.mtimeMs = cur.mtimeMs
        watched.externalRunning = false
        watched.lastSeenAt = now
      }
      const tracked = this.trackedListSessions.get(threadId)
      if (tracked?.path) {
        const cur = probeCodexRolloutStatus(tracked.path, { now, maxIdleMs: this.externalMaxIdleMs })
        tracked.size = cur.size
        tracked.mtimeMs = cur.mtimeMs
        tracked.externalRunning = false
      }
    }
  }

  async interrupt(threadId) {
    threadId = assertSafeSessionId(threadId, 'Codex threadId')
    for (const [aprId, entry] of this.pendingServerRequests.entries()) {
      if (entry.threadId === threadId && entry.method !== 'codex/asyncQuestion') {
        this.pendingServerRequests.delete(aprId)
        try {
          if (entry.method === 'item/tool/requestUserInput') {
            entry.writer?.sendRaw({ jsonrpc: '2.0', id: entry.rpcId, result: { answers: {} } })
          } else if (entry.method === 'item/permissions/requestApproval') {
            entry.writer?.sendRaw({ jsonrpc: '2.0', id: entry.rpcId, result: { permissions: {}, scope: 'turn' } })
          } else if (entry.method === 'mcpServer/elicitation/request') {
            entry.writer?.sendRaw({ jsonrpc: '2.0', id: entry.rpcId, result: { action: 'cancel' } })
          } else {
            entry.writer?.sendRaw({ jsonrpc: '2.0', id: entry.rpcId, result: { decision: 'cancel' } })
          }
        } catch {}
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
          id: aprId,
          app: APPS.CODEX,
          sessionId: makeCompositeId(APPS.CODEX, threadId),
          decision: 'cancel',
        })
      }
    }
    const active = this.activeTurns.get(threadId)
    if (!active) return { interrupted: false, sessionId: threadId }
    active.aborted = true
    if (active.turnId && active.writer) {
      await active.writer.rpc('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => {})
    }
    return { interrupted: true, sessionId: threadId }
  }

  async dispose() {
    this.disposed = true
    this.watcher.dispose()
    this.quotaManager.dispose()
    for (const [aprId] of this.pendingServerRequests.entries()) {
      this.pendingServerRequests.delete(aprId)
    }
    for (const [tid, entry] of this.pendingNewWriters.entries()) {
      this.clearTrackedTimer(entry.timer)
      entry.writer.killImmediate()
      this.pendingNewWriters.delete(tid)
    }
    for (const [tid, active] of this.activeTurns.entries()) {
      if (!active.settled) {
        active.settled = true
        active.reject?.(new Error('Codex adapter disposed'))
      }
      active.writer?.killImmediate()
      this.activeTurns.delete(tid)
    }
    for (const relWriter of [...this.releasingWriterClients]) {
      relWriter.killImmediate()
    }
    this.releasingWriterClients.clear()
    this.releasingWriters.clear()
    this.reader.killImmediate()
    this.disposeBase()
  }
}
