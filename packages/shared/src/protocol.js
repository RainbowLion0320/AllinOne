/**
 * Shared RPC & streaming event protocol between:
 *   Mobile App <-> Self-Hosted Relay Server <-> PC Bridge (dsh-mobile-hub)
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

export const APP_META = Object.freeze({
  dsh: {
    id: 'dsh',
    name: 'DeepSeek Harness',
    shortName: 'DeepSeek',
    color: '#4D6BFE',
    badge: 'DSH',
    canOrchestrate: false,
    description: '零侵入直连本机 DeepSeek Harness 原生会话与缓存（0 额外工具与 Token）',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    shortName: 'Codex',
    color: '#10A37F',
    badge: 'CDX',
    canOrchestrate: false,
    description: 'OpenAI Codex（官方 app-server 读写分离，每轮自动释放写入锁）',
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    shortName: 'Claude',
    color: '#D97757',
    badge: 'CLD',
    canOrchestrate: false,
    description: 'Claude Desktop / Code 本地项目会话（原生 CLI --resume 复用官方缓存）',
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    shortName: 'Antigravity',
    color: '#7C5CFF',
    badge: 'AGY',
    canOrchestrate: false,
    description: '官方 ACP 协议直连 Antigravity，与桌面端原生共享同一会话与缓存',
  },
})

/**
 * RPC method names routed from mobile client -> relay -> PC bridge.
 */
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

/**
 * Event names pushed from PC bridge -> relay -> mobile clients.
 */
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

/**
 * Build a unified composite key `<app>:<nativeId>`.
 * @param {string} app
 * @param {string} sessionId
 */
export function makeCompositeId(app, sessionId) {
  return `${app}:${sessionId}`
}

/**
 * Parse a composite session id `<app>:<nativeId>` or `{ app, sessionId }`.
 * @param {string} compositeId
 * @returns {{ app: string, sessionId: string }}
 */
export function parseCompositeId(compositeId) {
  const raw = String(compositeId ?? '')
  const idx = raw.indexOf(':')
  if (idx === -1) return { app: APPS.DSH, sessionId: raw }
  return { app: raw.slice(0, idx), sessionId: raw.slice(idx + 1) }
}

/**
 * Normalize a timestamp into milliseconds epoch.
 * @param {number|string|Date|null|undefined} value
 * @returns {number}
 */
export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Unix seconds vs milliseconds heuristic
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
