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
    description: '零侵入直连本机 DeepSeek Harness 原生会话与缓存（0 额外工具与 Token）',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    shortName: 'Codex',
    color: '#10A37F',
    badge: 'CDX',
    description: 'OpenAI Codex（官方 app-server 读写分离，每轮自动释放写入锁）',
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    shortName: 'Claude',
    color: '#D97757',
    badge: 'CLD',
    description: 'Claude Desktop / Code 本地项目会话（原生 CLI --resume 复用官方缓存）',
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    shortName: 'Antigravity',
    color: '#7C5CFF',
    badge: 'AGY',
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
  CLIENTS_STATUS: 'clients.status',
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
  E2EE_GRANT_REQUEST: 'e2ee.grant.request',
  E2EE_GRANT_OFFER: 'e2ee.grant.offer',
  E2EE_GRANT_DELIVER: 'e2ee.grant.deliver',
  E2EE_GRANT_REJECT: 'e2ee.grant.reject',
  E2EE_GRANT_CANCEL: 'e2ee.grant.cancel',
  E2EE_QR_NUDGE: 'e2ee.qr.nudge',
  P2P_SIGNAL: 'p2p.signal',
  CLIENT_REVOKED: 'client.revoked',
})

export const P2P_PROTOCOL_VERSION = 1
export const P2P_CTRL_CHANNEL = 'aio-ctrl'
export const P2P_BULK_CHANNEL = 'aio-bulk'

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
 * @param {string|{ app?: string, sessionId?: string }} compositeId
 * @returns {{ app: string, sessionId: string }}
 */
export function parseCompositeId(compositeId) {
  if (compositeId && typeof compositeId === 'object') {
    const app = compositeId.app != null && String(compositeId.app) !== ''
      ? String(compositeId.app)
      : APPS.DSH
    const sessionId = String(compositeId.sessionId ?? '')
    return { app, sessionId }
  }
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
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0
    // Unix seconds vs milliseconds heuristic
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 0
    // Treat plain positive numeric strings (excluding 4-digit year strings like "2026") as Unix s/ms
    if (/^\d+(?:\.\d+)?$/.test(trimmed) && !/^\d{4}$/.test(trimmed)) {
      const num = Number(trimmed)
      if (!Number.isFinite(num) || num <= 0) return 0
      return num > 1e12 ? num : num * 1000
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isFinite(t) ? t : 0
  }
  return 0
}
