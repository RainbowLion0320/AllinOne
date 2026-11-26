import { bi, getCurrentLang } from './i18n.js'

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif|ico)$/i

function extractTargetString(raw) {
  if (!raw) return ''
  if (typeof raw === 'object') {
    const rawUrl = String(raw.url || '').trim()
    const rawPath = String(raw.path || '').trim()
    const rawFallback = String(raw.raw || '').trim()
    return (rawUrl || rawPath || rawFallback).replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
  }
  return String(raw).trim().replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
}

export function isExternalHttpImageUrl(raw) {
  const target = extractTargetString(raw)
  if (!target) return false
  return /^https?:\/\//i.test(target)
}

function isPrivateIpv4Octets(a, b, c, d) {
  if (
    !Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c) || !Number.isInteger(d) ||
    a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255
  ) {
    return true
  }
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

export function isPrivateOrLoopbackUrl(raw) {
  const target = extractTargetString(raw)
  if (!target) return true
  let u
  try {
    u = new URL(target)
  } catch {
    return true
  }
  if (u.protocol !== 'https:') return true
  const rawHost = String(u.hostname || '').trim().toLowerCase().replace(/\.$/, '')
  if (!rawHost) return true
  if (rawHost === 'localhost' || rawHost.endsWith('.localhost') || rawHost.endsWith('.local')) {
    return true
  }
  if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
    const ip6 = rawHost.slice(1, -1).split('%')[0].toLowerCase()
    if (!ip6 || ip6 === '::' || ip6 === '::1') return true
    if (/^(?:0+:){7}0*[01]$/.test(ip6)) return true
    if (/^fe[89ab][0-9a-f]:/.test(ip6)) return true
    if (/^f[cd][0-9a-f]{2}:/.test(ip6)) return true
    const mappedDot = ip6.match(/^(?:::ffff:|0:0:0:0:0:ffff:|::)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (mappedDot) {
      return isPrivateIpv4Octets(
        Number(mappedDot[1]),
        Number(mappedDot[2]),
        Number(mappedDot[3]),
        Number(mappedDot[4]),
      )
    }
    const mappedHex = ip6.match(/^(?:::ffff:|0:0:0:0:0:ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16)
      const lo = parseInt(mappedHex[2], 16)
      return isPrivateIpv4Octets((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff)
    }
    return false
  }
  const ipv4 = rawHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    return isPrivateIpv4Octets(
      Number(ipv4[1]),
      Number(ipv4[2]),
      Number(ipv4[3]),
      Number(ipv4[4]),
    )
  }
  return false
}

export function stripQueryHash(raw) {
  return String(raw || '').split(/[?#]/)[0]
}

export function isImageTarget(raw) {
  const s = String(raw || '').trim()
  if (!s) return false
  const compact = s.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  if (compact.startsWith('data:image/svg+xml')) return false
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

  const compact = target.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  if (compact.startsWith('data:image/svg+xml')) {
    return ''
  }

  if (/^data:image\//i.test(target) || /^blob:/i.test(target)) {
    return target
  }

  // External direct HTTP(S) URL
  if (/^https?:\/\//i.test(target)) {
    return target
  }

  // Local PC file paths are exclusively loaded via P2P E2EE RPC.FILE_READ (see e2eeMedia.js)
  return ''
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
    const isUrlRef = /^https?:\/\/|^data:|^blob:/i.test(clean)
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

  // 2. Standalone file:///... image URIs (mask matched spans so step 4 never re-matches `e:///...`)
  const fileUriRe = /file:\/\/\/[^\s"'`<>\]\r\n]+?\.(?:png|jpe?g|webp|gif|bmp|svg|avif)/gi
  const fileUriSpans = []
  let m
  while ((m = fileUriRe.exec(masked)) !== null) {
    pushRef(m[0])
    fileUriSpans.push({ start: m.index, end: m.index + m[0].length })
  }
  for (let k = fileUriSpans.length - 1; k >= 0; k -= 1) {
    const s = fileUriSpans[k]
    masked = `${masked.slice(0, s.start)}${' '.repeat(s.end - s.start)}${masked.slice(s.end)}`
  }

  // Mask http(s):// URLs so `https://...png` never matches `s://...png` as a Windows drive path
  masked = masked.replace(/https?:\/\/[^\s"'`<>\]\r\n]+/gi, (seg) => ' '.repeat(seg.length))

  // 3. Backticked or quoted Windows absolute image paths (supports spaces & Chinese & (1))
  const quotedWinRe = /[`"']([A-Za-z]:[\\/](?!\/)[^`"'<>\r\n]+?\.(?:png|jpe?g|webp|gif|bmp|svg|avif))[`"']/gi
  while ((m = quotedWinRe.exec(masked)) !== null) {
    pushRef(m[1])
  }

  // 4. Plain Windows absolute image paths in prose (no newlines/quotes/brackets)
  const plainWinRe = /(?<![A-Za-z0-9_])([A-Za-z]:[\\/](?!\/)[^\s`"'<>|*?\[\]\r\n]+?\.(?:png|jpe?g|webp|gif|bmp|svg|avif))/gi
  while ((m = plainWinRe.exec(masked)) !== null) {
    pushRef(m[1])
  }

  return out
}
