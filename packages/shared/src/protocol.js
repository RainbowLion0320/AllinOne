/**
 * Shared RPC & streaming event protocol between:
 *   Mobile App <-> Self-Hosted Relay Server <-> PC Bridge (dsh-mobile-hub)
 */

export const APPS = Object.freeze({
  DSH: 'dsh',
  CODEX: 'codex',
  CLAUDE: 'claude',
  ANTIGRAVITY: 'antigravity',
  WORKBUDDY: 'workbuddy',
})

export const APP_LIST = Object.freeze([
  APPS.DSH,
  APPS.CODEX,
  APPS.CLAUDE,
  APPS.ANTIGRAVITY,
  APPS.WORKBUDDY,
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
    color: '#6366F1',
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
    color: '#3186FF',
    badge: 'AGY',
    description: '官方 ACP 协议直连 Antigravity，与桌面端原生共享同一会话与缓存',
  },
  workbuddy: {
    id: 'workbuddy',
    name: 'WorkBuddy',
    shortName: 'WorkBuddy',
    color: '#06C798',
    badge: 'WKB',
    description: '腾讯 WorkBuddy 桌面端会话实时同步（安装并登录官方 codebuddy CLI 可解锁远程发消息，账号与额度互通）',
  },
})

/**
 * RPC method names routed from mobile client -> relay -> PC bridge.
 */
export const RPC = Object.freeze({
  APPS_STATUS: 'apps.status',
  APP_SETUP: 'app.setup',
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
  STREAM_TASK_STATE: 'stream.task_state',
  STREAM_DONE: 'stream.done',
  STREAM_ERROR: 'stream.error',
  SESSION_UPDATED: 'session.updated',
  APPROVAL_REQUEST: 'approval.request',
  APPROVAL_RESOLVED: 'approval.resolved',
  DISPATCH_UPDATED: 'dispatch.updated',
  E2EE_GRANT_REQUEST: 'e2ee.grant.request',
  E2EE_GRANT_OFFER: 'e2ee.grant.offer',
  E2EE_GRANT_REVEAL: 'e2ee.grant.reveal',
  E2EE_GRANT_DELIVER: 'e2ee.grant.deliver',
  E2EE_GRANT_REJECT: 'e2ee.grant.reject',
  E2EE_GRANT_CANCEL: 'e2ee.grant.cancel',
  E2EE_QR_NUDGE: 'e2ee.qr.nudge',
  P2P_SIGNAL: 'p2p.signal',
  CLIENT_REVOKED: 'client.revoked',
})

export const PROTOCOL_VERSION = 1
export const P2P_PROTOCOL_VERSION = PROTOCOL_VERSION

/**
 * Canonical control-plane WebSocket message types between Relay, Bridge, and Client.
 */
export const WS_MSG = Object.freeze({
  HELLO: 'hello',
  BRIDGE_WELCOME: 'bridge.welcome',
  BRIDGE_META: 'bridge.meta',
  BRIDGE_LIST: 'bridge.list',
  PING: 'ping',
  PONG: 'pong',
  ICE_UPDATE: 'ice.update',
  P2P_SIGNAL: 'p2p.signal',
  P2P_SIGNAL_ERROR: 'p2p.signal.error',
  E2EE_GRANT_REQ: 'e2ee.grant.req',
  E2EE_GRANT_LIST: 'e2ee.grant.list',
  E2EE_GRANT_LIST_RES: 'e2ee.grant.list.res',
  E2EE_GRANT_OFFER: 'e2ee.grant.offer',
  E2EE_GRANT_REVEAL: 'e2ee.grant.reveal',
  E2EE_GRANT_DELIVER: 'e2ee.grant.deliver',
  E2EE_GRANT_REJECT: 'e2ee.grant.reject',
  E2EE_GRANT_CANCEL: 'e2ee.grant.cancel',
  E2EE_QR_NUDGE: 'e2ee.qr.nudge',
})

/**
 * Capability flags advertised during control-plane and P2P handshakes.
 */
export const PROTOCOL_CAPABILITIES = Object.freeze([
  'ctrl-bin-v1',
  'deflate-raw',
  'aio2-chunked',
  'grant-v2',
  'bulk-window-v1',
  'event-sync-v1',
])

/**
 * Canonical account tiers & default monthly TURN quotas (MB; 0 = unlimited).
 */
export const VALID_TIERS = Object.freeze(['free', 'pro', 'ultra', 'admin'])
export const DEFAULT_TURN_QUOTA_MB = Object.freeze({
  free: 1024,
  pro: 10240,
  ultra: 51200,
  admin: 51200,
})

/**
 * Canonical Content-Security-Policy for sandboxed HTML deliverable previews
 * (shared across Relay Server, Electron Desktop `app://`, and static fallback).
 */
export const SANDBOX_PREVIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"

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
