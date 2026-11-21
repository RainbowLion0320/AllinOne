import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APP_META, EVENTS, RPC } from '@allinone/shared'
import {
  ArrowLeftRight,
  ChevronDown,
  KeyRound,
  Loader2,
  Menu,
  SquarePen,
  WifiOff,
} from 'lucide-react'
import {
  MobileRelayClient,
  detectDefaultServerUrl,
  pairWithRelay,
} from './lib/wsClient.js'
import {
  getActiveDevice,
  getCacheScopeKey,
  getDeviceDisplayName,
  loadDeviceState,
  removeDevice,
  renameDevice,
  saveDeviceState,
  selectDevice,
  updateDeviceMeta,
  upsertDevice,
} from './lib/deviceStore.js'
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
import { DeviceSwitcherModal } from './components/DeviceSwitcherModal.jsx'
import { VendorBadge } from './components/VendorIcon.jsx'

export function App() {
  const [deviceState, setDeviceState] = useState(() => loadDeviceState())
  const [addingDevice, setAddingDevice] = useState({ open: false, serverUrl: '', openScanner: false })
  const [autoPairing, setAutoPairing] = useState(false)
  const [pairError, setPairError] = useState('')
  const [toastMsg, setToastMsg] = useState('')
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('allinone_dark') === '1')
  const [connState, setConnState] = useState('disconnected')
  const [bridges, setBridges] = useState([])

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [deviceSwitcherOpen, setDeviceSwitcherOpen] = useState(false)
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

  const devices = deviceState.devices
  const activeDevice = useMemo(() => getActiveDevice(deviceState), [deviceState])

  const onlineBridges = useMemo(() => bridges.filter((b) => b.online), [bridges])

  const activeBridge = useMemo(() => {
    if (!activeDevice || onlineBridges.length === 0) return null
    const preferredId = String(activeDevice.selectedBridgeId || '').trim()
    if (preferredId) {
      const matched = onlineBridges.find((b) => b.bridgeId === preferredId)
      if (matched) return matched
      // In a shared owner room where a specific bridge was already active in this view,
      // never silently reroute mid-conversation to a different online computer.
      if (activeDevice.roomId === 'owner' && (activeSession || sessions.length > 0)) {
        return null
      }
    }
    return onlineBridges[0] || null
  }, [activeDevice, onlineBridges, activeSession, sessions.length])

  const bridgeOnline = Boolean(activeBridge)
  const activeBridgeId = activeBridge?.bridgeId || ''
  const activeDeviceName = useMemo(
    () => getDeviceDisplayName(activeDevice, activeBridge, onlineBridges.length),
    [activeDevice, activeBridge, onlineBridges.length],
  )
  const cacheScope = useMemo(
    () => getCacheScopeKey(activeDevice, activeBridgeId),
    [activeDevice, activeBridgeId],
  )

  const skipFirstSaveRef = useRef(true)
  const deviceStateRef = useRef(deviceState)
  deviceStateRef.current = deviceState
  const clientRef = useRef(null)
  const activeSessionRef = useRef(null)
  activeSessionRef.current = activeSession
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const historyMetaRef = useRef(historyMeta)
  historyMetaRef.current = historyMeta
  const openRequestSeqRef = useRef(0)
  const deviceGenRef = useRef(0)
  const loadingOlderLockRef = useRef(false)
  const streamingRef = useRef(streamingBySession)
  streamingRef.current = streamingBySession
  const activeBridgeIdRef = useRef(activeBridgeId)
  activeBridgeIdRef.current = activeBridgeId
  const cacheScopeRef = useRef(cacheScope)
  cacheScopeRef.current = cacheScope
  const toastTimerRef = useRef(null)

  const showToast = useCallback((text) => {
    if (!text) return
    setToastMsg(text)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null
      setToastMsg('')
    }, 2600)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  // Persist multi-device state whenever it changes
  useEffect(() => {
    if (skipFirstSaveRef.current) {
      skipFirstSaveRef.current = false
      return
    }
    saveDeviceState(deviceState)
  }, [deviceState])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('allinone_dark', darkMode ? '1' : '0')
  }, [darkMode])

  const resetTransientWorkspace = useCallback(() => {
    deviceGenRef.current += 1
    openRequestSeqRef.current += 1
    loadingOlderLockRef.current = false
    setActiveSession(null)
    setMessages([])
    setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: null })
    setOlderError('')
    setLoadingSession(false)
    setLoadingOlder(false)
    setAppsStatus([])
    setModelsCatalog({})
    setSessionModelPrefs({})
    setDraftDshPref(null)
    setWorkspaces([])
    setSessions([])
    setStreamingBySession({})
    setApprovals([])
    setDispatches([])
    setNewChatOpen(false)
    setNewChatCwd('')
    setDispatchOpen(false)
    setModelPickerOpen(false)
    setLightboxState(null)
  }, [])

  const handleDeviceAuthenticated = useCallback((payload) => {
    setPairError('')
    const preview = upsertDevice(deviceStateRef.current, payload)
    resetTransientWorkspace()
    setBridges([])
    setDeviceState((prev) => upsertDevice(prev, payload).state)
    setAddingDevice({ open: false, serverUrl: '', openScanner: false })
    setDeviceSwitcherOpen(false)
    if (preview.device) {
      const name = getDeviceDisplayName(preview.device)
      showToast(preview.isNew ? `已添加并切换到 ${name}` : `已更新并切换到 ${name}`)
    }
  }, [resetTransientWorkspace, showToast])

  // Auto-pair immediately when opened via QR code link (?pair=pt_xxx or ?code=XXXX-XXXX)
  // Appends the newly paired computer to the saved devices list without deleting existing ones!
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
        handleDeviceAuthenticated({
          baseUrl: res.baseUrl,
          token: res.token,
          roomId: res.roomId,
          label: res.label,
          bridges: res.bridges,
          authMode: 'pair',
        })
      })
      .catch((err) => {
        if (cancelled) return
        setPairError(String(err?.message || err || '扫码自动配对失败，请重试'))
        if (deviceStateRef.current.devices.length > 0) {
          setAddingDevice({ open: true, serverUrl: detectDefaultServerUrl(), openScanner: false })
        }
      })
      .finally(() => {
        if (!cancelled) setAutoPairing(false)
      })

    return () => {
      cancelled = true
    }
  }, [handleDeviceAuthenticated])

  // Sync live hostname / platform / selectedBridgeId back to saved device metadata
  useEffect(() => {
    if (!activeDevice?.id || !activeBridge) return
    setDeviceState((prev) =>
      updateDeviceMeta(prev, activeDevice.id, {
        lastHostname: activeBridge.hostname || '',
        lastPlatform: activeBridge.platform || '',
        selectedBridgeId: activeBridge.bridgeId || '',
      }),
    )
  }, [activeDevice?.id, activeBridge?.bridgeId, activeBridge?.hostname, activeBridge?.platform])

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
      baseUrl: activeDevice?.baseUrl || '',
      token: activeDevice?.token || '',
      cwd: activeSession?.cwd || '',
      bridgeId: activeBridgeId,
      onOpenImage: setLightboxState,
    }),
    [activeDevice?.baseUrl, activeDevice?.token, activeSession?.cwd, activeBridgeId],
  )

  const loadWorkspaceData = useCallback(async (bridgeOverride = '') => {
    const client = clientRef.current
    if (!client) return
    const targetBridge = String(bridgeOverride || activeBridgeIdRef.current || '').trim()
    if (targetBridge) client.setTargetBridgeId(targetBridge)
    const gen = deviceGenRef.current
    setRefreshing(true)
    try {
      const rpcOpts = targetBridge ? { bridgeId: targetBridge } : {}
      const [statusRes, sessRes, wsRes, aprRes, dispRes, modelsRes] = await Promise.all([
        client.rpc(RPC.APPS_STATUS, {}, 45_000, rpcOpts).catch(() => ({ apps: [] })),
        client.rpc(RPC.SESSIONS_LIST, { app: 'all', limit: 100 }, 45_000, rpcOpts).catch(() => ({ sessions: [] })),
        client.rpc(RPC.WORKSPACES_LIST, {}, 45_000, rpcOpts).catch(() => ({ workspaces: [] })),
        client.rpc(RPC.APPROVAL_LIST, {}, 45_000, rpcOpts).catch(() => ({ approvals: [] })),
        client.rpc(RPC.DISPATCH_LIST, { limit: 30 }, 45_000, rpcOpts).catch(() => ({ tasks: [] })),
        client.rpc(RPC.MODELS_LIST, {}, 45_000, rpcOpts).catch(() => ({ catalog: {} })),
      ])
      if (deviceGenRef.current !== gen || clientRef.current !== client) return
      setAppsStatus(statusRes.apps || [])
      setSessions(sessRes.sessions || [])
      setWorkspaces(wsRes.workspaces || [])
      setApprovals(aprRes.approvals || [])
      setDispatches(dispRes.tasks || [])
      if (modelsRes?.catalog && Object.keys(modelsRes.catalog).length > 0) {
        setModelsCatalog(modelsRes.catalog)
      }
    } finally {
      if (deviceGenRef.current === gen) {
        setRefreshing(false)
      }
    }
  }, [])

  // Trigger workspace load whenever connected target device/bridge is ready or changes
  useEffect(() => {
    if (connState !== 'connected' || !activeDevice?.id || !activeBridgeId) return
    clientRef.current?.setTargetBridgeId(activeBridgeId)
    void loadWorkspaceData(activeBridgeId)
  }, [connState, activeDevice?.id, activeBridgeId, loadWorkspaceData])

  const openSession = useCallback(async (sessionOrId) => {
    const client = clientRef.current
    if (!client) return
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id
    const isDifferentSession = activeSessionRef.current?.id !== id
    const reqSeq = ++openRequestSeqRef.current
    const gen = deviceGenRef.current
    const scope = cacheScopeRef.current
    const targetBridge = activeBridgeIdRef.current
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

    // 1. Show phone-cached history immediately (0ms perceived latency), strictly scoped to current PC
    const cached = await loadCachedSession(id, scope)
    if (openRequestSeqRef.current !== reqSeq || deviceGenRef.current !== gen) return
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
      const res = await client.rpc(
        RPC.SESSION_READ,
        { id, limit: 14 },
        45_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
      if (openRequestSeqRef.current !== reqSeq || deviceGenRef.current !== gen) return
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
        void saveCachedSession(
          id,
          {
            meta: metaOnly,
            messages: reconciled.messages,
            hasMore: reconciled.hasMore,
            nextCursor: reconciled.nextCursor,
            totalCount: reconciled.totalCount,
          },
          scope,
        )
      }
    } catch (err) {
      if (openRequestSeqRef.current !== reqSeq || deviceGenRef.current !== gen) return
      if (!cached || !cached.messages?.length) {
        setStreamingBySession((prev) => ({
          ...prev,
          [id]: { active: false, error: String(err?.message || err) },
        }))
      }
    } finally {
      if (openRequestSeqRef.current === reqSeq && deviceGenRef.current === gen) {
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
    const gen = deviceGenRef.current
    const scope = cacheScopeRef.current
    const targetBridge = activeBridgeIdRef.current

    try {
      const res = await client.rpc(
        RPC.SESSION_READ,
        { id: targetId, limit: 14, cursor },
        45_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
      if (activeSessionRef.current?.id !== targetId || deviceGenRef.current !== gen) return
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
        void saveCachedSession(
          targetId,
          {
            meta: metaOnly,
            messages: merged,
            hasMore: nextHasMore,
            nextCursor: nextCur,
            totalCount: nextTotal,
          },
          scope,
        )
      }
    } catch (err) {
      if (deviceGenRef.current === gen) {
        setOlderError(String(err?.message || err || '加载更早历史失败'))
      }
    } finally {
      loadingOlderLockRef.current = false
      if (deviceGenRef.current === gen) {
        setLoadingOlder(false)
      }
    }
  }, [])

  // Connect WebSocket whenever the active saved computer changes
  useEffect(() => {
    if (autoPairing || !activeDevice?.token || !activeDevice?.baseUrl) {
      setConnState('disconnected')
      setBridges([])
      return
    }

    setBridges([])
    const client = new MobileRelayClient({
      baseUrl: activeDevice.baseUrl,
      token: activeDevice.token,
      bridgeId: activeDevice.selectedBridgeId || '',
    })
    clientRef.current = client

    const unsubStatus = client.onStatus(({ state, bridges: bList }) => {
      if (clientRef.current !== client) return
      setConnState(state)
      setBridges(bList || [])
    })

    const unsubEvents = client.onEvent((event, payload, rawMsg) => {
      if (clientRef.current !== client) return
      if (event === EVENTS.BRIDGE_STATUS) return

      // Strictly isolate live events to the currently selected computer bridge
      const evBridgeId = String(rawMsg?.bridgeId || '').trim()
      const curBridgeId = activeBridgeIdRef.current
      if (evBridgeId && curBridgeId && evBridgeId !== curBridgeId) {
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
          void saveCachedSession(
            sid,
            {
              meta: activeSessionRef.current,
              messages: nextList,
              hasMore: historyMetaRef.current.hasMore,
              nextCursor: historyMetaRef.current.nextCursor,
              totalCount: historyMetaRef.current.totalCount,
            },
            cacheScopeRef.current,
          )
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
      if (clientRef.current === client) {
        clientRef.current = null
      }
    }
  }, [autoPairing, activeDevice?.id, activeDevice?.token, activeDevice?.baseUrl])

  const handleSelectDevice = useCallback((deviceId, bridgeId = '') => {
    const cleanBridgeId = String(bridgeId || '').trim()
    const isSameDevice = activeDevice?.id === deviceId
    const isSameBridge = isSameDevice && (!cleanBridgeId || cleanBridgeId === activeBridgeIdRef.current)
    if (isSameBridge) return

    resetTransientWorkspace()
    if (!isSameDevice) {
      setBridges([])
    } else if (cleanBridgeId) {
      clientRef.current?.setTargetBridgeId(cleanBridgeId)
    }

    const target = devices.find((d) => d.id === deviceId)
    setDeviceState((prev) => selectDevice(prev, deviceId, cleanBridgeId || undefined))

    if (target) {
      const targetBridgeObj = isSameDevice
        ? onlineBridges.find((b) => b.bridgeId === cleanBridgeId) || null
        : null
      const name =
        isSameDevice && targetBridgeObj
          ? targetBridgeObj.hostname || targetBridgeObj.bridgeId
          : getDeviceDisplayName(target)
      showToast(`已切换到 ${name}`)
    }
  }, [activeDevice?.id, devices, onlineBridges, resetTransientWorkspace, showToast])

  const handleRenameDevice = useCallback((deviceId, customName) => {
    setDeviceState((prev) => renameDevice(prev, deviceId, customName))
  }, [])

  const handleSyncDeviceMeta = useCallback((deviceId, patch) => {
    setDeviceState((prev) => updateDeviceMeta(prev, deviceId, patch))
  }, [])

  const handleRemoveDevice = useCallback((deviceId) => {
    const target = devices.find((d) => d.id === deviceId)
    const removingActive = activeDevice?.id === deviceId
    const removingLast = devices.length <= 1
    void clearSessionCache(deviceId, { prefix: true })
    if (removingActive) {
      resetTransientWorkspace()
      setBridges([])
    }
    if (removingLast) {
      setDeviceSwitcherOpen(false)
      setDrawerOpen(false)
    }
    setDeviceState((prev) => removeDevice(prev, deviceId))
    if (target) {
      showToast(`已移除 ${getDeviceDisplayName(target)}`)
    }
  }, [activeDevice?.id, devices, resetTransientWorkspace, showToast])

  const handleCreateSession = async ({ app, cwd, title, model, provider, reasoningEffort }) => {
    const client = clientRef.current
    if (!client) throw new Error('未连接到服务器')
    const gen = deviceGenRef.current
    const targetBridge = activeBridgeIdRef.current
    const res = await client.rpc(
      RPC.SESSION_CREATE,
      {
        app,
        cwd,
        title,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
      45_000,
      targetBridge ? { bridgeId: targetBridge } : {},
    )
    if (deviceGenRef.current !== gen) return res.session
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
    const gen = deviceGenRef.current
    const scope = cacheScopeRef.current
    const targetBridge = activeBridgeIdRef.current

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
        if (deviceGenRef.current !== gen) return
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
    void saveCachedSession(
      target.id,
      {
        meta: target,
        messages: nextWithUser,
        hasMore: historyMetaRef.current.hasMore,
        nextCursor: historyMetaRef.current.nextCursor,
        totalCount: historyMetaRef.current.totalCount,
      },
      scope,
    )

    setStreamingBySession((prev) => ({
      ...prev,
      [target.id]: { active: true, text: '', thinking: '', tools: [], error: '' },
    }))

    try {
      await client.rpc(
        RPC.SESSION_SEND,
        {
          id: target.id,
          text: finalText,
          cwd: target.cwd,
          attachments,
          wait: false,
          ...(activePref.model ? { model: activePref.model } : {}),
          ...(activePref.provider ? { provider: activePref.provider } : {}),
          ...(activePref.reasoningEffort ? { reasoningEffort: activePref.reasoningEffort } : {}),
        },
        45_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
    } catch (err) {
      if (deviceGenRef.current !== gen) return
      setStreamingBySession((prev) => ({
        ...prev,
        [target.id]: { active: false, text: '', thinking: '', tools: [], error: String(err?.message || err) },
      }))
    }
  }

  const handleInterrupt = async () => {
    const client = clientRef.current
    if (!client || !activeSession) return
    const targetBridge = activeBridgeIdRef.current
    try {
      await client.rpc(
        RPC.SESSION_INTERRUPT,
        { id: activeSession.id },
        45_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
    } catch {}
  }

  const handleResolveApproval = async (id, decision) => {
    const client = clientRef.current
    if (!client) return
    const targetBridge = activeBridgeIdRef.current
    try {
      await client.rpc(
        RPC.APPROVAL_RESOLVE,
        { id, decision },
        45_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
      setApprovals((prev) => prev.filter((a) => a.id !== id))
    } catch (err) {
      alert(String(err?.message || err))
    }
  }

  const handleDirectDispatch = async ({ app, cwd, prompt }) => {
    const client = clientRef.current
    if (!client) throw new Error('未连接到服务器')
    const targetBridge = activeBridgeIdRef.current
    const res = await client.rpc(
      RPC.DISPATCH_CREATE,
      {
        app,
        cwd,
        prompt,
        wait: false,
        issuedBy: 'mobile-board',
      },
      45_000,
      targetBridge ? { bridgeId: targetBridge } : {},
    )
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
        <p className="mt-1.5 text-xs text-slate-400">独立加密房间验证中，已有电脑连接完全保留</p>
      </div>
    )
  }

  if (!activeDevice || addingDevice.open) {
    return (
      <LoginScreen
        initialError={pairError}
        isAddingDevice={Boolean(activeDevice && addingDevice.open)}
        initialServerUrl={addingDevice.serverUrl || activeDevice?.baseUrl || ''}
        autoOpenScanner={Boolean(addingDevice.open && addingDevice.openScanner)}
        onCancel={
          activeDevice
            ? () => {
                setPairError('')
                setAddingDevice({ open: false, serverUrl: '', openScanner: false })
              }
            : null
        }
        onSuccess={handleDeviceAuthenticated}
      />
    )
  }

  const activeApp = activeSession?.app || defaultApp
  const activeCatalog = modelsCatalog[activeApp] || null
  const activeModelPref = resolveModelPrefFor(activeSession)
  const activeModelObj = (activeCatalog?.models || []).find(
    (m) =>
      m.id === activeModelPref.model &&
      (!activeModelPref.provider || !m.provider || m.provider === activeModelPref.provider),
  ) || (activeCatalog?.models || []).find((m) => m.id === activeModelPref.model)
  const currentStream = activeSession ? streamingBySession[activeSession.id] : null

  const hasMultipleTargets = devices.length > 1 || onlineBridges.length > 1
  const headerSubtitle = (() => {
    if (connState === 'unauthorized') return `${activeDeviceName} · 凭证已过期`
    if (connState !== 'connected') return `${activeDeviceName} · 连接中...`
    if (!bridgeOnline) return `${activeDeviceName} · 等待上线`
    if (hasMultipleTargets) {
      return activeSession?.workspace
        ? `${activeDeviceName} · ${activeSession.workspace}`
        : activeDeviceName
    }
    return activeSession?.workspace || activeDeviceName || '电脑已在线'
  })()

  return (
    <div className="relative flex h-full w-full flex-col bg-white dark:bg-[#16171A]">
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

          <div className="flex min-w-0 flex-1 flex-col items-center text-center">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex max-w-full items-center gap-1.5"
            >
              <VendorBadge app={activeApp} size="xs" />
              <span className="truncate text-[14.5px] font-semibold text-slate-900 dark:text-white">
                {activeSession?.title || 'All in One'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setDeviceSwitcherOpen(true)}
              aria-label="切换控制的电脑"
              className="mt-0.5 inline-flex max-w-[230px] items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] text-slate-500 transition hover:bg-slate-100 active:scale-95 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  connState === 'unauthorized'
                    ? 'bg-rose-500'
                    : connState === 'connected' && bridgeOnline
                      ? 'bg-emerald-500'
                      : connState === 'connecting'
                        ? 'bg-amber-400'
                        : 'bg-rose-400'
                }`}
              />
              <span className="truncate">{headerSubtitle}</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-65" />
            </button>
          </div>

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

      {/* Expired token banner (never locks user out of other paired computers) */}
      {connState === 'unauthorized' && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-200">
          <KeyRound className="h-3.5 w-3.5 shrink-0" />
          <span>{activeDeviceName} 配对凭证已失效</span>
          <button
            type="button"
            onClick={() => setAddingDevice({ open: true, serverUrl: activeDevice.baseUrl, openScanner: false })}
            className="rounded-lg bg-rose-500 px-2.5 py-0.5 text-[11px] font-semibold text-white active:scale-95"
          >
            重新配对
          </button>
          {devices.length > 1 && (
            <button
              type="button"
              onClick={() => setDeviceSwitcherOpen(true)}
              className="rounded-lg border border-rose-300 bg-white px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
            >
              切换其他电脑
            </button>
          )}
        </div>
      )}

      {/* Offline warning bar if relay connected but target PC bridge offline */}
      {connState === 'connected' && !bridgeOnline && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>
            {onlineBridges.length > 0
              ? `当前选中的电脑（${activeDevice.selectedBridgeId}）已离线`
              : `服务器已连通，等待 ${activeDeviceName} 桥接上线...`}
          </span>
          {(devices.length > 1 || onlineBridges.length > 0) && (
            <button
              type="button"
              onClick={() => setDeviceSwitcherOpen(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-500/25 dark:text-amber-100"
            >
              <ArrowLeftRight className="h-3 w-3" />
              <span>切换电脑</span>
            </button>
          )}
        </div>
      )}

      {/* Non-intrusive toast pill */}
      {toastMsg && (
        <div className="pointer-events-none fixed top-16 left-1/2 z-[60] -translate-x-1/2">
          <div className="rounded-full bg-slate-900/90 px-4 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur-md dark:bg-white/95 dark:text-slate-900">
            {toastMsg}
          </div>
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
        onRefresh={() => loadWorkspaceData(activeBridgeId)}
        refreshing={refreshing}
        connState={connState}
        bridgeOnline={bridgeOnline}
        activeDeviceName={activeDeviceName}
        devicesCount={devices.length}
        onlineBridgesCount={onlineBridges.length}
        roomId={activeDevice?.roomId}
        cacheScope={cacheScope}
        darkMode={darkMode}
        onToggleDark={() => setDarkMode((v) => !v)}
        onOpenShare={() => setShareOpen(true)}
        onOpenDeviceSwitcher={() => setDeviceSwitcherOpen(true)}
      />

      {/* Multi-Computer Switcher & Manager Modal */}
      <DeviceSwitcherModal
        open={deviceSwitcherOpen}
        onClose={() => setDeviceSwitcherOpen(false)}
        devices={devices}
        activeDeviceId={activeDevice?.id}
        activeBridgeId={activeBridgeId}
        activeConnState={connState}
        activeBridges={bridges}
        onSelectDevice={handleSelectDevice}
        onAddDevice={(prefillServerUrl = '', opts = {}) => {
          setPairError('')
          setAddingDevice({
            open: true,
            serverUrl: prefillServerUrl || activeDevice?.baseUrl || '',
            openScanner: Boolean(opts?.openScanner),
          })
        }}
        onRenameDevice={handleRenameDevice}
        onRemoveDevice={handleRemoveDevice}
        onSyncDeviceMeta={handleSyncDeviceMeta}
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
        onRefresh={() => loadWorkspaceData(activeBridgeId)}
        onDirectDispatch={handleDirectDispatch}
        onJumpToSession={openSession}
      />
      {/* Share with Friends Modal */}
      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        serverUrl={activeDevice?.baseUrl}
      />
      {/* Full-Screen Zoomable Image Lightbox */}
      <ImageLightbox state={lightboxState} onClose={() => setLightboxState(null)} />
    </div>
  )
}

export default App
