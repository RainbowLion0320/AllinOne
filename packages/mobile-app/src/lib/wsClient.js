import { bi, getCurrentLang } from './i18n.js'
import { P2PPeerSession } from './p2pClient.js'

const L = (zh, en) => bi(getCurrentLang(), zh, en)

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

function toWsUrl(httpBase, path, queryParams = {}) {
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

const CLIENT_UID_STORAGE_KEY = 'allinone_client_uid_v1'

function getOrCreateClientUid() {
  if (typeof window !== 'undefined') {
    const desktopUid = String(window.allinoneDesktop?.clientUid || '').trim()
    if (/^[a-zA-Z0-9._-]{8,64}$/.test(desktopUid)) return desktopUid
    try {
      const existing = String(window.localStorage?.getItem(CLIENT_UID_STORAGE_KEY) || '').trim()
      if (/^[a-zA-Z0-9._-]{8,64}$/.test(existing)) return existing
      let randHex = ''
      if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const buf = new Uint8Array(12)
        crypto.getRandomValues(buf)
        randHex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
      } else {
        randHex = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`
      }
      const created = `cli_${randHex}`
      window.localStorage?.setItem(CLIENT_UID_STORAGE_KEY, created)
      return created
    } catch {}
  }
  return ''
}

function detectClientDeviceMeta() {
  const clientUid = getOrCreateClientUid()
  if (typeof window !== 'undefined' && window.allinoneDesktop?.isDesktop) {
    const plat = String(window.allinoneDesktop.platform || '').toLowerCase()
    const osName = plat === 'darwin' ? 'macOS' : plat === 'win32' ? 'Windows' : 'Linux'
    const host = String(window.allinoneDesktop.hostname || '').trim().replace(/\.local$/i, '').slice(0, 32)
    return {
      deviceName: host ? `${osName} Desktop · ${host}` : `${osName} Desktop`,
      clientKind: 'desktop',
      clientUid,
    }
  }
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : ''
  if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
    const isIos = /iPhone|iPad|iPod/i.test(ua)
    return { deviceName: isIos ? 'iOS App' : 'Android App', clientKind: 'mobile', clientUid }
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
  if (isIPhone) return { deviceName: browser ? `iPhone · ${browser}` : 'iPhone', clientKind: 'mobile', clientUid }
  if (isIPad) return { deviceName: browser ? `iPad · ${browser}` : 'iPad', clientKind: 'mobile', clientUid }
  if (isAndroid) return { deviceName: browser ? `Android · ${browser}` : 'Android', clientKind: 'mobile', clientUid }
  if (isWindows) return { deviceName: browser ? `Windows · ${browser}` : 'Windows', clientKind: 'web', clientUid }
  if (isMac) return { deviceName: browser ? `macOS · ${browser}` : 'macOS', clientKind: 'web', clientUid }
  return { deviceName: browser || 'Web Client', clientKind: 'web', clientUid }
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
      ...(devMeta.clientUid ? { clientUid: devMeta.clientUid } : {}),
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
    loginEmail2fa: Boolean(data.user?.loginEmail2fa),
    role: data.user?.role || 'user',
    tier: data.user?.tier || (data.user?.role === 'admin' ? 'admin' : 'free'),
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
      ...(devMeta.clientUid ? { clientUid: devMeta.clientUid } : {}),
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
    role: data.user?.role || 'user',
    tier: data.user?.tier || (data.user?.role === 'admin' ? 'admin' : 'free'),
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

export async function adminCreateInvites(baseUrl, token, { count = 1, note = '', tier = 'free' } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  const normTier = String(tier || 'free').trim().toLowerCase()
  const res = await fetch(`${base}/api/admin/invites`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      count,
      note,
      tier: normTier,
    }),
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
    throw new Error(data.error || L(`更新用户等级失败 (HTTP ${res.status})`, `Failed to update user tier (HTTP ${res.status})`))
  }
  return {
    user: data.user || null,
    tier: String(data.tier || tier || 'free'),
    turnQuota: data.turnQuota || null,
  }
}

export async function adminResetTurnUsage(baseUrl, token, { userId }) {
  const base = normalizeBaseUrl(baseUrl)
  const res = await fetch(`${base}/api/admin/users/reset-turn-usage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ userId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`清零中继流量失败 (HTTP ${res.status})`, `Failed to reset relay usage (HTTP ${res.status})`))
  }
  return {
    user: data.user || null,
    turnQuota: data.turnQuota || null,
  }
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
      loginEmail2fa: Boolean(data.loginEmail2fa),
      emailEnabled: Boolean(data.emailEnabled),
      role: String(data.role || ''),
      tier: String(data.tier || ''),
      turnQuota: data.turnQuota || null,
      roomId: String(data.roomId || device.roomId || ''),
    }
  } catch {
    return { status: 'unreachable', bridges: [], label: '', roomId: device.roomId || '' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function requestWsTicket(baseUrl, token, timeoutMs = 8000) {
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
        ...(devMeta.clientUid ? { clientUid: devMeta.clientUid } : {}),
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
  if (!res.ok || !data.ok) {
    throw new Error(data.error || L(`读取登录终端失败 (HTTP ${res.status})`, `Failed to load active sessions (HTTP ${res.status})`))
  }
  return {
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
      ...(devMeta.clientUid ? { clientUid: devMeta.clientUid } : {}),
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
 * Pure Control Plane WebSocket + Pure WebRTC P2P Data Plane Client (`AIO-P2P v1`).
 *
 * - Control WS (`/ws/client`): Auth, presence (`bridges`/`devices`/`clients`), E2EE key-grant signaling,
 *   and unicast E2EE WebRTC signaling (`p2p.signal`). Carries ZERO chat/RPC/file payloads.
 * - Direct WebRTC P2P (`P2PPeerSession`): Carries 100% of RPCs, streaming chat, images, and files directly
 *   between phone/browser and PC with zero server bandwidth usage.
 */
export class MobileRelayClient {
  constructor({ baseUrl, token, bridgeId = '', roomId = '', e2eeKeys = {} }) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.token = token
    this.roomId = String(roomId || '').trim()
    this.targetBridgeId = String(bridgeId || '').trim()
    this.e2eeKeys = normalizeE2eeKeysMap(e2eeKeys)
    this.ws = null
    this.closed = false
    this.openedOnce = false
    this.connectGen = 0
    this.attempt = 0
    this.reconnectTimer = null
    this.pingTimer = null
    this.reqSeq = 1
    this.eventListeners = new Set()
    this.statusListeners = new Set()
    this.connectionState = 'disconnected'
    this.connectionError = ''
    this.bridges = []
    this.devices = null
    this.clientId = ''
    this.onlineClientCount = 0
    this.iceServers = []
    this.turnQuota = null
    this.pendingGrants = []
    this._grantListResolvers = new Map()

    /** @type {Map<string, P2PPeerSession>} bridgeId -> P2PPeerSession */
    this.p2pPeers = new Map()
    this.p2pState = 'idle' // 'idle' | 'connecting' | 'connected' | 'failed'
    this.p2pError = ''
    this.p2pEngine = ''
    this.p2pTransport = '' // 'direct' | 'relay' | ''
    this._quotaBlockedBridgeId = ''

    this._onWindowOnline = () => {
      if (this.closed) return
      if (this.connectionState === 'connected' && this.p2pState === 'failed') {
        void this.retryP2p().catch(() => {})
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this._onWindowOnline)
    }
  }

  _settleGrantListResolvers() {
    for (const resolver of this._grantListResolvers.values()) {
      clearTimeout(resolver.timer)
      try { resolver.resolve(this.pendingGrants || []) } catch {}
    }
    this._grantListResolvers.clear()
  }

  _resolveTargetBridgeId(override = '') {
    const clean = String(override || this.targetBridgeId || '').trim()
    if (clean) return clean
    const firstOnline = this.bridges.find((b) => b.online)
    return firstOnline?.bridgeId || ''
  }

  _syncActiveP2pStatus() {
    const targetId = this._resolveTargetBridgeId()
    if (!targetId) {
      this._quotaBlockedBridgeId = ''
      this.p2pState = 'idle'
      this.p2pError = ''
      this.p2pEngine = ''
      this.p2pTransport = ''
      this.emitStatus()
      return
    }
    const peer = this.p2pPeers.get(targetId)
    if (!peer) {
      const targetOnline = this.bridges.some((b) => b.bridgeId === targetId && b.online)
      if (
        targetOnline &&
        this._quotaBlockedBridgeId === targetId &&
        this.turnQuota?.exceeded &&
        this.p2pState === 'failed'
      ) {
        this.emitStatus()
        return
      }
      if (this._quotaBlockedBridgeId === targetId) this._quotaBlockedBridgeId = ''
      this.p2pState = 'idle'
      this.p2pError = ''
      this.p2pEngine = ''
      this.p2pTransport = ''
    } else {
      this.p2pState = peer.state === 'closed' ? 'idle' : peer.state
      this.p2pError = peer.error || ''
      this.p2pEngine = peer.remoteEngine || ''
      this.p2pTransport = peer.transportType || ''
    }
    this.emitStatus()
  }

  _closeAllP2pPeers(notifyPeers = true) {
    for (const peer of this.p2pPeers.values()) {
      try { peer.close(notifyPeers) } catch {}
    }
    this.p2pPeers.clear()
    this._quotaBlockedBridgeId = ''
    this.p2pState = 'idle'
    this.p2pError = ''
    this.p2pEngine = ''
    this.p2pTransport = ''
  }

  _pruneOfflinePeers() {
    const onlineIds = new Set(this.bridges.filter((b) => b.online).map((b) => b.bridgeId))
    for (const [bid, peer] of [...this.p2pPeers.entries()]) {
      if (!onlineIds.has(bid)) {
        try { peer.close(false) } catch {}
        this.p2pPeers.delete(bid)
      }
    }
    if (this._quotaBlockedBridgeId && !onlineIds.has(this._quotaBlockedBridgeId)) {
      this._quotaBlockedBridgeId = ''
    }
  }

  _maybeAutoConnectP2p(bridgeOverride = '') {
    if (this.closed || this.connectionState !== 'connected') return
    const targetId = this._resolveTargetBridgeId(bridgeOverride)
    if (!targetId) return
    const bridge = this.bridges.find((b) => b.bridgeId === targetId && b.online)
    if (!bridge) return
    const e2eeCtx = this.getBridgeE2eeContext(targetId)
    if (!e2eeCtx.ready) return
    if (this._quotaBlockedBridgeId === targetId && this.turnQuota?.exceeded) return

    const existing = this.p2pPeers.get(targetId)
    if (existing && !existing.closed && existing.state !== 'failed') return
    // Do not spin-loop if the previous attempt just failed on a blocked network; wait for user Retry or network change
    if (existing && existing.state === 'failed') return

    void this.ensureP2pConnected(targetId).catch(() => {})
  }

  _createP2pPeer(bridgeId) {
    const prev = this.p2pPeers.get(bridgeId)
    if (prev) {
      try { prev.close(false) } catch {}
      this.p2pPeers.delete(bridgeId)
    }

    const peer = new P2PPeerSession({
      bridgeId,
      roomId: this.roomId,
      getE2eeContext: (bid) => this.getBridgeE2eeContext(bid),
      getIceServers: () => this.iceServers,
      sendSignal: ({ bridgeId: bid, sessionId, e2ee }) => {
        if (this.ws?.readyState !== WebSocket.OPEN) return
        try {
          this.ws.send(JSON.stringify({
            type: 'p2p.signal',
            bridgeId: bid,
            sessionId,
            e2ee,
          }))
        } catch {}
      },
      onStateChange: ({ bridgeId: bid, state, error, engine, transport }) => {
        if (this.p2pPeers.get(bid) !== peer) return
        const activeTarget = this._resolveTargetBridgeId()
        if (bid === activeTarget) {
          this.p2pState = state === 'closed' ? 'idle' : state
          this.p2pError = error || ''
          this.p2pEngine = engine || ''
          this.p2pTransport = transport || ''
          this.emitStatus()
        }
      },
      onEvent: (event, payload, rawMsg) => {
        if (this.closed) return
        for (const fn of this.eventListeners) {
          try { fn(event, payload, rawMsg) } catch {}
        }
      },
    })
    this.p2pPeers.set(bridgeId, peer)
    return peer
  }

  async ensureP2pConnected(bridgeOverride = '') {
    const targetId = this._resolveTargetBridgeId(bridgeOverride)
    if (!targetId) {
      throw new Error(L('当前没有在线的电脑端', 'No online computer available'))
    }
    const bridge = this.bridges.find((b) => b.bridgeId === targetId && b.online)
    if (!bridge) {
      const err = new Error(L('目标电脑当前不在线', 'Target computer is offline'))
      err.code = 'BRIDGE_OFFLINE'
      throw err
    }
    const e2eeCtx = this.getBridgeE2eeContext(targetId)
    if (!e2eeCtx.ready) {
      const err = new Error(
        L(
          '该电脑已开启端到端加密，请先扫描电脑端二维码同步密钥',
          'This computer requires End-to-End Encryption. Scan its QR code to sync the key.',
        ),
      )
      err.code = 'E2EE_KEY_REQUIRED'
      err.keyId = e2eeCtx.keyId
      throw err
    }

    let peer = this.p2pPeers.get(targetId)
    if (peer && peer.isOpen()) return peer
    if (peer && !peer.closed && peer.state === 'connecting') {
      return peer.connect()
    }
    // If previous attempt failed or closed, explicitly build a fresh WebRTC session
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(L('尚未连接到控制服务器，正在重连...', 'Not connected to control server, reconnecting...'))
    }
    peer = this._createP2pPeer(targetId)
    return peer.connect()
  }

  async retryP2p(bridgeOverride = '') {
    const targetId = this._resolveTargetBridgeId(bridgeOverride)
    if (!targetId) return null
    if (this._quotaBlockedBridgeId === targetId) this._quotaBlockedBridgeId = ''
    const existing = this.p2pPeers.get(targetId)
    if (existing) {
      this.p2pPeers.delete(targetId)
      try { existing.close(false) } catch {}
    }
    this._syncActiveP2pStatus()
    return this.ensureP2pConnected(targetId)
  }

  setTargetBridgeId(bridgeId) {
    const next = String(bridgeId || '').trim()
    if (next === this.targetBridgeId) return
    this.targetBridgeId = next
    this._syncActiveP2pStatus()
    this._maybeAutoConnectP2p(next)
  }

  setE2eeKeys(keysMap) {
    this.e2eeKeys = normalizeE2eeKeysMap(keysMap)
    this._maybeAutoConnectP2p()
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
      p2pState: this.p2pState,
      p2pError: this.p2pError,
      p2pEngine: this.p2pEngine,
      p2pTransport: this.p2pTransport,
      turnQuota: this.turnQuota,
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
      p2pState: this.p2pState,
      p2pError: this.p2pError,
      p2pEngine: this.p2pEngine,
      p2pTransport: this.p2pTransport,
      turnQuota: this.turnQuota,
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
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this._onWindowOnline)
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopPing()
    this._closeAllP2pPeers(true)
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
    this._settleGrantListResolvers()
    this.connectionState = 'connecting'
    this.connectionError = ''
    this.emitStatus()

    let ticket = null
    try {
      ticket = await requestWsTicket(this.baseUrl, this.token)
    } catch (err) {
      if (this.closed || gen !== this.connectGen) return
      if (err?.status === 401) {
        this._closeAllP2pPeers(false)
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

    const url = toWsUrl(this.baseUrl, '/ws/client', { ticket })
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
    }

    ws.onmessage = (ev) => {
      if (this.closed || gen !== this.connectGen || this.ws !== ws) return
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }

      if (msg.type === 'hello') {
        if (msg.clientId) this.clientId = String(msg.clientId)
        if (msg.roomId && !this.roomId) this.roomId = String(msg.roomId)
        if (Array.isArray(msg.iceServers)) this.iceServers = msg.iceServers
        if (msg.turnQuota !== undefined) this.turnQuota = msg.turnQuota || null
        this.bridges = msg.bridges || []
        if (Array.isArray(msg.devices)) this.devices = msg.devices
        if (Array.isArray(msg.clients)) {
          this.onlineClientCount = Number(msg.onlineClientCount) || msg.clients.length
        }
        this.connectionState = 'connected'
        this.connectionError = ''
        this._pruneOfflinePeers()
        if (Array.isArray(msg.pendingGrants)) {
          this.pendingGrants = msg.pendingGrants
          for (const g of msg.pendingGrants) {
            for (const fn of this.eventListeners) {
              try { fn('e2ee.grant.request', g, msg) } catch {}
            }
          }
        }
        this.emitStatus()
        this._maybeAutoConnectP2p()
        return
      }

      if (msg.type === 'ice.update') {
        const wasExceeded = Boolean(this.turnQuota?.exceeded)
        if (Array.isArray(msg.iceServers)) this.iceServers = msg.iceServers
        if (msg.turnQuota !== undefined) this.turnQuota = msg.turnQuota || null
        if (msg.quotaExceeded) {
          let droppedActiveRelayed = false
          const activeTarget = this._resolveTargetBridgeId()
          for (const [bid, peer] of [...this.p2pPeers.entries()]) {
            if (peer.transportType !== 'direct') {
              this.p2pPeers.delete(bid)
              try { peer.close(true) } catch {}
              if (bid === activeTarget) droppedActiveRelayed = true
            }
          }
          if (droppedActiveRelayed) {
            this._quotaBlockedBridgeId = activeTarget
            this.p2pState = 'failed'
            this.p2pEngine = ''
            this.p2pTransport = ''
            this.p2pError = L(
              '本月加密中继流量额度已用完，已暂停中继连接；切换至同 Wi-Fi / 家用宽带可继续免费 P2P 直连',
              'Monthly encrypted relay quota reached. Relayed session paused; switch to Wi-Fi / home broadband for unlimited direct P2P.',
            )
          }
          this.emitStatus()
        } else {
          if (!this.turnQuota?.exceeded) this._quotaBlockedBridgeId = ''
          this.emitStatus()
          if (wasExceeded && !this.turnQuota?.exceeded && this.p2pState === 'failed') {
            void this.retryP2p().catch(() => {})
          }
        }
        return
      }

      if (msg.type === 'p2p.signal') {
        const bid = String(msg.bridgeId || '').trim()
        const peer = this.p2pPeers.get(bid)
        if (peer) {
          void peer.handleEncryptedSignal({ sessionId: msg.sessionId, e2ee: msg.e2ee })
        }
        return
      }

      if (msg.type === 'p2p.signal.error') {
        const bid = String(msg.bridgeId || '').trim()
        const peer = this.p2pPeers.get(bid)
        if (peer) {
          peer.handleSignalError({
            sessionId: msg.sessionId,
            code: msg.code,
            message: msg.message,
          })
        }
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

      if (msg.type === 'event' && !msg.e2ee) {
        if (msg.event === 'bridge.status') {
          if (Array.isArray(msg.payload?.bridges)) this.bridges = msg.payload.bridges
          if (Array.isArray(msg.payload?.devices)) this.devices = msg.payload.devices
          this._pruneOfflinePeers()
          this._syncActiveP2pStatus()
          this._maybeAutoConnectP2p()
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
      }
    }

    ws.onclose = (ev) => {
      if (this.ws === ws) {
        this.ws = null
        this.stopPing()
      }
      if (this.closed || gen !== this.connectGen) return
      this.stopPing()
      this._settleGrantListResolvers()

      if (ev.code === 4401) {
        this._closeAllP2pPeers(false)
        this.connectionState = 'unauthorized'
        this.connectionError = ''
        this.emitStatus()
        return
      }
      if (ev.code === 4029) {
        this._closeAllP2pPeers(false)
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

      if (!this.openedOnce && this.attempt === 0) {
        probeDeviceStatus({ baseUrl: this.baseUrl, token: this.token }, 4000)
          .then((res) => {
            if (this.closed || gen !== this.connectGen) return
            if (res.status === 'expired') {
              this._closeAllP2pPeers(false)
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

  /**
   * Execute an E2EE RPC directly over WebRTC P2P `aio-ctrl` (0 bytes via server!).
   */
  async rpc(method, params = {}, timeoutMs = 45_000, options = {}) {
    const bridgeId = options.bridgeId !== undefined
      ? String(options.bridgeId || '').trim()
      : this.targetBridgeId
    const peer = await this.ensureP2pConnected(bridgeId)
    return peer.rpc(method, params, timeoutMs)
  }

  /**
   * Pull an E2EE bulk file stream directly from PC over WebRTC P2P `aio-bulk` (0 bytes via server!).
   */
  async downloadP2pBulk(streamId, { mimeType = 'application/octet-stream', size = 0, bridgeId = '', onProgress = null, signal = null } = {}) {
    const peer = await this.ensureP2pConnected(bridgeId || this.targetBridgeId)
    return peer.downloadBulkStream(streamId, { mimeType, size, onProgress, signal })
  }

  /**
   * Stream a local attachment directly to PC over WebRTC P2P `aio-bulk` (0 bytes via server!).
   */
  async uploadFile(file, { bridgeId = '', onProgress = null, signal = null } = {}) {
    const peer = await this.ensureP2pConnected(bridgeId || this.targetBridgeId)
    return peer.uploadFileBulk(file, { onProgress, signal })
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
}
