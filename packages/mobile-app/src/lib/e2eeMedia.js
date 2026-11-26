import { RPC } from '@allinone/shared'
import { resolveImageSrc } from './imageUrls.js'
import { clearE2eeDeliverableCache } from './e2eeFiles.js'
import { bi, getCurrentLang } from './i18n.js'

const L = (zh, en) => bi(getCurrentLang(), zh, en)

const MAX_BLOB_CACHE = 48
const MEDIA_DB_NAME = 'allinone_media_cache_v1'
const MEDIA_STORE_NAME = 'media'
const MAX_PERSISTED_MEDIA_ENTRIES = 60
const MAX_PERSISTED_MEDIA_BYTES = 40 * 1024 * 1024 // 40 MB persistent LRU cap
const MAX_PERSISTED_ITEM_BYTES = 12 * 1024 * 1024 // Skip persisting >12 MB single images
const MAX_PERSISTED_AGE_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

/** @type {Map<string, { url: string, ts: number }>} */
const blobUrlCache = new Map()
/** @type {Map<string, { promise: Promise<string>, controller: AbortController | null, waiters: number }>} */
const inflightLoads = new Map()
let cacheEpoch = 0
let mediaDbPromise = null

function openMediaDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (mediaDbPromise) return mediaDbPromise
  mediaDbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(MEDIA_DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
          const store = db.createObjectStore(MEDIA_STORE_NAME, { keyPath: 'key' })
          store.createIndex('cachedAt', 'cachedAt', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return mediaDbPromise
}

async function readPersistedMediaBlob(cacheKey) {
  const db = await openMediaDb()
  if (!db) return null
  const record = await new Promise((resolve) => {
    try {
      const tx = db.transaction(MEDIA_STORE_NAME, 'readonly')
      const req = tx.objectStore(MEDIA_STORE_NAME).get(cacheKey)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  if (!record || !record.blob) return null
  const now = Date.now()
  if (record.cachedAt && now - record.cachedAt > MAX_PERSISTED_AGE_MS) {
    void deletePersistedMedia(cacheKey)
    return null
  }
  // Touch LRU timestamp in background when older than 5 minutes
  if (!record.cachedAt || now - record.cachedAt > 5 * 60_000) {
    try {
      const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite')
      tx.objectStore(MEDIA_STORE_NAME).put({ ...record, cachedAt: now })
    } catch {}
  }
  return record.blob instanceof Blob
    ? record.blob
    : new Blob([record.blob], { type: record.mimeType || 'image/png' })
}

async function deletePersistedMedia(cacheKey) {
  const db = await openMediaDb()
  if (!db) return
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite')
      tx.objectStore(MEDIA_STORE_NAME).delete(cacheKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function prunePersistedMediaBudget(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite')
      const store = tx.objectStore(MEDIA_STORE_NAME)
      const idx = store.index('cachedAt')
      const cutoff = Date.now() - MAX_PERSISTED_AGE_MS
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
        const size = Number(val.size || val.blob?.size || 0)
        const expired = val.cachedAt && val.cachedAt < cutoff
        const overEntries = keptCount >= MAX_PERSISTED_MEDIA_ENTRIES
        const overBytes = keptCount > 0 && keptBytes + size > MAX_PERSISTED_MEDIA_BYTES
        if (expired || overEntries || overBytes) {
          store.delete(cur.primaryKey)
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

async function persistMediaBlob(cacheKey, blob, { roomId = '', bridgeId = '', mimeType = '' } = {}) {
  if (!blob || blob.size <= 0 || blob.size > MAX_PERSISTED_ITEM_BYTES) return
  const db = await openMediaDb()
  if (!db) return
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite')
      tx.objectStore(MEDIA_STORE_NAME).put({
        key: cacheKey,
        roomId: String(roomId || ''),
        bridgeId: String(bridgeId || ''),
        mimeType: String(mimeType || blob.type || 'image/png'),
        size: Number(blob.size || 0),
        blob,
        cachedAt: Date.now(),
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
  prunePersistedMediaBudget(db).catch(() => {})
}

function matchesMediaScope(record, { roomId = '', bridgeId = '' } = {}) {
  const cleanRoom = String(roomId || '').trim()
  const cleanBridge = String(bridgeId || '').trim()
  if (cleanRoom && String(record?.roomId || '') !== cleanRoom) return false
  if (cleanBridge && String(record?.bridgeId || '') !== cleanBridge) return false
  return true
}

export async function getPersistedMediaCacheStats({ roomId = '', bridgeId = '' } = {}) {
  const db = await openMediaDb()
  if (!db) return { imageCount: 0, totalBytes: 0 }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(MEDIA_STORE_NAME, 'readonly')
      const req = tx.objectStore(MEDIA_STORE_NAME).getAll()
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? req.result : []
        let imageCount = 0
        let totalBytes = 0
        for (const r of rows) {
          if (!matchesMediaScope(r, { roomId, bridgeId })) continue
          imageCount += 1
          totalBytes += Number(r.size || r.blob?.size || 0)
        }
        resolve({ imageCount, totalBytes })
      }
      req.onerror = () => resolve({ imageCount: 0, totalBytes: 0 })
    } catch {
      resolve({ imageCount: 0, totalBytes: 0 })
    }
  })
}

async function clearPersistedMediaStore({ roomId = '', bridgeId = '' } = {}) {
  const db = await openMediaDb()
  if (!db) return
  const cleanRoom = String(roomId || '').trim()
  const cleanBridge = String(bridgeId || '').trim()
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite')
      const store = tx.objectStore(MEDIA_STORE_NAME)
      if (!cleanRoom && !cleanBridge) {
        store.clear()
      } else {
        const req = store.openCursor()
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) return
          if (matchesMediaScope(cur.value, { roomId: cleanRoom, bridgeId: cleanBridge })) {
            store.delete(cur.primaryKey)
          }
          cur.continue()
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

function makeAbortError() {
  const err = new Error('Image load aborted')
  err.name = 'AbortError'
  return err
}

function attachSignal(entry, signal) {
  if (!signal) {
    entry.waiters += 1
    return entry.promise.finally(() => {
      entry.waiters = Math.max(0, entry.waiters - 1)
    })
  }
  if (signal.aborted) {
    return Promise.reject(makeAbortError())
  }
  entry.waiters += 1
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      entry.waiters = Math.max(0, entry.waiters - 1)
      if (entry.waiters === 0) {
        try { entry.controller?.abort() } catch {}
      }
      reject(makeAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    entry.promise.then(
      (url) => {
        if (settled) return
        settled = true
        cleanup()
        entry.waiters = Math.max(0, entry.waiters - 1)
        resolve(url)
      },
      (err) => {
        if (settled) return
        settled = true
        cleanup()
        entry.waiters = Math.max(0, entry.waiters - 1)
        reject(err)
      },
    )
  })
}

function cacheBlobUrl(cacheKey, url) {
  const existing = blobUrlCache.get(cacheKey)
  if (existing && existing.url !== url) {
    try { URL.revokeObjectURL(existing.url) } catch {}
  }
  blobUrlCache.delete(cacheKey)
  blobUrlCache.set(cacheKey, { url, ts: Date.now() })
  while (blobUrlCache.size > MAX_BLOB_CACHE) {
    const oldestKey = blobUrlCache.keys().next().value
    if (!oldestKey) break
    const oldest = blobUrlCache.get(oldestKey)
    blobUrlCache.delete(oldestKey)
    if (oldest?.url) {
      try { URL.revokeObjectURL(oldest.url) } catch {}
    }
  }
}

export function clearE2eeMediaCache({ persistent = false, roomId = '', bridgeId = '' } = {}) {
  cacheEpoch += 1
  for (const entry of blobUrlCache.values()) {
    if (entry?.url) {
      try { URL.revokeObjectURL(entry.url) } catch {}
    }
  }
  blobUrlCache.clear()
  for (const entry of inflightLoads.values()) {
    try { entry?.controller?.abort() } catch {}
  }
  inflightLoads.clear()
  clearE2eeDeliverableCache()
  if (persistent) {
    return clearPersistedMediaStore({ roomId, bridgeId })
  }
  return Promise.resolve()
}

function resolveTargetAndKey(item, imageContext = {}) {
  const rawUrl = typeof item === 'string' ? '' : String(item?.url || '').trim()
  const rawPath = typeof item === 'string' ? String(item).trim() : String(item?.path || '').trim()
  const target = (rawUrl || rawPath).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
  const roomId = String(imageContext?.roomId || '').trim()
  const bridgeId = String(imageContext?.bridgeId || '').trim()
  const cwd = String(imageContext?.cwd || '').trim()
  const e2eeKeyId = String(imageContext?.e2eeKeyId || '').trim()
  const cacheKey = `${roomId}|${bridgeId}|${e2eeKeyId}|${cwd}|${target}`
  return { target, roomId, bridgeId, cwd, e2eeKeyId, cacheKey }
}

export function needsE2eeMediaLoad(item) {
  if (!item) return false
  if (typeof item === 'object' && item.localPreviewUrl) return false
  const rawUrl = typeof item === 'string' ? '' : String(item?.url || '').trim()
  const rawPath = typeof item === 'string' ? String(item).trim() : String(item?.path || '').trim()
  const target = (rawUrl || rawPath).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
  if (!target || target.startsWith('data:') || target.startsWith('blob:')) return false
  return !/^https?:\/\//i.test(target)
}

export function getCachedE2eeImageUrl(item, imageContext = {}) {
  if (!item) return ''
  if (typeof item === 'object' && item?.localPreviewUrl) {
    return item.localPreviewUrl
  }
  if (!needsE2eeMediaLoad(item)) return ''
  const { target, cacheKey } = resolveTargetAndKey(item, imageContext)
  if (!target) return ''
  const hit = blobUrlCache.get(cacheKey)
  return hit?.url || ''
}

/**
 * Check persistent IndexedDB cache only (0 network bytes — works even offline or under Relay Data Saver).
 */
export async function loadPersistedE2eeImageUrl(item, imageContext = {}) {
  if (!item || !needsE2eeMediaLoad(item)) return ''
  const { target, cacheKey } = resolveTargetAndKey(item, imageContext)
  if (!target) return ''
  const memHit = blobUrlCache.get(cacheKey)
  if (memHit?.url) return memHit.url
  const epoch = cacheEpoch
  const persistedBlob = await readPersistedMediaBlob(cacheKey)
  if (!persistedBlob || epoch !== cacheEpoch) return ''
  const url = URL.createObjectURL(persistedBlob)
  if (epoch !== cacheEpoch) {
    try { URL.revokeObjectURL(url) } catch {}
    return ''
  }
  cacheBlobUrl(cacheKey, url)
  return url
}

/**
 * Load an E2EE-protected local PC image with 3-tier lookup:
 *   1. In-memory Blob URL cache (0ms)
 *   2. Persistent IndexedDB Blob LRU cache (0 network bytes across reloads)
 *   3. Direct WebRTC P2P (`RPC.FILE_READ` + binary `aio-bulk`, 0 server bytes)
 */
export async function loadE2eeImageUrl(item, imageContext = {}, { forceRefresh = false, signal = null } = {}) {
  if (signal?.aborted) {
    throw makeAbortError()
  }
  if (typeof item === 'object' && item?.localPreviewUrl) {
    return item.localPreviewUrl
  }

  const { target, roomId, bridgeId, cwd, cacheKey } = resolveTargetAndKey(item, imageContext)
  if (!target) return ''

  if (!needsE2eeMediaLoad(item)) {
    return resolveImageSrc(item)
  }

  if (!forceRefresh) {
    const hit = blobUrlCache.get(cacheKey)
    if (hit?.url) {
      blobUrlCache.delete(cacheKey)
      blobUrlCache.set(cacheKey, hit)
      return hit.url
    }
    const pending = inflightLoads.get(cacheKey)
    if (pending) return attachSignal(pending, signal)
  } else {
    const stalePending = inflightLoads.get(cacheKey)
    if (stalePending) {
      inflightLoads.delete(cacheKey)
      try { stalePending.controller?.abort() } catch {}
    }
  }

  const epoch = cacheEpoch
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const internalSignal = controller?.signal || null

  const entry = {
    promise: null,
    controller,
    waiters: 0,
  }

  entry.promise = (async () => {
    if (internalSignal?.aborted) throw makeAbortError()
    if (!forceRefresh) {
      const persistedBlob = await readPersistedMediaBlob(cacheKey)
      if (internalSignal?.aborted) throw makeAbortError()
      if (persistedBlob) {
        const persistedUrl = URL.createObjectURL(persistedBlob)
        if (epoch !== cacheEpoch) {
          try { URL.revokeObjectURL(persistedUrl) } catch {}
          throw new Error(L('加密媒体缓存已重置，请重试', 'Encrypted media cache was reset; please retry'))
        }
        cacheBlobUrl(cacheKey, persistedUrl)
        return persistedUrl
      }
    }

    const client = imageContext?.client
    if (!client) throw new Error(L('未连接到电脑端', 'Not connected to computer'))
    const sessionId = String(imageContext?.sessionId || '').trim()
    const result = await client.rpc(
      RPC.FILE_READ,
      { path: target, cwd, ...(sessionId ? { sessionId } : {}) },
      120_000,
      bridgeId ? { bridgeId } : {},
    )
    if (internalSignal?.aborted) throw makeAbortError()
    if (!String(result?.mimeType || '').startsWith('image/')) {
      throw new Error(L('仅支持预览图片文件', 'Only image files can be previewed'))
    }
    if (result?.transferMode !== 'p2p-bulk' || !result?.streamId) {
      throw new Error(L('仅支持预览图片文件', 'Only image files can be previewed'))
    }
    const dl = await client.downloadP2pBulk(result.streamId, {
      mimeType: result.mimeType,
      size: Number(result.size || 0),
      bridgeId,
      signal: internalSignal,
    })
    const blob = dl.blob
    if (internalSignal?.aborted) throw makeAbortError()
    const url = URL.createObjectURL(blob)
    if (epoch !== cacheEpoch) {
      try { URL.revokeObjectURL(url) } catch {}
      throw new Error(L('加密媒体缓存已重置，请重试', 'Encrypted media cache was reset; please retry'))
    }
    cacheBlobUrl(cacheKey, url)
    void persistMediaBlob(cacheKey, blob, { roomId, bridgeId, mimeType: result.mimeType }).catch(() => {})
    return url
  })()

  entry.promise.catch(() => {})

  inflightLoads.set(cacheKey, entry)
  entry.promise.finally(() => {
    if (inflightLoads.get(cacheKey) === entry) {
      inflightLoads.delete(cacheKey)
    }
  })

  return attachSignal(entry, signal)
}
