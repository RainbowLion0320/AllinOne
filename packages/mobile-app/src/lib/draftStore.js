/**
 * Local per-conversation composer draft cache (text + pending attachments).
 * Purely client-side (memory + localStorage), never synced to the relay server.
 */

export const DRAFTS_STORAGE_KEY = 'allinone_composer_drafts_v1'
const MAX_DRAFTS = 60
const MAX_TEXT_CHARS = 32_000

const memoryDrafts = new Map()
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

function hydrateOnce() {
  if (hydrated) return
  hydrated = true
  const raw = readRawStorage()
  if (!raw) return
  for (const [key, entry] of Object.entries(raw)) {
    if (!key || !entry || typeof entry !== 'object') continue
    const text = typeof entry.text === 'string' ? entry.text : ''
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : []
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
    if (memoryDrafts.size === 0) {
      localStorage.removeItem(DRAFTS_STORAGE_KEY)
      return
    }
    const obj = {}
    for (const [k, v] of memoryDrafts.entries()) {
      obj[k] = v
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
    attachments: Array.isArray(hit.attachments) ? [...hit.attachments] : [],
  }
}

export function saveDraft(draftKey, { text = '', attachments = [] } = {}) {
  hydrateOnce()
  if (!draftKey) return
  const safeText = typeof text === 'string' ? text.slice(0, MAX_TEXT_CHARS) : ''
  const safeAttachments = Array.isArray(attachments) ? attachments : []
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
    persistDrafts()
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
}
