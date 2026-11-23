import { RPC } from '@allinone/shared'
import { base64ToBytes, decryptBytes } from '@allinone/shared/e2ee'
import { resolveImageSrc } from './imageUrls.js'

const MAX_BLOB_CACHE = 48
/** @type {Map<string, { url: string, ts: number }>} */
const blobUrlCache = new Map()
/** @type {Map<string, Promise<string>>} */
const inflightLoads = new Map()

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
  for (const entry of blobUrlCache.values()) {
    if (entry?.url) {
      try { URL.revokeObjectURL(entry.url) } catch {}
    }
  }
  blobUrlCache.clear()
  inflightLoads.clear()
}

export function needsE2eeMediaLoad(item, imageContext = {}) {
  if (!item) return false
  if (typeof item === 'object' && item.localPreviewUrl) return false
  const rawUrl = typeof item === 'string' ? '' : String(item?.url || '').trim()
  const rawPath = typeof item === 'string' ? String(item).trim() : String(item?.path || '').trim()
  const target = (rawUrl || rawPath).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
  if (!target || target.startsWith('data:') || target.startsWith('blob:')) return false

  // Encrypted relay upload (/api/uploads/<id> with item.e2ee)
  if (typeof item === 'object' && item.e2ee?.iv && target.startsWith('/api/uploads/')) {
    return true
  }

  // Local PC file path -> always load over E2EE-encrypted RPC.FILE_READ
  const isHttp = /^https?:\/\//i.test(target)
  const isUpload = target.startsWith('/api/uploads/')
  if (!isHttp && !isUpload) {
    return true
  }

  return false
}

/**
 * Load an E2EE-protected image (either via encrypted RPC.FILE_READ or encrypted /api/uploads/<id>)
 * and return a local `blob:` URL cached in memory. Relay server never sees plaintext bytes or paths.
 */
export async function loadE2eeImageUrl(item, imageContext = {}, { forceRefresh = false } = {}) {
  if (typeof item === 'object' && item?.localPreviewUrl) {
    return item.localPreviewUrl
  }

  const rawUrl = typeof item === 'string' ? '' : String(item?.url || '').trim()
  const rawPath = typeof item === 'string' ? String(item).trim() : String(item?.path || '').trim()
  const target = (rawUrl || rawPath).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
  if (!target) return ''

  if (!needsE2eeMediaLoad(item, imageContext)) {
    return resolveImageSrc(item, imageContext)
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

  const job = (async () => {
    // Case 1: Encrypted relay-hosted upload
    if (typeof item === 'object' && item.e2ee?.iv && target.startsWith('/api/uploads/')) {
      const fetchUrl = resolveImageSrc({ url: target }, imageContext)
      if (!fetchUrl) throw new Error('无法构造附件下载地址')
      const key =
        (item.e2ee.kid && imageContext?.e2eeKeys?.[item.e2ee.kid]) ||
        imageContext?.e2eeKey ||
        ''
      if (!key) throw new Error('缺少端到端解密密钥')
      const res = await fetch(fetchUrl)
      if (!res.ok) throw new Error(`下载加密附件失败 (HTTP ${res.status})`)
      const cipherBytes = new Uint8Array(await res.arrayBuffer())
      const plainBytes = await decryptBytes(key, cipherBytes, {
        iv: item.e2ee.iv,
        kid: item.e2ee.kid || '',
        kind: 'upload',
        roomId: imageContext?.roomId || '',
      })
      const blob = new Blob([plainBytes], { type: item.mimeType || 'image/png' })
      const url = URL.createObjectURL(blob)
      cacheBlobUrl(cacheKey, url)
      return url
    }

    // Case 2: Local PC image file fetched through E2EE-encrypted WS RPC.FILE_READ
    const client = imageContext?.client
    if (!client) throw new Error('未连接到电脑端')
    const result = await client.rpc(
      RPC.FILE_READ,
      { path: target, cwd },
      25_000,
      bridgeId ? { bridgeId } : {},
    )
    if (!result?.dataBase64 || !String(result.mimeType || '').startsWith('image/')) {
      throw new Error('仅支持预览图片文件')
    }
    const bytes = base64ToBytes(result.dataBase64)
    const blob = new Blob([bytes], { type: result.mimeType })
    const url = URL.createObjectURL(blob)
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
