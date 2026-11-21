import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APP_META, EVENTS, RPC } from '@allinone/shared'
import { Loader2, Menu, SquarePen, WifiOff } from 'lucide-react'
import {
  MobileRelayClient,
  clearAuth,
  detectDefaultServerUrl,
  loadSavedAuth,
  pairWithRelay,
  saveAuth,
} from './lib/wsClient.js'
import {
  clearSessionCache,
  loadCachedSession,
  mergeSessionMessages,
  reconcileCachedWithFreshPage,
  saveCachedSession,
} from './lib/sessionCache.js'
import { LoginScreen } from './components/LoginScreen.jsx'
import { SidebarDrawer } from './components/SidebarDrawer.jsx'
import { ChatView } from './components/ChatView.jsx'
import { Composer } from './components/Composer.jsx'
import { NewChatModal } from './components/NewChatModal.jsx'
import { DispatchBoard } from './components/DispatchBoard.jsx'
import { ModelPickerSheet } from './components/ModelPickerSheet.jsx'
import { ImageLightbox } from './components/ImageLightbox.jsx'
import { ShareModal } from './components/ShareModal.jsx'
import { VendorBadge } from './components/VendorIcon.jsx'

export function App() {
  const [auth, setAuth] = useState(() => loadSavedAuth())
  const [autoPairing, setAutoPairing] = useState(false)
  const [pairError, setPairError] = useState('')
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('allinone_dark') === '1')
  const [connState, setConnState] = useState('disconnected')
  const [bridges, setBridges] = useState([])

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newChatCwd, setNewChatCwd] = useState('')
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [lightboxState, setLightboxState] = useState(null)

  const [appsStatus, setAppsStatus] = useState([])
  const [modelsCatalog, setModelsCatalog] = useState({})
  const [sessionModelPrefs, setSessionModelPrefs] = useState({})
  const [draftDshPref, setDraftDshPref] = useState(null)
  const [workspaces, setWorkspaces] = useState([])
  const [sessions, setSessions] = useState([])
  const [refreshing, setRefreshing] = useState(false)

  const [activeSession, setActiveSession] = useState(null)
  const [messages, setMessages] = useState([])
  const [historyMeta, setHistoryMeta] = useState({ hasMore: false, nextCursor: null, totalCount: null })
  const [prependSeq, setPrependSeq] = useState(0)
  const [sessionOpenSeq, setSessionOpenSeq] = useState(0)
  const [olderError, setOlderError] = useState('')
  const [loadingSession, setLoadingSession] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [dispatchMode, setDispatchMode] = useState(true)

  const [streamingBySession, setStreamingBySession] = useState({})
  const [approvals, setApprovals] = useState([])
  const [dispatches, setDispatches] = useState([])

  const clientRef = useRef(null)
  const activeSessionRef = useRef(null)
  activeSessionRef.current = activeSession
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const historyMetaRef = useRef(historyMeta)
  historyMetaRef.current = historyMeta
  const openRequestSeqRef = useRef(0)
  const loadingOlderLockRef = useRef(false)
  const streamingRef = useRef(streamingBySession)
  streamingRef.current = streamingBySession

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('allinone_dark', darkMode ? '1' : '0')
  }, [darkMode])

  // Auto-pair immediately when opened via QR code link (?pair=pt_xxx or ?code=XXXX-XXXX)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const pairToken = (params.get('pair') || '').trim()
    const pairCode = (params.get('code') || '').trim()
    if (!pairToken && !pairCode) return

    // Strip pairing secret from address bar immediately
    params.delete('pair')
    params.delete('code')
    const cleanQuery = params.toString()
    const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash || ''}`
    try { window.history.replaceState({}, '', cleanUrl) } catch {}

    let cancelled = false
    setAutoPairing(true)
    setPairError('')
    pairWithRelay(detectDefaultServerUrl(), { pairToken, pairCode })
      .then((res) => {
        if (cancelled) return
        const nextAuth = {
          baseUrl: res.baseUrl,
          token: res.token,
          roomId: res.roomId,
          label: res.label,
          bridges: res.bridges,
        }
        saveAuth(nextAuth)
        void clearSessionCache()
        setActiveSession(null)
        setMessages([])
        setSessions([])
        setAuth(nextAuth)
      })
      .catch((err) => {
        if (cancelled) return
        setPairError(String(err?.message || err || '扫码自动配对失败，请重试'))
      })
      .finally(() => {
        if (!cancelled) setAutoPairing(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const defaultApp = useMemo(() => {
    const order = ['dsh', 'codex', 'claude', 'antigravity']
    for (const id of order) {
      if (appsStatus.find((a) => a.app === id && a.writable)) return id
    }
    for (const id of order) {
      if (appsStatus.find((a) => a.app === id && a.available)) return id
    }
    return 'dsh'
  }, [appsStatus])

  const effectiveWorkspaces = useMemo(() => {
    const map = new Map()
    for (const w of workspaces) {
      if (w?.path) map.set(w.path.toLowerCase(), w)
    }
    for (const s of sessions) {
      const p = String(s?.cwd || '').trim()
      if (!p) continue
      const key = p.toLowerCase()
      if (!map.has(key)) {
        const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
        map.set(key, {
          name: s.workspace || parts[parts.length - 1] || p,
          path: p,
          source: s.app,
        })
      }
    }
    return [...map.values()]
  }, [workspaces, sessions])

  const imageContext = useMemo(
    () => ({
      baseUrl: auth?.baseUrl || '',
      token: auth?.token || '',
      cwd: activeSession?.cwd || '',
      onOpenImage: setLightboxState,
    }),
    [auth?.baseUrl, auth?.token, activeSession?.cwd],
  )

  const primaryBridge = bridges.find((b) => b.online) || null
  const bridgeOnline = Boolean(primaryBridge)

  const loadWorkspaceData = useCallback(async () => {
    const client = clientRef.current
    if (!client) return
    setRefreshing(true)
    try {
      const [statusRes, sessRes, wsRes, aprRes, dispRes, modelsRes] = await Promise.all([
        client.rpc(RPC.APPS_STATUS).catch(() => ({ apps: [] })),
        client.rpc(RPC.SESSIONS_LIST, { app: 'all', limit: 100 }).catch(() => ({ sessions: [] })),
        client.rpc(RPC.WORKSPACES_LIST).catch(() => ({ workspaces: [] })),
        client.rpc(RPC.APPROVAL_LIST).catch(() => ({ approvals: [] })),
        client.rpc(RPC.DISPATCH_LIST, { limit: 30 }).catch(() => ({ tasks: [] })),
        client.rpc(RPC.MODELS_LIST).catch(() => ({ catalog: {} })),
      ])
      setAppsStatus(statusRes.apps || [])
      setSessions(sessRes.sessions || [])
      setWorkspaces(wsRes.workspaces || [])
      setApprovals(aprRes.approvals || [])
      setDispatches(dispRes.tasks || [])
      if (modelsRes?.catalog && Object.keys(modelsRes.catalog).length > 0) {
        setModelsCatalog(modelsRes.catalog)
      }
    } finally {
      setRefreshing(false)
    }
  }, [])

  const openSession = useCallback(async (sessionOrId) => {
    const client = clientRef.current
    if (!client) return
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id
    const isDifferentSession = activeSessionRef.current?.id !== id
    const reqSeq = ++openRequestSeqRef.current
    loadingOlderLockRef.current = false
    setLoadingOlder(false)
    setOlderError('')
    setSessionOpenSeq((n) => n + 1)

    if (typeof sessionOrId === 'object') {
      setActiveSession(sessionOrId)
    }
    if (isDifferentSession) {
      // Clear previous session's messages immediately so ChatView never measures stale scrollHeight
      setMessages([])
      setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: null })
    }

    // 1. Show phone-cached history immediately (0ms perceived latency)
    const cached = await loadCachedSession(id)
    if (openRequestSeqRef.current !== reqSeq) return
    if (cached && cached.messages?.length > 0) {
      if (cached.meta && typeof sessionOrId === 'string') {
        setActiveSession(cached.meta)
      }
      setMessages(cached.messages)
      setHistoryMeta({
        hasMore: Boolean(cached.hasMore),
        nextCursor: cached.nextCursor ?? null,
        totalCount: cached.totalCount ?? null,
      })
      setLoadingSession(false)
    } else {
      setMessages([])
      setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: null })
      setLoadingSession(true)
    }

    // 2. Sync latest page from PC (14 merged real Q&A bubbles ~15KB) and reconcile with phone cache
    try {
      const res = await client.rpc(RPC.SESSION_READ, { id, limit: 14 })
      if (openRequestSeqRef.current !== reqSeq) return
      if (res?.session) {
        const { messages: freshMsgs = [], hasMore, nextCursor, totalCount, ...metaOnly } = res.session
        const reconciled = reconcileCachedWithFreshPage(cached, {
          messages: freshMsgs,
          hasMore,
          nextCursor,
          totalCount,
        })
        setActiveSession(res.session)
        setMessages(reconciled.messages)
        setHistoryMeta({
          hasMore: reconciled.hasMore,
          nextCursor: reconciled.nextCursor,
          totalCount: reconciled.totalCount,
        })
        void saveCachedSession(id, {
          meta: metaOnly,
          messages: reconciled.messages,
          hasMore: reconciled.hasMore,
          nextCursor: reconciled.nextCursor,
          totalCount: reconciled.totalCount,
        })
      }
    } catch (err) {
      if (openRequestSeqRef.current !== reqSeq) return
      if (!cached || !cached.messages?.length) {
        setStreamingBySession((prev) => ({
          ...prev,
          [id]: { active: false, error: String(err?.message || err) },
        }))
      }
    } finally {
      if (openRequestSeqRef.current === reqSeq) {
        setLoadingSession(false)
      }
    }
  }, [])

  const loadOlderMessages = useCallback(async () => {
    const client = clientRef.current
    const sess = activeSessionRef.current
    const hMeta = historyMetaRef.current
    if (!client || !sess?.id || !hMeta.hasMore || !hMeta.nextCursor) return
    if (loadingOlderLockRef.current) return

    loadingOlderLockRef.current = true
    setLoadingOlder(true)
    setOlderError('')
    const targetId = sess.id
    const cursor = hMeta.nextCursor

    try {
      const res = await client.rpc(RPC.SESSION_READ, { id: targetId, limit: 14, cursor })
      if (activeSessionRef.current?.id !== targetId) return
      if (res?.session) {
        const olderMsgs = Array.isArray(res.session.messages) ? res.session.messages : []
        const merged = mergeSessionMessages(olderMsgs, messagesRef.current)
        const nextHasMore = Boolean(res.session.hasMore) && Boolean(res.session.nextCursor) && res.session.nextCursor !== cursor
        const nextCur = nextHasMore ? res.session.nextCursor : null
        const nextTotal = res.session.totalCount ?? hMeta.totalCount ?? null

        setMessages(merged)
        setPrependSeq((n) => n + 1)
        setHistoryMeta({
          hasMore: nextHasMore,
          nextCursor: nextCur,
          totalCount: nextTotal,
        })

        const { messages: _drop, ...metaOnly } = res.session
        void saveCachedSession(targetId, {
          meta: metaOnly,
          messages: merged,
          hasMore: nextHasMore,
          nextCursor: nextCur,
          totalCount: nextTotal,
        })
      }
    } catch (err) {
      setOlderError(String(err?.message || err || '加载更早历史失败'))
    } finally {
      loadingOlderLockRef.current = false
      setLoadingOlder(false)
    }
  }, [])

  // Connect WebSocket whenever authenticated
  useEffect(() => {
    if (!auth?.token || !auth?.baseUrl) return
    const client = new MobileRelayClient({ baseUrl: auth.baseUrl, token: auth.token })
    clientRef.current = client

    const unsubStatus = client.onStatus(({ state, bridges: bList }) => {
      setConnState(state)
      setBridges(bList || [])
      if (state === 'connected' && (bList || []).some((b) => b.online)) {
        loadWorkspaceData()
      }
    })

    const unsubEvents = client.onEvent((event, payload) => {
      if (event === EVENTS.BRIDGE_STATUS) {
        if (payload?.online) loadWorkspaceData()
        return
      }

      if (event === EVENTS.APPROVAL_REQUEST && payload?.id) {
        setApprovals((prev) => [payload, ...prev.filter((a) => a.id !== payload.id)])
        return
      }

      if (event === EVENTS.APPROVAL_RESOLVED && payload?.id) {
        setApprovals((prev) => prev.filter((a) => a.id !== payload.id))
        return
      }

      if (event === EVENTS.DISPATCH_UPDATED && payload?.task) {
        const task = payload.task
        setDispatches((prev) => [task, ...prev.filter((x) => x.taskId !== task.taskId)])
        return
      }

      if (event === EVENTS.SESSION_UPDATED && payload?.session) {
        setSessions((prev) => [payload.session, ...prev.filter((s) => s.id !== payload.session.id)])
        return
      }

      const sid = payload?.sessionId
      if (!sid) return

      if (event === EVENTS.STREAM_START) {
        setStreamingBySession((prev) => ({
          ...prev,
          [sid]: { active: true, text: '', thinking: '', tools: [], error: '' },
        }))
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'running' } : s)))
      } else if (event === EVENTS.STREAM_DELTA) {
        setStreamingBySession((prev) => {
          const cur = prev[sid] || { active: true, text: '', thinking: '', tools: [], error: '' }
          return { ...prev, [sid]: { ...cur, active: true, text: cur.text + (payload.delta || '') } }
        })
      } else if (event === EVENTS.STREAM_THINKING) {
        setStreamingBySession((prev) => {
          const cur = prev[sid] || { active: true, text: '', thinking: '', tools: [], error: '' }
          return { ...prev, [sid]: { ...cur, active: true, thinking: cur.thinking + (payload.delta || '') } }
        })
      } else if (event === EVENTS.STREAM_TOOL_START && payload.tool) {
        setStreamingBySession((prev) => {
          const cur = prev[sid] || { active: true, text: '', thinking: '', tools: [], error: '' }
          const exists = cur.tools.some((t) => t.id === payload.tool.id)
          const tools = exists
            ? cur.tools
            : [...cur.tools, { ...payload.tool, status: 'running', output: '' }]
          return { ...prev, [sid]: { ...cur, active: true, tools } }
        })
      } else if (event === EVENTS.STREAM_TOOL_END && payload.toolId) {
        setStreamingBySession((prev) => {
          const cur = prev[sid] || { active: true, text: '', thinking: '', tools: [], error: '' }
          const tools = cur.tools.map((t) =>
            t.id === payload.toolId
              ? { ...t, status: payload.status || 'completed', output: payload.output || '' }
              : t,
          )
          return { ...prev, [sid]: { ...cur, tools } }
        })
      } else if (event === EVENTS.STREAM_ERROR) {
        setStreamingBySession((prev) => {
          const cur = prev[sid] || { active: false, text: '', thinking: '', tools: [] }
          return { ...prev, [sid]: { ...cur, active: false, error: payload.message || '执行出错' } }
        })
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'idle' } : s)))
      } else if (event === EVENTS.STREAM_DONE) {
        const cur = streamingRef.current[sid]
        setStreamingBySession((prev) => {
          const next = { ...prev }
          delete next[sid]
          return next
        })
        if (
          activeSessionRef.current?.id === sid &&
          (payload.finalText || cur?.text || cur?.thinking || cur?.tools?.length)
        ) {
          const committed = {
            id: `msg-a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'assistant',
            text: payload.finalText || cur?.text || '',
            thinking: cur?.thinking || undefined,
            tools: cur?.tools?.length ? cur.tools : undefined,
            ts: Date.now(),
          }
          const nextList = [...messagesRef.current, committed]
          setMessages(nextList)
          void saveCachedSession(sid, {
            meta: activeSessionRef.current,
            messages: nextList,
            hasMore: historyMetaRef.current.hasMore,
            nextCursor: historyMetaRef.current.nextCursor,
            totalCount: historyMetaRef.current.totalCount,
          })
        }
        setSessions((prev) =>
          prev.map((s) => (s.id === sid ? { ...s, status: 'idle', updatedAt: Date.now() } : s)),
        )
      }
    })

    client.connect()

    return () => {
      unsubStatus()
      unsubEvents()
      client.disconnect()
      clientRef.current = null
    }
  }, [auth?.token, auth?.baseUrl, loadWorkspaceData])

  const handleCreateSession = async ({ app, cwd, title, model, provider, reasoningEffort }) => {
    const client = clientRef.current
    if (!client) throw new Error('未连接到服务器')
    const res = await client.rpc(RPC.SESSION_CREATE, {
      app,
      cwd,
      title,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    })
    const created = res.session
    if (model || provider || reasoningEffort) {
      setSessionModelPrefs((prev) => ({
        ...prev,
        [created.id]: {
          model: model || created.model || '',
          provider: provider || created.provider || '',
          reasoningEffort: reasoningEffort || created.reasoningEffort || '',
        },
      }))
    }
    setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)])
    setActiveSession(created)
    setMessages([])
    setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: 0 })
    return created
  }

  const resolveModelPrefFor = (sessionObj) => {
    const appId = sessionObj?.app || defaultApp
    const cat = modelsCatalog[appId]
    const explicit = sessionObj?.id ? sessionModelPrefs[sessionObj.id] : draftDshPref
    if (explicit?.model) return explicit
    const sessModel =
      sessionObj?.model &&
      sessionObj.model !== 'Antigravity Desktop' &&
      sessionObj.model !== 'Antigravity CLI'
        ? sessionObj.model
        : ''
    const model = sessModel || cat?.defaultModel || ''
    const matched =
      (cat?.models || []).find(
        (m) => m.id === model && (!sessionObj?.provider || !m.provider || m.provider === sessionObj.provider),
      ) || (cat?.models || []).find((m) => m.id === model)
    const provider = sessionObj?.provider || matched?.provider || cat?.defaultProvider || ''
    const allowed = matched?.efforts || []
    const rawEffort = sessionObj?.reasoningEffort || matched?.defaultEffort || cat?.defaultEffort || ''
    const reasoningEffort =
      allowed.length === 0 ? '' : allowed.includes(rawEffort) ? rawEffort : matched?.defaultEffort || allowed[0] || ''
    return { model, provider, reasoningEffort }
  }

  const handleSend = async ({ text, attachments = [] }) => {
    const client = clientRef.current
    if (!client) return

    let target = activeSession
    if (!target) {
      // Auto-create a session on the first available writable app when typing from the greeting screen
      try {
        const initPref = resolveModelPrefFor({ app: defaultApp })
        target = await handleCreateSession({
          app: defaultApp,
          cwd: effectiveWorkspaces?.[0]?.path || '',
          title: text.slice(0, 28) || '新对话',
          model: initPref.model || undefined,
          provider: initPref.provider || undefined,
          reasoningEffort: initPref.reasoningEffort || undefined,
        })
      } catch (err) {
        alert(String(err?.message || err))
        return
      }
    }

    const activePref = resolveModelPrefFor(target)

    const finalText =
      target.app === 'dsh' && dispatchMode && !text.includes('allinone_')
        ? text
        : text

    // Optimistically replace generic placeholder title on first user message
    const genericTitle = /^(新 |手机端总控对话|[0-9a-f]{8}-[0-9a-f]{4}-)/i.test(target.title || '')
    if (genericTitle && finalText.trim().length > 0) {
      const nextTitle = finalText.trim().replace(/\s+/g, ' ').slice(0, 36)
      setActiveSession((prev) => (prev && prev.id === target.id ? { ...prev, title: nextTitle } : prev))
      setSessions((prev) => prev.map((s) => (s.id === target.id ? { ...s, title: nextTitle } : s)))
    }

    // Optimistic user bubble (render uploaded image attachments as real previews!)
    const imgAtts = attachments.filter((a) => String(a.mimeType || '').startsWith('image/'))
    const nonImgAtts = attachments.filter((a) => !String(a.mimeType || '').startsWith('image/'))
    const displayUserText =
      nonImgAtts.length > 0
        ? `${finalText}${finalText ? '\n' : ''}[附件: ${nonImgAtts.map((a) => a.filename).join(', ')}]`
        : finalText
    const userMsg = {
      id: `msg-u-${Date.now()}`,
      role: 'user',
      text: displayUserText,
      ...(imgAtts.length > 0
        ? { images: imgAtts.map((a) => ({ url: a.url, name: a.filename, mimeType: a.mimeType })) }
        : {}),
      ts: Date.now(),
    }
    const nextWithUser = [...messagesRef.current, userMsg]
    setMessages(nextWithUser)
    void saveCachedSession(target.id, {
      meta: target,
      messages: nextWithUser,
      hasMore: historyMetaRef.current.hasMore,
      nextCursor: historyMetaRef.current.nextCursor,
      totalCount: historyMetaRef.current.totalCount,
    })

    setStreamingBySession((prev) => ({
      ...prev,
      [target.id]: { active: true, text: '', thinking: '', tools: [], error: '' },
    }))

    try {
      await client.rpc(RPC.SESSION_SEND, {
        id: target.id,
        text: finalText,
        cwd: target.cwd,
        attachments,
        wait: false,
        ...(activePref.model ? { model: activePref.model } : {}),
        ...(activePref.provider ? { provider: activePref.provider } : {}),
        ...(activePref.reasoningEffort ? { reasoningEffort: activePref.reasoningEffort } : {}),
      })
    } catch (err) {
      setStreamingBySession((prev) => ({
        ...prev,
        [target.id]: { active: false, text: '', thinking: '', tools: [], error: String(err?.message || err) },
      }))
    }
  }

  const handleInterrupt = async () => {
    const client = clientRef.current
    if (!client || !activeSession) return
    try {
      await client.rpc(RPC.SESSION_INTERRUPT, { id: activeSession.id })
    } catch {}
  }

  const handleResolveApproval = async (id, decision) => {
    const client = clientRef.current
    if (!client) return
    try {
      await client.rpc(RPC.APPROVAL_RESOLVE, { id, decision })
      setApprovals((prev) => prev.filter((a) => a.id !== id))
    } catch (err) {
      alert(String(err?.message || err))
    }
  }

  const handleDirectDispatch = async ({ app, cwd, prompt }) => {
    const client = clientRef.current
    if (!client) throw new Error('未连接到服务器')
    const res = await client.rpc(RPC.DISPATCH_CREATE, {
      app,
      cwd,
      prompt,
      wait: false,
      issuedBy: 'mobile-board',
    })
    if (res?.task) {
      setDispatches((prev) => [res.task, ...prev.filter((t) => t.taskId !== res.task.taskId)])
    }
  }

  if (autoPairing) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-b from-[#F5F8FF] to-white px-6 text-center dark:from-[#16171A] dark:to-[#111216]">
        <div className="mb-4 h-16 w-16 overflow-hidden rounded-2xl bg-[#03080E] shadow-xl ring-1 ring-white/10">
          <img src="./icon-192.png" alt="All in One" className="h-full w-full object-cover" />
        </div>
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-white">
          <Loader2 className="h-4 w-4 animate-spin text-[#4D6BFE]" />
          <span>正在扫码自动配对你的专属电脑...</span>
        </div>
        <p className="mt-1.5 text-xs text-slate-400">独立加密房间验证中，请稍候</p>
      </div>
    )
  }

  if (!auth) {
    return (
      <LoginScreen
        initialError={pairError}
        onSuccess={(data) => {
          setPairError('')
          saveAuth(data)
          setAuth(data)
        }}
      />
    )
  }

  const activeApp = activeSession?.app || defaultApp
  const activeMeta = APP_META[activeApp] || APP_META.dsh
  const activeCatalog = modelsCatalog[activeApp] || null
  const activeModelPref = resolveModelPrefFor(activeSession)
  const activeModelObj = (activeCatalog?.models || []).find(
    (m) =>
      m.id === activeModelPref.model &&
      (!activeModelPref.provider || !m.provider || m.provider === activeModelPref.provider),
  ) || (activeCatalog?.models || []).find((m) => m.id === activeModelPref.model)
  const currentStream = activeSession ? streamingBySession[activeSession.id] : null

  return (
    <div className="flex h-full w-full flex-col bg-white dark:bg-[#16171A]">
      {/* DeepSeek-style minimal top header */}
      <header className="pt-safe shrink-0 border-b border-slate-100 bg-white/85 px-3 pb-2.5 backdrop-blur-md dark:border-slate-800/80 dark:bg-[#16171A]/85">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开对话列表"
            className="relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Menu className="h-5 w-5" />
            {approvals.length > 0 && (
              <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-rose-500" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex min-w-0 flex-1 flex-col items-center text-center"
          >
            <div className="flex max-w-full items-center gap-1.5">
              <VendorBadge app={activeApp} size="xs" />
              <span className="truncate text-[14.5px] font-semibold text-slate-900 dark:text-white">
                {activeSession?.title || 'All in One'}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-slate-400">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connState === 'connected' && bridgeOnline
                    ? 'bg-emerald-500'
                    : connState === 'connecting'
                      ? 'bg-amber-400'
                      : 'bg-rose-400'
                }`}
              />
              <span className="truncate max-w-[200px]">
                {connState !== 'connected'
                  ? '正在连接服务器...'
                  : bridgeOnline
                    ? activeSession?.workspace || primaryBridge?.hostname || '电脑已在线'
                    : '等待电脑端上线'}
              </span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setNewChatOpen(true)}
            aria-label="新建对话"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <SquarePen className="h-4.5 w-4.5" />
          </button>
        </div>
      </header>

      {/* Offline warning bar if relay connected but PC bridge offline */}
      {connState === 'connected' && !bridgeOnline && (
        <div className="flex items-center justify-center gap-2 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          <WifiOff className="h-3.5 w-3.5" />
          <span>服务器已连通，等待电脑端 All in One 桥接上线...</span>
        </div>
      )}

      {/* Main Chat Viewport */}
      <ChatView
        session={activeSession}
        messages={messages}
        streamingState={currentStream}
        loadingSession={loadingSession}
        hasMoreHistory={historyMeta.hasMore}
        loadingOlder={loadingOlder}
        olderError={olderError}
        prependSeq={prependSeq}
        sessionOpenSeq={sessionOpenSeq}
        totalHistoryCount={historyMeta.totalCount}
        onLoadOlder={loadOlderMessages}
        appsStatus={appsStatus}
        approvals={approvals}
        imageContext={imageContext}
        onResolveApproval={handleResolveApproval}
        onQuickPrompt={(promptText) => handleSend({ text: promptText })}
        onOpenDispatchBoard={() => setDispatchOpen(true)}
      />

      {/* Floating DeepSeek-style Composer */}
      <Composer
        activeApp={activeApp}
        streaming={Boolean(currentStream?.active)}
        disabled={!bridgeOnline || connState !== 'connected'}
        dispatchMode={dispatchMode}
        onToggleDispatchMode={() => setDispatchMode((v) => !v)}
        onSwitchAppClick={() => setNewChatOpen(true)}
        modelPref={activeModelPref}
        modelDisplayName={activeModelObj?.name || activeModelPref.model}
        onOpenModelPicker={() => setModelPickerOpen(true)}
        imageContext={imageContext}
        onUploadFile={(file) => clientRef.current?.uploadFile(file)}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
      />

      {/* Slide-over Sidebar Drawer */}
      <SidebarDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sessions={sessions}
        activeSessionId={activeSession?.id}
        onSelectSession={openSession}
        onNewChat={(cwdHint = '') => {
          setNewChatCwd(typeof cwdHint === 'string' ? cwdHint : '')
          setNewChatOpen(true)
        }}
        onRefresh={loadWorkspaceData}
        refreshing={refreshing}
        bridgeOnline={bridgeOnline}
        bridgeHost={primaryBridge?.hostname}
        roomId={auth?.roomId}
        darkMode={darkMode}
        onToggleDark={() => setDarkMode((v) => !v)}
        onOpenShare={() => setShareOpen(true)}
        onLogout={() => {
          clearAuth()
          void clearSessionCache()
          setAuth(null)
          setActiveSession(null)
          setMessages([])
        }}
      />

      {/* New Chat Bottom Sheet */}
      <NewChatModal
        open={newChatOpen}
        initialCwd={newChatCwd}
        onClose={() => {
          setNewChatOpen(false)
          setNewChatCwd('')
        }}
        workspaces={effectiveWorkspaces}
        appsStatus={appsStatus}
        modelsCatalog={modelsCatalog}
        onCreate={handleCreateSession}
      />

      {/* Mid-Chat Model & Reasoning Effort Picker */}
      <ModelPickerSheet
        open={modelPickerOpen}
        app={activeApp}
        catalog={activeCatalog}
        value={activeModelPref}
        mode="midchat"
        onClose={() => setModelPickerOpen(false)}
        onApply={(next) => {
          if (activeSession?.id) {
            setSessionModelPrefs((prev) => ({
              ...prev,
              [activeSession.id]: next,
            }))
            setActiveSession((prev) =>
              prev
                ? {
                    ...prev,
                    model: next.model || prev.model,
                    provider: next.provider || prev.provider,
                    reasoningEffort: next.reasoningEffort ?? prev.reasoningEffort,
                  }
                : prev,
            )
          } else {
            setDraftDshPref(next)
          }
        }}
      />

      {/* Master Dispatch Board */}
      <DispatchBoard
        open={dispatchOpen}
        onClose={() => setDispatchOpen(false)}
        appsStatus={appsStatus}
        workspaces={effectiveWorkspaces}
        dispatches={dispatches}
        onRefresh={loadWorkspaceData}
        onDirectDispatch={handleDirectDispatch}
        onJumpToSession={openSession}
      />
      {/* Share with Friends Modal */}
      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        serverUrl={auth?.baseUrl}
      />
      {/* Full-Screen Zoomable Image Lightbox */}
      <ImageLightbox state={lightboxState} onClose={() => setLightboxState(null)} />
    </div>
  )
}

export default App
