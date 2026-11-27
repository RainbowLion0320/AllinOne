import { scanMarkdownLinks, stripQueryHash } from './imageUrls.js'

const DELIVERABLE_EXT_RE = /\.(html?|pdf|docx?|xlsx?|csv|pptx?|md|markdown|txt|rtf|epub|zip)$/i
const HIGH_SIGNAL_EXT_RE = /\.(html?|pdf|docx?|xlsx?|csv|pptx?|rtf|epub|zip)$/i
const LOW_SIGNAL_TEXT_NAMES = new Set([
  'readme.md',
  'claude.md',
  'agents.md',
  'skill.md',
  'changelog.md',
  'contributing.md',
  'code_of_conduct.md',
  'security.md',
  'license.md',
  'license.txt',
  'requirements.txt',
  'robots.txt',
  'cmakelists.txt',
  'todo.md',
  'notes.md',
])

const IGNORED_PATH_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.venv',
  '__pycache__',
])

const DELIVERABLE_META = {
  html: { kind: 'html', badge: 'HTML', previewable: true, tone: 'amber' },
  htm: { kind: 'html', badge: 'HTML', previewable: true, tone: 'amber' },
  pdf: { kind: 'pdf', badge: 'PDF', previewable: false, tone: 'rose' },
  doc: { kind: 'word', badge: 'WORD', previewable: false, tone: 'blue' },
  docx: { kind: 'word', badge: 'WORD', previewable: false, tone: 'blue' },
  xls: { kind: 'excel', badge: 'EXCEL', previewable: false, tone: 'emerald' },
  xlsx: { kind: 'excel', badge: 'EXCEL', previewable: false, tone: 'emerald' },
  csv: { kind: 'excel', badge: 'CSV', previewable: false, tone: 'emerald' },
  ppt: { kind: 'ppt', badge: 'PPT', previewable: false, tone: 'orange' },
  pptx: { kind: 'ppt', badge: 'PPT', previewable: false, tone: 'orange' },
  md: { kind: 'text', badge: 'MD', previewable: false, tone: 'indigo' },
  markdown: { kind: 'text', badge: 'MD', previewable: false, tone: 'indigo' },
  txt: { kind: 'text', badge: 'TXT', previewable: false, tone: 'slate' },
  rtf: { kind: 'word', badge: 'RTF', previewable: false, tone: 'blue' },
  epub: { kind: 'text', badge: 'EPUB', previewable: false, tone: 'indigo' },
  zip: { kind: 'archive', badge: 'ZIP', previewable: false, tone: 'violet' },
}

function cleanFileTarget(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  if (
    (s.startsWith('<') && s.endsWith('>')) ||
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('`') && s.endsWith('`'))
  ) {
    s = s.slice(1, -1).trim()
  }
  // Strip trailing sentence punctuation that might cling to prose paths
  s = s.replace(/[.,;:!?。，；：！？）】》]+$/, '').trim()
  return s
}

function isRemoteHttpUrl(raw) {
  return /^(?:https?:\/\/|mailto:|tel:|data:|blob:|[a-z]:\/\/)/i.test(String(raw || '').trim())
}

function getDeliverableExt(raw) {
  const clean = stripQueryHash(cleanFileTarget(raw))
  const m = clean.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : ''
}

export function isDeliverableTarget(raw) {
  const clean = cleanFileTarget(raw)
  if (!clean || isRemoteHttpUrl(clean)) return false
  const stripped = stripQueryHash(clean)
  if (!DELIVERABLE_EXT_RE.test(stripped)) return false
  // Must look like a local path or file URI (not just a bare word like "foo.md" unless explicitly linked)
  return true
}

export function getDeliverableMeta(raw) {
  const ext = getDeliverableExt(raw)
  return (
    DELIVERABLE_META[ext] || {
      kind: 'file',
      badge: (ext || 'FILE').toUpperCase(),
      previewable: false,
      tone: 'slate',
    }
  )
}

export function getDeliverableName(raw, fallback = 'document') {
  const clean = stripQueryHash(cleanFileTarget(raw))
  if (!clean) return fallback
  const parts = clean.split(/[\\/]/).filter(Boolean)
  const last = parts[parts.length - 1] || fallback
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function formatShortPath(raw) {
  const clean = stripQueryHash(cleanFileTarget(raw))
    .replace(/^file:\/\/(?:localhost)?/i, '')
  let decoded = clean
  try {
    decoded = decodeURIComponent(clean)
  } catch {}
  if (decoded.length <= 54) return decoded
  const parts = decoded.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return decoded
  return `…/${parts.slice(-3).join('/')}`
}

export function normalizeDeliverableKey(raw) {
  let clean = stripQueryHash(cleanFileTarget(raw))
  if (!clean) return ''
  clean = clean.replace(/^file:\/\/(?:localhost)?/i, '')
  try {
    clean = decodeURIComponent(clean)
  } catch {}
  return clean.replace(/\\/g, '/').replace(/^\/([a-z]:)/i, '$1').toLowerCase()
}

function hasIgnoredSegment(rawPath) {
  const norm = String(rawPath || '').replace(/\\/g, '/').toLowerCase()
  const parts = norm.split('/').filter(Boolean)
  return parts.some((seg) => IGNORED_PATH_SEGMENTS.has(seg))
}

function looksLikeExplicitPath(raw) {
  const s = cleanFileTarget(raw)
  if (!s || isRemoteHttpUrl(s)) return false
  if (/^file:\/\//i.test(s)) return true
  if (/^~[\\/]/.test(s)) return true
  if (/^[A-Za-z]:[\\/]/.test(s)) return true
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return true
  if (s.includes('/') || s.includes('\\')) return true
  return false
}

function shouldKeepDeliverable(raw, { fromMarkdownLink = false, fromToolWrite = false } = {}) {
  const clean = stripQueryHash(cleanFileTarget(raw))
  if (!clean || isRemoteHttpUrl(clean)) return false
  if (!DELIVERABLE_EXT_RE.test(clean)) return false
  if (hasIgnoredSegment(clean)) return false

  const name = getDeliverableName(clean).toLowerCase()
  if (!name || name.startsWith('.')) return false

  const isHighSignal = HIGH_SIGNAL_EXT_RE.test(clean)
  if (isHighSignal) {
    // Avoid picking up generic build output index.html unless explicitly linked or written by tool
    if (name === 'index.html' && !fromMarkdownLink && !fromToolWrite) {
      const norm = clean.replace(/\\/g, '/').toLowerCase()
      if (norm.includes('/dist/') || norm.includes('/build/') || norm.includes('/public/')) {
        return false
      }
    }
    return true
  }

  // For .md / .markdown / .txt: suppress common repository boilerplate docs unless explicitly linked as file://
  if (LOW_SIGNAL_TEXT_NAMES.has(name)) {
    return false
  }
  if (fromMarkdownLink) return true
  // Allow absolute paths in user deliverable directories (Desktop / Downloads / Documents / brain / tmp)
  const norm = clean.replace(/\\/g, '/').toLowerCase()
  if (
    norm.includes('/desktop/') ||
    norm.includes('/downloads/') ||
    norm.includes('/documents/') ||
    norm.includes('/.gemini/antigravity/brain/') ||
    norm.startsWith('/tmp/') ||
    norm.startsWith('~/desktop/') ||
    norm.startsWith('~/downloads/') ||
    norm.startsWith('~/documents/')
  ) {
    return true
  }
  return false
}

/**
 * Extract unique local deliverable file references from an assistant message (text + tool calls).
 * Never fetches bytes; returns lightweight metadata cards for on-demand E2EE download / preview.
 */
export function extractDeliverableRefsFromMessage(msg, { maxItems = 12 } = {}) {
  if (!msg) return []
  const src = String(msg.text || '')
  const tools = Array.isArray(msg.tools) ? msg.tools : []
  if (!src && tools.length === 0) return []

  const seen = new Set()
  const out = []

  const pushRef = (rawRef, label = '', opts = {}) => {
    if (out.length >= maxItems) return
    const cleaned = cleanFileTarget(rawRef)
    if (!cleaned || isRemoteHttpUrl(cleaned)) return
    // Strip markdown line-range anchors like #L10-L20 when targeting a downloadable file
    const pathWithoutAnchor = stripQueryHash(cleaned)
    if (!looksLikeExplicitPath(pathWithoutAnchor) && !opts.allowBareName) return
    if (!shouldKeepDeliverable(pathWithoutAnchor, opts)) return

    const key = normalizeDeliverableKey(pathWithoutAnchor)
    if (!key || seen.has(key)) return
    seen.add(key)

    const filename = getDeliverableName(pathWithoutAnchor)
    const cleanLabel = String(label || '').trim()
    const displayName =
      cleanLabel &&
      cleanLabel.length <= 80 &&
      !cleanLabel.includes('\n') &&
      !/^https?:\/\//i.test(cleanLabel) &&
      DELIVERABLE_EXT_RE.test(cleanLabel)
        ? cleanLabel
        : filename

    const meta = getDeliverableMeta(pathWithoutAnchor)
    out.push({
      key,
      path: pathWithoutAnchor,
      name: displayName,
      filename,
      shortPath: formatShortPath(pathWithoutAnchor),
      ext: getDeliverableExt(pathWithoutAnchor),
      ...meta,
    })
  }

  // 1. Markdown links: [report.xlsx](file:///Users/.../report.xlsx) or [Deck](./output/q4.pptx)
  const links = scanMarkdownLinks(src)
  for (const item of links) {
    if (item.isImage) continue
    if (isDeliverableTarget(item.dest)) {
      pushRef(item.dest, item.label, { fromMarkdownLink: true, allowBareName: true })
    }
  }

  // Mask out already-parsed markdown links & remote http(s) URLs so regex scans never misparse `https://` as `s:/`
  let masked = src
  for (let k = links.length - 1; k >= 0; k -= 1) {
    const l = links[k]
    masked = `${masked.slice(0, l.start)}${' '.repeat(l.end - l.start)}${masked.slice(l.end)}`
  }
  masked = masked.replace(/(?:https?|ftp|mailto|tel):\/\/[^\s"'`<>\]\r\n]+/gi, (hit) => ' '.repeat(hit.length))

  // 2. Standalone file:///... deliverable URIs
  const fileUriRe = /file:\/\/\/[^\s"'`<>\]\r\n]+?\.(?:html?|pdf|docx?|xlsx?|csv|pptx?|md|markdown|txt|rtf|epub|zip)(?:#[^\s"'`<>\]\r\n]*)?/gi
  let m
  while ((m = fileUriRe.exec(masked)) !== null) {
    pushRef(m[0], '', { fromMarkdownLink: true })
  }

  // 3. Backticked or quoted paths (macOS/Linux absolute, ~/, Windows C:\..., or relative paths with /)
  const quotedPathRe = /[`"']((?:(?:[A-Za-z]:[\\/])|(?:~[\\/])|(?:\.{0,2}\/)|(?:[A-Za-z0-9_\u4e00-\u9fff.-]+[\\/]))[^`"'<>\r\n]+?\.(?:html?|pdf|docx?|xlsx?|csv|pptx?|md|markdown|txt|rtf|epub|zip))[`"']/gi
  while ((m = quotedPathRe.exec(masked)) !== null) {
    pushRef(m[1])
  }

  // 4. Plain Windows absolute paths in prose (must not be preceded by a letter/digit, e.g. `https://`)
  const plainWinRe = /(?<![A-Za-z0-9_])([A-Za-z]:[\\/](?!\/)[^\s`"'<>|*?[\]\r\n]+?\.(?:html?|pdf|docx?|xlsx?|csv|pptx?|md|markdown|txt|rtf|epub|zip))/gi
  while ((m = plainWinRe.exec(masked)) !== null) {
    pushRef(m[1])
  }

  // 5. Plain Unix absolute paths in common user/output roots or ~/...
  const plainUnixRe = /((?:~\/|\/(?:Users|home|tmp|var|opt|mnt|Volumes|private\/tmp)\/)[^\s`"'<>()[\]，。；：！？\r\n]+?\.(?:html?|pdf|docx?|xlsx?|csv|pptx?|md|markdown|txt|rtf|epub|zip))/gi
  while ((m = plainUnixRe.exec(masked)) !== null) {
    pushRef(m[1])
  }

  // 6. High-signal deliverable paths written by file-creation tools in this assistant turn
  const WRITE_TOOL_RE = /^(?:write|write_file|create_file|save_file|file_change|edit|edit_file|apply_patch|notebookedit)$/i
  for (const tool of tools) {
    if (!tool || tool.status === 'error') continue
    const toolName = String(tool.name || '').trim()
    if (!WRITE_TOOL_RE.test(toolName)) continue
    const inp = tool.input
    if (inp && typeof inp === 'object') {
      const candidates = [inp.path, inp.Path, inp.file_path, inp.filePath, inp.TargetFile, inp.target_file]
      for (const c of candidates) {
        if (typeof c === 'string' && HIGH_SIGNAL_EXT_RE.test(stripQueryHash(c))) {
          pushRef(c, '', { fromToolWrite: true })
        }
      }
    }
  }

  return out
}
