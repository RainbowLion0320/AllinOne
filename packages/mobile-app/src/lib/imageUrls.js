import { bi, getCurrentLang } from './i18n.js'

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif|ico)$/i

export function stripQueryHash(raw) {
  return String(raw || '').split(/[?#]/)[0]
}

export function isImageTarget(raw) {
  const s = String(raw || '').trim()
  if (!s) return false
  if (s.startsWith('data:image/') || s.startsWith('blob:')) return true
  const clean = stripQueryHash(s).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '')
  return IMAGE_EXT_RE.test(clean)
}

export function getImageLabel(raw, fallback = bi(getCurrentLang(), '图片', 'Image')) {
  const s = String(raw || '').trim()
  if (!s) return fallback
  if (s.startsWith('data:image/')) return fallback
  const clean = stripQueryHash(s).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '')
  const parts = clean.split(/[\\/]/).filter(Boolean)
  const last = parts[parts.length - 1] || fallback
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

export function normalizeImageKey(ref) {
  const s = String(ref || '').trim().replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '')
  if (s.startsWith('data:')) return s.slice(0, 80)
  return s
    .replace(/^file:\/\/(?:localhost)?\//i, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

export function resolveImageSrc(item) {
  const rawUrl = typeof item === 'string' ? '' : String(item?.url || '').trim()
  const rawPath = typeof item === 'string' ? String(item).trim() : String(item?.path || '').trim()
  const target = (rawUrl || rawPath).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
  if (!target) return ''

  if (target.startsWith('data:image/') || target.startsWith('blob:')) {
    return target
  }

  // External direct HTTP(S) URL
  if (/^https?:\/\//i.test(target)) {
    return target
  }

  // Local PC file paths are exclusively loaded via P2P E2EE RPC.FILE_READ (see e2eeMedia.js)
  return ''
}

export function isRelayUploadTarget() {
  return false
}

/**
 * Scan markdown `![alt](dest)` and `[label](dest)` supporting nested balanced parentheses
 * such as `C:/Users/Administrator/Pictures/Screenshots/屏幕截图(1).png` and `<dest>`.
 */
export function scanMarkdownLinks(text) {
  const results = []
  const src = String(text || '')
  const len = src.length
  let i = 0

  while (i < len) {
    const isImage = src[i] === '!' && src[i + 1] === '['
    if (!isImage && src[i] !== '[') {
      i += 1
      continue
    }

    const start = i
    const bracketOpen = isImage ? i + 1 : i
    let bracketClose = -1
    let bDepth = 0
    for (let j = bracketOpen; j < len; j += 1) {
      if (src[j] === '\\') {
        j += 1
        continue
      }
      if (src[j] === '[') bDepth += 1
      else if (src[j] === ']') {
        bDepth -= 1
        if (bDepth === 0) {
          bracketClose = j
          break
        }
      }
      if (src[j] === '\n') break
    }

    if (bracketClose === -1 || src[bracketClose + 1] !== '(') {
      i += 1
      continue
    }

    const destStart = bracketClose + 2
    let destEnd = -1
    let dest = ''

    if (src[destStart] === '<') {
      const closeAngle = src.indexOf('>', destStart + 1)
      if (closeAngle !== -1 && src[closeAngle + 1] === ')') {
        dest = src.slice(destStart + 1, closeAngle).trim()
        destEnd = closeAngle + 2
      }
    } else {
      let pDepth = 1
      for (let j = destStart; j < len; j += 1) {
        const ch = src[j]
        if (ch === '\\') {
          j += 1
          continue
        }
        if (ch === '\n') break
        if (ch === '(') pDepth += 1
        else if (ch === ')') {
          pDepth -= 1
          if (pDepth === 0) {
            dest = src.slice(destStart, j).trim()
            destEnd = j + 1
            break
          }
        }
      }
    }

    if (destEnd !== -1 && dest.length > 0) {
      // Strip optional markdown title `"title"` after whitespace if not a Windows path with spaces
      let cleanDest = dest
      const titleMatch = cleanDest.match(/^(\S+)\s+["'][^"']*["']$/)
      if (titleMatch) cleanDest = titleMatch[1]

      results.push({
        isImage,
        start,
        end: destEnd,
        label: src.slice(bracketOpen + 1, bracketClose),
        dest: cleanDest,
      })
      i = destEnd
    } else {
      i += 1
    }
  }

  return results
}

/**
 * Extract all unique image references mentioned in a message's text
 * (markdown images, markdown image links, file:/// URIs, and raw Windows paths).
 */
export function extractImageRefsFromText(text) {
  const src = String(text || '')
  if (!src) return []

  const seen = new Set()
  const out = []

  const pushRef = (rawRef, label = '') => {
    const clean = String(rawRef || '').trim().replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '')
    if (!clean) return
    const key = normalizeImageKey(clean)
    if (!key || seen.has(key)) return
    seen.add(key)
    const isUrlRef = /^https?:\/\/|^data:|^blob:|^\/api\//i.test(clean) || isRelayUploadTarget(clean)
    out.push({
      path: isUrlRef ? undefined : clean,
      url: isUrlRef ? clean : undefined,
      raw: clean,
      name: label || getImageLabel(clean),
    })
  }

  // 1. Markdown images & markdown links pointing to image files
  const links = scanMarkdownLinks(src)
  for (const item of links) {
    if (item.isImage || isImageTarget(item.dest)) {
      pushRef(item.dest, item.label || getImageLabel(item.dest))
    }
  }

  // Mask out already-parsed markdown link spans so we don't double-match their interior
  let masked = src
  for (let k = links.length - 1; k >= 0; k -= 1) {
    const l = links[k]
    masked = `${masked.slice(0, l.start)}${' '.repeat(l.end - l.start)}${masked.slice(l.end)}`
  }

  // 2. Standalone file:///... image URIs
  const fileUriRe = /file:\/\/\/[^\s"'`<>\]\r\n]+?\.(?:png|jpe?g|webp|gif|bmp|svg|avif)/gi
  let m
  while ((m = fileUriRe.exec(masked)) !== null) {
    pushRef(m[0])
  }

  // 3. Backticked or quoted Windows absolute image paths (supports spaces & Chinese & (1))
  const quotedWinRe = /[`"']([A-Za-z]:[\\/][^`"'<>\r\n]+?\.(?:png|jpe?g|webp|gif|bmp|svg|avif))[`"']/gi
  while ((m = quotedWinRe.exec(masked)) !== null) {
    pushRef(m[1])
  }

  // 4. Plain Windows absolute image paths in prose (no newlines/quotes/brackets)
  const plainWinRe = /([A-Za-z]:[\\/][^\s`"'<>|*?\[\]\r\n]+?\.(?:png|jpe?g|webp|gif|bmp|svg|avif))/gi
  while ((m = plainWinRe.exec(masked)) !== null) {
    pushRef(m[1])
  }

  return out
}
