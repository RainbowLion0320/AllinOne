import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  ChevronDown,
  ExternalLink,
  Home,
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
import { formatE2eeFingerprint } from '@allinone/shared/e2ee'
import { compressImageForUpload } from './lib/imageCompress.js'
import {
  getActiveDevice,
  loadDeviceState,
  saveDeviceState,
  upsertDevice,
} from './lib/deviceStore.js'
import { formatBytesCompact } from './lib/sessionCache.js'
import { makeDraftKey } from './lib/draftStore.js'
import { pollGithubOAuth } from './lib/wsClient.js'
import {
  clearPendingGithubOAuth,
  loadPendingGithubOAuth,
  stripOAuthQueryParamFromUrl,
} from './lib/githubOAuthClient.js'
import { useSessionStreamingActive } from './state/streamingStore.js'
import { ImageActionsProvider, ImageLiveStateProvider } from './state/ImageContext.jsx'
import { useTransportBridge } from './hooks/useTransportBridge.js'
import { useSessionManager } from './hooks/useSessionManager.js'
import { useOtaUpdater } from './hooks/useOtaUpdater.js'
import { useE2eeActions } from './hooks/useE2eeActions.js'
import { useAccountDevices } from './hooks/useAccountDevices.js'
import { useModalBackLayer } from './hooks/useModalBackLayer.js'
import { SidebarDrawer } from './components/SidebarDrawer.jsx'
import { ChatView } from './components/ChatView.jsx'
import { Composer } from './components/Composer.jsx'
import { AppModals } from './components/AppModals.jsx'
import { SectionErrorBoundary, ModalLoadingFallback } from './components/SectionErrorBoundary.jsx'
import { VendorBadge } from './components/VendorIcon.jsx'
import { useI18n } from './lib/i18n.jsx'
import { bi as biLang, getCurrentLang } from './lib/i18n.js'

const LoginScreen = React.lazy(() =>
  import('./components/LoginScreen.jsx').then((m) => ({ default: m.LoginScreen })),
)

export function App() {
  const { lang, bi, t } = useI18n()
  const [deviceState, setDeviceState] = useState(() => loadDeviceState())
  const [addingDevice, setAddingDevice] = useState({ open: false, serverUrl: '' })
  const [toastMsg, setToastMsg] = useState('')
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('allinone_dark') === '1')
  const [dataSaver, setDataSaver] = useState(() => localStorage.getItem('allinone_data_saver') !== '0')
  const [mediaCacheRev, setMediaCacheRev] = useState(0)
  const [phoneGuideDismissed, setPhoneGuideDismissed] = useState(false)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [deviceSwitcherOpen, setDeviceSwitcherOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [e2eeModal, setE2eeModal] = useState({ open: false, tab: 'auto', autoOpenScanner: false })
  const [lightboxState, setLightboxState] = useState(null)
  const [htmlPreviewState, setHtmlPreviewState] = useState(null)

  const desktopApi = typeof window !== 'undefined' ? window.allinoneDesktop || null : null
  const isMacDesktop = desktopApi?.platform === 'darwin'

  const devices = deviceState.devices
  const activeDevice = useMemo(() => getActiveDevice(deviceState), [deviceState])
  const isAdmin = Boolean(activeDevice && activeDevice.role === 'admin')

  const skipFirstSaveRef = useRef(true)
  const deviceStateRef = useRef(deviceState)
  deviceStateRef.current = deviceState
  const activeDeviceRef = useRef(activeDevice)
  activeDeviceRef.current = activeDevice
  const dataSaverRef = useRef(dataSaver)
  dataSaverRef.current = dataSaver
  const clientRef = useRef(null)
  const deviceGenRef = useRef(0)
  const sessionHandlersRef = useRef(null)
  const hasSessionContextRef = useRef(false)
  const onMenuActionRef = useRef(null)
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

  const {
    connState,
    connStateRef,
    connError,
    p2pState,
    p2pError,
    p2pEngine,
    p2pTransport,
    turnQuota,
    setTurnQuota,
    setBridges,
    onlineBridges,
    activeBridge,
    bridgeOnline,
    activeBridgeId,
    activeBridgeIdRef,
    activeDeviceName,
    cacheScope,
    cacheScopeRef,
    activeBridgeE2ee,
    e2eeLocked,
    e2eeLockedRef,
    activeBridgeMetaApps,
    activeBridgeAppsSig,
    accountDevices,
    setAccountDevices,
    clientSessions,
    setClientSessions,
    liveOnlineClientCount,
    setLiveOnlineClientCount,
    serverEmailEnabled,
    setServerEmailEnabled,
    serverGithubEnabled,
    setServerGithubEnabled,
    pendingGrantPopup,
    setPendingGrantPopup,
    qrNudge,
    setQrNudge,
    desktopBridge,
    setDesktopBridge,
    clientInstance,
  } = useTransportBridge({
    activeDevice,
    activeDeviceRef,
    clientRef,
    desktopApi,
    lang,
    e2eeModalOpen: e2eeModal.open,
    setDeviceState,
    onMenuActionRef,
    sessionHandlersRef,
    hasSessionContextRef,
    showToast,
  })

  const handleResetTransientModals = useCallback(() => {
    setLightboxState(null)
    setHtmlPreviewState(null)
  }, [])

  const {
    appsStatus,
    modelsCatalog,
    loadingModels,
    effectiveWorkspaces,
    sessions,
    refreshing,
    refreshingQuotas,
    activeSession,
    activeSessionRef,
    messages,
    historyMeta,
    prependSeq,
    sessionOpenSeq,
    olderError,
    loadingSession,
    loadingOlder,
    approvals,
    activeSessionApprovals,
    otherSessionApprovals,
    pendingApprovalSessionIds,
    sidebarFilterApp,
    setSidebarFilterApp,
    selectedDraftCwd,
    selectedDraftCwdRef,
    selectedDraftWorkspaceObj,
    newChatOpen,
    setNewChatOpen,
    newChatCwd,
    newChatApp,
    modelPickerOpen,
    setModelPickerOpen,
    workbuddySetup,
    activeApp,
    activeCatalog,
    activeModelPref,
    activeModelObj,
    resetTransientWorkspace,
    openNewChatModal,
    closeNewChatModal,
    handleOpenNewChatFromHome,
    handleSelectDraftApp,
    handleSelectDraftWorkspace,
    handleRefreshQuotas,
    handleSetupWorkbuddy,
    loadWorkspaceData,
    openSession,
    returnToHome,
    loadOlderMessages,
    handleCreateSession,
    handleSend,
    handleInterrupt,
    handleResolveApproval,
    handleOpenModelPicker,
    handleApplyModelPref,
  } = useSessionManager({
    clientRef,
    deviceGenRef,
    activeDeviceId: activeDevice?.id || '',
    activeBridgeId,
    activeBridgeIdRef,
    cacheScope,
    cacheScopeRef,
    connState,
    connStateRef,
    p2pState,
    e2eeLocked,
    e2eeLockedRef,
    activeBridgeMetaApps,
    activeBridgeAppsSig,
    sessionHandlersRef,
    hasSessionContextRef,
    onResetModals: handleResetTransientModals,
    showToast,
  })

  onMenuActionRef.current = (action) => {
    if (action === 'new-chat') openNewChatModal(activeSessionRef.current?.cwd || '')
    else if (action === 'devices') setDeviceSwitcherOpen(true)
    else if (action === 'settings') setSettingsOpen(true)
    else if (action === 'toggle-dark') setDarkMode((v) => !v)
  }

  const {
    updateState,
    setUpdateState,
    otaInfo,
    nativeOtaPlugin,
    canCheckMobileUpdate,
    handleCheckNativeMobileUpdate,
    handleDownloadMobileUpdate,
    handleCancelMobileUpdate,
    handleInstallMobileUpdate,
    handleResetOtaBundle,
  } = useOtaUpdater({ desktopApi, activeDevice, showToast })

  const {
    handleSelectDevice,
    handleSyncDeviceMeta,
    handleRenameAccountDevice,
    handleRemoveAccountDevice,
    handleRefreshClientSessions,
    handleRevokeClientSession,
    handleRevokeOtherClientSessions,
    handleRefreshAccountDevices,
    handleSendBindEmailCode,
    handleBindAccountEmail,
    handleToggleLoginEmail2fa,
    handleGithubLinked,
    handleUnlinkGithub,
    handleRemoveDevice,
  } = useAccountDevices({
    devices,
    activeDevice,
    activeDeviceRef,
    activeBridgeIdRef,
    deviceGenRef,
    clientRef,
    connState,
    accountDevices,
    onlineBridges,
    liveOnlineClientCount,
    settingsOpen,
    setDeviceState,
    setBridges,
    setAccountDevices,
    setClientSessions,
    setLiveOnlineClientCount,
    setServerEmailEnabled,
    setServerGithubEnabled,
    setTurnQuota,
    setDeviceSwitcherOpen,
    setDrawerOpen,
    resetTransientWorkspace,
    showToast,
  })

  const {
    handleImportE2eeKey,
    handleImportE2eeKeyring,
    handleScanGrantQr,
    handleRotateDesktopE2eeKey,
  } = useE2eeActions({
    activeDeviceRef,
    clientRef,
    desktopApi,
    setDeviceState,
    setDesktopBridge,
    setPendingGrantPopup,
    showToast,
  })

  // Persist multi-device state, dark mode, and unified dataSaver toggle
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
      localStorage.setItem('allinone_data_saver', dataSaver ? '1' : '0')
    } catch {}
  }, [dataSaver])

  // Phone onboarding guide banner (Desktop only, auto-retires once a 2nd client connects)
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
  }, [dismissPhoneGuide, setQrNudge])

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

  useEffect(() => {
    if (desktopApi && phoneGuideKey && liveOnlineClientCount >= 2 && !phoneGuideDismissed) {
      dismissPhoneGuide()
    }
  }, [desktopApi, phoneGuideKey, liveOnlineClientCount, phoneGuideDismissed, dismissPhoneGuide])

  // Stable UI callbacks (preserves SidebarDrawer, ChatView, and Composer React.memo boundaries)
  const handleCloseDrawer = useCallback(() => setDrawerOpen(false), [])
  const handleCloseDeviceSwitcher = useCallback(() => setDeviceSwitcherOpen(false), [])
  const handleCloseSettings = useCallback(() => setSettingsOpen(false), [])
  const handleCloseModelPicker = useCallback(() => setModelPickerOpen(false), [setModelPickerOpen])
  const handleCloseE2eeModal = useCallback(
    () => setE2eeModal((prev) => ({ ...prev, open: false, autoOpenScanner: false })),
    [],
  )
  const handleClosePendingGrant = useCallback(() => setPendingGrantPopup(null), [setPendingGrantPopup])
  const handleCloseLightbox = useCallback(() => setLightboxState(null), [])
  const handleCloseHtmlPreview = useCallback(() => setHtmlPreviewState(null), [])
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), [])
  const handleOpenDeviceSwitcher = useCallback(() => setDeviceSwitcherOpen(true), [])
  const handleToggleDark = useCallback(() => setDarkMode((v) => !v), [])
  const handleToggleDataSaver = useCallback(() => setDataSaver((v) => !v), [])
  const handleMediaCached = useCallback(() => setMediaCacheRev((n) => n + 1), [])

  const handleQuickScan = useCallback(() => {
    setE2eeModal({
      open: true,
      tab: desktopApi ? 'request' : 'import',
      autoOpenScanner: !desktopApi,
    })
  }, [desktopApi])

  const handleRefreshWorkspace = useCallback(() => {
    void loadWorkspaceData(activeBridgeIdRef.current)
  }, [loadWorkspaceData, activeBridgeIdRef])

  const handleAddDeviceFromSwitcher = useCallback((prefillServerUrl = '') => {
    setAddingDevice({
      open: true,
      serverUrl: prefillServerUrl || activeDeviceRef.current?.baseUrl || '',
    })
  }, [])

  const handleUploadFile = useCallback(
    async (rawFile) => {
      const { file: uploadTarget } = await compressImageForUpload(rawFile, {
        enabled: dataSaverRef.current,
      })
      return clientRef.current?.uploadFile(uploadTarget, { bridgeId: activeBridgeIdRef.current })
    },
    [activeBridgeIdRef],
  )

  const handleDeviceAuthenticated = useCallback(
    (payload) => {
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
            ? biLang(
                curLang,
                `已登录 @${userLabel} · 发现 ${onlineN} 台在线电脑`,
                `Signed in as @${userLabel} · ${onlineN} PC${onlineN === 1 ? '' : 's'} online`,
              )
            : biLang(curLang, `已登录 @${userLabel}`, `Signed in as @${userLabel}`),
        )
      }
    },
    [resetTransientWorkspace, setAccountDevices, setBridges, showToast],
  )

  // Resume same-tab GitHub OAuth sign-in when returning to an already-signed-in client (e.g. adding a 2nd account on iOS PWA)
  useEffect(() => {
    if (!activeDevice || addingDevice.open) return undefined
    const pending = loadPendingGithubOAuth('login')
    if (!pending) return undefined
    stripOAuthQueryParamFromUrl()
    clearPendingGithubOAuth()
    let cancelled = false
    pollGithubOAuth(pending.serverUrl, { pollToken: pending.pollToken })
      .then((res) => {
        if (cancelled) return
        if (res.status === 'completed' && res.token) {
          handleDeviceAuthenticated(res)
        } else if (res.error) {
          showToast(res.error)
        }
      })
      .catch((err) => {
        if (!cancelled) showToast(String(err?.message || err))
      })
    return () => {
      cancelled = true
    }
  }, [activeDevice, addingDevice.open, handleDeviceAuthenticated, showToast])

  // Unified Escape + Android hardware back layer + Desktop shortcuts
  useModalBackLayer({
    activeDevice,
    openNewChatModal,
    activeSessionRef,
    selectedDraftCwdRef,
    drawerOpen,
    setDrawerOpen,
    deviceSwitcherOpen,
    setDeviceSwitcherOpen,
    settingsOpen,
    setSettingsOpen,
    newChatOpen,
    setNewChatOpen,
    e2eeModalOpen: e2eeModal.open,
    closeE2eeModal: handleCloseE2eeModal,
    modelPickerOpen,
    setModelPickerOpen,
    pendingGrantPopup,
    closePendingGrantPopup: handleClosePendingGrant,
    lightboxState,
    closeLightbox: handleCloseLightbox,
    htmlPreviewState,
    closeHtmlPreview: handleCloseHtmlPreview,
    hasActiveSession: Boolean(activeSession),
    returnToHome,
  })

  // Split ImageContext: stable actions vs volatile transport/cache live state
  const imageActions = useMemo(() => {
    const localBridgeId = String(desktopBridge?.bridgeId || '').trim()
    const isLocalDesktopBridge = Boolean(
      desktopApi && localBridgeId && activeBridgeId && localBridgeId === activeBridgeId,
    )
    return {
      roomId: activeDevice?.roomId || '',
      sessionId: activeSession?.id || '',
      cwd: activeSession?.cwd || '',
      bridgeId: activeBridgeId,
      client: clientInstance,
      e2eeKeyId: activeBridgeE2ee.keyId,
      onOpenImage: setLightboxState,
      onOpenHtmlPreview: setHtmlPreviewState,
      onNotify: showToast,
      desktopApi,
      isLocalDesktopBridge,
    }
  }, [
    activeDevice?.roomId,
    activeSession?.id,
    activeSession?.cwd,
    activeBridgeId,
    clientInstance,
    activeBridgeE2ee.keyId,
    showToast,
    desktopApi,
    desktopBridge?.bridgeId,
  ])

  const imageLiveState = useMemo(
    () => ({
      connState,
      bridgeOnline,
      p2pState,
      p2pTransport,
      dataSaver,
      mediaCacheRev,
    }),
    [connState, bridgeOnline, p2pState, p2pTransport, dataSaver, mediaCacheRev],
  )

  // Subscribe ONLY to active boolean transitions (start/stop) — zero App re-renders per streamed token
  const activeSessionStreaming = useSessionStreamingActive(activeSession?.id || '')

  if (!activeDevice || addingDevice.open) {
    return (
      <Suspense fallback={<ModalLoadingFallback />}>
        <LoginScreen
          isAddingDevice={Boolean(activeDevice && addingDevice.open)}
          initialServerUrl={addingDevice.serverUrl || activeDevice?.baseUrl || ''}
          darkMode={darkMode}
          onToggleDark={handleToggleDark}
          onCancel={
            activeDevice
              ? () => {
                  setAddingDevice({ open: false, serverUrl: '' })
                }
              : null
          }
          onSuccess={handleDeviceAuthenticated}
        />
      </Suspense>
    )
  }

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
      return currentWorkspaceLabel ? `${activeDeviceName} · ${currentWorkspaceLabel}` : activeDeviceName
    }
    return currentWorkspaceLabel || activeDeviceName || bi('已连接', 'Connected')
  })()

  const wbStatus = appsStatus.find((a) => a.app === 'workbuddy')
  const isWorkbuddyReadonly =
    (activeSession?.app === 'workbuddy' && activeSession?.writable === false) ||
    (!activeSession && activeApp === 'workbuddy' && wbStatus && !wbStatus.writable)
  const isWorkbuddyWorking = workbuddySetup.status === 'working'
  const isWorkbuddyAwaiting = workbuddySetup.status === 'awaiting_login'
  const workbuddyNeedsCli = wbStatus?.setupState === 'needs_cli' || !wbStatus?.cliInstalled

  return (
    <ImageActionsProvider value={imageActions}>
      <ImageLiveStateProvider value={imageLiveState}>
        <div className="relative flex h-full w-full bg-white dark:bg-[#16171A]">
          {/* Responsive Sidebar (slide-over drawer on mobile, docked left column on desktop lg:) */}
          <SidebarDrawer
            open={drawerOpen}
            onClose={handleCloseDrawer}
            sessions={sessions}
            appsStatus={appsStatus}
            activeSessionId={activeSession?.id}
            pendingApprovalSessionIds={pendingApprovalSessionIds}
            onSelectSession={openSession}
            onGoHome={returnToHome}
            filterApp={sidebarFilterApp}
            onFilterAppChange={setSidebarFilterApp}
            onNewChat={openNewChatModal}
            onRefresh={handleRefreshWorkspace}
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
            onQuickScan={handleQuickScan}
            onOpenSettings={handleOpenSettings}
            onOpenDeviceSwitcher={handleOpenDeviceSwitcher}
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
                        activeSessionStreaming ||
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
                      onClick={handleOpenDeviceSwitcher}
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
                  onClick={() => {
                    if (activeSession) returnToHome()
                    else void handleRefreshQuotas()
                  }}
                  aria-label={bi('主页', 'Home')}
                  title={
                    activeSession
                      ? bi('返回主页（额度总览）', 'Back to Home (Quota Overview)')
                      : bi('主页（点击刷新额度）', 'Home (click to refresh quotas)')
                  }
                  className={`app-no-drag flex h-9 w-9 items-center justify-center rounded-xl transition active:scale-95 ${
                    !activeSession
                      ? 'bg-[#4D6BFE]/12 text-[#4D6BFE] hover:bg-[#4D6BFE]/20 dark:bg-[#4D6BFE]/20 dark:text-[#9BB0FF] dark:hover:bg-[#4D6BFE]/28'
                      : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
                  }`}
                >
                  <Home className="h-4.5 w-4.5" />
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
                    onClick={handleOpenDeviceSwitcher}
                    className="rounded-lg border border-rose-300 bg-white px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
                  >
                    {t('common.switch')}
                  </button>
                )}
              </div>
            )}

            {/* Connection limit / fatal WS error banner */}
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
                  onClick={handleOpenDeviceSwitcher}
                  className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-500/25 dark:text-amber-100"
                >
                  <ArrowLeftRight className="h-3 w-3" />
                  <span>{accountDevices.length === 0 ? bi('绑定', 'Link') : t('common.switch')}</span>
                </button>
              </div>
            )}

            {/* Honest P2P unreachable banner */}
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

            {/* Live nudge banner when another logged-in device is waiting to scan this computer's QR */}
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

            {/* First-time desktop non-blocking phone onboarding strip */}
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

            {/* Main Chat Viewport or E2EE Key Sync Lock Screen */}
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
                <SectionErrorBoundary name="chat-view" resetKey={activeSession?.id || 'home'}>
                  <ChatView
                    session={activeSession}
                    messages={messages}
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
                    onSelectApp={handleSelectDraftApp}
                    workspaces={effectiveWorkspaces}
                    selectedWorkspace={selectedDraftCwd}
                    onSelectWorkspace={handleSelectDraftWorkspace}
                    onOpenNewChatModal={handleOpenNewChatFromHome}
                    bridgeOnline={bridgeOnline}
                    refreshingQuotas={refreshingQuotas}
                    onRefreshQuotas={handleRefreshQuotas}
                    approvals={activeSessionApprovals}
                    onResolveApproval={handleResolveApproval}
                  />
                </SectionErrorBoundary>

                {isWorkbuddyReadonly ? (
                  <div className="pb-safe shrink-0 bg-white/90 px-3 pt-2 backdrop-blur-md dark:bg-[#16171A]/90">
                    <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-[#06C798]/30 bg-[#EEFBF7] px-3.5 py-2.5 lg:max-w-3xl dark:border-[#06C798]/30 dark:bg-[#142522]">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            isWorkbuddyWorking || isWorkbuddyAwaiting || activeSession?.syncState?.externalRunning
                              ? 'bg-[#06C798] animate-pulse-dot'
                              : 'bg-amber-400'
                          }`}
                        />
                        <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                          {isWorkbuddyWorking
                            ? bi('正在后台自动安装官方引擎并拉起扫码页，请稍候…', 'Setting up WorkBuddy engine & opening sign-in…')
                            : isWorkbuddyAwaiting
                              ? bi('请在弹出的官方页面完成微信扫码确认，完成后自动解锁发送', 'Finish scanning QR on the official page — unlocks automatically')
                              : activeSession?.syncState?.externalRunning
                                ? bi('WorkBuddy 正在电脑端执行 · 实时只读同步中', 'WorkBuddy running on PC · Live read-only sync')
                                : workbuddyNeedsCli
                                  ? bi('WorkBuddy 当前实时只读同步 · 一键自动安装并扫码即可远程发送', 'WorkBuddy live mirror · 1-click auto-setup & sign in to send')
                                  : bi('WorkBuddy 引擎已就绪 · 微信扫码授权一次即可解锁远程发送', 'WorkBuddy engine ready · 1-click QR sign-in to unlock sending')}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {isWorkbuddyAwaiting && workbuddySetup.authUrl ? (
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
                              disabled={isWorkbuddyWorking || !bridgeOnline || connState !== 'connected'}
                              onClick={() => handleSetupWorkbuddy('internal')}
                              className="inline-flex items-center gap-1.5 rounded-full bg-[#06C798] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#05B187] active:scale-95 disabled:opacity-60"
                            >
                              {isWorkbuddyWorking ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <QrCode className="h-3.5 w-3.5" />
                              )}
                              <span>
                                {isWorkbuddyWorking
                                  ? bi('配置中…', 'Setting up…')
                                  : workbuddyNeedsCli
                                    ? bi('一键启用发送', '1-Click Enable')
                                    : bi('一键微信扫码登录', '1-Click QR Sign-In')}
                              </span>
                            </button>
                            {!isWorkbuddyWorking && (
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
                ) : activeSession?.writable === false ? (
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
                ) : (
                  <Composer
                    key={activeDevice?.id || 'none'}
                    draftKey={makeDraftKey(cacheScope, activeSession?.id, activeApp)}
                    activeApp={activeApp}
                    streaming={activeSessionStreaming}
                    disabled={!bridgeOnline || connState !== 'connected' || e2eeLocked}
                    needsWorkspace={!activeSession && !selectedDraftCwd}
                    targetWorkspaceName={!activeSession ? (selectedDraftWorkspaceObj?.name || '') : ''}
                    modelPref={activeModelPref}
                    modelDisplayName={activeModelObj?.name || activeModelPref.model}
                    onOpenModelPicker={handleOpenModelPicker}
                    onUploadFile={handleUploadFile}
                    onSend={handleSend}
                    onInterrupt={handleInterrupt}
                    onError={showToast}
                  />
                )}
              </>
            )}
          </div>

          <AppModals
            deviceSwitcherOpen={deviceSwitcherOpen}
            onCloseDeviceSwitcher={handleCloseDeviceSwitcher}
            devices={devices}
            activeDevice={activeDevice}
            activeBridgeId={activeBridgeId}
            connState={connState}
            accountDevices={accountDevices}
            onSelectDevice={handleSelectDevice}
            onAddDevice={handleAddDeviceFromSwitcher}
            onRemoveDevice={handleRemoveDevice}
            onSyncDeviceMeta={handleSyncDeviceMeta}
            onRenameAccountDevice={handleRenameAccountDevice}
            onRemoveAccountDevice={handleRemoveAccountDevice}
            onRefreshAccountDevices={handleRefreshAccountDevices}
            newChatOpen={newChatOpen}
            cacheScope={cacheScope}
            newChatCwd={newChatCwd}
            newChatApp={newChatApp}
            onCloseNewChat={closeNewChatModal}
            effectiveWorkspaces={effectiveWorkspaces}
            appsStatus={appsStatus}
            modelsCatalog={modelsCatalog}
            workbuddySetup={workbuddySetup}
            onSetupWorkbuddy={handleSetupWorkbuddy}
            onCreateSession={handleCreateSession}
            modelPickerOpen={modelPickerOpen}
            activeApp={activeApp}
            activeCatalog={activeCatalog}
            loadingModels={loadingModels}
            activeModelPref={activeModelPref}
            onCloseModelPicker={handleCloseModelPicker}
            onApplyModelPref={handleApplyModelPref}
            settingsOpen={settingsOpen}
            onCloseSettings={handleCloseSettings}
            activeDeviceName={activeDeviceName}
            isAdmin={isAdmin}
            serverEmailEnabled={serverEmailEnabled}
            serverGithubEnabled={serverGithubEnabled}
            bridgeOnline={bridgeOnline}
            clientSessions={clientSessions}
            onlineClientCount={liveOnlineClientCount || clientSessions.onlineCount}
            onRefreshClientSessions={handleRefreshClientSessions}
            onRevokeClientSession={handleRevokeClientSession}
            onRevokeOtherClientSessions={handleRevokeOtherClientSessions}
            darkMode={darkMode}
            onToggleDark={handleToggleDark}
            desktopApi={desktopApi}
            desktopBridge={desktopBridge}
            setDesktopBridge={setDesktopBridge}
            updateState={updateState}
            setUpdateState={setUpdateState}
            otaInfo={otaInfo}
            onResetOtaBundle={handleResetOtaBundle}
            canCheckMobileUpdate={canCheckMobileUpdate}
            nativeOtaPlugin={nativeOtaPlugin}
            onCheckNativeMobileUpdate={handleCheckNativeMobileUpdate}
            onDownloadMobileUpdate={handleDownloadMobileUpdate}
            onCancelMobileUpdate={handleCancelMobileUpdate}
            onInstallMobileUpdate={handleInstallMobileUpdate}
            onSendBindEmailCode={handleSendBindEmailCode}
            onBindAccountEmail={handleBindAccountEmail}
            onToggleLoginEmail2fa={handleToggleLoginEmail2fa}
            onGithubLinked={handleGithubLinked}
            onUnlinkGithub={handleUnlinkGithub}
            turnQuota={turnQuota}
            dataSaver={dataSaver}
            onToggleDataSaver={handleToggleDataSaver}
            e2eeModal={e2eeModal}
            onCloseE2eeModal={handleCloseE2eeModal}
            activeBridge={activeBridge}
            e2eeLocked={e2eeLocked}
            activeBridgeE2ee={activeBridgeE2ee}
            client={clientInstance}
            onImportE2eeKey={handleImportE2eeKey}
            onImportE2eeKeyring={handleImportE2eeKeyring}
            onScanGrantQr={handleScanGrantQr}
            onRotateDesktopE2eeKey={handleRotateDesktopE2eeKey}
            pendingGrantPopup={pendingGrantPopup}
            onClosePendingGrant={handleClosePendingGrant}
            lightboxState={lightboxState}
            onMediaCached={handleMediaCached}
            onCloseLightbox={handleCloseLightbox}
            htmlPreviewState={htmlPreviewState}
            onCloseHtmlPreview={handleCloseHtmlPreview}
            showToast={showToast}
          />
        </div>
      </ImageLiveStateProvider>
    </ImageActionsProvider>
  )
}

export default App
