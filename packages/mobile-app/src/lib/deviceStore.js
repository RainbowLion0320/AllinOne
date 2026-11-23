import { bi, getCurrentLang } from './i18n.js'

export const DEVICES_STORAGE_KEY = 'allinone_devices_v2'
export const LEGACY_AUTH_STORAGE_KEY = 'allinone_dsh_auth_v1'

function getDefaultStorage() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage
    }
  } catch {}
  return null
}

export function normalizeDeviceBaseUrl(input) {
  const trimmed = String(input || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

export function makeDeviceId(baseUrl, roomId = 'owner') {
  const cleanBase = normalizeDeviceBaseUrl(baseUrl)
  const cleanRoom = String(roomId || 'owner').trim() || 'owner'
  return `${cleanBase}::${cleanRoom}`
}

export function formatPlatformLabel(platform) {
  const p = String(platform || '').toLowerCase()
  if (p === 'darwin' || p === 'macos') return 'macOS'
  if (p === 'win32' || p === 'windows') return 'Windows'
  if (p === 'linux') return 'Linux'
  return ''
}

export function formatServerHost(baseUrl) {
  const clean = normalizeDeviceBaseUrl(baseUrl)
  if (!clean) return ''
  try {
    const u = new URL(clean)
    return u.host + (u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '')
  } catch {
    return clean.replace(/^https?:\/\//i, '')
  }
}

function sanitizeDevice(raw) {
  if (!raw || typeof raw !== 'object') return null
  const baseUrl = normalizeDeviceBaseUrl(raw.baseUrl)
  const token = String(raw.token || '').trim()
  if (!baseUrl || !token) return null
  const roomId = String(raw.roomId || 'owner').trim() || 'owner'
  const id = String(raw.id || makeDeviceId(baseUrl, roomId)).trim()
  const firstBridge = Array.isArray(raw.bridges)
    ? raw.bridges.find((b) => b?.online) || raw.bridges[0] || null
    : null
  const now = Date.now()
  const authMode =
    raw.authMode === 'account' || roomId.startsWith('usr_')
      ? 'account'
      : raw.authMode === 'password' || (raw.authMode !== 'pair' && roomId === 'owner')
        ? 'password'
        : 'pair'
  const role = raw.role === 'admin' || roomId === 'owner' ? 'admin' : raw.role === 'user' ? 'user' : ''
  return {
    id,
    baseUrl,
    token,
    roomId,
    authMode,
    username: String(raw.username || '').trim().slice(0, 32),
    email: String(raw.email || '').trim().slice(0, 254),
    role,
    customName: String(raw.customName || '').trim().slice(0, 40),
    label: String(raw.label || '').trim().slice(0, 64),
    lastHostname: String(raw.lastHostname || firstBridge?.hostname || '').trim().slice(0, 64),
    lastPlatform: String(raw.lastPlatform || firstBridge?.platform || '').trim().slice(0, 32),
    selectedBridgeId: String(raw.selectedBridgeId || firstBridge?.bridgeId || '').trim().slice(0, 64),
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : now,
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : now,
  }
}

export function createEmptyDeviceState() {
  return { version: 2, activeDeviceId: null, devices: [] }
}

export function loadDeviceState(storage = getDefaultStorage()) {
  if (!storage) return createEmptyDeviceState()

  // 1. Try v2 multi-device store
  try {
    const rawV2 = storage.getItem(DEVICES_STORAGE_KEY)
    if (rawV2) {
      const parsed = JSON.parse(rawV2)
      const seen = new Set()
      const devices = []
      for (const item of Array.isArray(parsed?.devices) ? parsed.devices : []) {
        const clean = sanitizeDevice(item)
        if (!clean || seen.has(clean.id)) continue
        seen.add(clean.id)
        devices.push(clean)
      }
      const activeExists = devices.some((d) => d.id === parsed?.activeDeviceId)
      const activeDeviceId = activeExists
        ? parsed.activeDeviceId
        : devices[0]?.id || null
      return { version: 2, activeDeviceId, devices }
    }
  } catch {}

  // 2. Migrate seamlessly from legacy single-device v1 auth
  try {
    const rawV1 = storage.getItem(LEGACY_AUTH_STORAGE_KEY)
    if (rawV1) {
      const parsed = JSON.parse(rawV1)
      const migrated = sanitizeDevice(parsed)
      if (migrated) {
        const nextState = {
          version: 2,
          activeDeviceId: migrated.id,
          devices: [migrated],
        }
        saveDeviceState(nextState, storage)
        return nextState
      }
    }
  } catch {}

  return createEmptyDeviceState()
}

export function saveDeviceState(state, storage = getDefaultStorage()) {
  if (!storage) return
  try {
    const payload = {
      version: 2,
      activeDeviceId: state?.activeDeviceId || null,
      devices: Array.isArray(state?.devices) ? state.devices : [],
    }
    storage.setItem(DEVICES_STORAGE_KEY, JSON.stringify(payload))
    // Clean up legacy single-device key so deleted devices are never resurrected on reload
    storage.removeItem(LEGACY_AUTH_STORAGE_KEY)
  } catch {}
}

export function getActiveDevice(state) {
  if (!state || !Array.isArray(state.devices) || state.devices.length === 0) return null
  if (state.activeDeviceId) {
    const found = state.devices.find((d) => d.id === state.activeDeviceId)
    if (found) return found
  }
  return state.devices[0] || null
}

/**
 * Add a newly paired/logged-in computer or refresh credentials for an existing room
 * without disturbing any other saved computers.
 */
export function upsertDevice(state, payload) {
  const baseState = state && Array.isArray(state.devices) ? state : createEmptyDeviceState()
  const incoming = sanitizeDevice(payload)
  if (!incoming) {
    return { state: baseState, device: null, isNew: false }
  }

  const now = Date.now()
  const idx = baseState.devices.findIndex((d) => d.id === incoming.id)
  if (idx !== -1) {
    const existing = baseState.devices[idx]
    const updated = {
      ...existing,
      baseUrl: incoming.baseUrl,
      token: incoming.token,
      roomId: incoming.roomId,
      authMode: incoming.authMode,
      username: incoming.username || existing.username || '',
      email: incoming.email !== undefined && incoming.email !== '' ? incoming.email : existing.email || '',
      role: incoming.role || existing.role || '',
      label: incoming.label || existing.label,
      lastHostname: incoming.lastHostname || existing.lastHostname,
      lastPlatform: incoming.lastPlatform || existing.lastPlatform,
      selectedBridgeId: existing.selectedBridgeId || incoming.selectedBridgeId,
      lastUsedAt: now,
    }
    const nextDevices = baseState.devices.slice()
    nextDevices[idx] = updated
    return {
      state: { version: 2, activeDeviceId: updated.id, devices: nextDevices },
      device: updated,
      isNew: false,
    }
  }

  const created = {
    ...incoming,
    addedAt: now,
    lastUsedAt: now,
  }
  return {
    state: {
      version: 2,
      activeDeviceId: created.id,
      devices: [...baseState.devices, created],
    },
    device: created,
    isNew: true,
  }
}

export function selectDevice(state, deviceId, bridgeId) {
  if (!state || !Array.isArray(state.devices)) return createEmptyDeviceState()
  const idx = state.devices.findIndex((d) => d.id === deviceId)
  if (idx === -1) return state

  const target = state.devices[idx]
  const nextBridgeId = bridgeId !== undefined ? String(bridgeId || '').trim() : target.selectedBridgeId
  const nextDevices = state.devices.slice()
  nextDevices[idx] = {
    ...target,
    selectedBridgeId: nextBridgeId,
    lastUsedAt: Date.now(),
  }
  return {
    version: 2,
    activeDeviceId: deviceId,
    devices: nextDevices,
  }
}

export function updateDeviceMeta(state, deviceId, patch = {}) {
  if (!state || !Array.isArray(state.devices) || !deviceId || !patch) return state
  const idx = state.devices.findIndex((d) => d.id === deviceId)
  if (idx === -1) return state

  const cur = state.devices[idx]
  const next = { ...cur }
  let changed = false

  if (patch.customName !== undefined) {
    const val = String(patch.customName || '').trim().slice(0, 40)
    if (val !== cur.customName) {
      next.customName = val
      changed = true
    }
  }
  if (patch.label !== undefined) {
    const val = String(patch.label || '').trim().slice(0, 64)
    if (val && val !== cur.label) {
      next.label = val
      changed = true
    }
  }
  if (patch.username !== undefined) {
    const val = String(patch.username || '').trim().slice(0, 32)
    if (val && val !== cur.username) {
      next.username = val
      changed = true
    }
  }
  if (patch.email !== undefined) {
    const val = String(patch.email || '').trim().slice(0, 254)
    if (val !== (cur.email || '')) {
      next.email = val
      changed = true
    }
  }
  if (patch.role !== undefined) {
    const val = patch.role === 'admin' ? 'admin' : patch.role === 'user' ? 'user' : ''
    if (val && val !== cur.role) {
      next.role = val
      changed = true
    }
  }
  if (patch.lastHostname !== undefined) {
    const val = String(patch.lastHostname || '').trim().slice(0, 64)
    if (val && val !== cur.lastHostname) {
      next.lastHostname = val
      changed = true
    }
  }
  if (patch.lastPlatform !== undefined) {
    const val = String(patch.lastPlatform || '').trim().slice(0, 32)
    if (val && val !== cur.lastPlatform) {
      next.lastPlatform = val
      changed = true
    }
  }
  if (patch.selectedBridgeId !== undefined) {
    const val = String(patch.selectedBridgeId || '').trim().slice(0, 64)
    if (val !== cur.selectedBridgeId) {
      next.selectedBridgeId = val
      changed = true
    }
  }

  if (!changed) return state
  const nextDevices = state.devices.slice()
  nextDevices[idx] = next
  return {
    ...state,
    devices: nextDevices,
  }
}

export function renameDevice(state, deviceId, customName) {
  return updateDeviceMeta(state, deviceId, { customName })
}

export function removeDevice(state, deviceId) {
  if (!state || !Array.isArray(state.devices)) return createEmptyDeviceState()
  const remaining = state.devices.filter((d) => d.id !== deviceId)
  if (remaining.length === state.devices.length) return state

  let nextActiveId = state.activeDeviceId
  if (nextActiveId === deviceId) {
    if (remaining.length === 0) {
      nextActiveId = null
    } else {
      const mostRecent = [...remaining].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0]
      nextActiveId = mostRecent?.id || remaining[0].id
    }
  }

  return {
    version: 2,
    activeDeviceId: nextActiveId,
    devices: remaining,
  }
}

export function getDeviceDisplayName(device, activeBridge = null, onlineBridgeCount = 0, lang = getCurrentLang()) {
  if (!device) return bi(lang, '未选择电脑', 'No Computer')
  if (device.authMode === 'account' || String(device.roomId || '').startsWith('usr_')) {
    if (activeBridge) {
      return activeBridge.label || activeBridge.hostname || activeBridge.bridgeId
    }
    if (device.lastHostname) return device.lastHostname
    return device.username ? `@${device.username}` : device.label || bi(lang, '我的账号', 'My Account')
  }
  const baseName =
    device.customName ||
    activeBridge?.hostname ||
    device.lastHostname ||
    device.label ||
    (device.roomId === 'owner' ? bi(lang, '我的主电脑', 'My Primary PC') : device.roomId)

  if (onlineBridgeCount > 1 && activeBridge) {
    const bridgeName = activeBridge.hostname || activeBridge.bridgeId
    if (device.customName && bridgeName && bridgeName !== device.customName) {
      return `${device.customName} · ${bridgeName}`
    }
    return bridgeName || baseName
  }

  return baseName
}

export function getCacheScopeKey(device, bridgeId = '') {
  if (!device?.id) return ''
  const effBridge = String(bridgeId || device.selectedBridgeId || '').trim()
  return effBridge ? `${device.id}::${effBridge}` : device.id
}
