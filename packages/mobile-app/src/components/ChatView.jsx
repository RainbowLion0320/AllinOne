import React, { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Folder,
  History,
  Info,
  Loader2,
  Terminal,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import { extractImageRefsFromText, normalizeImageKey } from '../lib/imageUrls.js'
import { extractDeliverableRefsFromMessage } from '../lib/deliverableFiles.js'
import { ChatImageGallery } from './ChatImageGallery.jsx'
import { ChatDeliverableList } from './ChatDeliverableList.jsx'
import { VendorBadge } from './VendorIcon.jsx'
import { HomeQuotaDashboard } from './HomeQuotaDashboard.jsx'
import { InteractivePromptCard } from './InteractivePromptCard.jsx'
import { TaskStateBar } from './TaskStateBar.jsx'
import { useI18n } from '../lib/i18n.jsx'
import { bi as biLang } from '../lib/i18n.js'
import { clearStreamError, useSessionStream, useSessionStreamingActive } from '../state/streamingStore.js'
import { SectionErrorBoundary } from './SectionErrorBoundary.jsx'

const LazyMarkdownView = React.lazy(() =>
  import('../lib/markdown.jsx').then((m) => ({ default: m.MarkdownView })),
)

function SafeMarkdown({ text, streaming = false, resetKey = '' }) {
  if (!text) return null
  return (
    <SectionErrorBoundary name="markdown" compact resetKey={resetKey}>
      <Suspense
        fallback={
          <div className="min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[15px] leading-[1.72] text-slate-800 dark:text-slate-100">
            {text}
          </div>
        }
      >
        <LazyMarkdownView text={text} streaming={streaming} />
      </Suspense>
    </SectionErrorBoundary>
  )
}

function ThinkingBlock({ text, streaming }) {
  const { bi } = useI18n()
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 transition-all duration-150 hover:bg-slate-200/80 active:scale-[0.98] dark:bg-[#232630] dark:text-slate-300"
      >
        <Brain className="h-3.5 w-3.5 text-[#4D6BFE]" />
        <span>{streaming ? bi('深度思考中...', 'Thinking...') : bi('已深度思考', 'Thought process')}</span>
        <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="animate-reveal-down mt-2 border-l-2 border-slate-200 pl-3 text-[13px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {text}
        </div>
      )}
    </div>
  )
}

function ToolCallDetailRow({ tool }) {
  const { bi } = useI18n()
  const [open, setOpen] = useState(false)
  const isOrchestratorTool = String(tool.name || '').startsWith('allinone_')

  const inputSummary = (() => {
    if (!tool.input) return ''
    if (typeof tool.input === 'string') return tool.input
    if (tool.input.command) return tool.input.command
    if (tool.input.app && tool.input.prompt) return `[${tool.input.app}] ${tool.input.prompt}`
    if (tool.input.id) return tool.input.id
    return JSON.stringify(tool.input)
  })()

  return (
    <div className="border-t border-slate-200/60 first:border-t-0 dark:border-slate-700/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-slate-100/60 dark:hover:bg-slate-800/40"
      >
        {tool.status === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#4D6BFE]" />
        ) : tool.status === 'error' ? (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
        ) : isOrchestratorTool ? (
          <Cpu className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE]" />
        ) : tool.name === 'command' ? (
          <Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        )}

        <span className="shrink-0 font-semibold text-slate-700 dark:text-slate-200">
          {isOrchestratorTool ? `${bi('总控', 'Dispatch')} · ${tool.name.replace('allinone_', '')}` : tool.name}
        </span>
        <span className="flex-1 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
          {inputSummary.slice(0, 80)}
        </span>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="animate-reveal-down space-y-2 bg-slate-50/70 px-3 py-2 font-mono text-[11px] dark:bg-[#16181F]/80">
          {inputSummary && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase text-slate-400">{bi('参数', 'Input')}</div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-slate-700 dark:text-slate-300">
                {typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.output && (
            <div>
              <div className="mb-0.5 text-[10px] font-semibold uppercase text-slate-400">{bi('输出', 'Output')}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-slate-600 dark:text-slate-300">
                {tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function summarizeToolCounts(tools, lang) {
  const counts = new Map()
  for (const t of tools) {
    const raw = String(t.name || 'tool')
    const label = raw.startsWith('allinone_')
      ? biLang(lang, '总控调度', 'dispatch')
      : raw === 'command' || raw === 'Bash' || raw === 'run_command'
        ? biLang(lang, '命令', 'cmd')
        : raw === 'file_change' || raw === 'Edit' || raw === 'Write' || raw === 'edit_file'
          ? biLang(lang, '文件变更', 'edit')
          : raw === 'web_search' || raw === 'WebSearch'
            ? biLang(lang, '搜索', 'search')
            : raw
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  const top = [...counts.entries()].slice(0, 3)
  return top.map(([k, n]) => `${n} ${k}`).join(' · ')
}

/**
 * Collapses ALL tool calls of a turn into ONE sleek, compact pill by default.
 * Users can tap to expand individual tool details only when needed.
 */
function ToolCallsGroup({ tools, totalToolCount = null, streaming = false }) {
  const { lang, bi } = useI18n()
  const [expanded, setExpanded] = useState(false)
  if (!Array.isArray(tools) || tools.length === 0) return null

  const runningTool = tools.find((t) => t.status === 'running')
  const hasError = tools.some((t) => t.status === 'error')
  const hasOrchestrator = tools.some((t) => String(t.name || '').startsWith('allinone_'))
  const doneCount = tools.filter((t) => t.status !== 'running').length
  const summaryText = summarizeToolCounts(tools, lang)
  const displayCount = Math.max(tools.length, Number(totalToolCount || 0))

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition active:scale-[0.98] ${
          hasOrchestrator
            ? 'border-[#4D6BFE]/35 bg-[#F2F5FF] text-[#3552E8] dark:border-[#4D6BFE]/40 dark:bg-[#1E2438] dark:text-[#9AB0FF]'
            : 'border-slate-200/80 bg-slate-100/90 text-slate-600 hover:bg-slate-200/70 dark:border-slate-700/80 dark:bg-[#232630] dark:text-slate-300'
        }`}
      >
        {streaming && runningTool ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#4D6BFE]" />
        ) : hasError ? (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
        ) : hasOrchestrator ? (
          <Cpu className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE]" />
        ) : (
          <Wrench className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        )}

        <span className="truncate">
          {streaming && runningTool
            ? bi(`执行 ${runningTool.name} (${doneCount}/${tools.length})`, `Running ${runningTool.name} (${doneCount}/${tools.length})`)
            : bi(`${displayCount} 次工具 · ${summaryText}`, `${displayCount} tool${displayCount === 1 ? '' : 's'} · ${summaryText}`)}
        </span>

        <ChevronRight className={`h-3.5 w-3.5 shrink-0 opacity-70 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {expanded && (
        <div className="animate-reveal-down mt-2 overflow-hidden rounded-2xl border border-slate-200/80 bg-[#F8FAFC] dark:border-slate-700/80 dark:bg-[#1F222B]">
          {tools.map((t, idx) => (
            <ToolCallDetailRow key={t.id || `tool-${idx}`} tool={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function mergeUniqueImages(listA = [], listB = []) {
  const seen = new Set()
  const out = []
  for (const img of [...listA, ...listB]) {
    if (!img) continue
    const key = normalizeImageKey(img.url || img.path || img.raw || img.localPreviewUrl || img.id || '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(img)
  }
  return out
}

function mergeUniqueTools(listA = [], listB = []) {
  const seen = new Set()
  const out = []
  for (const t of [...listA, ...listB]) {
    if (!t) continue
    const key = t.id || `${t.name}-${out.length}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * Merge consecutive assistant messages (e.g. multiple tool-only steps before final answer)
 * into a single visual assistant turn while preserving referential equality for unchanged
 * historical runs so `React.memo(MessageRow)` never re-renders prior messages on append.
 */
function mergeAssistantRunsStable(messages, prevCache) {
  const raw = messages || []
  const runs = []
  for (const msg of raw) {
    if (!msg) continue
    const lastRun = runs[runs.length - 1]
    if (msg.role === 'assistant' && lastRun && lastRun[0].role === 'assistant') {
      lastRun.push(msg)
    } else {
      runs.push([msg])
    }
  }

  const nextCache = new Map()
  const merged = new Array(runs.length)

  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]
    if (run.length === 1) {
      merged[i] = run[0]
      continue
    }
    const key = run[0].id || `run-${i}`
    const cached = prevCache?.get(key)
    if (
      cached &&
      cached.sources.length === run.length &&
      cached.sources.every((s, idx) => s === run[idx])
    ) {
      merged[i] = cached.merged
      nextCache.set(key, cached)
      continue
    }

    let acc = run[0]
    for (let j = 1; j < run.length; j += 1) {
      const msg = run[j]
      const nextThinking = [acc.thinking, msg.thinking].filter(Boolean).join('\n\n')
      const nextText = [acc.text, msg.text].filter(Boolean).join('\n\n')
      const nextTools = mergeUniqueTools(acc.tools, msg.tools)
      const nextImages = mergeUniqueImages(acc.images, msg.images)
      const prevToolCount = Number(acc.toolCount) || (Array.isArray(acc.tools) ? acc.tools.length : 0)
      const msgToolCount = Number(msg.toolCount) || (Array.isArray(msg.tools) ? msg.tools.length : 0)
      const nextToolCount =
        acc.toolCount != null || msg.toolCount != null
          ? Math.max(nextTools.length, prevToolCount + msgToolCount)
          : undefined
      acc = {
        ...acc,
        text: nextText,
        thinking: nextThinking || undefined,
        tools: nextTools.length > 0 ? nextTools : undefined,
        ...(nextToolCount !== undefined ? { toolCount: nextToolCount } : {}),
        images: nextImages.length > 0 ? nextImages : undefined,
        ts: msg.ts || acc.ts,
      }
    }
    merged[i] = acc
    nextCache.set(key, { sources: run, merged: acc })
  }

  return { merged, nextCache }
}

/**
 * Memoized message row so prepending older pages, live streaming deltas, or transport
 * status changes never re-render already-mounted Markdown trees or image cards.
 */
const MessageRow = React.memo(function MessageRow({ msg, appId, virtualize = false }) {
  const allImages = useMemo(
    () => mergeUniqueImages(msg.images || [], extractImageRefsFromText(msg.text)),
    [msg.images, msg.text],
  )
  const deliverables = useMemo(
    () => (msg.role === 'assistant' ? extractDeliverableRefsFromMessage(msg) : []),
    [msg.role, msg.text, msg.tools],
  )
  const rowClass = virtualize ? 'chat-msg-row ' : ''

  if (msg.role === 'user') {
    return (
      <div data-msg-id={msg.id} className={`${rowClass}flex max-w-full flex-col items-end`}>
        {msg.text && (
          <div className="max-w-[85%] min-w-0 rounded-[22px] rounded-tr-md bg-[#EEF2FF] px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-slate-900 dark:bg-[#2A3454] dark:text-white">
            {msg.text}
          </div>
        )}
        {allImages.length > 0 && (
          <div className="max-w-[85%]">
            <ChatImageGallery images={allImages} compact={true} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-msg-id={msg.id} className={`${rowClass}flex max-w-full items-start gap-2.5`}>
      <VendorBadge app={appId} size="md" className="mt-0.5 shadow-2xs" />
      <div className="min-w-0 flex-1">
        {msg.thinking && <ThinkingBlock text={msg.thinking} streaming={false} />}
        {Array.isArray(msg.tools) && msg.tools.length > 0 && (
          <ToolCallsGroup tools={msg.tools} totalToolCount={msg.toolCount} streaming={false} />
        )}
        <SafeMarkdown text={msg.text} resetKey={msg.id} />
        {allImages.length > 0 && <ChatImageGallery images={allImages} />}
        {deliverables.length > 0 && <ChatDeliverableList files={deliverables} />}
      </div>
    </div>
  )
})

/**
 * Isolated streaming leaf component subscribed directly to `streamingStore`.
 * Receiving high-frequency token deltas ONLY re-renders this leaf instead of `App` + `ChatView`!
 */
const StreamingAssistantTurn = React.memo(function StreamingAssistantTurn({
  sessionId,
  appId,
  scrollRef,
  isNearBottomRef,
  pinnedToBottomRef,
  userInteractedRef,
}) {
  const { bi } = useI18n()
  const stream = useSessionStream(sessionId)

  const streamingImages = useMemo(
    () => (stream?.active && stream?.text ? extractImageRefsFromText(stream.text) : []),
    [stream?.active, stream?.text],
  )

  useEffect(() => {
    const el = scrollRef?.current
    if (!el || !stream?.active) return
    if (isNearBottomRef.current || (pinnedToBottomRef.current && !userInteractedRef.current)) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
      isNearBottomRef.current = true
    }
  }, [stream?.active, stream?.text, stream?.thinking, stream?.tools?.length, scrollRef, isNearBottomRef, pinnedToBottomRef, userInteractedRef])

  if (!stream) return null

  return (
    <>
      {stream.active && (
        <div className="animate-msg-in flex items-start gap-2.5">
          <VendorBadge app={appId || 'dsh'} size="md" active={true} className="mt-0.5 shadow-2xs" />
          <div className="min-w-0 flex-1">
            {stream.thinking && <ThinkingBlock text={stream.thinking} streaming={true} />}
            {stream.tools?.length > 0 && <ToolCallsGroup tools={stream.tools} streaming={true} />}
            {stream.text ? (
              <>
                <SafeMarkdown text={stream.text} streaming={true} resetKey={`${sessionId}:stream`} />
                {streamingImages.length > 0 && <ChatImageGallery images={streamingImages} />}
              </>
            ) : (
              <div className="inline-flex items-center gap-2 py-1 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin text-[#4D6BFE]" />
                <span>{bi('思考中...', 'Thinking...')}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {stream.error && (
        <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{stream.error}</span>
          <button
            type="button"
            onClick={() => clearStreamError(sessionId)}
            aria-label={bi('关闭错误提示', 'Dismiss error')}
            className="shrink-0 rounded-lg p-0.5 text-rose-500/80 transition hover:bg-rose-200/50 hover:text-rose-700 dark:text-rose-300/80 dark:hover:bg-rose-900/50"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  )
})

export const ChatView = React.memo(function ChatView({
  session,
  messages,
  loadingSession,
  hasMoreHistory = false,
  loadingOlder = false,
  olderError = '',
  prependSeq = 0,
  sessionOpenSeq = 0,
  onLoadOlder,
  appsStatus,
  sessions = [],
  activeApp = 'dsh',
  onSelectApp,
  workspaces = [],
  selectedWorkspace = '',
  onSelectWorkspace,
  onOpenNewChatModal,
  bridgeOnline = false,
  refreshingQuotas = false,
  onRefreshQuotas,
  approvals,
  onResolveApproval,
}) {
  const { bi, t } = useI18n()
  const isStreamingActive = useSessionStreamingActive(session?.id || '')
  const scrollRef = useRef(null)
  const contentRef = useRef(null)
  const topSentinelRef = useRef(null)
  const bottomAnchorRef = useRef(null)
  const [pullPx, setPullPx] = useState(0)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [initialScrollReady, setInitialScrollReady] = useState(false)
  const pullPxRef = useRef(0)
  const pullAnchorYRef = useRef(null)
  const loadCooldownRef = useRef(0)
  const autoBackfillCountRef = useRef(0)
  const anchorBeforePrependRef = useRef(null)
  const lastAppliedPrependSeqRef = useRef(0)
  const prevOpenKeyRef = useRef('')
  const prevLastIdRef = useRef(null)
  const prevMsgCountRef = useRef(0)
  const pendingInitialScrollRef = useRef(false)
  const pinnedToBottomRef = useRef(false)
  const pinUntilRef = useRef(0)
  const isNearBottomRef = useRef(true)
  const userInteractedRef = useRef(false)
  const rafIdsRef = useRef({ r1: 0, r2: 0 })

  const cancelPendingRafs = () => {
    if (rafIdsRef.current.r1) cancelAnimationFrame(rafIdsRef.current.r1)
    if (rafIdsRef.current.r2) cancelAnimationFrame(rafIdsRef.current.r2)
    rafIdsRef.current = { r1: 0, r2: 0 }
  }

  useEffect(() => cancelPendingRafs, [])

  const mergedRunCacheRef = useRef(new Map())
  const displayMessages = useMemo(() => {
    const { merged, nextCache } = mergeAssistantRunsStable(messages, mergedRunCacheRef.current)
    mergedRunCacheRef.current = nextCache
    return merged
  }, [messages])

  const captureVisibleAnchor = () => {
    const el = scrollRef.current
    if (!el) return null
    const containerRect = el.getBoundingClientRect()
    const anchors = []
    if (contentRef.current) {
      const nodes = contentRef.current.querySelectorAll('[data-msg-id]')
      for (const node of nodes) {
        const rect = node.getBoundingClientRect()
        if (rect.bottom >= containerRect.top) {
          const msgId = node.getAttribute('data-msg-id') || ''
          if (msgId) anchors.push({ msgId, relTop: rect.top - containerRect.top })
          if (anchors.length >= 3) break
        }
      }
      if (anchors.length === 0 && nodes.length > 0) {
        for (let i = 0; i < Math.min(3, nodes.length); i += 1) {
          const node = nodes[i]
          const msgId = node.getAttribute('data-msg-id') || ''
          if (msgId) anchors.push({ msgId, relTop: node.getBoundingClientRect().top - containerRect.top })
        }
      }
    }
    const snap = {
      anchors,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    }
    anchorBeforePrependRef.current = snap
    return snap
  }

  const scrollToBottomImmediate = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    if (bottomAnchorRef.current) {
      try {
        bottomAnchorRef.current.scrollIntoView({ block: 'end', behavior: 'instant' })
      } catch {
        el.scrollTop = el.scrollHeight
      }
    }
    isNearBottomRef.current = true
    setShowScrollBottom(false)
  }

  const triggerLoadOlder = () => {
    if (pendingInitialScrollRef.current) return
    if (!hasMoreHistory || loadingOlder || loadingSession || !onLoadOlder) return
    const now = Date.now()
    if (now - loadCooldownRef.current < 320) return
    loadCooldownRef.current = now
    captureVisibleAnchor()
    onLoadOlder()
  }

  // Keep a live ref to triggerLoadOlder for IntersectionObserver without re-subscribing constantly
  const triggerLoadOlderRef = useRef(triggerLoadOlder)
  triggerLoadOlderRef.current = triggerLoadOlder

  // 1) IntersectionObserver on top sentinel: ONLY arms after initial bottom-snap settles so switching chats never triggers top fetch!
  useEffect(() => {
    const rootEl = scrollRef.current
    const sentinelEl = topSentinelRef.current
    if (!rootEl || !sentinelEl || !initialScrollReady || !hasMoreHistory || loadingSession || displayMessages.length === 0) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !pendingInitialScrollRef.current) {
          triggerLoadOlderRef.current()
        }
      },
      {
        root: rootEl,
        rootMargin: '260px 0px 0px 0px',
        threshold: 0,
      },
    )
    observer.observe(sentinelEl)
    return () => observer.disconnect()
  }, [session?.id, initialScrollReady, hasMoreHistory, loadingSession, displayMessages.length])

  // 2) Keep pinned to latest message during async layout expansion (cached->fresh sync, images/code blocks settling)
  useEffect(() => {
    const contentEl = contentRef.current
    if (!contentEl || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (userInteractedRef.current) return
      if (pinnedToBottomRef.current && Date.now() <= pinUntilRef.current) {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      }
    })
    ro.observe(contentEl)
    return () => ro.disconnect()
  }, [])

  // 3) Scroll position management: guaranteed bottom snap on session open/switch + exact anchor on prepend
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sessionId = session?.id || null
    const openKey = `${sessionId || ''}:${sessionOpenSeq}`
    const lastId = displayMessages[displayMessages.length - 1]?.id || null
    const count = displayMessages.length

    if (prevOpenKeyRef.current !== openKey) {
      // Newly selected/switched conversation -> arm initial bottom-snap until messages actually render!
      cancelPendingRafs()
      prevOpenKeyRef.current = openKey
      autoBackfillCountRef.current = 0
      anchorBeforePrependRef.current = null
      lastAppliedPrependSeqRef.current = prependSeq
      userInteractedRef.current = false
      pendingInitialScrollRef.current = true
      pinnedToBottomRef.current = true
      pinUntilRef.current = Date.now() + 1400
      isNearBottomRef.current = true
      setInitialScrollReady(false)
      setShowScrollBottom(false)
    }

    if (loadingSession) {
      // Reset initial scroll readiness cleanly whenever loading starts so observer never fires before bottom-snap settles
      cancelPendingRafs()
      pendingInitialScrollRef.current = true
      pinnedToBottomRef.current = true
      pinUntilRef.current = Date.now() + 1400
      isNearBottomRef.current = true
      setInitialScrollReady(false)
      setShowScrollBottom(false)
    } else if (pendingInitialScrollRef.current) {
      if (count > 0 || isStreamingActive) {
        pendingInitialScrollRef.current = false
        pinnedToBottomRef.current = true
        pinUntilRef.current = Date.now() + 1000
        scrollToBottomImmediate()
        // Follow up across 2 animation frames after images/fonts/markdown complete layout
        cancelPendingRafs()
        rafIdsRef.current.r1 = requestAnimationFrame(() => {
          rafIdsRef.current.r1 = 0
          if (!userInteractedRef.current) scrollToBottomImmediate()
          rafIdsRef.current.r2 = requestAnimationFrame(() => {
            rafIdsRef.current.r2 = 0
            if (!userInteractedRef.current) scrollToBottomImmediate()
            setInitialScrollReady(true)
          })
        })
      }
    } else if (prependSeq !== lastAppliedPrependSeqRef.current) {
      // Older messages were prepended -> restore exact visual viewport position via [data-msg-id] anchor (zero jump!)
      lastAppliedPrependSeqRef.current = prependSeq
      pinnedToBottomRef.current = false
      const snap = anchorBeforePrependRef.current
      anchorBeforePrependRef.current = null
      if (snap) {
        let restored = false
        if (Array.isArray(snap.anchors) && contentRef.current) {
          for (const anchor of snap.anchors) {
            const escapedId =
              typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                ? CSS.escape(anchor.msgId)
                : String(anchor.msgId).replace(/["\\]/g, '\\$&')
            const anchorEl = contentRef.current.querySelector(`[data-msg-id="${escapedId}"]`)
            if (anchorEl) {
              const containerRect = el.getBoundingClientRect()
              const nextRelTop = anchorEl.getBoundingClientRect().top - containerRect.top
              const shift = nextRelTop - anchor.relTop
              if (Number.isFinite(shift) && Math.abs(shift) > 0.5) {
                el.scrollTop = Math.max(0, el.scrollTop + shift)
              }
              restored = true
              break
            }
          }
        }
        if (!restored) {
          const delta = el.scrollHeight - snap.scrollHeight
          if (delta > 0) {
            el.scrollTop = snap.scrollTop + delta
          }
        }
      }
    } else if (
      count > 0 &&
      (lastId !== prevLastIdRef.current || (pinnedToBottomRef.current && Date.now() <= pinUntilRef.current))
    ) {
      // Fresh page reconciled with cache or a brand-new message arrived at the bottom
      const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (!userInteractedRef.current && pinnedToBottomRef.current && Date.now() <= pinUntilRef.current) {
        scrollToBottomImmediate()
        requestAnimationFrame(() => {
          if (!userInteractedRef.current && pinnedToBottomRef.current) scrollToBottomImmediate()
        })
      } else if (isNearBottomRef.current || distFromBottom < 320 || prevMsgCountRef.current === 0) {
        el.scrollTo({ top: el.scrollHeight, behavior: prevMsgCountRef.current === 0 ? 'auto' : 'smooth' })
        isNearBottomRef.current = true
        setShowScrollBottom(false)
      }
    }

    prevLastIdRef.current = lastId
    prevMsgCountRef.current = count
  }, [session?.id, sessionOpenSeq, loadingSession, displayMessages, prependSeq, isStreamingActive])

  // 4) Auto-backfill once if initial page didn't fill the screen height (so user can always scroll naturally!)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !initialScrollReady || loadingSession || loadingOlder || !hasMoreHistory || displayMessages.length === 0) return
    if (autoBackfillCountRef.current >= 2) return
    if (el.scrollHeight <= el.clientHeight + 80) {
      autoBackfillCountRef.current += 1
      triggerLoadOlderRef.current()
    }
  }, [session?.id, initialScrollReady, displayMessages.length, hasMoreHistory, loadingOlder, loadingSession])

  // Auto-scroll to show newly arrived interactive question/approval cards immediately
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !approvals || approvals.length === 0) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [approvals?.length])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    isNearBottomRef.current = distFromBottom < 260
    const shouldShowJump = distFromBottom > 360 && !loadingSession && displayMessages.length > 0
    setShowScrollBottom((prev) => (prev === shouldShowJump ? prev : shouldShowJump))
    if (distFromBottom > 80 && initialScrollReady) {
      pinnedToBottomRef.current = false
    }
    if (loadingOlder) {
      captureVisibleAnchor()
    }
    if (
      !pendingInitialScrollRef.current &&
      initialScrollReady &&
      el.scrollTop <= 180 &&
      hasMoreHistory &&
      !loadingOlder &&
      !loadingSession &&
      displayMessages.length > 0
    ) {
      triggerLoadOlder()
    }
  }

  const handleWheel = (e) => {
    if (e.deltaY < 0) {
      userInteractedRef.current = true
      pinnedToBottomRef.current = false
    }
  }

  // Unbreakable ref-driven touch pull-down (works even if swipe starts slightly below top or viewport isn't scrollable)
  const handleTouchStart = (e) => {
    userInteractedRef.current = true
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    if (distFromBottom > 24) {
      pinnedToBottomRef.current = false
    }
    if (!hasMoreHistory || loadingOlder || loadingSession || e.touches?.length !== 1) {
      pullAnchorYRef.current = null
      return
    }
    pullAnchorYRef.current = el.scrollTop <= 2 ? e.touches[0].clientY : null
  }

  const handleTouchMove = (e) => {
    const el = scrollRef.current
    if (!el || !hasMoreHistory || loadingOlder || loadingSession || e.touches?.length !== 1) return
    const y = e.touches[0].clientY
    // Activate pull anchor mid-drag as soon as user reaches the top edge!
    if (pullAnchorYRef.current === null) {
      if (el.scrollTop <= 2) {
        pullAnchorYRef.current = y
      }
      return
    }
    if (el.scrollTop > 4) {
      pullAnchorYRef.current = null
      if (pullPxRef.current !== 0) {
        pullPxRef.current = 0
        setPullPx(0)
      }
      return
    }
    const dy = y - pullAnchorYRef.current
    if (dy > 4) {
      const next = Math.min(72, Math.round(dy * 0.58))
      pullPxRef.current = next
      setPullPx(next)
    } else if (pullPxRef.current !== 0) {
      pullPxRef.current = 0
      setPullPx(0)
    }
  }

  const finishTouchPull = () => {
    const pulled = pullPxRef.current
    pullAnchorYRef.current = null
    pullPxRef.current = 0
    if (pullPx !== 0) setPullPx(0)
    if (pulled >= 26) {
      triggerLoadOlder()
    }
  }

  const [dismissedSyncWarnKey, setDismissedSyncWarnKey] = useState('')
  const syncWarnKey = session?.syncWarning ? `${session?.id || ''}::${session.syncWarning}` : ''
  const showSyncWarning = Boolean(session?.syncWarning && dismissedSyncWarnKey !== syncWarnKey)
  const hasContent = displayMessages.length > 0 || isStreamingActive

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <TaskStateBar
        sessionId={session?.id || ''}
        taskState={session?.taskState || null}
        running={Boolean(isStreamingActive || session?.syncState?.externalRunning)}
      />
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={finishTouchPull}
        onTouchCancel={finishTouchPull}
        className="flex-1 overflow-x-hidden overflow-y-auto px-4 pt-3 pb-4"
      >
        <div ref={contentRef} className="mx-auto w-full max-w-2xl min-w-0 lg:max-w-3xl">
        {/* Top IntersectionObserver sentinel for seamless automatic infinite scroll */}
        <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />

        {/* Pull-down visual feedback banner */}
        {pullPx > 6 && hasMoreHistory && !loadingOlder && (
          <div
            style={{ height: `${Math.max(26, pullPx)}px` }}
            className="mb-2 flex items-center justify-center gap-1.5 text-xs font-medium text-[#4D6BFE]"
          >
            <ArrowUp
              className={`h-3.5 w-3.5 transition-transform ${pullPx >= 26 ? 'rotate-0' : 'rotate-180'}`}
            />
            <span>{pullPx >= 26 ? bi('松开加载', 'Release to load') : bi('下拉加载更早', 'Pull down to load earlier')}</span>
          </div>
        )}

        {/* Top Pagination Status & Manual Trigger Pill (only shown when more history exists or loading/error) */}
        {!loadingSession && displayMessages.length > 0 && (loadingOlder || olderError || hasMoreHistory) && (
          <div className="mb-3 flex flex-col items-center gap-1.5">
            {loadingOlder ? (
              <div className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500 dark:bg-[#232630] dark:text-slate-300">
                <Loader2 className="h-3 w-3 animate-spin text-[#4D6BFE]" />
                <span>{t('common.loading')}</span>
              </div>
            ) : olderError ? (
              <button
                type="button"
                onClick={triggerLoadOlder}
                className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[11px] font-medium text-rose-600 active:scale-95 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
              >
                <AlertTriangle className="h-3 w-3" />
                <span>{bi('加载失败，点击重试', 'Load failed, tap to retry')}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={triggerLoadOlder}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white px-3 py-1 text-[11px] font-medium text-slate-500 shadow-2xs transition hover:border-[#4D6BFE]/50 hover:text-[#4D6BFE] active:scale-95 dark:border-slate-700/80 dark:bg-[#20232C] dark:text-slate-300"
              >
                <History className="h-3 w-3 text-[#4D6BFE]" />
                <span>{bi('加载更早消息', 'Load earlier messages')}</span>
              </button>
            )}
          </div>
        )}
        {/* Read-only / context handoff notice */}
        {session?.notice && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-[#4D6BFE]/25 bg-[#F2F5FF] px-3.5 py-2.5 text-xs leading-relaxed text-slate-700 dark:border-[#4D6BFE]/35 dark:bg-[#1E2438] dark:text-slate-200">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#4D6BFE]" />
            <span>{session.notice}</span>
          </div>
        )}

        {/* Antigravity cross-client sync notice (only when split-brain or Desktop memory sync hint applies) */}
        {showSyncWarning && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-amber-300/60 bg-amber-50/90 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/35 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="flex-1">{session.syncWarning}</span>
            <button
              type="button"
              aria-label={bi('关闭同步提示', 'Dismiss sync notice')}
              onClick={() => setDismissedSyncWarnKey(syncWarnKey)}
              className="rounded-lg p-0.5 text-amber-700/70 hover:bg-amber-200/50 hover:text-amber-900 dark:text-amber-300/70 dark:hover:bg-amber-800/40"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {loadingSession && (
          <div className="flex items-center justify-center py-16 text-xs text-slate-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-[#4D6BFE]" />
            {t('common.loading')}
          </div>
        )}

        {/* Empty Greeting / Home Quota Overview Dashboard */}
        {!loadingSession && !hasContent && (
          session ? (
            <div className="flex flex-col items-center pt-20 pb-8 text-center">
              <div className="animate-home-rise mb-3.5 h-15 w-15 overflow-hidden rounded-[18px] bg-[#03080E] shadow-lg shadow-blue-950/30 ring-1 ring-white/10 transition-transform duration-300 hover:scale-105">
                <img src="./icon-192.png" alt="All in One" className="h-full w-full object-cover" />
              </div>
              <h2 className="animate-home-rise text-lg font-bold text-slate-900 dark:text-white">
                {session.title}
              </h2>
              {session.workspace && (
                <div
                  title={session.cwd || session.workspace}
                  className="mt-3 inline-flex max-w-xs items-center gap-1.5 rounded-full border border-slate-200/80 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 dark:border-slate-700/80 dark:bg-[#1E2028] dark:text-slate-300"
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE]" />
                  <span className="truncate">{session.workspace}</span>
                </div>
              )}
            </div>
          ) : (
            <HomeQuotaDashboard
              appsStatus={appsStatus}
              sessions={sessions}
              activeApp={activeApp}
              onSelectApp={onSelectApp}
              workspaces={workspaces}
              selectedWorkspace={selectedWorkspace}
              onSelectWorkspace={onSelectWorkspace}
              onOpenNewChatModal={onOpenNewChatModal}
              bridgeOnline={bridgeOnline}
              refreshingQuotas={refreshingQuotas}
              onRefreshQuotas={onRefreshQuotas}
            />
          )
        )}

        {/* Messages list */}
        {!loadingSession && (
          <div className="space-y-5">
            {displayMessages.map((msg, idx) => (
              <MessageRow
                key={msg.id}
                msg={msg}
                appId={session?.app || 'dsh'}
                virtualize={idx >= 15 && idx < displayMessages.length - 8}
              />
            ))}

            {/* Live streaming assistant turn & stream error banner (isolated via useSyncExternalStore) */}
            {session?.id && (
              <StreamingAssistantTurn
                sessionId={session.id}
                appId={session.app || 'dsh'}
                scrollRef={scrollRef}
                isNearBottomRef={isNearBottomRef}
                pinnedToBottomRef={pinnedToBottomRef}
                userInteractedRef={userInteractedRef}
              />
            )}

            {/* External Desktop live-sync pulse (Antigravity / Codex / Claude Desktop currently generating) */}
            {!isStreamingActive && session?.syncState?.externalRunning && (
              <div className="animate-msg-in space-y-1.5 py-1">
                <div className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
                  <VendorBadge app={session?.app || 'dsh'} size="xs" active={true} />
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#4D6BFE]" />
                  <span>{bi('桌面端正在运行此对话，进度自动实时同步中...', 'Running on Desktop, syncing live progress...')}</span>
                </div>
                {session?.syncState?.waitingPermission && (
                  <div className="inline-flex items-center gap-1.5 rounded-xl border border-amber-200/80 bg-amber-50/90 px-2.5 py-1 text-[11.5px] text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/35 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      {bi(
                        `桌面端正在等待权限确认${session.syncState.permissionTool ? `（${session.syncState.permissionTool}）` : ''}，请在电脑端确认`,
                        `Waiting for permission approval on Desktop${session.syncState.permissionTool ? ` (${session.syncState.permissionTool})` : ''}`,
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Interactive Questions & Approvals Cards */}
        {approvals.length > 0 && (
          <div className="mt-5 space-y-2.5">
            {approvals.map((apr) => (
              <InteractivePromptCard key={apr.id} prompt={apr} onResolve={onResolveApproval} />
            ))}
          </div>
        )}
        {/* Bottom scroll anchor */}
        <div ref={bottomAnchorRef} className="h-px w-full" aria-hidden="true" />
      </div>
      </div>

      {/* Floating Jump-to-Latest Button when scrolled up */}
      {showScrollBottom && (
        <button
          type="button"
          aria-label={bi('回到底部最新消息', 'Scroll to latest')}
          onClick={() => {
            userInteractedRef.current = false
            isNearBottomRef.current = true
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
          }}
          className="animate-pop-up absolute right-4 bottom-3 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/90 bg-white/95 text-slate-600 shadow-lg backdrop-blur-md transition-all duration-150 hover:-translate-y-0.5 hover:border-[#4D6BFE]/50 hover:text-[#4D6BFE] active:scale-95 dark:border-slate-700/90 dark:bg-[#232630]/95 dark:text-slate-200"
        >
          <ChevronDown className="h-4.5 w-4.5" />
        </button>
      )}
    </div>
  )
})
