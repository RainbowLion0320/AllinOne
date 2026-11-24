import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APP_META, EVENTS, RPC } from '@allinone/shared'
import {
  ArrowLeftRight,
  ChevronDown,
  KeyRound,
  Loader2,
  Lock,
  Menu,
  ScanLine,
  ShieldCheck,
  Smartphone,
  SquarePen,
  WifiOff,
} from 'lucide-react'
import { computeGrantPubKeyFp, formatE2eeFingerprint } from '@allinone/shared/e2ee'
import { clearE2eeMediaCache } from './lib/e2eeMedia.js'
import {
  MobileRelayClient,
  bindAccountEmail,
  detectDefaultServerUrl,
  fetchAuthSessions,
  listAccountDevices,
  probeDeviceStatus,
  removeAccountDevice,
  renameAccountDevice,
  requestMediaToken,
  revokeAuthSession,
  revokeDeviceSessions,
  revokeOtherAuthSessions,
  sendEmailVerificationCode,
  setAccountLogin2fa,
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
  upsertDeviceE2eeKey,
} from './lib/deviceStore.js'
import {
  clearSessionCache,
  loadCachedSession,
  mergeSessionMessages,
  reconcileCachedWithFreshPage,
  saveCachedSession,
} from './lib/sessionCache.js'
import {
  clearDraftsForScope,
  loadLastSessionId,
  loadLastWorkspace,
  makeDraftKey,
  saveLastSessionId,
  saveLastWorkspace,
} from './lib/draftStore.js'
import { LoginScreen } from './components/LoginScreen.jsx'
import { SidebarDrawer } from './components/SidebarDrawer.jsx'
import { ChatView } from './components/ChatView.jsx'
import { Composer } from './components/Composer.jsx'
import { NewChatModal } from './components/NewChatModal.jsx'
import { ModelPickerSheet } from './components/ModelPickerSheet.jsx'
import { ImageLightbox } from './components/ImageLightbox.jsx'
import { ShareModal } from './components/ShareModal.jsx'
import { DeviceSwitcherModal } from './components/DeviceSwitcherModal.jsx'
import { InviteManagerModal } from './components/InviteManagerModal.jsx'
import { SettingsModal } from './components/SettingsModal.jsx'
import { E2eeSyncModal } from './components/E2eeSyncModal.jsx'
import { E2eeGrantApproveModal } from './components/E2eeGrantApproveModal.jsx'
import { VendorBadge } from './components/VendorIcon.jsx'
import { useI18n } from './lib/i18n.jsx'
import { bi as biLang, getCurrentLang } from './lib/i18n.js'

export function App() {
  const { lang, bi, t } = useI18n()
  const [deviceState, setDeviceState] = useState(() => loadDeviceState())
  const [addingDevice, setAddingDevice] = useState({ open: false, serverUrl: '', openScanner: false, inviteCode: '' })
  const [pairError, setPairError] = useState('')
  const [toastMsg, setToastMsg] = useState('')
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('allinone_dark') === '1')
  const [connState, setConnState] = useState('disconnected')
  const [bridges, setBridges] = useState([])
  const [accountDevices, setAccountDevices] = useState([])
  const [clientSessions, setClientSessions] = useState({
    supported: true,
    sessions: [],
    onlineCount: 0,
    onlineDeviceCount: 0,
    totalCount: 0,
  })
  const [liveOnlineClientCount, setLiveOnlineClientCount] = useState(0)
  const [serverEmailEnabled, setServerEmailEnabled] = useState(false)
  const [pendingGrantPopup, setPendingGrantPopup] = useState(null)
  const [mediaAuth, setMediaAuth] = useState({ deviceId: '', mediaToken: '' })

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [deviceSwitcherOpen, setDeviceSwitcherOpen] = useState(false)
  const [inviteManagerOpen, setInviteManagerOpen] = useState(false)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newChatCwd, setNewChatCwd] = useState('')
  const [newChatApp, setNewChatApp] = useState('')
  const [sidebarFilterApp, setSidebarFilterApp] = useState('all')
  const [selectedDraftApp, setSelectedDraftApp] = useState('')
  const [selectedDraftCwd, setSelectedDraftCwd] = useState('')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [e2eeModal, setE2eeModal] = useState({ open: false, tab: 'auto', autoOpenScanner: false })
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

  const [streamingBySession, setStreamingBySession] = useState({})
  const [approvals, setApprovals] = useState([])
  const [desktopBridge, setDesktopBridge] = useState(null)
  const [updateState, setUpdateState] = useState(null)

  const desktopApi = typeof window !== 'undefined' ? window.allinoneDesktop || null : null
  const isMacDesktop = desktopApi?.platform === 'darwin'

  const devices = deviceState.devices
  const activeDevice = useMemo(() => getActiveDevice(deviceState), [deviceState])
  const isAccountMode = Boolean(activeDevice && String(activeDevice.roomId || '').startsWith('usr_'))
  const isAdmin = Boolean(activeDevice && activeDevice.role === 'admin')

  const onlineBridges = useMemo(() => bridges.filter((b) => b.online), [bridges])

  const activeBridge = useMemo(() => {
    if (!activeDevice || onlineBridges.length === 0) return null
    const preferredId = String(activeDevice.selectedBridgeId || '').trim()
    let chosen = null
    if (preferredId) {
      const matched = onlineBridges.find((b) => b.bridgeId === preferredId)
      if (matched) {
        chosen = matched
      } else if (activeSession || sessions.length > 0) {
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
    return getDeviceDisplayName(activeDevice, activeBridge, onlineBridges.length, lang)
  }, [activeDevice, activeBridge, onlineBridges.length, isAccountMode, accountDevices, lang])
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
  const autoOpenedScopeRef = useRef('')
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

  const openNewChatModal = useCallback((cwdHint = '', appHint = '') => {
    const cleanCwd = typeof cwdHint === 'string' ? cwdHint : ''
    const cleanApp = typeof appHint === 'string' ? appHint : ''
    const isWritableApp = (id) => Boolean(id && appsStatus.find((a) => a.app === id && a.writable))
    const fallbackApp =
      (isWritableApp(activeSessionRef.current?.app) ? activeSessionRef.current.app : '') ||
      (isWritableApp(selectedDraftApp) ? selectedDraftApp : '') ||
      ''
    const resolvedApp =
      cleanApp ||
      (sidebarFilterApp !== 'all' ? sidebarFilterApp : '') ||
      fallbackApp
    setNewChatCwd(cleanCwd)
    setNewChatApp(resolvedApp)
    setNewChatOpen(true)
    // Silently refresh live app readiness (e.g. if DeepSeek Harness just started and opened local IPC)
    const client = clientRef.current
    if (client) {
      const targetBridge = String(activeBridgeIdRef.current || '').trim()
      const gen = deviceGenRef.current
      client
        .rpc(RPC.APPS_STATUS, {}, 12_000, targetBridge ? { bridgeId: targetBridge } : {})
        .then((res) => {
          if (deviceGenRef.current === gen && Array.isArray(res?.apps) && res.apps.length > 0) {
            setAppsStatus(res.apps)
          }
        })
        .catch(() => {})
    }
  }, [sidebarFilterApp, selectedDraftApp, appsStatus])

  // Electron Desktop App integration: live local bridge status + auto-updater + menu shortcuts
  useEffect(() => {
    if (!desktopApi) return
    let unsubStatus = null
    let unsubMenu = null
    let unsubUpdate = null
    desktopApi.getBridgeStatus?.().then((st) => {
      if (st) setDesktopBridge(st)
    }).catch(() => {})
    desktopApi.getUpdateState?.().then((st) => {
      if (st) setUpdateState(st)
    }).catch(() => {})
    if (typeof desktopApi.onBridgeStatus === 'function') {
      unsubStatus = desktopApi.onBridgeStatus((st) => setDesktopBridge(st))
    }
    if (typeof desktopApi.onUpdateState === 'function') {
      unsubUpdate = desktopApi.onUpdateState((st) => setUpdateState(st))
    }
    if (typeof desktopApi.onMenuAction === 'function') {
      unsubMenu = desktopApi.onMenuAction((action) => {
        if (action === 'new-chat') openNewChatModal(activeSessionRef.current?.cwd || '')
        else if (action === 'devices') setDeviceSwitcherOpen(true)
        else if (action === 'settings') setSettingsOpen(true)
        else if (action === 'share') setShareOpen(true)
        else if (action === 'invites') setInviteManagerOpen(true)
        else if (action === 'toggle-dark') setDarkMode((v) => !v)
      })
    }
    return () => {
      try { unsubStatus?.() } catch {}
      try { unsubUpdate?.() } catch {}
      try { unsubMenu?.() } catch {}
    }
  }, [desktopApi, openNewChatModal])

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
          return desktopApi.getE2eeInfo?.(activeDevice.roomId)
        })
        .then((info) => {
          if (info?.enabled && info.key && info.keyId && activeDevice?.id) {
            setDeviceState((prev) => upsertDeviceE2eeKey(prev, activeDevice.id, info.keyId, info.key))
          }
        })
        .catch(() => {})
    } else if (!activeDevice && hadDesktopAccountRef.current) {
      // Only stop the local bridge on explicit logout (never on initial boot before UI login!)
      hadDesktopAccountRef.current = false
      desktopApi.stopBridge?.().catch(() => {})
    }
  }, [desktopApi, activeDevice?.id, activeDevice?.token, activeDevice?.baseUrl, activeDevice?.roomId, activeDevice?.username, activeDevice?.authMode])

  // Keep Desktop UI's local E2EE key ring synced with the embedded bridge key (zero friction on the host PC!)
  useEffect(() => {
    if (!desktopApi || !activeDevice?.id || !activeDevice?.roomId?.startsWith('usr_')) return
    let cancelled = false
    desktopApi
      .getE2eeInfo?.(activeDevice.roomId)
      .then((info) => {
        if (cancelled || !info?.enabled || !info.key || !info.keyId) return
        setDeviceState((prev) => upsertDeviceE2eeKey(prev, activeDevice.id, info.keyId, info.key))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [desktopApi, activeDevice?.id, activeDevice?.roomId, desktopBridge?.e2eeKeyId, desktopBridge?.state])

  // Desktop keyboard shortcuts (Cmd/Ctrl+N new chat, Cmd/Ctrl+K switch computer, Esc close modals)
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'n' && activeDevice) {
          e.preventDefault()
          openNewChatModal(activeSessionRef.current?.cwd || selectedDraftCwd || '')
          return
        }
        if (k === 'k' && activeDevice) {
          e.preventDefault()
          setDeviceSwitcherOpen((v) => !v)
          return
        }
        if (k === ',' && activeDevice) {
          e.preventDefault()
          setSettingsOpen((v) => !v)
          return
        }
      }
      if (e.key === 'Escape') {
        if (lightboxState) setLightboxState(null)
        else if (e2eeModal.open) setE2eeModal((prev) => ({ ...prev, open: false }))
        else if (modelPickerOpen) setModelPickerOpen(false)
        else if (newChatOpen) setNewChatOpen(false)
        else if (settingsOpen) setSettingsOpen(false)
        else if (deviceSwitcherOpen) setDeviceSwitcherOpen(false)
        else if (inviteManagerOpen) setInviteManagerOpen(false)
        else if (shareOpen) setShareOpen(false)
        else if (drawerOpen) setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDevice, openNewChatModal, selectedDraftCwd, lightboxState, e2eeModal.open, modelPickerOpen, newChatOpen, settingsOpen, deviceSwitcherOpen, inviteManagerOpen, shareOpen, drawerOpen])

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
    setSelectedDraftApp('')
    setSelectedDraftCwd('')
    autoOpenedScopeRef.current = ''
    setWorkspaces([])
    setSessions([])
    setStreamingBySession({})
    setApprovals([])
    setNewChatOpen(false)
    setNewChatCwd('')
    setNewChatApp('')
    setModelPickerOpen(false)
    setLightboxState(null)
    clearE2eeMediaCache()
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
      const curLang = getCurrentLang()
      if (payload.authMode === 'account') {
        const onlineN = (payload.devices || payload.bridges || []).filter((x) => x.online).length
        showToast(
          onlineN > 0
            ? biLang(curLang, `已登录 @${payload.username} · 发现 ${onlineN} 台在线电脑`, `Signed in as @${payload.username} · ${onlineN} PC${onlineN === 1 ? '' : 's'} online`)
            : biLang(curLang, `已登录 @${payload.username}`, `Signed in as @${payload.username}`),
        )
      } else {
        const name = getDeviceDisplayName(preview.device, null, 0, curLang)
        showToast(
          preview.isNew
            ? biLang(curLang, `已添加并切换到 ${name}`, `Added and switched to ${name}`)
            : biLang(curLang, `已更新并切换到 ${name}`, `Updated and switched to ${name}`),
        )
      }
    }
  }, [resetTransientWorkspace, showToast])

  // Auto-handle Invite Registration link (?invite=INV-XXXX-XXXX)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const inviteCode = (params.get('invite') || '').trim()
    if (!inviteCode) return

    // Strip invite param from address bar immediately
    params.delete('invite')
    const cleanQuery = params.toString()
    const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash || ''}`
    try { window.history.replaceState({}, '', cleanUrl) } catch {}

    setPairError('')
    setAddingDevice({
      open: true,
      serverUrl: detectDefaultServerUrl(),
      openScanner: false,
      inviteCode,
    })
  }, [])

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

  const selectedDraftWorkspaceObj = useMemo(() => {
    if (!selectedDraftCwd) return null
    const lower = selectedDraftCwd.toLowerCase()
    const hit = effectiveWorkspaces.find((w) => w.path.toLowerCase() === lower)
    if (hit) return hit
    const parts = selectedDraftCwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
    return { name: parts[parts.length - 1] || selectedDraftCwd, path: selectedDraftCwd }
  }, [selectedDraftCwd, effectiveWorkspaces])

  // Mint and auto-refresh a short-lived 15-min read-only media token so the 30-day master JWT never appears in image URLs
  useEffect(() => {
    if (!activeDevice?.id || !activeDevice?.baseUrl || !activeDevice?.token || connState === 'unauthorized') {
      setMediaAuth({ deviceId: '', mediaToken: '' })
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

  const activeBridgeE2ee = useMemo(() => {
    const raw = activeBridge?.e2ee || null
    const enabled = Boolean(raw?.enabled && raw?.keyId)
    const keyId = enabled ? String(raw.keyId) : ''
    const keysMap = activeDevice?.e2eeKeys || {}
    const matchedKey = keyId ? String(keysMap[keyId] || '') : ''
    const locked = Boolean(enabled && !matchedKey)
    const desktopKeyId = desktopBridge?.e2eeKeyId && keysMap[desktopBridge.e2eeKeyId] ? desktopBridge.e2eeKeyId : ''
    const fallbackKeyId = desktopKeyId || Object.keys(keysMap)[0] || ''
    const shareableKeyId = matchedKey ? keyId : fallbackKeyId
    const shareableKey = shareableKeyId ? String(keysMap[shareableKeyId] || '') : ''
    return {
      enabled,
      keyId,
      matchedKey,
      locked,
      active: Boolean(enabled && matchedKey),
      shareableKey,
      shareableKeyId,
    }
  }, [activeBridge?.e2ee, activeDevice?.e2eeKeys, desktopBridge?.e2eeKeyId])

  const e2eeLocked = activeBridgeE2ee.locked
  const e2eeLockedRef = useRef(e2eeLocked)
  e2eeLockedRef.current = e2eeLocked
  const activeE2eeKeysRef = useRef(activeDevice?.e2eeKeys || {})
  activeE2eeKeysRef.current = activeDevice?.e2eeKeys || {}

  useEffect(() => {
    clientRef.current?.setE2eeKeys(activeDevice?.e2eeKeys || {})
  }, [activeDevice?.e2eeKeys])

  const imageContext = useMemo(() => {
    const matched = mediaAuth.deviceId === activeDevice?.id
    return {
      baseUrl: activeDevice?.baseUrl || '',
      roomId: activeDevice?.roomId || '',
      mediaToken: matched ? mediaAuth.mediaToken : '',
      cwd: activeSession?.cwd || '',
      bridgeId: activeBridgeId,
      client: clientRef.current,
      e2eeActive: activeBridgeE2ee.active,
      e2eeKey: activeBridgeE2ee.matchedKey,
      e2eeKeyId: activeBridgeE2ee.keyId,
      e2eeKeys: activeDevice?.e2eeKeys || {},
      onOpenImage: setLightboxState,
    }
  }, [
    activeDevice?.id,
    activeDevice?.baseUrl,
    activeDevice?.roomId,
    activeDevice?.e2eeKeys,
    mediaAuth.deviceId,
    mediaAuth.mediaToken,
    activeSession?.cwd,
    activeBridgeId,
    activeBridgeE2ee.active,
    activeBridgeE2ee.matchedKey,
    activeBridgeE2ee.keyId,
  ])

  const loadWorkspaceData = useCallback(async (bridgeOverride = '') => {
    const client = clientRef.current
    if (!client || e2eeLockedRef.current) return
    const targetBridge = String(bridgeOverride || activeBridgeIdRef.current || '').trim()
    if (targetBridge) client.setTargetBridgeId(targetBridge)
    const gen = deviceGenRef.current
    setRefreshing(true)
    try {
      const rpcOpts = targetBridge ? { bridgeId: targetBridge } : {}
      const [statusRes, sessRes, wsRes, aprRes, modelsRes] = await Promise.all([
        client.rpc(RPC.APPS_STATUS, {}, 45_000, rpcOpts).catch(() => ({ apps: [] })),
        client.rpc(RPC.SESSIONS_LIST, { app: 'all', limit: 100 }, 45_000, rpcOpts).catch(() => ({ sessions: [] })),
        client.rpc(RPC.WORKSPACES_LIST, {}, 45_000, rpcOpts).catch(() => ({ workspaces: [] })),
        client.rpc(RPC.APPROVAL_LIST, {}, 45_000, rpcOpts).catch(() => ({ approvals: [] })),
        client.rpc(RPC.MODELS_LIST, {}, 45_000, rpcOpts).catch(() => ({ catalog: {} })),
      ])
      if (deviceGenRef.current !== gen || clientRef.current !== client) return
      setAppsStatus(statusRes.apps || [])
      setSessions(sessRes.sessions || [])
      setWorkspaces(wsRes.workspaces || [])
      setApprovals(aprRes.approvals || [])
      if (modelsRes?.catalog && Object.keys(modelsRes.catalog).length > 0) {
        setModelsCatalog(modelsRes.catalog)
      }
    } finally {
      if (deviceGenRef.current === gen) {
        setRefreshing(false)
      }
    }
  }, [])

  // Trigger workspace load whenever connected target device/bridge is ready or E2EE unlocks
  useEffect(() => {
    if (connState !== 'connected' || !activeDevice?.id || !activeBridgeId || e2eeLocked) return
    clientRef.current?.setTargetBridgeId(activeBridgeId)
    clientRef.current?.setE2eeKeys(activeDevice?.e2eeKeys || {})
    void loadWorkspaceData(activeBridgeId)
  }, [connState, activeDevice?.id, activeBridgeId, e2eeLocked, loadWorkspaceData])

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
      if (sessionOrId.cwd) saveLastWorkspace(scope, sessionOrId.cwd)
    }
    saveLastSessionId(scope, id)
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

  // Auto-resume the last active conversation (or most recent conversation) once per connected PC,
  // so opening the app lands straight inside a real project conversation instead of an unscoped blank screen.
  useEffect(() => {
    if (connState !== 'connected' || !activeBridgeId || !cacheScope) return
    if (sessions.length === 0) return
    if (autoOpenedScopeRef.current === cacheScope) return
    if (activeSessionRef.current) {
      autoOpenedScopeRef.current = cacheScope
      return
    }
    autoOpenedScopeRef.current = cacheScope
    const savedId = loadLastSessionId(cacheScope)
    const targetSess = (savedId && sessions.find((s) => s.id === savedId)) || sessions[0]
    if (targetSess) {
      void openSession(targetSess)
    }
  }, [connState, activeBridgeId, cacheScope, sessions, openSession])

  // Restore last explicitly used project directory on the empty screen (only if still present on this PC)
  useEffect(() => {
    if (selectedDraftCwd || !cacheScope || effectiveWorkspaces.length === 0) return
    const saved = loadLastWorkspace(cacheScope)
    if (!saved) return
    const matched = effectiveWorkspaces.find((w) => w.path.toLowerCase() === saved.toLowerCase())
    if (matched) {
      setSelectedDraftCwd(matched.path)
    }
  }, [cacheScope, effectiveWorkspaces, selectedDraftCwd])

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
              ? {
                  ...s,
                  status: res.session.status || s.status,
                  title: res.session.title || s.title,
                  ...(res.session.syncState ? { syncState: res.session.syncState } : {}),
                  ...(res.session.updatedAt ? { updatedAt: Math.max(s.updatedAt || 0, res.session.updatedAt) } : {}),
                }
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
        setOlderError(String(err?.message || err || biLang(getCurrentLang(), '加载更早历史失败', 'Failed to load earlier history')))
      }
    } finally {
      loadingOlderLockRef.current = false
      if (deviceGenRef.current === gen) {
        setLoadingOlder(false)
      }
    }
  }, [])

  // Connect WebSocket whenever the active saved account changes
  useEffect(() => {
    if (!activeDevice?.token || !activeDevice?.baseUrl) {
      setConnState('disconnected')
      setBridges([])
      setAccountDevices([])
      return
    }

    setBridges([])
    // Refresh persisted account profile (role/username/devices) cleanly on mount/switch
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

    const client = new MobileRelayClient({
      baseUrl: activeDevice.baseUrl,
      token: activeDevice.token,
      roomId: activeDevice.roomId,
      bridgeId: activeDevice.selectedBridgeId || '',
      e2eeKeys: activeDevice.e2eeKeys || {},
    })
    setPendingGrantPopup(null)
    clientRef.current = client

    const unsubStatus = client.onStatus(({ state, bridges: bList, devices: dList, onlineClientCount: occ }) => {
      if (clientRef.current !== client) return
      setConnState(state)
      setBridges(bList || [])
      if (Array.isArray(dList)) setAccountDevices(dList)
      if (typeof occ === 'number') setLiveOnlineClientCount(occ)
    })

    const unsubEvents = client.onEvent((event, payload, rawMsg) => {
      if (clientRef.current !== client) return
      if (event === EVENTS.BRIDGE_STATUS || event === EVENTS.CLIENTS_STATUS) return

      // Zero-knowledge device-to-device E2EE key-grant signaling (room-wide, independent of selected bridge)
      if (event === EVENTS.E2EE_GRANT_REQUEST && payload?.reqId && payload?.pubKey) {
        if (payload.requesterClientId && payload.requesterClientId === client.clientId) return
        const myKeys = activeE2eeKeysRef.current || {}
        if (Object.keys(myKeys).length > 0) {
          setPendingGrantPopup((prev) => (prev?.qrVerified ? prev : payload))
        }
        return
      }
      if (event === EVENTS.E2EE_GRANT_CANCEL && payload?.reqId) {
        setPendingGrantPopup((prev) => (prev && prev.reqId === payload.reqId ? null : prev))
        return
      }
      if (
        event === EVENTS.E2EE_GRANT_OFFER ||
        event === EVENTS.E2EE_GRANT_DELIVER ||
        event === EVENTS.E2EE_GRANT_REJECT
      ) {
        return
      }

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

      if (event === EVENTS.SESSION_UPDATED && payload?.session) {
        const updated = payload.session
        setSessions((prev) => {
          const prevItem = prev.find((s) => s.id === updated.id)
          const merged = prevItem ? { ...prevItem, ...updated } : updated
          const next = [merged, ...prev.filter((s) => s.id !== updated.id)]
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
          return { ...prev, [sid]: { ...cur, active: false, error: payload.message || biLang(getCurrentLang(), '执行出错', 'Execution error') } }
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
  }, [activeDevice?.id, activeDevice?.token, activeDevice?.baseUrl])

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
          : getDeviceDisplayName(target, null, 0, getCurrentLang())
      showToast(biLang(getCurrentLang(), `已切换到 ${name}`, `Switched to ${name}`))
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
      showToast(biLang(getCurrentLang(), `已重命名为 ${newLabel}`, `Renamed to ${newLabel}`))
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
      showToast(biLang(getCurrentLang(), '已解绑并断开该电脑', 'Computer unlinked and disconnected'))
    } catch (err) {
      showToast(String(err?.message || err))
    }
  }, [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, resetTransientWorkspace, showToast])

  const handleRefreshClientSessions = useCallback(async () => {
    if (!activeDevice?.baseUrl || !activeDevice?.token) return
    try {
      const res = await fetchAuthSessions(
        activeDevice.baseUrl,
        activeDevice.token,
        clientRef.current?.clientId || '',
      )
      setClientSessions(res)
      if (res.supported) {
        setLiveOnlineClientCount(res.onlineCount)
      }
    } catch {}
  }, [activeDevice?.baseUrl, activeDevice?.token])

  // Auto-refresh detailed client session list whenever live client count changes while modal is open or on connect
  useEffect(() => {
    if (!activeDevice?.baseUrl || !activeDevice?.token || connState !== 'connected') return
    void handleRefreshClientSessions()
  }, [
    activeDevice?.baseUrl,
    activeDevice?.token,
    connState,
    liveOnlineClientCount,
    deviceSwitcherOpen,
    settingsOpen,
    handleRefreshClientSessions,
  ])

  const handleRevokeClientSession = useCallback(
    async ({ sid = '', clientId = '' } = {}) => {
      if (!activeDevice?.baseUrl || !activeDevice?.token) return
      try {
        const res = await revokeAuthSession(activeDevice.baseUrl, activeDevice.token, {
          sid,
          clientId,
          currentClientId: clientRef.current?.clientId || '',
        })
        setClientSessions({ supported: true, ...res })
        setLiveOnlineClientCount(res.onlineCount)
        showToast(biLang(getCurrentLang(), '已将该设备踢下线', 'Signed out device'))
      } catch (err) {
        showToast(String(err?.message || err))
      }
    },
    [activeDevice?.baseUrl, activeDevice?.token, showToast],
  )

  const handleRevokeOtherClientSessions = useCallback(async () => {
    if (!activeDevice?.id || !activeDevice?.baseUrl || !activeDevice?.token) return
    try {
      const res = await revokeOtherAuthSessions(
        activeDevice.baseUrl,
        activeDevice.token,
        clientRef.current?.clientId || '',
      )
      if (res.token) {
        clientRef.current?.updateToken(res.token)
        setDeviceState((prev) => updateDeviceMeta(prev, activeDevice.id, { token: res.token }))
      }
      setClientSessions({ supported: true, ...res })
      setLiveOnlineClientCount(res.onlineCount)
      showToast(biLang(getCurrentLang(), '已下线其他全部登录设备，仅保留本机', 'Signed out all other devices'))
    } catch (err) {
      showToast(String(err?.message || err))
    }
  }, [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, showToast])

  const handleRefreshAccountDevices = useCallback(async () => {
    if (!activeDevice?.baseUrl || !activeDevice?.token) return
    void handleRefreshClientSessions()
    if (!isAccountMode) return
    try {
      const [devRes, meRes] = await Promise.all([
        listAccountDevices(activeDevice.baseUrl, activeDevice.token).catch(() => null),
        probeDeviceStatus(activeDevice, 5000).catch(() => null),
      ])
      if (devRes) setAccountDevices(devRes.devices)
      if (meRes && meRes.status !== 'expired' && meRes.status !== 'unreachable') {
        setServerEmailEnabled(Boolean(meRes.emailEnabled))
        setDeviceState((prev) =>
          updateDeviceMeta(prev, activeDevice.id, {
            ...(meRes.username ? { username: meRes.username } : {}),
            ...(meRes.role ? { role: meRes.role } : {}),
            email: meRes.email || '',
            loginEmail2fa: Boolean(meRes.loginEmail2fa),
          }),
        )
      }
    } catch {}
  }, [activeDevice, isAccountMode, handleRefreshClientSessions])

  useEffect(() => {
    if (!activeDevice?.id || !activeDevice?.baseUrl || !activeDevice?.token || !isAccountMode) {
      setServerEmailEnabled(false)
      return
    }
    let cancelled = false
    probeDeviceStatus(activeDevice, 5000)
      .then((res) => {
        if (cancelled || !res || res.status === 'expired' || res.status === 'unreachable') return
        setServerEmailEnabled(Boolean(res.emailEnabled))
        setDeviceState((prev) =>
          updateDeviceMeta(prev, activeDevice.id, {
            ...(res.username ? { username: res.username } : {}),
            ...(res.role ? { role: res.role } : {}),
            email: res.email || '',
            loginEmail2fa: Boolean(res.loginEmail2fa),
          }),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, isAccountMode])

  const handleSendBindEmailCode = useCallback(
    async (targetEmail) => {
      if (!activeDevice?.baseUrl || !activeDevice?.token) {
        throw new Error(biLang(getCurrentLang(), '未登录账号', 'Not signed in'))
      }
      return sendEmailVerificationCode(activeDevice.baseUrl, {
        purpose: 'bind',
        email: targetEmail,
        token: activeDevice.token,
      })
    },
    [activeDevice?.baseUrl, activeDevice?.token],
  )

  const handleBindAccountEmail = useCallback(
    async (targetEmail, code) => {
      if (!activeDevice?.id || !activeDevice?.baseUrl || !activeDevice?.token) {
        throw new Error(biLang(getCurrentLang(), '未登录账号', 'Not signed in'))
      }
      const user = await bindAccountEmail(activeDevice.baseUrl, activeDevice.token, {
        email: targetEmail,
        code,
      })
      const boundEmail = user?.email || targetEmail
      setDeviceState((prev) => updateDeviceMeta(prev, activeDevice.id, { email: boundEmail }))
      showToast(biLang(getCurrentLang(), `已绑定邮箱 ${boundEmail}`, `Linked email ${boundEmail}`))
      return user
    },
    [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, showToast],
  )

  const handleToggleLoginEmail2fa = useCallback(
    async (enabled) => {
      if (!activeDevice?.id || !activeDevice?.baseUrl || !activeDevice?.token) return
      try {
        const user = await setAccountLogin2fa(activeDevice.baseUrl, activeDevice.token, enabled)
        setDeviceState((prev) =>
          updateDeviceMeta(prev, activeDevice.id, { loginEmail2fa: Boolean(user?.loginEmail2fa) }),
        )
        const curLang = getCurrentLang()
        showToast(
          user?.loginEmail2fa
            ? biLang(curLang, '已开启登录邮箱二次验证', 'Email login 2FA enabled')
            : biLang(curLang, '已关闭登录邮箱二次验证', 'Email login 2FA disabled'),
        )
      } catch (err) {
        showToast(String(err?.message || err))
      }
    },
    [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, showToast],
  )

  const handleImportE2eeKey = useCallback(
    async (rawKey, keyId, { applyToDesktopBridge = false } = {}) => {
      if (!activeDevice?.id || !rawKey || !keyId) return
      let finalKey = rawKey
      let finalKeyId = keyId
      if (applyToDesktopBridge && desktopApi?.setE2eeKey && activeDevice?.roomId) {
        const res = await desktopApi.setE2eeKey(activeDevice.roomId, rawKey)
        if (res?.key && res?.keyId) {
          finalKey = res.key
          finalKeyId = res.keyId
        }
        const st = await desktopApi.getBridgeStatus?.().catch(() => null)
        if (st) setDesktopBridge(st)
      }
      const nextKeys = {
        ...(activeDevice.e2eeKeys || {}),
        [finalKeyId]: finalKey,
      }
      clientRef.current?.setE2eeKeys(nextKeys)
      setDeviceState((prev) => upsertDeviceE2eeKey(prev, activeDevice.id, finalKeyId, finalKey))
      showToast(
        biLang(
          getCurrentLang(),
          `端到端密钥已同步 (${formatE2eeFingerprint(finalKeyId).slice(0, 9)})`,
          `E2EE key synced (${formatE2eeFingerprint(finalKeyId).slice(0, 9)})`,
        ),
      )
    },
    [activeDevice?.id, activeDevice?.roomId, activeDevice?.e2eeKeys, desktopApi, showToast],
  )

  const handleImportE2eeKeyring = useCallback(
    async (entries = [], preferredKeyId = '', { applyToDesktopBridge = false, approverName = '' } = {}) => {
      if (!activeDevice?.id || !Array.isArray(entries) || entries.length === 0) return
      const validEntries = entries.filter((e) => e?.keyId && e?.key)
      if (validEntries.length === 0) return

      const preferred =
        validEntries.find((e) => e.keyId === preferredKeyId) || validEntries[0]

      const nextKeys = { ...(activeDevice.e2eeKeys || {}) }
      for (const item of validEntries) {
        nextKeys[item.keyId] = item.key
      }

      if (applyToDesktopBridge && desktopApi?.setE2eeKey && activeDevice?.roomId && preferred?.key) {
        const res = await desktopApi.setE2eeKey(activeDevice.roomId, preferred.key)
        if (res?.key && res?.keyId) {
          nextKeys[res.keyId] = res.key
        }
        const st = await desktopApi.getBridgeStatus?.().catch(() => null)
        if (st) setDesktopBridge(st)
      }

      clientRef.current?.setE2eeKeys(nextKeys)
      setDeviceState((prev) => {
        let next = prev
        for (const [kid, kVal] of Object.entries(nextKeys)) {
          next = upsertDeviceE2eeKey(next, activeDevice.id, kid, kVal)
        }
        return next
      })
      showToast(
        approverName
          ? biLang(
              getCurrentLang(),
              `已通过「${approverName}」安全同步 ${validEntries.length} 把端到端密钥`,
              `Synced ${validEntries.length} E2EE key(s) via ${approverName}`,
            )
          : biLang(
              getCurrentLang(),
              `已安全同步 ${validEntries.length} 把端到端密钥`,
              `Synced ${validEntries.length} E2EE key(s)`,
            ),
      )
    },
    [activeDevice?.id, activeDevice?.roomId, activeDevice?.e2eeKeys, desktopApi, showToast],
  )

  const handleScanGrantQr = useCallback(
    async (grantQr) => {
      if (!grantQr?.reqId || !grantQr?.pubKeyFp || !clientRef.current) return false
      const list = await clientRef.current.listGrantRequests(5000)
      const match = (Array.isArray(list) ? list : []).find((g) => g.reqId === grantQr.reqId)
      if (!match || !match.pubKey) return false
      if (activeDevice?.roomId && match.roomId && match.roomId !== activeDevice.roomId) {
        throw new Error(biLang(getCurrentLang(), '该授权请求属于其他账号', 'Grant request belongs to a different account'))
      }
      const computedFp = await computeGrantPubKeyFp(match.pubKey)
      if (computedFp !== String(grantQr.pubKeyFp).toLowerCase()) {
        throw new Error(
          biLang(
            getCurrentLang(),
            '安全校验失败：二维码公钥指纹不匹配，可能存在中间人攻击，已拒绝授权！',
            'Security verification failed: QR public key fingerprint mismatch!',
          ),
        )
      }
      setPendingGrantPopup({
        ...match,
        qrVerified: true,
        qrPubKeyFp: grantQr.pubKeyFp,
      })
      return true
    },
    [activeDevice?.roomId],
  )

  const handleRotateDesktopE2eeKey = useCallback(async () => {
    if (!desktopApi?.rotateE2eeKey || !activeDevice?.id || !activeDevice?.roomId) return
    const res = await desktopApi.rotateE2eeKey(activeDevice.roomId)
    if (res?.key && res?.keyId) {
      const nextKeys = {
        ...(activeDevice.e2eeKeys || {}),
        [res.keyId]: res.key,
      }
      clientRef.current?.setE2eeKeys(nextKeys)
      setDeviceState((prev) => upsertDeviceE2eeKey(prev, activeDevice.id, res.keyId, res.key))
    }
    const st = await desktopApi.getBridgeStatus?.().catch(() => null)
    if (st) setDesktopBridge(st)
    clearE2eeMediaCache()
    showToast(biLang(getCurrentLang(), '已轮换端到端密钥并重启本机桥接', 'Rotated E2EE key and restarted local bridge'))
  }, [desktopApi, activeDevice?.id, activeDevice?.roomId, activeDevice?.e2eeKeys, showToast])

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
    clearDraftsForScope(deviceId)
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
      const curLang = getCurrentLang()
      const name = getDeviceDisplayName(target, null, 0, curLang)
      showToast(
        revokeAll
          ? biLang(curLang, `已吊销 ${name} 全部设备凭证并移除`, `Revoked all sessions and removed ${name}`)
          : biLang(curLang, `已移除 ${name}`, `Removed ${name}`),
      )
    }
  }, [activeDevice?.id, devices, resetTransientWorkspace, showToast])

  const handleCreateSession = async ({ app, cwd, title, model, provider, reasoningEffort }) => {
    const client = clientRef.current
    if (!client) throw new Error(biLang(getCurrentLang(), '未连接到服务器', 'Not connected to server'))
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
    saveLastSessionId(cacheScopeRef.current, created.id)
    if (created.cwd) {
      saveLastWorkspace(cacheScopeRef.current, created.cwd)
      setSelectedDraftCwd(created.cwd)
    }
    setMessages([])
    setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: 0 })
    return created
  }

  const effectiveDefaultApp = selectedDraftApp || defaultApp

  const resolveModelPrefFor = (sessionObj) => {
    const appId = sessionObj?.app || effectiveDefaultApp
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
      // Strictly require an explicitly chosen project directory before creating a new conversation
      const explicitCwd = String(selectedDraftCwd || '').trim()
      if (!explicitCwd) {
        showToast(bi('请先选择目标项目目录', 'Please select a target project directory first'))
        openNewChatModal('', effectiveDefaultApp)
        return
      }
      try {
        const initPref = resolveModelPrefFor({ app: effectiveDefaultApp })
        target = await handleCreateSession({
          app: effectiveDefaultApp,
          cwd: explicitCwd,
          title: text.slice(0, 28) || t('common.newChat'),
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
    const finalText = text

    // Optimistically replace generic placeholder title on first user message
    const genericTitle = /^(新 |新对话|New Chat|手机端总控对话|[0-9a-f]{8}-[0-9a-f]{4}-)/i.test(target.title || '')
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
        ? `${finalText}${finalText ? '\n' : ''}[${bi('附件', 'Attachment')}: ${nonImgAtts.map((a) => a.filename).join(', ')}]`
        : finalText
    const userMsg = {
      id: `msg-u-${Date.now()}`,
      role: 'user',
      text: displayUserText,
      ...(imgAtts.length > 0
        ? {
            images: imgAtts.map((a) => ({
              url: a.url,
              name: a.filename,
              mimeType: a.mimeType,
              ...(a.e2ee ? { e2ee: a.e2ee } : {}),
              ...(a.localPreviewUrl ? { localPreviewUrl: a.localPreviewUrl } : {}),
            })),
          }
        : {}),
      ts: Date.now(),
    }
    const wireAttachments = attachments.map(({ localPreviewUrl: _drop, ...rest }) => rest)
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
          attachments: wireAttachments,
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

  const handleResolveApproval = async (id, decisionOrPayload) => {
    const client = clientRef.current
    if (!client) return
    const targetBridge = activeBridgeIdRef.current
    const payload =
      decisionOrPayload && typeof decisionOrPayload === 'object'
        ? { id, decision: decisionOrPayload.decision || 'submit', answers: decisionOrPayload.answers }
        : { id, decision: decisionOrPayload }
    try {
      await client.rpc(
        RPC.APPROVAL_RESOLVE,
        payload,
        45_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
      setApprovals((prev) => prev.filter((a) => a.id !== id))
    } catch (err) {
      alert(String(err?.message || err))
    }
  }

  if (!activeDevice || addingDevice.open) {
    return (
      <LoginScreen
        initialError={pairError}
        isAddingDevice={Boolean(activeDevice && addingDevice.open)}
        initialServerUrl={addingDevice.serverUrl || activeDevice?.baseUrl || ''}
        initialInviteCode={addingDevice.inviteCode || ''}
        autoOpenScanner={Boolean(addingDevice.open && addingDevice.openScanner)}
        darkMode={darkMode}
        onToggleDark={() => setDarkMode((v) => !v)}
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

  const activeApp = activeSession?.app || effectiveDefaultApp
  const activeCatalog = modelsCatalog[activeApp] || null
  const activeModelPref = resolveModelPrefFor(activeSession)
  const activeModelObj = (activeCatalog?.models || []).find(
    (m) =>
      m.id === activeModelPref.model &&
      (!activeModelPref.provider || !m.provider || m.provider === activeModelPref.provider),
  ) || (activeCatalog?.models || []).find((m) => m.id === activeModelPref.model)
  const currentStream = activeSession ? streamingBySession[activeSession.id] : null

  const hasMultipleTargets = devices.length > 1 || onlineBridges.length > 1 || accountDevices.length > 1
  const currentWorkspaceLabel = activeSession?.workspace || selectedDraftWorkspaceObj?.name || ''
  const headerSubtitle = (() => {
    if (connState === 'unauthorized') return `${activeDeviceName} · ${t('common.expired')}`
    if (connState !== 'connected') return `${activeDeviceName} · ${t('common.connecting')}`
    if (!bridgeOnline) return `${activeDeviceName} · ${t('common.offline')}`
    if (hasMultipleTargets) {
      return currentWorkspaceLabel
        ? `${activeDeviceName} · ${currentWorkspaceLabel}`
        : activeDeviceName
    }
    return currentWorkspaceLabel || activeDeviceName || bi('已连接', 'Connected')
  })()

  const activeSessionId = activeSession?.id || ''
  const activeSessionApprovals = approvals.filter((a) => !a.sessionId || a.sessionId === activeSessionId)
  const otherSessionApprovals = approvals.filter((a) => a.sessionId && a.sessionId !== activeSessionId)
  const pendingApprovalSessionIds = new Set(approvals.map((a) => a.sessionId).filter(Boolean))

  return (
    <div className="relative flex h-full w-full bg-white dark:bg-[#16171A]">
      {/* Responsive Sidebar (slide-over drawer on mobile, docked left column on desktop lg:) */}
      <SidebarDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sessions={sessions}
        activeSessionId={activeSession?.id}
        pendingApprovalSessionIds={pendingApprovalSessionIds}
        onSelectSession={openSession}
        filterApp={sidebarFilterApp}
        onFilterAppChange={setSidebarFilterApp}
        onNewChat={(cwdHint = '', appHint = '') => openNewChatModal(cwdHint, appHint)}
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
        hasUpdate={updateState?.status === 'available' || updateState?.status === 'downloaded'}
        e2eeLocked={e2eeLocked}
        onQuickScan={() => setE2eeModal({ open: true, tab: 'import', autoOpenScanner: true })}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenDeviceSwitcher={() => setDeviceSwitcherOpen(true)}
      />

      {/* Right Main Column */}
      <div className="relative flex min-w-0 flex-1 flex-col bg-white dark:bg-[#16171A]">
      {/* Minimal top header */}
      <header className="app-drag pt-safe shrink-0 border-b border-slate-100 bg-white/85 px-3 pb-2.5 backdrop-blur-md dark:border-slate-800/80 dark:bg-[#16171A]/85">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 lg:max-w-3xl">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={bi('打开对话列表', 'Open conversations')}
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
            <div className="mt-0.5 flex items-center justify-center gap-1">
              <button
                type="button"
                onClick={() => setDeviceSwitcherOpen(true)}
                aria-label={bi('切换控制的电脑', 'Switch computer')}
                className="inline-flex max-w-[230px] items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] text-slate-500 transition hover:bg-slate-100 active:scale-95 dark:text-slate-400 dark:hover:bg-slate-800"
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
              {connState === 'connected' && bridgeOnline && activeBridgeE2ee.enabled && (
                <button
                  type="button"
                  onClick={() =>
                    setE2eeModal({
                      open: true,
                      tab: e2eeLocked ? (desktopApi ? 'request' : 'import') : 'show',
                      autoOpenScanner: false,
                    })
                  }
                  title={
                    e2eeLocked
                      ? bi('需扫码同步端到端加密密钥', 'Sync E2EE key')
                      : bi(
                          `端到端加密已开启 (AES-256-GCM · ${formatE2eeFingerprint(activeBridgeE2ee.keyId)})`,
                          `End-to-End Encrypted (AES-256-GCM · ${formatE2eeFingerprint(activeBridgeE2ee.keyId)})`,
                        )
                  }
                  className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition active:scale-95 ${
                    e2eeLocked
                      ? 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400'
                      : 'bg-emerald-500/12 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400'
                  }`}
                >
                  {e2eeLocked ? <Lock className="h-2.5 w-2.5" /> : <ShieldCheck className="h-2.5 w-2.5" />}
                  {e2eeLocked && <span>{bi('同步密钥', 'Unlock')}</span>}
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => openNewChatModal(activeSession?.cwd || selectedDraftCwd || '')}
            aria-label={t('common.newChat')}
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
          <span>{bi('登录已过期', 'Session expired')}</span>
          <button
            type="button"
            onClick={() => setAddingDevice({ open: true, serverUrl: activeDevice.baseUrl, openScanner: false, inviteCode: '' })}
            className="rounded-lg bg-rose-500 px-2.5 py-0.5 text-[11px] font-semibold text-white active:scale-95"
          >
            {isAccountMode ? bi('重新登录', 'Sign In Again') : bi('重新配对', 'Pair Again')}
          </button>
          {devices.length > 1 && (
            <button
              type="button"
              onClick={() => setDeviceSwitcherOpen(true)}
              className="rounded-lg border border-rose-300 bg-white px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
            >
              {t('common.switch')}
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
              ? bi('尚未绑定电脑', 'No computer linked')
              : `${activeDeviceName} ${t('common.offline')}`}
          </span>
          {(devices.length > 1 || onlineBridges.length > 0 || isAccountMode) && (
            <button
              type="button"
              onClick={() => setDeviceSwitcherOpen(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-500/25 dark:text-amber-100"
            >
              <ArrowLeftRight className="h-3 w-3" />
              <span>{isAccountMode && accountDevices.length === 0 ? bi('绑定', 'Link') : t('common.switch')}</span>
            </button>
          )}
        </div>
      )}

      {/* Cross-session pending question/approval jump banner */}
      {otherSessionApprovals.length > 0 && connState === 'connected' && bridgeOnline && !e2eeLocked && (() => {
        const first = otherSessionApprovals[0]
        const targetSess = sessions.find((s) => s.id === first.sessionId)
        return (
          <div className="flex items-center justify-center gap-2 bg-[#EEF2FF] px-3 py-1.5 text-xs text-[#2842C9] dark:bg-[#1F2742] dark:text-[#B4C4FF]">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#4D6BFE] animate-pulse" />
            <span className="truncate">
              {bi(
                `「${targetSess?.title || first.title}」等待你的选择`,
                `${targetSess?.title || first.title} is waiting for your input`,
              )}
            </span>
            {targetSess && (
              <button
                type="button"
                onClick={() => openSession(targetSess)}
                className="shrink-0 rounded-lg bg-[#4D6BFE] px-2.5 py-0.5 text-[11px] font-semibold text-white active:scale-95"
              >
                {bi('去查看', 'View')}
              </button>
            )}
          </div>
        )
      })()}

      {/* Non-intrusive toast pill */}
      {toastMsg && (
        <div className="pointer-events-none fixed top-16 left-1/2 z-[60] -translate-x-1/2">
          <div className="rounded-full bg-slate-900/90 px-4 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur-md dark:bg-white/95 dark:text-slate-900">
            {toastMsg}
          </div>
        </div>
      )}

      {/* Main Chat Viewport (or E2EE Key Sync Lock Screen when bridge is E2EE-protected and key is not yet synced) */}
      {connState === 'connected' && bridgeOnline && e2eeLocked ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
          <div className="w-full max-w-sm rounded-3xl border border-slate-200/80 bg-slate-50/70 p-6 shadow-sm dark:border-slate-800 dark:bg-[#1C1F27]">
            <div className="mx-auto mb-3.5 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-500">
              <Lock className="h-6 w-6" />
            </div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              {bi('同步加密密钥', 'Sync Encryption Key')}
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {bi(
                `同步「${activeDeviceName}」的密钥后即可查看会话`,
                `Sync the key for ${activeDeviceName} to unlock chats`,
              )}
            </p>
            {activeBridgeE2ee.keyId && (
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 font-mono text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200/80 dark:bg-[#14171F] dark:text-slate-300 dark:ring-slate-700/80">
                <span className="text-[#4D6BFE]">{formatE2eeFingerprint(activeBridgeE2ee.keyId)}</span>
              </div>
            )}
            <div className="mt-5 space-y-2">
              {desktopApi ? (
                <>
                  <button
                    type="button"
                    onClick={() => setE2eeModal({ open: true, tab: 'request', autoOpenScanner: false })}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-3 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 transition active:scale-[0.98]"
                  >
                    <Smartphone className="h-4 w-4" />
                    <span>{bi('用已授权手机同步', 'Approve from Phone')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setE2eeModal({ open: true, tab: 'import', autoOpenScanner: false })}
                    className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-slate-200 bg-white py-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-[#232631] dark:text-slate-200 dark:hover:bg-[#2B2F3D]"
                  >
                    <KeyRound className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('扫码或粘贴密钥', 'Scan or Paste Key')}</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setE2eeModal({ open: true, tab: 'import', autoOpenScanner: true })}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-3 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 transition active:scale-[0.98]"
                  >
                    <ScanLine className="h-4 w-4" />
                    <span>{bi('扫一扫二维码', 'Scan QR Code')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setE2eeModal({ open: true, tab: 'request', autoOpenScanner: false })}
                    className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-slate-200 bg-white py-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-[#232631] dark:text-slate-200 dark:hover:bg-[#2B2F3D]"
                  >
                    <Smartphone className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('向已授权设备请求同步', 'Approve from Another Device')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setE2eeModal({ open: true, tab: 'import', autoOpenScanner: false })}
                    className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-slate-200/80 bg-transparent py-2 text-[11.5px] font-medium text-slate-500 transition hover:bg-slate-100/70 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/50"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    <span>{bi('粘贴恢复密钥', 'Paste Recovery Key')}</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
      <>
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
        activeApp={activeApp}
        onSelectApp={(appId) => {
          setSelectedDraftApp(appId)
          setDraftDshPref(null)
        }}
        workspaces={effectiveWorkspaces}
        selectedWorkspace={selectedDraftCwd}
        onSelectWorkspace={(cwdPath) => {
          setSelectedDraftCwd(cwdPath)
          if (cwdPath) saveLastWorkspace(cacheScopeRef.current, cwdPath)
        }}
        onOpenNewChatModal={() => openNewChatModal(selectedDraftCwd || '', effectiveDefaultApp)}
        approvals={activeSessionApprovals}
        imageContext={imageContext}
        onResolveApproval={handleResolveApproval}
      />

      {/* Floating DeepSeek-style Composer */}
      <Composer
        draftKey={makeDraftKey(cacheScope, activeSession?.id, activeApp)}
        activeApp={activeApp}
        streaming={Boolean(currentStream?.active)}
        disabled={!bridgeOnline || connState !== 'connected' || e2eeLocked}
        needsWorkspace={!activeSession && !selectedDraftCwd}
        targetWorkspaceName={!activeSession ? (selectedDraftWorkspaceObj?.name || '') : ''}
        onSwitchAppClick={() => openNewChatModal(activeSession?.cwd || selectedDraftCwd || '')}
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
      </>
      )}
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
        clientSessions={clientSessions}
        onlineClientCount={liveOnlineClientCount || clientSessions.onlineCount}
        isAdmin={isAdmin}
        emailEnabled={serverEmailEnabled}
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
        onRefreshClientSessions={handleRefreshClientSessions}
        onRevokeClientSession={handleRevokeClientSession}
        onRevokeOtherClientSessions={handleRevokeOtherClientSessions}
        onSendBindEmailCode={handleSendBindEmailCode}
        onBindAccountEmail={handleBindAccountEmail}
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
        initialApp={newChatApp}
        onClose={() => {
          setNewChatOpen(false)
          setNewChatCwd('')
          setNewChatApp('')
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

      {/* Share with Friends Modal */}
      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        serverUrl={activeDevice?.baseUrl}
        token={activeDevice?.token}
        isAdmin={isAdmin}
        onOpenInviteManager={() => setInviteManagerOpen(true)}
      />
      {/* Settings Modal (account, theme, desktop bridge, cache, version & about) */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        activeDevice={activeDevice}
        activeDeviceName={activeDeviceName}
        isAccountMode={isAccountMode}
        isAdmin={isAdmin}
        emailEnabled={serverEmailEnabled}
        connState={connState}
        bridgeOnline={bridgeOnline}
        onlineClientCount={liveOnlineClientCount || clientSessions.onlineCount}
        darkMode={darkMode}
        onToggleDark={() => setDarkMode((v) => !v)}
        cacheScope={cacheScope}
        desktopApi={desktopApi}
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
        onOpenDesktopLog={desktopApi ? () => { void desktopApi.openLog?.() } : null}
        updateState={updateState}
        onCheckUpdate={desktopApi ? () => { void desktopApi.checkForUpdates?.().then((st) => st && setUpdateState(st)) } : null}
        onDownloadUpdate={desktopApi ? () => { void desktopApi.downloadUpdate?.().then((st) => st && setUpdateState(st)) } : null}
        onCancelUpdate={desktopApi ? () => { void desktopApi.cancelUpdateDownload?.().then((st) => st && setUpdateState(st)) } : null}
        onInstallUpdate={desktopApi ? () => { void desktopApi.installUpdate?.().then((st) => st && setUpdateState(st)) } : null}
        onOpenDeviceSwitcher={() => setDeviceSwitcherOpen(true)}
        onOpenShare={() => setShareOpen(true)}
        onOpenInviteManager={() => setInviteManagerOpen(true)}
        onSendBindEmailCode={handleSendBindEmailCode}
        onBindAccountEmail={handleBindAccountEmail}
        onToggleLogin2fa={handleToggleLoginEmail2fa}
        e2eeStatus={{
          enabled: activeBridgeE2ee.active,
          locked: activeBridgeE2ee.locked,
          keyId: activeBridgeE2ee.shareableKeyId || activeBridgeE2ee.keyId,
        }}
        onOpenE2eeSync={() =>
          setE2eeModal({
            open: true,
            tab: e2eeLocked ? (desktopApi ? 'request' : 'import') : 'auto',
            autoOpenScanner: false,
          })
        }
        onRemoveDevice={handleRemoveDevice}
      />
      {/* Zero-Knowledge End-to-End Encryption (E2EE) QR Key Sync Modal */}
      <E2eeSyncModal
        open={e2eeModal.open}
        onClose={() => setE2eeModal((prev) => ({ ...prev, open: false, autoOpenScanner: false }))}
        roomId={activeDevice?.roomId || ''}
        username={activeDevice?.username || ''}
        bridgeName={activeDeviceName}
        bridgeE2ee={activeBridge?.e2ee || null}
        isBridgeLocked={e2eeLocked}
        activeKey={activeBridgeE2ee.shareableKey}
        activeKeyId={activeBridgeE2ee.shareableKeyId}
        isDesktopApp={Boolean(desktopApi)}
        client={clientRef.current}
        onlineOtherClientCount={Math.max(0, liveOnlineClientCount - 1)}
        initialTab={e2eeModal.tab}
        autoOpenScanner={e2eeModal.autoOpenScanner}
        onImportKey={handleImportE2eeKey}
        onImportKeyring={handleImportE2eeKeyring}
        onScanGrantQr={handleScanGrantQr}
        onRotateDesktopKey={desktopApi ? handleRotateDesktopE2eeKey : null}
      />
      {/* Zero-Knowledge Device-to-Device Key Grant Approval Popup (Phone B -> Computer C) */}
      <E2eeGrantApproveModal
        open={Boolean(pendingGrantPopup)}
        grant={pendingGrantPopup}
        e2eeKeys={activeDevice?.e2eeKeys || {}}
        preferredKeyId={activeBridgeE2ee.shareableKeyId || ''}
        client={clientRef.current}
        onDone={(g) => {
          showToast(
            biLang(
              getCurrentLang(),
              `已安全授权「${g?.deviceName || '新设备'}」同步端到端密钥`,
              `Authorized ${g?.deviceName || 'new device'} via zero-knowledge E2EE handoff`,
            ),
          )
        }}
        onClose={() => setPendingGrantPopup(null)}
      />
      {/* Full-Screen Zoomable Image Lightbox */}
      <ImageLightbox state={lightboxState} imageContext={imageContext} onClose={() => setLightboxState(null)} />
    </div>
  )
}

export default App
