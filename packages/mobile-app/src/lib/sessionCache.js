/**
 * Local persistent chat history cache on the user's phone (IndexedDB with memory fallback).
 * Guardrails against unbounded storage growth:
 *  - Max 40 sessions (LRU eviction)
 *  - Max 120 persisted messages per session (strictly preserves valid pagination cursors)
 *  - Max 12 MB total persisted size (byte-aware LRU eviction)
 *  - 14-day TTL for inactive cached sessions
 */

const DB_NAME = 'allinone_session_cache_v2'
const STORE_NAME = 'sessions'

const MAX_CACHED_SESSIONS = 40
const MAX_MESSAGES_PER_SESSION = 120
const MAX_TOTAL_CACHE_BYTES = 12 * 1024 * 1024 // 12 MB
const MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

const memoryFallback = new Map()
let dbPromise = null

function estimateBytes(obj) {
  try {
    return new Blob([JSON.stringify(obj)]).size
  } catch {
    try {
      return JSON.stringify(obj).length * 2
    } catch {
      return 0
    }
  }
}

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' })
          store.createIndex('cachedAt', 'cachedAt', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

export function makeScopedCacheKey(sessionId, scope = '') {
  const sid = String(sessionId || '')
  const sc = String(scope || '').trim()
  return sc ? `${sc}::${sid}` : sid
}

function stripEphemeralPreviewUrls(messages) {
  if (!Array.isArray(messages)) return []
  let anyChanged = false
  const mapped = messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg
    let msgChanged = false
    let nextImages = msg.images
    if (Array.isArray(msg.images)) {
      let imgsChanged = false
      const cleanedImgs = msg.images.map((img) => {
        if (img && typeof img === 'object' && 'localPreviewUrl' in img) {
          imgsChanged = true
          const { localPreviewUrl: _drop, ...rest } = img
          return rest
        }
        return img
      })
      if (imgsChanged) {
        msgChanged = true
        nextImages = cleanedImgs
      }
    }
    let nextAttachments = msg.attachments
    if (Array.isArray(msg.attachments)) {
      let attsChanged = false
      const cleanedAtts = msg.attachments.map((att) => {
        if (att && typeof att === 'object' && 'localPreviewUrl' in att) {
          attsChanged = true
          const { localPreviewUrl: _drop, ...rest } = att
          return rest
        }
        return att
      })
      if (attsChanged) {
        msgChanged = true
        nextAttachments = cleanedAtts
      }
    }
    if (!msgChanged) return msg
    anyChanged = true
    return {
      ...msg,
      ...(nextImages !== msg.images ? { images: nextImages } : {}),
      ...(nextAttachments !== msg.attachments ? { attachments: nextAttachments } : {}),
    }
  })
  return anyChanged ? mapped : messages
}

export async function loadCachedSession(sessionId, scope = '') {
  if (!sessionId) return null
  const cacheKey = makeScopedCacheKey(sessionId, scope)
  const db = await openDb()
  let record = null
  if (!db) {
    record = memoryFallback.get(cacheKey) || null
  } else {
    record = await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const req = tx.objectStore(STORE_NAME).get(cacheKey)
        req.onsuccess = () => resolve(req.result || memoryFallback.get(cacheKey) || null)
        req.onerror = () => resolve(memoryFallback.get(cacheKey) || null)
      } catch {
        resolve(memoryFallback.get(cacheKey) || null)
      }
    })
  }

  if (!record) return null
  if (record.cachedAt && Date.now() - record.cachedAt > MAX_CACHE_AGE_MS) {
    void deleteCachedSession(sessionId, scope)
    return null
  }
  if (Array.isArray(record.messages)) {
    const cleaned = stripEphemeralPreviewUrls(record.messages)
    if (cleaned !== record.messages) {
      return { ...record, messages: cleaned }
    }
  }
  return record
}

export async function deleteCachedSession(sessionId, scope = '') {
  if (!sessionId) return
  const cacheKey = makeScopedCacheKey(sessionId, scope)
  memoryFallback.delete(cacheKey)
  const db = await openDb()
  if (!db) return
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(cacheKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function saveCachedSession(sessionId, payload, scope = '') {
  if (!sessionId || !payload) return
  const cleanScope = String(scope || '').trim()
  const cacheKey = makeScopedCacheKey(sessionId, cleanScope)

  let messages = stripEphemeralPreviewUrls(Array.isArray(payload.messages) ? payload.messages : [])
  let hasMore = Boolean(payload.hasMore)
  let nextCursor = payload.nextCursor ?? null
  const totalCount = payload.totalCount ?? null

  // Enforce per-session persisted cap without ever corrupting opaque cursors (e.g. Codex)
  if (messages.length > MAX_MESSAGES_PER_SESSION) {
    const dropCount = messages.length - MAX_MESSAGES_PER_SESSION
    const isCodexSession =
      payload.meta?.app === 'codex' || String(sessionId).startsWith('codex:')
    const isNumericCursor =
      !isCodexSession &&
      (nextCursor === null ||
        nextCursor === undefined ||
        (typeof nextCursor === 'string' && /^\d+$/.test(nextCursor)))

    if (isNumericCursor) {
      const baseStart = nextCursor ? Number(nextCursor) : 0
      messages = messages.slice(dropCount)
      nextCursor = String(baseStart + dropCount)
      hasMore = true
    } else {
      // For Codex / opaque-cursor sessions exceeding MAX_MESSAGES_PER_SESSION:
      // retain the latest 120 messages cleanly and clear cursor/hasMore so we neither
      // fabricate invalid numeric cursors nor freeze cache updates or skip history gaps.
      messages = messages.slice(-MAX_MESSAGES_PER_SESSION)
      hasMore = false
      nextCursor = null
    }
  }

  const baseRecord = {
    sessionId: cacheKey,
    rawSessionId: String(sessionId),
    scope: cleanScope,
    meta: payload.meta || null,
    messages,
    hasMore,
    nextCursor,
    totalCount,
    cachedAt: Date.now(),
  }
  const approxBytes = estimateBytes(baseRecord)
  const record = { ...baseRecord, approxBytes }

  memoryFallback.set(cacheKey, record)

  const db = await openDb()
  if (!db) return

  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })

  // Background TTL + session count + total byte budget LRU prune
  pruneCacheBudget(db).catch(() => {})
}

async function pruneCacheBudget(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const idx = store.index('cachedAt')
      const cutoff = Date.now() - MAX_CACHE_AGE_MS
      let keptCount = 0
      let keptBytes = 0

      const req = idx.openCursor(null, 'prev') // newest -> oldest
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) {
          resolve()
          return
        }
        const val = cur.value || {}
        const size = Number(val.approxBytes) || estimateBytes(val)
        const expired = val.cachedAt && val.cachedAt < cutoff
        const overSessions = keptCount >= MAX_CACHED_SESSIONS
        const overBytes = keptCount > 0 && keptBytes + size > MAX_TOTAL_CACHE_BYTES

        if (expired || overSessions || overBytes) {
          store.delete(cur.primaryKey)
          memoryFallback.delete(cur.primaryKey)
        } else {
          keptCount += 1
          keptBytes += size
        }
        cur.continue()
      }
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

function matchesScope(record, scopeOrPrefix, prefix = false) {
  if (!scopeOrPrefix) return true
  const recScope = String(record?.scope || '')
  const recKey = String(record?.sessionId || '')
  if (prefix) {
    return (
      recScope === scopeOrPrefix ||
      recScope.startsWith(`${scopeOrPrefix}::`) ||
      recKey.startsWith(`${scopeOrPrefix}::`)
    )
  }
  if (record?.scope !== undefined) {
    return recScope === scopeOrPrefix
  }
  if (!recKey.startsWith(`${scopeOrPrefix}::`)) return false
  return !recKey.slice(scopeOrPrefix.length + 2).includes('::')
}

export async function getSessionCacheStats(scope = '') {
  const cleanScope = String(scope || '').trim()
  const db = await openDb()
  if (!db) {
    let sessionCount = 0
    let messageCount = 0
    let totalBytes = 0
    for (const r of memoryFallback.values()) {
      if (!matchesScope(r, cleanScope, false)) continue
      sessionCount += 1
      messageCount += r.messages?.length || 0
      totalBytes += Number(r.approxBytes) || estimateBytes(r)
    }
    return { sessionCount, messageCount, totalBytes }
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAll()
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? req.result : []
        let sessionCount = 0
        let messageCount = 0
        let totalBytes = 0
        for (const r of rows) {
          if (!matchesScope(r, cleanScope, false)) continue
          sessionCount += 1
          messageCount += r.messages?.length || 0
          totalBytes += Number(r.approxBytes) || estimateBytes(r)
        }
        resolve({ sessionCount, messageCount, totalBytes })
      }
      req.onerror = () => resolve({ sessionCount: 0, messageCount: 0, totalBytes: 0 })
    } catch {
      resolve({ sessionCount: 0, messageCount: 0, totalBytes: 0 })
    }
  })
}

export async function clearSessionCache(scopeOrPrefix = '', { prefix = false } = {}) {
  const cleanScope = String(scopeOrPrefix || '').trim()
  if (!cleanScope) {
    memoryFallback.clear()
    const db = await openDb()
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          tx.objectStore(STORE_NAME).clear()
          tx.oncomplete = () => resolve()
          tx.onerror = () => resolve()
        } catch {
          resolve()
        }
      })
    }
    return
  }

  for (const [k, v] of memoryFallback.entries()) {
    if (matchesScope(v, cleanScope, prefix)) {
      memoryFallback.delete(k)
    }
  }

  const db = await openDb()
  if (!db) return
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.openCursor()
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) return
        if (matchesScope(cur.value, cleanScope, prefix)) {
          store.delete(cur.primaryKey)
        }
        cur.continue()
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

export function formatBytesCompact(bytes) {
  const n = Number(bytes || 0)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Deduplicate and merge chronological message arrays (`older` before `newer`).
 */
export function mergeSessionMessages(older = [], newer = []) {
  const byId = new Map()
  const orderedIds = []

  const add = (m) => {
    if (!m) return
    const id = m.id || `${m.role}-${m.ts || 0}-${orderedIds.length}`
    if (!byId.has(id)) {
      orderedIds.push(id)
      byId.set(id, { ...m, id })
    } else {
      byId.set(id, { ...byId.get(id), ...m, id })
    }
  }

  for (const m of older) add(m)
  for (const m of newer) add(m)

  return orderedIds.map((id) => byId.get(id))
}

/**
 * Reconcile a fresh tail page from PC with an existing phone-cached history.
 * Strictly drops trailing synthetic optimistic messages (`msg-u-*` / `msg-a-*`) once
 * authoritative persisted messages overlap, preventing ghost duplicates or stale tails.
 */
export function reconcileCachedWithFreshPage(cached, fresh) {
  const freshMsgs = Array.isArray(fresh?.messages) ? fresh.messages : []
  const cachedMsgs = Array.isArray(cached?.messages) ? cached.messages : []

  if (cachedMsgs.length === 0 || !fresh?.hasMore) {
    return {
      messages: freshMsgs,
      hasMore: Boolean(fresh?.hasMore),
      nextCursor: fresh?.nextCursor ?? null,
      totalCount: fresh?.totalCount ?? null,
    }
  }

  if (freshMsgs.length === 0) {
    return {
      messages: cachedMsgs,
      hasMore: Boolean(cached?.hasMore),
      nextCursor: cached?.nextCursor ?? null,
      totalCount: cached?.totalCount ?? null,
    }
  }

  const freshIdSet = new Set(freshMsgs.map((m) => m?.id).filter(Boolean))
  const firstFreshIdxInCache = cachedMsgs.findIndex((m) => m?.id && m.id === freshMsgs[0]?.id)
  const firstOverlapIdx =
    firstFreshIdxInCache >= 0
      ? firstFreshIdxInCache
      : cachedMsgs.findIndex((m) => m?.id && freshIdSet.has(m.id))

  if (firstOverlapIdx > 0 && cachedMsgs.length >= freshMsgs.length) {
    const firstFreshTs = Number(freshMsgs[0]?.ts || 0)
    const olderPrefix = cachedMsgs.slice(0, firstOverlapIdx).filter((m) => {
      if (!m) return false
      if (/^msg-[ua]-/.test(String(m.id || '')) && firstFreshTs > 0 && Number(m.ts || 0) >= firstFreshTs - 5_000) {
        return false
      }
      return true
    })
    const merged = mergeSessionMessages(olderPrefix, freshMsgs)
    return {
      messages: merged,
      hasMore: Boolean(cached.hasMore),
      nextCursor: cached.nextCursor ?? null,
      totalCount: fresh?.totalCount ?? cached.totalCount ?? null,
    }
  }

  return {
    messages: freshMsgs,
    hasMore: Boolean(fresh?.hasMore),
    nextCursor: fresh?.nextCursor ?? null,
    totalCount: fresh?.totalCount ?? null,
  }
}
