import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  APPS,
  EVENTS,
  assertSafeCliToken,
  assertSafeSessionId,
  makeCompositeId,
  toEpochMs,
} from '../protocol.js'
import { mergeAndCompactMessages } from '../helpers/history-normalize.js'
import {
  findZCodeBuiltinConfig,
  findZCodeLauncher,
  killProcessTree,
  sanitizeChildEnv,
  spawnCrossPlatform,
} from '../helpers/bin-finder.js'
import { createTaskStateTracker, normalizeTaskMode } from '../helpers/task-state.js'
import { BaseAdapter } from './base-adapter.js'
import {
  getDatabaseSync,
  readTailLinesZeroOom,
  runPythonSqliteJson,
} from '../primitives/io-utils.js'
import { BoundedLruMap } from '../primitives/lru.js'
import { QuotaCacheManager } from '../primitives/quota-cache.js'
import { SessionExternalWatcher } from '../primitives/session-watcher.js'

const ZCODE_WATCH_POLL_MS = 2_500
const ZCODE_WATCH_TTL_MS = 10 * 60_000
const ZCODE_LIST_WATCH_TTL_MS = 10 * 60_000
const ZCODE_EXTERNAL_ACTIVE_WINDOW_MS = 3 * 60_000
const ZCODE_QUOTA_CACHE_TTL_MS = 30_000
const ZCODE_TURN_INACTIVITY_TIMEOUT_MS = 15 * 60_000
const ZCODE_MAX_LINE_BYTES = 16 * 1024 * 1024
const ZCODE_LOG_TAIL_BYTES = 512 * 1024

const ALLOWED_ZCODE_MODES = Object.freeze([
  'plan',
  'guarded',
  'build',
  'edit',
  'auto',
  'yolo',
])

const ZCODE_MODE_RANK = Object.freeze({
  plan: 0,
  guarded: 1,
  build: 2,
  edit: 3,
  auto: 4,
  yolo: 5,
})

const ZCODE_DEFAULT_EFFORTS = Object.freeze(['low', 'high', 'max'])

const ZCODE_FALLBACK_MODELS = Object.freeze([
  { id: 'GLM-5.4', name: 'GLM-5.4', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  { id: 'GLM-5.3', name: 'GLM-5.3', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  { id: 'GLM-5.2', name: 'GLM-5.2', efforts: ['disabled', 'high', 'max'], defaultEffort: 'high' },
  { id: 'GLM-5.1', name: 'GLM-5.1', efforts: ['disabled', 'enabled'], defaultEffort: 'enabled' },
  { id: 'GLM-5-Turbo', name: 'GLM-5-Turbo', efforts: ['disabled', 'enabled'], defaultEffort: 'enabled' },
  { id: 'GLM-4.7', name: 'GLM-4.7', efforts: ['disabled', 'enabled'], defaultEffort: 'enabled' },
])

const CANONICAL_GLM_MODELS = new Map(
  [
    'GLM-5.4',
    'GLM-5.3',
    'GLM-5.3-Flash',
    'GLM-5.2',
    'GLM-5.1',
    'GLM-5-Turbo',
    'GLM-4.7',
    'GLM-4.6',
    'GLM-4.5',
    'GLM-4.5-Air',
  ].map((m) => [m.toLowerCase(), m]),
)

export function normalizeZCodeModelId(rawModelId) {
  const s = String(rawModelId || '').trim()
  if (!s) return ''
  return CANONICAL_GLM_MODELS.get(s.toLowerCase()) || s
}

/**
 * Resolve valid reasoning levels for a ZCode model from builtin `modelRules` (with curated GLM defaults).
 */
export function resolveZCodeModelEfforts(modelId, builtin = null) {
  const cleanId = normalizeZCodeModelId(modelId)
  const rules = builtin?.config?.modelConfigRules?.modelRules
  if (cleanId && Array.isArray(rules)) {
    let matchedValues = null
    for (const r of rules) {
      const pat = typeof r?.modelMatch === 'string' ? r.modelMatch.trim() : ''
      const vals = r?.config?.optionSpecs?.reasoningLevel?.values
      if (!pat || !Array.isArray(vals) || vals.length === 0) continue
      try {
        if (new RegExp(`^(?:${pat})$`, 'i').test(cleanId)) {
          matchedValues = vals.map((v) => String(v).trim()).filter(Boolean)
        }
      } catch {}
    }
    if (matchedValues && matchedValues.length > 0) {
      const def = matchedValues.includes('high')
        ? 'high'
        : matchedValues.includes('enabled')
          ? 'enabled'
          : matchedValues[matchedValues.length - 1]
      return { efforts: matchedValues, defaultEffort: def }
    }
  }
  const fb = ZCODE_FALLBACK_MODELS.find((m) => m.id.toLowerCase() === cleanId.toLowerCase())
  if (fb) return { efforts: [...fb.efforts], defaultEffort: fb.defaultEffort }
  if (/glm-5\.2/i.test(cleanId)) return { efforts: ['disabled', 'high', 'max'], defaultEffort: 'high' }
  if (/glm-5-(?:turbo)|glm-5\.1|glm-4/i.test(cleanId)) return { efforts: ['disabled', 'enabled'], defaultEffort: 'enabled' }
  return { efforts: [...ZCODE_DEFAULT_EFFORTS], defaultEffort: 'high' }
}

/**
 * Clamp a requested reasoning effort value so ZCode's strict model option validator never rejects it.
 */
export function normalizeZCodeReasoningLevel(effort, modelId, builtin = null) {
  const raw = String(effort || '').trim().toLowerCase()
  if (!raw) return ''
  const { efforts, defaultEffort } = resolveZCodeModelEfforts(modelId, builtin)
  if (efforts.includes(raw)) return raw
  if ((raw === 'off' || raw === 'none') && efforts.includes('disabled')) return 'disabled'
  if (raw === 'disabled' && efforts.includes('low')) return 'low'
  if (raw === 'medium') {
    if (efforts.includes('high')) return 'high'
    if (efforts.includes('enabled')) return 'enabled'
  }
  if ((raw === 'low' || raw === 'high' || raw === 'max' || raw === 'xhigh') && efforts.includes('enabled')) {
    return 'enabled'
  }
  if (raw === 'xhigh' && efforts.includes('max')) return 'max'
  return defaultEffort || efforts[0] || ''
}

/**
 * Translate verbose / cryptic ZCode CLI stderr & provider errors into concise, actionable messages.
 */
export function formatZCodeCliError(rawErr, { resumed = false } = {}) {
  const text = String(rawErr || '').trim()
  if (!text) return 'ZCode 执行失败'

  if (/Select a model before sending a message/i.test(text)) {
    return resumed
      ? 'ZCode 官方 CLI（--resume）当前版本暂不支持直接续聊已有桌面端会话，请在 All in One 中新建 ZCode 对话，或在电脑端 ZCode 窗口中继续此会话。'
      : 'ZCode 未选中可用模型，请先重新授权登录或在模型选择器中选择一个 GLM 模型后重试。'
  }

  const bizMatch = text.match(/providerMessage:\s*['"]([^'"]+)['"]/) || text.match(/ProviderBusinessError:\s*([^\r\n]+)/)
  const bizMsg = bizMatch ? bizMatch[1].trim() : ''

  if (/\[1113\]|余额不足|无可用资源包/i.test(text)) {
    return '智谱 Coding Plan 无可用余额或资源包（错误码 1113）：ZCode 免费 Start Plan 仅限官方 ZCode 桌面端使用，远程发送需开通 BigModel / Z.AI Coding Plan 或配置自定义 API Key。'
  }
  if (/3012|This client is not supported/i.test(text)) {
    return 'ZCode 免费 Start Plan 仅限官方 ZCode 桌面端使用（错误码 3012），远程发送需开通 Coding Plan 或配置自定义 API Key。'
  }
  if (bizMsg) {
    return `智谱接口返回错误：${bizMsg}`
  }

  // Strip Node.js stack traces / verbose object dumps to keep UI error banners crisp
  const firstMeaningful = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('at ') && !l.startsWith('{') && !l.startsWith('}'))
  const lastErrLine = [...firstMeaningful].reverse().find((l) => /^Error:/i.test(l))
  const chosen = (firstMeaningful[0] && !/^Error:\s*Turn execution failed/i.test(firstMeaningful[0])
    ? firstMeaningful[0]
    : lastErrLine || firstMeaningful[0] || text
  ).replace(/^Error:\s*/i, '')
  return chosen.slice(0, 320)
}

const TRUSTED_ZCODE_AUTH_SUFFIXES = Object.freeze([
  'bigmodel.cn',
  'z.ai',
  'zcode.ai',
  'zcode.z.ai',
  'chatglm.cn',
  'chatglm.site',
  'zhipuai.cn',
])

const DEFAULT_PROVIDER_BY_DOMAIN = Object.freeze({
  bigmodel: {
    'individual-coding-plan': 'account:bigmodel-individual-coding-plan',
    'team-coding-plan': 'account:bigmodel-team-coding-plan',
    'start-plan': 'account:bigmodel-start-plan',
  },
  zai: {
    'individual-coding-plan': 'account:zai-individual-coding-plan',
    'team-coding-plan': 'account:zai-team-coding-plan',
    'start-plan': 'account:zai-start-plan',
  },
})

function getZCodeHome(configuredHome = '', env = process.env) {
  const custom = String(configuredHome || env?.ZCODE_HOME || '').trim()
  if (custom) return custom
  const baseDir = String(env?.ZCODE_DATA_BASE_DIR || '').trim()
  if (baseDir) return join(baseDir, '.zcode')
  return join(homedir(), '.zcode')
}

export function getZCodeManagedAuthDir(configuredAuthDir = '', env = process.env) {
  const custom = String(configuredAuthDir || env?.ALLINONE_ZCODE_AUTH_DIR || '').trim()
  if (custom) return custom
  return join(homedir(), '.allinone-bridge', 'zcode-auth')
}

/**
 * Ensure an isolated 0600 secret file exists for ZCode standalone CLI (`ZCODE_CREDENTIAL_SECRET_FILE`)
 * so `zcode.cjs` never depends on native `@napi-rs/keyring` and never touches ZCode Desktop's OS-keyring store.
 */
export function ensureZCodeManagedAuthStore(authDir) {
  const dir = String(authDir || '').trim()
  if (!dir) throw new Error('Missing ZCode managed auth directory')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch {}

  const secretFile = join(dir, 'credential-secret')
  const credentialsFile = join(dir, 'credentials.json')
  const providerConfigFile = join(dir, 'provider_config.json')

  let needSecret = true
  if (existsSync(secretFile)) {
    try {
      const st = statSync(secretFile)
      if (st.isFile() && st.size >= 32 && st.size <= 4096) {
        needSecret = false
      }
    } catch {}
  }
  if (needSecret) {
    const secret = randomBytes(32).toString('hex')
    writeFileSync(secretFile, secret, { encoding: 'utf8', mode: 0o600 })
  }
  try { chmodSync(secretFile, 0o600) } catch {}

  return { dir, secretFile, credentialsFile, providerConfigFile }
}

function safeReadJson(filePath) {
  if (!filePath || !existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function safeJsonParse(raw, fallback = null) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Strictly validate an OAuth login URL emitted by `zcode login [bigmodel|zai] --no-browser`
 * against trusted Zhipu / BigModel / Z.AI HTTPS origins before exposing it to remote clients.
 */
export function isSafeZCodeAuthUrl(rawUrl) {
  const s = String(rawUrl || '').trim()
  if (!s || s.length > 4096) return false
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return TRUSTED_ZCODE_AUTH_SUFFIXES.some((sfx) => host === sfx || host.endsWith(`.${sfx}`))
  } catch {
    return false
  }
}

/**
 * Clamp requested ZCode permission mode against host-configured maximum mode.
 */
export function resolveEffectiveZCodeMode(requestedMode, hostConfiguredMode, effectiveTaskMode) {
  const hostMode = ALLOWED_ZCODE_MODES.includes(hostConfiguredMode) ? hostConfiguredMode : 'build'
  const rawReq = String(requestedMode ?? '').trim().toLowerCase()
  if (!rawReq) {
    if (effectiveTaskMode === 'plan') return 'plan'
    return hostMode
  }
  if (!ALLOWED_ZCODE_MODES.includes(rawReq)) {
    throw new Error('非法的 ZCode mode 参数值')
  }
  const reqRank = ZCODE_MODE_RANK[rawReq]
  const hostRank = ZCODE_MODE_RANK[hostMode]
  if (reqRank > hostRank) {
    throw new Error(`出于安全限制，不允许远程将 ZCode 权限模式从 ${hostMode} 提升至 ${rawReq}`)
  }
  return rawReq
}

function hasAuthFilesInDir(dir) {
  if (!dir || !existsSync(dir)) return false
  const providerCfg = safeReadJson(join(dir, 'provider_config.json'))
  if (providerCfg?.config?.defaultModelSelection?.providerId && providerCfg?.config?.defaultModelSelection?.modelId) {
    return true
  }
  const manualRules = providerCfg?.config?.providerConfigRules?.providerRules
  if (Array.isArray(manualRules) && manualRules.some((r) => r && (r.providerId || r.id))) {
    return true
  }

  const credsObj = safeReadJson(join(dir, 'credentials.json'))
  if (credsObj && typeof credsObj === 'object') {
    for (const key of Object.keys(credsObj)) {
      if (/^account-provider:.+:identity$/i.test(key) && credsObj[key]) {
        return true
      }
    }
  }
  return false
}

/**
 * Detect whether standalone ZCode CLI (`zcode.cjs -p ...`) has usable model/account credentials,
 * checking env keys, All in One's isolated managed auth store, and `~/.zcode/v2/`.
 * Inspects only non-secret config structure and key names in `credentials.json` (never decrypts secrets).
 */
export function hasZCodeStandaloneAuth({ zcodeHome = '', authDir = '', env = process.env } = {}) {
  if (
    String(env?.ZHIPU_API_KEY || env?.BIGMODEL_API_KEY || env?.ZAI_API_KEY || env?.ZCODE_API_KEY || '').trim()
  ) {
    return true
  }

  const managedDir = authDir || getZCodeManagedAuthDir('', env)
  if (managedDir && existsSync(join(managedDir, 'credential-secret')) && hasAuthFilesInDir(managedDir)) {
    return true
  }

  const home = zcodeHome || getZCodeHome('', env)
  if (!home || !existsSync(home)) return false
  return hasAuthFilesInDir(join(home, 'v2'))
}

/**
 * Normalize ZCode's `billing/balance` payload (`plans` + `balances`) into All in One's unified
 * multi-pool window quota shape (`quota.pools`, `remainingPercent`, `planType`, `resetsAt`).
 */
export function normalizeZCodeBillingQuota(rawPayload, { now = Date.now() } = {}) {
  if (!rawPayload || typeof rawPayload !== 'object') return null
  const data = rawPayload?.payload?.data || rawPayload?.data || rawPayload
  if (!data || typeof data !== 'object') return null

  const rawBalances = Array.isArray(data.balances) ? data.balances : []
  const rawPlans = Array.isArray(data.plans) ? data.plans : []
  if (rawBalances.length === 0) return null

  const activePlan =
    rawPlans.find((p) => String(p?.status || '').toLowerCase() === 'active') || rawPlans[0] || null
  const planType = String(activePlan?.name || rawPayload?.plans?.[0]?.name || 'ZCode').trim()

  const entitlementById = new Map()
  for (const plan of rawPlans) {
    for (const ent of Array.isArray(plan?.entitlements) ? plan.entitlements : []) {
      if (ent?.entitlement_id) entitlementById.set(String(ent.entitlement_id), ent)
    }
  }

  const pools = []
  let lowestPct = 101
  let primaryWin = null

  for (const b of rawBalances) {
    if (!b || typeof b !== 'object') continue
    const total = Number(b.total_units ?? b.grant_units ?? 0)
    if (!Number.isFinite(total) || total <= 0) continue

    const remainingRaw = b.available_units ?? b.remaining_units
    const usedRaw = Number(b.used_units ?? 0)
    const remaining =
      remainingRaw !== undefined && remainingRaw !== null && Number.isFinite(Number(remainingRaw))
        ? Math.max(0, Number(remainingRaw))
        : Math.max(0, total - (Number.isFinite(usedRaw) ? usedRaw : 0))
    const remainingPercent = Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))

    const periodStartMs = toEpochMs(b.period_start)
    const periodEndMs = toEpochMs(b.period_end || b.expires_at)
    // Skip stale expired buckets older than 60s
    if (periodEndMs > 86_400_000 && now > periodEndMs + 60_000) continue

    const ent = entitlementById.get(String(b.entitlement_id || '')) || null
    const periodStr = String(ent?.period || b.period || '').toLowerCase()

    let windowMinutes = 1440
    if (periodStartMs > 0 && periodEndMs > periodStartMs) {
      const diffMins = Math.round((periodEndMs - periodStartMs) / 60_000)
      if (diffMins >= 30 && diffMins <= 60 * 24 * 60) {
        windowMinutes = diffMins
      }
    } else if (periodStr === 'weekly' || periodStr === 'week') {
      windowMinutes = 10080
    } else if (periodStr === '5h' || periodStr === 'hourly') {
      windowMinutes = 300
    } else if (periodStr === 'monthly' || periodStr === 'month') {
      windowMinutes = 43200
    }

    let kind = 'short'
    if (periodStr === 'daily' || (windowMinutes >= 720 && windowMinutes <= 2160)) {
      kind = 'daily'
    } else if (windowMinutes > 2160) {
      kind = 'weekly'
    }

    const label = String(b.show_name || ent?.show_name || b.entitlement_id || 'GLM').trim()
    const poolId = String(b.entitlement_id || b.bucket_id || label)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .slice(0, 48)

    const winObj = {
      id: `${poolId}_${kind}`,
      kind,
      windowMinutes,
      remainingPercent,
      resetsAt: periodEndMs,
    }
    pools.push({
      id: poolId,
      label,
      labelZh: label,
      windows: [winObj],
    })

    if (remainingPercent < lowestPct) {
      lowestPct = remainingPercent
      primaryWin = winObj
    }
  }

  if (pools.length === 0 || !primaryWin) return null

  return {
    windowKind: primaryWin.kind,
    windowMinutes: primaryWin.windowMinutes,
    remainingPercent: primaryWin.remainingPercent,
    usedPercent: Math.max(0, Math.min(100, 100 - primaryWin.remainingPercent)),
    resetsAt: primaryWin.resetsAt,
    planType,
    pools,
    updatedAt: now,
  }
}

/**
 * Extract the latest live `billing/balance` quota snapshot written by ZCode Desktop
 * into `~/.zcode/v2/logs/YYYY-MM-DD.log` using zero-OOM tail reading.
 */
export function readZCodeQuotaFromLogs(zcodeHome, { now = Date.now(), maxBytes = ZCODE_LOG_TAIL_BYTES } = {}) {
  const logsDir = join(zcodeHome, 'v2', 'logs')
  if (!existsSync(logsDir)) return null

  let logFiles
  try {
    logFiles = readdirSync(logsDir)
      .filter((name) => name.endsWith('.log'))
      .map((name) => {
        const full = join(logsDir, name)
        try {
          const st = statSync(full)
          return st.isFile() && st.size > 0 ? { full, mtimeMs: st.mtimeMs || 0 } : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 3)
  } catch {
    return null
  }

  for (const file of logFiles) {
    const lines = readTailLinesZeroOom(file.full, maxBytes)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (!line.includes('billing/balance')) continue
      const jsonStart = line.indexOf('{')
      if (jsonStart === -1) continue
      const parsed = safeJsonParse(line.slice(jsonStart), null)
      if (!parsed) continue
      const quota = normalizeZCodeBillingQuota(parsed, { now })
      if (quota) return quota
    }
  }
  return null
}

function normalizeZCodeToolState(partData, partId) {
  const state = partData?.state && typeof partData.state === 'object' ? partData.state : {}
  const rawStatus = String(state.status || '').toLowerCase()
  const status =
    rawStatus === 'error' || rawStatus === 'failed'
      ? 'error'
      : rawStatus === 'pending' || rawStatus === 'running'
        ? 'running'
        : 'completed'
  const outputRaw =
    rawStatus === 'error'
      ? state.error || state.output || ''
      : state.output ?? ''
  return {
    id: String(partData.callId || partId || `zcd-tool-${randomUUID().slice(0, 8)}`),
    name: String(partData.tool || state.title || 'tool'),
    input: state.input && typeof state.input === 'object' ? state.input : {},
    status,
    output: typeof outputRaw === 'string' ? outputRaw.slice(0, 3000) : JSON.stringify(outputRaw).slice(0, 3000),
  }
}

/**
 * Convert ZCode SQLite `message` + `part` rows into All in One's unified conversation message array.
 */
export function normalizeZCodeDbMessages(msgRows = [], partRows = []) {
  const partsByMsgId = new Map()
  for (const row of partRows || []) {
    const mid = String(row?.message_id || '')
    if (!mid) continue
    let list = partsByMsgId.get(mid)
    if (!list) {
      list = []
      partsByMsgId.set(mid, list)
    }
    list.push(row)
  }

  const messages = []
  let lastModel = ''

  for (const mRow of msgRows || []) {
    const info = safeJsonParse(mRow?.data, {}) || {}
    const role = info.role === 'user' ? 'user' : info.role === 'assistant' ? 'assistant' : ''
    if (!role) continue

    const rawModel =
      info.modelID ||
      info.modelId ||
      info.model?.modelID ||
      info.model?.modelId ||
      info.modelSelection?.modelId ||
      ''
    if (rawModel) lastModel = normalizeZCodeModelId(rawModel)

    // Skip internal system-injected context rows (environment, skills catalog, date reminders)
    if (info.synthetic === true || info.visibility === 'model-only' || info.hidden === true) continue

    const msgId = String(mRow.id || `zcd-m-${messages.length}`)
    const ts = toEpochMs(info?.time?.created || mRow.time_created || mRow.time_updated || Date.now())

    const pRows = partsByMsgId.get(msgId) || []
    const textChunks = []
    const thinkingChunks = []
    const tools = []
    const images = []

    for (const pRow of pRows) {
      const p = safeJsonParse(pRow?.data, null)
      if (!p || typeof p !== 'object') continue
      if (p.ignored === true || p.synthetic === true) continue

      if (p.type === 'text' && typeof p.text === 'string') {
        const trimmed = p.text.trim()
        if (trimmed) textChunks.push(p.text)
      } else if (p.type === 'reasoning' && typeof p.text === 'string') {
        const trimmed = p.text.trim()
        if (trimmed) thinkingChunks.push(trimmed)
      } else if (p.type === 'tool') {
        tools.push(normalizeZCodeToolState(p, pRow.id))
      } else if (p.type === 'file') {
        const mime = String(p.mime || '').toLowerCase()
        const url = String(p.url || '').trim()
        const name = String(p.filename || (url ? basename(url) : 'file')).trim()
        if (mime.startsWith('image/') && url) {
          if (url.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('/')) {
            const cleanPath = url.replace(/^file:\/\/\/?/i, '')
            images.push({ path: cleanPath, name })
          } else {
            images.push({ url, name })
          }
        } else if (name) {
          textChunks.push(`[附件: ${name}]`)
        }
      } else if (p.type === 'subagent') {
        tools.push({
          id: String(pRow.id || `zcd-sub-${tools.length}`),
          name: `Subagent (${p.agent || 'agent'})`,
          input: { description: p.description || '', prompt: String(p.prompt || '').slice(0, 400) },
          status: 'completed',
          output: '',
        })
      }
    }

    if (role === 'assistant' && info.error && textChunks.length === 0) {
      const errMsg = typeof info.error === 'string' ? info.error : info.error?.message || ''
      if (errMsg) textChunks.push(`⚠️ ${errMsg}`)
    }

    const text = textChunks.join('\n').trim()
    const thinking = thinkingChunks.join('\n\n').trim()
    if (!text && !thinking && tools.length === 0 && images.length === 0) continue

    if (role === 'user') {
      messages.push({
        id: msgId,
        role: 'user',
        text,
        ...(images.length > 0 ? { images } : {}),
        ts,
      })
    } else {
      messages.push({
        id: msgId,
        role: 'assistant',
        text,
        ...(thinking ? { thinking } : {}),
        tools,
        ts,
      })
    }
  }

  return {
    messages: mergeAndCompactMessages(messages),
    model: lastModel,
  }
}

/**
 * Convert ZCode SQLite `todo` + `session_target` rows into unified `taskState`.
 */
export function extractZCodeTaskState(todoRows = [], targetRow = null, mode = '') {
  const tracker = createTaskStateTracker()
  const normMode = normalizeTaskMode(mode)
  if (normMode === 'plan') tracker.setMode('plan', Date.now())

  if (targetRow && targetRow.objective) {
    tracker.setGoal(
      {
        objective: String(targetRow.objective).trim(),
        status: String(targetRow.status || 'active'),
      },
      toEpochMs(targetRow.time_updated || targetRow.time_created || Date.now()),
    )
  }

  if (Array.isArray(todoRows) && todoRows.length > 0) {
    const items = todoRows
      .filter((t) => t && String(t.content || '').trim())
      .map((t) => ({
        content: String(t.content).trim(),
        status: String(t.status || 'pending').toLowerCase(),
      }))
    if (items.length > 0) {
      tracker.applyClaudeTool('TodoWrite', { todos: items }, Date.now())
    }
  }

  return tracker.snapshot()
}

/**
 * Parse a single NDJSON object emitted by `zcode.cjs -p ... --output-format stream-json`.
 */
export function parseZCodeStreamEvent(obj) {
  if (!obj || typeof obj !== 'object') return null
  const type = String(obj.type || '')
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : {}
  const sessionId = typeof obj.sessionId === 'string' && obj.sessionId.trim() ? obj.sessionId.trim() : ''

  if (type === 'result') {
    return {
      kind: 'result',
      sessionId,
      response: typeof obj.response === 'string' ? obj.response : '',
      usage: obj.usage || null,
      projection: obj.projection || null,
    }
  }
  if (type === 'session.created' || type === 'session.resumed') {
    return { kind: 'session', sessionId }
  }
  if (type === 'model.streaming') {
    const pk = String(payload.kind || '')
    const delta = typeof payload.delta === 'string' ? payload.delta : ''
    if (pk === 'text_delta' && delta) {
      return { kind: 'text_delta', sessionId, delta }
    }
    if (pk === 'reasoning_delta' && delta) {
      return { kind: 'thinking_delta', sessionId, delta }
    }
    return null
  }
  if (type === 'tool.updated') {
    const pk = String(payload.kind || '')
    const toolId = String(payload.toolCallId || payload.callId || payload.id || '')
    const toolName = String(payload.toolName || payload.tool || payload.name || 'tool')
    if ((pk === 'scheduled' || pk === 'started') && toolId) {
      return {
        kind: 'tool_start',
        sessionId,
        tool: {
          id: toolId,
          name: toolName,
          input: payload.input && typeof payload.input === 'object' ? payload.input : {},
        },
      }
    }
    if ((pk === 'result' || pk === 'error') && toolId) {
      const rawOut =
        pk === 'error'
          ? payload.error || payload.message || payload.result || ''
          : payload.result ?? payload.output ?? ''
      const output = typeof rawOut === 'string' ? rawOut.slice(0, 3000) : JSON.stringify(rawOut).slice(0, 3000)
      return {
        kind: 'tool_end',
        sessionId,
        toolId,
        status: pk === 'error' ? 'error' : 'completed',
        output,
      }
    }
    return null
  }
  if (type === 'turn.completed') {
    return {
      kind: 'turn_done',
      sessionId,
      response: typeof payload.response === 'string' ? payload.response : '',
    }
  }
  if (type === 'turn.failed') {
    const msg =
      (typeof payload.error === 'string' ? payload.error : payload.error?.message) ||
      payload.message ||
      'ZCode 执行出错'
    return {
      kind: 'turn_error',
      sessionId,
      message: String(msg),
    }
  }
  return null
}

function readZCodeSqliteSync(dbPath, mode = 'list', sessionId = '') {
  if (!dbPath || !existsSync(dbPath)) return null
  const DatabaseSync = getDatabaseSync()
  if (!DatabaseSync) return null
  let db = null
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true })
    if (mode === 'list') {
      const sessions = db
        .prepare(
          `SELECT id, project_id, workspace_id, parent_id, directory, path, title, time_created, time_updated, time_archived, time_deleted
           FROM session
           WHERE time_deleted IS NULL AND time_archived IS NULL AND (parent_id IS NULL OR parent_id = '')
           ORDER BY time_updated DESC
           LIMIT 200`,
        )
        .all()
      let presences = []
      try {
        presences = db
          .prepare(`SELECT session_id, status, last_seen_at FROM session_runtime_presence`)
          .all()
      } catch {}
      // Latest visible (non-synthetic) message preview per session (bounded)
      let previews = []
      try {
        previews = db
          .prepare(
            `SELECT m.session_id, m.data AS msg_data, p.data AS part_data
             FROM message m
             LEFT JOIN part p ON p.message_id = m.id
             WHERE m.id IN (
               SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY COALESCE(sequence, 0) DESC, time_created DESC) AS rn
                 FROM message
                 WHERE COALESCE(json_extract(data, '$.synthetic'), 0) != 1
                   AND COALESCE(json_extract(data, '$.visibility'), '') != 'model-only'
               ) WHERE rn = 1
             )`,
          )
          .all()
      } catch {
        try {
          previews = db
            .prepare(
              `SELECT m.session_id, m.data AS msg_data, p.data AS part_data
               FROM message m
               LEFT JOIN part p ON p.message_id = m.id
               WHERE m.id IN (
                 SELECT id FROM (
                   SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY COALESCE(sequence, 0) DESC, time_created DESC) AS rn
                   FROM message
                 ) WHERE rn = 1
               )`,
            )
            .all()
        } catch {}
      }
      return { sessions, presences, previews }
    }
    if (mode === 'read') {
      const session = db
        .prepare(
          `SELECT id, project_id, workspace_id, parent_id, directory, path, title, time_created, time_updated
           FROM session WHERE id = ?`,
        )
        .get(sessionId)
      if (!session) return null
      const messages = db
        .prepare(
          `SELECT id, session_id, time_created, time_updated, data, sequence
           FROM message WHERE session_id = ?
           ORDER BY COALESCE(sequence, 0) ASC, time_created ASC, id ASC`,
        )
        .all(sessionId)
      const parts = db
        .prepare(
          `SELECT id, message_id, session_id, time_created, time_updated, data, sequence
           FROM part WHERE session_id = ?
           ORDER BY COALESCE(sequence, 0) ASC, time_created ASC, id ASC`,
        )
        .all(sessionId)
      let todos = []
      try {
        todos = db
          .prepare(`SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position ASC`)
          .all(sessionId)
      } catch {}
      let target = null
      try {
        target = db
          .prepare(`SELECT objective, status, time_created, time_updated FROM session_target WHERE session_id = ?`)
          .get(sessionId)
      } catch {}
      let presence = null
      try {
        presence = db
          .prepare(`SELECT status, last_seen_at FROM session_runtime_presence WHERE session_id = ?`)
          .get(sessionId)
      } catch {}
      return { session, messages, parts, todos, target, presence }
    }
    return null
  } catch {
    return null
  } finally {
    if (db) {
      try { db.close() } catch {}
    }
  }
}

async function readZCodeSqliteAsync(dbPath, mode = 'list', sessionId = '') {
  if (!dbPath || !existsSync(dbPath)) return null
  const syncRes = readZCodeSqliteSync(dbPath, mode, sessionId)
  if (syncRes !== null) return syncRes
  if (getDatabaseSync()) return null

  // Electron runtime fallback via Python stdlib sqlite3
  const pyCode =
    mode === 'list'
      ? `import sqlite3, json, sys
p = sys.argv[1]
con = sqlite3.connect('file:' + p + '?mode=ro', uri=True, timeout=1.5)
con.row_factory = sqlite3.Row
out = {'sessions': [], 'presences': [], 'previews': []}
try:
  out['sessions'] = [dict(r) for r in con.execute("SELECT id, project_id, workspace_id, parent_id, directory, path, title, time_created, time_updated, time_archived, time_deleted FROM session WHERE time_deleted IS NULL AND time_archived IS NULL AND (parent_id IS NULL OR parent_id = '') ORDER BY time_updated DESC LIMIT 200").fetchall()]
except Exception: pass
try:
  out['presences'] = [dict(r) for r in con.execute("SELECT session_id, status, last_seen_at FROM session_runtime_presence").fetchall()]
except Exception: pass
print(json.dumps(out))
`
      : `import sqlite3, json, sys
p, sid = sys.argv[1], sys.argv[2]
con = sqlite3.connect('file:' + p + '?mode=ro', uri=True, timeout=1.5)
con.row_factory = sqlite3.Row
s = con.execute("SELECT id, project_id, workspace_id, parent_id, directory, path, title, time_created, time_updated FROM session WHERE id = ?", (sid,)).fetchone()
if not s:
  print("null")
  sys.exit(0)
out = {
  'session': dict(s),
  'messages': [dict(r) for r in con.execute("SELECT id, session_id, time_created, time_updated, data, sequence FROM message WHERE session_id = ? ORDER BY COALESCE(sequence, 0) ASC, time_created ASC, id ASC", (sid,)).fetchall()],
  'parts': [dict(r) for r in con.execute("SELECT id, message_id, session_id, time_created, time_updated, data, sequence FROM part WHERE session_id = ? ORDER BY COALESCE(sequence, 0) ASC, time_created ASC, id ASC", (sid,)).fetchall()],
  'todos': [],
  'target': None,
  'presence': None,
}
try:
  out['todos'] = [dict(r) for r in con.execute("SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position ASC", (sid,)).fetchall()]
except Exception: pass
try:
  t = con.execute("SELECT objective, status, time_created, time_updated FROM session_target WHERE session_id = ?", (sid,)).fetchone()
  if t: out['target'] = dict(t)
except Exception: pass
try:
  pr = con.execute("SELECT status, last_seen_at FROM session_runtime_presence WHERE session_id = ?", (sid,)).fetchone()
  if pr: out['presence'] = dict(pr)
except Exception: pass
print(json.dumps(out))
`
  return await runPythonSqliteJson(pyCode, mode === 'read' ? [dbPath, sessionId] : [dbPath], 4_000)
}

function readZCodeTasksIndexSync(tasksDbPath) {
  if (!tasksDbPath || !existsSync(tasksDbPath)) return null
  const DatabaseSync = getDatabaseSync()
  if (!DatabaseSync) return null
  let db = null
  try {
    db = new DatabaseSync(tasksDbPath, { open: true, readOnly: true })
    let tasks = []
    let projects = []
    try {
      tasks = db
        .prepare(
          `SELECT task_id, workspace_path, title, task_status, provider, mode, model, created_at, updated_at
           FROM tasks ORDER BY updated_at DESC LIMIT 200`,
        )
        .all()
    } catch {}
    try {
      projects = db
        .prepare(
          `SELECT p.name, r.root_path
           FROM projects p
           JOIN project_roots r ON r.project_id = p.project_id
           WHERE p.deleted = 0
           ORDER BY p.pinned DESC, p.position ASC`,
        )
        .all()
    } catch {}
    return { tasks, projects }
  } catch {
    return null
  } finally {
    if (db) {
      try { db.close() } catch {}
    }
  }
}

async function readZCodeTasksIndexAsync(tasksDbPath) {
  if (!tasksDbPath || !existsSync(tasksDbPath)) return { tasks: [], projects: [] }
  const syncRes = readZCodeTasksIndexSync(tasksDbPath)
  if (syncRes !== null) return syncRes
  if (getDatabaseSync()) return { tasks: [], projects: [] }

  const pyCode = `import sqlite3, json, sys
con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True, timeout=1.5)
con.row_factory = sqlite3.Row
out = {'tasks': [], 'projects': []}
try:
  out['tasks'] = [dict(r) for r in con.execute("SELECT task_id, workspace_path, title, task_status, provider, mode, model, created_at, updated_at FROM tasks ORDER BY updated_at DESC LIMIT 200").fetchall()]
except Exception: pass
try:
  out['projects'] = [dict(r) for r in con.execute("SELECT p.name, r.root_path FROM projects p JOIN project_roots r ON r.project_id = p.project_id WHERE p.deleted = 0 ORDER BY p.pinned DESC, p.position ASC").fetchall()]
except Exception: pass
print(json.dumps(out))
`
  const res = await runPythonSqliteJson(pyCode, [tasksDbPath], 3_000)
  return res || { tasks: [], projects: [] }
}

function isPresenceRunning(presence, now = Date.now()) {
  if (!presence) return false
  const st = String(presence.status || '').toLowerCase()
  const active = st === 'running' || st === 'streaming' || st === 'busy' || st === 'working'
  if (!active) return false
  const seen = toEpochMs(presence.last_seen_at)
  return !seen || now - seen <= ZCODE_EXTERNAL_ACTIVE_WINDOW_MS
}

function extractPreviewFromRows(previewRows = []) {
  const bySession = new Map()
  for (const row of previewRows || []) {
    const sid = String(row?.session_id || '')
    if (!sid) continue
    const m = safeJsonParse(row?.msg_data, null)
    if (m?.synthetic === true || m?.visibility === 'model-only' || m?.hidden === true) continue
    const p = safeJsonParse(row?.part_data, null)
    if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim() && !p.ignored && !p.synthetic) {
      const clean = p.text.replace(/\s+/g, ' ').trim().slice(0, 120)
      if (clean) bySession.set(sid, clean)
    }
  }
  return bySession
}

/**
 * Adapter for Zhipu ZCode (智谱 ZCode) Desktop & CLI.
 *
 * Architecture:
 *  - Read & live sync: directly reads `~/.zcode/cli/db/db.sqlite` (WAL) + `~/.zcode/v2/tasks-index.sqlite`
 *    + `~/.zcode/v2/setting.json`, and watches updates via `SessionExternalWatcher`.
 *  - Quota monitoring: extracts live `billing/balance` plan entitlements from ZCode Desktop's
 *    local log (`~/.zcode/v2/logs/YYYY-MM-DD.log`) with zero credential decryption or extra network calls.
 *  - Write & streaming: spawns official `zcode.cjs -p ... --output-format stream-json` (auto-located from
 *    ZCode Desktop's bundled `resources/glm/zcode.cjs` + bundled Node runtime, or standalone `zcode` CLI)
 *    with `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and per-turn model selection overlay.
 *  - 1-Click OAuth Setup: supports `app.setup` via official `zcode login [bigmodel|zai] --no-browser --json`.
 */
export class ZCodeAdapter extends BaseAdapter {
  constructor({ config = {}, log = console, emitEvent, onApprovalRequest } = {}) {
    super(APPS.ZCODE, {
      config,
      log,
      emitEvent,
      onApprovalRequest,
      capabilities: {
        supportsWorkspaces: true,
        supportsSetup: true,
        supportsApproval: false,
        supportsMidChatSwitch: true,
        supportsAttachments: true,
        supportsQuota: true,
      },
    })

    this.env = config.env || process.env
    this.zcodeHome = getZCodeHome(config.zcodeHome || '', this.env)
    this.managedAuthDir = getZCodeManagedAuthDir(config.zcodeAuthDir || '', this.env)
    this.defaultCwd = config.cwd || process.cwd()
    this.configuredBin = String(config.zcodeBin || '').trim()
    this.permissionMode = ALLOWED_ZCODE_MODES.includes(config.zcodeMode) ? config.zcodeMode : 'build'
    this.spawnFn = config.spawnFn || ((bin, args, opts) => spawnCrossPlatform(bin, args, opts))
    this.launcher = this._resolveLauncher()

    /** @type {Map<string, any>} nativeOrPendingId -> active turn state */
    this.activeProcs = new Map()
    /** @type {BoundedLruMap<string, string>} pendingId -> real sess_... id */
    this.aliasToNative = new BoundedLruMap(128)
    /** @type {BoundedLruMap<string, string>} real sess_... id -> pendingId */
    this.nativeToAlias = new BoundedLruMap(128)
    /** @type {any} active login subprocess */
    this.activeLoginSession = null
    /** @type {Set<string>} temp overlay dirs cleaned up on turn end / dispose */
    this._tempDirs = new Set()

    this.quotaManager = new QuotaCacheManager({
      app: APPS.ZCODE,
      ttlMs: Number(config.zcodeQuotaTtlMs) || ZCODE_QUOTA_CACHE_TTL_MS,
      emitEvent: this.emitEvent,
      fetcher: async () => {
        if (typeof config.fetchZCodeQuota === 'function') {
          return await config.fetchZCodeQuota()
        }
        return readZCodeQuotaFromLogs(this.zcodeHome)
      },
      isValid: (q, now) => Boolean(q && typeof q.remainingPercent === 'number' && (!q.resetsAt || now <= q.resetsAt + 60_000)),
    })

    this.watcher = new SessionExternalWatcher({
      pollMs: Number(config.zcodeWatchPollMs) || ZCODE_WATCH_POLL_MS,
      maxWatched: 8,
      maxTracked: 30,
      watchTtlMs: ZCODE_WATCH_TTL_MS,
      listWatchTtlMs: ZCODE_LIST_WATCH_TTL_MS,
      onPoll: (ctx) => this._pollExternalUpdates(ctx),
    })
  }

  get dbPath() {
    return join(this.zcodeHome, 'cli', 'db', 'db.sqlite')
  }

  get tasksDbPath() {
    return join(this.zcodeHome, 'v2', 'tasks-index.sqlite')
  }

  get settingPath() {
    return join(this.zcodeHome, 'v2', 'setting.json')
  }

  get personalProviderConfigPath() {
    if (this._useManagedAuthStore()) {
      return join(this.managedAuthDir, 'provider_config.json')
    }
    return join(this.zcodeHome, 'v2', 'provider_config.json')
  }

  _useManagedAuthStore() {
    return Boolean(
      this.managedAuthDir &&
        existsSync(join(this.managedAuthDir, 'credential-secret')) &&
        hasAuthFilesInDir(this.managedAuthDir),
    )
  }

  _resolveLauncher() {
    if (this.config.zcodeLauncher) return this.config.zcodeLauncher
    return findZCodeLauncher({
      env: this.env,
      configuredBin: this.configuredBin,
      zcodeHome: this.zcodeHome,
    })
  }

  refreshBinary() {
    this.launcher = this._resolveLauncher()
  }

  resolveNativeId(sessionId) {
    const clean = String(sessionId || '').trim()
    return this.aliasToNative.get(clean) || clean
  }

  isCliInstalled() {
    if (!this.launcher) this.launcher = this._resolveLauncher()
    return Boolean(this.launcher?.bin)
  }

  isStandaloneAuthenticated() {
    if (typeof this.config.checkZCodeAuth === 'function') {
      return Boolean(this.config.checkZCodeAuth())
    }
    return hasZCodeStandaloneAuth({
      zcodeHome: this.zcodeHome,
      authDir: this.managedAuthDir,
      env: this.env,
    })
  }

  hasLocalData() {
    return (
      existsSync(this.dbPath) ||
      existsSync(this.tasksDbPath) ||
      existsSync(this.settingPath) ||
      existsSync(this.personalProviderConfigPath)
    )
  }

  _buildCliEnv({ personalConfigOverridePath = '', ensureManagedAuth = false } = {}) {
    const env = sanitizeChildEnv({ ...process.env, ...this.env })
    const builtinPath =
      this.launcher?.builtinConfigPath ||
      findZCodeBuiltinConfig(this.zcodeHome, this.launcher?.resourceRoot || '')
    if (builtinPath) {
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinPath
    }

    const useManaged = ensureManagedAuth || this._useManagedAuthStore()
    if (useManaged) {
      const store = ensureZCodeManagedAuthStore(this.managedAuthDir)
      // Never set both ZCODE_CREDENTIAL_SECRET and ZCODE_CREDENTIAL_SECRET_FILE
      delete env.ZCODE_CREDENTIAL_SECRET
      env.ZCODE_CREDENTIAL_SECRET_FILE = store.secretFile
      env.ZCODE_CREDENTIALS_FILE = store.credentialsFile
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalConfigOverridePath || store.providerConfigFile
    } else {
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE =
        personalConfigOverridePath || this.personalProviderConfigPath
    }

    if (this.zcodeHome !== join(homedir(), '.zcode')) {
      const parentDir = join(this.zcodeHome, '..')
      if (basename(this.zcodeHome).toLowerCase() === '.zcode') {
        env.ZCODE_DATA_BASE_DIR = parentDir
      }
    }
    return env
  }

  _readProviderCatalogContext() {
    const setting = safeReadJson(this.settingPath) || {}
    const personal = safeReadJson(this.personalProviderConfigPath) || {}
    const builtinPath =
      this.launcher?.builtinConfigPath ||
      findZCodeBuiltinConfig(this.zcodeHome, this.launcher?.resourceRoot || '')
    const builtin = safeReadJson(builtinPath) || {}

    const domain = setting.providerFamilyDomain === 'zai' ? 'zai' : 'bigmodel'
    const connKind =
      setting.providerFamilyConnectionSelections?.[domain]?.kind || 'individual-coding-plan'
    const defaultProviderFromSetting =
      DEFAULT_PROVIDER_BY_DOMAIN[domain]?.[connKind] ||
      DEFAULT_PROVIDER_BY_DOMAIN[domain]['individual-coding-plan']

    const configuredDef = personal?.config?.defaultModelSelection || null
    const defaultProvider = String(configuredDef?.providerId || defaultProviderFromSetting)
    const pRules = builtin?.config?.providerConfigRules?.providerRules || []
    const matchedRule =
      pRules.find((r) => r?.providerId === defaultProvider) ||
      pRules.find((r) => String(r?.providerId || '').includes(domain)) ||
      null
    const firstBuiltinModel = Array.isArray(matchedRule?.config?.builtinModelIds)
      ? String(matchedRule.config.builtinModelIds[0] || '').trim()
      : ''
    const defaultModel = normalizeZCodeModelId(configuredDef?.modelId || firstBuiltinModel || 'GLM-5.4')
    const defaultEffort =
      normalizeZCodeReasoningLevel(configuredDef?.options?.reasoningLevel || '', defaultModel, builtin) ||
      resolveZCodeModelEfforts(defaultModel, builtin).defaultEffort

    return {
      setting,
      personal,
      builtin,
      domain,
      defaultProvider,
      defaultModel,
      defaultEffort,
    }
  }

  /**
   * Build a temporary cloned `provider_config.json` when the caller specifies a model/effort
   * different from the user's persisted default — avoids mutating `~/.zcode/v2/provider_config.json`.
   */
  _createTempModelConfigOverlay({ model = '', provider = '', reasoningEffort = '' } = {}) {
    const cleanModel = String(model || '').trim()
    const cleanEffort = String(reasoningEffort || '').trim()
    if (!cleanModel && !cleanEffort) return null

    const ctx = this._readProviderCatalogContext()
    let targetProvider = String(provider || '').trim() || ctx.defaultProvider
    let targetModel = cleanModel || ctx.defaultModel
    if (targetModel.includes('/')) {
      const idx = targetModel.indexOf('/')
      targetProvider = targetModel.slice(0, idx)
      targetModel = targetModel.slice(idx + 1)
    }
    targetModel = normalizeZCodeModelId(targetModel)
    const normalizedEffort = cleanEffort
      ? normalizeZCodeReasoningLevel(cleanEffort, targetModel, ctx.builtin)
      : ''

    // If matching existing defaultModelSelection, skip overlay creation
    const cur = ctx.personal?.config?.defaultModelSelection
    if (
      cur &&
      cur.providerId === targetProvider &&
      cur.modelId === targetModel &&
      (!normalizedEffort || cur.options?.reasoningLevel === normalizedEffort)
    ) {
      return null
    }

    const dir = mkdtempSync(join(tmpdir(), 'allinone-zcode-cfg-'))
    this._tempDirs.add(dir)
    const filePath = join(dir, 'provider_config.json')
    const baseCfg =
      ctx.personal && typeof ctx.personal === 'object' && ctx.personal.config
        ? structuredClone(ctx.personal)
        : {
            schemaVersion: 1,
            config: {
              providerConfigRules: { providerRules: [] },
              modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
            },
          }
    baseCfg.config = baseCfg.config || {}
    baseCfg.config.defaultModelSelection = {
      providerId: targetProvider,
      modelId: targetModel,
      ...(normalizedEffort ? { options: { reasoningLevel: normalizedEffort } } : {}),
    }
    writeFileSync(filePath, JSON.stringify(baseCfg, null, 2), 'utf8')
    return {
      filePath,
      cleanup: () => {
        this._tempDirs.delete(dir)
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
      },
    }
  }

  async getStatus({ forceQuota = false } = {}) {
    const cliInstalled = this.isCliInstalled()
    const hasData = this.hasLocalData()
    const available = cliInstalled || hasData

    if (!available) {
      return {
        app: APPS.ZCODE,
        available: false,
        writable: false,
        cliInstalled: false,
        setupState: 'not_installed',
        mode: 'unavailable',
        detail: '未检测到本机智谱 ZCode 安装或本地数据目录',
        activeCount: 0,
      }
    }

    const authed = cliInstalled && this.isStandaloneAuthenticated()
    let quota = this.quotaManager.getValid()
    if (forceQuota || !quota) {
      quota = await this.quotaManager.refreshInBackground({ force: forceQuota }).catch(() => quota)
    }

    const writable = cliInstalled && authed
    const setupState = writable ? 'ready' : cliInstalled ? 'needs_login' : 'needs_cli'

    return {
      app: APPS.ZCODE,
      available: true,
      writable,
      cliInstalled,
      setupState,
      mode: writable ? 'zcode-cli-rw' : 'zcode-desktop-ro',
      detail: writable
        ? '智谱 ZCode 读写就绪（复用官方原生流式协议与本地会话库）'
        : cliInstalled
          ? '已同步 ZCode 桌面端会话（只读）· 一键浏览器授权一次即可解锁远程发送'
          : '已检测到 ZCode 本地会话数据（只读）· 请安装 ZCode 桌面端或 CLI 解锁远程发送',
      activeCount: this.activeProcs.size,
      ...(quota ? { quota } : {}),
    }
  }

  async listModels() {
    const ctx = this._readProviderCatalogContext()
    const models = []
    const seen = new Set()

    const addModel = (id, name, providerId = ctx.defaultProvider, effortsOverride = null) => {
      const cleanId = normalizeZCodeModelId(id)
      if (!cleanId) return
      const key = cleanId.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      const resolved = resolveZCodeModelEfforts(cleanId, ctx.builtin)
      const efforts = Array.isArray(effortsOverride) && effortsOverride.length > 0 ? [...effortsOverride] : resolved.efforts
      models.push({
        id: cleanId,
        name: String(name || cleanId).trim(),
        provider: providerId,
        efforts,
        defaultEffort: resolved.defaultEffort,
      })
    }

    // 1. User's configured default model first
    if (ctx.defaultModel) {
      addModel(ctx.defaultModel, ctx.defaultModel, ctx.defaultProvider)
    }

    // 2. Models from matching builtin provider rule (e.g. account:bigmodel-individual-coding-plan)
    const pRules = ctx.builtin?.config?.providerConfigRules?.providerRules || []
    const matchedRule =
      pRules.find((r) => r?.providerId === ctx.defaultProvider) ||
      pRules.find((r) => String(r?.providerId || '').includes(ctx.domain)) ||
      null
    if (Array.isArray(matchedRule?.config?.builtinModelIds)) {
      for (const mid of matchedRule.config.builtinModelIds) {
        addModel(mid, mid, matchedRule.providerId || ctx.defaultProvider)
      }
    }

    // 3. Any additional official GLM models listed in builtinProviderModelRules for this domain
    const bpmRules = ctx.builtin?.config?.modelConfigRules?.builtinProviderModelRules || []
    for (const rule of bpmRules) {
      if (!rule?.modelId) continue
      const pid = String(rule.providerId || '')
      if (pid === ctx.defaultProvider || pid.includes(ctx.domain)) {
        addModel(rule.modelId, rule.modelId, pid || ctx.defaultProvider)
      }
    }

    // 4. Custom manual models in user's provider_config.json
    const manualModels = ctx.personal?.config?.modelConfigRules?.manualProviderModelRules || []
    for (const m of manualModels) {
      const mid = String(m?.modelId || m?.id || '').trim()
      if (mid) addModel(mid, m?.name || m?.displayName || mid, m?.providerId || ctx.defaultProvider)
    }

    // 5. Curated GLM fallback set so picker is always rich even without builtin JSON
    for (const fm of ZCODE_FALLBACK_MODELS) {
      addModel(fm.id, fm.name, ctx.defaultProvider, fm.efforts)
    }

    return {
      app: APPS.ZCODE,
      defaultModel: ctx.defaultModel || models[0]?.id || 'GLM-5.3',
      defaultProvider: ctx.defaultProvider,
      defaultEffort: ctx.defaultEffort || 'high',
      supportsMidChatSwitch: true,
      models,
    }
  }

  async listWorkspaces() {
    const map = new Map()
    const addWs = (rawPath, name = '', source = 'zcode') => {
      const p = String(rawPath || '').trim()
      if (!p || !existsSync(p)) return
      const key = p.toLowerCase()
      if (map.has(key)) return
      map.set(key, {
        name: String(name || basename(p) || p).trim(),
        path: p,
        source,
      })
    }

    const tasksIdx = await readZCodeTasksIndexAsync(this.tasksDbPath)
    for (const proj of tasksIdx.projects || []) {
      addWs(proj.root_path, proj.name, 'zcode-project')
    }
    for (const t of tasksIdx.tasks || []) {
      addWs(t.workspace_path, '', 'zcode-task')
    }

    const setting = safeReadJson(this.settingPath) || {}
    if (setting.lastActiveWorkspace?.workspacePath) {
      addWs(setting.lastActiveWorkspace.workspacePath, '', 'zcode-last')
    }
    for (const rp of Array.isArray(setting.recentProjects) ? setting.recentProjects : []) {
      const p = typeof rp === 'string' ? rp : rp?.path || rp?.workspacePath
      addWs(p, typeof rp === 'object' ? rp?.name || '' : '', 'zcode-recent')
    }

    const dbSnap = await readZCodeSqliteAsync(this.dbPath, 'list')
    for (const s of dbSnap?.sessions || []) {
      addWs(s.path || s.directory, '', 'zcode-session')
    }

    return [...map.values()]
  }

  async listSessions({ limit = 50, search = '' } = {}) {
    this.watcher.markListActive()
    const writable = this.isCliInstalled() && this.isStandaloneAuthenticated()
    const [dbSnap, tasksIdx] = await Promise.all([
      readZCodeSqliteAsync(this.dbPath, 'list'),
      readZCodeTasksIndexAsync(this.tasksDbPath),
    ])

    const taskById = new Map()
    for (const t of tasksIdx.tasks || []) {
      if (t?.task_id) taskById.set(String(t.task_id), t)
    }
    const presenceById = new Map()
    for (const p of dbSnap?.presences || []) {
      if (p?.session_id) presenceById.set(String(p.session_id), p)
    }
    const previewById = extractPreviewFromRows(dbSnap?.previews || [])

    const items = []
    const seenIds = new Set()
    const now = Date.now()

    for (const s of dbSnap?.sessions || []) {
      const sid = String(s.id || '').trim()
      if (!sid) continue
      seenIds.add(sid)
      const alias = this.nativeToAlias.get(sid)
      if (alias) this.pendingCreated.delete(alias)
      this.pendingCreated.delete(sid)

      const taskRow = taskById.get(sid) || null
      const presence = presenceById.get(sid) || null
      const cwd = String(s.path || s.directory || taskRow?.workspace_path || '').trim()
      const title =
        String(s.title || taskRow?.title || '').trim() ||
        previewById.get(sid)?.slice(0, 56) ||
        sid
      const preview = previewById.get(sid) || ''
      const updatedAt = Math.max(
        toEpochMs(s.time_updated || s.time_created),
        toEpochMs(taskRow?.updated_at),
      )
      const createdAt = toEpochMs(s.time_created || taskRow?.created_at) || updatedAt
      const externalRunning = isPresenceRunning(presence, now)
      const isLocalActive = this.activeProcs.has(sid) || (alias ? this.activeProcs.has(alias) : false)
      const model = String(this.sessionPrefs.get(sid)?.model || taskRow?.model || '').trim()

      const summary = {
        id: makeCompositeId(APPS.ZCODE, sid),
        app: APPS.ZCODE,
        nativeId: sid,
        title,
        preview,
        cwd,
        workspace: cwd ? basename(cwd) : 'ZCode',
        model,
        source: 'zcode-desktop',
        status: isLocalActive || externalRunning ? 'running' : 'idle',
        writable,
        createdAt,
        updatedAt,
      }
      items.push(summary)
      this.watcher.rememberTracked(sid, { updatedAt, externalRunning })
    }

    // Include pending newly-created sessions not yet persisted in SQLite
    for (const pending of this.pendingCreated.values()) {
      const resolved = this.resolveNativeId(pending.nativeId)
      if (seenIds.has(pending.nativeId) || seenIds.has(resolved)) {
        this.pendingCreated.delete(pending.nativeId)
        continue
      }
      items.push({ ...pending, writable })
    }

    const q = String(search || '').trim().toLowerCase()
    const filtered = q
      ? items.filter(
          (it) =>
            it.title.toLowerCase().includes(q) ||
            it.preview.toLowerCase().includes(q) ||
            it.cwd.toLowerCase().includes(q) ||
            it.workspace.toLowerCase().includes(q),
        )
      : items

    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return filtered.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))
  }

  async readSession(sessionId, { limit = 25, cursor = null } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'ZCode sessionId')
    const resolvedId = this.resolveNativeId(sessionId)
    const writable = this.isCliInstalled() && this.isStandaloneAuthenticated()

    const pending = this.pendingCreated.get(sessionId)
    const dbData = await readZCodeSqliteAsync(this.dbPath, 'read', resolvedId)

    if (!dbData) {
      if (pending) {
        return {
          ...pending,
          writable,
          status: this.activeProcs.has(sessionId) ? 'running' : 'idle',
          messages: [],
          hasMore: false,
          nextCursor: null,
          totalCount: 0,
        }
      }
      throw new Error(`找不到 ZCode 会话：${sessionId}`)
    }

    const { session: sRow, messages: msgRows, parts: partRows, todos, target, presence } = dbData
    const parsed = normalizeZCodeDbMessages(msgRows, partRows)
    const tasksIdx = await readZCodeTasksIndexAsync(this.tasksDbPath)
    const taskRow = (tasksIdx.tasks || []).find((t) => String(t.task_id) === resolvedId) || null

    const cwd = String(sRow.path || sRow.directory || taskRow?.workspace_path || '').trim()
    const title = String(sRow.title || taskRow?.title || '').trim() || resolvedId
    const pref = this.sessionPrefs.get(resolvedId) || this.sessionPrefs.get(sessionId) || null
    const model = String(pref?.model || parsed.model || taskRow?.model || '').trim()
    const updatedAt = Math.max(
      toEpochMs(sRow.time_updated || sRow.time_created),
      toEpochMs(taskRow?.updated_at),
    )
    const externalRunning = isPresenceRunning(presence, Date.now())
    const isLocalActive = this.activeProcs.has(resolvedId) || this.activeProcs.has(sessionId)
    const taskState =
      this.sessionTaskStates.get(resolvedId) ||
      extractZCodeTaskState(todos, target, taskRow?.mode || '')

    this.watcher.rememberWatched(resolvedId, {
      updatedAt,
      messageCount: parsed.messages.length,
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
      id: makeCompositeId(APPS.ZCODE, sessionId),
      app: APPS.ZCODE,
      nativeId: sessionId,
      title,
      cwd,
      workspace: cwd ? basename(cwd) : 'ZCode',
      model,
      reasoningEffort: pref?.reasoningEffort || '',
      source: 'zcode-desktop',
      writable,
      status: isLocalActive || externalRunning ? 'running' : 'idle',
      taskState,
      syncState: {
        externalRunning,
        source: 'zcode-desktop',
      },
      messages: parsed.messages.slice(startIdx, endIdx),
      hasMore: startIdx > 0,
      nextCursor: startIdx > 0 ? String(startIdx) : null,
      totalCount: total,
      updatedAt,
    }
  }

  async createSession({ cwd, title, model, provider, reasoningEffort } = {}) {
    if (!this.isCliInstalled()) {
      const err = new Error('未检测到智谱 ZCode CLI / 桌面端运行引擎，请先在本机安装 ZCode。')
      err.code = 'SESSION_READONLY'
      throw err
    }
    if (!this.isStandaloneAuthenticated()) {
      const err = new Error('ZCode 当前处于只读同步模式，请先点击「一键登录授权 ZCode」完成初次浏览器授权后再新建对话。')
      err.code = 'SESSION_READONLY'
      throw err
    }

    const sessionId = `zcode-new-${randomUUID().slice(0, 12)}`
    const targetCwd = String(cwd || '').trim() || this.defaultCwd
    const ctx = this._readProviderCatalogContext()
    const effectiveModel = String(model || ctx.defaultModel || 'GLM-5.3').trim()
    const effectiveProvider = String(provider || ctx.defaultProvider || '').trim()
    const effectiveEffort = String(reasoningEffort || ctx.defaultEffort || '').trim()

    this.sessionPrefs.set(sessionId, {
      model: effectiveModel,
      provider: effectiveProvider,
      reasoningEffort: effectiveEffort,
    })

    const now = Date.now()
    const summary = {
      id: makeCompositeId(APPS.ZCODE, sessionId),
      app: APPS.ZCODE,
      nativeId: sessionId,
      title: title || '新 ZCode 对话',
      preview: '',
      cwd: targetCwd,
      workspace: basename(targetCwd) || 'ZCode',
      model: effectiveModel,
      provider: effectiveProvider,
      reasoningEffort: effectiveEffort,
      source: 'zcode-desktop',
      status: 'idle',
      writable: true,
      createdAt: now,
      updatedAt: now,
    }
    this.pendingCreated.set(sessionId, summary)
    return summary
  }

  async sendMessage(sessionId, { text, cwd, attachments = [], permissionMode, taskMode, model, provider, reasoningEffort } = {}) {
    sessionId = assertSafeSessionId(sessionId, 'ZCode sessionId')
    const resolvedId = this.resolveNativeId(sessionId)
    const compositeId = makeCompositeId(APPS.ZCODE, sessionId)

    if (this.activeProcs.has(sessionId) || this.activeProcs.has(resolvedId)) {
      const err = new Error('该 ZCode 会话正在运行中，请等待完成或先点击停止。')
      err.code = 'SESSION_BUSY'
      throw err
    }

    const reservation = { reserved: true, proc: null, aborted: false }
    this.activeProcs.set(sessionId, reservation)

    let overlay = null
    try {
      if (!this.isCliInstalled() || !this.launcher?.bin) {
        const err = new Error('未检测到智谱 ZCode 运行引擎，请先在本机安装 ZCode。')
        err.code = 'SESSION_READONLY'
        throw err
      }
      if (!this.isStandaloneAuthenticated()) {
        const err = new Error('请先点击「一键登录授权 ZCode」完成初次浏览器授权，随后即可正常发送消息。')
        err.code = 'SESSION_READONLY'
        throw err
      }

      const dbData = await readZCodeSqliteAsync(this.dbPath, 'read', resolvedId)
      if (dbData && isPresenceRunning(dbData.presence, Date.now())) {
        const err = new Error('该 ZCode 会话正在电脑端运行中（实时同步中），请等待电脑端完成后再发送。')
        err.code = 'SESSION_BUSY'
        throw err
      }

      const pending = this.pendingCreated.get(sessionId)
      let targetCwd = String(cwd || '').trim()
      if (!targetCwd && dbData?.session) {
        targetCwd = String(dbData.session.path || dbData.session.directory || '').trim()
      }
      if (!targetCwd && pending?.cwd) targetCwd = pending.cwd
      if (!targetCwd || !existsSync(targetCwd)) targetCwd = this.defaultCwd

      let prompt = String(text || '').trim()
      let effectiveTaskMode = normalizeTaskMode(taskMode)
      if (!effectiveTaskMode && prompt) {
        const planMatch = /^\/plan(?:\s+([\s\S]*))?$/i.exec(prompt)
        if (planMatch) {
          effectiveTaskMode = 'plan'
          const rest = String(planMatch[1] || '').trim()
          if (rest) prompt = rest
        }
      }

      const attachPaths = []
      const extraAttLines = []
      for (const att of attachments || []) {
        if (att?.localPath && existsSync(att.localPath)) {
          attachPaths.push(att.localPath)
        } else if (att?.localPath || att?.filename) {
          extraAttLines.push(`- 附件：${att.localPath || att.filename}`)
        }
      }
      if (extraAttLines.length > 0) {
        prompt = `${prompt}${prompt ? '\n\n' : ''}[上传的附件]\n${extraAttLines.join('\n')}`
      }
      if (!prompt) throw new Error('消息内容不能为空')

      const pref = this.sessionPrefs.get(resolvedId) || this.sessionPrefs.get(sessionId) || null
      const effectiveModel = assertSafeCliToken(model || pref?.model || '', 'model')
      const effectiveProvider = assertSafeCliToken(provider || pref?.provider || '', 'provider')
      const effectiveEffort = assertSafeCliToken(reasoningEffort || pref?.reasoningEffort || '', 'reasoningEffort')
      const effectiveMode = resolveEffectiveZCodeMode(permissionMode, this.permissionMode, effectiveTaskMode)

      if (effectiveModel || effectiveProvider || effectiveEffort) {
        const nextPref = {
          model: effectiveModel || pref?.model || '',
          provider: effectiveProvider || pref?.provider || '',
          reasoningEffort: effectiveEffort || pref?.reasoningEffort || '',
        }
        this.sessionPrefs.set(sessionId, nextPref)
        if (resolvedId !== sessionId) this.sessionPrefs.set(resolvedId, nextPref)
      }

      overlay = this._createTempModelConfigOverlay({
        model: effectiveModel,
        provider: effectiveProvider,
        reasoningEffort: effectiveEffort,
      })

      const cliArgs = [
        ...(this.launcher.baseArgs || []),
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--cwd',
        targetCwd,
        '--mode',
        effectiveMode,
      ]
      // Only pass --resume when the session already exists in ZCode SQLite (not a brand-new pending id)
      const isPersistedSession = Boolean(dbData) || (resolvedId.startsWith('sess_') && !pending)
      if (isPersistedSession) {
        cliArgs.push('--resume', resolvedId)
      }
      for (const ap of attachPaths) {
        cliArgs.push('--attach', ap)
      }

      const spawnEnv = this._buildCliEnv({
        personalConfigOverridePath: overlay?.filePath || '',
      })

      return await this._runStreamingTurn({
        sessionId,
        resolvedId,
        compositeId,
        targetCwd,
        cliArgs,
        spawnEnv,
        effectiveMode,
        isResumed: isPersistedSession,
        reservation,
        cleanupOverlay: overlay?.cleanup || null,
      })
    } catch (err) {
      if (this.activeProcs.get(sessionId) === reservation) {
        this.activeProcs.delete(sessionId)
      }
      overlay?.cleanup?.()
      throw err
    }
  }

  _runStreamingTurn({
    sessionId,
    resolvedId,
    compositeId,
    targetCwd,
    cliArgs,
    spawnEnv,
    effectiveMode,
    isResumed = false,
    reservation,
    cleanupOverlay,
  }) {
    this.emitEvent(EVENTS.STREAM_START, {
      sessionId: compositeId,
      app: APPS.ZCODE,
      nativeId: sessionId,
    })

    return new Promise((resolvePromise, rejectPromise) => {
      let overlayCleaned = false
      const runCleanup = () => {
        if (overlayCleaned) return
        overlayCleaned = true
        try { cleanupOverlay?.() } catch {}
      }

      let proc
      try {
        proc = this.spawnFn(this.launcher.bin, cliArgs, {
          cwd: targetCwd,
          env: spawnEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        if (this.activeProcs.get(sessionId) === reservation) this.activeProcs.delete(sessionId)
        runCleanup()
        if (err && typeof err === 'object') err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: APPS.ZCODE,
          message: String(err?.message || err),
        })
        rejectPromise(err)
        return
      }

      this.trackChildProcess(proc)
      proc.stdout.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')

      const taskTracker = createTaskStateTracker(this.sessionTaskStates.get(resolvedId) || null)
      if (effectiveMode === 'plan') {
        taskTracker.setMode('plan', Date.now())
      } else if (taskTracker.snapshot()?.mode === 'plan') {
        taskTracker.setMode(null, Date.now())
      }
      const emitTaskState = () => {
        const diff = taskTracker.consumeChanged()
        if (!diff.changed) return
        this.sessionTaskStates.set(resolvedId, diff.taskState)
        this.emitEvent(EVENTS.STREAM_TASK_STATE, {
          sessionId: compositeId,
          app: APPS.ZCODE,
          taskState: diff.taskState,
        })
      }

      const state = {
        proc,
        aborted: Boolean(reservation?.aborted),
        inactivityTimer: null,
        cleanup: runCleanup,
      }
      this.activeProcs.set(sessionId, state)
      if (state.aborted) killProcessTree(proc, { force: false })
      emitTaskState()

      let stdoutBuf = ''
      let droppingOversized = false
      let stderrBuf = ''
      let finalText = ''
      let seenResult = false
      let turnError = ''
      let settled = false
      let discoveredNativeId = resolvedId
      const seenTools = new Set()

      const clearTimer = () => {
        if (state.inactivityTimer) {
          clearTimeout(state.inactivityTimer)
          state.inactivityTimer = null
        }
      }
      const touchTimer = () => {
        clearTimer()
        state.inactivityTimer = setTimeout(() => {
          if (settled) return
          turnError = `ZCode 响应超时（超过 ${Math.round(ZCODE_TURN_INACTIVITY_TIMEOUT_MS / 60_000)} 分钟无输出）`
          killProcessTree(proc, { force: true })
        }, ZCODE_TURN_INACTIVITY_TIMEOUT_MS)
        state.inactivityTimer.unref?.()
      }
      touchTimer()

      const bindDiscoveredSession = (newId) => {
        if (!newId || newId === discoveredNativeId) return
        discoveredNativeId = newId
        if (sessionId !== newId) {
          this.aliasToNative.set(sessionId, newId)
          this.nativeToAlias.set(newId, sessionId)
          const pref = this.sessionPrefs.get(sessionId)
          if (pref) this.sessionPrefs.set(newId, pref)
        }
      }

      const handleLine = (line) => {
        let obj
        try {
          obj = JSON.parse(line)
        } catch {
          return
        }
        touchTimer()
        const ev = parseZCodeStreamEvent(obj)
        if (!ev) return
        if (ev.sessionId) bindDiscoveredSession(ev.sessionId)

        if (ev.kind === 'text_delta') {
          finalText += ev.delta
          this.emitEvent(EVENTS.STREAM_DELTA, {
            sessionId: compositeId,
            app: APPS.ZCODE,
            delta: ev.delta,
          })
        } else if (ev.kind === 'thinking_delta') {
          this.emitEvent(EVENTS.STREAM_THINKING, {
            sessionId: compositeId,
            app: APPS.ZCODE,
            delta: ev.delta,
          })
        } else if (ev.kind === 'tool_start') {
          if (!seenTools.has(ev.tool.id)) {
            seenTools.add(ev.tool.id)
            this.emitEvent(EVENTS.STREAM_TOOL_START, {
              sessionId: compositeId,
              app: APPS.ZCODE,
              tool: ev.tool,
            })
            if (taskTracker.applyClaudeTool(ev.tool.name, ev.tool.input, Date.now())) {
              emitTaskState()
            }
          }
        } else if (ev.kind === 'tool_end') {
          this.emitEvent(EVENTS.STREAM_TOOL_END, {
            sessionId: compositeId,
            app: APPS.ZCODE,
            toolId: ev.toolId,
            status: ev.status,
            output: ev.output,
          })
        } else if (ev.kind === 'turn_done' || ev.kind === 'result') {
          if (ev.kind === 'result') seenResult = true
          if (ev.response && !finalText) {
            finalText = ev.response
            this.emitEvent(EVENTS.STREAM_DELTA, {
              sessionId: compositeId,
              app: APPS.ZCODE,
              delta: ev.response,
            })
          }
        } else if (ev.kind === 'turn_error') {
          turnError = ev.message
        }
      }

      proc.stdout.on('data', (chunk) => {
        const str = String(chunk || '')
        if (droppingOversized) {
          const nl = str.indexOf('\n')
          if (nl === -1) return
          droppingOversized = false
          stdoutBuf = str.slice(nl + 1)
        } else {
          stdoutBuf += str
        }
        let idx
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim()
          stdoutBuf = stdoutBuf.slice(idx + 1)
          if (line) handleLine(line)
        }
        if (stdoutBuf.length > ZCODE_MAX_LINE_BYTES) {
          this.log.warn?.('mobile-hub: ZCode stdout line exceeded limit; dropping frame')
          stdoutBuf = ''
          droppingOversized = true
        }
      })

      proc.stderr?.on('data', (chunk) => {
        stderrBuf = (stderrBuf + String(chunk || '')).slice(-4096)
      })

      proc.on('error', (err) => {
        clearTimer()
        runCleanup()
        if (settled) return
        settled = true
        if (this.activeProcs.get(sessionId) === state) this.activeProcs.delete(sessionId)
        if (err && typeof err === 'object') err._streamErrorEmitted = true
        this.emitEvent(EVENTS.STREAM_ERROR, {
          sessionId: compositeId,
          app: APPS.ZCODE,
          message: String(err?.message || err),
        })
        rejectPromise(err)
      })

      proc.on('close', (code) => {
        clearTimer()
        runCleanup()
        if (settled) return
        settled = true
        const tail = droppingOversized ? '' : stdoutBuf.trim()
        if (tail) handleLine(tail)
        if (this.activeProcs.get(sessionId) === state) this.activeProcs.delete(sessionId)

        if (turnError && !state.aborted) {
          const cleanTurnErr = formatZCodeCliError(turnError, { resumed: isResumed })
          const err = new Error(cleanTurnErr)
          err._streamErrorEmitted = true
          this.emitEvent(EVENTS.STREAM_ERROR, {
            sessionId: compositeId,
            app: APPS.ZCODE,
            message: cleanTurnErr,
          })
          rejectPromise(err)
          return
        }

        if (code !== 0 && !state.aborted && !seenResult) {
          const cleanErr = stderrBuf.trim()
            ? formatZCodeCliError(stderrBuf, { resumed: isResumed })
            : `ZCode 进程退出（code=${code}）`
          const err = new Error(cleanErr)
          err._streamErrorEmitted = true
          this.emitEvent(EVENTS.STREAM_ERROR, {
            sessionId: compositeId,
            app: APPS.ZCODE,
            message: cleanErr,
          })
          rejectPromise(err)
          return
        }

        if (!state.aborted && discoveredNativeId && discoveredNativeId !== sessionId) {
          this.pendingCreated.delete(sessionId)
        }

        this.emitEvent(EVENTS.STREAM_DONE, {
          sessionId: compositeId,
          app: APPS.ZCODE,
          nativeId: discoveredNativeId,
          finalText,
          aborted: state.aborted,
        })
        void this.quotaManager.refreshInBackground({ force: false })
        resolvePromise({
          sessionId: compositeId,
          nativeId: discoveredNativeId,
          finalText,
          aborted: state.aborted,
        })
      })
    })
  }

  async interruptSession(sessionId) {
    sessionId = assertSafeSessionId(sessionId, 'ZCode sessionId')
    const active = this.activeProcs.get(sessionId)
    if (!active) {
      return { interrupted: false, sessionId: makeCompositeId(APPS.ZCODE, sessionId) }
    }
    active.aborted = true
    if (active.proc) {
      killProcessTree(active.proc, { force: false, graceMs: 2_000 })
    }
    return { interrupted: true, sessionId: makeCompositeId(APPS.ZCODE, sessionId) }
  }

  stopActiveLoginSession() {
    const sess = this.activeLoginSession
    if (!sess) return
    this.activeLoginSession = null
    if (sess.timer) this.clearTrackedTimer(sess.timer)
    if (sess.proc) killProcessTree(sess.proc, { force: true })
  }

  /**
   * 1-Click official OAuth login for ZCode standalone CLI (`zcode login bigmodel|zai --no-browser --json`).
   * Maps `methodId: 'internal'` -> `bigmodel` (智谱国内版) and `methodId: 'external'` -> `zai` (Z.AI 国际版).
   */
  async runSetup({ action = 'setup', methodId = 'internal' } = {}) {
    if (action === 'status') {
      const st = await this.getStatus()
      return { ok: true, ...st }
    }

    if (!this.isCliInstalled() || !this.launcher?.bin) {
      return {
        ok: false,
        status: 'not_installed',
        writable: false,
        setupState: 'not_installed',
        error: '本机未找到 ZCode 安装目录，请先下载安装智谱 ZCode 桌面端。',
      }
    }

    if (this.isStandaloneAuthenticated()) {
      return {
        ok: true,
        status: 'ready',
        writable: true,
        setupState: 'ready',
        message: 'ZCode 已完成授权，读写就绪！',
      }
    }

    const providerArg = methodId === 'external' ? 'zai' : 'bigmodel'
    if (this.activeLoginSession && this.activeLoginSession.providerArg === providerArg && this.activeLoginSession.authUrl) {
      return {
        ok: true,
        status: 'awaiting_login',
        writable: false,
        setupState: 'needs_login',
        authUrl: this.activeLoginSession.authUrl,
        methodId,
        message: '请打开官方授权页完成登录，授权完成后将自动解锁远程发送。',
      }
    }

    this.stopActiveLoginSession()

    const cliArgs = [
      ...(this.launcher.baseArgs || []),
      'login',
      providerArg,
      '--no-browser',
      '--json',
    ]
    const spawnEnv = this._buildCliEnv({ ensureManagedAuth: true })

    return await new Promise((resolveSetup) => {
      let settled = false
      const settle = (payload) => {
        if (settled) return
        settled = true
        if (waitUrlTimer) this.clearTrackedTimer(waitUrlTimer)
        resolveSetup(payload)
      }

      let proc
      try {
        proc = this.spawnFn(this.launcher.bin, cliArgs, {
          cwd: this.defaultCwd,
          env: spawnEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        settle({
          ok: false,
          status: 'login_failed',
          writable: false,
          setupState: 'needs_login',
          error: `无法启动 ZCode 官方登录流程：${String(err?.message || err)}`,
        })
        return
      }

      this.trackChildProcess(proc)
      proc.stdout?.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')

      const loginState = {
        proc,
        providerArg,
        authUrl: '',
        startedAt: Date.now(),
        timer: null,
      }
      this.activeLoginSession = loginState
      loginState.timer = this.setTimeout(() => {
        if (this.activeLoginSession === loginState) this.stopActiveLoginSession()
      }, 305_000)

      const waitUrlTimer = this.setTimeout(() => {
        settle({
          ok: true,
          status: 'awaiting_login',
          writable: false,
          setupState: 'needs_login',
          authUrl: loginState.authUrl || '',
          methodId,
          message: loginState.authUrl
            ? '请打开智谱官方授权页完成登录，授权后自动解锁发送'
            : '正在等待智谱官方授权链接生成，请稍候…',
        })
      }, 10_000)

      let stderrTail = ''
      const inspectForUrl = (chunk) => {
        const text = String(chunk || '')
        const m = text.match(/https:\/\/[^\s"'<>]+/i)
        if (m && isSafeZCodeAuthUrl(m[0])) {
          loginState.authUrl = m[0]
          settle({
            ok: true,
            status: 'awaiting_login',
            writable: false,
            setupState: 'needs_login',
            authUrl: m[0],
            methodId,
            message: '已生成智谱官方登录链接，请在浏览器中完成授权，授权后自动解锁远程发送。',
          })
        }
      }

      proc.stdout?.on('data', (chunk) => {
        inspectForUrl(chunk)
      })
      proc.stderr?.on('data', (chunk) => {
        const text = String(chunk || '')
        stderrTail = (stderrTail + text).slice(-2048)
        inspectForUrl(text)
      })

      proc.on('error', (err) => {
        if (this.activeLoginSession === loginState) this.stopActiveLoginSession()
        settle({
          ok: false,
          status: 'login_failed',
          writable: false,
          setupState: 'needs_login',
          error: String(err?.message || err),
        })
      })

      proc.on('close', (code) => {
        if (this.activeLoginSession === loginState) {
          if (loginState.timer) this.clearTrackedTimer(loginState.timer)
          this.activeLoginSession = null
        }
        if (code === 0 || this.isStandaloneAuthenticated()) {
          void this.quotaManager.refreshInBackground({ force: true })
          this.emitEvent(EVENTS.SESSION_UPDATED, {
            externalUpdate: true,
            authReady: true,
            app: APPS.ZCODE,
          })
          settle({
            ok: true,
            status: 'ready',
            writable: true,
            setupState: 'ready',
            message: 'ZCode 授权成功，已解锁远程发送！',
          })
          return
        }
        settle({
          ok: false,
          status: 'login_failed',
          writable: false,
          setupState: 'needs_login',
          error: stderrTail.trim() || `ZCode 登录流程已退出（code=${code}）`,
        })
      })
    })
  }

  async _pollExternalUpdates({ now, watched, tracked, isListExpired }) {
    if (this.disposed) return
    if (watched.size === 0 && isListExpired(now)) {
      tracked.clear()
      return
    }
    const dbSnap = await readZCodeSqliteAsync(this.dbPath, 'list')
    if (!dbSnap) return

    const sessionById = new Map()
    for (const s of dbSnap.sessions || []) {
      if (s?.id) sessionById.set(String(s.id), s)
    }
    const presenceById = new Map()
    for (const p of dbSnap.presences || []) {
      if (p?.session_id) presenceById.set(String(p.session_id), p)
    }
    const previewById = extractPreviewFromRows(dbSnap.previews || [])

    for (const [sid, meta] of [...watched.entries()]) {
      if (now - (meta.lastSeenAt || 0) > ZCODE_WATCH_TTL_MS) {
        watched.delete(sid)
        continue
      }
      const sRow = sessionById.get(sid)
      if (!sRow) continue
      const updatedAt = toEpochMs(sRow.time_updated || sRow.time_created)
      const externalRunning = isPresenceRunning(presenceById.get(sid), now)
      const changed = updatedAt !== meta.updatedAt || externalRunning !== meta.externalRunning
      if (!changed) continue

      meta.updatedAt = updatedAt
      meta.externalRunning = externalRunning
      meta.lastSeenAt = now
      const cwd = String(sRow.path || sRow.directory || '').trim()
      this.emitEvent(EVENTS.SESSION_UPDATED, {
        externalUpdate: true,
        session: {
          id: makeCompositeId(APPS.ZCODE, sid),
          app: APPS.ZCODE,
          nativeId: sid,
          title: String(sRow.title || sid),
          preview: previewById.get(sid) || '',
          cwd,
          workspace: cwd ? basename(cwd) : 'ZCode',
          status: externalRunning || this.activeProcs.has(sid) ? 'running' : 'idle',
          updatedAt,
          syncState: { externalRunning, source: 'zcode-desktop' },
        },
      })
    }

    if (isListExpired(now)) {
      tracked.clear()
      return
    }
    for (const [sid, meta] of [...tracked.entries()]) {
      if (watched.has(sid)) continue
      const sRow = sessionById.get(sid)
      if (!sRow) continue
      const updatedAt = toEpochMs(sRow.time_updated || sRow.time_created)
      const externalRunning = isPresenceRunning(presenceById.get(sid), now)
      if (updatedAt !== meta.updatedAt || externalRunning !== meta.externalRunning) {
        meta.updatedAt = updatedAt
        meta.externalRunning = externalRunning
        const cwd = String(sRow.path || sRow.directory || '').trim()
        this.emitEvent(EVENTS.SESSION_UPDATED, {
          externalUpdate: true,
          session: {
            id: makeCompositeId(APPS.ZCODE, sid),
            app: APPS.ZCODE,
            nativeId: sid,
            title: String(sRow.title || sid),
            preview: previewById.get(sid) || '',
            cwd,
            workspace: cwd ? basename(cwd) : 'ZCode',
            status: externalRunning || this.activeProcs.has(sid) ? 'running' : 'idle',
            updatedAt,
            syncState: { externalRunning, source: 'zcode-desktop' },
          },
        })
      }
    }
  }

  async dispose() {
    this.stopActiveLoginSession()
    this.watcher.dispose()
    this.quotaManager.dispose()
    for (const active of this.activeProcs.values()) {
      active.aborted = true
      if (active.inactivityTimer) {
        clearTimeout(active.inactivityTimer)
        active.inactivityTimer = null
      }
      try { active.cleanup?.() } catch {}
      if (active.proc) killProcessTree(active.proc, { force: true })
    }
    this.activeProcs.clear()
    for (const dir of [...this._tempDirs]) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
    this._tempDirs.clear()
    this.disposeBase()
  }
}
