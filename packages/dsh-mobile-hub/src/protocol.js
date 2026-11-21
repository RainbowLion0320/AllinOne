import { resolve, sep } from 'node:path'

/**
 * Self-contained protocol constants for dsh-mobile-hub so this plugin can be linked
 * directly into ~/.dsh/profiles/desktop without needing external workspace packages.
 */

export const APPS = Object.freeze({
  DSH: 'dsh',
  CODEX: 'codex',
  CLAUDE: 'claude',
  ANTIGRAVITY: 'antigravity',
})

export const APP_LIST = Object.freeze([
  APPS.DSH,
  APPS.CODEX,
  APPS.CLAUDE,
  APPS.ANTIGRAVITY,
])

export const RPC = Object.freeze({
  APPS_STATUS: 'apps.status',
  MODELS_LIST: 'models.list',
  WORKSPACES_LIST: 'workspaces.list',
  SESSIONS_LIST: 'sessions.list',
  SESSION_READ: 'session.read',
  SESSION_CREATE: 'session.create',
  SESSION_SEND: 'session.send',
  SESSION_INTERRUPT: 'session.interrupt',
  APPROVAL_LIST: 'approval.list',
  APPROVAL_RESOLVE: 'approval.resolve',
  DISPATCH_LIST: 'dispatch.list',
  DISPATCH_CREATE: 'dispatch.create',
  DISPATCH_STATUS: 'dispatch.status',
  FILE_READ: 'file.read',
  BRIDGE_PING: 'bridge.ping',
})

export const EVENTS = Object.freeze({
  BRIDGE_STATUS: 'bridge.status',
  STREAM_START: 'stream.start',
  STREAM_DELTA: 'stream.delta',
  STREAM_THINKING: 'stream.thinking',
  STREAM_TOOL_START: 'stream.tool.start',
  STREAM_TOOL_END: 'stream.tool.end',
  STREAM_DONE: 'stream.done',
  STREAM_ERROR: 'stream.error',
  SESSION_UPDATED: 'session.updated',
  APPROVAL_REQUEST: 'approval.request',
  APPROVAL_RESOLVED: 'approval.resolved',
  DISPATCH_UPDATED: 'dispatch.updated',
})

export function makeCompositeId(app, sessionId) {
  return `${app}:${sessionId}`
}

export function parseCompositeId(compositeId) {
  const raw = String(compositeId ?? '')
  const idx = raw.indexOf(':')
  if (idx === -1) return { app: APPS.DSH, sessionId: raw }
  return { app: raw.slice(0, idx), sessionId: raw.slice(idx + 1) }
}

export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value)
    if (Number.isFinite(num)) return num > 1e12 ? num : num * 1000
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (value instanceof Date) return value.getTime()
  return 0
}

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9._:@-]{1,128}$/
const SAFE_CLI_TOKEN_RE = /^[a-zA-Z0-9._:@/+=-]{1,120}$/

/**
 * Validate session/thread/conversation IDs against path traversal (`../`, `/`, `\`)
 * and CLI option injection (leading `-`, shell metacharacters, null bytes).
 */
export function assertSafeSessionId(value, label = 'sessionId') {
  const s = String(value ?? '').trim()
  if (!s || s.startsWith('-') || s.includes('..') || !SAFE_SESSION_ID_RE.test(s)) {
    throw new Error(`非法的 ${label} 格式`)
  }
  return s
}

/**
 * Validate remote-supplied CLI option values (e.g. model ID, effort, permission mode)
 * against Windows cmd.exe / POSIX shell metacharacters and leading-dash option injection.
 */
export function assertSafeCliToken(value, label = '参数', { allowEmpty = true } = {}) {
  const s = String(value ?? '').trim()
  if (!s) {
    if (allowEmpty) return ''
    throw new Error(`缺少 ${label}`)
  }
  if (s.startsWith('-') || s.includes('..') || !SAFE_CLI_TOKEN_RE.test(s)) {
    throw new Error(`非法的 ${label} 参数值`)
  }
  return s
}

/** Ensure `targetPath` resolves strictly inside `baseDir`. */
export function assertPathWithinDir(targetPath, baseDir, label = '路径') {
  const base = resolve(baseDir)
  const target = resolve(targetPath)
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`非法的 ${label}：超出允许目录范围`)
  }
  return target
}
