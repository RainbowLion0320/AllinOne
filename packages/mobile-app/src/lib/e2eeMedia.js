import { RPC } from '@allinone/shared'
import { base64ToBytes } from '@allinone/shared/e2ee'
import { resolveImageSrc } from './imageUrls.js'
import { clearE2eeDeliverableCache } from './e2eeFiles.js'
import { bi, getCurrentLang } from './i18n.js'

const L = (zh, en) => bi(getCurrentLang(), zh, en)

const MAX_BLOB_CACHE = 48
/** @type {Map<string, { url: string, ts: number }>} */
const blobUrlCache = new Map()
/** @type {Map<string, Promise<string>>} */
const inflightLoads = new Map()
let cacheEpoch = 0

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

export function clearE2eeMediaCache() {
  cacheEpoch += 1
  for (const entry of blobUrlCache.values()) {
    if (entry?.url) {
      try { URL.revokeObjectURL(entry.url) } catch {}
    }
  }
  blobUrlCache.clear()
  inflightLoads.clear()
  clearE2eeDeliverableCache()
}

export function needsE2eeMediaLoad(item) {
  if (!item) return false
  if (typeof item === 'object' && item.localPreviewUrl) return false
  const rawUrl = typeof item === 'string' ? '' : String(item?.url || '').trim()
  const rawPath = typeof item === 'string' ? String(item).trim() : String(item?.path || '').trim()
  const target = (rawUrl || rawPath).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
  if (!target || target.startsWith('data:') || target.startsWith('blob:')) return false

  // Local PC file path -> always load directly via P2P E2EE RPC.FILE_READ (0 server bytes)
  const isHttp = /^https?:\/\//i.test(target)
  if (!isHttp) {
    return true
  }

  return false
}

/**
 * Load an E2EE-protected local PC image over direct WebRTC P2P (`RPC.FILE_READ` + `aio-bulk` for >128KB)
 * and return a local `blob:` URL cached in memory. Server sees zero image bytes or paths.
 */
export async function loadE2eeImageUrl(item, imageContext = {}, { forceRefresh = false } = {}) {
  if (typeof item === 'object' && item?.localPreviewUrl) {
    return item.localPreviewUrl
  }

  const rawUrl = typeof item === 'string' ? '' : String(item?.url || '').trim()
  const rawPath = typeof item === 'string' ? String(item).trim() : String(item?.path || '').trim()
  const target = (rawUrl || rawPath).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
  if (!target) return ''

  if (!needsE2eeMediaLoad(item)) {
    return resolveImageSrc(item)
  }

  const bridgeId = String(imageContext?.bridgeId || '').trim()
  const cwd = String(imageContext?.cwd || '').trim()
  const e2eeKeyId = String(item?.e2ee?.kid || imageContext?.e2eeKeyId || '').trim()
  const cacheKey = `${imageContext?.roomId || ''}|${bridgeId}|${e2eeKeyId}|${cwd}|${target}`

  if (!forceRefresh) {
    const hit = blobUrlCache.get(cacheKey)
    if (hit?.url) {
      blobUrlCache.delete(cacheKey)
      blobUrlCache.set(cacheKey, hit)
      return hit.url
    }
    const pending = inflightLoads.get(cacheKey)
    if (pending) return pending
  }

  const epoch = cacheEpoch
  const job = (async () => {
    const client = imageContext?.client
    if (!client) throw new Error(L('未连接到电脑端', 'Not connected to computer'))
    const result = await client.rpc(
      RPC.FILE_READ,
      { path: target, cwd },
      120_000,
      bridgeId ? { bridgeId } : {},
    )
    if (!String(result?.mimeType || '').startsWith('image/')) {
      throw new Error(L('仅支持预览图片文件', 'Only image files can be previewed'))
    }
    let blob
    if (result?.transferMode === 'p2p-bulk' && result?.streamId) {
      const dl = await client.downloadP2pBulk(result.streamId, {
        mimeType: result.mimeType,
        size: Number(result.size || 0),
        bridgeId,
      })
      blob = dl.blob
    } else if (result?.dataBase64) {
      const bytes = base64ToBytes(result.dataBase64)
      blob = new Blob([bytes], { type: result.mimeType })
    } else {
      throw new Error(L('仅支持预览图片文件', 'Only image files can be previewed'))
    }
    const url = URL.createObjectURL(blob)
    if (epoch !== cacheEpoch) {
      try { URL.revokeObjectURL(url) } catch {}
      throw new Error(L('加密媒体缓存已重置，请重试', 'Encrypted media cache was reset; please retry'))
    }
    cacheBlobUrl(cacheKey, url)
    return url
  })()

  inflightLoads.set(cacheKey, job)
  try {
    return await job
  } finally {
    if (inflightLoads.get(cacheKey) === job) {
      inflightLoads.delete(cacheKey)
    }
  }
}
