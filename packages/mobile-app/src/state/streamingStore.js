import { useCallback, useSyncExternalStore } from 'react'

/**
 * External high-frequency streaming store driven by React's `useSyncExternalStore`.
 *
 * Isolates live token deltas (`STREAM_DELTA`, `STREAM_THINKING`) from `App.jsx` and
 * `ChatView.jsx`: only the active leaf `<StreamingAssistantTurn>` subscribes to text
 * updates, coalesced to at most 1 notification per animation frame (~16–33ms).
 */

const entries = new Map()
const sessionListeners = new Map() // sid -> Set<fn>
const activeListeners = new Map() // sid -> Set<fn>
const dirtySessions = new Set()
let flushHandle = null
let flushIsRaf = false

function emitSession(sid) {
  const set = sessionListeners.get(sid)
  if (!set || set.size === 0) return
  for (const fn of [...set]) {
    try { fn() } catch {}
  }
}

function emitActive(sid) {
  const set = activeListeners.get(sid)
  if (!set || set.size === 0) return
  for (const fn of [...set]) {
    try { fn() } catch {}
  }
}

function flushDirtyNow() {
  if (flushHandle !== null) {
    if (flushIsRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(flushHandle)
    } else {
      clearTimeout(flushHandle)
    }
    flushHandle = null
    flushIsRaf = false
  }
  if (dirtySessions.size === 0) return
  const pending = [...dirtySessions]
  dirtySessions.clear()
  for (const sid of pending) {
    emitSession(sid)
  }
}

function scheduleFlush(sid) {
  dirtySessions.add(sid)
  if (flushHandle !== null) return
  if (typeof requestAnimationFrame === 'function') {
    flushIsRaf = true
    flushHandle = requestAnimationFrame(() => {
      flushHandle = null
      flushIsRaf = false
      flushDirtyNow()
    })
  } else {
    flushIsRaf = false
    flushHandle = setTimeout(() => {
      flushHandle = null
      flushDirtyNow()
    }, 32)
  }
}

function normalizeBase(raw, now) {
  return {
    active: true,
    text: typeof raw?.text === 'string' ? raw.text : '',
    thinking: typeof raw?.thinking === 'string' ? raw.thinking : '',
    tools: Array.isArray(raw?.tools) ? raw.tools : [],
    error: '',
    startedAt: Number(raw?.startedAt) || now,
    lastDeltaAt: now,
  }
}

export function getRawStream(sid) {
  if (!sid) return null
  return entries.get(sid) || null
}

export function isStreamActive(sid) {
  if (!sid) return false
  return Boolean(entries.get(sid)?.active)
}

export function isStaleStreamForIdle(sid, thresholdMs = 3_000) {
  if (!sid) return false
  const entry = entries.get(sid)
  if (!entry?.active) return false
  const lastActivity = Number(entry.lastDeltaAt || entry.startedAt || 0)
  return Date.now() - lastActivity >= thresholdMs
}

export function startStream(sid) {
  if (!sid) return null
  const wasActive = Boolean(entries.get(sid)?.active)
  const now = Date.now()
  const entry = {
    active: true,
    text: '',
    thinking: '',
    tools: [],
    error: '',
    startedAt: now,
    lastDeltaAt: now,
  }
  entries.set(sid, entry)
  dirtySessions.delete(sid)
  emitSession(sid)
  if (!wasActive) emitActive(sid)
  return entry
}

export function appendStreamDelta(sid, delta) {
  if (!sid) return null
  const wasActive = Boolean(entries.get(sid)?.active)
  const now = Date.now()
  const cur = normalizeBase(entries.get(sid), now)
  const next = {
    ...cur,
    text: cur.text + (delta || ''),
  }
  entries.set(sid, next)
  if (!wasActive) {
    dirtySessions.delete(sid)
    emitSession(sid)
    emitActive(sid)
  } else {
    scheduleFlush(sid)
  }
  return next
}

export function appendStreamThinking(sid, delta) {
  if (!sid) return null
  const wasActive = Boolean(entries.get(sid)?.active)
  const now = Date.now()
  const cur = normalizeBase(entries.get(sid), now)
  const next = {
    ...cur,
    thinking: cur.thinking + (delta || ''),
  }
  entries.set(sid, next)
  if (!wasActive) {
    dirtySessions.delete(sid)
    emitSession(sid)
    emitActive(sid)
  } else {
    scheduleFlush(sid)
  }
  return next
}

export function streamToolStart(sid, tool) {
  if (!sid || !tool) return null
  const wasActive = Boolean(entries.get(sid)?.active)
  const now = Date.now()
  const cur = normalizeBase(entries.get(sid), now)
  const exists = cur.tools.some((t) => t.id === tool.id)
  const tools = exists ? cur.tools : [...cur.tools, { ...tool, status: 'running', output: '' }]
  const next = { ...cur, tools }
  entries.set(sid, next)
  dirtySessions.delete(sid)
  emitSession(sid)
  if (!wasActive) emitActive(sid)
  return next
}

export function streamToolEnd(sid, toolId, status = 'completed', output = '') {
  if (!sid || !toolId) return null
  const prevRaw = entries.get(sid)
  const wasActive = Boolean(prevRaw?.active)
  const now = Date.now()
  const cur = normalizeBase(prevRaw, now)
  const tools = cur.tools.map((t) =>
    t.id === toolId ? { ...t, status: status || 'completed', output: output || '' } : t,
  )
  const nextActive = prevRaw?.active ?? true
  const next = { ...cur, active: nextActive, tools }
  entries.set(sid, next)
  dirtySessions.delete(sid)
  emitSession(sid)
  if (wasActive !== nextActive) emitActive(sid)
  return next
}

export function failStream(sid, errorMessage, { keepPartial = true } = {}) {
  if (!sid) return null
  const prevRaw = entries.get(sid)
  const wasActive = Boolean(prevRaw?.active)
  const next = {
    active: false,
    text: keepPartial && typeof prevRaw?.text === 'string' ? prevRaw.text : '',
    thinking: keepPartial && typeof prevRaw?.thinking === 'string' ? prevRaw.thinking : '',
    tools: keepPartial && Array.isArray(prevRaw?.tools) ? prevRaw.tools : [],
    error: String(errorMessage || ''),
  }
  entries.set(sid, next)
  dirtySessions.delete(sid)
  emitSession(sid)
  if (wasActive) emitActive(sid)
  return next
}

export function finishStream(sid) {
  if (!sid) return null
  const cur = entries.get(sid) || null
  const wasActive = Boolean(cur?.active)
  entries.delete(sid)
  dirtySessions.delete(sid)
  emitSession(sid)
  if (wasActive) emitActive(sid)
  return cur
}

export function clearStream(sid) {
  if (!sid || !entries.has(sid)) return
  const wasActive = Boolean(entries.get(sid)?.active)
  entries.delete(sid)
  dirtySessions.delete(sid)
  emitSession(sid)
  if (wasActive) emitActive(sid)
}

export function clearAllStreams() {
  if (entries.size === 0 && dirtySessions.size === 0) return
  const sids = [...new Set([...entries.keys(), ...dirtySessions])]
  entries.clear()
  dirtySessions.clear()
  if (flushHandle !== null) {
    if (flushIsRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(flushHandle)
    } else {
      clearTimeout(flushHandle)
    }
    flushHandle = null
    flushIsRaf = false
  }
  for (const sid of sids) {
    emitSession(sid)
    emitActive(sid)
  }
}

export function subscribeStream(sid, listener) {
  if (!sid || typeof listener !== 'function') return () => {}
  let set = sessionListeners.get(sid)
  if (!set) {
    set = new Set()
    sessionListeners.set(sid, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) sessionListeners.delete(sid)
  }
}

export function subscribeStreamActive(sid, listener) {
  if (!sid || typeof listener !== 'function') return () => {}
  let set = activeListeners.get(sid)
  if (!set) {
    set = new Set()
    activeListeners.set(sid, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) activeListeners.delete(sid)
  }
}

export function useSessionStream(sid) {
  const subscribe = useCallback(
    (onStoreChange) => (sid ? subscribeStream(sid, onStoreChange) : () => {}),
    [sid],
  )
  const getSnapshot = useCallback(() => (sid ? entries.get(sid) || null : null), [sid])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSessionStreamingActive(sid) {
  const subscribe = useCallback(
    (onStoreChange) => (sid ? subscribeStreamActive(sid, onStoreChange) : () => {}),
    [sid],
  )
  const getSnapshot = useCallback(() => Boolean(sid && entries.get(sid)?.active), [sid])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
