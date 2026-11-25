import {
  E2EE_CHUNKED_THRESHOLD,
  E2EE_METHOD_MARKER,
  decryptAutoStream,
  decryptJson,
  encryptBytes,
  encryptChunkedBytes,
  encryptJson,
} from '@allinone/shared/e2ee'
import { bi, getCurrentLang } from './i18n.js'

const L = (zh, en) => bi(getCurrentLang(), zh, en)
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const DEFAULT_FILE_LIMITS = {
  maxUploadBytes: MAX_UPLOAD_BYTES,
  maxImageBytes: MAX_UPLOAD_BYTES,
  maxDocumentBytes: 10 * 1024 * 1024,
}

function formatFileLimitLabel(bytes) {
  const n = Number(bytes || 0)
  if (n >= 1024 * 1024 * 1024) {
    const gb = n / (1024 * 1024 * 1024)
    return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`
  }
  return `${Math.max(1, Math.round(n / (1024 * 1024)))} MB`
}

function normalizeE2eeKeysMap(keysMap) {
  const out = {}
  for (const [k, v] of Object.entries(keysMap || {})) {
    const cleanK = String(k || '').trim().toLowerCase()
    const cleanV = String(v || '').trim()
    if (cleanK && cleanV) out[cleanK] = cleanV
  }
  return out
}

export const DEFAULT_PROD_SERVER =
  String(import.meta.env?.VITE_RELAY_URL || '').trim().replace(/\/+$/, '') ||
  'https://your-relay.example.com'

export function detectDefaultServerUrl() {
  if (typeof window !== 'undefined') {
    const desktopDefault = String(window.allinoneDesktop?.defaultServerUrl || '').trim().replace(/\/+$/, '')
    if (desktopDefault) return desktopDefault

    if (window.location.protocol.startsWith('http')) {
      const host = window.location.hostname
      const port = window.location.port
      // Inside Capacitor Android/iOS WebView, origin is https://localhost or capacitor://localhost
      if (host === 'localhost' && (!port || port === '80' || port === '443')) {
        return DEFAULT_PROD_SERVER
      }
      const basePath = window.location.pathname
        .replace(/\/index\.html$/i, '')
        .replace(/\/+$/, '')
      return `${window.location.origin}${basePath}`
    }
  }
  return DEFAULT_PROD_SERVER
}

export function normalizeBaseUrl(input) {
  const trimmed = String(input || '').trim().replace(/\/+$/, '')
  if (!trimmed) {
    return detectDefaultServerUrl()
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`
  }
  return trimmed
}

export function toWsUrl(httpBase, path, queryParams = {}) {
  const base = normalizeBaseUrl(httpBase)
  const cleanPath = String(path || '').replace(/^\/+/, '')
  const u = new URL(`${base}/${cleanPath}`)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
  }
  return u.toString()
}

export async function fetchBootstrapStatus(serverUrl, timeoutMs = 4000) {
  const base = normalizeBaseUrl(serverUrl)
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(`${base}/api/account/bootstrap-status`, {
      ...(controller ? { signal: controller.signal } : {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) return { hasUsers: true, emailEnabled: false }
    return { hasUsers: Boolean(data.hasUsers), emailEnabled: Boolean(data.emailEnabled) }
  } catch {
    return { hasUsers: true, emailEnabled: false }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function detectClientDeviceMeta() {
  if (typeof window !== 'undefined' && window.allinoneDesktop?.isDesktop) {
    const plat = String(window.allinoneDesktop.platform || '').toLowerCase()
    const osName = plat === 'darwin' ? 'macOS' : plat === 'win32' ? 'Windows' : 'Linux'
    return { deviceName: `${osName} Desktop`, clientKind: 'desktop' }
  }
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : ''
  if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
    const isIos = /iPhone|iPad|iPod/i.test(ua)
    return { deviceName: isIos ? 'iOS App' : 'Android App', clientKind: 'mobile' }
  }
  const isIPhone = /iPhone/i.test(ua)
  const isIPad = /iPad/i.test(ua)
  const isAndroid = /Android/i.test(ua)
  const isWindows = /Windows NT/i.test(ua)
  const isMac = /Macintosh|Mac OS X/i.test(ua)
  let browser = ''
  if (/Edg\//i.test(ua)) browser = 'Edge'
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome'
  else if (/Firefox\//i.test(ua)) browser = 'Firefox'
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari'
  if (isIPhone) return { deviceName: browser ? `iPhone · ${browser}` : 'iPhone', clientKind: 'mobile' }
  if (isIPad) return { deviceName: browser ? `iPad · ${browser}` : 'iPad', clientKind: 'mobile' }
  if (isAndroid) return { deviceName: browser ? `Android · ${browser}` : 'Android', clientKind: 'mobile' }
  if (isWindows) return { deviceName: browser ? `Windows · ${browser}` : 'Windows', clientKind: 'web' }
  if (isMac) return { deviceName: browser ? `macOS · ${browser}` : 'macOS', clientKind: 'web' }
  return { deviceName: browser || 'Web Client', clientKind: 'web' }
}

export async function loginAccount(serverUrl, { username, password, emailCode = '' }) {
  const base = normalizeBaseUrl(serverUrl)
  const devMeta = detectClientDeviceMeta()
  const cleanCode = String(emailCode || '').trim()
  const res = await fetch(`${base}/api/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: String(username || '').trim(),
      password: String(password ?? ''),
      ...(cleanCode ? { emailCode: cleanCode } : {}),
      deviceName: devMeta.deviceName,
      clientKind: devMeta.clientKind,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (data.requires2fa && !data.ok) {
    return {
      requires2fa: true,
      maskedEmail: String(data.maskedEmail || ''),
      cooldownSec: Number(data.cooldownSec) || 0,
      message: String(data.message || ''),
      error: String(data.error || ''),
    }
  }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`登录失败 (HTTP ${res.status})`, `Sign in failed (HTTP ${res.status})`))
  }
  return {
    baseUrl: base,
    token: data.token,
    roomId: data.roomId || data.user?.userId || '',
    username: data.user?.username || String(username || '').trim(),
    email: data.user?.email || '',
    emailVerified: Boolean(data.user?.emailVerified),
    loginEmail2fa: Boolean(data.user?.loginEmail2fa),
    role: data.user?.role || 'user',
    label: `@${data.user?.username || String(username || '').trim()}`,
    devices: Array.isArray(data.devices) ? data.devices : [],
    bridges: Array.isArray(data.bridges) ? data.bridges : [],
  }
}

export async function setAccountLogin2fa(baseUrl, token, enabled) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/account/security/2fa`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ enabled: Boolean(enabled) }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`设置二次验证失败 (HTTP ${res.status})`, `Failed to update 2FA setting (HTTP ${res.status})`))
  }
  return data.user
}

export async function registerAccount(serverUrl, { username, password, inviteCode, email = '', emailCode = '' }) {
  const base = normalizeBaseUrl(serverUrl)
  const cleanEmail = String(email || '').trim()
  const devMeta = detectClientDeviceMeta()
  const res = await fetch(`${base}/api/account/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: String(username || '').trim(),
      password: String(password ?? ''),
      inviteCode: String(inviteCode || '').trim(),
      ...(cleanEmail ? { email: cleanEmail, emailCode: String(emailCode || '').trim() } : {}),
      deviceName: devMeta.deviceName,
      clientKind: devMeta.clientKind,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`注册失败 (HTTP ${res.status})`, `Registration failed (HTTP ${res.status})`))
  }
  return {
    baseUrl: base,
    token: data.token,
    roomId: data.roomId || data.user?.userId || '',
    username: data.user?.username || String(username || '').trim(),
    email: data.user?.email || '',
    emailVerified: Boolean(data.user?.emailVerified),
    role: data.user?.role || 'user',
    label: `@${data.user?.username || String(username || '').trim()}`,
    devices: Array.isArray(data.devices) ? data.devices : [],
    bridges: Array.isArray(data.bridges) ? data.bridges : [],
  }
}

export async function sendEmailVerificationCode(serverUrl, { purpose, email, inviteCode = '', token = '' }) {
  const base = normalizeBaseUrl(serverUrl)
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${base}/api/account/email/send-code`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      purpose,
      email: String(email || '').trim(),
      ...(inviteCode ? { inviteCode: String(inviteCode).trim() } : {}),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || L(`发送验证码失败 (HTTP ${res.status})`, `Failed to send code (HTTP ${res.status})`))
    if (data.retryAfterSec) err.retryAfterSec = Number(data.retryAfterSec)
    throw err
  }
  return {
    cooldownSec: Number(data.cooldownSec) || 60,
    expiresInSec: Number(data.expiresInSec) || 600,
    message: data.message || L('验证码已发送，请查收邮件', 'Verification code sent. Please check your inbox.'),
  }
}

export async function bindAccountEmail(baseUrl, token, { email, code }) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/account/email/bind`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      email: String(email || '').trim(),
      code: String(code || '').trim(),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`绑定邮箱失败 (HTTP ${res.status})`, `Failed to link email (HTTP ${res.status})`))
  }
  return data.user
}

export async function resetAccountPassword(serverUrl, { email, code, newPassword }) {
  const base = normalizeBaseUrl(serverUrl)
  const res = await fetch(`${base}/api/account/password/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: String(email || '').trim(),
      code: String(code || '').trim(),
      newPassword: String(newPassword ?? ''),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`重置密码失败 (HTTP ${res.status})`, `Password reset failed (HTTP ${res.status})`))
  }
  return { username: data.username || '' }
}

export async function listAccountDevices(baseUrl, token) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/account/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`获取电脑列表失败 (HTTP ${res.status})`, `Failed to load computers (HTTP ${res.status})`))
  }
  return {
    devices: Array.isArray(data.devices) ? data.devices : [],
    bridges: Array.isArray(data.bridges) ? data.bridges : [],
  }
}

export async function renameAccountDevice(baseUrl, token, { deviceId, label }) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/account/devices/rename`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ deviceId, label }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`重命名失败 (HTTP ${res.status})`, `Rename failed (HTTP ${res.status})`))
  }
  return Array.isArray(data.devices) ? data.devices : []
}

export async function removeAccountDevice(baseUrl, token, { deviceId }) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/account/devices/remove`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ deviceId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`解绑失败 (HTTP ${res.status})`, `Unlink failed (HTTP ${res.status})`))
  }
  return Array.isArray(data.devices) ? data.devices : []
}

export async function adminListInvites(baseUrl, token) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/admin/invites`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`获取邀请码失败 (HTTP ${res.status})`, `Failed to load invite codes (HTTP ${res.status})`))
  }
  return {
    invites: Array.isArray(data.invites) ? data.invites : [],
    stats: data.stats || { total: 0, active: 0, used: 0, revoked: 0 },
    users: Array.isArray(data.users) ? data.users : [],
  }
}

export async function adminCreateInvites(baseUrl, token, { count = 1, note = '', grantAdmin = false, tier = 'free' } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  const cleanTier = String(tier || (grantAdmin ? 'admin' : 'free')).toLowerCase()
  const res = await fetch(`${base}/api/admin/invites`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ count, note, tier: cleanTier, grantAdmin: Boolean(grantAdmin || cleanTier === 'admin') }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`生成邀请码失败 (HTTP ${res.status})`, `Failed to create invite codes (HTTP ${res.status})`))
  }
  return Array.isArray(data.invites) ? data.invites : []
}

export async function adminSetUserTier(baseUrl, token, { userId, tier }) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/admin/users/set-tier`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ userId, tier }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`调整用户等级失败 (HTTP ${res.status})`, `Failed to update user tier (HTTP ${res.status})`))
  }
  return data
}

export async function adminRevokeInvite(baseUrl, token, { id }) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/admin/invites/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ id }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`作废邀请码失败 (HTTP ${res.status})`, `Failed to revoke invite code (HTTP ${res.status})`))
  }
  return data.invite
}

export async function probeDeviceStatus(device, timeoutMs = 5000) {
  if (!device?.baseUrl || !device?.token) {
    return { status: 'unreachable', bridges: [], label: '', roomId: device?.roomId || '' }
  }
  const base = normalizeBaseUrl(device.baseUrl)
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(`${base}/api/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${device.token}` },
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (res.status === 401) {
      return { status: 'expired', bridges: [], label: '', roomId: device.roomId || '' }
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      return { status: 'unreachable', bridges: [], label: '', roomId: device.roomId || '' }
    }
    const bridges = Array.isArray(data.bridges) ? data.bridges : []
    const online = bridges.some((b) => b.online)
    return {
      status: online ? 'online' : 'offline',
      bridges,
      devices: Array.isArray(data.devices) ? data.devices : null,
      label: String(data.label || ''),
      username: String(data.username || ''),
      email: String(data.email || ''),
      emailVerified: Boolean(data.emailVerified),
      loginEmail2fa: Boolean(data.loginEmail2fa),
      emailEnabled: Boolean(data.emailEnabled),
      role: String(data.role || ''),
      roomId: String(data.roomId || device.roomId || ''),
    }
  } catch {
    return { status: 'unreachable', bridges: [], label: '', roomId: device.roomId || '' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function requestWsTicket(baseUrl, token, timeoutMs = 8000) {
  const base = normalizeBaseUrl(baseUrl)
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  const devMeta = detectClientDeviceMeta()
  try {
    const res = await fetch(`${base}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        deviceName: devMeta.deviceName,
        clientKind: devMeta.clientKind,
      }),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (res.status === 401) {
      const err = new Error(L('登录已失效', 'Session expired'))
      err.status = 401
      throw err
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok || !data.ticket) {
      throw new Error(data.error || L(`获取连接票据失败 (HTTP ${res.status})`, `Failed to obtain WS ticket (HTTP ${res.status})`))
    }
    return data.ticket
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function requestMediaToken(baseUrl, token, timeoutMs = 8000) {
  const base = normalizeBaseUrl(baseUrl)
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(`${base}/api/auth/media-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (res.status === 401) {
      const err = new Error(L('登录已失效', 'Session expired'))
      err.status = 401
      throw err
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok || !data.mediaToken) {
      throw new Error(data.error || L(`获取媒体令牌失败 (HTTP ${res.status})`, `Failed to obtain media token (HTTP ${res.status})`))
    }
    return { mediaToken: data.mediaToken, expiresAt: data.expiresAt || 0 }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function revokeDeviceSessions(baseUrl, token) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/auth/sessions/revoke-all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`吊销会话失败 (HTTP ${res.status})`, `Failed to revoke sessions (HTTP ${res.status})`))
  }
  return data
}

export async function fetchAuthSessions(baseUrl, token, currentClientId = '') {
  const base = normalizeBaseUrl(baseUrl)
  const qs = currentClientId ? `?clientId=${encodeURIComponent(currentClientId)}` : ''
  const res = await fetch(`${base}/api/auth/sessions${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 404) {
    return { supported: false, sessions: [], onlineCount: 0, onlineDeviceCount: 0, totalCount: 0 }
  }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`读取登录终端失败 (HTTP ${res.status})`, `Failed to load active sessions (HTTP ${res.status})`))
  }
  return {
    supported: true,
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    onlineCount: Number(data.onlineCount) || 0,
    onlineDeviceCount: Number(data.onlineDeviceCount) || 0,
    totalCount: Number(data.totalCount) || 0,
    currentSid: String(data.currentSid || ''),
  }
}

export async function revokeAuthSession(baseUrl, token, { sid = '', clientId = '', currentClientId = '' } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/auth/sessions/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ sid, clientId, currentClientId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`踢出设备失败 (HTTP ${res.status})`, `Failed to sign out device (HTTP ${res.status})`))
  }
  return {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    onlineCount: Number(data.onlineCount) || 0,
    onlineDeviceCount: Number(data.onlineDeviceCount) || 0,
    totalCount: Number(data.totalCount) || 0,
    revokedPermanent: Boolean(data.revokedPermanent),
    kickedConnections: Number(data.kickedConnections) || 0,
  }
}

export async function revokeOtherAuthSessions(baseUrl, token, currentClientId = '') {
  const base = normalizeBaseUrl(baseUrl)
  const devMeta = detectClientDeviceMeta()
  const res = await fetch(`${base}/api/auth/sessions/revoke-others`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      currentClientId,
      deviceName: devMeta.deviceName,
      clientKind: devMeta.clientKind,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`下线其他设备失败 (HTTP ${res.status})`, `Failed to sign out other devices (HTTP ${res.status})`))
  }
  return {
    token: String(data.token || ''),
    sid: String(data.sid || ''),
    kickedConnections: Number(data.kickedConnections) || 0,
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    onlineCount: Number(data.onlineCount) || 0,
    onlineDeviceCount: Number(data.onlineDeviceCount) || 0,
    totalCount: Number(data.totalCount) || 0,
  }
}

/**
 * Mobile WebSocket RPC + Stream client with automatic reconnect & catch-up replay.
 */
export class MobileRelayClient {
  constructor({ baseUrl, token, bridgeId = '', roomId = '', e2eeKeys = {} }) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.token = token
    this.roomId = String(roomId || '').trim()
    this.targetBridgeId = String(bridgeId || '').trim()
    this.e2eeKeys = normalizeE2eeKeysMap(e2eeKeys)
    this._inboundEventQueue = Promise.resolve()
    this.ws = null
    this.closed = false
    this.openedOnce = false
    this.connectGen = 0
    this.lastSeq = 0
    this.attempt = 0
    this.reconnectTimer = null
    this.pingTimer = null
    this.reqSeq = 1
    this.pending = new Map()
    this.eventListeners = new Set()
    this.statusListeners = new Set()
    this.connectionState = 'disconnected'
    this.connectionError = ''
    this.bridges = []
    this.devices = null
    this.clientId = ''
    this.onlineClientCount = 0
    this.tier = 'free'
    this.fileLimits = { ...DEFAULT_FILE_LIMITS }
    this._mediaTokenCache = { token: '', expiresAt: 0 }
    this.pendingGrants = []
    this._grantListResolvers = new Map()
  }

  _rejectPendingRpcs(message = L('连接已断开', 'Connection closed')) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    this.pending.clear()
  }

  _settleGrantListResolvers() {
    for (const resolver of this._grantListResolvers.values()) {
      clearTimeout(resolver.timer)
      try { resolver.resolve(this.pendingGrants || []) } catch {}
    }
    this._grantListResolvers.clear()
  }

  setTargetBridgeId(bridgeId) {
    this.targetBridgeId = String(bridgeId || '').trim()
  }

  setE2eeKeys(keysMap) {
    this.e2eeKeys = normalizeE2eeKeysMap(keysMap)
  }

  getBridgeE2eeContext(bridgeId = '') {
    const cleanId = String(bridgeId || this.targetBridgeId || '').trim()
    let bridge = null
    if (cleanId) {
      bridge = this.bridges.find((b) => b.bridgeId === cleanId) || null
    }
    if (!bridge) {
      bridge = this.bridges.find((b) => b.online) || this.bridges[0] || null
    }
    const keyId = String(bridge?.e2ee?.keyId || '').trim().toLowerCase()
    const key = keyId ? String(this.e2eeKeys[keyId] || '').trim() : ''
    return {
      enabled: true,
      ready: Boolean(key),
      keyId,
      key,
    }
  }

  updateToken(newToken) {
    if (newToken) this.token = newToken
  }

  onEvent(fn) {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }

  onStatus(fn) {
    this.statusListeners.add(fn)
    fn({
      state: this.connectionState,
      error: this.connectionError,
      bridges: this.bridges,
      devices: this.devices,
      clientId: this.clientId,
      onlineClientCount: this.onlineClientCount,
      tier: this.tier,
      fileLimits: this.fileLimits,
    })
    return () => this.statusListeners.delete(fn)
  }

  emitStatus() {
    const snap = {
      state: this.connectionState,
      error: this.connectionError,
      bridges: this.bridges,
      devices: this.devices,
      clientId: this.clientId,
      onlineClientCount: this.onlineClientCount,
      tier: this.tier,
      fileLimits: this.fileLimits,
    }
    for (const fn of this.statusListeners) {
      try { fn(snap) } catch {}
    }
  }

  connect() {
    this.closed = false
    this.connectionError = ''
    this.openSocket()
  }

  disconnect() {
    this.closed = true
    this.connectGen += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopPing()
    this._rejectPendingRpcs(L('连接已断开', 'Connection closed'))
    this._settleGrantListResolvers()
    if (this.ws) {
      const oldWs = this.ws
      this.ws = null
      try { oldWs.close(1000) } catch {}
    }
    this.connectionState = 'disconnected'
    this.connectionError = ''
    this.emitStatus()
  }

  scheduleNextReconnect() {
    if (this.closed || this.reconnectTimer) return
    const delay = Math.min(15_000, 1_200 * Math.pow(1.5, Math.min(this.attempt, 6)))
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.openSocket()
    }, delay)
  }

  async openSocket() {
    if (this.closed) return
    const gen = ++this.connectGen
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopPing()
    if (this.ws) {
      const prevWs = this.ws
      this.ws = null
      try { prevWs.close(1000) } catch {}
    }
    this._rejectPendingRpcs(L('连接正在重建', 'Connection reconnecting'))
    this._settleGrantListResolvers()
    this.connectionState = 'connecting'
    this.connectionError = ''
    this.emitStatus()

    // Exchange 30-day master JWT (in Authorization header) for a 30s single-use WS ticket
    let ticket = null
    try {
      ticket = await requestWsTicket(this.baseUrl, this.token)
    } catch (err) {
      if (this.closed || gen !== this.connectGen) return
      if (err?.status === 401) {
        this.connectionState = 'unauthorized'
        this.emitStatus()
        return
      }
      this.connectionState = 'disconnected'
      this.emitStatus()
      this.scheduleNextReconnect()
      return
    }
    if (this.closed || gen !== this.connectGen) return

    if (this.ws) {
      const prevWs = this.ws
      this.ws = null
      try { prevWs.close(1000) } catch {}
    }

    const url = toWsUrl(this.baseUrl, '/ws/client', {
      ticket,
      lastSeq: this.lastSeq > 0 ? this.lastSeq : undefined,
    })

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      if (this.closed || gen !== this.connectGen || this.ws !== ws) {
        try { ws.close(1000) } catch {}
        return
      }
      this.attempt = 0
      this.openedOnce = true
      this.startPing()
      // Wait for the server's `hello` frame (with fresh bridges/devices) before emitting 'connected'
    }

    ws.onmessage = (ev) => {
      if (this.closed || gen !== this.connectGen || this.ws !== ws) return
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }

      if (msg.type === 'hello') {
        if (typeof msg.seq === 'number') this.lastSeq = Math.max(this.lastSeq, msg.seq)
        if (msg.clientId) this.clientId = String(msg.clientId)
        if (msg.tier) this.tier = String(msg.tier)
        if (msg.fileLimits && typeof msg.fileLimits === 'object') {
          this.fileLimits = { ...DEFAULT_FILE_LIMITS, ...msg.fileLimits }
        }
        this.bridges = msg.bridges || []
        if (Array.isArray(msg.devices)) this.devices = msg.devices
        if (Array.isArray(msg.clients)) {
          this.onlineClientCount = Number(msg.onlineClientCount) || msg.clients.length
        }
        this.connectionState = 'connected'
        this.connectionError = ''
        if (Array.isArray(msg.pendingGrants)) {
          this.pendingGrants = msg.pendingGrants
          for (const g of msg.pendingGrants) {
            for (const fn of this.eventListeners) {
              try { fn('e2ee.grant.request', g, msg) } catch {}
            }
          }
        }
        this.emitStatus()
        return
      }

      if (msg.type === 'tier.update') {
        if (msg.tier) this.tier = String(msg.tier)
        if (msg.fileLimits && typeof msg.fileLimits === 'object') {
          this.fileLimits = { ...DEFAULT_FILE_LIMITS, ...msg.fileLimits }
        }
        this.emitStatus()
        return
      }

      if (msg.type === 'e2ee.grant.list.res') {
        const resolver = this._grantListResolvers.get(String(msg.id || ''))
        if (resolver) {
          this._grantListResolvers.delete(String(msg.id || ''))
          clearTimeout(resolver.timer)
          const grants = Array.isArray(msg.grants) ? msg.grants : []
          this.pendingGrants = grants
          resolver.resolve(grants)
        }
        return
      }

      if (msg.type === 'rpc.res') {
        const p = this.pending.get(msg.id)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(msg.id)
        if (msg.e2ee) {
          const resKid = String(msg.e2ee.kid || '').trim().toLowerCase()
          const decryptKey =
            (resKid && (this.e2eeKeys[resKid] || this.e2eeKeys[msg.e2ee.kid])) ||
            p.e2eeKey ||
            ''
          if (!decryptKey) {
            const err = new Error(L('缺少端到端解密密钥，请先扫码同步密钥', 'Missing E2EE key. Scan the QR code on your computer to sync.'))
            err.code = 'E2EE_KEY_REQUIRED'
            err.keyId = String(msg.e2ee.kid || '')
            p.reject(err)
            return
          }
          decryptJson(decryptKey, msg.e2ee, { kind: 'rpc.res', roomId: this.roomId })
            .then((inner) => {
              if (p.cid && inner?.cid && inner.cid !== p.cid) {
                const err = new Error(L('端到端响应编号校验失败', 'E2EE response correlation mismatch'))
                err.code = 'E2EE_CORRELATION_MISMATCH'
                p.reject(err)
                return
              }
              if (inner?.ok) p.resolve(inner.result)
              else {
                const err = new Error(inner?.error?.message || L('RPC 执行失败', 'RPC execution failed'))
                if (inner?.error?.code) err.code = inner.error.code
                p.reject(err)
              }
            })
            .catch((err) => p.reject(err))
          return
        }
        // Strictly reject any forged unencrypted success response
        if (msg.ok) {
          const err = new Error(L('拒绝接收未加密的异常响应', 'Rejected unexpected plaintext response on E2EE channel'))
          err.code = 'E2EE_UNEXPECTED_PLAINTEXT'
          p.reject(err)
          return
        }
        const err = new Error(msg.error?.message || L('RPC 执行失败', 'RPC execution failed'))
        if (msg.error?.code) err.code = msg.error.code
        if (msg.error?.keyId) err.keyId = msg.error.keyId
        p.reject(err)
        return
      }

      if (msg.type === 'event') {
        if (!msg.e2ee) {
          if (typeof msg.seq === 'number') this.lastSeq = Math.max(this.lastSeq, msg.seq)
          // Only relay-originated control metadata events are unencrypted; drop any plaintext bridge events
          if (msg.event === 'bridge.status') {
            if (Array.isArray(msg.payload?.bridges)) this.bridges = msg.payload.bridges
            if (Array.isArray(msg.payload?.devices)) this.devices = msg.payload.devices
            this.emitStatus()
            for (const fn of this.eventListeners) {
              try { fn(msg.event, msg.payload, msg) } catch {}
            }
          } else if (msg.event === 'clients.status') {
            if (Array.isArray(msg.payload?.clients)) {
              this.onlineClientCount = Number(msg.payload?.onlineCount) || msg.payload.clients.length
              this.emitStatus()
            }
            for (const fn of this.eventListeners) {
              try { fn(msg.event, msg.payload, msg) } catch {}
            }
          } else if (
            msg.event === 'e2ee.grant.request' ||
            msg.event === 'e2ee.grant.offer' ||
            msg.event === 'e2ee.grant.deliver' ||
            msg.event === 'e2ee.grant.reject' ||
            msg.event === 'e2ee.grant.cancel' ||
            msg.event === 'e2ee.qr.nudge'
          ) {
            // Relay-routed ephemeral ECDH public-key / ciphertext-envelope signaling (never plaintext E2EE keys)
            if (msg.event === 'e2ee.grant.request' && msg.payload?.reqId) {
              this.pendingGrants = [
                msg.payload,
                ...this.pendingGrants.filter((g) => g.reqId !== msg.payload.reqId),
              ]
            } else if (msg.event === 'e2ee.grant.cancel' && msg.payload?.reqId) {
              this.pendingGrants = this.pendingGrants.filter((g) => g.reqId !== msg.payload.reqId)
            }
            for (const fn of this.eventListeners) {
              try { fn(msg.event, msg.payload, msg) } catch {}
            }
          }
          return
        }
        const evKid = String(msg.e2ee.kid || '').trim().toLowerCase()
        const key = evKid ? (this.e2eeKeys[evKid] || this.e2eeKeys[msg.e2ee.kid] || '') : ''
        // Do NOT advance lastSeq when the decryption key is currently missing so catch-up replay can recover
        if (!key) return
        if (typeof msg.seq === 'number') this.lastSeq = Math.max(this.lastSeq, msg.seq)
        // Decrypt & dispatch encrypted bridge events strictly in FIFO order
        const roomIdSnap = this.roomId
        const envSnap = msg.e2ee
        const rawMsg = msg
        this._inboundEventQueue = this._inboundEventQueue
          .then(async () => {
            if (this.closed || gen !== this.connectGen || this.ws !== ws) return
            const inner = await decryptJson(key, envSnap, { kind: 'event', roomId: roomIdSnap })
            if (this.closed || gen !== this.connectGen || this.ws !== ws) return
            if (!inner?.event) return
            for (const fn of this.eventListeners) {
              try { fn(inner.event, inner.payload, rawMsg) } catch {}
            }
          })
          .catch(() => {})
      }
    }

    ws.onclose = (ev) => {
      if (this.ws === ws) {
        this.ws = null
        this.stopPing()
      }
      if (this.closed || gen !== this.connectGen) return
      this.stopPing()
      this._rejectPendingRpcs(L('连接已断开，正在重连...', 'Connection closed'))
      this._settleGrantListResolvers()

      if (ev.code === 4401) {
        this.connectionState = 'unauthorized'
        this.connectionError = ''
        this.emitStatus()
        return
      }
      if (ev.code === 4029) {
        this.connectionState = 'error'
        this.connectionError = L(
          '同时打开的连接数已达上限，当前标签页已断开，请关闭多余标签页后重新连接。',
          'Too many concurrent tabs or sessions open. This connection was closed. Close extra tabs and reconnect.',
        )
        this.emitStatus()
        return
      }
      this.connectionState = 'disconnected'
      this.emitStatus()

      // If handshake failed before ever opening, verify whether the 30-day JWT expired (HTTP 401)
      if (!this.openedOnce && this.attempt === 0) {
        probeDeviceStatus({ baseUrl: this.baseUrl, token: this.token }, 4000)
          .then((res) => {
            if (this.closed || gen !== this.connectGen) return
            if (res.status === 'expired') {
              this.connectionState = 'unauthorized'
              this.emitStatus()
              return
            }
            this.scheduleNextReconnect()
          })
          .catch(() => this.scheduleNextReconnect())
        return
      }

      this.scheduleNextReconnect()
    }

    ws.onerror = () => {
      // handled in onclose
    }
  }

  startPing() {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })) } catch {}
      }
    }, 25_000)
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  rpc(method, params = {}, timeoutMs = 45_000, options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(L('尚未连接到中转服务器，正在重连...', 'Not connected to relay server, reconnecting...')))
        return
      }
      const id = `c-${this.reqSeq++}-${Date.now()}`
      const bridgeId = options.bridgeId !== undefined
        ? String(options.bridgeId || '').trim()
        : this.targetBridgeId
      const e2eeCtx = this.getBridgeE2eeContext(bridgeId)
      if (!e2eeCtx.ready) {
        const err = new Error(
          L(
            '该电脑已开启端到端加密，请先扫描电脑端二维码同步密钥',
            'This computer requires End-to-End Encryption. Scan its QR code to sync the key.',
          ),
        )
        err.code = 'E2EE_KEY_REQUIRED'
        err.keyId = e2eeCtx.keyId
        reject(err)
        return
      }

      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(L('请求超时，请检查电脑端连接状态', 'Request timed out. Check your computer connection.')))
      }, timeoutMs)

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cid: id,
        e2eeKey: e2eeCtx.key,
        e2eeKeyId: e2eeCtx.keyId,
      })
      encryptJson(
        e2eeCtx.key,
        { method, params, cid: id, ts: Date.now() },
        { kind: 'rpc.req', roomId: this.roomId },
      )
        .then((e2ee) => {
          if (!this.pending.has(id)) return
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            clearTimeout(timer)
            this.pending.delete(id)
            reject(new Error(L('尚未连接到中转服务器，正在重连...', 'Not connected to relay server, reconnecting...')))
            return
          }
          this.ws.send(JSON.stringify({
            type: 'rpc.req',
            id,
            method: E2EE_METHOD_MARKER,
            e2ee,
            timeoutMs,
            ...(bridgeId ? { bridgeId } : {}),
          }))
        })
        .catch((err) => {
          if (!this.pending.has(id)) return
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        })
    })
  }

  sendGrantRequest({ reqId, pubKey, wantedKeyId = '' }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({
      type: 'e2ee.grant.req',
      reqId,
      pubKey,
      ...(wantedKeyId ? { wantedKeyId } : {}),
    }))
    return true
  }

  listGrantRequests(timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve(this.pendingGrants || [])
        return
      }
      const id = `gl-${this.reqSeq++}`
      const timer = setTimeout(() => {
        this._grantListResolvers.delete(id)
        resolve(this.pendingGrants || [])
      }, timeoutMs)
      this._grantListResolvers.set(id, { resolve, timer })
      this.ws.send(JSON.stringify({ type: 'e2ee.grant.list', id }))
    })
  }

  sendGrantOffer({ reqId, approverPubKey }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ type: 'e2ee.grant.offer', reqId, approverPubKey }))
    return true
  }

  sendGrantDeliver({ reqId, envelope }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ type: 'e2ee.grant.deliver', reqId, envelope }))
    return true
  }

  sendGrantReject({ reqId }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ type: 'e2ee.grant.reject', reqId }))
    return true
  }

  sendGrantCancel({ reqId }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ type: 'e2ee.grant.cancel', reqId }))
    return true
  }

  sendQrNudge({ wantedKeyId = '', action = 'scanning' } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({
      type: 'e2ee.qr.nudge',
      action: action === 'done' ? 'done' : 'scanning',
      ...(wantedKeyId ? { wantedKeyId } : {}),
    }))
    return true
  }

  async getMediaToken() {
    const now = Date.now()
    if (this._mediaTokenCache.token && this._mediaTokenCache.expiresAt - now > 60_000) {
      return this._mediaTokenCache.token
    }
    const res = await fetch(`${this.baseUrl}/api/auth/media-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.ok || !data?.mediaToken) {
      throw new Error(data?.error || L('获取加密媒体下载凭证失败', 'Failed to obtain encrypted media token'))
    }
    this._mediaTokenCache = {
      token: String(data.mediaToken),
      expiresAt: Number(data.expiresAt) || now + 14 * 60_000,
    }
    return this._mediaTokenCache.token
  }

  async downloadEncryptedUpload(uploadUrl, e2eeMeta, { mimeType = 'application/octet-stream', consume = true, bridgeId = '' } = {}) {
    const cleanPath = String(uploadUrl || '').trim()
    if (!/^\/api\/uploads\/[a-f0-9-]{8,64}$/i.test(cleanPath)) {
      throw new Error(L('无效的加密文件下载地址', 'Invalid encrypted upload URL'))
    }
    if (!e2eeMeta?.iv) {
      throw new Error(L('缺少端到端解密元数据', 'Missing E2EE metadata'))
    }
    const normKid = String(e2eeMeta.kid || '').trim().toLowerCase()
    const ctx = this.getBridgeE2eeContext(bridgeId || this.targetBridgeId)
    const key =
      (normKid && (this.e2eeKeys[normKid] || this.e2eeKeys[e2eeMeta.kid])) ||
      ctx.key ||
      ''
    if (!key) {
      const err = new Error(L('缺少端到端解密密钥，请先扫码同步密钥', 'Missing E2EE decryption key'))
      err.code = 'E2EE_KEY_REQUIRED'
      err.keyId = normKid
      throw err
    }
    const mediaToken = await this.getMediaToken()
    const fullUrl = `${this.baseUrl}${cleanPath}${consume ? '?consume=1' : ''}`
    const res = await fetch(fullUrl, {
      headers: { Authorization: `Bearer ${mediaToken}` },
    })
    if (!res.ok) {
      let errMsg = ''
      try {
        const j = await res.json()
        errMsg = j?.error || ''
      } catch {}
      throw new Error(errMsg || L(`下载加密文件失败 (HTTP ${res.status})`, `Failed to download encrypted file (HTTP ${res.status})`))
    }
    const dec = await decryptAutoStream(key, res.body || new Uint8Array(await res.arrayBuffer()), {
      iv: e2eeMeta.iv,
      kid: e2eeMeta.kid || '',
      kind: 'upload',
      roomId: this.roomId,
      chunked: Boolean(e2eeMeta.chunked),
    })
    return {
      blob: new Blob(dec.chunks || [], { type: mimeType || 'application/octet-stream' }),
      size: dec.totalPlainBytes,
    }
  }

  async uploadFile(file) {
    const maxBytes = Math.max(1024 * 1024, Number(this.fileLimits?.maxUploadBytes) || MAX_UPLOAD_BYTES)
    if (typeof file?.size === 'number' && file.size > maxBytes) {
      const limitLabel = formatFileLimitLabel(maxBytes)
      throw new Error(
        L(
          `文件过大，当前等级单个附件最大支持 ${limitLabel}`,
          `File is too large (max ${limitLabel} per attachment for your tier)`,
        ),
      )
    }
    const e2eeCtx = this.getBridgeE2eeContext(this.targetBridgeId)
    if (!e2eeCtx.ready) {
      const err = new Error(
        L(
          '该电脑已开启端到端加密，请先扫描电脑端二维码同步密钥后再发送附件',
          'Sync the E2EE key before uploading files to this encrypted computer.',
        ),
      )
      err.code = 'E2EE_KEY_REQUIRED'
      err.keyId = e2eeCtx.keyId
      throw err
    }

    let uploadBody
    let encMeta
    if (typeof file?.size === 'number' && file.size > E2EE_CHUNKED_THRESHOLD) {
      const enc = await encryptChunkedBytes(e2eeCtx.key, file, {
        kind: 'upload',
        roomId: this.roomId,
      })
      uploadBody = new Blob(enc.chunks || [], { type: 'application/octet-stream' })
      encMeta = { v: enc.v, kid: enc.kid, iv: enc.iv, chunked: true }
    } else {
      const rawBytes = new Uint8Array(await file.arrayBuffer())
      const enc = await encryptBytes(e2eeCtx.key, rawBytes, {
        kind: 'upload',
        roomId: this.roomId,
      })
      uploadBody = enc.ciphertext
      encMeta = { v: enc.v, kid: enc.kid, iv: enc.iv }
    }

    const timeoutMs = Math.max(60_000, Math.min(600_000, Math.ceil((file.size || 0) / (256 * 1024)) * 1000))
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    let res
    try {
      res = await fetch(`${this.baseUrl}/api/uploads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Allinone-Encrypted': '1',
          Authorization: `Bearer ${this.token}`,
        },
        body: uploadBody,
        ...(controller ? { signal: controller.signal } : {}),
      })
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(L('附件上传超时，请检查网络后重试', 'Upload timed out. Check your connection and retry.'))
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      throw new Error(data.error || L('上传失败', 'Upload failed'))
    }
    const realMime = file.type || 'application/octet-stream'
    const localPreviewUrl =
      realMime.startsWith('image/') &&
      (file.size || 0) <= 50 * 1024 * 1024 &&
      typeof URL?.createObjectURL === 'function'
        ? URL.createObjectURL(file)
        : ''
    return {
      ...data.upload,
      filename: file.name,
      mimeType: realMime,
      size: file.size,
      e2ee: encMeta,
      ...(localPreviewUrl ? { localPreviewUrl } : {}),
    }
  }
}
