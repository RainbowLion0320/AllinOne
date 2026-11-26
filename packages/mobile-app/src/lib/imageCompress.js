/**
 * Client-side smart raster image compression using native browser Canvas / createImageBitmap.
 * Zero external dependencies. Keeps UI screenshots and photos crisp (max 2048px long edge)
 * while typically cutting 4-10 MB mobile photos down to 250-600 KB (85%-92% bandwidth savings).
 */

const DEFAULT_MAX_EDGE = 2048
const DEFAULT_QUALITY = 0.85
const MIN_COMPRESS_BYTES = 200 * 1024 // Skip already-small images (<= 200 KB)

const SKIP_MIMES = new Set(['image/gif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'])
const RASTER_EXT_RE = /\.(?:jpe?g|png|webp|bmp|heic|heif|avif)$/i

export function shouldAttemptImageCompress(file) {
  if (!file || typeof file !== 'object') return false
  const size = Number(file.size || 0)
  if (!Number.isFinite(size) || size <= MIN_COMPRESS_BYTES) return false
  const mime = String(file.type || '').split(';')[0].trim().toLowerCase()
  const name = String(file.name || '').trim()
  if (SKIP_MIMES.has(mime)) return false
  if (/\.(?:gif|svg|ico)$/i.test(name)) return false
  if (mime.startsWith('image/')) return true
  if (!mime && RASTER_EXT_RE.test(name)) return true
  return false
}

export function computeResizedDimensions(width, height, maxEdge = DEFAULT_MAX_EDGE) {
  const w = Math.max(1, Math.round(Number(width) || 0))
  const h = Math.max(1, Math.round(Number(height) || 0))
  const limit = Math.max(256, Math.round(Number(maxEdge) || DEFAULT_MAX_EDGE))
  const longest = Math.max(w, h)
  if (longest <= limit) return { width: w, height: h, resized: false }
  const scale = limit / longest
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    resized: true,
  }
}

export function replaceFileExtension(filename, newExt) {
  const clean = String(filename || 'image').trim() || 'image'
  const dot = clean.lastIndexOf('.')
  const stem = dot > 0 ? clean.slice(0, dot) : clean
  return `${stem}${newExt}`
}

async function decodeImageSource(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => {
          try { bitmap.close?.() } catch {}
        },
      }
    } catch {}
  }

  if (typeof Image === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    return null
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Image decode failed'))
      el.src = url
    })
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      cleanup: () => {
        try { URL.revokeObjectURL(url) } catch {}
      },
    }
  } catch {
    try { URL.revokeObjectURL(url) } catch {}
    return null
  }
}

async function encodeCanvasBlob(canvas, mimeType, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mimeType, quality })
  }
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob || null), mimeType, quality)
  })
}

/**
 * Compress a raster image File/Blob if it yields meaningful (>= 8%) size savings.
 * Never throws on unsupported formats or canvas errors — safely falls back to the original file.
 */
export async function compressImageForUpload(
  file,
  { enabled = true, maxEdge = DEFAULT_MAX_EDGE, quality = DEFAULT_QUALITY } = {},
) {
  const originalSize = Number(file?.size || 0)
  if (!enabled || !shouldAttemptImageCompress(file)) {
    return { file, compressed: false, originalSize, finalSize: originalSize }
  }
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
    return { file, compressed: false, originalSize, finalSize: originalSize }
  }

  let decoded = null
  try {
    decoded = await decodeImageSource(file)
    if (!decoded || decoded.width <= 0 || decoded.height <= 0) {
      return { file, compressed: false, originalSize, finalSize: originalSize }
    }

    const { width, height } = computeResizedDimensions(decoded.width, decoded.height, maxEdge)
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height })
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return { file, compressed: false, originalSize, finalSize: originalSize }
    }
    ctx.drawImage(decoded.source, 0, 0, width, height)

    // Prefer WebP (supports alpha & beats JPEG by ~25-35%); fall back to JPEG when browser lacks WebP encode
    let outBlob = await encodeCanvasBlob(canvas, 'image/webp', quality).catch(() => null)
    let outMime = 'image/webp'
    let outExt = '.webp'
    if (!outBlob || outBlob.type !== 'image/webp') {
      const srcMime = String(file.type || '').toLowerCase()
      if (srcMime === 'image/png') {
        // Avoid losing alpha channel when WebP export is unsupported on older engines
        return { file, compressed: false, originalSize, finalSize: originalSize }
      }
      outBlob = await encodeCanvasBlob(canvas, 'image/jpeg', quality).catch(() => null)
      outMime = 'image/jpeg'
      outExt = '.jpg'
    }

    if (!outBlob || outBlob.size <= 0 || outBlob.size >= originalSize * 0.92) {
      return { file, compressed: false, originalSize, finalSize: originalSize }
    }

    const nextName = replaceFileExtension(file.name || 'image', outExt)
    const outFile =
      typeof File === 'function'
        ? new File([outBlob], nextName, { type: outMime, lastModified: Date.now() })
        : Object.assign(outBlob, { name: nextName })

    return {
      file: outFile,
      compressed: true,
      originalSize,
      finalSize: outBlob.size,
      width,
      height,
      mimeType: outMime,
    }
  } catch {
    return { file, compressed: false, originalSize, finalSize: originalSize }
  } finally {
    decoded?.cleanup?.()
  }
}
