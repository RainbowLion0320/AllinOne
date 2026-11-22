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
  listAccountDevices,
  pairWithRelay,
  probeDeviceStatus,
  removeAccountDevice,
  renameAccountDevice,
  requestMediaToken,
  revokeDeviceSessions,
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
import { InviteManagerModal } from './components/InviteManagerModal.jsx'
import { VendorBadge } from './components/VendorIcon.jsx'

export function App() {
  const [deviceState, setDeviceState] = useState(() => loadDeviceState())
  const [addingDevice, setAddingDevice] = useState({ open: false, serverUrl: '', openScanner: false, inviteCode: '' })
  const [autoPairing, setAutoPairing] = useState(false)
  const [pairError, setPairError] = useState('')
  const [toastMsg, setToastMsg] = useState('')
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('allinone_dark') === '1')
  const [connState, setConnState] = useState('disconnected')
  const [bridges, setBridges] = useState([])
  const [accountDevices, setAccountDevices] = useState([])
  const [mediaAuth, setMediaAuth] = useState({ deviceId: '', mediaToken: '', unsupported: false })

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [deviceSwitcherOpen, setDeviceSwitcherOpen] = useState(false)
  const [inviteManagerOpen, setInviteManagerOpen] = useState(false)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newChatCwd, setNewChatCwd] = useState('')
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [lightboxState, setLightboxState] = useState(null)

  const [appsStatus, setAppsStatus] = useState([])
  const [modelsCatalog, setModelsCatalog] = useState({})
  const [loadingModels, setLoadingModels] = useState(false)
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
  const [desktopBridge, setDesktopBridge] = useState(null)

  const desktopApi = typeof window !== 'undefined' ? window.allinoneDesktop || null : null
  const isMacDesktop = desktopApi?.platform === 'darwin'

  const devices = deviceState.devices
  const activeDevice = useMemo(() => getActiveDevice(deviceState), [deviceState])
  const isAccountMode = Boolean(
    activeDevice && (activeDevice.authMode === 'account' || String(activeDevice.roomId || '').startsWith('usr_')),
  )
  const isAdmin = Boolean(
    activeDevice && (activeDevice.role === 'admin' || activeDevice.roomId === 'owner'),
  )

  const onlineBridges = useMemo(() => bridges.filter((b) => b.online), [bridges])

  const activeBridge = useMemo(() => {
    if (!activeDevice || onlineBridges.length === 0) return null
    const preferredId = String(activeDevice.selectedBridgeId || '').trim()
    let chosen = null
    if (preferredId) {
      const matched = onlineBridges.find((b) => b.bridgeId === preferredId)
      if (matched) {
        chosen = matched
      } else if ((activeDevice.roomId === 'owner' || isAccountMode) && (activeSession || sessions.length > 0)) {
        // Never silently reroute mid-conversation to a different online computer
        return null
      }
    }
    if (!chosen) chosen = onlineBridges[0] || null
    if (chosen && isAccountMode) {
      const boundMeta = accountDevices.find((d) => d.bridgeId === chosen.bridgeId)
      if (boundMeta?.label) {
        return { ...chosen, label: boundMeta.label }
      }
    }
    return chosen
  }, [activeDevice, onlineBridges, activeSession, sessions.length, isAccountMode, accountDevices])

  const bridgeOnline = Boolean(activeBridge)
  const activeBridgeId = activeBridge?.bridgeId || ''
  const activeDeviceName = useMemo(() => {
    if (isAccountMode && !activeBridge && activeDevice?.selectedBridgeId) {
      const bound = accountDevices.find((d) => d.bridgeId === activeDevice.selectedBridgeId)
      if (bound) return bound.label || bound.hostname || bound.bridgeId
    }
    return getDeviceDisplayName(activeDevice, activeBridge, onlineBridges.length)
  }, [activeDevice, activeBridge, onlineBridges.length, isAccountMode, accountDevices])
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
  const quietSyncInFlightRef = useRef(false)
  const quietSyncPendingRef = useRef('')
  const lastFocusSyncAtRef = useRef(0)
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

  // Electron Desktop App integration: live local bridge status + menu shortcuts + keyboard shortcuts
  useEffect(() => {
    if (!desktopApi) return
    let unsubStatus = null
    let unsubMenu = null
    desktopApi.getBridgeStatus?.().then((st) => {
      if (st) setDesktopBridge(st)
    }).catch(() => {})
    if (typeof desktopApi.onBridgeStatus === 'function') {
      unsubStatus = desktopApi.onBridgeStatus((st) => setDesktopBridge(st))
    }
    if (typeof desktopApi.onMenuAction === 'function') {
      unsubMenu = desktopApi.onMenuAction((action) => {
        if (action === 'new-chat') setNewChatOpen(true)
        else if (action === 'devices') setDeviceSwitcherOpen(true)
        else if (action === 'share') setShareOpen(true)
        else if (action === 'invites') setInviteManagerOpen(true)
        else if (action === 'toggle-dark') setDarkMode((v) => !v)
      })
    }
    return () => {
      try { unsubStatus?.() } catch {}
      try { unsubMenu?.() } catch {}
    }
  }, [desktopApi])

  const hadDesktopAccountRef = useRef(false)
  // Auto-bind & run embedded local PC bridge whenever signed into an account inside Desktop App
  useEffect(() => {
    if (!desktopApi) return
    if (
      activeDevice?.token &&
      activeDevice?.baseUrl &&
      (activeDevice.authMode === 'account' || String(activeDevice.roomId || '').startsWith('usr_'))
    ) {
      hadDesktopAccountRef.current = true
      desktopApi
        .syncAccount?.({
          baseUrl: activeDevice.baseUrl,
          token: activeDevice.token,
          roomId: activeDevice.roomId,
          username: activeDevice.username || '',
        })
        .then((st) => {
          if (st) setDesktopBridge(st)
        })
        .catch(() => {})
    } else if (!activeDevice && hadDesktopAccountRef.current) {
      // Only stop the local bridge on explicit logout (never on initial boot before UI login!)
      hadDesktopAccountRef.current = false
      desktopApi.stopBridge?.().catch(() => {})
    }
  }, [desktopApi, activeDevice?.id, activeDevice?.token, activeDevice?.baseUrl, activeDevice?.roomId, activeDevice?.username, activeDevice?.authMode])

  // Desktop keyboard shortcuts (Cmd/Ctrl+N new chat, Cmd/Ctrl+K switch computer, Esc close modals)
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'n' && activeDevice) {
          e.preventDefault()
          setNewChatOpen(true)
          return
        }
        if (k === 'k' && activeDevice) {
          e.preventDefault()
          setDeviceSwitcherOpen((v) => !v)
          return
        }
      }
      if (e.key === 'Escape') {
        if (lightboxState) setLightboxState(null)
        else if (modelPickerOpen) setModelPickerOpen(false)
        else if (newChatOpen) setNewChatOpen(false)
        else if (deviceSwitcherOpen) setDeviceSwitcherOpen(false)
        else if (inviteManagerOpen) setInviteManagerOpen(false)
        else if (shareOpen) setShareOpen(false)
        else if (dispatchOpen) setDispatchOpen(false)
        else if (drawerOpen) setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDevice, lightboxState, modelPickerOpen, newChatOpen, deviceSwitcherOpen, inviteManagerOpen, shareOpen, dispatchOpen, drawerOpen])

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
    setBridges(Array.isArray(payload.bridges) ? payload.bridges : [])
    setAccountDevices(Array.isArray(payload.devices) ? payload.devices : [])
    setDeviceState((prev) => upsertDevice(prev, payload).state)
    setAddingDevice({ open: false, serverUrl: '', openScanner: false, inviteCode: '' })
    setDeviceSwitcherOpen(false)
    if (preview.device) {
      if (payload.authMode === 'account') {
        const onlineN = (payload.devices || payload.bridges || []).filter((x) => x.online).length
        showToast(
          onlineN > 0
            ? `已登录 @${payload.username} · 发现 ${onlineN} 台在线电脑`
            : `已登录 @${payload.username}`,
        )
      } else {
        const name = getDeviceDisplayName(preview.device)
        showToast(preview.isNew ? `已添加并切换到 ${name}` : `已更新并切换到 ${name}`)
      }
    }
  }, [resetTransientWorkspace, showToast])

  // Auto-handle QR code link (?pair=pt_xxx / ?code=XXXX-XXXX) or Invite Registration link (?invite=INV-XXXX-XXXX)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const inviteCode = (params.get('invite') || '').trim()
    const pairToken = (params.get('pair') || '').trim()
    const pairCode = (params.get('code') || '').trim()
    if (!inviteCode && !pairToken && !pairCode) return

    // Strip sensitive params from address bar immediately
    params.delete('invite')
    params.delete('pair')
    params.delete('code')
    const cleanQuery = params.toString()
    const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash || ''}`
    try { window.history.replaceState({}, '', cleanUrl) } catch {}

    if (inviteCode) {
      setPairError('')
      setAddingDevice({
        open: true,
        serverUrl: detectDefaultServerUrl(),
        openScanner: false,
        inviteCode,
      })
      return
    }

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
          setAddingDevice({ open: true, serverUrl: detectDefaultServerUrl(), openScanner: false, inviteCode: '' })
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

  // Mint and auto-refresh a short-lived 15-min read-only media token so the 30-day master JWT never appears in image URLs
  useEffect(() => {
    if (!activeDevice?.id || !activeDevice?.baseUrl || !activeDevice?.token || connState === 'unauthorized') {
      setMediaAuth({ deviceId: '', mediaToken: '', unsupported: false })
      return
    }
    let cancelled = false
    let expiresAt = 0
    const deviceId = activeDevice.id
    const baseUrl = activeDevice.baseUrl
    const token = activeDevice.token

    const refresh = () => {
      requestMediaToken(baseUrl, token)
        .then((res) => {
          if (cancelled) return
          expiresAt = res.expiresAt || 0
          setMediaAuth({
            deviceId,
            mediaToken: res.mediaToken || '',
            unsupported: Boolean(res.unsupported),
          })
        })
        .catch(() => {})
    }

    const onWake = () => {
      if (document.visibilityState === 'visible' && (!expiresAt || Date.now() > expiresAt - 5 * 60 * 1000)) {
        refresh()
      }
    }

    refresh()
    const timer = setInterval(refresh, 10 * 60 * 1000)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, connState])

  const imageContext = useMemo(() => {
    const matched = mediaAuth.deviceId === activeDevice?.id
    return {
      baseUrl: activeDevice?.baseUrl || '',
      mediaToken: matched ? mediaAuth.mediaToken : '',
      token: matched && mediaAuth.unsupported ? activeDevice?.token || '' : '',
      cwd: activeSession?.cwd || '',
      bridgeId: activeBridgeId,
      onOpenImage: setLightboxState,
    }
  }, [
    activeDevice?.id,
    activeDevice?.baseUrl,
    activeDevice?.token,
    mediaAuth.deviceId,
    mediaAuth.mediaToken,
    mediaAuth.unsupported,
    activeSession?.cwd,
    activeBridgeId,
  ])

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

  // Auto-sync app readiness & model catalog whenever the active bridge broadcasts updated meta.apps
  // (e.g. after background auto-completion finishes installing a missing CLI like `agy` / `claude` / `codex`).
  const activeBridgeMetaApps = useMemo(() => {
    const matched = bridges.find((b) => b.bridgeId === activeBridgeId && b.online !== false)
    return Array.isArray(matched?.meta?.apps) ? matched.meta.apps : null
  }, [bridges, activeBridgeId])

  const activeBridgeAppsSig = useMemo(() => {
    if (!activeBridgeMetaApps || activeBridgeMetaApps.length === 0) return ''
    return activeBridgeMetaApps
      .map((a) => `${a.app}:${a.available ? 1 : 0}:${a.writable ? 1 : 0}`)
      .join('|')
  }, [activeBridgeMetaApps])

  const lastMetaAppsSigRef = useRef('')
  useEffect(() => {
    if (!activeBridgeAppsSig || connState !== 'connected' || !activeBridgeId) return
    const key = `${activeBridgeId}::${activeBridgeAppsSig}`
    if (lastMetaAppsSigRef.current === key) return
    const prevKey = lastMetaAppsSigRef.current
    lastMetaAppsSigRef.current = key
    if (activeBridgeMetaApps) {
      setAppsStatus(activeBridgeMetaApps)
    }
    // If readiness changed mid-session on the same bridge, quietly refresh model catalog too
    if (prevKey && prevKey.startsWith(`${activeBridgeId}::`)) {
      const client = clientRef.current
      if (client) {
        client
          .rpc(RPC.MODELS_LIST, {}, 45_000, { bridgeId: activeBridgeId })
          .then((res) => {
            if (res?.catalog && Object.keys(res.catalog).length > 0) {
              setModelsCatalog(res.catalog)
            }
          })
          .catch(() => {})
      }
    }
  }, [activeBridgeAppsSig, activeBridgeMetaApps, activeBridgeId, connState])

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

  const syncActiveSessionQuietly = useCallback(async (sessionId = '') => {
    const client = clientRef.current
    const targetId = sessionId || activeSessionRef.current?.id || ''
    if (!client || !targetId) return
    if (streamingRef.current[targetId]?.active || loadingOlderLockRef.current) return
    if (quietSyncInFlightRef.current) {
      quietSyncPendingRef.current = targetId
      return
    }

    quietSyncInFlightRef.current = true
    const gen = deviceGenRef.current
    const scope = cacheScopeRef.current
    const targetBridge = activeBridgeIdRef.current
    try {
      const res = await client.rpc(
        RPC.SESSION_READ,
        { id: targetId, limit: 14 },
        30_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
      if (
        deviceGenRef.current !== gen ||
        activeSessionRef.current?.id !== targetId ||
        streamingRef.current[targetId]?.active
      ) {
        return
      }
      if (res?.session) {
        const { messages: freshMsgs = [], hasMore, nextCursor, totalCount, ...metaOnly } = res.session
        const currentSnapshot = {
          messages: messagesRef.current,
          hasMore: historyMetaRef.current.hasMore,
          nextCursor: historyMetaRef.current.nextCursor,
          totalCount: historyMetaRef.current.totalCount,
        }
        const reconciled = reconcileCachedWithFreshPage(currentSnapshot, {
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
        setSessions((prev) =>
          prev.map((s) =>
            s.id === targetId
              ? { ...s, status: res.session.status || s.status, title: res.session.title || s.title }
              : s,
          ),
        )
        void saveCachedSession(
          targetId,
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
    } catch {
      // Quiet background sync errors should never disrupt active reading
    } finally {
      quietSyncInFlightRef.current = false
      const pendingId = quietSyncPendingRef.current
      quietSyncPendingRef.current = ''
      if (
        pendingId &&
        deviceGenRef.current === gen &&
        activeSessionRef.current?.id === pendingId &&
        !streamingRef.current[pendingId]?.active
      ) {
        void syncActiveSessionQuietly(pendingId)
      }
    }
  }, [])

  // Auto-sync the open session whenever user switches back to All in One (Desktop focus or mobile resume)
  useEffect(() => {
    const triggerFocusSync = () => {
      if (document.visibilityState === 'hidden') return
      if (connState !== 'connected' || !activeBridgeIdRef.current) return
      const now = Date.now()
      if (now - lastFocusSyncAtRef.current < 1_500) return
      lastFocusSyncAtRef.current = now
      const curId = activeSessionRef.current?.id
      if (curId && !streamingRef.current[curId]?.active) {
        void syncActiveSessionQuietly(curId)
      }
    }
    window.addEventListener('focus', triggerFocusSync)
    document.addEventListener('visibilitychange', triggerFocusSync)
    return () => {
      window.removeEventListener('focus', triggerFocusSync)
      document.removeEventListener('visibilitychange', triggerFocusSync)
    }
  }, [connState, syncActiveSessionQuietly])

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

  // Connect WebSocket whenever the active saved computer/account changes
  useEffect(() => {
    if (autoPairing || !activeDevice?.token || !activeDevice?.baseUrl) {
      setConnState('disconnected')
      setBridges([])
      setAccountDevices([])
      return
    }

    setBridges([])
    if (!(activeDevice.authMode === 'account' || String(activeDevice.roomId || '').startsWith('usr_'))) {
      setAccountDevices([])
    } else {
      // Also refresh persisted account profile (role/username/devices) cleanly on mount/switch
      probeDeviceStatus(activeDevice, 5000)
        .then((res) => {
          if (Array.isArray(res.devices)) setAccountDevices(res.devices)
          if (res.username || res.role) {
            setDeviceState((prev) =>
              updateDeviceMeta(prev, activeDevice.id, {
                ...(res.username ? { username: res.username } : {}),
                ...(res.role ? { role: res.role } : {}),
              }),
            )
          }
        })
        .catch(() => {})
    }

    const client = new MobileRelayClient({
      baseUrl: activeDevice.baseUrl,
      token: activeDevice.token,
      bridgeId: activeDevice.selectedBridgeId || '',
    })
    clientRef.current = client

    const unsubStatus = client.onStatus(({ state, bridges: bList, devices: dList }) => {
      if (clientRef.current !== client) return
      setConnState(state)
      setBridges(bList || [])
      if (Array.isArray(dList)) setAccountDevices(dList)
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
        const updated = payload.session
        setSessions((prev) => {
          const next = [updated, ...prev.filter((s) => s.id !== updated.id)]
          next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          return next
        })
        if (activeSessionRef.current?.id === updated.id) {
          setActiveSession((prev) => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev))
          if ((payload.historyChanged || payload.statusChanged) && !streamingRef.current[updated.id]?.active) {
            void syncActiveSessionQuietly(updated.id)
          }
        }
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
        // Reconcile optimistic msg-u/msg-a IDs with authoritative disk transcript & syncState shortly after turn settles
        setTimeout(() => {
          if (activeSessionRef.current?.id === sid && !streamingRef.current[sid]?.active) {
            void syncActiveSessionQuietly(sid)
          }
        }, 1200)
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
    const curSelectedBridge = activeDevice?.selectedBridgeId || activeBridgeIdRef.current
    const isSameBridge = isSameDevice && (!cleanBridgeId || cleanBridgeId === curSelectedBridge)
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
      const targetAcctPc = isSameDevice
        ? accountDevices.find((d) => d.bridgeId === cleanBridgeId) || null
        : null
      const targetBridgeObj = isSameDevice
        ? onlineBridges.find((b) => b.bridgeId === cleanBridgeId) || null
        : null
      const name =
        isSameDevice && (targetAcctPc || targetBridgeObj)
          ? targetAcctPc?.label || targetBridgeObj?.label || targetBridgeObj?.hostname || cleanBridgeId
          : getDeviceDisplayName(target)
      showToast(`已切换到 ${name}`)
    }
  }, [activeDevice?.id, activeDevice?.selectedBridgeId, devices, accountDevices, onlineBridges, resetTransientWorkspace, showToast])

  const handleRenameDevice = useCallback((deviceId, customName) => {
    setDeviceState((prev) => renameDevice(prev, deviceId, customName))
  }, [])

  const handleSyncDeviceMeta = useCallback((deviceId, patch) => {
    setDeviceState((prev) => updateDeviceMeta(prev, deviceId, patch))
  }, [])

  const handleRenameAccountDevice = useCallback(async (pcDeviceId, newLabel) => {
    if (!activeDevice?.baseUrl || !activeDevice?.token) return
    try {
      const nextList = await renameAccountDevice(activeDevice.baseUrl, activeDevice.token, {
        deviceId: pcDeviceId,
        label: newLabel,
      })
      setAccountDevices(nextList)
      showToast(`已重命名为 ${newLabel}`)
    } catch (err) {
      showToast(String(err?.message || err))
    }
  }, [activeDevice?.baseUrl, activeDevice?.token, showToast])

  const handleRemoveAccountDevice = useCallback(async (pcDeviceId, pcBridgeId = '') => {
    if (!activeDevice?.baseUrl || !activeDevice?.token) return
    try {
      const nextList = await removeAccountDevice(activeDevice.baseUrl, activeDevice.token, {
        deviceId: pcDeviceId,
      })
      setAccountDevices(nextList)
      if (pcBridgeId && activeBridgeIdRef.current === pcBridgeId) {
        resetTransientWorkspace()
        setDeviceState((prev) =>
          updateDeviceMeta(prev, activeDevice.id, { selectedBridgeId: '' }),
        )
      }
      showToast('已解绑并断开该电脑')
    } catch (err) {
      showToast(String(err?.message || err))
    }
  }, [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, resetTransientWorkspace, showToast])

  const handleRefreshAccountDevices = useCallback(async () => {
    if (!activeDevice?.baseUrl || !activeDevice?.token || !isAccountMode) return
    try {
      const res = await listAccountDevices(activeDevice.baseUrl, activeDevice.token)
      setAccountDevices(res.devices)
    } catch {}
  }, [activeDevice?.baseUrl, activeDevice?.token, isAccountMode])

  const handleRemoveDevice = useCallback(async (deviceId, { revokeAll = false } = {}) => {
    const target = devices.find((d) => d.id === deviceId)
    if (revokeAll && target?.baseUrl && target?.token) {
      try {
        await revokeDeviceSessions(target.baseUrl, target.token)
      } catch {}
    }
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
      const name = getDeviceDisplayName(target)
      showToast(revokeAll ? `已吊销 ${name} 全部手机凭证并移除` : `已移除 ${name}`)
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
          <span>正在配对...</span>
        </div>
      </div>
    )
  }

  if (!activeDevice || addingDevice.open) {
    return (
      <LoginScreen
        initialError={pairError}
        isAddingDevice={Boolean(activeDevice && addingDevice.open)}
        initialServerUrl={addingDevice.serverUrl || activeDevice?.baseUrl || ''}
        initialInviteCode={addingDevice.inviteCode || ''}
        autoOpenScanner={Boolean(addingDevice.open && addingDevice.openScanner)}
        onCancel={
          activeDevice
            ? () => {
                setPairError('')
                setAddingDevice({ open: false, serverUrl: '', openScanner: false, inviteCode: '' })
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

  const hasMultipleTargets = devices.length > 1 || onlineBridges.length > 1 || accountDevices.length > 1
  const headerSubtitle = (() => {
    if (connState === 'unauthorized') return `${activeDeviceName} · 已过期`
    if (connState !== 'connected') return `${activeDeviceName} · 连接中`
    if (!bridgeOnline) return `${activeDeviceName} · 离线`
    if (hasMultipleTargets) {
      return activeSession?.workspace
        ? `${activeDeviceName} · ${activeSession.workspace}`
        : activeDeviceName
    }
    return activeSession?.workspace || activeDeviceName || '已连接'
  })()

  return (
    <div className="relative flex h-full w-full bg-white dark:bg-[#16171A]">
      {/* Responsive Sidebar (slide-over drawer on mobile, docked left column on desktop lg:) */}
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
        devicesCount={isAccountMode ? Math.max(accountDevices.length, onlineBridges.length) : devices.length}
        onlineBridgesCount={onlineBridges.length}
        roomId={activeDevice?.roomId}
        username={activeDevice?.username || ''}
        isAdmin={isAdmin}
        isMacDesktop={isMacDesktop}
        cacheScope={cacheScope}
        darkMode={darkMode}
        onToggleDark={() => setDarkMode((v) => !v)}
        onOpenShare={() => setShareOpen(true)}
        onOpenDeviceSwitcher={() => setDeviceSwitcherOpen(true)}
        onOpenInviteManager={() => setInviteManagerOpen(true)}
      />

      {/* Right Main Column */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-white dark:bg-[#16171A]">
      {/* Minimal top header */}
      <header className="app-drag pt-safe shrink-0 border-b border-slate-100 bg-white/85 px-3 pb-2.5 backdrop-blur-md dark:border-slate-800/80 dark:bg-[#16171A]/85">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 lg:max-w-3xl">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开对话列表"
            className="app-no-drag relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 lg:hidden dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Menu className="h-5 w-5" />
            {approvals.length > 0 && (
              <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-rose-500" />
            )}
          </button>

          <div className="app-no-drag flex min-w-0 flex-1 flex-col items-center text-center">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex max-w-full items-center gap-1.5 lg:pointer-events-none"
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
              className="mt-0.5 inline-flex max-w-[260px] items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] text-slate-500 transition hover:bg-slate-100 active:scale-95 dark:text-slate-400 dark:hover:bg-slate-800"
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
            className="app-no-drag flex h-9 w-9 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <SquarePen className="h-4.5 w-4.5" />
          </button>
        </div>
      </header>

      {/* Expired token banner */}
      {connState === 'unauthorized' && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-200">
          <KeyRound className="h-3.5 w-3.5 shrink-0" />
          <span>登录已过期</span>
          <button
            type="button"
            onClick={() => setAddingDevice({ open: true, serverUrl: activeDevice.baseUrl, openScanner: false, inviteCode: '' })}
            className="rounded-lg bg-rose-500 px-2.5 py-0.5 text-[11px] font-semibold text-white active:scale-95"
          >
            {isAccountMode ? '重新登录' : '重新配对'}
          </button>
          {devices.length > 1 && (
            <button
              type="button"
              onClick={() => setDeviceSwitcherOpen(true)}
              className="rounded-lg border border-rose-300 bg-white px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
            >
              切换
            </button>
          )}
        </div>
      )}

      {/* Offline warning bar if relay connected but target PC bridge offline */}
      {connState === 'connected' && !bridgeOnline && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>
            {isAccountMode && accountDevices.length === 0
              ? '尚未绑定电脑'
              : `${activeDeviceName} 离线`}
          </span>
          {(devices.length > 1 || onlineBridges.length > 0 || isAccountMode) && (
            <button
              type="button"
              onClick={() => setDeviceSwitcherOpen(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-500/25 dark:text-amber-100"
            >
              <ArrowLeftRight className="h-3 w-3" />
              <span>{isAccountMode && accountDevices.length === 0 ? '绑定' : '切换'}</span>
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
        onOpenModelPicker={() => {
          setModelPickerOpen(true)
          const curModels = modelsCatalog?.[activeApp]?.models || []
          if (curModels.length === 0 && clientRef.current && connState === 'connected' && activeBridgeId) {
            setLoadingModels(true)
            clientRef.current
              .rpc(RPC.MODELS_LIST, { app: activeApp }, 25_000, { bridgeId: activeBridgeId })
              .then((res) => {
                if (res?.catalog) {
                  setModelsCatalog((prev) => ({ ...prev, ...res.catalog }))
                }
              })
              .catch(() => {})
              .finally(() => setLoadingModels(false))
          }
        }}
        imageContext={imageContext}
        onUploadFile={(file) => clientRef.current?.uploadFile(file)}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
      />
      </div>

      {/* Multi-Computer Switcher & Account Device Manager Modal */}
      <DeviceSwitcherModal
        open={deviceSwitcherOpen}
        onClose={() => setDeviceSwitcherOpen(false)}
        devices={devices}
        activeDeviceId={activeDevice?.id}
        activeBridgeId={activeBridgeId}
        activeConnState={connState}
        activeBridges={bridges}
        accountDevices={accountDevices}
        isAdmin={isAdmin}
        desktopBridge={desktopBridge}
        onToggleDesktopBridge={
          desktopApi
            ? () => {
                desktopApi.toggleBridge?.().then((st) => st && setDesktopBridge(st)).catch(() => {})
              }
            : null
        }
        onToggleDesktopAutoLaunch={
          desktopApi
            ? () => {
                desktopApi.toggleAutoLaunch?.().then((st) => st && setDesktopBridge(st)).catch(() => {})
              }
            : null
        }
        onSelectDevice={handleSelectDevice}
        onAddDevice={(prefillServerUrl = '', opts = {}) => {
          setPairError('')
          setAddingDevice({
            open: true,
            serverUrl: prefillServerUrl || activeDevice?.baseUrl || '',
            openScanner: Boolean(opts?.openScanner),
            inviteCode: '',
          })
        }}
        onRenameDevice={handleRenameDevice}
        onRemoveDevice={handleRemoveDevice}
        onSyncDeviceMeta={handleSyncDeviceMeta}
        onRenameAccountDevice={handleRenameAccountDevice}
        onRemoveAccountDevice={handleRemoveAccountDevice}
        onRefreshAccountDevices={handleRefreshAccountDevices}
        onOpenInviteManager={() => setInviteManagerOpen(true)}
      />

      {/* Admin Single-Use Invite Code Manager */}
      <InviteManagerModal
        open={inviteManagerOpen}
        onClose={() => setInviteManagerOpen(false)}
        baseUrl={activeDevice?.baseUrl}
        token={activeDevice?.token}
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
        loading={loadingModels}
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
        token={activeDevice?.token}
        isAdmin={isAdmin}
        onOpenInviteManager={() => setInviteManagerOpen(true)}
      />
      {/* Full-Screen Zoomable Image Lightbox */}
      <ImageLightbox state={lightboxState} onClose={() => setLightboxState(null)} />
    </div>
  )
}

export default App
