import { bi, getCurrentLang } from './i18n.js'

export const DEVICES_STORAGE_KEY = 'allinone_devices_v2'

function getDefaultStorage() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage
    }
  } catch {}
  return null
}

function normalizeDeviceBaseUrl(input) {
  const trimmed = String(input || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

function makeDeviceId(baseUrl, roomId) {
  const cleanBase = normalizeDeviceBaseUrl(baseUrl)
  const cleanRoom = String(roomId || '').trim()
  return `${cleanBase}::${cleanRoom}`
}

export function formatPlatformLabel(platform) {
  const p = String(platform || '').toLowerCase()
  if (p === 'darwin' || p === 'macos') return 'macOS'
  if (p === 'win32' || p === 'windows') return 'Windows'
  if (p === 'linux') return 'Linux'
  return ''
}

function sanitizeE2eeKeysMap(rawMap) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return {}
  const deduped = new Map()
  for (const [kid, val] of Object.entries(rawMap)) {
    const cleanKid = String(kid || '').trim().toLowerCase()
    const cleanVal = String(val || '').trim()
    if (!/^[0-9a-f]{16}$/.test(cleanKid) || !/^[A-Za-z0-9_-]{42,44}$/.test(cleanVal)) continue
    deduped.delete(cleanKid)
    deduped.set(cleanKid, cleanVal)
  }
  const recent = [...deduped.entries()].slice(-16)
  const out = {}
  for (const [k, v] of recent) {
    out[k] = v
  }
  return out
}

function sanitizeDevice(raw, { allowEmptyToken = false } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const baseUrl = normalizeDeviceBaseUrl(raw.baseUrl)
  const token = String(raw.token || '').trim()
  const roomId = String(raw.roomId || '').trim()
  if (!baseUrl || (!allowEmptyToken && !token) || !roomId.startsWith('usr_')) return null
  const id = String(raw.id || makeDeviceId(baseUrl, roomId)).trim()
  const firstBridge = Array.isArray(raw.bridges)
    ? raw.bridges.find((b) => b?.online) || raw.bridges[0] || null
    : null
  const now = Date.now()
  const role = raw.role === 'admin' ? 'admin' : 'user'
  const rawTier = String(raw.tier || '').trim().toLowerCase()
  const tier =
    role === 'admin'
      ? 'admin'
      : rawTier === 'pro' || rawTier === 'ultra' || rawTier === 'free'
        ? rawTier
        : 'free'
  return {
    id,
    baseUrl,
    token,
    roomId,
    username: String(raw.username || '').trim().slice(0, 32),
    email: String(raw.email || '').trim().slice(0, 254),
    loginEmail2fa: Boolean(raw.loginEmail2fa),
    role,
    tier,
    label: String(raw.label || '').trim().slice(0, 64),
    lastHostname: String(raw.lastHostname || firstBridge?.hostname || '').trim().slice(0, 64),
    lastPlatform: String(raw.lastPlatform || firstBridge?.platform || '').trim().slice(0, 32),
    selectedBridgeId: String(raw.selectedBridgeId || firstBridge?.bridgeId || '').trim().slice(0, 64),
    e2eeKeys: sanitizeE2eeKeysMap(raw.e2eeKeys),
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : now,
  }
}

function createEmptyDeviceState() {
  return { version: 2, activeDeviceId: null, devices: [] }
}

export function loadDeviceState(storage = getDefaultStorage()) {
  if (!storage) return createEmptyDeviceState()

  try {
    const rawV2 = storage.getItem(DEVICES_STORAGE_KEY)
    if (rawV2) {
      const parsed = JSON.parse(rawV2)
      const seen = new Set()
      const devices = []
      for (const item of Array.isArray(parsed?.devices) ? parsed.devices : []) {
        const clean = sanitizeDevice(item, { allowEmptyToken: true })
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
      username: incoming.username || existing.username || '',
      email: incoming.email !== undefined && incoming.email !== '' ? incoming.email : existing.email || '',
      loginEmail2fa:
        payload?.loginEmail2fa !== undefined
          ? Boolean(payload.loginEmail2fa)
          : Boolean(existing.loginEmail2fa),
      role: incoming.role || existing.role || '',
      tier: payload?.tier ? incoming.tier : existing.tier || incoming.tier || 'free',
      label: incoming.label || existing.label,
      lastHostname: incoming.lastHostname || existing.lastHostname,
      lastPlatform: incoming.lastPlatform || existing.lastPlatform,
      selectedBridgeId: existing.selectedBridgeId || incoming.selectedBridgeId,
      e2eeKeys: (() => {
        const mergedKeys = { ...sanitizeE2eeKeysMap(existing.e2eeKeys) }
        for (const [k, v] of Object.entries(sanitizeE2eeKeysMap(incoming.e2eeKeys))) {
          delete mergedKeys[k]
          mergedKeys[k] = v
        }
        return sanitizeE2eeKeysMap(mergedKeys)
      })(),
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

  if (patch.token !== undefined) {
    const val = String(patch.token || '').trim()
    if (val && val !== cur.token) {
      next.token = val
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
  if (patch.loginEmail2fa !== undefined) {
    const val = Boolean(patch.loginEmail2fa)
    if (val !== Boolean(cur.loginEmail2fa)) {
      next.loginEmail2fa = val
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
  if (patch.tier !== undefined) {
    const rawT = String(patch.tier || '').trim().toLowerCase()
    const val = rawT === 'free' || rawT === 'pro' || rawT === 'ultra' || rawT === 'admin' ? rawT : ''
    if (val && val !== cur.tier) {
      next.tier = val
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
  if (patch.e2eeKeys !== undefined) {
    const merged = sanitizeE2eeKeysMap(patch.e2eeKeys)
    const prevJson = JSON.stringify(cur.e2eeKeys || {})
    const nextJson = JSON.stringify(merged)
    if (nextJson !== prevJson) {
      next.e2eeKeys = merged
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

export function upsertDeviceE2eeKey(state, deviceId, keyId, key) {
  if (!state || !Array.isArray(state.devices) || !deviceId || !keyId || !key) return state
  const target = state.devices.find((d) => d.id === deviceId)
  if (!target) return state
  const cleanKid = String(keyId).trim().toLowerCase()
  const cleanKey = String(key).trim()
  const merged = { ...(target.e2eeKeys || {}) }
  delete merged[cleanKid]
  merged[cleanKid] = cleanKey
  return updateDeviceMeta(state, deviceId, { e2eeKeys: merged })
}

export function clearDeviceCredentials(state, deviceId) {
  if (!state || !Array.isArray(state.devices) || !deviceId) return state
  const idx = state.devices.findIndex((d) => d.id === deviceId)
  if (idx === -1) return state
  const cur = state.devices[idx]
  const hasE2eeKeys = cur.e2eeKeys && Object.keys(cur.e2eeKeys).length > 0
  if (!cur.token && !hasE2eeKeys && !cur.e2eeKey && !cur.e2eeKeyId) return state
  const next = {
    ...cur,
    token: '',
    e2eeKeys: {},
    e2eeKey: '',
    e2eeKeyId: '',
  }
  const nextDevices = state.devices.slice()
  nextDevices[idx] = next
  return {
    ...state,
    devices: nextDevices,
  }
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

export function getDeviceDisplayName(device, activeBridge = null, lang = getCurrentLang()) {
  if (!device) return bi(lang, '未选择电脑', 'No Computer')
  if (activeBridge) {
    return activeBridge.label || activeBridge.hostname || activeBridge.bridgeId
  }
  if (device.lastHostname) return device.lastHostname
  return device.username ? `@${device.username}` : device.label || bi(lang, '我的账号', 'My Account')
}

export function getCacheScopeKey(device, bridgeId = '') {
  if (!device?.id) return ''
  const effBridge = String(bridgeId || device.selectedBridgeId || '').trim()
  return effBridge ? `${device.id}::${effBridge}` : device.id
}
