import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  APPS,
  EVENTS,
  assertPathWithinDir,
  assertSafeCliToken,
  assertSafeSessionId,
  makeCompositeId,
  toEpochMs,
} from '../protocol.js'
import { createFileParseCache, mergeAndCompactMessages } from '../helpers/history-normalize.js'
import {
  findExecutable,
  getCodebuddyCandidates,
  killProcessTree,
  spawnCrossPlatform,
} from '../helpers/bin-finder.js'
import { installSingleAppCli } from '../helpers/env-autofix.js'
import { normalizeResolvePayload, normalizeSingleAnswer } from '../helpers/interactive-schema.js'
import { createTaskStateTracker, normalizeTaskMode, parseMaybeJson } from '../helpers/task-state.js'

const require = createRequire(import.meta.url)

const workbuddyParseCache = createFileParseCache(24)

const WORKBUDDY_EXTERNAL_MAX_IDLE_MS = 15 * 60_000
const WORKBUDDY_WATCH_POLL_MS = 2_000
const WORKBUDDY_WATCH_TTL_MS = 10 * 60_000
const WORKBUDDY_LIST_WATCH_TTL_MS = 10 * 60_000
const WORKBUDDY_LIST_DISCOVERY_INTERVAL_MS = 15_000
const WORKBUDDY_TRACKED_LIST_LIMIT = 20
const WORKBUDDY_TAIL_PROBE_BYTES = 64 * 1024
const WORKBUDDY_TAIL_PROBE_MAX_BYTES = 512 * 1024
const WORKBUDDY_QUOTA_CACHE_TTL_MS = 2 * 60 * 1_000
const WORKBUDDY_QUOTA_TIMEOUT_MS = 4_500
const WORKBUDDY_MAX_FULL_PARSE_BYTES = 32 * 1024 * 1024
const WORKBUDDY_TAIL_FALLBACK_BYTES = 4 * 1024 * 1024

const ALLOWED_WORKBUDDY_PERMISSION_MODES = Object.freeze([
  'plan',
  'default',
  'acceptEdits',
  'dontAsk',
  'auto',
  'bypassPermissions',
])

const WORKBUDDY_PERMISSION_MODE_RANK = Object.freeze({
  plan: 0,
  default: 1,
  acceptEdits: 2,
  dontAsk: 3,
  auto: 3,
  bypassPermissions: 4,
})

const WORKBUDDY_DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const WORKBUDDY_BASE_MODELS = Object.freeze([
  { id: 'auto', name: 'Auto (WorkBuddy 默认)', efforts: WORKBUDDY_DEFAULT_EFFORTS, defaultEffort: 'high' },
  { id: 'glm-5.3', name: 'GLM-5.3', efforts: WORKBUDDY_DEFAULT_EFFORTS, defaultEffort: 'high' },
  { id: 'glm-5.1', name: 'GLM-5.1', efforts: WORKBUDDY_DEFAULT_EFFORTS, defaultEffort: 'high' },
  { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', efforts: WORKBUDDY_DEFAULT_EFFORTS, defaultEffort: 'medium' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', efforts: WORKBUDDY_DEFAULT_EFFORTS, defaultEffort: 'high' },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek V3.2', efforts: WORKBUDDY_DEFAULT_EFFORTS, defaultEffort: 'high' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', efforts: WORKBUDDY_DEFAULT_EFFORTS, defaultEffort: 'high' },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', efforts: WORKBUDDY_DEFAULT_EFFORTS, defaultEffort: 'high' },
])

let sqliteModCache = undefined
function getDatabaseSync() {
  if (sqliteModCache !== undefined) return sqliteModCache
  try {
    const mod = require('node:sqlite')
    sqliteModCache = typeof mod?.DatabaseSync === 'function' ? mod.DatabaseSync : null
  } catch {
    sqliteModCache = null
  }
  return sqliteModCache
}

function resolveEffectiveWorkbuddyPermissionMode(requestedMode, hostConfiguredMode, effectiveTaskMode) {
  const hostMode = ALLOWED_WORKBUDDY_PERMISSION_MODES.includes(hostConfiguredMode)
    ? hostConfiguredMode
    : 'acceptEdits'
  const rawReq = String(requestedMode ?? '').trim()
  if (!rawReq) {
    if (effectiveTaskMode === 'plan') return 'plan'
    return hostMode
  }
  if (!ALLOWED_WORKBUDDY_PERMISSION_MODES.includes(rawReq)) {
    throw new Error('非法的 permissionMode 参数值')
  }
  const reqRank = WORKBUDDY_PERMISSION_MODE_RANK[rawReq]
  const hostRank = WORKBUDDY_PERMISSION_MODE_RANK[hostMode]
  if (reqRank > hostRank) {
    throw new Error(`出于安全限制，不允许远程将 WorkBuddy 权限模式从 ${hostMode} 提升至 ${rawReq}`)
  }
  return rawReq
}

function getWorkbuddyHome(configuredHome = '') {
  const custom = String(configuredHome || process.env.WORKBUDDY_CONFIG_DIR || '').trim()
  return custom || join(homedir(), '.workbuddy')
}

function getCodebuddyHome(configuredHome = '') {
  const custom = String(configuredHome || process.env.CODEBUDDY_CONFIG_DIR || '').trim()
  return custom || join(homedir(), '.codebuddy')
}

function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function findCodebuddyCommand(configured) {
  const candidates = getCodebuddyCandidates(homedir(), process.platform, process.env, configured)
  if (process.platform === 'win32') {
    return findExecutable(['codebuddy.exe', 'codebuddy.cmd', 'cbc.exe', 'cbc.cmd', 'codebuddy', 'cbc'], candidates) || ''
  }
  return findExecutable(['codebuddy', 'cbc'], candidates) || ''
}

const TRUSTED_WORKBUDDY_AUTH_SUFFIXES = [
  'codebuddy.cn',
  'codebuddy.ai',
  'workbuddy.cn',
  'workbuddy.ai',
  'copilot.tencent.com',
  'tencentbuddy.com',
  'open.weixin.qq.com',
  'cloud.tencent.com',
  'accounts.google.com',
  'github.com',
]

/**
 * Strictly validate an OAuth login URL returned by CodeBuddy ACP `_codebuddy.ai/authUrl`
 * against javascript:/data:/phishing domains before surfacing it to clients.
 */
export function isSafeWorkbuddyAuthUrl(rawUrl) {
  const s = String(rawUrl || '').trim()
  if (!s || s.length > 4096) return false
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return TRUSTED_WORKBUDDY_AUTH_SUFFIXES.some((sfx) => host === sfx || host.endsWith(`.${sfx}`))
  } catch {
    return false
  }
}

export function getCodebuddyAuthDir({ home = homedir(), platform = process.platform, env = process.env, configuredDir = '' } = {}) {
  const custom = String(configuredDir || '').trim()
  if (custom) return custom
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  }
  if (platform === 'win32') {
    const localApp = env?.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return join(localApp, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
  }
  return join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
}

/**
 * Detect whether standalone `@tencent-ai/codebuddy-code` CLI already holds a saved login session.
 * Note: `workbuddy-desktop*.info` is encrypted by WorkBuddy Desktop's main Electron process and
 * cannot be decrypted by standalone CLI processes, so it is intentionally excluded here.
 */
export function hasStandaloneCodebuddyAuth({ authDir = '', env = process.env } = {}) {
  if (String(env?.CODEBUDDY_API_KEY || env?.CODEBUDDY_AUTH_TOKEN || '').trim()) {
    return true
  }
  const dir = authDir || getCodebuddyAuthDir({ env })
  if (!dir || !existsSync(dir)) return false
  try {
    const names = readdirSync(dir)
    for (const name of names) {
      if (!name.endsWith('.info')) continue
      const lower = name.toLowerCase()
      if (lower.startsWith('workbuddy-desktop')) continue
      // Skip timestamped backup snapshots like `foo.2026-09-09T04-29-47-512Z.info`
      if (/\.\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}/i.test(lower)) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (!st.isFile() || st.size <= 2) continue
      } catch {
        continue
      }
      if (existsSync(`${full}.logout`)) continue
      return true
    }
  } catch {}
  return false
}

/**
 * Read the signed-in standalone CodeBuddy CLI OAuth credential file (`*.info`, excluding
 * WorkBuddy Desktop's Electron-encrypted `workbuddy-desktop*.info`) strictly for querying
 * official read-only billing/credits summary. Never logs or exposes the access token.
 */
export function readStandaloneCodebuddyCredential({ authDir = '', env = process.env } = {}) {
  const dir = authDir || getCodebuddyAuthDir({ env })
  if (!dir || !existsSync(dir)) return null
  try {
    const names = readdirSync(dir)
    const candidates = []
    for (const name of names) {
      if (!name.endsWith('.info')) continue
      const lower = name.toLowerCase()
      if (lower.startsWith('workbuddy-desktop')) continue
      if (/\.\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}/i.test(lower)) continue
      const full = join(dir, name)
      if (existsSync(`${full}.logout`)) continue
      let st
      try {
        st = statSync(full)
        if (!st.isFile() || st.size <= 2 || st.size > 256 * 1024) continue
      } catch {
        continue
      }
      candidates.push({ full, mtimeMs: st.mtimeMs })
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const item of candidates) {
      let data
      try {
        data = JSON.parse(readFileSync(item.full, 'utf8'))
      } catch {
        continue
      }
      const accessToken = String(data?.auth?.accessToken || '').trim()
      if (!accessToken || accessToken.length < 16) continue
      const rawDomain = String(data?.auth?.domain || 'www.codebuddy.cn').trim().replace(/^https?:\/\//i, '').replace(/\/+.*$/, '')
      const domain = rawDomain || 'www.codebuddy.cn'
      if (!isSafeWorkbuddyAuthUrl(`https://${domain}/`)) continue
      const uid = String(data?.account?.uid || '').trim()
      const enterpriseId = String(data?.account?.enterpriseId || '').trim()
      const accountType = String(data?.account?.type || 'personal').trim()
      return {
        accessToken,
        domain,
        uid,
        enterpriseId,
        accountType,
      }
    }
  } catch {}
  return null
}

function roundCredit(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.round(v * 10) / 10
}

/**
 * Normalize Tencent WorkBuddy / CodeBuddy personal (`get-user-resource-summary`) or
 * enterprise (`get-enterprise-user-usage`) billing responses into All in One's unified quota shape.
 */
export function normalizeWorkbuddyCreditsQuota(rawPayload, { isEnterprise = false } = {}) {
  if (!rawPayload || typeof rawPayload !== 'object') return null
  const data = rawPayload?.data?.data || rawPayload?.data || rawPayload
  if (!data || typeof data !== 'object') return null

  if (isEnterprise || typeof data.limitNum === 'number') {
    const limitNum = Number(data.limitNum)
    if (!Number.isFinite(limitNum)) return null
    const resetsAt = data.cycleResetTime ? toEpochMs(data.cycleResetTime) : 0
    if (limitNum === -1) {
      return {
        windowKind: 'credits',
        remainingPercent: 100,
        usedPercent: 0,
        creditsRemaining: null,
        creditsTotal: null,
        creditsUsed: roundCredit(data.credit || 0),
        unlimited: true,
        planType: 'Enterprise',
        resetsAt,
        updatedAt: Date.now(),
      }
    }
    if (limitNum <= 0) return null
    const used = Math.max(0, roundCredit(data.credit || 0))
    const remaining = Math.max(0, roundCredit(limitNum - used))
    const remainingPercent = Math.max(0, Math.min(100, Math.round((remaining / limitNum) * 100)))
    return {
      windowKind: 'credits',
      remainingPercent,
      usedPercent: Math.max(0, Math.min(100, 100 - remainingPercent)),
      creditsRemaining: remaining,
      creditsTotal: roundCredit(limitNum),
      creditsUsed: used,
      unlimited: false,
      planType: 'Enterprise',
      resetsAt,
      updatedAt: Date.now(),
    }
  }

  const groups = Array.isArray(data.CreditGroups) ? data.CreditGroups : []
  const packages = Array.isArray(data.Packages) ? data.Packages : []
  const sourceList = groups.length > 0 ? groups : packages
  const hasExplicitTotalCredits =
    data.TotalCredits !== undefined &&
    data.TotalCredits !== null &&
    String(data.TotalCredits).trim() !== '' &&
    Number.isFinite(Number(data.TotalCredits))
  if (sourceList.length === 0 && !hasExplicitTotalCredits) return null

  let totalSum = 0
  let usedSum = 0
  let remainSum = 0
  const creditGroups = []
  let resetsAt = data.CycleResetTime || data.ResetTime ? toEpochMs(data.CycleResetTime || data.ResetTime) : 0
  for (const g of sourceList) {
    if (!g || typeof g !== 'object') continue
    const gTotal = Number(g.CycleTotalCapacity) || 0
    const gUsed = Number(g.CycleUsedCapacity) || 0
    const gRemain = Number(g.CycleRemainCapacity) || 0
    const gReset = g.CycleResetTime || g.ResetTime || g.ExpireTime
    if (gReset && !resetsAt) {
      const ts = toEpochMs(gReset)
      if (ts > 0) resetsAt = ts
    }
    totalSum += gTotal
    usedSum += gUsed
    remainSum += gRemain
    if (g.Name && (gTotal > 0 || gRemain > 0)) {
      creditGroups.push({
        kind: String(g.Kind || ''),
        name: String(g.Name),
        remaining: roundCredit(gRemain),
        total: roundCredit(gTotal),
      })
    }
  }

  const remaining = Math.max(0, roundCredit(hasExplicitTotalCredits ? Number(data.TotalCredits) : remainSum))
  const used = Math.max(0, roundCredit(usedSum))
  const total = roundCredit(totalSum > 0 ? totalSum : (remaining + used))
  const remainingPercent =
    total > 0
      ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
      : (remaining > 0 ? 100 : 0)
  const planType = String(
    data.SubscriptionPackageName || (data.IsPaidUser ? 'Pro' : 'Free'),
  ).trim()

  return {
    windowKind: 'credits',
    remainingPercent,
    usedPercent: Math.max(0, Math.min(100, 100 - remainingPercent)),
    creditsRemaining: remaining,
    creditsTotal: total,
    creditsUsed: used,
    unlimited: false,
    planType,
    creditGroups,
    resetsAt,
    updatedAt: Date.now(),
  }
}

export async function fetchWorkbuddyCreditsQuota({
  authDir = '',
  env = process.env,
  endpointOverride = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = WORKBUDDY_QUOTA_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') return null
  const cred = readStandaloneCodebuddyCredential({ authDir, env })
  if (!cred) return null

  const isEnterprise = Boolean(cred.enterpriseId)
  const baseUrl = endpointOverride
    ? String(endpointOverride).replace(/\/+$/, '')
    : `https://${cred.domain}`
  if (!endpointOverride && !isSafeWorkbuddyAuthUrl(`${baseUrl}/`)) return null

  const path = isEnterprise
    ? '/v2/billing/meter/get-enterprise-user-usage'
    : '/billing/meter/get-user-resource-summary'
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${cred.accessToken}`,
    'Content-Type': 'application/json',
    'X-Domain': cred.domain,
    'Accept-Language': 'zh',
    ...(cred.uid ? { 'X-User-Id': cred.uid } : {}),
    ...(cred.enterpriseId ? { 'X-Enterprise-Id': cred.enterpriseId, 'X-Tenant-Id': cred.enterpriseId } : {}),
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  timer?.unref?.()
  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: '{}',
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!res?.ok) return null
    const json = await res.json()
    if (json && typeof json.code === 'number' && json.code !== 0) return null
    return normalizeWorkbuddyCreditsQuota(json, { isEnterprise })
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function extractTextFromBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text
      if (typeof content.output === 'string') return content.output
    }
    return ''
  }
  return content
    .map((b) => {
      if (typeof b === 'string') return b
      if (!b || typeof b !== 'object') return ''
      if ((b.type === 'text' || b.type === 'input_text' || b.type === 'output_text' || b.type === 'reasoning_text') && typeof b.text === 'string') {
        return b.text
      }
      if (b.type === 'thinking' && typeof b.thinking === 'string') return b.thinking
      if (b.type === 'image_blob_ref') {
        const label = String(b.original_filename || b.filename || b.name || '').trim()
        return label ? `[图片: ${label}]` : '[图片]'
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Strip WorkBuddy Desktop's injected XML wrappers (`<system-reminder>`, `<image_local_path>`,
 * internal compaction `<cb_summary>`) and unwrap `<user_query>` so user turns display cleanly.
 */
export function cleanWorkbuddyUserText(raw) {
  let text = String(raw || '')
  if (!text) return ''
  text = text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
  text = text.replace(/<image_local_path\b[^>]*>[\s\S]*?<\/image_local_path>/gi, '')
  text = text.replace(/<cb_summary\b[^>]*>[\s\S]*?<\/cb_summary>/gi, '')
  text = text.replace(/<user_query\b[^>]*>([\s\S]*?)<\/user_query>/gi, '$1')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

function extractToolOutputText(output) {
  if (output === null || output === undefined) return ''
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return extractTextFromBlocks(output)
  if (typeof output === 'object') {
    if (typeof output.text === 'string') return output.text
    if (typeof output.content === 'string') return output.content
    if (Array.isArray(output.content)) return extractTextFromBlocks(output.content)
    try {
      return JSON.stringify(output)
    } catch {
      return String(output)
    }
  }
  return String(output)
}

function readTailLinesZeroOom(filePath, maxBytes = WORKBUDDY_TAIL_PROBE_BYTES) {
  const st = statSync(filePath)
  const size = st.size
  if (size === 0) return { lines: [], size: 0, mtimeMs: st.mtimeMs }
  const readLen = Math.min(size, maxBytes)
  const offset = Math.max(0, size - readLen)
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(readLen)
    const bytesRead = readSync(fd, buf, 0, readLen, offset)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)
    if (offset > 0 && lines.length > 0) lines.shift()
    return { lines: lines.filter(Boolean), size, mtimeMs: st.mtimeMs }
  } finally {
    closeSync(fd)
  }
}

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
    if (headLines.length > 1) headLines.pop()
    if (tailLines.length > 1) tailLines.shift()
    return [...headLines, ...tailLines].filter(Boolean)
  } finally {
    closeSync(fd)
  }
}

function readWorkbuddyFileForParse(filePath) {
  const st = statSync(filePath)
  if (st.size <= WORKBUDDY_MAX_FULL_PARSE_BYTES) {
    return { headLines: [], bodyLines: readFileSync(filePath, 'utf8').split(/\r?\n/) }
  }
  const fd = openSync(filePath, 'r')
  try {
    const headLen = Math.min(st.size, 32 * 1024)
    const headBuf = Buffer.alloc(headLen)
    const headRead = readSync(fd, headBuf, 0, headLen, 0)
    const headLines = headBuf.subarray(0, headRead).toString('utf8').split(/\r?\n/)
    if (headLines.length > 1) headLines.pop()

    const tailLen = Math.min(st.size, WORKBUDDY_TAIL_FALLBACK_BYTES)
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

/**
 * Read WorkBuddy Desktop SQLite metadata (`workbuddy.db`) strictly read-only.
 * Gracefully degrades to empty maps if `node:sqlite` or `workbuddy.db` is absent.
 */
export function readWorkbuddyDbSnapshot(workbuddyHome) {
  const sessionsById = new Map()
  const workspaces = []
  const seenWs = new Set()

  const addWorkspace = (rawPath, nameHint = '', source = 'workbuddy') => {
    const raw = String(rawPath || '').trim()
    if (!raw) return
    let clean = raw
    try { clean = resolve(raw) } catch {}
    if (!existsSync(clean)) return
    const key = process.platform === 'win32' || process.platform === 'darwin' ? clean.toLowerCase() : clean
    if (seenWs.has(key)) return
    seenWs.add(key)
    const name = String(nameHint || '').trim()
    workspaces.push({
      name: name && !/[\\/]/.test(name) ? name : basename(clean) || clean,
      path: clean,
      source,
    })
  }

  const dbPath = join(workbuddyHome, 'workbuddy.db')
  const DatabaseSync = getDatabaseSync()
  if (!DatabaseSync || !existsSync(dbPath)) {
    return { exists: existsSync(dbPath), sessionsById, workspaces }
  }

  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db
        .prepare(
          `SELECT id, cwd, title, custom_title, status, model, mode, permission_mode, thought_level,
                  created_at, updated_at, deleted_at, source_mode, transport
           FROM sessions
           WHERE deleted_at IS NULL
           ORDER BY updated_at DESC
           LIMIT 240`,
        )
        .all()
      for (const row of rows) {
        const sid = String(row?.id || '').trim()
        if (!sid) continue
        try {
          assertSafeSessionId(sid, 'WorkBuddy sessionId')
        } catch {
          continue
        }
        const cwd = String(row.cwd || '').trim()
        sessionsById.set(sid, {
          id: sid,
          cwd,
          title: String(row.custom_title || row.title || '').trim(),
          status: String(row.status || '').trim(),
          model: String(row.model || '').trim(),
          mode: String(row.mode || row.source_mode || '').trim(),
          permissionMode: String(row.permission_mode || '').trim(),
          thoughtLevel: String(row.thought_level || '').trim(),
          transport: String(row.transport || 'local').trim(),
          createdAt: toEpochMs(row.created_at || 0),
          updatedAt: toEpochMs(row.updated_at || 0),
        })
        if (cwd) addWorkspace(cwd, '', 'workbuddy')
      }
    } catch {}

    try {
      const wsRows = db.prepare('SELECT path, last_opened_at FROM workspaces ORDER BY last_opened_at DESC LIMIT 60').all()
      for (const r of wsRows) {
        if (r?.path) addWorkspace(r.path, '', 'workbuddy')
      }
    } catch {}

    try {
      const spRows = db.prepare('SELECT id, name, primary_folder_path, create_folder_path FROM spaces LIMIT 60').all()
      const spaceNames = new Map()
      for (const sp of spRows) {
        if (sp?.id && sp?.name) spaceNames.set(String(sp.id), String(sp.name))
        if (sp?.primary_folder_path) addWorkspace(sp.primary_folder_path, sp.name || '', 'workbuddy')
        if (sp?.create_folder_path) addWorkspace(sp.create_folder_path, sp.name || '', 'workbuddy')
      }
      const sfRows = db.prepare('SELECT space_id, path FROM space_folders LIMIT 120').all()
      for (const sf of sfRows) {
        if (sf?.path) addWorkspace(sf.path, spaceNames.get(String(sf.space_id)) || '', 'workbuddy')
      }
    } catch {}
  } catch {
    // Ignore SQLite busy/corrupt errors; JSONL scanning still works cleanly
  } finally {
    try { db?.close?.() } catch {}
  }

  return { exists: true, sessionsById, workspaces }
}

/**
 * Zero-OOM tail probe for WorkBuddy / CodeBuddy `.jsonl` transcripts.
 */
export function probeWorkbuddyTranscriptTail(filePath, { now = Date.now(), maxIdleMs = WORKBUDDY_EXTERNAL_MAX_IDLE_MS } = {}) {
  const empty = {
    exists: false,
    size: 0,
    mtimeMs: 0,
    running: false,
    lastToolName: '',
    lastTextPreview: '',
  }
  if (!filePath || !existsSync(filePath)) return empty

  let tail
  try {
    tail = readTailLinesZeroOom(filePath, WORKBUDDY_TAIL_PROBE_BYTES)
  } catch {
    return empty
  }

  const parseTail = (lines) => {
    let signal = 'unknown'
    let seenSignal = false
    let lastToolName = ''
    let lastTextPreview = ''

    for (const line of lines) {
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const type = String(obj.type || '')
      const role = String(obj.role || obj.message?.role || '')

      if (type === 'result') {
        signal = 'idle'
        seenSignal = true
        continue
      }

      // WorkBuddy OpenAI-Responses-style events
      if (type === 'reasoning') {
        signal = 'active'
        seenSignal = true
        continue
      }
      if (type === 'function_call') {
        if (obj.name) lastToolName = String(obj.name)
        signal = 'active'
        seenSignal = true
        continue
      }
      if (type === 'function_call_result') {
        if (obj.name) lastToolName = String(obj.name)
        signal = 'active'
        seenSignal = true
        continue
      }
      if (type === 'message') {
        const txt = role === 'user'
          ? cleanWorkbuddyUserText(extractTextFromBlocks(obj.content))
          : extractTextFromBlocks(obj.content).trim()
        if (role === 'user') {
          if (txt) {
            signal = 'active'
            seenSignal = true
          }
        } else if (role === 'assistant') {
          if (txt) lastTextPreview = txt
          const st = String(obj.status || '').toLowerCase()
          if (st === 'in_progress' || st === 'streaming' || st === 'pending') {
            signal = 'active'
            seenSignal = true
          } else {
            signal = 'idle'
            seenSignal = true
          }
        }
        continue
      }

      // Standard CodeBuddy/Claude CLI JSONL events
      if (type === 'assistant') {
        const blocks = Array.isArray(obj.message?.content) ? obj.message.content : []
        let hasToolUse = false
        for (const b of blocks) {
          if (b?.type === 'tool_use') {
            hasToolUse = true
            if (b.name) lastToolName = String(b.name)
          } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            lastTextPreview = b.text.trim()
          }
        }
        if (hasToolUse) {
          signal = 'active'
          seenSignal = true
        } else if (obj.message?.stop_reason === 'end_turn') {
          signal = 'idle'
          seenSignal = true
        }
        continue
      }
      if (type === 'user' && !obj.isMeta) {
        const txt = cleanWorkbuddyUserText(extractTextFromBlocks(obj.message?.content))
        if (txt) {
          signal = 'active'
          seenSignal = true
        }
      }
    }

    return { signal, seenSignal, lastToolName, lastTextPreview }
  }

  let parsed = parseTail(tail.lines)
  if (!parsed.seenSignal && tail.size > WORKBUDDY_TAIL_PROBE_BYTES) {
    try {
      const bigger = readTailLinesZeroOom(filePath, WORKBUDDY_TAIL_PROBE_MAX_BYTES)
      tail = bigger
      parsed = parseTail(bigger.lines)
    } catch {}
  }

  const fresh = now - tail.mtimeMs <= maxIdleMs
  const running = parsed.signal === 'active' && fresh
  return {
    exists: true,
    size: tail.size,
    mtimeMs: tail.mtimeMs,
    running,
    lastToolName: parsed.lastToolName,
    lastTextPreview: parsed.lastTextPreview,
  }
}

function probeWorkbuddyPidDir(sessionsDir, { targetSessionId = '', checkPidAlive = isPidAlive } = {}) {
  if (!sessionsDir || !existsSync(sessionsDir)) return null
  let best = null
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith('.json')) continue
      let data
      try {
        data = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'))
      } catch {
        continue
      }
      if (!data || typeof data !== 'object') continue
      const sid = String(data.sessionId || '').trim()
      if (targetSessionId && sid && sid !== targetSessionId) continue
      const pid = Number(data.pid || 0)
      if (!checkPidAlive(pid)) continue
      const status = String(data.status || '').toLowerCase()
      const busy = status === 'busy' || status === 'running' || status === 'thinking' || status === 'streaming'
      const updatedAt = toEpochMs(data.statusUpdatedAt || data.updatedAt || data.startedAt || 0)
      if (!best || (busy && !best.busy) || (busy === best.busy && updatedAt > best.updatedAt)) {
        best = { alive: true, busy, status, pid, sessionId: sid, updatedAt }
      }
    }
  } catch {}
  return best
}

function isDbStatusActive(rawStatus) {
  const st = String(rawStatus || '').trim().toLowerCase()
  return st === 'running' || st === 'streaming' || st === 'in_progress' || st === 'working' || st === 'thinking'
}

export function probeWorkbuddyExternalStatus({
  pidSessionsDir = '',
  targetSessionId = '',
  transcriptPath = '',
  dbStatus = '',
  dbUpdatedAt = 0,
  now = Date.now(),
  maxIdleMs = WORKBUDDY_EXTERNAL_MAX_IDLE_MS,
  checkPidAlive = isPidAlive,
} = {}) {
  const pidInfo = probeWorkbuddyPidDir(pidSessionsDir, { targetSessionId, checkPidAlive })
  const tail = transcriptPath ? probeWorkbuddyTranscriptTail(transcriptPath, { now, maxIdleMs }) : null
  const dbActive = isDbStatusActive(dbStatus) && dbUpdatedAt > 0 && now - dbUpdatedAt <= maxIdleMs

  let running = false
  if (pidInfo?.alive && pidInfo.busy) {
    running = true
  } else if (tail?.running) {
    running = true
  } else if (dbActive && (!tail?.exists || tail.mtimeMs >= dbUpdatedAt - 5_000)) {
    running = true
  }

  return {
    running,
    pidAlive: Boolean(pidInfo?.alive),
    lastToolName: tail?.lastToolName || '',
    lastTextPreview: tail?.lastTextPreview || '',
    size: tail?.size || 0,
    mtimeMs: Math.max(tail?.mtimeMs || 0, pidInfo?.updatedAt || 0, dbUpdatedAt || 0),
  }
}

function scanWorkbuddySessionSummary(filePath, fallbackProjectName) {
  let st
  try {
    st = statSync(filePath)
  } catch {
    return null
  }
  const sessionId = basename(filePath, '.jsonl')
  if (!sessionId || sessionId.startsWith('agent-')) return null
  try {
    assertSafeSessionId(sessionId, 'WorkBuddy sessionId')
  } catch {
    return null
  }

  let lines = []
  try {
    lines = readHeadAndTailLines(filePath)
  } catch {
    return null
  }

  let cwd = ''
  let customTitle = ''
  let aiTitle = ''
  let firstUserText = ''
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
    if (!cwd && typeof obj.cwd === 'string' && obj.cwd.trim()) cwd = obj.cwd.trim()
    if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
      customTitle = obj.customTitle.trim()
    }
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
      aiTitle = obj.aiTitle.trim()
    }
    const pdModel = obj.providerData?.requestModelId || obj.providerData?.model
    if (typeof pdModel === 'string' && pdModel.trim()) model = pdModel.trim()

    if (obj.type === 'message' && obj.role === 'user') {
      const txt = cleanWorkbuddyUserText(extractTextFromBlocks(obj.content))
      if (txt && !firstUserText) {
        firstUserText = txt
        if (obj.timestamp) createdAt = toEpochMs(obj.timestamp) || createdAt
      }
    } else if (obj.type === 'message' && obj.role === 'assistant') {
      const txt = extractTextFromBlocks(obj.content).trim()
      if (txt) lastAssistantText = txt
    } else if (obj.type === 'user' && !obj.isMeta && !obj.isSidechain) {
      const txt = cleanWorkbuddyUserText(extractTextFromBlocks(obj.message?.content))
      if (txt && !firstUserText) {
        firstUserText = txt
        if (obj.timestamp) createdAt = toEpochMs(obj.timestamp) || createdAt
      }
    } else if (obj.type === 'assistant' && !obj.isSidechain) {
      if (obj.message?.model) model = String(obj.message.model)
      const txt = extractTextFromBlocks(obj.message?.content).trim()
      if (txt) lastAssistantText = txt
    }
  }

  if (!firstUserText && !customTitle && !aiTitle && !lastAssistantText) return null

  const title =
    customTitle ||
    aiTitle ||
    firstUserText.replace(/\s+/g, ' ').slice(0, 56) ||
    sessionId
  const preview = (lastAssistantText || firstUserText).replace(/\s+/g, ' ').slice(0, 120)

  return {
    id: makeCompositeId(APPS.WORKBUDDY, sessionId),
    app: APPS.WORKBUDDY,
    nativeId: sessionId,
    title,
    preview,
    cwd,
    workspace: cwd ? basename(cwd) : fallbackProjectName || 'WorkBuddy',
    model: model || 'auto',
    status: 'idle',
    filePath,
    createdAt: toEpochMs(createdAt),
    updatedAt: st.mtimeMs,
  }
}

/**
 * Parse a WorkBuddy / CodeBuddy JSONL transcript into All in One's unified message & taskState model.
 * Supports both WorkBuddy Desktop OpenAI-Responses-style lines and CodeBuddy/Claude CLI lines.
 */
export function parseWorkbuddyJsonlMessages(filePath) {
  return workbuddyParseCache.getOrParse(filePath, () => {
    const { headLines, bodyLines } = readWorkbuddyFileForParse(filePath)
    const messages = []
    const toolIndex = new Map()
    const taskTracker = createTaskStateTracker()
    let cwd = ''
    let title = ''
    let customTitle = ''
    let model = ''
    let pendingThinking = ''

    for (const line of headLines) {
      if (!line.trim()) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (!cwd && typeof obj.cwd === 'string' && obj.cwd.trim()) cwd = obj.cwd.trim()
      if (obj.type === 'custom-title' && obj.customTitle) customTitle = String(obj.customTitle).trim()
      if (obj.type === 'ai-title' && obj.aiTitle) title = String(obj.aiTitle).trim()
      const pdModel = obj.providerData?.requestModelId || obj.providerData?.model || obj.message?.model
      if (!model && typeof pdModel === 'string' && pdModel.trim()) model = pdModel.trim()
    }

    const ensureAssistantMsg = (id, ts) => {
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        if (pendingThinking) {
          last.thinking = last.thinking ? `${last.thinking}\n\n${pendingThinking}` : pendingThinking
          pendingThinking = ''
        }
        return last
      }
      const msg = {
        id: id || `wb-a-${messages.length}`,
        role: 'assistant',
        text: '',
        ...(pendingThinking ? { thinking: pendingThinking } : {}),
        tools: [],
        ts,
      }
      pendingThinking = ''
      messages.push(msg)
      return msg
    }

    for (const line of bodyLines) {
      if (!line.trim()) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (!cwd && typeof obj.cwd === 'string' && obj.cwd.trim()) cwd = obj.cwd.trim()
      if (obj.type === 'custom-title' && obj.customTitle) customTitle = String(obj.customTitle).trim()
      if (obj.type === 'ai-title' && obj.aiTitle) title = String(obj.aiTitle).trim()
      if (obj.isSidechain) continue

      const pdModel = obj.providerData?.requestModelId || obj.providerData?.model || obj.message?.model
      if (typeof pdModel === 'string' && pdModel.trim()) model = pdModel.trim()

      const ts = toEpochMs(obj.timestamp || Date.now())

      // Format 1: WorkBuddy OpenAI-Responses-style JSONL
      if (obj.type === 'message' && obj.role === 'user') {
        const text = cleanWorkbuddyUserText(extractTextFromBlocks(obj.content))
        if (!text) continue
        if (!title) title = text.replace(/\s+/g, ' ').slice(0, 56)
        pendingThinking = ''
        messages.push({
          id: obj.id || `wb-u-${messages.length}`,
          role: 'user',
          text,
          ts,
        })
        continue
      }

      if (obj.type === 'reasoning') {
        const rText = (
          extractTextFromBlocks(obj.rawContent) ||
          extractTextFromBlocks(obj.content) ||
          (typeof obj.providerData?.reasoning === 'string' ? obj.providerData.reasoning : '')
        ).trim()
        if (rText) {
          pendingThinking = pendingThinking ? `${pendingThinking}\n\n${rText}` : rText
        }
        continue
      }

      if (obj.type === 'function_call') {
        const toolId = String(obj.callId || obj.id || `wb-t-${messages.length}-${toolIndex.size}`)
        const toolName = String(obj.name || 'tool')
        const parsedArgs = parseMaybeJson(obj.arguments)
        const toolInput = parsedArgs && typeof parsedArgs === 'object' ? parsedArgs : (obj.arguments ? { raw: String(obj.arguments) } : {})
        if (typeof obj.providerData?.reasoning === 'string' && obj.providerData.reasoning.trim()) {
          const r = obj.providerData.reasoning.trim()
          if (!pendingThinking.includes(r)) {
            pendingThinking = pendingThinking ? `${pendingThinking}\n\n${r}` : r
          }
        }
        const msg = ensureAssistantMsg(obj.id, ts)
        if (!Array.isArray(msg.tools)) msg.tools = []
        const toolEntry = {
          id: toolId,
          name: toolName,
          input: toolInput,
          status: 'completed',
          output: '',
        }
        msg.tools.push(toolEntry)
        toolIndex.set(toolId, toolEntry)
        taskTracker.applyClaudeTool(toolName, toolInput, ts)
        continue
      }

      if (obj.type === 'function_call_result') {
        const callId = String(obj.callId || '')
        const existing = callId ? toolIndex.get(callId) : null
        const outText = extractToolOutputText(obj.output).slice(0, 4000)
        const isErr = String(obj.status || '').toLowerCase() === 'error' || String(obj.status || '').toLowerCase() === 'failed'
        if (existing) {
          existing.status = isErr ? 'error' : 'completed'
          existing.output = outText
        }
        continue
      }

      if (obj.type === 'message' && obj.role === 'assistant') {
        const text = extractTextFromBlocks(obj.content).trim()
        if (!text && !pendingThinking) continue
        const msg = ensureAssistantMsg(obj.id, ts)
        if (text) {
          msg.text = msg.text ? `${msg.text}\n\n${text}` : text
        }
        continue
      }

      // Format 2: Standard CodeBuddy/Claude stream-json transcript
      if (obj.type === 'user' && !obj.isMeta) {
        const content = obj.message?.content
        if (Array.isArray(content)) {
          let handledToolResult = false
          for (const b of content) {
            if (b?.type === 'tool_result' && b.tool_use_id) {
              handledToolResult = true
              const tEntry = toolIndex.get(b.tool_use_id)
              if (tEntry) {
                tEntry.status = b.is_error ? 'error' : 'completed'
                tEntry.output = extractToolOutputText(b.content).slice(0, 4000)
              }
            }
          }
          if (handledToolResult) continue
        }
        const text = cleanWorkbuddyUserText(extractTextFromBlocks(content))
        if (!text) continue
        if (!title) title = text.replace(/\s+/g, ' ').slice(0, 56)
        pendingThinking = ''
        messages.push({
          id: obj.uuid || `wb-u-${messages.length}`,
          role: 'user',
          text,
          ts,
        })
        continue
      }

      if (obj.type === 'assistant') {
        const blocks = Array.isArray(obj.message?.content) ? obj.message.content : []
        let aText = ''
        let aThink = ''
        const aTools = []
        for (const b of blocks) {
          if (b?.type === 'thinking' && b.thinking) {
            aThink += aThink ? `\n\n${b.thinking}` : b.thinking
          } else if (b?.type === 'text' && typeof b.text === 'string') {
            aText += aText ? `\n${b.text}` : b.text
          } else if (b?.type === 'tool_use' && b.id) {
            const tEntry = {
              id: b.id,
              name: b.name || 'tool',
              input: b.input ?? {},
              status: 'completed',
              output: '',
            }
            aTools.push(tEntry)
            toolIndex.set(b.id, tEntry)
            taskTracker.applyClaudeTool(tEntry.name, tEntry.input, ts)
          }
        }
        if (aThink) {
          pendingThinking = pendingThinking ? `${pendingThinking}\n\n${aThink}` : aThink
        }
        if (aText.trim() || aTools.length > 0 || pendingThinking) {
          const msg = ensureAssistantMsg(obj.uuid || obj.message?.id, ts)
          if (aText.trim()) msg.text = msg.text ? `${msg.text}\n\n${aText.trim()}` : aText.trim()
          if (aTools.length > 0) {
            if (!Array.isArray(msg.tools)) msg.tools = []
            msg.tools.push(...aTools)
          }
        }
      }
    }

    if (pendingThinking) {
      const msg = ensureAssistantMsg(`wb-a-${messages.length}`, Date.now())
      if (!msg.thinking) msg.thinking = pendingThinking
    }

    return {
      cwd,
      title: customTitle || title,
      model,
      messages: mergeAndCompactMessages(messages),
      taskState: taskTracker.snapshot(),
    }
  })
}

/**
 * WorkBuddy Adapter (5th AI tool):
 *  - Zero-config read & live sync of WorkBuddy Desktop sessions (`~/.workbuddy/workbuddy.db` + `projects/*.jsonl`)
 *    plus standalone CodeBuddy CLI sessions (`~/.codebuddy/projects/*.jsonl`).
 *  - Writable streaming execution, resume (`--resume`), new sessions (`--session-id`), model & effort selection,
 *    and interactive approvals when the official standalone `@tencent-ai/codebuddy-code` CLI (`codebuddy` / `cbc`)
 *    is installed and signed in (same Tencent account & shared Credits quota as WorkBuddy Desktop).
 */
export class WorkBuddyAdapter {
  constructor({ config = {}, log = console, emitEvent, onApprovalRequest } = {}) {
    this.config = config
    this.log = log
    this.emitEvent = emitEvent || (() => {})
    this.onApprovalRequest = onApprovalRequest || (() => {})
    this.workbuddyHome = getWorkbuddyHome(config.workbuddyHome)
    this.codebuddyHome = getCodebuddyHome(config.codebuddyHome)
    this.authDir = getCodebuddyAuthDir({ configuredDir: config.workbuddyAuthDir || '' })
    this.assumeAuthenticated = config.workbuddyAssumeAuth === true
    this.configuredBin = config.workbuddyCliBin || config.codebuddyBin || ''
    this.codebuddyBin = findCodebuddyCommand(this.configuredBin)
    this.defaultCwd = config.cwd || process.cwd()
    this.permissionMode = ALLOWED_WORKBUDDY_PERMISSION_MODES.includes(config.workbuddyPermissionMode)
      ? config.workbuddyPermissionMode
      : 'acceptEdits'
    this.watchPollMs = Math.max(50, Number(config.workbuddyWatchPollMs) || WORKBUDDY_WATCH_POLL_MS)
    this.externalMaxIdleMs = Math.max(5_000, Number(config.workbuddyExternalMaxIdleMs) || WORKBUDDY_EXTERNAL_MAX_IDLE_MS)
    this.checkPidAlive = typeof config.checkPidAlive === 'function' ? config.checkPidAlive : isPidAlive
    this.installCliFn = typeof config.installWorkbuddyCli === 'function'
      ? config.installWorkbuddyCli
      : () => installSingleAppCli('workbuddy', { log: this.log })

    /** @type {Map<string, any>} */
    this.activeProcs = new Map()
    /** @type {Map<string, any>} */
    this.pendingCreated = new Map()
    /** @type {Map<string, { model: string, reasoningEffort: string }>} */
    this.sessionPrefs = new Map()
    /** @type {Map<string, any>} */
    this.pendingControlRequests = new Map()
    /** @type {Map<string, any>} */
    this.sessionTaskStates = new Map()
    /** @type {Map<string, any>} */
    this.watchedSessions = new Map()
    /** @type {Map<string, any>} */
    this.trackedListSessions = new Map()
    this.watchTimer = null
    this.watchPollInFlight = false
    this.lastClientListAt = 0
    this.lastListDiscoveryAt = 0
    this.cliAvailableCache = null
    this.cliCheckedAt = 0
    this.cliAuthenticated = false
    this.activeLoginSession = null
    this.quotaCache = null
    this.quotaCacheAt = 0
    this.quotaFetchInFlight = null
    this.quotaEndpointOverride = String(config.workbuddyQuotaEndpoint || '').trim()
    this.fetchQuotaFn = typeof config.fetchWorkbuddyQuota === 'function'
      ? config.fetchWorkbuddyQuota
      : () => fetchWorkbuddyCreditsQuota({
          authDir: this.authDir,
          endpointOverride: this.quotaEndpointOverride,
        })
    this.disposed = false
  }

  refreshBinary() {
    this.codebuddyBin = findCodebuddyCommand(this.configuredBin)
    this.cliAvailableCache = null
    this.cliCheckedAt = 0
  }

  getProjectsRoots() {
    const roots = []
    const seen = new Set()
    for (const base of [this.workbuddyHome, this.codebuddyHome]) {
      if (!base) continue
      const pDir = join(base, 'projects')
      const key = process.platform === 'win32' || process.platform === 'darwin' ? pDir.toLowerCase() : pDir
      if (seen.has(key)) continue
      seen.add(key)
      if (existsSync(pDir)) roots.push({ base, projectsDir: pDir })
    }
    return roots
  }

  async probeCliVersion({ force = false } = {}) {
    const now = Date.now()
    if (!force && this.cliAvailableCache !== null && now - this.cliCheckedAt < 30_000) {
      return this.cliAvailableCache
    }
    this.codebuddyBin = findCodebuddyCommand(this.configuredBin)
    if (!this.codebuddyBin) {
      this.cliAvailableCache = false
      this.cliCheckedAt = now
      return false
    }
    const ver = await new Promise((resolvePromise) => {
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
        proc = spawnCrossPlatform(this.codebuddyBin, ['--version'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        let out = ''
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => { out += d })
        proc.on('close', (code) => done(code === 0 ? (out.trim() || 'codebuddy') : false))
        proc.on('error', () => done(false))
      } catch {
        done(false)
      }
    })
    this.cliAvailableCache = ver
    this.cliCheckedAt = now
    return ver
  }

  isCliAuthenticated() {
    if (this.assumeAuthenticated || this.cliAuthenticated) return true
    return hasStandaloneCodebuddyAuth({ authDir: this.authDir })
  }

  async isWritableReady({ forceCliProbe = false } = {}) {
    const cliVer = await this.probeCliVersion({ force: forceCliProbe })
    return Boolean(cliVer && this.isCliAuthenticated())
  }

  async refreshQuotaInBackground({ force = false } = {}) {
    if (this.disposed) return this.quotaCache
    const now = Date.now()
    if (!force && this.quotaCache && this.quotaCacheAt > 0 && now - this.quotaCacheAt < WORKBUDDY_QUOTA_CACHE_TTL_MS) {
      return this.quotaCache
    }
    if (this.quotaFetchInFlight) return this.quotaFetchInFlight
    const task = Promise.resolve()
      .then(() => this.fetchQuotaFn())
      .then((fresh) => {
        if (this.disposed) return null
        this.quotaCacheAt = Date.now()
        if (fresh) {
          this.quotaCache = fresh
          this.emitEvent(EVENTS.BRIDGE_STATUS, {
            type: 'quota.updated',
            app: APPS.WORKBUDDY,
            quota: fresh,
          })
        }
        return this.quotaCache
      })
      .catch(() => this.quotaCache)
      .finally(() => {
        if (this.quotaFetchInFlight === task) this.quotaFetchInFlight = null
      })
    this.quotaFetchInFlight = task
    return task
  }

  async getStatus(opts = {}) {
    const forceQuota = Boolean(opts?.forceQuota)
    const cliVersion = await this.probeCliVersion({ force: true })
    const dbSnap = readWorkbuddyDbSnapshot(this.workbuddyHome)
    const projectRoots = this.getProjectsRoots()
    const hasLocalData = dbSnap.exists || projectRoots.length > 0 || dbSnap.sessionsById.size > 0
    const cliInstalled = Boolean(cliVersion)
    const authenticated = cliInstalled && this.isCliAuthenticated()
    const writable = cliInstalled && authenticated
    const sessionCount = dbSnap.sessionsById.size

    let quota = this.quotaCache
    if (authenticated || hasStandaloneCodebuddyAuth({ authDir: this.authDir })) {
      const now = Date.now()
      const stale = forceQuota || !quota || now - this.quotaCacheAt >= WORKBUDDY_QUOTA_CACHE_TTL_MS
      if (stale) {
        const refreshPromise = this.refreshQuotaInBackground({ force: forceQuota })
        if (!quota || forceQuota) {
          // On cold start or explicit refresh give the lightweight summary API up to 2.2s
          let t = null
          try {
            const fresh = await Promise.race([
              refreshPromise,
              new Promise((r) => {
                t = setTimeout(() => r(null), forceQuota ? 2_200 : 1_800)
                t.unref?.()
              }),
            ])
            if (fresh) quota = fresh
          } finally {
            if (t) clearTimeout(t)
          }
        }
      }
    }

    const setupState = writable
      ? 'ready'
      : cliInstalled
        ? 'needs_login'
        : hasLocalData
          ? 'needs_cli'
          : 'unavailable'

    const detail = writable
      ? `已连接 CodeBuddy CLI (${cliVersion})，支持 WorkBuddy 桌面端会话同步与远程流式收发（同账号共用额度）`
      : cliInstalled
        ? `WorkBuddy 引擎 (${cliVersion}) 已自动就绪，点击「一键扫码登录」即可解锁远程发送（同账号共用额度）`
        : hasLocalData
          ? `已接入 WorkBuddy 桌面端实时只读同步${sessionCount > 0 ? `（${sessionCount} 条本地会话）` : ''}；点击「一键启用发送」可自动安装官方引擎并微信扫码解锁`
          : '未检测到 WorkBuddy 桌面端或 codebuddy CLI'

    return {
      app: APPS.WORKBUDDY,
      available: cliInstalled || hasLocalData,
      writable,
      mode: writable ? 'codebuddy-cli-stream' : 'readonly',
      setupState,
      cliInstalled,
      authenticated,
      loginInProgress: Boolean(this.activeLoginSession),
      detail,
      activeCount: this.activeProcs.size,
      ...(quota ? { quota } : {}),
    }
  }

  stopActiveLoginSession() {
    const cur = this.activeLoginSession
    if (!cur) return
    this.activeLoginSession = null
    if (cur.timer) clearTimeout(cur.timer)
    try { cur.proc?.stdin?.end?.() } catch {}
    if (cur.proc) killProcessTree(cur.proc, { force: true })
  }

  /**
   * Zero-terminal 1-click WorkBuddy RW activation:
   *  1) Auto-installs official native CodeBuddy CLI (SHA-256 verified, zero Node.js required) if missing
   *  2) Starts official ACP `authenticate({ methodId })` and returns the trusted official OAuth URL
   *     (`_codebuddy.ai/authUrl`) so users on Desktop or Mobile can scan WeChat QR in 1 click.
   */
  async runSetup({ action = 'setup', methodId = 'internal' } = {}) {
    const cleanMethod = methodId === 'external' ? 'external' : 'internal'
    if (action === 'status') {
      const st = await this.getStatus()
      return {
        ok: true,
        status: st.writable ? 'ready' : st.loginInProgress ? 'awaiting_login' : st.setupState,
        writable: st.writable,
        setupState: st.setupState,
        authUrl: this.activeLoginSession?.authUrl || '',
        methodId: this.activeLoginSession?.methodId || cleanMethod,
      }
    }

    // Step 1: Ensure standalone CodeBuddy CLI is installed (silent official native installer)
    let cliVersion = await this.probeCliVersion({ force: true })
    if (!cliVersion) {
      const installRes = await this.installCliFn()
      this.refreshBinary()
      cliVersion = await this.probeCliVersion({ force: true })
      if (!cliVersion) {
        return {
          ok: false,
          status: 'install_failed',
          writable: false,
          setupState: 'needs_cli',
          error: installRes?.error || '自动安装官方 CodeBuddy CLI 失败，请检查网络连接后重试',
        }
      }
    }

    // Step 2: Already authenticated?
    if (this.isCliAuthenticated()) {
      return {
        ok: true,
        status: 'ready',
        writable: true,
        setupState: 'ready',
        message: 'WorkBuddy 远程发送权限已就绪',
      }
    }

    // Step 3: Reuse an active login attempt for the same method if we already have its authUrl
    if (
      this.activeLoginSession &&
      this.activeLoginSession.methodId === cleanMethod &&
      Date.now() - this.activeLoginSession.startedAt < 120_000
    ) {
      return {
        ok: true,
        status: 'awaiting_login',
        writable: false,
        setupState: 'needs_login',
        authUrl: this.activeLoginSession.authUrl || '',
        methodId: cleanMethod,
        message: '请在打开的腾讯官方授权页面完成扫码登录，完成后自动解锁发送',
      }
    }

    this.stopActiveLoginSession()

    const spawnEnv = {
      ...process.env,
      CODEBUDDY_CONFIG_DIR: existsSync(this.workbuddyHome) ? this.workbuddyHome : this.codebuddyHome,
      WORKBUDDY_CONFIG_DIR: this.workbuddyHome,
      CODEBUDDY_INTERNET_ENVIRONMENT: cleanMethod,
    }

    let proc
    try {
      proc = spawnCrossPlatform(this.codebuddyBin, ['--acp'], {
        cwd: existsSync(this.defaultCwd) ? this.defaultCwd : homedir(),
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      return {
        ok: false,
        status: 'login_failed',
        writable: false,
        setupState: 'needs_login',
        error: `无法启动官方登录流程：${String(err?.message || err)}`,
      }
    }

    proc.stdout.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdin?.on('error', () => {})

    const loginState = {
      proc,
      methodId: cleanMethod,
      authUrl: '',
      startedAt: Date.now(),
      timer: null,
    }
    this.activeLoginSession = loginState

    // Auto-expire login ACP process after 3 minutes so no orphan lingers
    loginState.timer = setTimeout(() => {
      if (this.activeLoginSession === loginState) {
        this.stopActiveLoginSession()
      }
    }, 180_000)
    loginState.timer.unref?.()

    return new Promise((resolvePromise) => {
      let settled = false
      let stdoutBuf = ''
      let stderrBuf = ''
      let authSent = false

      const settle = (payload) => {
        if (settled) return
        settled = true
        clearTimeout(waitUrlTimer)
        resolvePromise(payload)
      }

      const waitUrlTimer = setTimeout(() => {
        settle({
          ok: true,
          status: 'awaiting_login',
          writable: false,
          setupState: 'needs_login',
          authUrl: loginState.authUrl || '',
          methodId: cleanMethod,
          message: loginState.authUrl
            ? '请在弹出的腾讯官方页面完成扫码授权，授权成功后自动解锁'
            : '已在电脑端拉起官方浏览器授权页，请完成扫码登录后自动解锁',
        })
      }, 8_000)
      waitUrlTimer.unref?.()

      const handleLine = (line) => {
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          // Fallback: scan plain URLs in case a CLI build prints the official auth URL directly
          const m = line.match(/https:\/\/[^\s"'<>]+/i)
          if (m && isSafeWorkbuddyAuthUrl(m[0]) && !loginState.authUrl) {
            loginState.authUrl = m[0]
            settle({
              ok: true,
              status: 'awaiting_login',
              writable: false,
              setupState: 'needs_login',
              authUrl: loginState.authUrl,
              methodId: cleanMethod,
              message: '请在打开的腾讯官方授权页面完成扫码登录，完成后自动解锁发送',
            })
          }
          return
        }

        // Capture official ACP `_codebuddy.ai/authUrl` notification
        const candUrl = msg?.params?.authUrl || msg?.result?.authUrl || ''
        if (candUrl && isSafeWorkbuddyAuthUrl(candUrl)) {
          loginState.authUrl = String(candUrl).trim()
          settle({
            ok: true,
            status: 'awaiting_login',
            writable: false,
            setupState: 'needs_login',
            authUrl: loginState.authUrl,
            methodId: cleanMethod,
            message: '请在打开的腾讯官方授权页面完成扫码登录，完成后自动解锁发送',
          })
          return
        }

        // Initialize response -> trigger official ACP `authenticate`
        if (msg?.id === 1 && !authSent) {
          authSent = true
          try {
            proc.stdin.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'authenticate',
                params: { methodId: cleanMethod },
              })}\n`,
              'utf8',
            )
          } catch {}
          return
        }

        // Authenticate finished!
        if (msg?.id === 2) {
          if (msg.error) {
            const errMsg = String(msg.error?.message || '官方登录授权未完成或已取消')
            if (this.activeLoginSession === loginState) this.stopActiveLoginSession()
            settle({
              ok: false,
              status: 'login_failed',
              writable: false,
              setupState: 'needs_login',
              error: errMsg,
            })
          } else {
            this.cliAuthenticated = true
            if (this.activeLoginSession === loginState) this.stopActiveLoginSession()
            this.emitEvent(EVENTS.SESSION_UPDATED, {
              externalUpdate: true,
              authReady: true,
              app: APPS.WORKBUDDY,
            })
            settle({
              ok: true,
              status: 'ready',
              writable: true,
              setupState: 'ready',
              message: 'WorkBuddy 授权成功，已解锁远程发送！',
            })
          }
        }
      }

      proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk
        let idx
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim()
          stdoutBuf = stdoutBuf.slice(idx + 1)
          if (line) handleLine(line)
        }
      })

      proc.stderr?.on('data', (chunk) => {
        const text = String(chunk || '')
        stderrBuf = (stderrBuf + text).slice(-2048)
        const m = text.match(/https:\/\/[^\s"'<>]+/i)
        if (m && isSafeWorkbuddyAuthUrl(m[0]) && !loginState.authUrl) {
          loginState.authUrl = m[0]
          settle({
            ok: true,
            status: 'awaiting_login',
            writable: false,
            setupState: 'needs_login',
            authUrl: loginState.authUrl,
            methodId: cleanMethod,
            message: '请在打开的腾讯官方授权页面完成扫码登录，完成后自动解锁发送',
          })
        }
      })

      proc.on('error', (err) => {
        if (this.activeLoginSession === loginState) this.stopActiveLoginSession()
        settle({
          ok: false,
          status: 'login_failed',
          writable: false,
          setupState: 'needs_login',
          error: `登录进程异常：${String(err?.message || err)}`,
        })
      })

      proc.on('close', (code) => {
        if (this.activeLoginSession === loginState) {
          if (loginState.timer) clearTimeout(loginState.timer)
          this.activeLoginSession = null
        }
        if (this.isCliAuthenticated()) {
          this.cliAuthenticated = true
          void this.refreshQuotaInBackground({ force: true })
          this.emitEvent(EVENTS.SESSION_UPDATED, {
            externalUpdate: true,
            authReady: true,
            app: APPS.WORKBUDDY,
          })
          settle({
            ok: true,
            status: 'ready',
            writable: true,
            setupState: 'ready',
            message: 'WorkBuddy 授权成功，已解锁远程发送！',
          })
          return
        }
        settle({
          ok: false,
          status: 'login_failed',
          writable: false,
          setupState: 'needs_login',
          error: stderrBuf.trim() || `官方登录流程提前退出（code=${code}）`,
        })
      })

      // Kick off ACP handshake
      try {
        proc.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: 1,
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
              clientInfo: { name: 'allinone', version: '1.0.29' },
            },
          })}\n`,
          'utf8',
        )
      } catch (err) {
        if (this.activeLoginSession === loginState) this.stopActiveLoginSession()
        settle({
          ok: false,
          status: 'login_failed',
          writable: false,
          setupState: 'needs_login',
          error: String(err?.message || err),
        })
      }
    })
  }

  async listWorkspaces() {
    const dbSnap = readWorkbuddyDbSnapshot(this.workbuddyHome)
    return dbSnap.workspaces
  }

  async listModels() {
    const models = WORKBUDDY_BASE_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }))
    const seen = new Set(models.map((m) => m.id.toLowerCase()))

    // Merge any custom models configured in ~/.workbuddy/models.json or ~/.codebuddy/models.json
    for (const base of [this.workbuddyHome, this.codebuddyHome]) {
      const modelsPath = join(base, 'models.json')
      if (!existsSync(modelsPath)) continue
      try {
        const parsed = JSON.parse(readFileSync(modelsPath, 'utf8'))
        const list = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.models)
            ? parsed.models
            : []
        for (const item of list) {
          const id = String(item?.id || item?.modelId || item?.model || '').trim()
          if (!id || seen.has(id.toLowerCase())) continue
          seen.add(id.toLowerCase())
          models.push({
            id,
            name: String(item?.name || item?.displayName || id).trim(),
            efforts: [...WORKBUDDY_DEFAULT_EFFORTS],
            defaultEffort: 'high',
          })
        }
      } catch {}
    }

    return {
      app: APPS.WORKBUDDY,
      defaultModel: 'auto',
      defaultEffort: 'high',
      supportsMidChatSwitch: true,
      models,
    }
  }

  findSessionFile(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'WorkBuddy sessionId')
    for (const { base, projectsDir } of this.getProjectsRoots()) {
      let projDirs
      try { projDirs = readdirSync(projectsDir) } catch { continue }
      for (const proj of projDirs) {
        const projDir = join(projectsDir, proj)
        let st
        try { st = statSync(projDir) } catch { continue }
        if (!st.isDirectory()) continue
        const candidate = assertPathWithinDir(join(projDir, `${sessionId}.jsonl`), projDir, 'WorkBuddy session file')
        if (existsSync(candidate)) {
          return { filePath: candidate, configDir: base }
        }
      }
    }
    return null
  }

  buildWatchPayload(meta, probe, running) {
    const updatedAt = Math.max(meta.updatedAt || 0, Math.round(probe?.mtimeMs || 0))
    const preview =
      (probe?.lastTextPreview ? probe.lastTextPreview.replace(/\s+/g, ' ').slice(0, 120) : '') ||
      (running && probe?.lastToolName ? `正在调用 ${probe.lastToolName}…` : '') ||
      meta.preview ||
      ''
    return {
      id: makeCompositeId(APPS.WORKBUDDY, meta.nativeId),
      app: APPS.WORKBUDDY,
      nativeId: meta.nativeId,
      title: meta.title || meta.nativeId,
      preview,
      cwd: meta.cwd || '',
      workspace: meta.workspace || (meta.cwd ? basename(meta.cwd) : 'WorkBuddy'),
      model: meta.model || 'auto',
      source: meta.source || 'workbuddy-desktop',
      writable: Boolean(meta.writable),
      status: running ? 'running' : 'idle',
      ...(meta.taskState !== undefined ? { taskState: meta.taskState } : {}),
      syncState: {
        externalRunning: Boolean(running),
        source: meta.source || 'workbuddy-desktop',
      },
      updatedAt,
    }
  }

  ensureWatchTimer() {
    if (this.disposed || this.watchTimer) return
    if (this.watchedSessions.size === 0 && this.trackedListSessions.size === 0) return
    this.watchTimer = setInterval(() => {
      void this.pollExternalSessions()
    }, this.watchPollMs)
    this.watchTimer.unref?.()
  }

  rememberWatchedSession(nativeId, descriptor) {
    if (this.disposed || !nativeId) return
    this.watchedSessions.set(nativeId, {
      ...descriptor,
      nativeId,
      lastSeenAt: Date.now(),
    })
    this.ensureWatchTimer()
  }

  rememberTrackedListSession(nativeId, descriptor) {
    if (this.disposed || !nativeId) return
    this.trackedListSessions.set(nativeId, {
      ...descriptor,
      nativeId,
    })
    if (this.trackedListSessions.size > WORKBUDDY_TRACKED_LIST_LIMIT * 2) {
      const oldest = [...this.trackedListSessions.entries()]
        .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
      while (this.trackedListSessions.size > WORKBUDDY_TRACKED_LIST_LIMIT) {
        const next = oldest.shift()
        if (!next) break
        this.trackedListSessions.delete(next[0])
      }
    }
    this.ensureWatchTimer()
  }

  async pollExternalSessions() {
    if (this.disposed || this.watchPollInFlight) return
    this.watchPollInFlight = true
    try {
      const now = Date.now()
      const emittedIds = new Set()
      const dbSnap = readWorkbuddyDbSnapshot(this.workbuddyHome)
      const pidDir = join(this.workbuddyHome, 'sessions')

      for (const [nativeId, entry] of [...this.watchedSessions.entries()]) {
        if (this.activeProcs.has(nativeId)) continue
        const dbRow = dbSnap.sessionsById.get(nativeId) || null
        const probe = probeWorkbuddyExternalStatus({
          pidSessionsDir: pidDir,
          targetSessionId: nativeId,
          transcriptPath: entry.filePath || '',
          dbStatus: dbRow?.status || '',
          dbUpdatedAt: dbRow?.updatedAt || 0,
          now,
          maxIdleMs: this.externalMaxIdleMs,
          checkPidAlive: this.checkPidAlive,
        })
        const historyChanged = probe.size !== entry.size || probe.mtimeMs > (entry.mtimeMs || 0) + 10
        const statusChanged = Boolean(probe.running) !== Boolean(entry.externalRunning)
        if (historyChanged || statusChanged) {
          entry.size = probe.size
          entry.mtimeMs = probe.mtimeMs
          entry.externalRunning = probe.running
          entry.updatedAt = Math.max(entry.updatedAt || 0, Math.round(probe.mtimeMs || 0))
          if (dbRow?.title) entry.title = dbRow.title
          if (historyChanged && entry.filePath && existsSync(entry.filePath)) {
            try {
              entry.taskState = parseWorkbuddyJsonlMessages(entry.filePath).taskState || null
              this.sessionTaskStates.set(nativeId, entry.taskState)
            } catch {}
          }
          if (probe.running) entry.lastSeenAt = now
          emittedIds.add(nativeId)
          this.emitEvent(EVENTS.SESSION_UPDATED, {
            historyChanged,
            statusChanged,
            externalUpdate: true,
            session: this.buildWatchPayload(entry, probe, probe.running),
          })
        } else if (!probe.running && now - (entry.lastSeenAt || 0) > WORKBUDDY_WATCH_TTL_MS) {
          this.watchedSessions.delete(nativeId)
        }
      }

      const listExpired = now - this.lastClientListAt > WORKBUDDY_LIST_WATCH_TTL_MS
      if (listExpired) {
        this.trackedListSessions.clear()
      } else {
        for (const [nativeId, entry] of [...this.trackedListSessions.entries()]) {
          if (emittedIds.has(nativeId) || this.activeProcs.has(nativeId)) continue
          const dbRow = dbSnap.sessionsById.get(nativeId) || null
          const probe = probeWorkbuddyExternalStatus({
            pidSessionsDir: pidDir,
            targetSessionId: nativeId,
            transcriptPath: entry.filePath || '',
            dbStatus: dbRow?.status || '',
            dbUpdatedAt: dbRow?.updatedAt || 0,
            now,
            maxIdleMs: this.externalMaxIdleMs,
            checkPidAlive: this.checkPidAlive,
          })
          const statusChanged = Boolean(probe.running) !== Boolean(entry.externalRunning)
          if (statusChanged) {
            entry.size = probe.size
            entry.mtimeMs = probe.mtimeMs
            entry.externalRunning = probe.running
            entry.updatedAt = Math.max(entry.updatedAt || 0, Math.round(probe.mtimeMs || 0))
            if (dbRow?.title) entry.title = dbRow.title
            emittedIds.add(nativeId)
            this.emitEvent(EVENTS.SESSION_UPDATED, {
              historyChanged: false,
              statusChanged: true,
              externalUpdate: true,
              session: this.buildWatchPayload(entry, probe, probe.running),
            })
          }
        }

        if (this.trackedListSessions.size > 0 && now - this.lastListDiscoveryAt >= WORKBUDDY_LIST_DISCOVERY_INTERVAL_MS) {
          this.lastListDiscoveryAt = now
          for (const [sid, dbRow] of dbSnap.sessionsById.entries()) {
            if (emittedIds.has(sid) || this.activeProcs.has(sid) || this.trackedListSessions.has(sid)) continue
            if (dbRow.transport === 'cloud' && !dbRow.cwd) continue
            const found = this.findSessionFile(sid)
            if (!found) continue
            const probe = probeWorkbuddyExternalStatus({
              pidSessionsDir: pidDir,
              targetSessionId: sid,
              transcriptPath: found.filePath,
              dbStatus: dbRow.status,
              dbUpdatedAt: dbRow.updatedAt,
              now,
              maxIdleMs: this.externalMaxIdleMs,
              checkPidAlive: this.checkPidAlive,
            })
            if (probe.running) {
              const cliReady = Boolean(this.cliAvailableCache) && this.isCliAuthenticated()
              const entry = {
                nativeId: sid,
                filePath: found.filePath,
                title: dbRow.title || sid,
                preview: probe.lastTextPreview || '',
                cwd: dbRow.cwd || '',
                workspace: dbRow.cwd ? basename(dbRow.cwd) : 'WorkBuddy',
                model: dbRow.model || 'auto',
                source: 'workbuddy-desktop',
                writable: cliReady,
                updatedAt: Math.max(dbRow.updatedAt || 0, probe.mtimeMs || 0),
                size: probe.size,
                mtimeMs: probe.mtimeMs,
                externalRunning: true,
              }
              this.rememberTrackedListSession(sid, entry)
              this.emitEvent(EVENTS.SESSION_UPDATED, {
                historyChanged: false,
                statusChanged: true,
                externalUpdate: true,
                session: this.buildWatchPayload(entry, probe, true),
              })
            }
          }
        }
      }

      if (this.watchedSessions.size === 0 && this.trackedListSessions.size === 0 && this.watchTimer) {
        clearInterval(this.watchTimer)
        this.watchTimer = null
      }
    } finally {
      this.watchPollInFlight = false
    }
  }

  async listSessions({ limit = 80, search = '' } = {}) {
    const now = Date.now()
    const cliReady = await this.isWritableReady()
    const dbSnap = readWorkbuddyDbSnapshot(this.workbuddyHome)
    const pidDir = join(this.workbuddyHome, 'sessions')
    const results = []
    const seen = new Set()

    // 1. Freshly created sessions not yet flushed to disk
    for (const pending of this.pendingCreated.values()) {
      if (seen.has(pending.nativeId)) continue
      seen.add(pending.nativeId)
      results.push({
        ...pending,
        writable: cliReady,
        status: this.activeProcs.has(pending.nativeId) ? 'running' : 'idle',
      })
    }

    // 2. Scan all JSONL files across ~/.workbuddy/projects and ~/.codebuddy/projects
    const allFiles = []
    for (const { base, projectsDir } of this.getProjectsRoots()) {
      let projDirs
      try { projDirs = readdirSync(projectsDir) } catch { continue }
      for (const proj of projDirs) {
        const pDir = join(projectsDir, proj)
        let stat
        try { stat = statSync(pDir) } catch { continue }
        if (!stat.isDirectory()) continue
        let files
        try { files = readdirSync(pDir) } catch { continue }
        for (const f of files) {
          if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
          const fp = join(pDir, f)
          try {
            const fst = statSync(fp)
            allFiles.push({
              fp,
              proj,
              isWorkbuddyHome: base === this.workbuddyHome,
              mtimeMs: fst.mtimeMs,
            })
          } catch {}
        }
      }
    }
    allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)

    let acceptedCount = 0
    for (let i = 0; i < Math.min(allFiles.length, 150); i += 1) {
      const entry = allFiles[i]
      const summary = scanWorkbuddySessionSummary(entry.fp, entry.proj)
      if (!summary || seen.has(summary.nativeId)) continue
      seen.add(summary.nativeId)

      const dbRow = dbSnap.sessionsById.get(summary.nativeId) || null
      if (dbRow) {
        if (dbRow.title) summary.title = dbRow.title
        if (dbRow.cwd && !summary.cwd) summary.cwd = dbRow.cwd
        if (dbRow.model && dbRow.model !== 'default' && dbRow.model !== 'fast-model') {
          summary.model = dbRow.model
        }
        if (dbRow.createdAt) summary.createdAt = dbRow.createdAt
        if (dbRow.updatedAt > summary.updatedAt) summary.updatedAt = dbRow.updatedAt
      }
      if (summary.cwd) summary.workspace = basename(summary.cwd) || summary.workspace

      const source = entry.isWorkbuddyHome || dbRow ? 'workbuddy-desktop' : 'codebuddy-cli'
      const sessionIdx = acceptedCount++
      const isLocalActive = this.activeProcs.has(summary.nativeId)
      let probe = null
      let externalRunning = false
      if (!isLocalActive && (sessionIdx < WORKBUDDY_TRACKED_LIST_LIMIT || now - (summary.updatedAt || 0) <= this.externalMaxIdleMs + 5 * 60_000)) {
        probe = probeWorkbuddyExternalStatus({
          pidSessionsDir: pidDir,
          targetSessionId: summary.nativeId,
          transcriptPath: entry.fp,
          dbStatus: dbRow?.status || '',
          dbUpdatedAt: dbRow?.updatedAt || 0,
          now,
          maxIdleMs: this.externalMaxIdleMs,
          checkPidAlive: this.checkPidAlive,
        })
        externalRunning = Boolean(probe?.running)
        if (probe?.mtimeMs > (summary.updatedAt || 0)) {
          summary.updatedAt = Math.round(probe.mtimeMs)
        }
      }

      const filePath = summary.filePath
      delete summary.filePath
      summary.source = source
      summary.writable = cliReady
      if (isLocalActive) {
        summary.status = 'running'
        summary.syncState = { externalRunning: false, source }
      } else if (externalRunning) {
        summary.status = 'running'
        summary.syncState = { externalRunning: true, source }
      } else {
        summary.syncState = { externalRunning: false, source }
      }

      if (!search && sessionIdx < WORKBUDDY_TRACKED_LIST_LIMIT) {
        this.rememberTrackedListSession(summary.nativeId, {
          ...summary,
          filePath,
          size: probe?.size || 0,
          mtimeMs: probe?.mtimeMs || 0,
          externalRunning,
        })
      }
      results.push(summary)
    }

    this.lastClientListAt = now
    this.lastListDiscoveryAt = now

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
    sessionId = assertSafeSessionId(sessionId, 'WorkBuddy sessionId')
    const now = Date.now()
    const cliReady = await this.isWritableReady()
    const found = this.findSessionFile(sessionId)
    const dbSnap = readWorkbuddyDbSnapshot(this.workbuddyHome)
    const dbRow = dbSnap.sessionsById.get(sessionId) || null

    if (!found) {
      const pending = this.pendingCreated.get(sessionId)
      if (pending) {
        return {
          ...pending,
          writable: cliReady,
          messages: [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
        }
      }
      throw new Error(`找不到 WorkBuddy 会话：${sessionId}`)
    }

    const parsed = parseWorkbuddyJsonlMessages(found.filePath)
    const activeProc = this.activeProcs.get(sessionId)
    const isLocalActive = Boolean(activeProc)
    const taskState =
      isLocalActive && activeProc?.taskTracker
        ? activeProc.taskTracker.snapshot()
        : parsed.taskState || null
    this.sessionTaskStates.set(sessionId, taskState)

    const probe = !isLocalActive
      ? probeWorkbuddyExternalStatus({
          pidSessionsDir: join(this.workbuddyHome, 'sessions'),
          targetSessionId: sessionId,
          transcriptPath: found.filePath,
          dbStatus: dbRow?.status || '',
          dbUpdatedAt: dbRow?.updatedAt || 0,
          now,
          maxIdleMs: this.externalMaxIdleMs,
          checkPidAlive: this.checkPidAlive,
        })
      : null
    const externalRunning = Boolean(!isLocalActive && probe?.running)

    const source = found.configDir === this.workbuddyHome || dbRow ? 'workbuddy-desktop' : 'codebuddy-cli'
    const title = dbRow?.title || parsed.title || sessionId
    const cwd = dbRow?.cwd || parsed.cwd || ''
    const workspace = cwd ? basename(cwd) : 'WorkBuddy'
    const pref = this.sessionPrefs.get(sessionId)
    const model =
      pref?.model ||
      (dbRow?.model && dbRow.model !== 'default' && dbRow.model !== 'fast-model' ? dbRow.model : '') ||
      parsed.model ||
      'auto'
    const updatedAt = Math.max(dbRow?.updatedAt || 0, Math.round(probe?.mtimeMs || 0))

    // Always watch opened WorkBuddy sessions so desktop progress mirrors live to mobile
    this.rememberWatchedSession(sessionId, {
      nativeId: sessionId,
      filePath: found.filePath,
      title,
      cwd,
      workspace,
      model,
      source,
      writable: cliReady,
      updatedAt,
      size: probe?.size || 0,
      mtimeMs: probe?.mtimeMs || 0,
      externalRunning,
    })

    const total = parsed.messages.length
    const pageSize = Math.max(10, Math.min(Number(limit) || 25, 200))
    const endIdx =
      cursor !== null && cursor !== undefined && cursor !== '' && Number.isFinite(Number(cursor))
        ? Math.max(0, Math.min(total, Number(cursor)))
        : total
    const startIdx = Math.max(0, endIdx - pageSize)

    return {
      id: makeCompositeId(APPS.WORKBUDDY, sessionId),
      app: APPS.WORKBUDDY,
      nativeId: sessionId,
      title,
      cwd,
      workspace,
      model,
      reasoningEffort: pref?.reasoningEffort || dbRow?.thoughtLevel || '',
      source,
      writable: cliReady,
      status: isLocalActive || externalRunning ? 'running' : 'idle',
      taskState,
      syncState: {
        externalRunning,
        source,
      },
      messages: parsed.messages.slice(startIdx, endIdx),
      hasMore: startIdx > 0,
      nextCursor: startIdx > 0 ? String(startIdx) : null,
      totalCount: total,
      updatedAt,
    }
  }

  async createSession({ cwd, title, model, reasoningEffort } = {}) {
    const cliVer = Boolean(await this.probeCliVersion())
    if (!cliVer) {
      const err = new Error('WorkBuddy 远程发送引擎尚未就绪，请点击「一键启用 WorkBuddy」自动安装并微信扫码登录（全程免命令行）。')
      err.code = 'SESSION_READONLY'
      throw err
    }
    if (!this.isCliAuthenticated()) {
      const err = new Error('请先点击「一键微信扫码登录 WorkBuddy」完成初次授权（与桌面端同账号共用额度），授权后即可远程新建与发消息。')
      err.code = 'SESSION_READONLY'
      throw err
    }
    const sessionId = randomUUID()
    const targetCwd = String(cwd || '').trim() || this.defaultCwd
    if (model || reasoningEffort) {
      this.sessionPrefs.set(sessionId, {
        model: model || 'auto',
        reasoningEffort: reasoningEffort || '',
      })
    }
    const summary = {
      id: makeCompositeId(APPS.WORKBUDDY, sessionId),
      app: APPS.WORKBUDDY,
      nativeId: sessionId,
      title: title || '新 WorkBuddy 对话',
      preview: '',
      cwd: targetCwd,
      workspace: basename(targetCwd) || 'WorkBuddy',
      model: model || 'auto',
      reasoningEffort: reasoningEffort || '',
      source: existsSync(this.workbuddyHome) ? 'workbuddy-desktop' : 'codebuddy-cli',
      status: 'idle',
      writable: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.pendingCreated.set(sessionId, summary)
    return summary
  }

  async sendMessage(sessionId, { text, cwd, attachments = [], permissionMode, taskMode, model, reasoningEffort } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'WorkBuddy sessionId')
    let effectiveTaskMode = normalizeTaskMode(taskMode)
    if (this.activeProcs.has(sessionId)) {
      const err = new Error('该 WorkBuddy 会话正在运行中，请等待完成或先点击停止。')
      err.code = 'SESSION_BUSY'
      throw err
    }

    const cliReady = Boolean(await this.probeCliVersion())
    if (!cliReady || !this.codebuddyBin) {
      const err = new Error('WorkBuddy 远程发送引擎尚未安装，请点击下方「一键启用 WorkBuddy」自动安装并微信扫码登录（全程免命令行）。')
      err.code = 'SESSION_READONLY'
      throw err
    }
    if (!this.isCliAuthenticated()) {
      const err = new Error('请先点击「一键微信扫码登录 WorkBuddy」完成初次授权（与桌面端同账号共用额度），随后即可正常发送消息。')
      err.code = 'SESSION_READONLY'
      throw err
    }

    const found = this.findSessionFile(sessionId)
    const dbSnap = readWorkbuddyDbSnapshot(this.workbuddyHome)
    const dbRow = dbSnap.sessionsById.get(sessionId) || null

    if (found) {
      const extProbe = probeWorkbuddyExternalStatus({
        pidSessionsDir: join(this.workbuddyHome, 'sessions'),
        targetSessionId: sessionId,
        transcriptPath: found.filePath,
        dbStatus: dbRow?.status || '',
        dbUpdatedAt: dbRow?.updatedAt || 0,
        maxIdleMs: this.externalMaxIdleMs,
        checkPidAlive: this.checkPidAlive,
      })
      if (extProbe.running) {
        const err = new Error('该 WorkBuddy 会话正在电脑端运行中（手机端实时同步中），请等待电脑端完成后再发消息。')
        err.code = 'SESSION_BUSY'
        throw err
      }
    }

    let targetCwd = String(cwd || '').trim()
    if (!targetCwd && dbRow?.cwd) targetCwd = dbRow.cwd
    if (!targetCwd && found) {
      const sum = scanWorkbuddySessionSummary(found.filePath, '')
      targetCwd = sum?.cwd || ''
    }
    if (!targetCwd) {
      targetCwd = this.pendingCreated.get(sessionId)?.cwd || this.defaultCwd
    }
    if (!existsSync(targetCwd)) targetCwd = this.defaultCwd

    let prompt = String(text || '').trim()
    if (!effectiveTaskMode && prompt) {
      const planMatch = /^\/plan(?:\s+([\s\S]*))?$/i.exec(prompt)
      if (planMatch) {
        effectiveTaskMode = 'plan'
        const rest = String(planMatch[1] || '').trim()
        if (rest) prompt = rest
      }
    }
    if (attachments.length > 0) {
      const lines = attachments.map((a) => `- 附件文件：${a.localPath || a.filename}`)
      prompt = `${prompt}\n\n[手机端上传的附件，可直接读取]\n${lines.join('\n')}`
    }
    if (!prompt) throw new Error('消息内容不能为空')

    const pref = this.sessionPrefs.get(sessionId)
    const effectiveModel = assertSafeCliToken(model || pref?.model || '', 'model')
    const effectiveEffort = assertSafeCliToken(reasoningEffort || pref?.reasoningEffort || '', 'reasoningEffort')
    const effectivePermissionMode = resolveEffectiveWorkbuddyPermissionMode(
      permissionMode,
      this.permissionMode,
      effectiveTaskMode,
    )
    if (effectiveModel || effectiveEffort) {
      this.sessionPrefs.set(sessionId, {
        model: effectiveModel || 'auto',
        reasoningEffort: effectiveEffort || '',
      })
    }

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      effectivePermissionMode,
    ]
    if (effectiveModel && effectiveModel !== 'default' && effectiveModel !== 'auto') {
      args.push('--model', effectiveModel)
    }
    if (effectiveEffort && effectiveEffort !== 'off') {
      args.push('--effort', effectiveEffort)
    }
    if (found) {
      args.push('--resume', sessionId)
    } else {
      args.push('--session-id', sessionId)
    }

    // Align transcript directory with WorkBuddy when resuming a WorkBuddy session or when ~/.workbuddy exists
    const targetConfigDir = found?.configDir || (existsSync(this.workbuddyHome) ? this.workbuddyHome : this.codebuddyHome)
    const spawnEnv = {
      ...process.env,
      CODEBUDDY_CONFIG_DIR: targetConfigDir,
      WORKBUDDY_CONFIG_DIR: this.workbuddyHome,
    }

    const compositeId = makeCompositeId(APPS.WORKBUDDY, sessionId)
    this.emitEvent(EVENTS.STREAM_START, {
      sessionId: compositeId,
      app: APPS.WORKBUDDY,
      nativeId: sessionId,
    })

    return new Promise((resolvePromise, rejectPromise) => {
      let proc
      try {
        proc = spawnCrossPlatform(this.codebuddyBin, args, {
          cwd: targetCwd,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        if (err && typeof err === 'object') err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: APPS.WORKBUDDY,
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
          app: APPS.WORKBUDDY,
          taskState: diff.taskState,
        })
      }

      const state = { proc, aborted: false, taskTracker, emitTaskState }
      this.activeProcs.set(sessionId, state)
      emitTaskState()

      let stdoutBuf = ''
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

      const formatFriendlyError = (raw) => {
        const s = String(raw || '').trim()
        if (/authentication required|authentication failed|\/login/i.test(s)) {
          this.cliAuthenticated = false
          return 'WorkBuddy 尚未完成授权登录：请点击底部「一键微信扫码登录 WorkBuddy」完成一次官方扫码授权（与桌面端同账号共用额度），授权后即可直接发送消息。'
        }
        return s || 'WorkBuddy 执行返回错误'
      }

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
                app: APPS.WORKBUDDY,
                tool: { id: b.id, name: b.name || 'tool', input: b.input ?? {} },
              })
              if (taskTracker.applyClaudeTool(b.name || 'tool', b.input ?? {}, Date.now())) {
                emitTaskState()
              }
            } else if (b?.type === 'text' && typeof b.text === 'string') {
              fullText += b.text
            }
          }
          if (/authentication required|authentication failed/i.test(fullText) && !finalText) {
            resultError = formatFriendlyError(fullText)
            return
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
                  app: APPS.WORKBUDDY,
                  delta: rawThinkDelta,
                })
              }
            } else if (fullThink !== prevThink) {
              const thinkPrefix = lastThinkMsgId ? '\n\n' : ''
              emittedThinkByMsg.set(msgId, fullThink)
              lastThinkMsgId = msgId
              this.emitEvent(EVENTS.STREAM_THINKING, {
                sessionId: compositeId,
                app: APPS.WORKBUDDY,
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
                  app: APPS.WORKBUDDY,
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
                app: APPS.WORKBUDDY,
                delta,
              })
            }
          }
        } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
          for (const b of obj.message.content) {
            if (b?.type === 'tool_result' && b.tool_use_id) {
              this.emitEvent(EVENTS.STREAM_TOOL_END, {
                sessionId: compositeId,
                app: APPS.WORKBUDDY,
                toolId: b.tool_use_id,
                status: b.is_error ? 'error' : 'completed',
                output: extractToolOutputText(b.content).slice(0, 3000),
              })
            }
          }
        } else if (obj.type === 'control_request' && obj.request_id && obj.request) {
          this.handleControlRequest(proc, sessionId, compositeId, targetCwd, obj)
        } else if (obj.type === 'result') {
          seenResult = true
          if (obj.is_error) {
            resultError = formatFriendlyError(resultError || obj.result || obj.error)
          } else if (typeof obj.result === 'string' && obj.result.length > 0) {
            const trimmedResult = obj.result.trim()
            if (!lastTextMsgId) {
              finalText = obj.result
              this.emitEvent(EVENTS.STREAM_DELTA, {
                sessionId: compositeId,
                app: APPS.WORKBUDDY,
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
                  app: APPS.WORKBUDDY,
                  delta: suffix,
                })
              } else {
                const delta = `${finalText ? '\n\n' : ''}${obj.result}`
                emittedTextByMsg.set(lastTextMsgId, obj.result)
                finalText += delta
                this.emitEvent(EVENTS.STREAM_DELTA, {
                  sessionId: compositeId,
                  app: APPS.WORKBUDDY,
                  delta,
                })
              }
            }
          }
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
        if (settled) return
        settled = true
        if (this.activeProcs.get(sessionId) === state) this.activeProcs.delete(sessionId)
        this.clearPendingControlRequests(proc)
        if (err && typeof err === 'object') err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: APPS.WORKBUDDY,
          message: String(err?.message || err),
        })
        rejectPromise(err)
      })

      proc.on('close', (code) => {
        if (settled) return
        settled = true
        if (stdoutBuf.trim()) handleJsonLine(stdoutBuf.trim())
        if (this.activeProcs.get(sessionId) === state) this.activeProcs.delete(sessionId)
        this.clearPendingControlRequests(proc)

        if (resultError && !state.aborted) {
          if (this.findSessionFile(sessionId)) this.pendingCreated.delete(sessionId)
          const err = new Error(resultError)
          err._streamErrorEmitted = true
          this.emitEvent(EVENTS.STREAM_ERROR, {
            sessionId: compositeId,
            app: APPS.WORKBUDDY,
            message: resultError,
          })
          rejectPromise(err)
          return
        }

        if (code !== 0 && !state.aborted && !seenResult) {
          if (this.findSessionFile(sessionId)) this.pendingCreated.delete(sessionId)
          const errMsg = formatFriendlyError(stderrBuf.trim() || `codebuddy 进程退出（code=${code}）`)
          const err = new Error(errMsg)
          err._streamErrorEmitted = true
          this.emitEvent(EVENTS.STREAM_ERROR, {
            sessionId: compositeId,
            app: APPS.WORKBUDDY,
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
          app: APPS.WORKBUDDY,
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
        void this.refreshQuotaInBackground({ force: true })
      })

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
        this.emitEvent(EVENTS.APPROVAL_RESOLVED, { id: aprId, app: APPS.WORKBUDDY, decision: 'cancel' })
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
      this.writeControlResponse(proc, requestId, { behavior: 'allow' })
      return
    }

    const toolName = String(req.tool_name || 'tool')
    const toolInput = req.input && typeof req.input === 'object' ? req.input : {}

    if (toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions) && toolInput.questions.length > 0) {
      const aprId = `wb-q-${randomUUID().slice(0, 10)}`
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

      this.pendingControlRequests.set(aprId, { proc, requestId, toolName, toolInput, questions, sessionId })
      this.onApprovalRequest({
        id: aprId,
        app: APPS.WORKBUDDY,
        sessionId: compositeId,
        kind: 'question',
        title: 'WorkBuddy 需要你做选择',
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
      const aprId = `wb-plan-${randomUUID().slice(0, 10)}`
      this.pendingControlRequests.set(aprId, { proc, requestId, toolName, toolInput, sessionId })
      this.onApprovalRequest({
        id: aprId,
        app: APPS.WORKBUDDY,
        sessionId: compositeId,
        kind: 'permissions',
        title: 'WorkBuddy 计划已就绪',
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

    const aprId = `wb-apr-${randomUUID().slice(0, 10)}`
    this.pendingControlRequests.set(aprId, { proc, requestId, toolName, toolInput, sessionId })
    const detail =
      toolInput.command ||
      toolInput.file_path ||
      toolInput.path ||
      toolInput.description ||
      JSON.stringify(toolInput, null, 2)

    this.onApprovalRequest({
      id: aprId,
      app: APPS.WORKBUDDY,
      sessionId: compositeId,
      kind: toolName === 'Edit' || toolName === 'Write' ? 'file_change' : 'command',
      title: `WorkBuddy 请求使用 ${toolName}`,
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
        const wbAnswers = {}
        for (const q of entry.questions || []) {
          const ans = normalizeSingleAnswer(answers[q.id])
          const key = q.origQuestion || q.question
          wbAnswers[key] = q.multiSelect
            ? ans.combined.join(', ')
            : (ans.selected[0] || ans.custom || '')
        }
        this.writeControlResponse(entry.proc, entry.requestId, {
          behavior: 'allow',
          updatedInput: {
            ...entry.toolInput,
            questions: entry.toolInput?.questions || [],
            answers: wbAnswers,
          },
        })
      }
      this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
        id: approvalId,
        app: APPS.WORKBUDDY,
        decision: cancelled ? 'cancel' : 'submit',
      })
      return { resolved: true, id: approvalId, decision: cancelled ? 'cancel' : 'submit' }
    }

    const allowed = decision === 'allow' || decision === 'accept' || decision === 'acceptForSession'
    if (entry.toolName === 'ExitPlanMode' && allowed && entry.sessionId) {
      const active = this.activeProcs.get(entry.sessionId)
      if (active?.taskTracker) {
        active.taskTracker.setMode(null, Date.now())
        active.emitTaskState?.()
      }
    }
    this.writeControlResponse(
      entry.proc,
      entry.requestId,
      allowed
        ? { behavior: 'allow', updatedInput: entry.toolInput || {} }
        : { behavior: 'deny', message: 'User denied tool execution' },
    )
    this.emitEvent(EVENTS.APPROVAL_RESOLVED, {
      id: approvalId,
      app: APPS.WORKBUDDY,
      decision: allowed ? 'allow' : 'deny',
    })
    return { resolved: true, id: approvalId, decision: allowed ? 'allow' : 'deny' }
  }

  async interrupt(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'WorkBuddy sessionId')
    const active = this.activeProcs.get(sessionId)
    if (!active) return { interrupted: false, sessionId }
    active.aborted = true
    this.clearPendingControlRequests(active.proc)
    const proc = active.proc
    try { proc.stdin?.end() } catch {}
    try { proc.kill('SIGTERM') } catch {}
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

  async dispose() {
    this.disposed = true
    this.stopActiveLoginSession()
    if (this.watchTimer) {
      clearInterval(this.watchTimer)
      this.watchTimer = null
    }
    this.watchedSessions.clear()
    this.trackedListSessions.clear()
    for (const active of this.activeProcs.values()) {
      active.aborted = true
      try { this.clearPendingControlRequests(active.proc) } catch {}
      killProcessTree(active.proc, { force: true })
    }
    this.activeProcs.clear()
    this.pendingControlRequests.clear()
  }
}
