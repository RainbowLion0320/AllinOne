import { statSync } from 'node:fs'

const MAX_TOOL_INPUT_CHARS = 320
const MAX_TOOL_OUTPUT_CHARS = 450
const MAX_THINKING_CHARS = 2400
const MAX_TOOLS_PER_TURN = 32

function truncateText(val, maxLen) {
  const s = String(val ?? '')
  if (s.length <= maxLen) return s
  return `${s.slice(0, maxLen)}…`
}

/**
 * Compact a tool call record for mobile history pagination so tool-heavy autonomous runs
 * stay lightweight (~10-25KB/page instead of >1MB/page) without losing tool visibility.
 */
export function compactTool(tool) {
  if (!tool || typeof tool !== 'object') return null
  let input = tool.input
  if (typeof input === 'string') {
    input = truncateText(input, MAX_TOOL_INPUT_CHARS)
  } else if (input && typeof input === 'object') {
    if (typeof input.command === 'string') {
      input = {
        command: truncateText(input.command, MAX_TOOL_INPUT_CHARS),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }
    } else if (typeof input.path === 'string') {
      input = { path: truncateText(input.path, MAX_TOOL_INPUT_CHARS) }
    } else {
      try {
        const serialized = JSON.stringify(input)
        if (serialized.length > MAX_TOOL_INPUT_CHARS) {
          input = truncateText(serialized, MAX_TOOL_INPUT_CHARS)
        }
      } catch {
        input = ''
      }
    }
  }

  return {
    id: tool.id,
    name: tool.name || 'tool',
    input: input ?? {},
    status: tool.status || 'completed',
    output: tool.output ? truncateText(tool.output, MAX_TOOL_OUTPUT_CHARS) : '',
  }
}

function mergeUniqueTools(listA = [], listB = []) {
  const seen = new Set()
  const out = []
  for (const raw of [...listA, ...listB]) {
    if (!raw) continue
    const key = raw.id || `${raw.name}-${out.length}`
    if (seen.has(key)) continue
    seen.add(key)
    const c = compactTool(raw)
    if (c) out.push(c)
  }
  return out
}

function mergeUniqueImages(listA = [], listB = []) {
  const seen = new Set()
  const out = []
  for (const img of [...listA, ...listB]) {
    if (!img) continue
    const key = String(img.url || img.path || '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(img)
  }
  return out
}

/**
 * Merge consecutive assistant steps (e.g. 15 consecutive tool-only steps) into ONE clean
 * visual assistant turn BEFORE paginating, and compact oversized tool/thinking payloads.
 */
export function mergeAndCompactMessages(rawMessages = []) {
  const merged = []
  for (const msg of rawMessages) {
    if (!msg) continue
    const prev = merged[merged.length - 1]
    const msgBranch = msg.branchEpoch ?? 0
    if (
      msg.role === 'assistant' &&
      prev &&
      prev.role === 'assistant' &&
      (prev._branchEpoch ?? 0) === msgBranch
    ) {
      if (msg.thinking) {
        prev.thinking = prev.thinking ? `${prev.thinking}\n\n${msg.thinking}` : msg.thinking
      }
      if (msg.text) {
        prev.text = prev.text ? `${prev.text}\n\n${msg.text}` : msg.text
      }
      if (Array.isArray(msg.tools) && msg.tools.length > 0) {
        prev._allTools.push(...msg.tools)
      }
      if (Array.isArray(msg.images) && msg.images.length > 0) {
        prev._images = mergeUniqueImages(prev._images, msg.images)
      }
      prev.ts = msg.ts || prev.ts
    } else {
      merged.push({
        id: msg.id,
        role: msg.role,
        text: msg.text || '',
        thinking: msg.thinking || '',
        _allTools: Array.isArray(msg.tools) ? [...msg.tools] : [],
        _images: Array.isArray(msg.images) ? [...msg.images] : [],
        _branchEpoch: msgBranch,
        ts: msg.ts || 0,
      })
    }
  }

  return merged.map((m) => {
    const out = {
      id: m.id,
      role: m.role,
      text: m.text,
      ts: m.ts,
    }
    if (m.thinking) {
      out.thinking = truncateText(m.thinking, MAX_THINKING_CHARS)
    }
    if (m._allTools.length > 0) {
      const deduped = mergeUniqueTools([], m._allTools)
      out.toolCount = deduped.length
      out.tools =
        deduped.length > MAX_TOOLS_PER_TURN
          ? [...deduped.slice(0, 6), ...deduped.slice(-(MAX_TOOLS_PER_TURN - 6))]
          : deduped
    }
    if (m._images.length > 0) {
      out.images = m._images
    }
    return out
  })
}

/**
 * Small stat-validated LRU cache for parsed local session files (JSONL / JSON).
 * Makes page 2, 3, 4... backward pagination ~0.05ms with zero repeated disk reads.
 */
export function createFileParseCache(maxEntries = 12) {
  const map = new Map() // filePath -> { mtimeMs, size, value }

  return {
    getOrParse(filePath, parserFn) {
      let st
      try {
        st = statSync(filePath)
      } catch {
        return parserFn()
      }
      const cached = map.get(filePath)
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        map.delete(filePath)
        map.set(filePath, cached)
        return cached.value
      }
      const value = parserFn()
      map.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, value })
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value
        if (!oldest) break
        map.delete(oldest)
      }
      return value
    },
  }
}
