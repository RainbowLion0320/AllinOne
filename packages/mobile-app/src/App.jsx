import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EVENTS, RPC } from '@allinone/shared'
import {
  ArrowLeftRight,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Loader2,
  Lock,
  Menu,
  QrCode,
  RefreshCw,
  ScanLine,
  Smartphone,
  SquarePen,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import { computeGrantPubKeyFp, formatE2eeFingerprint } from '@allinone/shared/e2ee'
import { clearE2eeMediaCache } from './lib/e2eeMedia.js'
import {
  checkNativeMobileUpdate,
  clearWebCachesAndServiceWorkers,
  isHotReloadableWebOrigin,
  performWebHotReload,
} from './lib/clientHelpers.js'
import { compressImageForUpload } from './lib/imageCompress.js'
import {
  MobileRelayClient,
  bindAccountEmail,
  fetchAuthSessions,
  listAccountDevices,
  logoutDeviceSession,
  probeDeviceStatus,
  removeAccountDevice,
  renameAccountDevice,
  revokeAuthSession,
  revokeDeviceSessions,
  revokeOtherAuthSessions,
  sendEmailVerificationCode,
  setAccountLogin2fa,
} from './lib/wsClient.js'
import {
  clearDeviceCredentials,
  getActiveDevice,
  getCacheScopeKey,
  getDeviceDisplayName,
  loadDeviceState,
  removeDevice,
  saveDeviceState,
  selectDevice,
  updateDeviceMeta,
  upsertDevice,
  upsertDeviceE2eeKey,
} from './lib/deviceStore.js'
import {
  clearSessionCache,
  formatBytesCompact,
  loadCachedSession,
  mergeSessionMessages,
  reconcileCachedWithFreshPage,
  saveCachedSession,
} from './lib/sessionCache.js'
import {
  clearDraftsForScope,
  loadLastWorkspace,
  makeDraftKey,
  saveLastWorkspace,
} from './lib/draftStore.js'
import { LoginScreen } from './components/LoginScreen.jsx'
import { SidebarDrawer } from './components/SidebarDrawer.jsx'
import { ChatView } from './components/ChatView.jsx'
import { Composer } from './components/Composer.jsx'
import { VendorBadge } from './components/VendorIcon.jsx'
import { useI18n } from './lib/i18n.jsx'
import { bi as biLang, getCurrentLang } from './lib/i18n.js'

const NewChatModal = React.lazy(() =>
  import('./components/NewChatModal.jsx').then((m) => ({ default: m.NewChatModal })),
)
const ModelPickerSheet = React.lazy(() =>
  import('./components/ModelPickerSheet.jsx').then((m) => ({ default: m.ModelPickerSheet })),
)
const ImageLightbox = React.lazy(() =>
  import('./components/ImageLightbox.jsx').then((m) => ({ default: m.ImageLightbox })),
)
const HtmlPreviewModal = React.lazy(() =>
  import('./components/HtmlPreviewModal.jsx').then((m) => ({ default: m.HtmlPreviewModal })),
)
const DeviceSwitcherModal = React.lazy(() =>
  import('./components/DeviceSwitcherModal.jsx').then((m) => ({ default: m.DeviceSwitcherModal })),
)
const SettingsModal = React.lazy(() =>
  import('./components/SettingsModal.jsx').then((m) => ({ default: m.SettingsModal })),
)
const E2eeSyncModal = React.lazy(() =>
  import('./components/E2eeSyncModal.jsx').then((m) => ({ default: m.E2eeSyncModal })),
)
const E2eeGrantApproveModal = React.lazy(() =>
  import('./components/E2eeGrantApproveModal.jsx').then((m) => ({ default: m.E2eeGrantApproveModal })),
)

export function App() {
  const { lang, bi, t } = useI18n()
  const [deviceState, setDeviceState] = useState(() => loadDeviceState())
  const [addingDevice, setAddingDevice] = useState({ open: false, serverUrl: '' })
  const [toastMsg, setToastMsg] = useState('')
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('allinone_dark') === '1')
  const [relayDataSaver, setRelayDataSaver] = useState(() => localStorage.getItem('allinone_relay_data_saver') !== '0')
  const [smartImageCompress, setSmartImageCompress] = useState(() => localStorage.getItem('allinone_image_compress') !== '0')
  const [mediaCacheRev, setMediaCacheRev] = useState(0)
  const [connState, setConnState] = useState('disconnected')
  const [connError, setConnError] = useState('')
  const [p2pState, setP2pState] = useState('idle')
  const [p2pError, setP2pError] = useState('')
  const [p2pEngine, setP2pEngine] = useState('')
  const [p2pTransport, setP2pTransport] = useState('')
  const [turnQuota, setTurnQuota] = useState(null)
  const [bridges, setBridges] = useState([])
  const [accountDevices, setAccountDevices] = useState([])
  const [clientSessions, setClientSessions] = useState({
    sessions: [],
    onlineCount: 0,
    onlineDeviceCount: 0,
    totalCount: 0,
  })
  const [liveOnlineClientCount, setLiveOnlineClientCount] = useState(0)
  const [serverEmailEnabled, setServerEmailEnabled] = useState(false)
  const [pendingGrantPopup, setPendingGrantPopup] = useState(null)
  const [qrNudge, setQrNudge] = useState(null)
  const [phoneGuideDismissed, setPhoneGuideDismissed] = useState(false)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [deviceSwitcherOpen, setDeviceSwitcherOpen] = useState(false)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newChatCwd, setNewChatCwd] = useState('')
  const [newChatApp, setNewChatApp] = useState('')
  const [sidebarFilterApp, setSidebarFilterApp] = useState('all')
  const [selectedDraftApp, setSelectedDraftApp] = useState('')
  const [selectedDraftCwd, setSelectedDraftCwd] = useState('')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [e2eeModal, setE2eeModal] = useState({ open: false, tab: 'auto', autoOpenScanner: false })
  const [lightboxState, setLightboxState] = useState(null)
  const [htmlPreviewState, setHtmlPreviewState] = useState(null)

  const [appsStatus, setAppsStatus] = useState([])
  const [modelsCatalog, setModelsCatalog] = useState({})
  const [loadingModels, setLoadingModels] = useState(false)
  const [sessionModelPrefs, setSessionModelPrefs] = useState({})
  const [draftDshPref, setDraftDshPref] = useState(null)
  const [workspaces, setWorkspaces] = useState([])
  const [sessions, setSessions] = useState([])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshingQuotas, setRefreshingQuotas] = useState(false)

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
  const updateStateRef = useRef(null)
  updateStateRef.current = updateState

  const desktopApi = typeof window !== 'undefined' ? window.allinoneDesktop || null : null
  const isMacDesktop = desktopApi?.platform === 'darwin'
  const isNativeMobile =
    typeof window !== 'undefined' && !desktopApi && Boolean(window.Capacitor?.isNativePlatform?.())
  const nativeOtaPlugin = isNativeMobile ? window.Capacitor?.Plugins?.AllinOneUpdater || null : null
  const isWebHotUpdatable =
    typeof window !== 'undefined' && !desktopApi && isHotReloadableWebOrigin(window.location)
  const canCheckMobileUpdate = !desktopApi && (isNativeMobile || isWebHotUpdatable)

  const devices = deviceState.devices
  const activeDevice = useMemo(() => getActiveDevice(deviceState), [deviceState])
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
      } else {
        const knownOfflineDevice = accountDevices.some((d) => d.bridgeId === preferredId)
        if (knownOfflineDevice || activeSession || sessions.length > 0) {
          // Never silently reroute away from an explicitly selected offline computer or mid-conversation
          return null
        }
      }
    }
    if (!chosen) chosen = onlineBridges[0] || null
    if (chosen) {
      const boundMeta = accountDevices.find((d) => d.bridgeId === chosen.bridgeId)
      if (boundMeta?.label) {
        return { ...chosen, label: boundMeta.label }
      }
    }
    return chosen
  }, [activeDevice, onlineBridges, activeSession, sessions.length, accountDevices])

  const bridgeOnline = Boolean(activeBridge)
  const activeBridgeId = activeBridge?.bridgeId || ''
  const activeDeviceName = useMemo(() => {
    if (!activeBridge && activeDevice?.selectedBridgeId) {
      const bound = accountDevices.find((d) => d.bridgeId === activeDevice.selectedBridgeId)
      if (bound) return bound.label || bound.hostname || bound.bridgeId
    }
    return getDeviceDisplayName(activeDevice, activeBridge, lang)
  }, [activeDevice, activeBridge, accountDevices, lang])
  const cacheScope = useMemo(
    () => getCacheScopeKey(activeDevice, activeBridgeId),
    [activeDevice, activeBridgeId],
  )

  const skipFirstSaveRef = useRef(true)
  const deviceStateRef = useRef(deviceState)
  deviceStateRef.current = deviceState
  const activeDeviceRef = useRef(activeDevice)
  activeDeviceRef.current = activeDevice
  const activeDeviceTokenRef = useRef(activeDevice?.token || '')
  activeDeviceTokenRef.current = activeDevice?.token || ''
  const connStateRef = useRef(connState)
  connStateRef.current = connState
  const clientRef = useRef(null)
  const activeSessionRef = useRef(null)
  activeSessionRef.current = activeSession
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const modelsCatalogRef = useRef(modelsCatalog)
  modelsCatalogRef.current = modelsCatalog
  const modelsEtagRef = useRef({ bridgeId: '', etag: '' })
  const historyMetaRef = useRef(historyMeta)
  historyMetaRef.current = historyMeta
  const openRequestSeqRef = useRef(0)
  const deviceGenRef = useRef(0)
  const workspaceLoadSeqRef = useRef(0)
  const olderReqSeqRef = useRef(0)
  const loadingOlderLockRef = useRef(false)
  const streamingRef = useRef(streamingBySession)
  streamingRef.current = streamingBySession
  const liveStreamMapRef = useRef({})
  const sentPreviewUrlsRef = useRef(new Set())
  const activeBridgeIdRef = useRef(activeBridgeId)
  activeBridgeIdRef.current = activeBridgeId
  const cacheScopeRef = useRef(cacheScope)
  cacheScopeRef.current = cacheScope
  const quietSyncSeqRef = useRef(0)
  const activeQuietSyncSeqRef = useRef(0)
  const quietSyncPendingRef = useRef('')
  const lastFocusSyncAtRef = useRef(0)
  const toastTimerRef = useRef(null)

  const revokeAllSentPreviewUrls = useCallback(() => {
    for (const url of sentPreviewUrlsRef.current) {
      try { URL.revokeObjectURL(url) } catch {}
    }
    sentPreviewUrlsRef.current.clear()
  }, [])

  const pruneUnusedSentPreviewUrls = useCallback((currentMessages = []) => {
    if (sentPreviewUrlsRef.current.size === 0) return
    const inUse = new Set()
    for (const m of currentMessages || []) {
      if (!Array.isArray(m?.images)) continue
      for (const img of m.images) {
        if (img?.localPreviewUrl) inUse.add(img.localPreviewUrl)
      }
    }
    for (const url of [...sentPreviewUrlsRef.current]) {
      if (!inUse.has(url)) {
        sentPreviewUrlsRef.current.delete(url)
        try { URL.revokeObjectURL(url) } catch {}
      }
    }
  }, [])

  const clearLiveStreamEntry = useCallback((sid) => {
    if (!sid) return
    delete liveStreamMapRef.current[sid]
    setStreamingBySession((prev) => {
      if (!(sid in prev)) return prev
      const next = { ...prev }
      delete next[sid]
      return next
    })
  }, [])

  const isStaleStreamForIdle = useCallback((sid) => {
    if (!sid) return false
    const entry = liveStreamMapRef.current[sid] || streamingRef.current[sid]
    if (!entry?.active) return false
    const lastActivity = Number(entry.lastDeltaAt || entry.startedAt || 0)
    return Date.now() - lastActivity >= 3_000
  }, [])

  const showToast = useCallback((text) => {
    if (!text) return
    setToastMsg(text)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null
      setToastMsg('')
    }, 2600)
  }, [])

  const [workbuddySetup, setWorkbuddySetup] = useState({
    status: 'idle', // 'idle' | 'working' | 'awaiting_login' | 'error'
    authUrl: '',
    error: '',
    methodId: 'internal',
  })
  const workbuddyPollTimerRef = useRef(null)

  const stopWorkbuddySetupPoll = useCallback(() => {
    if (workbuddyPollTimerRef.current) {
      clearInterval(workbuddyPollTimerRef.current)
      workbuddyPollTimerRef.current = null
    }
  }, [])

  const applyWorkbuddyUnlocked = useCallback((freshApps = null) => {
    stopWorkbuddySetupPoll()
    setWorkbuddySetup({ status: 'idle', authUrl: '', error: '', methodId: 'internal' })
    if (Array.isArray(freshApps)) {
      setAppsStatus(freshApps)
    }
    setSessions((prev) => prev.map((s) => (s.app === 'workbuddy' ? { ...s, writable: true } : s)))
    setActiveSession((prev) => {
      if (!prev || prev.app !== 'workbuddy') return prev
      const next = { ...prev, writable: true }
      activeSessionRef.current = next
      return next
    })
  }, [stopWorkbuddySetupPoll])

  const handleSetupWorkbuddy = useCallback(
    async (methodId = 'internal') => {
      const client = clientRef.current
      const reqBridgeId = String(activeBridgeIdRef.current || '').trim()
      if (!client || !reqBridgeId) {
        showToast(biLang(getCurrentLang(), '请先连接电脑后再启用 WorkBuddy', 'Connect your computer first'))
        return
      }
      const gen = deviceGenRef.current
      stopWorkbuddySetupPoll()
      setWorkbuddySetup({ status: 'working', authUrl: '', error: '', methodId })
      try {
        const res = await client.rpc(
          RPC.APP_SETUP,
          { app: 'workbuddy', action: 'setup', methodId },
          185_000,
          { bridgeId: reqBridgeId },
        )
        if (deviceGenRef.current !== gen || activeBridgeIdRef.current !== reqBridgeId) return

        if (res?.writable || res?.status === 'ready') {
          const fresh = await client.rpc(RPC.APPS_STATUS, {}, 12_000, { bridgeId: reqBridgeId }).catch(() => null)
          applyWorkbuddyUnlocked(fresh?.apps || null)
          showToast(biLang(getCurrentLang(), 'WorkBuddy 远程发送权限已解锁！', 'WorkBuddy remote sending unlocked!'))
          return
        }

        if (res?.ok && res?.status === 'awaiting_login') {
          const authUrl = typeof res.authUrl === 'string' && /^https:\/\//i.test(res.authUrl) ? res.authUrl : ''
          setWorkbuddySetup({ status: 'awaiting_login', authUrl, error: '', methodId })
          if (authUrl) {
            try {
              window.open(authUrl, '_blank', 'noopener,noreferrer')
            } catch {}
          }
          showToast(
            authUrl
              ? biLang(getCurrentLang(), '已打开腾讯官方登录页，微信扫码确认后自动解锁', 'Opened official login page. Scan QR to unlock automatically.')
              : biLang(getCurrentLang(), '已在电脑浏览器拉起官方登录页，扫码后自动解锁', 'Opened login page on your PC browser. Scan QR to unlock.'),
          )

          let pollCount = 0
          workbuddyPollTimerRef.current = setInterval(() => {
            pollCount += 1
            if (pollCount > 48 || deviceGenRef.current !== gen || activeBridgeIdRef.current !== reqBridgeId) {
              stopWorkbuddySetupPoll()
              return
            }
            const curClient = clientRef.current
            if (!curClient) return
            curClient
              .rpc(RPC.APPS_STATUS, {}, 10_000, { bridgeId: reqBridgeId })
              .then((stRes) => {
                if (deviceGenRef.current !== gen || activeBridgeIdRef.current !== reqBridgeId) return
                if (Array.isArray(stRes?.apps)) {
                  setAppsStatus(stRes.apps)
                  const wb = stRes.apps.find((a) => a.app === 'workbuddy')
                  if (wb?.writable) {
                    applyWorkbuddyUnlocked(stRes.apps)
                    showToast(biLang(getCurrentLang(), 'WorkBuddy 授权成功，已解锁远程发送！', 'WorkBuddy authorized! Remote sending unlocked.'))
                  }
                }
              })
              .catch(() => {})
          }, 2_500)
          return
        }

        const errMsg = res?.error || biLang(getCurrentLang(), '启用 WorkBuddy 失败，请稍后重试', 'Failed to set up WorkBuddy')
        setWorkbuddySetup({ status: 'error', authUrl: '', error: errMsg, methodId })
        showToast(errMsg)
      } catch (err) {
        if (deviceGenRef.current !== gen) return
        const errMsg = String(err?.message || err)
        setWorkbuddySetup({ status: 'error', authUrl: '', error: errMsg, methodId })
        showToast(errMsg)
      }
    },
    [applyWorkbuddyUnlocked, showToast, stopWorkbuddySetupPoll],
  )

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      stopWorkbuddySetupPoll()
      revokeAllSentPreviewUrls()
    }
  }, [revokeAllSentPreviewUrls, stopWorkbuddySetupPoll])

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
          if (
            deviceGenRef.current === gen &&
            clientRef.current === client &&
            (!targetBridge || activeBridgeIdRef.current === targetBridge) &&
            Array.isArray(res?.apps) &&
            res.apps.length > 0
          ) {
            setAppsStatus(res.apps)
          }
        })
        .catch(() => {})
    }
  }, [sidebarFilterApp, selectedDraftApp, appsStatus])

  const handleRefreshQuotas = useCallback(async () => {
    const client = clientRef.current
    if (!client) return
    const targetBridge = String(activeBridgeIdRef.current || '').trim()
    const gen = deviceGenRef.current
    setRefreshingQuotas(true)
    try {
      const res = await client.rpc(
        RPC.APPS_STATUS,
        { forceQuota: true },
        15_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
      if (
        deviceGenRef.current === gen &&
        clientRef.current === client &&
        (!targetBridge || activeBridgeIdRef.current === targetBridge) &&
        Array.isArray(res?.apps) &&
        res.apps.length > 0
      ) {
        setAppsStatus(res.apps)
      }
    } catch {
    } finally {
      if (deviceGenRef.current === gen) {
        setRefreshingQuotas(false)
      }
    }
  }, [])

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
        else if (action === 'toggle-dark') setDarkMode((v) => !v)
      })
    }
    return () => {
      try { unsubStatus?.() } catch {}
      try { unsubUpdate?.() } catch {}
      try { unsubMenu?.() } catch {}
    }
  }, [desktopApi, openNewChatModal])

  // Native Android OTA plugin: confirm healthy boot & subscribe to live download progress
  useEffect(() => {
    if (!nativeOtaPlugin) return
    const currentVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
    try {
      void nativeOtaPlugin.confirmBoot?.({ version: currentVersion })?.catch?.(() => {})
    } catch {}

    let handlePromise = null
    if (typeof nativeOtaPlugin.addListener === 'function') {
      try {
        handlePromise = Promise.resolve(
          nativeOtaPlugin.addListener('otaProgress', (ev) => {
            if (!ev || typeof ev !== 'object') return
            if (ev.status === 'downloading') {
              setUpdateState((prev) => ({
                ...(prev || {}),
                status: 'downloading',
                hotUpdate: true,
                mode: 'capacitor-ota',
                latestVersion: ev.version || prev?.latestVersion || '',
                downloadedBytes: Number(ev.downloadedBytes || 0),
                totalBytes: Number(ev.totalBytes || prev?.assetSize || 0),
                percent: Number(ev.percent || 0),
                error: '',
              }))
            }
          }),
        )
      } catch {}
    }
    return () => {
      handlePromise
        ?.then((h) => h?.remove?.())
        ?.catch?.(() => {})
    }
  }, [nativeOtaPlugin])

  const handleDownloadMobileUpdate = useCallback(
    async (explicitCandidate = null) => {
      const target = explicitCandidate || updateStateRef.current
      if (!nativeOtaPlugin?.downloadBundle || !target?.downloadUrl || !target?.expectedSha256) return null
      const curStatus = updateStateRef.current?.status
      if (curStatus === 'downloading' || curStatus === 'installing') return updateStateRef.current

      setUpdateState({
        ...target,
        status: 'downloading',
        hotUpdate: true,
        mode: 'capacitor-ota',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: Number(target.assetSize || 0),
        error: '',
      })

      try {
        const res = await nativeOtaPlugin.downloadBundle({
          version: target.latestVersion || '',
          minNativeVersion: target.minNativeVersion || '',
          url: target.downloadUrl,
          fallbackUrl: target.fallbackUrl || '',
          expectedSha256: target.expectedSha256,
          expectedSize: Number(target.assetSize || 0),
          signature: target.signature || '',
          sigAlg: target.sigAlg || '',
        })
        if (res?.status === 'cancelled') {
          const next = { ...target, status: 'available', percent: 0, error: '' }
          setUpdateState(next)
          return next
        }
        const next = {
          ...target,
          status: 'downloaded',
          hotUpdate: true,
          mode: 'capacitor-ota',
          latestVersion: res?.version || target.latestVersion || '',
          percent: 100,
          error: '',
        }
        setUpdateState(next)
        return next
      } catch (err) {
        const msg = String(err?.message || err || biLang(getCurrentLang(), '热更新下载失败', 'Hot update download failed'))
        const next = { ...target, status: 'error', error: msg }
        setUpdateState(next)
        return next
      }
    },
    [nativeOtaPlugin],
  )

  const handleCancelMobileUpdate = useCallback(async () => {
    try {
      await nativeOtaPlugin?.cancelDownload?.()
    } catch {}
    setUpdateState((prev) =>
      prev && prev.status === 'downloading'
        ? { ...prev, status: 'available', percent: 0, error: '' }
        : prev,
    )
  }, [nativeOtaPlugin])

  const handleInstallMobileUpdate = useCallback(async () => {
    const cur = updateStateRef.current
    if (!cur || cur.status === 'installing') return
    setUpdateState((prev) => ({ ...(prev || {}), status: 'installing', error: '' }))
    try {
      if (cur.mode === 'capacitor-ota' && nativeOtaPlugin?.applyUpdate) {
        // Clear any Service Worker / CacheStorage before switching Capacitor's local bundle root
        await clearWebCachesAndServiceWorkers()
        await nativeOtaPlugin.applyUpdate({ version: cur.latestVersion || '' })
        return
      }
      await performWebHotReload()
    } catch (err) {
      const msg = String(err?.message || err || biLang(getCurrentLang(), '热更重启失败', 'Hot restart failed'))
      setUpdateState((prev) => ({ ...(prev || {}), status: 'error', error: msg }))
    }
  }, [nativeOtaPlugin])

  const handleCheckNativeMobileUpdate = useCallback(
    async ({ silent = false } = {}) => {
      if (!canCheckMobileUpdate) return null
      const curStatus = updateStateRef.current?.status
      if (curStatus === 'downloading' || curStatus === 'installing') {
        return updateStateRef.current
      }
      const currentVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
      if (!silent) {
        setUpdateState((prev) => ({ ...(prev || {}), status: 'checking', currentVersion, error: '' }))
      }
      let nativeVersion = ''
      let stagedVersion = ''
      if (nativeOtaPlugin?.getAppInfo) {
        try {
          const info = await nativeOtaPlugin.getAppInfo()
          nativeVersion = String(info?.nativeVersion || '').trim()
          stagedVersion = String(info?.stagedVersion || '').trim()
        } catch {}
      }
      const next = await checkNativeMobileUpdate({
        currentVersion,
        nativeVersion,
        stagedVersion,
        hasNativeOta: Boolean(nativeOtaPlugin),
        baseUrl: activeDevice?.baseUrl || '',
        token: activeDevice?.token || '',
      })
      if (silent && next.status === 'error') {
        return next
      }
      // On manual check, if a small signed OTA hot-update bundle is available, start downloading in-app right away
      if (!silent && next.status === 'available' && next.hotUpdate && next.mode === 'capacitor-ota' && nativeOtaPlugin) {
        return handleDownloadMobileUpdate(next)
      }
      setUpdateState(next)
      return next
    },
    [canCheckMobileUpdate, nativeOtaPlugin, activeDevice?.baseUrl, activeDevice?.token, handleDownloadMobileUpdate],
  )

  // Mobile (Android APK & Mobile PWA) automatic silent update check shortly after launch + every 4 hours
  useEffect(() => {
    if (!canCheckMobileUpdate) return
    const startupTimer = setTimeout(() => {
      void handleCheckNativeMobileUpdate({ silent: true })
    }, 5_000)
    const periodicTimer = setInterval(() => {
      void handleCheckNativeMobileUpdate({ silent: true })
    }, 4 * 60 * 60 * 1000)
    return () => {
      clearTimeout(startupTimer)
      clearInterval(periodicTimer)
    }
  }, [canCheckMobileUpdate, handleCheckNativeMobileUpdate])

  const hadDesktopAccountRef = useRef(false)
  // Auto-bind & run embedded local PC bridge whenever signed into an account inside Desktop App
  useEffect(() => {
    if (!desktopApi) return
    if (activeDevice?.token && activeDevice?.baseUrl) {
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
  }, [desktopApi, activeDevice?.id, activeDevice?.token, activeDevice?.baseUrl, activeDevice?.roomId, activeDevice?.username])

  // Keep Desktop UI's local E2EE key ring synced with the embedded bridge key (zero friction on the host PC!)
  useEffect(() => {
    if (!desktopApi || !activeDevice?.id || !activeDevice?.token || !activeDevice?.roomId?.startsWith('usr_')) return
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
  }, [desktopApi, activeDevice?.id, activeDevice?.token, activeDevice?.roomId, desktopBridge?.e2eeKeyId, desktopBridge?.state])

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
        if (htmlPreviewState) setHtmlPreviewState(null)
        else if (lightboxState) setLightboxState(null)
        else if (pendingGrantPopup) setPendingGrantPopup(null)
        else if (modelPickerOpen) setModelPickerOpen(false)
        else if (e2eeModal.open) setE2eeModal((prev) => ({ ...prev, open: false, autoOpenScanner: false }))
        else if (newChatOpen) setNewChatOpen(false)
        else if (settingsOpen) setSettingsOpen(false)
        else if (deviceSwitcherOpen) setDeviceSwitcherOpen(false)
        else if (drawerOpen) setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDevice, openNewChatModal, selectedDraftCwd, htmlPreviewState, lightboxState, pendingGrantPopup, e2eeModal.open, modelPickerOpen, newChatOpen, settingsOpen, deviceSwitcherOpen, drawerOpen])

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
    const themeMeta = document.querySelector('meta[name="theme-color"]')
    if (themeMeta) {
      themeMeta.setAttribute('content', darkMode ? '#03080E' : '#FFFFFF')
    }
  }, [darkMode])

  useEffect(() => {
    try {
      localStorage.setItem('allinone_relay_data_saver', relayDataSaver ? '1' : '0')
    } catch {}
  }, [relayDataSaver])

  useEffect(() => {
    try {
      localStorage.setItem('allinone_image_compress', smartImageCompress ? '1' : '0')
    } catch {}
  }, [smartImageCompress])

  const resetTransientWorkspace = useCallback(() => {
    deviceGenRef.current += 1
    openRequestSeqRef.current += 1
    workspaceLoadSeqRef.current += 1
    olderReqSeqRef.current += 1
    quietSyncSeqRef.current += 1
    activeQuietSyncSeqRef.current = 0
    quietSyncPendingRef.current = ''
    loadingOlderLockRef.current = false
    liveStreamMapRef.current = {}
    activeSessionRef.current = null
    messagesRef.current = []
    modelsEtagRef.current = { bridgeId: '', etag: '' }
    historyMetaRef.current = { hasMore: false, nextCursor: null, totalCount: null }
    setActiveSession(null)
    setMessages([])
    setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: null })
    setOlderError('')
    setLoadingSession(false)
    setLoadingOlder(false)
    setLoadingModels(false)
    setAppsStatus([])
    setModelsCatalog({})
    setSessionModelPrefs({})
    setDraftDshPref(null)
    setSelectedDraftApp('')
    setSelectedDraftCwd('')
    setWorkspaces([])
    setSessions([])
    setStreamingBySession({})
    setApprovals([])
    setNewChatOpen(false)
    setNewChatCwd('')
    setNewChatApp('')
    setModelPickerOpen(false)
    setLightboxState(null)
    revokeAllSentPreviewUrls()
    clearE2eeMediaCache()
  }, [revokeAllSentPreviewUrls])

  const handleDeviceAuthenticated = useCallback((payload) => {
    const preview = upsertDevice(deviceStateRef.current, payload)
    resetTransientWorkspace()
    setBridges(Array.isArray(payload.bridges) ? payload.bridges : [])
    setAccountDevices(Array.isArray(payload.devices) ? payload.devices : [])
    setDeviceState((prev) => upsertDevice(prev, payload).state)
    setAddingDevice({ open: false, serverUrl: '' })
    setDeviceSwitcherOpen(false)
    if (preview.device) {
      const curLang = getCurrentLang()
      const onlineN = (payload.devices || payload.bridges || []).filter((x) => x.online).length
      const userLabel = payload.username || preview.device.username || preview.device.roomId
      showToast(
        onlineN > 0
          ? biLang(curLang, `已登录 @${userLabel} · 发现 ${onlineN} 台在线电脑`, `Signed in as @${userLabel} · ${onlineN} PC${onlineN === 1 ? '' : 's'} online`)
          : biLang(curLang, `已登录 @${userLabel}`, `Signed in as @${userLabel}`),
      )
    }
  }, [resetTransientWorkspace, showToast])

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
    const order = ['dsh', 'codex', 'claude', 'antigravity', 'workbuddy']
    for (const id of order) {
      if (appsStatus.find((a) => a.app === id && a.writable)) return id
    }
    for (const id of order) {
      if (appsStatus.find((a) => a.app === id && a.available)) return id
    }
    return 'dsh'
  }, [appsStatus])

  // Keep sidebar filter & draft app aligned with tools actually present on the active computer
  useEffect(() => {
    if (appsStatus.length === 0) return
    const detectedSet = new Set(
      appsStatus.filter((a) => a?.available || a?.writable).map((a) => a.app),
    )
    const sidebarSet = new Set(detectedSet)
    for (const s of sessions) {
      if (s?.app) sidebarSet.add(s.app)
    }
    if (sidebarFilterApp !== 'all' && (sidebarSet.size < 2 || !sidebarSet.has(sidebarFilterApp))) {
      setSidebarFilterApp('all')
    }
    if (selectedDraftApp && detectedSet.size > 0 && !detectedSet.has(selectedDraftApp)) {
      setSelectedDraftApp('')
    }
  }, [appsStatus, sessions, sidebarFilterApp, selectedDraftApp])

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

  const activeBridgeE2ee = useMemo(() => {
    const raw = activeBridge?.e2ee || null
    const enabled = Boolean(raw?.enabled && raw?.keyId)
    const keyId = enabled ? String(raw.keyId).trim().toLowerCase() : ''
    const keysMap = {}
    for (const [k, v] of Object.entries(activeDevice?.e2eeKeys || {})) {
      const ck = String(k || '').trim().toLowerCase()
      if (ck && v) keysMap[ck] = v
    }
    const matchedKey = keyId ? String(keysMap[keyId] || '') : ''
    const locked = Boolean(enabled && !matchedKey)
    const rawDesktopKid = String(desktopBridge?.e2eeKeyId || '').trim().toLowerCase()
    const desktopKeyId = rawDesktopKid && keysMap[rawDesktopKid] ? rawDesktopKid : ''
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
  const e2eeModalOpenRef = useRef(false)
  e2eeModalOpenRef.current = e2eeModal.open

  const phoneGuideKey = activeDevice?.roomId ? `allinone_phone_guide_done::${activeDevice.roomId}` : ''

  const dismissPhoneGuide = useCallback(() => {
    setPhoneGuideDismissed(true)
    if (phoneGuideKey) {
      try { localStorage.setItem(phoneGuideKey, '1') } catch {}
    }
  }, [phoneGuideKey])

  const openDesktopQrModal = useCallback(() => {
    setQrNudge(null)
    dismissPhoneGuide()
    setE2eeModal({ open: true, tab: 'show', autoOpenScanner: false })
  }, [dismissPhoneGuide])

  useEffect(() => {
    if (!phoneGuideKey) {
      setPhoneGuideDismissed(true)
      return
    }
    try {
      setPhoneGuideDismissed(localStorage.getItem(phoneGuideKey) === '1')
    } catch {
      setPhoneGuideDismissed(false)
    }
  }, [phoneGuideKey])

  // Auto-retire first-time desktop phone onboarding once a 2nd client (phone) connects to this account
  useEffect(() => {
    if (desktopApi && phoneGuideKey && liveOnlineClientCount >= 2 && !phoneGuideDismissed) {
      dismissPhoneGuide()
    }
  }, [desktopApi, phoneGuideKey, liveOnlineClientCount, phoneGuideDismissed, dismissPhoneGuide])

  // Auto-clear mobile scan nudge when QR modal opens or after 60s timeout
  useEffect(() => {
    if (e2eeModal.open && qrNudge) {
      setQrNudge(null)
      return
    }
    if (!qrNudge) return
    const timer = setTimeout(() => setQrNudge(null), 60_000)
    return () => clearTimeout(timer)
  }, [e2eeModal.open, qrNudge])

  // Mobile side C1: when locked on the E2EE unlock screen, gently nudge online desktop to surface a 1-click "Show QR" bar
  useEffect(() => {
    if (desktopApi || connState !== 'connected' || !bridgeOnline || !e2eeLocked) return
    const wantedKeyId = String(activeBridgeE2ee.keyId || '').trim().toLowerCase()
    clientRef.current?.sendQrNudge?.({ wantedKeyId, action: 'scanning' })
    return () => {
      clientRef.current?.sendQrNudge?.({ wantedKeyId, action: 'done' })
    }
  }, [desktopApi, connState, bridgeOnline, e2eeLocked, activeBridgeE2ee.keyId])

  useEffect(() => {
    clientRef.current?.setE2eeKeys(activeDevice?.e2eeKeys || {})
  }, [activeDevice?.e2eeKeys])

  const handleMediaCached = useCallback(() => {
    setMediaCacheRev((n) => n + 1)
  }, [])

  const imageContext = useMemo(() => {
    const localBridgeId = String(desktopBridge?.bridgeId || '').trim()
    const isLocalDesktopBridge = Boolean(
      desktopApi &&
      localBridgeId &&
      activeBridgeId &&
      localBridgeId === activeBridgeId,
    )
    return {
      roomId: activeDevice?.roomId || '',
      sessionId: activeSession?.id || '',
      cwd: activeSession?.cwd || '',
      bridgeId: activeBridgeId,
      client: clientRef.current,
      connState,
      bridgeOnline,
      p2pState,
      p2pTransport,
      relayDataSaver,
      mediaCacheRev,
      e2eeKeyId: activeBridgeE2ee.keyId,
      onOpenImage: setLightboxState,
      onOpenHtmlPreview: setHtmlPreviewState,
      onNotify: showToast,
      desktopApi,
      isLocalDesktopBridge,
    }
  }, [
    activeDevice?.id,
    activeDevice?.roomId,
    activeSession?.id,
    activeSession?.cwd,
    activeBridgeId,
    connState,
    bridgeOnline,
    p2pState,
    p2pTransport,
    relayDataSaver,
    mediaCacheRev,
    activeBridgeE2ee.keyId,
    desktopApi,
    desktopBridge?.bridgeId,
    showToast,
  ])

  const syncActiveSessionQuietly = useCallback(async (sessionId = '') => {
    const client = clientRef.current
    const targetId = sessionId || activeSessionRef.current?.id || ''
    if (!client || !targetId) return
    if (liveStreamMapRef.current[targetId]?.active || loadingOlderLockRef.current) return
    if (activeQuietSyncSeqRef.current !== 0) {
      quietSyncPendingRef.current = targetId
      return
    }

    const seq = ++quietSyncSeqRef.current
    activeQuietSyncSeqRef.current = seq
    const gen = deviceGenRef.current
    const scope = cacheScopeRef.current
    const targetBridge = activeBridgeIdRef.current
    try {
      const curMsgs = messagesRef.current || []
      const hasOptimistic = curMsgs.some((m) => /^msg-[ua]-/.test(String(m?.id || '')))
      const syncEtag =
        !hasOptimistic && curMsgs.length > 0 && activeSessionRef.current?.id === targetId
          ? String(activeSessionRef.current?.etag || '')
          : ''
      const res = await client.rpc(
        RPC.SESSION_READ,
        { id: targetId, limit: 14, ...(syncEtag ? { etag: syncEtag } : {}) },
        30_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
      if (
        quietSyncSeqRef.current !== seq ||
        deviceGenRef.current !== gen ||
        activeSessionRef.current?.id !== targetId ||
        liveStreamMapRef.current[targetId]?.active
      ) {
        return
      }
      if (res?.unchanged) {
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
        const nextHistoryMeta = {
          hasMore: reconciled.hasMore,
          nextCursor: reconciled.nextCursor,
          totalCount: reconciled.totalCount,
        }
        activeSessionRef.current = res.session
        messagesRef.current = reconciled.messages
        historyMetaRef.current = nextHistoryMeta
        setActiveSession(res.session)
        if (res.session.cwd) {
          saveLastWorkspace(scope, res.session.cwd)
          setSelectedDraftCwd(res.session.cwd)
        }
        setMessages(reconciled.messages)
        setHistoryMeta(nextHistoryMeta)
        pruneUnusedSentPreviewUrls(reconciled.messages)
        setSessions((prev) =>
          prev.map((s) =>
            s.id === targetId
              ? {
                  ...s,
                  status: res.session.status || s.status,
                  title: res.session.title || s.title,
                  cwd: res.session.cwd || s.cwd,
                  workspace: res.session.workspace || s.workspace,
                  syncState: res.session.syncState ?? null,
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
      if (activeQuietSyncSeqRef.current === seq) {
        activeQuietSyncSeqRef.current = 0
        const pendingId = quietSyncPendingRef.current
        quietSyncPendingRef.current = ''
        if (
          pendingId &&
          quietSyncSeqRef.current === seq &&
          deviceGenRef.current === gen &&
          activeSessionRef.current?.id === pendingId &&
          !liveStreamMapRef.current[pendingId]?.active
        ) {
          void syncActiveSessionQuietly(pendingId)
        }
      }
    }
  }, [pruneUnusedSentPreviewUrls])

  const loadWorkspaceData = useCallback(async (bridgeOverride = '') => {
    const client = clientRef.current
    if (!client || e2eeLockedRef.current) return
    const targetBridge = String(bridgeOverride || activeBridgeIdRef.current || '').trim()
    if (targetBridge) client.setTargetBridgeId(targetBridge)
    const gen = deviceGenRef.current
    const loadSeq = ++workspaceLoadSeqRef.current
    setRefreshing(true)
    try {
      const rpcOpts = targetBridge ? { bridgeId: targetBridge } : {}
      const cachedModelsEtag =
        modelsEtagRef.current.bridgeId === targetBridge &&
        modelsEtagRef.current.etag &&
        Object.keys(modelsCatalogRef.current || {}).length > 0
          ? modelsEtagRef.current.etag
          : ''
      const [statusRes, sessRes, wsRes, aprRes, modelsRes] = await Promise.all([
        client.rpc(RPC.APPS_STATUS, {}, 45_000, rpcOpts).catch(() => null),
        client.rpc(RPC.SESSIONS_LIST, { app: 'all', limit: 100 }, 45_000, rpcOpts).catch(() => null),
        client.rpc(RPC.WORKSPACES_LIST, {}, 45_000, rpcOpts).catch(() => null),
        client.rpc(RPC.APPROVAL_LIST, {}, 45_000, rpcOpts).catch(() => null),
        client.rpc(RPC.MODELS_LIST, cachedModelsEtag ? { etag: cachedModelsEtag } : {}, 45_000, rpcOpts).catch(() => null),
      ])
      if (
        deviceGenRef.current !== gen ||
        workspaceLoadSeqRef.current !== loadSeq ||
        clientRef.current !== client ||
        (targetBridge && activeBridgeIdRef.current && activeBridgeIdRef.current !== targetBridge)
      ) {
        return
      }
      if (statusRes && Array.isArray(statusRes.apps)) {
        setAppsStatus(statusRes.apps)
      }
      if (sessRes && Array.isArray(sessRes.sessions)) {
        setSessions(sessRes.sessions)
        const curActiveId = activeSessionRef.current?.id
        for (const s of sessRes.sessions) {
          if (s?.id && s.id === curActiveId) {
            setActiveSession((prev) => {
              if (!prev || prev.id !== s.id) return prev
              const merged = {
                ...prev,
                title: s.title || prev.title,
                cwd: s.cwd || prev.cwd,
                workspace: s.workspace || prev.workspace,
                status: s.status || prev.status,
                ...(s.updatedAt ? { updatedAt: Math.max(prev.updatedAt || 0, s.updatedAt) } : {}),
              }
              activeSessionRef.current = merged
              return merged
            })
            if (s.cwd) {
              saveLastWorkspace(cacheScopeRef.current, s.cwd)
              setSelectedDraftCwd(s.cwd)
            }
          }
          if (s?.id && s.status === 'idle' && isStaleStreamForIdle(s.id)) {
            clearLiveStreamEntry(s.id)
            if (activeSessionRef.current?.id === s.id) {
              void syncActiveSessionQuietly(s.id)
            }
          }
        }
      }
      if (wsRes && Array.isArray(wsRes.workspaces)) {
        setWorkspaces(wsRes.workspaces)
      }
      if (aprRes && Array.isArray(aprRes.approvals)) {
        setApprovals(aprRes.approvals)
      }
      if (modelsRes?.unchanged) {
        if (modelsRes.etag) {
          modelsEtagRef.current = { bridgeId: targetBridge, etag: String(modelsRes.etag) }
        }
      } else if (modelsRes?.catalog && Object.keys(modelsRes.catalog).length > 0) {
        setModelsCatalog(modelsRes.catalog)
        modelsEtagRef.current = { bridgeId: targetBridge, etag: String(modelsRes.etag || '') }
      }
    } finally {
      if (deviceGenRef.current === gen && workspaceLoadSeqRef.current === loadSeq) {
        setRefreshing(false)
      }
    }
  }, [clearLiveStreamEntry, isStaleStreamForIdle, syncActiveSessionQuietly])

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
    const apps = matched?.apps ?? matched?.meta?.apps
    return Array.isArray(apps) ? apps : null
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
      setAppsStatus((prev) =>
        activeBridgeMetaApps.map((nextApp) => {
          if (nextApp.quota) return nextApp
          const old = prev.find((p) => p.app === nextApp.app)
          return old?.quota ? { ...nextApp, quota: old.quota } : nextApp
        }),
      )
    }
    // If readiness changed mid-session on the same bridge, quietly refresh model catalog too
    if (prevKey && prevKey.startsWith(`${activeBridgeId}::`)) {
      const client = clientRef.current
      if (client) {
        const gen = deviceGenRef.current
        const reqBridgeId = activeBridgeId
        const reqEtag =
          modelsEtagRef.current.bridgeId === reqBridgeId &&
          modelsEtagRef.current.etag &&
          Object.keys(modelsCatalogRef.current || {}).length > 0
            ? modelsEtagRef.current.etag
            : ''
        client
          .rpc(RPC.MODELS_LIST, reqEtag ? { etag: reqEtag } : {}, 45_000, { bridgeId: reqBridgeId })
          .then((res) => {
            if (
              deviceGenRef.current !== gen ||
              activeBridgeIdRef.current !== reqBridgeId ||
              clientRef.current !== client
            ) {
              return
            }
            if (!res?.unchanged && res?.catalog && Object.keys(res.catalog).length > 0) {
              setModelsCatalog(res.catalog)
              modelsEtagRef.current = { bridgeId: reqBridgeId, etag: String(res.etag || '') }
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
    const openStartedAt = Date.now()
    const gen = deviceGenRef.current
    const scope = cacheScopeRef.current
    const targetBridge = activeBridgeIdRef.current
    olderReqSeqRef.current += 1
    loadingOlderLockRef.current = false
    setLoadingOlder(false)
    setOlderError('')
    setSessionOpenSeq((n) => n + 1)

    if (typeof sessionOrId === 'object') {
      activeSessionRef.current = sessionOrId
      setActiveSession(sessionOrId)
      if (sessionOrId.cwd) {
        saveLastWorkspace(scope, sessionOrId.cwd)
        setSelectedDraftCwd(sessionOrId.cwd)
      }
    }
    if (isDifferentSession) {
      // Clear previous session's messages immediately so ChatView never measures stale scrollHeight
      messagesRef.current = []
      historyMetaRef.current = { hasMore: false, nextCursor: null, totalCount: null }
      setMessages([])
      setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: null })
      pruneUnusedSentPreviewUrls([])
    }

    // 1. Show phone-cached history immediately (0ms perceived latency), strictly scoped to current PC
    const cached = await loadCachedSession(id, scope)
    if (openRequestSeqRef.current !== reqSeq || deviceGenRef.current !== gen) return
    if (cached && cached.messages?.length > 0) {
      if (cached.meta && typeof sessionOrId === 'string') {
        activeSessionRef.current = cached.meta
        setActiveSession(cached.meta)
        if (cached.meta.cwd) {
          saveLastWorkspace(scope, cached.meta.cwd)
          setSelectedDraftCwd(cached.meta.cwd)
        }
      }
      const nextMeta = {
        hasMore: Boolean(cached.hasMore),
        nextCursor: cached.nextCursor ?? null,
        totalCount: cached.totalCount ?? null,
      }
      messagesRef.current = cached.messages
      historyMetaRef.current = nextMeta
      setMessages(cached.messages)
      setHistoryMeta(nextMeta)
      setLoadingSession(false)
    } else {
      messagesRef.current = []
      historyMetaRef.current = { hasMore: false, nextCursor: null, totalCount: null }
      setMessages([])
      setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: null })
      setLoadingSession(true)
    }

    // 2. Sync latest page from PC (14 merged real Q&A bubbles ~15KB) and reconcile with phone cache
    try {
      const cachedMsgs = Array.isArray(cached?.messages) ? cached.messages : []
      const cachedHasOptimistic = cachedMsgs.some((m) => /^msg-[ua]-/.test(String(m?.id || '')))
      const openEtag = !cachedHasOptimistic && cachedMsgs.length > 0 ? String(cached?.meta?.etag || '') : ''
      const res = await client.rpc(
        RPC.SESSION_READ,
        { id, limit: 14, ...(openEtag ? { etag: openEtag } : {}) },
        45_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
      if (openRequestSeqRef.current !== reqSeq || deviceGenRef.current !== gen) return
      if (res?.unchanged) {
        if (cached?.meta?.status === 'idle' && isStaleStreamForIdle(id)) {
          clearLiveStreamEntry(id)
        }
        if (res.etag && activeSessionRef.current?.id === id && activeSessionRef.current.etag !== res.etag) {
          const mergedMeta = { ...activeSessionRef.current, etag: res.etag }
          activeSessionRef.current = mergedMeta
          setActiveSession(mergedMeta)
        }
        return
      }
      if (res?.session) {
        if (res.session.status === 'idle' && isStaleStreamForIdle(id)) {
          clearLiveStreamEntry(id)
        }
        const { messages: freshMsgs = [], hasMore, nextCursor, totalCount, ...metaOnly } = res.session
        const reconciled = reconcileCachedWithFreshPage(cached, {
          messages: freshMsgs,
          hasMore,
          nextCursor,
          totalCount,
        })
        // Preserve any optimistic msg-u-*/msg-a-* sent while SESSION_READ was in flight
        const recentTail = reconciled.messages.slice(-4)
        const pendingLocal = (messagesRef.current || []).filter((m) => {
          if (!m || !/^msg-[ua]-/.test(String(m.id || ''))) return false
          if (Number(m.ts || 0) < openStartedAt - 1_000) return false
          const trimmed = String(m.text || '').trim()
          const alreadyPersisted = recentTail.some(
            (fm) =>
              fm &&
              fm.role === m.role &&
              String(fm.text || '').trim() === trimmed &&
              (!fm.ts || Number(fm.ts) >= openStartedAt - 5_000),
          )
          return !alreadyPersisted
        })
        const finalMessages =
          pendingLocal.length > 0 ? [...reconciled.messages, ...pendingLocal] : reconciled.messages
        const nextMeta = {
          hasMore: reconciled.hasMore,
          nextCursor: reconciled.nextCursor,
          totalCount: reconciled.totalCount,
        }
        activeSessionRef.current = res.session
        messagesRef.current = finalMessages
        historyMetaRef.current = nextMeta
        setActiveSession(res.session)
        if (res.session.cwd) {
          saveLastWorkspace(scope, res.session.cwd)
          setSelectedDraftCwd(res.session.cwd)
        }
        setSessions((prev) =>
          prev.map((s) =>
            s.id === id
              ? {
                  ...s,
                  status: res.session.status || s.status,
                  title: res.session.title || s.title,
                  cwd: res.session.cwd || s.cwd,
                  workspace: res.session.workspace || s.workspace,
                  syncState: res.session.syncState ?? s.syncState,
                  ...(res.session.updatedAt ? { updatedAt: Math.max(s.updatedAt || 0, res.session.updatedAt) } : {}),
                }
              : s,
          ),
        )
        setMessages(finalMessages)
        setHistoryMeta(nextMeta)
        pruneUnusedSentPreviewUrls(finalMessages)
        void saveCachedSession(
          id,
          {
            meta: metaOnly,
            messages: finalMessages,
            hasMore: reconciled.hasMore,
            nextCursor: reconciled.nextCursor,
            totalCount: reconciled.totalCount,
          },
          scope,
        )
      }
    } catch (err) {
      if (openRequestSeqRef.current !== reqSeq || deviceGenRef.current !== gen) return
      if ((!cached || !cached.messages?.length) && !liveStreamMapRef.current[id]?.active) {
        const errEntry = {
          active: false,
          text: '',
          thinking: '',
          tools: [],
          error: String(err?.message || err),
        }
        liveStreamMapRef.current[id] = errEntry
        setStreamingBySession((prev) => ({
          ...prev,
          [id]: errEntry,
        }))
      }
    } finally {
      if (openRequestSeqRef.current === reqSeq && deviceGenRef.current === gen) {
        setLoadingSession(false)
      }
    }
  }, [clearLiveStreamEntry, isStaleStreamForIdle, pruneUnusedSentPreviewUrls])

  // Return cleanly to the empty All in One home screen (without disturbing background streams)
  const returnToHome = useCallback(() => {
    openRequestSeqRef.current += 1
    activeQuietSyncSeqRef.current += 1
    loadingOlderLockRef.current = false
    activeSessionRef.current = null
    messagesRef.current = []
    historyMetaRef.current = { hasMore: false, nextCursor: null, totalCount: null }
    setActiveSession(null)
    setMessages([])
    setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: null })
    setOlderError('')
    setLoadingSession(false)
    setLoadingOlder(false)
  }, [])

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

  // Auto-sync the open session whenever user switches back to All in One (Desktop focus or mobile resume)
  useEffect(() => {
    const triggerFocusSync = () => {
      if (document.visibilityState === 'hidden') return
      if (connState !== 'connected' || !activeBridgeIdRef.current) return
      const now = Date.now()
      if (now - lastFocusSyncAtRef.current < 1_500) return
      lastFocusSyncAtRef.current = now
      const curId = activeSessionRef.current?.id
      if (curId && !liveStreamMapRef.current[curId]?.active) {
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

    const reqSeq = ++olderReqSeqRef.current
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
      if (
        olderReqSeqRef.current !== reqSeq ||
        activeSessionRef.current?.id !== targetId ||
        deviceGenRef.current !== gen
      ) {
        return
      }
      if (res?.session) {
        const olderMsgs = Array.isArray(res.session.messages) ? res.session.messages : []
        const merged = mergeSessionMessages(olderMsgs, messagesRef.current)
        const nextHasMore = Boolean(res.session.hasMore) && Boolean(res.session.nextCursor) && res.session.nextCursor !== cursor
        const nextCur = nextHasMore ? res.session.nextCursor : null
        const nextTotal = res.session.totalCount ?? hMeta.totalCount ?? null
        const nextMeta = {
          hasMore: nextHasMore,
          nextCursor: nextCur,
          totalCount: nextTotal,
        }

        messagesRef.current = merged
        historyMetaRef.current = nextMeta
        setMessages(merged)
        setPrependSeq((n) => n + 1)
        setHistoryMeta(nextMeta)

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
      if (olderReqSeqRef.current === reqSeq && deviceGenRef.current === gen) {
        setOlderError(String(err?.message || err || biLang(getCurrentLang(), '加载更早历史失败', 'Failed to load earlier history')))
      }
    } finally {
      if (olderReqSeqRef.current === reqSeq) {
        loadingOlderLockRef.current = false
        if (deviceGenRef.current === gen) {
          setLoadingOlder(false)
        }
      }
    }
  }, [])

  const hasActiveToken = Boolean(activeDevice?.token)
  const revokedWipeGuardRef = useRef('')

  // Connect WebSocket whenever the active saved account changes
  useEffect(() => {
    const devSnap = activeDeviceRef.current
    const initialToken = activeDeviceTokenRef.current
    if (!activeDevice?.id || !activeDevice?.baseUrl || !initialToken) {
      setConnState(activeDevice?.id && activeDevice?.baseUrl && !initialToken ? 'unauthorized' : 'disconnected')
      setConnError('')
      setP2pState('idle')
      setP2pError('')
      setP2pEngine('')
      setP2pTransport('')
      setTurnQuota(null)
      setBridges([])
      setAccountDevices([])
      setClientSessions({
        sessions: [],
        onlineCount: 0,
        onlineDeviceCount: 0,
        totalCount: 0,
      })
      setLiveOnlineClientCount(0)
      return
    }

    setConnError('')
    setP2pState('idle')
    setP2pError('')
    setP2pEngine('')
    setP2pTransport('')
    setTurnQuota(null)
    setBridges([])
    setAccountDevices([])
    setClientSessions({
      sessions: [],
      onlineCount: 0,
      onlineDeviceCount: 0,
      totalCount: 0,
    })
    setLiveOnlineClientCount(0)

    const client = new MobileRelayClient({
      baseUrl: activeDevice.baseUrl,
      token: initialToken,
      roomId: devSnap?.roomId || '',
      bridgeId: devSnap?.selectedBridgeId || '',
      e2eeKeys: devSnap?.e2eeKeys || {},
    })
    setPendingGrantPopup(null)
    setQrNudge(null)
    clientRef.current = client

    const unsubStatus = client.onStatus(({ state, error, bridges: bList, devices: dList, onlineClientCount: occ, p2pState: nextP2p, p2pError: nextP2pErr, p2pEngine: nextP2pEngine, p2pTransport: nextP2pTransport, turnQuota: nextTurnQuota }) => {
      if (clientRef.current !== client) return
      setConnState(state)
      setConnError(error || '')
      setP2pState(nextP2p || 'idle')
      setP2pError(nextP2pErr || '')
      setP2pEngine(nextP2pEngine || '')
      setP2pTransport(nextP2pTransport || '')
      if (nextTurnQuota !== undefined) {
        setTurnQuota(nextTurnQuota || null)
        if (nextTurnQuota?.tier && activeDeviceRef.current?.id) {
          setDeviceState((prev) =>
            updateDeviceMeta(prev, activeDeviceRef.current.id, {
              tier: nextTurnQuota.tier,
              role: nextTurnQuota.tier === 'admin' ? 'admin' : 'user',
            }),
          )
        }
      }
      setBridges(bList || [])
      if (Array.isArray(dList)) setAccountDevices(dList)
      if (typeof occ === 'number') setLiveOnlineClientCount(occ)
    })

    const unsubEvents = client.onEvent((event, payload, rawMsg) => {
      if (clientRef.current !== client) return
      if (event === EVENTS.CLIENTS_STATUS) return
      if (event === EVENTS.BRIDGE_STATUS && !(payload?.app && payload?.quota)) return

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
        event === 'e2ee.grant.reveal' ||
        event === EVENTS.E2EE_GRANT_DELIVER ||
        event === EVENTS.E2EE_GRANT_REJECT
      ) {
        return
      }
      if (event === EVENTS.E2EE_QR_NUDGE && payload) {
        if (payload.requesterClientId && payload.requesterClientId === client.clientId) return
        if (payload.action === 'done') {
          setQrNudge((prev) =>
            prev && (!payload.requesterClientId || prev.requesterClientId === payload.requesterClientId)
              ? null
              : prev,
          )
          return
        }
        const myKeys = activeE2eeKeysRef.current || {}
        const wantedKid = String(payload.wantedKeyId || '').trim().toLowerCase()
        const canHelp = wantedKid ? Boolean(myKeys[wantedKid]) : Object.keys(myKeys).length > 0
        if (canHelp && !e2eeModalOpenRef.current) {
          setQrNudge({
            requesterClientId: payload.requesterClientId || '',
            deviceName: payload.deviceName || biLang(getCurrentLang(), '手机端', 'Phone'),
            wantedKeyId: wantedKid,
            receivedAt: Date.now(),
          })
        }
        return
      }

      // Strictly isolate live events to the currently selected computer bridge (never leak when active bridge is offline)
      const evBridgeId = String(rawMsg?.bridgeId || '').trim()
      const curBridgeId = activeBridgeIdRef.current
      if (evBridgeId && (!curBridgeId || evBridgeId !== curBridgeId)) {
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

      if (event === EVENTS.BRIDGE_STATUS && payload?.app && payload?.quota) {
        setAppsStatus((prev) => {
          const exists = prev.some((a) => a?.app === payload.app)
          if (!exists) return prev
          return prev.map((a) => (a?.app === payload.app ? { ...a, quota: payload.quota } : a))
        })
        return
      }

      if (event === EVENTS.SESSION_UPDATED && payload?.authReady && payload?.app === 'workbuddy') {
        const curClient = clientRef.current
        const reqBridgeId = activeBridgeIdRef.current
        if (curClient && reqBridgeId) {
          curClient
            .rpc(RPC.APPS_STATUS, {}, 12_000, { bridgeId: reqBridgeId })
            .then((res) => {
              if (Array.isArray(res?.apps) && res.apps.find((a) => a.app === 'workbuddy')?.writable) {
                applyWorkbuddyUnlocked(res.apps)
              }
            })
            .catch(() => {})
        }
        return
      }

      if (event === EVENTS.SESSION_UPDATED && payload?.session) {
        const updated = payload.session
        let clearedStaleStream = false
        if (updated.status === 'idle' && isStaleStreamForIdle(updated.id)) {
          clearLiveStreamEntry(updated.id)
          clearedStaleStream = true
        }
        setSessions((prev) => {
          const prevItem = prev.find((s) => s.id === updated.id)
          const merged = prevItem ? { ...prevItem, ...updated } : updated
          const next = [merged, ...prev.filter((s) => s.id !== updated.id)]
          next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          return next
        })
        if (activeSessionRef.current?.id === updated.id) {
          const nextCwd = String(updated.cwd || activeSessionRef.current?.cwd || '').trim()
          setActiveSession((prev) => {
            if (!prev || prev.id !== updated.id) return prev
            const merged = { ...prev, ...updated }
            activeSessionRef.current = merged
            return merged
          })
          if (nextCwd) {
            saveLastWorkspace(cacheScopeRef.current, nextCwd)
            setSelectedDraftCwd(nextCwd)
          }
          if (
            (payload.historyChanged || payload.statusChanged || clearedStaleStream) &&
            !liveStreamMapRef.current[updated.id]?.active
          ) {
            void syncActiveSessionQuietly(updated.id)
          }
        }
        return
      }

      if (event === EVENTS.STREAM_TASK_STATE && payload?.sessionId) {
        const targetSid = payload.sessionId
        const nextTaskState = payload.taskState ?? null
        setSessions((prev) =>
          prev.map((s) => (s.id === targetSid ? { ...s, taskState: nextTaskState } : s)),
        )
        if (activeSessionRef.current?.id === targetSid) {
          setActiveSession((prev) => {
            if (!prev || prev.id !== targetSid) return prev
            const merged = { ...prev, taskState: nextTaskState }
            activeSessionRef.current = merged
            return merged
          })
        }
        return
      }

      const sid = payload?.sessionId
      if (!sid) return

      const normalizeStreamBase = (raw, now) => ({
        active: true,
        text: typeof raw?.text === 'string' ? raw.text : '',
        thinking: typeof raw?.thinking === 'string' ? raw.thinking : '',
        tools: Array.isArray(raw?.tools) ? raw.tools : [],
        error: '',
        startedAt: Number(raw?.startedAt) || now,
        lastDeltaAt: now,
      })

      if (event === EVENTS.STREAM_START) {
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
        liveStreamMapRef.current[sid] = entry
        setStreamingBySession((prev) => ({ ...prev, [sid]: entry }))
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'running' } : s)))
      } else if (event === EVENTS.STREAM_DELTA) {
        const now = Date.now()
        const cur = normalizeStreamBase(liveStreamMapRef.current[sid], now)
        const nextEntry = {
          ...cur,
          text: cur.text + (payload.delta || ''),
        }
        liveStreamMapRef.current[sid] = nextEntry
        setStreamingBySession((prev) => ({ ...prev, [sid]: nextEntry }))
      } else if (event === EVENTS.STREAM_THINKING) {
        const now = Date.now()
        const cur = normalizeStreamBase(liveStreamMapRef.current[sid], now)
        const nextEntry = {
          ...cur,
          thinking: cur.thinking + (payload.delta || ''),
        }
        liveStreamMapRef.current[sid] = nextEntry
        setStreamingBySession((prev) => ({ ...prev, [sid]: nextEntry }))
      } else if (event === EVENTS.STREAM_TOOL_START && payload.tool) {
        const now = Date.now()
        const cur = normalizeStreamBase(liveStreamMapRef.current[sid], now)
        const exists = cur.tools.some((t) => t.id === payload.tool.id)
        const tools = exists
          ? cur.tools
          : [...cur.tools, { ...payload.tool, status: 'running', output: '' }]
        const nextEntry = { ...cur, tools }
        liveStreamMapRef.current[sid] = nextEntry
        setStreamingBySession((prev) => ({ ...prev, [sid]: nextEntry }))
      } else if (event === EVENTS.STREAM_TOOL_END && payload.toolId) {
        const now = Date.now()
        const prevRaw = liveStreamMapRef.current[sid]
        const cur = normalizeStreamBase(prevRaw, now)
        const tools = cur.tools.map((t) =>
          t.id === payload.toolId
            ? { ...t, status: payload.status || 'completed', output: payload.output || '' }
            : t,
        )
        const nextEntry = { ...cur, active: prevRaw?.active ?? true, tools }
        liveStreamMapRef.current[sid] = nextEntry
        setStreamingBySession((prev) => ({ ...prev, [sid]: nextEntry }))
      } else if (event === EVENTS.STREAM_ERROR) {
        const prevRaw = liveStreamMapRef.current[sid]
        const nextEntry = {
          active: false,
          text: typeof prevRaw?.text === 'string' ? prevRaw.text : '',
          thinking: typeof prevRaw?.thinking === 'string' ? prevRaw.thinking : '',
          tools: Array.isArray(prevRaw?.tools) ? prevRaw.tools : [],
          error: payload.message || biLang(getCurrentLang(), '执行出错', 'Execution error'),
        }
        liveStreamMapRef.current[sid] = nextEntry
        setStreamingBySession((prev) => ({ ...prev, [sid]: nextEntry }))
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'idle' } : s)))
      } else if (event === EVENTS.STREAM_DONE) {
        const cur = liveStreamMapRef.current[sid] || streamingRef.current[sid]
        delete liveStreamMapRef.current[sid]
        setStreamingBySession((prev) => {
          if (!(sid in prev)) return prev
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
          const cacheList = [...messagesRef.current, committed]
          messagesRef.current = cacheList
          setMessages((prev) => {
            const next = prev.some((m) => m.id === committed.id) ? prev : [...prev, committed]
            messagesRef.current = next
            return next
          })
          void saveCachedSession(
            sid,
            {
              meta: activeSessionRef.current,
              messages: cacheList,
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
        const doneGen = deviceGenRef.current
        setTimeout(() => {
          if (activeSessionRef.current?.id === sid && !liveStreamMapRef.current[sid]?.active) {
            void syncActiveSessionQuietly(sid)
          }
          // Quietly refresh E2EE subscription quota / readiness after a turn finishes
          if (
            payload?.app === 'codex' ||
            payload?.app === 'claude' ||
            payload?.app === 'antigravity' ||
            payload?.app === 'workbuddy'
          ) {
            const curClient = clientRef.current
            const reqBridgeId = activeBridgeIdRef.current
            if (curClient && curClient === client && reqBridgeId && deviceGenRef.current === doneGen) {
              curClient
                .rpc(RPC.APPS_STATUS, {}, 15_000, { bridgeId: reqBridgeId })
                .then((res) => {
                  if (
                    deviceGenRef.current === doneGen &&
                    activeBridgeIdRef.current === reqBridgeId &&
                    clientRef.current === curClient &&
                    Array.isArray(res?.apps)
                  ) {
                    setAppsStatus(res.apps)
                  }
                })
                .catch(() => {})
            }
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
  }, [activeDevice?.id, activeDevice?.baseUrl, hasActiveToken, clearLiveStreamEntry, isStaleStreamForIdle, syncActiveSessionQuietly])

  // On confirmed 401 / WS 4401 remote revocation, immediately wipe local secrets, caches, drafts & in-memory state
  useEffect(() => {
    if (connState !== 'unauthorized') {
      revokedWipeGuardRef.current = ''
      return
    }
    const devId = activeDevice?.id
    if (!devId || revokedWipeGuardRef.current === devId) return
    revokedWipeGuardRef.current = devId
    const devRoomId = activeDevice?.roomId || ''

    setDeviceState((prev) => clearDeviceCredentials(prev, devId))
    void clearSessionCache(devId, { prefix: true })
    void clearE2eeMediaCache({ persistent: true, ...(devRoomId ? { roomId: devRoomId } : {}) })
    clearDraftsForScope(devId)
    resetTransientWorkspace()
    setBridges([])
    setAccountDevices([])
    setClientSessions({
      sessions: [],
      onlineCount: 0,
      onlineDeviceCount: 0,
      totalCount: 0,
    })
    setLiveOnlineClientCount(0)
    setPendingGrantPopup(null)
    setQrNudge(null)
    try {
      window.Capacitor?.Plugins?.AllinOneFiles?.clearSharedCache?.().catch?.(() => {})
    } catch {}
  }, [connState, activeDevice?.id, activeDevice?.roomId, resetTransientWorkspace])

  // Hot-swap rotated JWT without tearing down an active WebSocket; only reconnect if unauthorized
  useEffect(() => {
    const token = activeDevice?.token
    const client = clientRef.current
    if (!token || !client) return
    client.updateToken(token)
    if (connStateRef.current === 'unauthorized') {
      client.connect()
    }
  }, [activeDevice?.token])

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
          : getDeviceDisplayName(target, null, getCurrentLang())
      showToast(biLang(getCurrentLang(), `已切换到 ${name}`, `Switched to ${name}`))
    }
  }, [activeDevice?.id, activeDevice?.selectedBridgeId, devices, accountDevices, onlineBridges, resetTransientWorkspace, showToast])

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
    const gen = deviceGenRef.current
    try {
      const res = await fetchAuthSessions(
        activeDevice.baseUrl,
        activeDevice.token,
        clientRef.current?.clientId || '',
      )
      if (deviceGenRef.current !== gen) return
      setClientSessions(res)
      setLiveOnlineClientCount(res.onlineCount)
    } catch {}
  }, [activeDevice?.baseUrl, activeDevice?.token])

  // Auto-refresh detailed client session list whenever live client count changes while settings is open or on connect
  useEffect(() => {
    if (!activeDevice?.baseUrl || !activeDevice?.token || connState !== 'connected') return
    void handleRefreshClientSessions()
  }, [
    activeDevice?.baseUrl,
    activeDevice?.token,
    connState,
    liveOnlineClientCount,
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
        setClientSessions(res)
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
      setClientSessions(res)
      setLiveOnlineClientCount(res.onlineCount)
      showToast(biLang(getCurrentLang(), '已下线其他全部登录设备，仅保留本机', 'Signed out all other devices'))
    } catch (err) {
      showToast(String(err?.message || err))
    }
  }, [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, showToast])

  const handleRefreshAccountDevices = useCallback(async () => {
    const targetDeviceId = activeDevice?.id
    const baseUrl = activeDevice?.baseUrl
    const token = activeDevice?.token
    const roomId = activeDevice?.roomId || ''
    if (!targetDeviceId || !baseUrl || !token) return
    const gen = deviceGenRef.current
    try {
      const [devRes, meRes] = await Promise.all([
        listAccountDevices(baseUrl, token).catch(() => null),
        probeDeviceStatus({ baseUrl, token, roomId }, 5000).catch(() => null),
      ])
      if (deviceGenRef.current !== gen) return
      if (devRes) setAccountDevices(devRes.devices)
      if (meRes && meRes.status !== 'expired' && meRes.status !== 'unreachable') {
        if (!devRes && Array.isArray(meRes.devices)) setAccountDevices(meRes.devices)
        setServerEmailEnabled(Boolean(meRes.emailEnabled))
        if (meRes.turnQuota) setTurnQuota(meRes.turnQuota)
        setDeviceState((prev) =>
          updateDeviceMeta(prev, targetDeviceId, {
            ...(meRes.username ? { username: meRes.username } : {}),
            ...(meRes.role ? { role: meRes.role } : {}),
            ...(meRes.tier ? { tier: meRes.tier } : {}),
            email: meRes.email || '',
            loginEmail2fa: Boolean(meRes.loginEmail2fa),
          }),
        )
      }
    } catch {}
  }, [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, activeDevice?.roomId])

  // Single unified account status probe on mount/switch/token refresh/settings open (keeps TURN quota usage fresh)
  useEffect(() => {
    const devId = activeDevice?.id
    const baseUrl = activeDevice?.baseUrl
    const token = activeDevice?.token
    const roomId = activeDevice?.roomId || ''
    if (!devId || !baseUrl || !token) {
      setServerEmailEnabled(false)
      return
    }
    let cancelled = false
    probeDeviceStatus({ baseUrl, token, roomId }, 5000)
      .then((res) => {
        if (cancelled || !res || res.status === 'expired' || res.status === 'unreachable') return
        if (Array.isArray(res.devices)) setAccountDevices(res.devices)
        setServerEmailEnabled(Boolean(res.emailEnabled))
        if (res.turnQuota) setTurnQuota(res.turnQuota)
        setDeviceState((prev) =>
          updateDeviceMeta(prev, devId, {
            ...(res.username ? { username: res.username } : {}),
            ...(res.role ? { role: res.role } : {}),
            ...(res.tier ? { tier: res.tier } : {}),
            email: res.email || '',
            loginEmail2fa: Boolean(res.loginEmail2fa),
          }),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, activeDevice?.roomId, settingsOpen])

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
    async (targetEmail, code, currentPassword = '') => {
      if (!activeDevice?.id || !activeDevice?.baseUrl || !activeDevice?.token) {
        throw new Error(biLang(getCurrentLang(), '未登录账号', 'Not signed in'))
      }
      const user = await bindAccountEmail(activeDevice.baseUrl, activeDevice.token, {
        email: targetEmail,
        code,
        currentPassword,
      })
      const boundEmail = user?.email || targetEmail
      setDeviceState((prev) => updateDeviceMeta(prev, activeDevice.id, { email: boundEmail }))
      showToast(biLang(getCurrentLang(), `已绑定邮箱 ${boundEmail}`, `Linked email ${boundEmail}`))
      return user
    },
    [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, showToast],
  )

  const handleToggleLoginEmail2fa = useCallback(
    async (enabled, currentPassword = '') => {
      if (!activeDevice?.id || !activeDevice?.baseUrl || !activeDevice?.token) return
      try {
        const user = await setAccountLogin2fa(
          activeDevice.baseUrl,
          activeDevice.token,
          enabled,
          currentPassword,
        )
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
        if (!enabled) {
          throw err
        }
        showToast(String(err?.message || err))
      }
    },
    [activeDevice?.id, activeDevice?.baseUrl, activeDevice?.token, showToast],
  )

  const handleImportE2eeKey = useCallback(
    async (rawKey, keyId, { applyToDesktopBridge = false } = {}) => {
      if (!activeDevice?.id || !rawKey || !keyId) return
      let finalKey = rawKey
      let finalKeyId = String(keyId).trim().toLowerCase()
      if (applyToDesktopBridge && desktopApi?.setE2eeKey && activeDevice?.roomId) {
        const res = await desktopApi.setE2eeKey(activeDevice.roomId, rawKey)
        if (res?.key && res?.keyId) {
          finalKey = res.key
          finalKeyId = String(res.keyId).trim().toLowerCase()
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
      const validEntries = entries
        .filter((e) => e?.keyId && e?.key)
        .map((e) => ({ keyId: String(e.keyId).trim().toLowerCase(), key: e.key }))
      if (validEntries.length === 0) return

      const normPreferred = String(preferredKeyId || '').trim().toLowerCase()
      const preferred =
        validEntries.find((e) => e.keyId === normPreferred) || validEntries[0]

      const nextKeys = { ...(activeDevice.e2eeKeys || {}) }
      for (const item of validEntries) {
        delete nextKeys[item.keyId]
        nextKeys[item.keyId] = item.key
      }

      let desktopKeyEntry = null
      if (applyToDesktopBridge && desktopApi?.setE2eeKey && activeDevice?.roomId && preferred?.key) {
        const res = await desktopApi.setE2eeKey(activeDevice.roomId, preferred.key)
        if (res?.key && res?.keyId) {
          const desktopKid = String(res.keyId).trim().toLowerCase()
          delete nextKeys[desktopKid]
          nextKeys[desktopKid] = res.key
          desktopKeyEntry = { keyId: desktopKid, key: res.key }
        }
        const st = await desktopApi.getBridgeStatus?.().catch(() => null)
        if (st) setDesktopBridge(st)
      }

      clientRef.current?.setE2eeKeys(nextKeys)
      setDeviceState((prev) => {
        let next = prev
        for (const item of validEntries) {
          next = upsertDeviceE2eeKey(next, activeDevice.id, item.keyId, item.key)
        }
        if (desktopKeyEntry) {
          next = upsertDeviceE2eeKey(next, activeDevice.id, desktopKeyEntry.keyId, desktopKeyEntry.key)
        }
        if (preferred?.keyId && preferred?.key) {
          next = upsertDeviceE2eeKey(next, activeDevice.id, preferred.keyId, preferred.key)
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
        qrGrantSecret: grantQr.grantSecret || '',
      })
      return true
    },
    [activeDevice?.roomId],
  )

  const handleRotateDesktopE2eeKey = useCallback(async () => {
    if (!desktopApi?.rotateE2eeKey || !activeDevice?.id || !activeDevice?.roomId) return
    const res = await desktopApi.rotateE2eeKey(activeDevice.roomId)
    if (res?.key && res?.keyId) {
      const nextKid = String(res.keyId).trim().toLowerCase()
      const nextKeys = {
        ...(activeDevice.e2eeKeys || {}),
        [nextKid]: res.key,
      }
      clientRef.current?.setE2eeKeys(nextKeys)
      setDeviceState((prev) => upsertDeviceE2eeKey(prev, activeDevice.id, nextKid, res.key))
    }
    const st = await desktopApi.getBridgeStatus?.().catch(() => null)
    if (st) setDesktopBridge(st)
    void clearE2eeMediaCache({ persistent: true, roomId: activeDevice.roomId })
    showToast(biLang(getCurrentLang(), '已轮换端到端密钥并重启本机桥接', 'Rotated E2EE key and restarted local bridge'))
  }, [desktopApi, activeDevice?.id, activeDevice?.roomId, activeDevice?.e2eeKeys, showToast])

  const handleRemoveDevice = useCallback(async (deviceId, { revokeAll = false } = {}) => {
    const target = devices.find((d) => d.id === deviceId)
    if (target?.baseUrl && target?.token) {
      try {
        if (revokeAll) {
          await revokeDeviceSessions(target.baseUrl, target.token)
        } else {
          await logoutDeviceSession(target.baseUrl, target.token)
        }
      } catch {}
    }
    const removingActive = activeDevice?.id === deviceId
    const removingLast = devices.length <= 1
    void clearSessionCache(deviceId, { prefix: true })
    if (target?.roomId) {
      void clearE2eeMediaCache({ persistent: true, roomId: target.roomId })
    }
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
      const name = getDeviceDisplayName(target, null, curLang)
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
    const startOpenSeq = openRequestSeqRef.current
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
    // If the user explicitly opened another conversation while SESSION_CREATE was in flight,
    // keep the newly created session in the sidebar without hijacking their active viewport.
    if (openRequestSeqRef.current !== startOpenSeq) {
      return created
    }
    openRequestSeqRef.current += 1
    olderReqSeqRef.current += 1
    loadingOlderLockRef.current = false
    setLoadingSession(false)
    setLoadingOlder(false)
    setOlderError('')
    setSessionOpenSeq((n) => n + 1)
    const emptyMeta = { hasMore: false, nextCursor: null, totalCount: 0 }
    activeSessionRef.current = created
    messagesRef.current = []
    historyMetaRef.current = emptyMeta
    pruneUnusedSentPreviewUrls([])
    setActiveSession(created)
    if (created.cwd) {
      saveLastWorkspace(cacheScopeRef.current, created.cwd)
      setSelectedDraftCwd(created.cwd)
    }
    setMessages([])
    setHistoryMeta(emptyMeta)
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
    if (!client) return false
    const gen = deviceGenRef.current
    const scope = cacheScopeRef.current
    const targetBridge = activeBridgeIdRef.current

    let target = activeSession
    const createdJustNow = !target
    if (!target) {
      // Strictly require an explicitly chosen project directory before creating a new conversation
      const explicitCwd = String(selectedDraftCwd || '').trim()
      if (!explicitCwd) {
        showToast(bi('请先选择目标项目目录', 'Please select a target project directory first'))
        openNewChatModal('', effectiveDefaultApp)
        return false
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
        if (deviceGenRef.current !== gen || !target) return false
      } catch (err) {
        showToast(String(err?.message || err))
        return false
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
    const validAtts = Array.isArray(attachments)
      ? attachments.filter((a) => a && typeof a === 'object')
      : []
    const imgAtts = validAtts.filter((a) => String(a.mimeType || '').startsWith('image/'))
    const nonImgAtts = validAtts.filter((a) => !String(a.mimeType || '').startsWith('image/'))
    for (const a of imgAtts) {
      if (typeof a.localPreviewUrl === 'string' && a.localPreviewUrl.startsWith('blob:')) {
        sentPreviewUrlsRef.current.add(a.localPreviewUrl)
      }
    }
    const displayUserText =
      nonImgAtts.length > 0
        ? `${finalText}${finalText ? '\n' : ''}[${bi('附件', 'Attachment')}: ${nonImgAtts.map((a) => a.filename).join(', ')}]`
        : finalText
    const userMsg = {
      id: `msg-u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      text: displayUserText,
      ...(imgAtts.length > 0
        ? {
            images: imgAtts.map((a) => ({
              id: a.id || a.p2pToken || a.localPreviewUrl || '',
              ...(a.url ? { url: a.url } : {}),
              name: a.filename,
              mimeType: a.mimeType,
              ...(a.localPreviewUrl ? { localPreviewUrl: a.localPreviewUrl } : {}),
            })),
          }
        : {}),
      ts: Date.now(),
    }
    const wireAttachments = validAtts.map(({ localPreviewUrl: _drop, ...rest }) => rest)
    const baseMessages = createdJustNow ? [] : messagesRef.current
    const baseHistoryMeta = createdJustNow
      ? { hasMore: false, nextCursor: null, totalCount: 0 }
      : historyMetaRef.current
    const nextWithUser = [...baseMessages, userMsg]
    messagesRef.current = nextWithUser
    setMessages((prev) => {
      const base = createdJustNow ? [] : prev
      const next = base.some((m) => m.id === userMsg.id) ? base : [...base, userMsg]
      messagesRef.current = next
      return next
    })
    void saveCachedSession(
      target.id,
      {
        meta: target,
        messages: nextWithUser,
        hasMore: baseHistoryMeta.hasMore,
        nextCursor: baseHistoryMeta.nextCursor,
        totalCount: baseHistoryMeta.totalCount,
      },
      scope,
    )

    const startNow = Date.now()
    const initStream = {
      active: true,
      text: '',
      thinking: '',
      tools: [],
      error: '',
      startedAt: startNow,
      lastDeltaAt: startNow,
    }
    liveStreamMapRef.current[target.id] = initStream
    setStreamingBySession((prev) => ({
      ...prev,
      [target.id]: initStream,
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
      return true
    } catch (err) {
      if (deviceGenRef.current !== gen) return true
      const streamUntouched = liveStreamMapRef.current[target.id] === initStream
      if (streamUntouched) {
        const errEntry = {
          active: false,
          text: '',
          thinking: '',
          tools: [],
          error: String(err?.message || err),
        }
        liveStreamMapRef.current[target.id] = errEntry
        setStreamingBySession((prev) => ({
          ...prev,
          [target.id]: errEntry,
        }))
        // Return preview URL ownership back to Composer and roll back unsent optimistic bubble
        for (const a of imgAtts) {
          if (a?.localPreviewUrl) sentPreviewUrlsRef.current.delete(a.localPreviewUrl)
        }
        const stillOnTarget = activeSessionRef.current?.id === target.id
        if (stillOnTarget) {
          const rolledBack = messagesRef.current.filter((m) => m?.id !== userMsg.id)
          messagesRef.current = rolledBack
          setMessages((prev) => {
            const next = prev.filter((m) => m?.id !== userMsg.id)
            messagesRef.current = next
            return next
          })
          void saveCachedSession(
            target.id,
            {
              meta: target,
              messages: rolledBack,
              hasMore: baseHistoryMeta.hasMore,
              nextCursor: baseHistoryMeta.nextCursor,
              totalCount: baseHistoryMeta.totalCount,
            },
            scope,
          )
        } else {
          // User already switched to another session: never overwrite Session A's cache with Session B's messages
          void loadCachedSession(target.id, scope).then((cachedTarget) => {
            if (!cachedTarget || !Array.isArray(cachedTarget.messages)) return
            const cleaned = cachedTarget.messages.filter((m) => m?.id !== userMsg.id)
            return saveCachedSession(
              target.id,
              {
                meta: cachedTarget.meta || target,
                messages: cleaned,
                hasMore: cachedTarget.hasMore,
                nextCursor: cachedTarget.nextCursor,
                truncatedByCap: cachedTarget.truncatedByCap,
                totalCount: cachedTarget.totalCount,
              },
              scope,
            )
          }).catch(() => {})
        }
        return false
      }
      return true
    }
  }

  const handleInterrupt = async () => {
    const client = clientRef.current
    const sess = activeSessionRef.current
    if (!client || !sess?.id) return
    const sid = sess.id
    const gen = deviceGenRef.current
    const targetBridge = activeBridgeIdRef.current
    try {
      const res = await client.rpc(
        RPC.SESSION_INTERRUPT,
        { id: sid },
        45_000,
        targetBridge ? { bridgeId: targetBridge } : {},
      )
      if (deviceGenRef.current !== gen) return
      if (res?.interrupted === false) {
        clearLiveStreamEntry(sid)
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'idle' } : s)))
        void syncActiveSessionQuietly(sid)
      }
    } catch {
      if (deviceGenRef.current !== gen) return
      clearLiveStreamEntry(sid)
      setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'idle' } : s)))
      void syncActiveSessionQuietly(sid)
    }
  }

  const handleResolveApproval = async (id, decisionOrPayload) => {
    const client = clientRef.current
    if (!client) return
    const gen = deviceGenRef.current
    const targetBridge = activeBridgeIdRef.current
    const rpcOpts = targetBridge ? { bridgeId: targetBridge } : {}
    const payload =
      decisionOrPayload && typeof decisionOrPayload === 'object'
        ? { id, decision: decisionOrPayload.decision || 'submit', answers: decisionOrPayload.answers }
        : { id, decision: decisionOrPayload }
    try {
      const res = await client.rpc(RPC.APPROVAL_RESOLVE, payload, 45_000, rpcOpts)
      if (deviceGenRef.current !== gen) return
      if (res && res.resolved === false) {
        const reason = String(res.reason || '')
        const isAlreadyHandled = /not\s*found|already|不存在|已处理|已过期|expired/i.test(reason)
        if (isAlreadyHandled) {
          setApprovals((prev) => prev.filter((a) => a.id !== id))
        }
        showToast(reason || biLang(getCurrentLang(), '审批未能提交，请重试', 'Could not resolve prompt'))
        return
      }
      setApprovals((prev) => prev.filter((a) => a.id !== id))
    } catch (err) {
      if (deviceGenRef.current !== gen) return
      showToast(String(err?.message || err))
      // Background re-sync so stale/already-handled prompts are removed from UI
      client
        .rpc(RPC.APPROVAL_LIST, {}, 20_000, rpcOpts)
        .then((listRes) => {
          if (
            deviceGenRef.current !== gen ||
            clientRef.current !== client ||
            (targetBridge && activeBridgeIdRef.current !== targetBridge)
          ) {
            return
          }
          if (listRes && Array.isArray(listRes.approvals)) {
            setApprovals(listRes.approvals)
          }
        })
        .catch(() => {})
    }
  }

  if (!activeDevice || addingDevice.open) {
    return (
      <LoginScreen
        isAddingDevice={Boolean(activeDevice && addingDevice.open)}
        initialServerUrl={addingDevice.serverUrl || activeDevice?.baseUrl || ''}
        darkMode={darkMode}
        onToggleDark={() => setDarkMode((v) => !v)}
        onCancel={
          activeDevice
            ? () => {
                setAddingDevice({ open: false, serverUrl: '' })
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
  const currentWorkspaceLabel = activeSession
    ? (activeSession.workspace || '')
    : (selectedDraftWorkspaceObj?.name || '')
  const headerSubtitle = (() => {
    if (connState === 'unauthorized') return `${activeDeviceName} · ${t('common.expired')}`
    if (connState === 'error') return `${activeDeviceName} · ${bi('连接已断开', 'Disconnected')}`
    if (connState !== 'connected') return `${activeDeviceName} · ${t('common.connecting')}`
    if (!bridgeOnline) return `${activeDeviceName} · ${t('common.offline')}`
    if (!e2eeLocked && p2pState === 'failed') {
      return `${activeDeviceName} · ${turnQuota?.exceeded ? bi('中继额度已用完', 'Relay Quota Reached') : bi('P2P 直连受限', 'P2P Blocked')}`
    }
    if (!e2eeLocked && p2pState === 'connecting') return `${activeDeviceName} · ${bi('正在建立 P2P 直连...', 'Connecting P2P...')}`
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
        appsStatus={appsStatus}
        activeSessionId={activeSession?.id}
        pendingApprovalSessionIds={pendingApprovalSessionIds}
        onSelectSession={openSession}
        onGoHome={returnToHome}
        filterApp={sidebarFilterApp}
        onFilterAppChange={setSidebarFilterApp}
        onNewChat={(cwdHint = '', appHint = '') => openNewChatModal(cwdHint, appHint)}
        onRefresh={() => loadWorkspaceData(activeBridgeId)}
        refreshing={refreshing}
        connState={connState}
        bridgeOnline={bridgeOnline}
        activeDeviceName={activeDeviceName}
        username={activeDevice?.username || ''}
        isAdmin={isAdmin}
        isDesktopApp={Boolean(desktopApi)}
        isMacDesktop={isMacDesktop}
        hasUpdate={updateState?.status === 'available' || updateState?.status === 'downloaded'}
        e2eeLocked={e2eeLocked}
        canShowMyQr={Boolean(!e2eeLocked && activeBridgeE2ee.shareableKey)}
        onShowMyQr={openDesktopQrModal}
        onQuickScan={() =>
          setE2eeModal({
            open: true,
            tab: desktopApi ? 'request' : 'import',
            autoOpenScanner: !desktopApi,
          })
        }
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
              <VendorBadge
                app={activeApp}
                size="xs"
                active={Boolean(
                  currentStream?.active ||
                    activeSession?.status === 'running' ||
                    activeSession?.syncState?.externalRunning,
                )}
              />
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
                    connState === 'unauthorized' || connState === 'error'
                      ? 'bg-rose-500'
                      : connState === 'connected' && bridgeOnline
                        ? !e2eeLocked && p2pState === 'failed'
                          ? 'bg-rose-500'
                          : !e2eeLocked && p2pState === 'connecting'
                            ? 'bg-amber-400 animate-pulse'
                            : 'bg-emerald-500'
                        : connState === 'connecting'
                          ? 'bg-amber-400'
                          : 'bg-rose-400'
                  }`}
                />
                <span className="truncate">{headerSubtitle}</span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-65" />
              </button>
              {connState === 'connected' && bridgeOnline && !e2eeLocked && p2pState === 'connected' && (
                <span
                  title={
                    p2pTransport === 'relay'
                      ? bi(
                          `当前处于双对称 NAT，已自动经加密 TURN 中继连接（保持 AES-256-GCM 端到端加密${p2pEngine ? ` · ${p2pEngine}` : ''}）`,
                          `Connected via encrypted TURN relay for symmetric NAT traversal (AES-256-GCM E2EE${p2pEngine ? ` · ${p2pEngine}` : ''})`,
                        )
                      : bi(
                          `WebRTC 端到端 P2P 直连（0 服务器流量${p2pEngine ? ` · ${p2pEngine}` : ''}）`,
                          `Direct WebRTC P2P connection (0 server relay traffic${p2pEngine ? ` · ${p2pEngine}` : ''})`,
                        )
                  }
                  className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    p2pTransport === 'relay'
                      ? 'bg-sky-500/12 text-sky-600 dark:text-sky-400'
                      : 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  <Zap className="h-2.5 w-2.5" />
                  <span>{p2pTransport === 'relay' ? bi('中继', 'Relay') : 'P2P'}</span>
                </span>
              )}
              {connState === 'connected' && bridgeOnline && activeBridgeE2ee.enabled && e2eeLocked && (
                <button
                  type="button"
                  onClick={() => {
                    setE2eeModal({
                      open: true,
                      tab: desktopApi ? 'request' : 'import',
                      autoOpenScanner: false,
                    })
                  }}
                  title={bi('需扫码同步端到端加密密钥', 'Sync E2EE key')}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 transition hover:bg-amber-500/25 active:scale-95 dark:text-amber-400"
                >
                  <Lock className="h-2.5 w-2.5" />
                  <span>{bi('同步密钥', 'Unlock')}</span>
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => openNewChatModal(activeSession?.cwd || selectedDraftCwd || '')}
            aria-label={t('common.newChat')}
            title={activeSession?.cwd ? bi('在当前项目新建对话', 'New chat in current project') : t('common.newChat')}
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
            onClick={() => setAddingDevice({ open: true, serverUrl: activeDevice.baseUrl })}
            className="rounded-lg bg-rose-500 px-2.5 py-0.5 text-[11px] font-semibold text-white active:scale-95"
          >
            {bi('重新登录', 'Sign In Again')}
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

      {/* Connection limit / fatal WS error banner (e.g., close code 4029) */}
      {connState === 'error' && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-200">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>{connError || bi('连接已断开，请重试', 'Connection closed. Please reconnect.')}</span>
          <button
            type="button"
            onClick={() => clientRef.current?.connect()}
            className="rounded-lg bg-rose-500 px-2.5 py-0.5 text-[11px] font-semibold text-white active:scale-95"
          >
            {bi('重新连接', 'Reconnect')}
          </button>
        </div>
      )}

      {/* Offline warning bar if control server connected but target PC bridge offline */}
      {connState === 'connected' && !bridgeOnline && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>
            {accountDevices.length === 0
              ? bi('尚未绑定电脑', 'No computer linked')
              : `${activeDeviceName} ${t('common.offline')}`}
          </span>
          <button
            type="button"
            onClick={() => setDeviceSwitcherOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-500/25 dark:text-amber-100"
          >
            <ArrowLeftRight className="h-3 w-3" />
            <span>{accountDevices.length === 0 ? bi('绑定', 'Link') : t('common.switch')}</span>
          </button>
        </div>
      )}

      {/* Honest P2P unreachable banner when strict UDP firewall blocks direct NAT traversal (0 server relay fallback) */}
      {connState === 'connected' && bridgeOnline && !e2eeLocked && p2pState === 'failed' && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-200">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>
            {turnQuota?.exceeded
              ? bi(
                  `本月加密中继额度已用完（${formatBytesCompact(turnQuota.usedBytes)} / ${formatBytesCompact(turnQuota.quotaBytes)}），切换至同 Wi-Fi / 家用宽带可继续免费 P2P 直连，或联系管理员升级等级`,
                  `Monthly encrypted relay quota reached (${formatBytesCompact(turnQuota.usedBytes)} / ${formatBytesCompact(turnQuota.quotaBytes)}). Switch to Wi-Fi / home broadband for free direct P2P or contact admin to upgrade.`,
                )
              : p2pError || bi('P2P 直连受当前网络防火墙限制，请切换 Wi-Fi / 5G 后重试', 'Direct P2P blocked by network firewall. Switch Wi-Fi / 5G and retry.')}
          </span>
          <button
            type="button"
            onClick={() => {
              void clientRef.current
                ?.retryP2p(activeBridgeId)
                ?.then(() => loadWorkspaceData(activeBridgeId))
                .catch(() => {})
            }}
            className="inline-flex items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-0.5 text-[11px] font-semibold text-white active:scale-95"
          >
            <RefreshCw className="h-3 w-3" />
            <span>{bi('重试直连', 'Retry P2P')}</span>
          </button>
        </div>
      )}

      {/* Cross-session pending question/approval jump banner */}
      {otherSessionApprovals.length > 0 && connState === 'connected' && bridgeOnline && !e2eeLocked && (() => {
        const first = otherSessionApprovals[0]
        const targetSess = sessions.find((s) => s.id === first.sessionId)
        const jumpTarget = targetSess || first.sessionId
        return (
          <div className="flex items-center justify-center gap-2 bg-[#EEF2FF] px-3 py-1.5 text-xs text-[#2842C9] dark:bg-[#1F2742] dark:text-[#B4C4FF]">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#4D6BFE] animate-pulse" />
            <span className="truncate">
              {bi(
                `「${targetSess?.title || first.title}」等待你的选择`,
                `${targetSess?.title || first.title} is waiting for your input`,
              )}
            </span>
            {jumpTarget && (
              <button
                type="button"
                onClick={() => openSession(jumpTarget)}
                className="shrink-0 rounded-lg bg-[#4D6BFE] px-2.5 py-0.5 text-[11px] font-semibold text-white active:scale-95"
              >
                {bi('去查看', 'View')}
              </button>
            )}
          </div>
        )
      })()}

      {/* C1: Live nudge banner when another logged-in device (e.g. phone) is waiting to scan this computer's QR */}
      {qrNudge &&
        connState === 'connected' &&
        !e2eeLocked &&
        activeBridgeE2ee.shareableKey &&
        (!qrNudge.wantedKeyId || activeBridgeE2ee.shareableKeyId === qrNudge.wantedKeyId) &&
        !e2eeModal.open && (
        <div className="animate-reveal-down flex flex-wrap items-center justify-center gap-2 border-b border-[#4D6BFE]/20 bg-[#EEF2FF] px-3 py-2 text-xs text-[#2842C9] dark:border-[#4D6BFE]/30 dark:bg-[#1C243C] dark:text-[#C5D3FF]">
          <span className="h-2 w-2 shrink-0 rounded-full bg-[#4D6BFE] animate-pulse" />
          <Smartphone className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE]" />
          <span>
            {bi(
              `「${qrNudge.deviceName}」正在等待扫码同步密钥`,
              `${qrNudge.deviceName} is waiting to scan your QR code`,
            )}
          </span>
          <button
            type="button"
            onClick={openDesktopQrModal}
            className="scan-btn-sweep inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#4D6BFE] px-2.5 py-1 text-[11px] font-semibold text-white shadow-xs transition hover:bg-[#3B59ED] active:scale-95"
          >
            <QrCode className="h-3 w-3" />
            <span>{bi('一键显示二维码', 'Show QR Code')}</span>
          </button>
          <button
            type="button"
            onClick={() => setQrNudge(null)}
            aria-label={bi('关闭提示', 'Dismiss')}
            className="rounded-lg p-1 text-[#4D6BFE]/70 transition hover:bg-[#4D6BFE]/12 hover:text-[#2842C9] dark:text-slate-400 dark:hover:text-slate-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* B1: First-time desktop non-blocking onboarding strip (auto-retires once a phone connects or dismissed) */}
      {desktopApi &&
        connState === 'connected' &&
        bridgeOnline &&
        !e2eeLocked &&
        activeBridgeE2ee.shareableKey &&
        liveOnlineClientCount <= 1 &&
        !phoneGuideDismissed &&
        !qrNudge &&
        !e2eeModal.open && (
          <div className="animate-reveal-down flex flex-wrap items-center justify-center gap-2 border-b border-slate-200/70 bg-[#F4F7FF] px-3 py-2 text-xs text-slate-700 dark:border-slate-800 dark:bg-[#1A1F30] dark:text-slate-200">
            <Smartphone className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE]" />
            <span>
              {bi(
                '想用手机随时远程控制？手机登录同账号后扫本机二维码即可解锁',
                'Want to control from your phone? Sign in on mobile and scan this computer’s QR',
              )}
            </span>
            <button
              type="button"
              onClick={openDesktopQrModal}
              className="scan-btn-sweep inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#4D6BFE] px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-[#3B59ED] active:scale-95"
            >
              <QrCode className="h-3 w-3" />
              <span>{bi('显示二维码', 'Show QR')}</span>
            </button>
            <button
              type="button"
              onClick={dismissPhoneGuide}
              aria-label={bi('以后再说', 'Dismiss')}
              className="rounded-lg px-1.5 py-0.5 text-[11px] text-slate-400 transition hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              {bi('暂不', 'Later')}
            </button>
          </div>
        )}

      {/* Non-intrusive toast pill */}
      {toastMsg && (
        <div className="pointer-events-none fixed top-16 left-1/2 z-[60] -translate-x-1/2">
          <div className="animate-toast-in rounded-full bg-slate-900/90 px-4 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur-md dark:bg-white/95 dark:text-slate-900">
            {toastMsg}
          </div>
        </div>
      )}

      {/* Main Chat Viewport (or E2EE Key Sync Lock Screen when bridge is E2EE-protected and key is not yet synced) */}
      {connState === 'connected' && bridgeOnline && e2eeLocked ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
          <div className="animate-sheet-in w-full max-w-sm rounded-3xl border border-slate-200/80 bg-slate-50/70 p-6 shadow-sm dark:border-slate-800 dark:bg-[#1C1F27]">
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
                    className="scan-btn-sweep flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-3 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 transition hover:bg-[#3B59ED] active:scale-[0.98]"
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
                  <p className="pt-1.5 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
                    {bi(
                      '电脑端已自动弹出提示，或点击电脑端左下角「连手机」显示二维码',
                      'Check the prompt on your computer, or click "Phone" in the bottom-left to display the QR code',
                    )}
                  </p>
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
        onLoadOlder={loadOlderMessages}
        appsStatus={appsStatus}
        sessions={sessions}
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
        activeDeviceName={activeDeviceName}
        bridgeOnline={bridgeOnline}
        refreshingQuotas={refreshingQuotas}
        onRefreshQuotas={handleRefreshQuotas}
        approvals={activeSessionApprovals}
        imageContext={imageContext}
        onResolveApproval={handleResolveApproval}
      />

      {/* Floating DeepSeek-style Composer (or sleek live-mirror / 1-click unlock footer for read-only Desktop sessions) */}
      {(() => {
        const wbStatus = appsStatus.find((a) => a.app === 'workbuddy')
        const isWorkbuddyReadonly =
          (activeSession?.app === 'workbuddy' && activeSession?.writable === false) ||
          (!activeSession && activeApp === 'workbuddy' && wbStatus && !wbStatus.writable)
        if (isWorkbuddyReadonly) {
          const isWorking = workbuddySetup.status === 'working'
          const isAwaiting = workbuddySetup.status === 'awaiting_login'
          const needsCli = wbStatus?.setupState === 'needs_cli' || !wbStatus?.cliInstalled
          return (
            <div className="pb-safe shrink-0 bg-white/90 px-3 pt-2 backdrop-blur-md dark:bg-[#16171A]/90">
              <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-[#06C798]/30 bg-[#EEFBF7] px-3.5 py-2.5 lg:max-w-3xl dark:border-[#06C798]/30 dark:bg-[#142522]">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      isWorking || isAwaiting || activeSession?.syncState?.externalRunning
                        ? 'bg-[#06C798] animate-pulse-dot'
                        : 'bg-amber-400'
                    }`}
                  />
                  <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                    {isWorking
                      ? bi('正在后台自动安装官方引擎并拉起扫码页，请稍候…', 'Setting up WorkBuddy engine & opening sign-in…')
                      : isAwaiting
                        ? bi('请在弹出的官方页面完成微信扫码确认，完成后自动解锁发送', 'Finish scanning QR on the official page — unlocks automatically')
                        : activeSession?.syncState?.externalRunning
                          ? bi('WorkBuddy 正在电脑端执行 · 实时只读同步中', 'WorkBuddy running on PC · Live read-only sync')
                          : needsCli
                            ? bi('WorkBuddy 当前实时只读同步 · 一键自动安装并扫码即可远程发送', 'WorkBuddy live mirror · 1-click auto-setup & sign in to send')
                            : bi('WorkBuddy 引擎已就绪 · 微信扫码授权一次即可解锁远程发送', 'WorkBuddy engine ready · 1-click QR sign-in to unlock sending')}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {isAwaiting && workbuddySetup.authUrl ? (
                    <a
                      href={workbuddySetup.authUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full bg-[#06C798] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#05B187] active:scale-95"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      <span>{bi('打开官方授权页', 'Open Sign-In Page')}</span>
                    </a>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={isWorking || !bridgeOnline || connState !== 'connected'}
                        onClick={() => handleSetupWorkbuddy('internal')}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[#06C798] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#05B187] active:scale-95 disabled:opacity-60"
                      >
                        {isWorking ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <QrCode className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {isWorking
                            ? bi('配置中…', 'Setting up…')
                            : needsCli
                              ? bi('一键启用发送', '1-Click Enable')
                              : bi('一键微信扫码登录', '1-Click QR Sign-In')}
                        </span>
                      </button>
                      {!isWorking && (
                        <button
                          type="button"
                          disabled={!bridgeOnline || connState !== 'connected'}
                          onClick={() => handleSetupWorkbuddy('external')}
                          title={bi('海外版账号（Google / GitHub）登录', 'International account (Google / GitHub)')}
                          className="rounded-full border border-slate-300/80 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-white/70 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800/60"
                        >
                          {bi('国际版', 'Global')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        }
        if (activeSession?.writable === false) {
          return (
            <div className="pb-safe shrink-0 bg-white/90 px-3 pt-2 backdrop-blur-md dark:bg-[#16171A]/90">
              <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-2.5 rounded-2xl border border-slate-200/90 bg-[#F4F6FA] px-3.5 py-2.5 lg:max-w-3xl dark:border-slate-700/80 dark:bg-[#21232B]">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      activeSession?.syncState?.externalRunning
                        ? 'bg-emerald-500 animate-pulse-dot'
                        : 'bg-slate-400 dark:bg-slate-500'
                    }`}
                  />
                  <span className="truncate text-xs font-medium text-slate-600 dark:text-slate-300">
                    {activeSession?.syncState?.externalRunning
                      ? bi('Claude Desktop 正在电脑端执行 · 实时只读同步中', 'Claude Desktop running on PC · Live read-only sync')
                      : bi('Claude Desktop (Cowork) 只读同步视图', 'Claude Desktop (Cowork) read-only mirror')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => openNewChatModal(activeSession?.cwd || '', activeSession?.app || 'claude')}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#4D6BFE] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#3B59ED] active:scale-95"
                >
                  <SquarePen className="h-3.5 w-3.5" />
                  <span>{bi('同目录新建可写对话', 'New Writable Chat')}</span>
                </button>
              </div>
            </div>
          )
        }
        return (
          <Composer
            key={activeDevice?.id || 'none'}
            draftKey={makeDraftKey(cacheScope, activeSession?.id, activeApp)}
            activeApp={activeApp}
            streaming={Boolean(currentStream?.active)}
            disabled={!bridgeOnline || connState !== 'connected' || e2eeLocked}
            needsWorkspace={!activeSession && !selectedDraftCwd}
            targetWorkspaceName={!activeSession ? (selectedDraftWorkspaceObj?.name || '') : ''}
            modelPref={activeModelPref}
            modelDisplayName={activeModelObj?.name || activeModelPref.model}
            onOpenModelPicker={() => {
              setModelPickerOpen(true)
              const curModels = modelsCatalog?.[activeApp]?.models || []
              if (curModels.length === 0 && clientRef.current && connState === 'connected' && activeBridgeId) {
                const client = clientRef.current
                const gen = deviceGenRef.current
                const reqBridgeId = activeBridgeId
                setLoadingModels(true)
                client
                  .rpc(RPC.MODELS_LIST, { app: activeApp }, 25_000, { bridgeId: reqBridgeId })
                  .then((res) => {
                    if (
                      deviceGenRef.current !== gen ||
                      activeBridgeIdRef.current !== reqBridgeId ||
                      clientRef.current !== client
                    ) {
                      return
                    }
                    if (res?.catalog) {
                      setModelsCatalog((prev) => ({ ...prev, ...res.catalog }))
                    }
                  })
                  .catch(() => {})
                  .finally(() => {
                    if (deviceGenRef.current === gen && activeBridgeIdRef.current === reqBridgeId) {
                      setLoadingModels(false)
                    }
                  })
              }
            }}
            onUploadFile={async (rawFile) => {
              const { file: uploadTarget } = await compressImageForUpload(rawFile, {
                enabled: smartImageCompress,
              })
              return clientRef.current?.uploadFile(uploadTarget, { bridgeId: activeBridgeId })
            }}
            onSend={handleSend}
            onInterrupt={handleInterrupt}
            onError={showToast}
          />
        )
      })()}
      </>
      )}
      </div>

      {/* Lazily loaded Modals & Sheets (only fetched/mounted when opened) */}
      <Suspense fallback={null}>
        {deviceSwitcherOpen && (
          <DeviceSwitcherModal
            open={deviceSwitcherOpen}
            onClose={() => setDeviceSwitcherOpen(false)}
            devices={devices}
            activeDeviceId={activeDevice?.id}
            activeBridgeId={activeBridgeId || activeDevice?.selectedBridgeId || ''}
            activeConnState={connState}
            accountDevices={accountDevices}
            onSelectDevice={handleSelectDevice}
            onAddDevice={(prefillServerUrl = '') => {
              setAddingDevice({
                open: true,
                serverUrl: prefillServerUrl || activeDevice?.baseUrl || '',
              })
            }}
            onRemoveDevice={handleRemoveDevice}
            onSyncDeviceMeta={handleSyncDeviceMeta}
            onRenameAccountDevice={handleRenameAccountDevice}
            onRemoveAccountDevice={handleRemoveAccountDevice}
            onRefreshAccountDevices={handleRefreshAccountDevices}
          />
        )}

        {newChatOpen && (
          <NewChatModal
            open={newChatOpen}
            scopeKey={cacheScope}
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
            workbuddySetup={workbuddySetup}
            onSetupWorkbuddy={handleSetupWorkbuddy}
            onCreate={handleCreateSession}
          />
        )}

        {modelPickerOpen && (
          <ModelPickerSheet
            open={modelPickerOpen}
            app={activeApp}
            catalog={activeCatalog}
            loading={loadingModels}
            value={activeModelPref}
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
        )}

        {settingsOpen && (
          <SettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            activeDevice={activeDevice}
            activeDeviceName={activeDeviceName}
            isAdmin={isAdmin}
            emailEnabled={serverEmailEnabled}
            connState={connState}
            bridgeOnline={bridgeOnline}
            clientSessions={clientSessions}
            onlineClientCount={liveOnlineClientCount || clientSessions.onlineCount}
            onRefreshClientSessions={handleRefreshClientSessions}
            onRevokeClientSession={handleRevokeClientSession}
            onRevokeOtherClientSessions={handleRevokeOtherClientSessions}
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
            onCheckUpdate={
              desktopApi
                ? () => { void desktopApi.checkForUpdates?.().then((st) => st && setUpdateState(st)) }
                : canCheckMobileUpdate
                  ? () => { void handleCheckNativeMobileUpdate({ silent: false }) }
                  : null
            }
            onDownloadUpdate={
              desktopApi
                ? () => { void desktopApi.downloadUpdate?.().then((st) => st && setUpdateState(st)) }
                : nativeOtaPlugin
                  ? () => { void handleDownloadMobileUpdate() }
                  : null
            }
            onCancelUpdate={
              desktopApi
                ? () => { void desktopApi.cancelUpdateDownload?.().then((st) => st && setUpdateState(st)) }
                : nativeOtaPlugin
                  ? () => { void handleCancelMobileUpdate() }
                  : null
            }
            onInstallUpdate={
              desktopApi
                ? () => { void desktopApi.installUpdate?.().then((st) => st && setUpdateState(st)) }
                : canCheckMobileUpdate
                  ? () => { void handleInstallMobileUpdate() }
                  : null
            }
            onSendBindEmailCode={handleSendBindEmailCode}
            onBindAccountEmail={handleBindAccountEmail}
            onToggleLogin2fa={handleToggleLoginEmail2fa}
            turnQuota={turnQuota}
            relayDataSaver={relayDataSaver}
            onToggleRelayDataSaver={() => setRelayDataSaver((v) => !v)}
            smartImageCompress={smartImageCompress}
            onToggleSmartImageCompress={() => setSmartImageCompress((v) => !v)}
            onRemoveDevice={handleRemoveDevice}
          />
        )}

        {e2eeModal.open && (
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
            initialTab={e2eeModal.tab}
            autoOpenScanner={e2eeModal.autoOpenScanner}
            onImportKey={handleImportE2eeKey}
            onImportKeyring={handleImportE2eeKeyring}
            onScanGrantQr={handleScanGrantQr}
            onRotateDesktopKey={desktopApi ? handleRotateDesktopE2eeKey : null}
          />
        )}

        {pendingGrantPopup && (
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
        )}

        {lightboxState && (
          <ImageLightbox
            state={lightboxState}
            imageContext={imageContext}
            onMediaCached={handleMediaCached}
            onClose={() => setLightboxState(null)}
          />
        )}

        {htmlPreviewState && (
          <HtmlPreviewModal
            state={htmlPreviewState}
            onClose={() => setHtmlPreviewState(null)}
          />
        )}
      </Suspense>
    </div>
  )
}

export default App
