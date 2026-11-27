import { RPC } from '@allinone/shared'
import { bi, getCurrentLang } from './i18n.js'
import { getDeliverableName, normalizeDeliverableKey } from './deliverableFiles.js'

const L = (zh, en) => bi(getCurrentLang(), zh, en)

const MAX_FILE_CACHE = 16
const MAX_FILE_CACHE_BYTES = 25 * 1024 * 1024 // 25 MB memory cap across cached deliverables
const MAX_SINGLE_CACHED_FILE_BYTES = 12 * 1024 * 1024 // Skip caching >12 MB blobs in RAM
const NATIVE_EXPORT_CHUNK_BYTES = 512 * 1024 // 512 KB base64 bridge chunks (~682 KB string) -> zero Android OOM!
/** @type {Map<string, { blob: Blob, url: string, filename: string, mimeType: string, size: number, path: string, ts: number }>} */
const deliverableCache = new Map()
/** @type {Map<string, Promise<any>>} */
const inflightFileLoads = new Map()
let fileCacheEpoch = 0
let deliverableCacheBytes = 0

function makeCacheKey(rawPath, context = {}) {
  const norm = normalizeDeliverableKey(rawPath)
  const roomId = String(context?.roomId || '').trim()
  const bridgeId = String(context?.bridgeId || '').trim()
  const cwd = String(context?.cwd || '').trim()
  const keyId = String(context?.e2eeKeyId || '').trim()
  return `${roomId}|${bridgeId}|${keyId}|${cwd}|${norm}`
}

function storeCachedDeliverable(cacheKey, entry) {
  const entrySize = Number(entry?.size || entry?.blob?.size || 0)
  if (entrySize > MAX_SINGLE_CACHED_FILE_BYTES) {
    return false
  }
  const prev = deliverableCache.get(cacheKey)
  if (prev) {
    deliverableCacheBytes = Math.max(0, deliverableCacheBytes - Number(prev.size || prev.blob?.size || 0))
    if (prev.url && prev.url !== entry.url) {
      try { URL.revokeObjectURL(prev.url) } catch {}
    }
  }
  deliverableCache.delete(cacheKey)
  deliverableCache.set(cacheKey, entry)
  deliverableCacheBytes += entrySize
  while (deliverableCache.size > MAX_FILE_CACHE || deliverableCacheBytes > MAX_FILE_CACHE_BYTES) {
    const oldestKey = deliverableCache.keys().next().value
    if (!oldestKey) break
    const oldest = deliverableCache.get(oldestKey)
    deliverableCache.delete(oldestKey)
    if (oldest) {
      deliverableCacheBytes = Math.max(0, deliverableCacheBytes - Number(oldest.size || oldest.blob?.size || 0))
      if (oldest.url) {
        try { URL.revokeObjectURL(oldest.url) } catch {}
      }
    }
  }
  return true
}

export function scheduleEphemeralDeliverableRevoke(entry, delayMs = 60_000) {
  if (!entry?.ephemeralUrl || !entry?.url || entry._revokeScheduled) return
  entry._revokeScheduled = true
  const targetUrl = entry.url
  setTimeout(() => {
    try { URL.revokeObjectURL(targetUrl) } catch {}
  }, delayMs)
}

export function clearE2eeDeliverableCache() {
  fileCacheEpoch += 1
  for (const entry of deliverableCache.values()) {
    if (entry?.url) {
      try { URL.revokeObjectURL(entry.url) } catch {}
    }
  }
  deliverableCache.clear()
  deliverableCacheBytes = 0
  inflightFileLoads.clear()
}

export function getCachedDeliverableFile(rawPath, context = {}) {
  const key = makeCacheKey(rawPath, context)
  return deliverableCache.get(key) || null
}

/**
 * On-demand E2EE fetch of a local PC deliverable file over WS RPC.FILE_READ (`mode: 'document'`).
 * Never invoked automatically; deduplicates concurrent clicks and caches decrypted Blob in memory.
 */
export async function fetchE2eeDeliverableFile(rawPath, context = {}, { forceRefresh = false } = {}) {
  const target = String(rawPath || '').trim()
  if (!target) throw new Error(L('缺少文件路径', 'Missing file path'))

  const cacheKey = makeCacheKey(target, context)
  if (!forceRefresh) {
    const hit = deliverableCache.get(cacheKey)
    if (hit) {
      deliverableCache.delete(cacheKey)
      deliverableCache.set(cacheKey, hit)
      return hit
    }
    const pending = inflightFileLoads.get(cacheKey)
    if (pending) return pending
  }

  const client = context?.client
  if (!client) {
    throw new Error(L('未连接到电脑端，请先确认电脑在线', 'Not connected to computer'))
  }

  const bridgeId = String(context?.bridgeId || '').trim()
  const cwd = String(context?.cwd || '').trim()
  const sessionId = String(context?.sessionId || '').trim()
  const epoch = fileCacheEpoch

  const job = (async () => {
    const result = await client.rpc(
      RPC.FILE_READ,
      { path: target, cwd, mode: 'document', ...(sessionId ? { sessionId } : {}) },
      300_000,
      bridgeId ? { bridgeId } : {},
    )
    const mimeType = String(result?.mimeType || 'application/octet-stream')
    const filename = String(result?.filename || getDeliverableName(target, 'download'))
    let blob
    let size = Number(result?.size || 0)
    if (result?.transferMode === 'p2p-bulk' && result?.streamId) {
      const dl = await client.downloadP2pBulk(result.streamId, {
        mimeType,
        size,
        bridgeId,
      })
      blob = dl.blob
      size = size || dl.size
    } else {
      throw new Error(L('未能读取到文件内容', 'Failed to read file bytes'))
    }
    const url = URL.createObjectURL(blob)
    if (epoch !== fileCacheEpoch) {
      try { URL.revokeObjectURL(url) } catch {}
      throw new Error(L('加密缓存已重置，请重试', 'Encrypted cache reset; please retry'))
    }
    const entry = {
      blob,
      url,
      filename,
      mimeType,
      size: Number(size || 0),
      path: String(result.path || target),
      ts: Date.now(),
      ephemeralUrl: false,
    }
    const cached = storeCachedDeliverable(cacheKey, entry)
    if (!cached) {
      entry.ephemeralUrl = true
    }
    return entry
  })()

  inflightFileLoads.set(cacheKey, job)
  try {
    return await job
  } finally {
    if (inflightFileLoads.get(cacheKey) === job) {
      inflightFileLoads.delete(cacheKey)
    }
  }
}

function getNativeAndroidFilesPlugin() {
  try {
    if (!isCapacitorAndroid()) return null
    const plugin = window.Capacitor?.Plugins?.AllinOneFiles
    return typeof plugin?.saveAndShare === 'function' ? plugin : null
  } catch {
    return null
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const res = String(reader.result || '')
      const comma = res.indexOf(',')
      resolve(comma >= 0 ? res.slice(comma + 1) : res)
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read file data'))
    reader.readAsDataURL(blob)
  })
}

function uint8ToBase64(u8) {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < u8.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, Math.min(u8.byteLength, i + CHUNK)))
  }
  return btoa(binary)
}

function supportsStreamingAndroidExport(plugin) {
  return Boolean(
    plugin &&
    typeof plugin.openExport === 'function' &&
    typeof plugin.writeExportChunk === 'function' &&
    typeof plugin.finishExport === 'function',
  )
}

export async function saveOrShareBlobNatively(blob, { filename = 'document', mimeType = 'application/octet-stream', mode = 'save' } = {}) {
  const plugin = getNativeAndroidFilesPlugin()
  if (!plugin || !blob) return false
  const cleanFilename = String(filename || 'document')
  const cleanMime = String(mimeType || blob.type || 'application/octet-stream')
  const cleanMode = mode === 'share' ? 'share' : 'save'

  // Stream via chunked export bridge when available (prevents >250MB Base64 OOM crashes on Android!)
  if (supportsStreamingAndroidExport(plugin) && blob.size > NATIVE_EXPORT_CHUNK_BYTES) {
    const { exportId } = await plugin.openExport({
      filename: cleanFilename,
      mimeType: cleanMime,
      mode: cleanMode,
    })
    try {
      for (let off = 0; off < blob.size; off += NATIVE_EXPORT_CHUNK_BYTES) {
        const sliceBuf = await blob.slice(off, Math.min(blob.size, off + NATIVE_EXPORT_CHUNK_BYTES)).arrayBuffer()
        await plugin.writeExportChunk({
          exportId,
          chunkBase64: uint8ToBase64(new Uint8Array(sliceBuf)),
        })
      }
      await plugin.finishExport({ exportId, cancel: false })
      return true
    } catch (err) {
      await plugin.finishExport({ exportId, cancel: true }).catch(() => {})
      throw err
    }
  }

  const dataBase64 = await blobToBase64(blob)
  await plugin.saveAndShare({
    filename: cleanFilename,
    mimeType: cleanMime,
    dataBase64,
    mode: cleanMode,
  })
  return true
}

/**
 * Direct zero-OOM P2P -> Android MediaStore streaming export for huge deliverables (>12MB).
 * Decrypts AIO2 chunks on-the-fly and writes 512 KB slices directly to native storage without buffering the full Blob.
 */
export async function streamExportDeliverableDirect(rawPath, context = {}, { mode = 'save', onProgress = null } = {}) {
  const plugin = getNativeAndroidFilesPlugin()
  if (!supportsStreamingAndroidExport(plugin)) return false
  const client = context?.client
  if (!client) throw new Error(L('未连接到电脑端，请先确认电脑在线', 'Not connected to computer'))

  const target = String(rawPath || '').trim()
  const bridgeId = String(context?.bridgeId || '').trim()
  const cwd = String(context?.cwd || '').trim()
  const sessionId = String(context?.sessionId || '').trim()

  const result = await client.rpc(
    RPC.FILE_READ,
    { path: target, cwd, mode: 'document', ...(sessionId ? { sessionId } : {}) },
    300_000,
    bridgeId ? { bridgeId } : {},
  )
  if (result?.transferMode !== 'p2p-bulk' || !result?.streamId) {
    throw new Error(L('未能读取到文件内容', 'Failed to read file bytes'))
  }
  const mimeType = String(result?.mimeType || 'application/octet-stream')
  const filename = String(result?.filename || getDeliverableName(target, 'download'))
  const { exportId } = await plugin.openExport({
    filename,
    mimeType,
    mode: mode === 'share' ? 'share' : 'save',
  })
  try {
    await client.downloadP2pBulk(result.streamId, {
      mimeType,
      size: Number(result?.size || 0),
      bridgeId,
      onProgress,
      onPlainChunk: async (plainChunk) => {
        for (let off = 0; off < plainChunk.byteLength; off += NATIVE_EXPORT_CHUNK_BYTES) {
          const sub = plainChunk.subarray(off, Math.min(plainChunk.byteLength, off + NATIVE_EXPORT_CHUNK_BYTES))
          await plugin.writeExportChunk({
            exportId,
            chunkBase64: uint8ToBase64(sub),
          })
        }
      },
    })
    await plugin.finishExport({ exportId, cancel: false })
    return true
  } catch (err) {
    await plugin.finishExport({ exportId, cancel: true }).catch(() => {})
    throw err
  }
}

export function canNativeShareFiles() {
  if (getNativeAndroidFilesPlugin()) return true
  try {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof File === 'undefined') {
      return false
    }
    if (typeof navigator.canShare !== 'function') return false
    const probe = new File(['x'], 'probe.txt', { type: 'text/plain' })
    return navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

export async function shareDeliverableFile(entry) {
  if (!entry?.blob) return false
  if (getNativeAndroidFilesPlugin()) {
    return await saveOrShareBlobNatively(entry.blob, {
      filename: entry.filename || 'document',
      mimeType: entry.mimeType || entry.blob.type || 'application/octet-stream',
      mode: 'share',
    })
  }
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return false
  }
  const file = new File([entry.blob], entry.filename || 'document', {
    type: entry.mimeType || 'application/octet-stream',
  })
  if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
    return false
  }
  try {
    await navigator.share({
      files: [file],
      title: entry.filename || 'All in One',
    })
    return true
  } catch (err) {
    // User cancelled the native share sheet — treat as handled without showing an error
    if (err?.name === 'AbortError') return true
    // On iOS Safari / Android Chromium, user-activation gesture expires after a multi-second P2P transfer;
    // return false so callers can fall back to <a download> or let the user tap once more (instant cache hit).
    if (err?.name === 'NotAllowedError') {
      return false
    }
    throw err
  }
}

function isCapacitorAndroid() {
  try {
    return Boolean(
      typeof window !== 'undefined' &&
      window.Capacitor?.isNativePlatform?.() &&
      String(window.Capacitor?.getPlatform?.() || '').toLowerCase() === 'android',
    )
  } catch {
    return false
  }
}

/**
 * Trigger a browser download or native mobile save/share for a decrypted deliverable Blob.
 * In Android Capacitor WebView, `<a download="blob:...">` is ignored by default, so we use
 * our native `AllinOneFiles` Capacitor plugin (MediaStore Downloads / FileProvider share) first.
 */
export async function triggerDeliverableDownload(entry) {
  if (!entry?.blob || !entry?.url) return false

  if (getNativeAndroidFilesPlugin()) {
    const saved = await saveOrShareBlobNatively(entry.blob, {
      filename: entry.filename || 'document',
      mimeType: entry.mimeType || entry.blob.type || 'application/octet-stream',
      mode: 'save',
    })
    if (saved) {
      scheduleEphemeralDeliverableRevoke(entry, 5_000)
      return true
    }
  }

  if (isCapacitorAndroid() && canNativeShareFiles()) {
    const shared = await shareDeliverableFile(entry)
    if (shared) {
      scheduleEphemeralDeliverableRevoke(entry, 5_000)
      return true
    }
  }

  const a = document.createElement('a')
  a.href = entry.url
  a.download = entry.filename || 'document'
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  try {
    a.click()
  } finally {
    setTimeout(() => {
      try { a.remove() } catch {}
    }, 100)
    // Revoke uncached (>12 MB) temporary download Blob URLs after browser download starts
    scheduleEphemeralDeliverableRevoke(entry, 60_000)
  }
  return true
}
