/**
 * Local per-conversation composer draft cache (text + pending attachments).
 * Purely client-side (memory + localStorage), never synced to the relay server.
 */

const DRAFTS_STORAGE_KEY = 'allinone_composer_drafts_v1'
const LAST_SESSION_STORAGE_KEY = 'allinone_last_session_v1'
const LAST_WORKSPACE_STORAGE_KEY = 'allinone_last_workspace_v1'
const MAX_DRAFTS = 60
const MAX_TEXT_CHARS = 32_000

const memoryDrafts = new Map()
const memoryLastSessions = new Map()
const memoryLastWorkspaces = new Map()
const hydratedScopeMaps = new WeakSet()
let hydrated = false

function readRawStorage() {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const P2P_DRAFT_TOKEN_TTL_MS = 14 * 60 * 1000 // PC bridge expires p2pTokens at 15 min

function sanitizeDraftAttachments(rawList, { forPersistence = false, now = Date.now() } = {}) {
  if (!Array.isArray(rawList)) return []
  const out = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const isEphemeralP2p = typeof item.p2pToken === 'string' && item.p2pToken.trim().startsWith('p2p_')
    // Ephemeral p2pTokens live only in PC bridge RAM bound to the current WS clientId — never persist across reloads
    if (forPersistence && isEphemeralP2p) continue
    if (isEphemeralP2p && item._draftSavedAt && now - Number(item._draftSavedAt) > P2P_DRAFT_TOKEN_TTL_MS) {
      continue
    }
    const clean = { ...item }
    delete clean.localPreviewUrl
    if (isEphemeralP2p && !clean._draftSavedAt) {
      clean._draftSavedAt = now
    }
    out.push(clean)
  }
  return out
}

function hydrateOnce() {
  if (hydrated) return
  hydrated = true
  const raw = readRawStorage()
  if (!raw) return
  for (const [key, entry] of Object.entries(raw)) {
    if (!key || !entry || typeof entry !== 'object') continue
    const text = typeof entry.text === 'string' ? entry.text : ''
    const attachments = sanitizeDraftAttachments(entry.attachments, { forPersistence: true })
    if (!text && attachments.length === 0) continue
    memoryDrafts.set(key, {
      text: text.slice(0, MAX_TEXT_CHARS),
      attachments,
      updatedAt: Number(entry.updatedAt) || Date.now(),
    })
  }
}

function persistDrafts() {
  try {
    if (typeof localStorage === 'undefined') return
    const obj = {}
    let count = 0
    for (const [k, v] of memoryDrafts.entries()) {
      const persistedAtts = sanitizeDraftAttachments(v.attachments, { forPersistence: true })
      if (!v.text && persistedAtts.length === 0) continue
      obj[k] = {
        text: v.text,
        attachments: persistedAtts,
        updatedAt: v.updatedAt,
      }
      count += 1
    }
    if (count === 0) {
      localStorage.removeItem(DRAFTS_STORAGE_KEY)
      return
    }
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(obj))
  } catch {
    // Ignore storage quota errors; in-memory map still works cleanly
  }
}

function pruneExcessDrafts() {
  if (memoryDrafts.size <= MAX_DRAFTS) return
  const entries = [...memoryDrafts.entries()].sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
  const removeCount = memoryDrafts.size - MAX_DRAFTS
  for (let i = 0; i < removeCount; i += 1) {
    memoryDrafts.delete(entries[i][0])
  }
}

export function makeDraftKey(scope, sessionId, activeApp = 'dsh') {
  const sc = String(scope || 'default').trim() || 'default'
  if (sessionId) return `${sc}::${sessionId}`
  return `${sc}::__new__::${activeApp || 'dsh'}`
}

export function loadDraft(draftKey) {
  hydrateOnce()
  if (!draftKey) return { text: '', attachments: [] }
  const hit = memoryDrafts.get(draftKey)
  if (!hit) return { text: '', attachments: [] }
  return {
    text: hit.text || '',
    attachments: sanitizeDraftAttachments(hit.attachments),
  }
}

export function saveDraft(draftKey, { text = '', attachments = [] } = {}) {
  hydrateOnce()
  if (!draftKey) return
  const safeText = typeof text === 'string' ? text.slice(0, MAX_TEXT_CHARS) : ''
  const safeAttachments = sanitizeDraftAttachments(attachments)
  if (!safeText && safeAttachments.length === 0) {
    if (memoryDrafts.delete(draftKey)) {
      persistDrafts()
    }
    return
  }
  memoryDrafts.set(draftKey, {
    text: safeText,
    attachments: safeAttachments,
    updatedAt: Date.now(),
  })
  pruneExcessDrafts()
  persistDrafts()
}

export function clearDraft(draftKey) {
  hydrateOnce()
  if (!draftKey) return
  if (memoryDrafts.delete(draftKey)) {
    persistDrafts()
  }
}

export function clearDraftsForScope(scopePrefix) {
  hydrateOnce()
  const prefix = String(scopePrefix || '').trim()
  if (!prefix) {
    memoryDrafts.clear()
    memoryLastSessions.clear()
    memoryLastWorkspaces.clear()
    hydratedScopeMaps.add(memoryLastSessions)
    hydratedScopeMaps.add(memoryLastWorkspaces)
    persistDrafts()
    persistScopeMap(LAST_SESSION_STORAGE_KEY, memoryLastSessions)
    persistScopeMap(LAST_WORKSPACE_STORAGE_KEY, memoryLastWorkspaces)
    return
  }
  let changed = false
  for (const key of [...memoryDrafts.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}::`)) {
      memoryDrafts.delete(key)
      changed = true
    }
  }
  if (changed) persistDrafts()

  clearScopeMapPrefix(LAST_SESSION_STORAGE_KEY, memoryLastSessions, prefix)
  clearScopeMapPrefix(LAST_WORKSPACE_STORAGE_KEY, memoryLastWorkspaces, prefix)
}

function hydrateScopeMap(storageKey, map) {
  if (hydratedScopeMaps.has(map)) return
  hydratedScopeMaps.add(map)
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(storageKey)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return
    for (const [k, v] of Object.entries(parsed)) {
      if (k && typeof v === 'string' && v.trim()) map.set(k, v.trim())
    }
  } catch {}
}

function persistScopeMap(storageKey, map) {
  try {
    if (typeof localStorage === 'undefined') return
    if (map.size === 0) {
      localStorage.removeItem(storageKey)
      return
    }
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(map.entries())))
  } catch {}
}

function clearScopeMapPrefix(storageKey, map, prefix) {
  hydrateScopeMap(storageKey, map)
  let changed = false
  for (const k of [...map.keys()]) {
    if (k === prefix || k.startsWith(`${prefix}::`)) {
      map.delete(k)
      changed = true
    }
  }
  if (changed) persistScopeMap(storageKey, map)
}

export function loadLastSessionId(scope) {
  const sc = String(scope || '').trim()
  if (!sc) return ''
  hydrateScopeMap(LAST_SESSION_STORAGE_KEY, memoryLastSessions)
  return memoryLastSessions.get(sc) || ''
}

export function saveLastSessionId(scope, sessionId) {
  const sc = String(scope || '').trim()
  const sid = String(sessionId || '').trim()
  if (!sc) return
  hydrateScopeMap(LAST_SESSION_STORAGE_KEY, memoryLastSessions)
  if (!sid) {
    if (memoryLastSessions.delete(sc)) persistScopeMap(LAST_SESSION_STORAGE_KEY, memoryLastSessions)
    return
  }
  if (memoryLastSessions.get(sc) === sid) return
  memoryLastSessions.set(sc, sid)
  persistScopeMap(LAST_SESSION_STORAGE_KEY, memoryLastSessions)
}

export function loadLastWorkspace(scope) {
  const sc = String(scope || '').trim()
  if (!sc) return ''
  hydrateScopeMap(LAST_WORKSPACE_STORAGE_KEY, memoryLastWorkspaces)
  return memoryLastWorkspaces.get(sc) || ''
}

export function saveLastWorkspace(scope, cwd) {
  const sc = String(scope || '').trim()
  const path = String(cwd || '').trim()
  if (!sc || !path) return
  hydrateScopeMap(LAST_WORKSPACE_STORAGE_KEY, memoryLastWorkspaces)
  if (memoryLastWorkspaces.get(sc) === path) return
  memoryLastWorkspaces.set(sc, path)
  persistScopeMap(LAST_WORKSPACE_STORAGE_KEY, memoryLastWorkspaces)
}
