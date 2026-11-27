import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EVENTS, RPC } from '@allinone/shared'
import { clearE2eeMediaCache } from '../lib/e2eeMedia.js'
import {
  loadCachedSession,
  mergeSessionMessages,
  mergeUnflushedOptimisticTail,
  reconcileCachedWithFreshPage,
  saveCachedSession,
} from '../lib/sessionCache.js'
import { loadLastWorkspace, saveLastWorkspace } from '../lib/draftStore.js'
import {
  appendStreamDelta,
  appendStreamThinking,
  clearAllStreams,
  clearStream,
  clearStreamError,
  failStream,
  finishStream,
  getRawStream,
  isStaleStreamForIdle,
  isStreamActive,
  startStream,
  streamToolEnd,
  streamToolStart,
} from '../state/streamingStore.js'
import { bi as biLang, getCurrentLang, translate } from '../lib/i18n.js'

const MAX_UNFLUSHED_RETRY_PER_REV = 2

/**
 * Manages sessions, workspaces, active chat transcript, pagination, optimistic send/stream-done
 * sequencing, per-session mutation revision guards, model selection, approvals, and WorkBuddy setup.
 *
 * All exported action callbacks are stabilized with `useCallback` + live refs so `SidebarDrawer`,
 * `ChatView`, and `Composer` `React.memo` boundaries remain intact.
 */
export function useSessionManager({
  clientRef,
  deviceGenRef,
  activeDeviceId,
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
  onResetModals,
  showToast,
}) {
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

  const [approvals, setApprovals] = useState([])
  const [sidebarFilterApp, setSidebarFilterApp] = useState('all')
  const [selectedDraftApp, setSelectedDraftApp] = useState('')
  const [selectedDraftCwd, setSelectedDraftCwd] = useState('')
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newChatCwd, setNewChatCwd] = useState('')
  const [newChatApp, setNewChatApp] = useState('')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)

  const [workbuddySetup, setWorkbuddySetup] = useState({
    status: 'idle',
    authUrl: '',
    error: '',
    methodId: 'internal',
  })
  const [zcodeSetup, setZcodeSetup] = useState({
    status: 'idle',
    authUrl: '',
    error: '',
    methodId: 'internal',
  })

  // Live refs for zero-stale-closure memoized callbacks
  const activeSessionRef = useRef(activeSession)
  activeSessionRef.current = activeSession
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const appsStatusRef = useRef(appsStatus)
  appsStatusRef.current = appsStatus
  const modelsCatalogRef = useRef(modelsCatalog)
  modelsCatalogRef.current = modelsCatalog
  const sessionModelPrefsRef = useRef(sessionModelPrefs)
  sessionModelPrefsRef.current = sessionModelPrefs
  const draftDshPrefRef = useRef(draftDshPref)
  draftDshPrefRef.current = draftDshPref
  const sidebarFilterAppRef = useRef(sidebarFilterApp)
  sidebarFilterAppRef.current = sidebarFilterApp
  const selectedDraftAppRef = useRef(selectedDraftApp)
  selectedDraftAppRef.current = selectedDraftApp
  const selectedDraftCwdRef = useRef(selectedDraftCwd)
  selectedDraftCwdRef.current = selectedDraftCwd
  const modelsEtagRef = useRef({ bridgeId: '', etag: '' })
  const historyMetaRef = useRef(historyMeta)
  historyMetaRef.current = historyMeta

  const openRequestSeqRef = useRef(0)
  const workspaceLoadSeqRef = useRef(0)
  const olderReqSeqRef = useRef(0)
  const loadingOlderLockRef = useRef(false)
  const sentPreviewUrlsRef = useRef(new Set())
  const quietSyncSeqRef = useRef(0)
  const activeQuietSyncSeqRef = useRef(0)
  const quietSyncPendingRef = useRef('')
  const lastFocusSyncAtRef = useRef(0)
  const workbuddyPollTimerRef = useRef(null)
  const zcodePollTimerRef = useRef(null)
  const lastMetaAppsSigRef = useRef('')
  const prevP2pStateRef = useRef('idle')

  // Per-session monotonic mutation revision guard (sequences STREAM_DONE / handleSend vs syncActiveSessionQuietly)
  const sessionMutationRevRef = useRef(new Map())
  const optimisticRetryTimerRef = useRef(null)
  const optimisticRetryCountRef = useRef(new Map())

  const getSessionRev = useCallback((sid) => {
    if (!sid) return 0
    return sessionMutationRevRef.current.get(sid) || 0
  }, [])

  const bumpSessionRev = useCallback((sid) => {
    if (!sid) return 0
    const next = (sessionMutationRevRef.current.get(sid) || 0) + 1
    sessionMutationRevRef.current.set(sid, next)
    return next
  }, [])

  const clearOptimisticRetryTimer = useCallback(() => {
    if (optimisticRetryTimerRef.current) {
      clearTimeout(optimisticRetryTimerRef.current)
      optimisticRetryTimerRef.current = null
    }
  }, [])

  // Keep transport hook informed whether user is mid-conversation or has loaded sessions
  if (hasSessionContextRef) {
    hasSessionContextRef.current = Boolean(activeSession || sessions.length > 0)
  }

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

  const stopWorkbuddySetupPoll = useCallback(() => {
    if (workbuddyPollTimerRef.current) {
      clearInterval(workbuddyPollTimerRef.current)
      workbuddyPollTimerRef.current = null
    }
  }, [])

  const stopZcodeSetupPoll = useCallback(() => {
    if (zcodePollTimerRef.current) {
      clearInterval(zcodePollTimerRef.current)
      zcodePollTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      stopWorkbuddySetupPoll()
      stopZcodeSetupPoll()
      clearOptimisticRetryTimer()
      revokeAllSentPreviewUrls()
    }
  }, [stopWorkbuddySetupPoll, stopZcodeSetupPoll, clearOptimisticRetryTimer, revokeAllSentPreviewUrls])

  const applyWorkbuddyUnlocked = useCallback(
    (freshApps = null) => {
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
    },
    [stopWorkbuddySetupPoll],
  )

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
    [activeBridgeIdRef, applyWorkbuddyUnlocked, clientRef, deviceGenRef, showToast, stopWorkbuddySetupPoll],
  )

  const applyZcodeUnlocked = useCallback(
    (freshApps = null) => {
      stopZcodeSetupPoll()
      setZcodeSetup({ status: 'idle', authUrl: '', error: '', methodId: 'internal' })
      if (Array.isArray(freshApps)) {
        setAppsStatus(freshApps)
      }
      setSessions((prev) => prev.map((s) => (s.app === 'zcode' ? { ...s, writable: true } : s)))
      setActiveSession((prev) => {
        if (!prev || prev.app !== 'zcode') return prev
        const next = { ...prev, writable: true }
        activeSessionRef.current = next
        return next
      })
    },
    [stopZcodeSetupPoll],
  )

  const handleSetupZcode = useCallback(
    async (methodId = 'internal') => {
      const client = clientRef.current
      const reqBridgeId = String(activeBridgeIdRef.current || '').trim()
      if (!client || !reqBridgeId) {
        showToast(biLang(getCurrentLang(), '请先连接电脑后再授权 ZCode', 'Connect your computer first'))
        return
      }
      const gen = deviceGenRef.current
      stopZcodeSetupPoll()
      setZcodeSetup({ status: 'working', authUrl: '', error: '', methodId })
      try {
        const res = await client.rpc(
          RPC.APP_SETUP,
          { app: 'zcode', action: 'setup', methodId },
          30_000,
          { bridgeId: reqBridgeId },
        )
        if (deviceGenRef.current !== gen || activeBridgeIdRef.current !== reqBridgeId) return

        if (res?.writable || res?.status === 'ready') {
          const fresh = await client.rpc(RPC.APPS_STATUS, {}, 12_000, { bridgeId: reqBridgeId }).catch(() => null)
          applyZcodeUnlocked(fresh?.apps || null)
          showToast(biLang(getCurrentLang(), 'ZCode 远程发送权限已解锁！', 'ZCode remote sending unlocked!'))
          return
        }

        if (res?.ok && res?.status === 'awaiting_login') {
          const authUrl = typeof res.authUrl === 'string' && /^https:\/\//i.test(res.authUrl) ? res.authUrl : ''
          setZcodeSetup({ status: 'awaiting_login', authUrl, error: '', methodId })
          if (authUrl) {
            try {
              window.open(authUrl, '_blank', 'noopener,noreferrer')
            } catch {}
          }
          showToast(
            authUrl
              ? biLang(getCurrentLang(), '已打开智谱官方授权页，登录确认后自动解锁', 'Opened official ZCode login page — unlocks automatically.')
              : biLang(getCurrentLang(), '正在等待智谱官方登录页，请完成授权', 'Waiting for official ZCode sign-in confirmation'),
          )

          let pollCount = 0
          zcodePollTimerRef.current = setInterval(() => {
            pollCount += 1
            if (pollCount > 72 || deviceGenRef.current !== gen || activeBridgeIdRef.current !== reqBridgeId) {
              stopZcodeSetupPoll()
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
                  const zc = stRes.apps.find((a) => a.app === 'zcode')
                  if (zc?.writable) {
                    applyZcodeUnlocked(stRes.apps)
                    showToast(biLang(getCurrentLang(), 'ZCode 授权成功，已解锁远程发送！', 'ZCode authorized! Remote sending unlocked.'))
                  }
                }
              })
              .catch(() => {})
          }, 2_500)
          return
        }

        const errMsg = res?.error || biLang(getCurrentLang(), '授权 ZCode 失败，请稍后重试', 'Failed to authorize ZCode')
        setZcodeSetup({ status: 'error', authUrl: '', error: errMsg, methodId })
        showToast(errMsg)
      } catch (err) {
        if (deviceGenRef.current !== gen) return
        const errMsg = String(err?.message || err)
        setZcodeSetup({ status: 'error', authUrl: '', error: errMsg, methodId })
        showToast(errMsg)
      }
    },
    [activeBridgeIdRef, applyZcodeUnlocked, clientRef, deviceGenRef, showToast, stopZcodeSetupPoll],
  )

  const defaultApp = useMemo(() => {
    const order = ['dsh', 'codex', 'claude', 'antigravity', 'workbuddy', 'zcode']
    for (const id of order) {
      if (appsStatus.find((a) => a.app === id && a.writable)) return id
    }
    for (const id of order) {
      if (appsStatus.find((a) => a.app === id && a.available)) return id
    }
    return 'dsh'
  }, [appsStatus])

  const effectiveDefaultApp = selectedDraftApp || defaultApp
  const effectiveDefaultAppRef = useRef(effectiveDefaultApp)
  effectiveDefaultAppRef.current = effectiveDefaultApp

  // Keep sidebar filter & draft app aligned with tools actually present on the active computer
  useEffect(() => {
    if (appsStatus.length === 0) return
    const detectedSet = new Set(appsStatus.filter((a) => a?.available || a?.writable).map((a) => a.app))
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

  // Restore last explicitly used project directory on the empty screen
  useEffect(() => {
    if (selectedDraftCwd || !cacheScope || effectiveWorkspaces.length === 0) return
    const saved = loadLastWorkspace(cacheScope)
    if (!saved) return
    const matched = effectiveWorkspaces.find((w) => w.path.toLowerCase() === saved.toLowerCase())
    if (matched) {
      setSelectedDraftCwd(matched.path)
    }
  }, [cacheScope, effectiveWorkspaces, selectedDraftCwd])

  const resetTransientWorkspace = useCallback(() => {
    deviceGenRef.current += 1
    openRequestSeqRef.current += 1
    workspaceLoadSeqRef.current += 1
    olderReqSeqRef.current += 1
    quietSyncSeqRef.current += 1
    activeQuietSyncSeqRef.current = 0
    quietSyncPendingRef.current = ''
    loadingOlderLockRef.current = false
    sessionMutationRevRef.current.clear()
    optimisticRetryCountRef.current.clear()
    clearOptimisticRetryTimer()
    clearAllStreams()
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
    setApprovals([])
    setNewChatOpen(false)
    setNewChatCwd('')
    setNewChatApp('')
    setModelPickerOpen(false)
    onResetModals?.()
    revokeAllSentPreviewUrls()
    clearE2eeMediaCache()
  }, [clearOptimisticRetryTimer, deviceGenRef, onResetModals, revokeAllSentPreviewUrls])

  const openNewChatModal = useCallback(
    (cwdHint = '', appHint = '') => {
      const cleanCwd = typeof cwdHint === 'string' ? cwdHint : ''
      const cleanApp = typeof appHint === 'string' ? appHint : ''
      const curApps = appsStatusRef.current || []
      const isWritableApp = (id) => Boolean(id && curApps.find((a) => a.app === id && a.writable))
      const fallbackApp =
        (isWritableApp(activeSessionRef.current?.app) ? activeSessionRef.current.app : '') ||
        (isWritableApp(selectedDraftAppRef.current) ? selectedDraftAppRef.current : '') ||
        ''
      const resolvedApp =
        cleanApp ||
        (sidebarFilterAppRef.current !== 'all' ? sidebarFilterAppRef.current : '') ||
        fallbackApp
      setNewChatCwd(cleanCwd)
      setNewChatApp(resolvedApp)
      setNewChatOpen(true)

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
    },
    [activeBridgeIdRef, clientRef, deviceGenRef],
  )

  const closeNewChatModal = useCallback(() => {
    setNewChatOpen(false)
    setNewChatCwd('')
    setNewChatApp('')
  }, [])

  const handleOpenNewChatFromHome = useCallback(() => {
    openNewChatModal(selectedDraftCwdRef.current || '', effectiveDefaultAppRef.current)
  }, [openNewChatModal])

  const handleSelectDraftApp = useCallback((appId) => {
    setSelectedDraftApp(appId)
    setDraftDshPref(null)
  }, [])

  const handleSelectDraftWorkspace = useCallback(
    (cwdPath) => {
      setSelectedDraftCwd(cwdPath)
      if (cwdPath) saveLastWorkspace(cacheScopeRef.current, cwdPath)
    },
    [cacheScopeRef],
  )

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
  }, [activeBridgeIdRef, clientRef, deviceGenRef])

  const syncActiveSessionQuietly = useCallback(
    async (sessionId = '') => {
      const client = clientRef.current
      const targetId = sessionId || activeSessionRef.current?.id || ''
      if (!client || !targetId) return
      if (isStreamActive(targetId) || loadingOlderLockRef.current) return
      if (activeQuietSyncSeqRef.current !== 0) {
        quietSyncPendingRef.current = targetId
        return
      }

      const seq = ++quietSyncSeqRef.current
      activeQuietSyncSeqRef.current = seq
      const gen = deviceGenRef.current
      const scope = cacheScopeRef.current
      const targetBridge = activeBridgeIdRef.current
      const startRev = getSessionRev(targetId)

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
          isStreamActive(targetId)
        ) {
          return
        }
        // Per-session monotonic revision guard: if a send / STREAM_DONE / loadOlder occurred while
        // SESSION_READ was in flight, never overwrite with stale pre-mutation history — re-sync instead!
        if (getSessionRev(targetId) !== startRev) {
          quietSyncPendingRef.current = targetId
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
          // Merge instead of clobbering a freshly completed turn when remote history hasn't flushed to disk yet
          const { messages: mergedMessages, preservedOptimistic } = mergeUnflushedOptimisticTail(
            reconciled.messages,
            messagesRef.current,
          )
          const nextHistoryMeta = {
            hasMore: reconciled.hasMore,
            nextCursor: reconciled.nextCursor,
            totalCount: reconciled.totalCount,
          }
          activeSessionRef.current = res.session
          messagesRef.current = mergedMessages
          historyMetaRef.current = nextHistoryMeta
          setActiveSession(res.session)
          if (res.session.cwd) {
            saveLastWorkspace(scope, res.session.cwd)
            setSelectedDraftCwd(res.session.cwd)
          }
          setMessages(mergedMessages)
          setHistoryMeta(nextHistoryMeta)
          pruneUnusedSentPreviewUrls(mergedMessages)
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
              messages: mergedMessages,
              hasMore: reconciled.hasMore,
              nextCursor: reconciled.nextCursor,
              totalCount: reconciled.totalCount,
            },
            scope,
          )

          const retryKey = `${targetId}:${startRev}`
          if (preservedOptimistic) {
            const tries = optimisticRetryCountRef.current.get(retryKey) || 0
            if (tries < MAX_UNFLUSHED_RETRY_PER_REV) {
              optimisticRetryCountRef.current.set(retryKey, tries + 1)
              clearOptimisticRetryTimer()
              optimisticRetryTimerRef.current = setTimeout(() => {
                optimisticRetryTimerRef.current = null
                if (
                  deviceGenRef.current === gen &&
                  activeSessionRef.current?.id === targetId &&
                  !isStreamActive(targetId)
                ) {
                  void syncActiveSessionQuietly(targetId)
                }
              }, 2_500)
            }
          } else {
            optimisticRetryCountRef.current.delete(retryKey)
          }
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
            !isStreamActive(pendingId)
          ) {
            void syncActiveSessionQuietly(pendingId)
          }
        }
      }
    },
    [
      activeBridgeIdRef,
      cacheScopeRef,
      clearOptimisticRetryTimer,
      clientRef,
      deviceGenRef,
      getSessionRev,
      pruneUnusedSentPreviewUrls,
    ],
  )

  const loadWorkspaceData = useCallback(
    async (bridgeOverride = '') => {
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
              clearStream(s.id)
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
    },
    [activeBridgeIdRef, cacheScopeRef, clientRef, deviceGenRef, e2eeLockedRef, syncActiveSessionQuietly],
  )

  // Trigger workspace load whenever connected target device/bridge is ready or E2EE unlocks
  useEffect(() => {
    if (connState !== 'connected' || !activeDeviceId || !activeBridgeId || e2eeLocked) return
    clientRef.current?.setTargetBridgeId(activeBridgeId)
    void loadWorkspaceData(activeBridgeId)
  }, [connState, activeDeviceId, activeBridgeId, e2eeLocked, clientRef, loadWorkspaceData])

  // Recover workspace data automatically if P2P becomes connected while workspace lists are still empty
  useEffect(() => {
    const prevP2p = prevP2pStateRef.current
    prevP2pStateRef.current = p2pState
    if (
      p2pState === 'connected' &&
      prevP2p !== 'connected' &&
      connState === 'connected' &&
      activeBridgeId &&
      !e2eeLocked &&
      appsStatus.length === 0 &&
      sessions.length === 0
    ) {
      void loadWorkspaceData(activeBridgeId)
    }
  }, [p2pState, connState, activeBridgeId, e2eeLocked, appsStatus.length, sessions.length, loadWorkspaceData])

  // Auto-sync app readiness & model catalog whenever active bridge broadcasts updated meta.apps
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
  }, [activeBridgeAppsSig, activeBridgeMetaApps, activeBridgeId, activeBridgeIdRef, clientRef, connState, deviceGenRef])

  // Auto-sync the open session on window focus / mobile resume
  useEffect(() => {
    const triggerFocusSync = () => {
      if (document.visibilityState === 'hidden') return
      if (connState !== 'connected' || !activeBridgeIdRef.current) return
      const now = Date.now()
      if (now - lastFocusSyncAtRef.current < 1_500) return
      lastFocusSyncAtRef.current = now
      const curId = activeSessionRef.current?.id
      if (curId && !isStreamActive(curId)) {
        void syncActiveSessionQuietly(curId)
      }
    }
    window.addEventListener('focus', triggerFocusSync)
    document.addEventListener('visibilitychange', triggerFocusSync)
    return () => {
      window.removeEventListener('focus', triggerFocusSync)
      document.removeEventListener('visibilitychange', triggerFocusSync)
    }
  }, [connState, activeBridgeIdRef, syncActiveSessionQuietly])

  const openSession = useCallback(
    async (sessionOrId) => {
      const client = clientRef.current
      if (!client) return
      const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id
      const prevId = activeSessionRef.current?.id || ''
      const isDifferentSession = prevId !== id

      // Dismiss stale stream error banners on session switch / reopen
      if (prevId) clearStreamError(prevId)
      clearStreamError(id)
      bumpSessionRev(id)
      clearOptimisticRetryTimer()

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
        messagesRef.current = []
        historyMetaRef.current = { hasMore: false, nextCursor: null, totalCount: null }
        setMessages([])
        setHistoryMeta({ hasMore: false, nextCursor: null, totalCount: null })
        pruneUnusedSentPreviewUrls([])
      }

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
            clearStream(id)
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
            clearStream(id)
          }
          const { messages: freshMsgs = [], hasMore, nextCursor, totalCount, ...metaOnly } = res.session
          const reconciled = reconcileCachedWithFreshPage(cached, {
            messages: freshMsgs,
            hasMore,
            nextCursor,
            totalCount,
          })
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
        if ((!cached || !cached.messages?.length) && !isStreamActive(id)) {
          failStream(id, String(err?.message || err), { keepPartial: false })
        }
      } finally {
        if (openRequestSeqRef.current === reqSeq && deviceGenRef.current === gen) {
          setLoadingSession(false)
        }
      }
    },
    [
      activeBridgeIdRef,
      bumpSessionRev,
      cacheScopeRef,
      clearOptimisticRetryTimer,
      clientRef,
      deviceGenRef,
      pruneUnusedSentPreviewUrls,
    ],
  )

  const returnToHome = useCallback(() => {
    const prevSid = activeSessionRef.current?.id || ''
    if (prevSid) clearStreamError(prevSid)
    clearOptimisticRetryTimer()
    openRequestSeqRef.current += 1
    quietSyncSeqRef.current += 1
    activeQuietSyncSeqRef.current = 0
    quietSyncPendingRef.current = ''
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
    // Release any sent local preview Blob URLs cleanly when leaving active transcript
    revokeAllSentPreviewUrls()
  }, [clearOptimisticRetryTimer, revokeAllSentPreviewUrls])

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
        bumpSessionRev(targetId)
        const olderMsgs = Array.isArray(res.session.messages) ? res.session.messages : []
        const merged = mergeSessionMessages(olderMsgs, messagesRef.current)
        const nextHasMore =
          Boolean(res.session.hasMore) && Boolean(res.session.nextCursor) && res.session.nextCursor !== cursor
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
  }, [activeBridgeIdRef, bumpSessionRev, cacheScopeRef, clientRef, deviceGenRef])

  const resolveModelPrefFor = useCallback((sessionObj) => {
    const appId = sessionObj?.app || effectiveDefaultAppRef.current
    const cat = modelsCatalogRef.current?.[appId]
    const explicit = sessionObj?.id ? sessionModelPrefsRef.current?.[sessionObj.id] : draftDshPrefRef.current
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
  }, [])

  const handleCreateSession = useCallback(
    async ({ app, cwd, title, model, provider, reasoningEffort }) => {
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
    },
    [activeBridgeIdRef, cacheScopeRef, clientRef, deviceGenRef, pruneUnusedSentPreviewUrls],
  )

  const handleSend = useCallback(
    async ({ text, attachments = [] }) => {
      const client = clientRef.current
      if (!client) return false
      const gen = deviceGenRef.current
      const scope = cacheScopeRef.current
      const targetBridge = activeBridgeIdRef.current
      const curLang = getCurrentLang()

      let target = activeSessionRef.current
      const createdJustNow = !target
      if (!target) {
        const explicitCwd = String(selectedDraftCwdRef.current || '').trim()
        if (!explicitCwd) {
          showToast(biLang(curLang, '请先选择目标项目目录', 'Please select a target project directory first'))
          openNewChatModal('', effectiveDefaultAppRef.current)
          return false
        }
        try {
          const initPref = resolveModelPrefFor({ app: effectiveDefaultAppRef.current })
          target = await handleCreateSession({
            app: effectiveDefaultAppRef.current,
            cwd: explicitCwd,
            title: text.slice(0, 28) || translate(curLang, 'common.newChat'),
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

      // Clear any previous error banner on this session before starting the new turn
      clearStreamError(target.id)
      bumpSessionRev(target.id)

      const activePref = resolveModelPrefFor(target)
      const finalText = text

      const genericTitle = /^(新 |新对话|New Chat|手机端总控对话|[0-9a-f]{8}-[0-9a-f]{4}-)/i.test(target.title || '')
      if (genericTitle && finalText.trim().length > 0) {
        const nextTitle = finalText.trim().replace(/\s+/g, ' ').slice(0, 36)
        setActiveSession((prev) => (prev && prev.id === target.id ? { ...prev, title: nextTitle } : prev))
        setSessions((prev) => prev.map((s) => (s.id === target.id ? { ...s, title: nextTitle } : s)))
      }

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
          ? `${finalText}${finalText ? '\n' : ''}[${biLang(curLang, '附件', 'Attachment')}: ${nonImgAtts.map((a) => a.filename).join(', ')}]`
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
      const isTargetStillActive = activeSessionRef.current?.id === target.id
      const baseHistoryMeta = createdJustNow
        ? { hasMore: false, nextCursor: null, totalCount: 0 }
        : isTargetStillActive
          ? historyMetaRef.current
          : { hasMore: false, nextCursor: null, totalCount: null }

      if (isTargetStillActive) {
        const baseMessages = createdJustNow ? [] : messagesRef.current
        const nextWithUser = baseMessages.some((m) => m.id === userMsg.id)
          ? baseMessages
          : [...baseMessages, userMsg]
        messagesRef.current = nextWithUser
        setMessages((prev) => {
          const base = createdJustNow ? [] : prev
          return base.some((m) => m.id === userMsg.id) ? base : [...base, userMsg]
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
      } else {
        void saveCachedSession(
          target.id,
          {
            meta: target,
            messages: [userMsg],
            hasMore: false,
            nextCursor: null,
            totalCount: 1,
          },
          scope,
        )
      }

      const initStream = startStream(target.id)

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
        const streamUntouched = getRawStream(target.id) === initStream
        if (streamUntouched) {
          bumpSessionRev(target.id)
          failStream(target.id, String(err?.message || err), { keepPartial: false })
          for (const a of imgAtts) {
            if (a?.localPreviewUrl) sentPreviewUrlsRef.current.delete(a.localPreviewUrl)
          }
          const stillOnTarget = activeSessionRef.current?.id === target.id
          if (stillOnTarget) {
            const rolledBack = messagesRef.current.filter((m) => m?.id !== userMsg.id)
            messagesRef.current = rolledBack
            setMessages((prev) => prev.filter((m) => m?.id !== userMsg.id))
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
            void loadCachedSession(target.id, scope)
              .then((cachedTarget) => {
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
              })
              .catch(() => {})
          }
          return false
        }
        return true
      }
    },
    [
      activeBridgeIdRef,
      bumpSessionRev,
      cacheScopeRef,
      clientRef,
      deviceGenRef,
      handleCreateSession,
      openNewChatModal,
      resolveModelPrefFor,
      showToast,
    ],
  )

  const handleInterrupt = useCallback(async () => {
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
        clearStream(sid)
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'idle' } : s)))
        void syncActiveSessionQuietly(sid)
      }
    } catch {
      if (deviceGenRef.current !== gen) return
      clearStream(sid)
      setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'idle' } : s)))
      void syncActiveSessionQuietly(sid)
    }
  }, [activeBridgeIdRef, clientRef, deviceGenRef, syncActiveSessionQuietly])

  const handleResolveApproval = useCallback(
    async (id, decisionOrPayload) => {
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
    },
    [activeBridgeIdRef, clientRef, deviceGenRef, showToast],
  )

  const handleOpenModelPicker = useCallback(() => {
    setModelPickerOpen(true)
    const appKey = activeSessionRef.current?.app || effectiveDefaultAppRef.current
    const curModels = modelsCatalogRef.current?.[appKey]?.models || []
    const reqBridgeId = activeBridgeIdRef.current
    if (curModels.length === 0 && clientRef.current && connStateRef.current === 'connected' && reqBridgeId) {
      const client = clientRef.current
      const gen = deviceGenRef.current
      setLoadingModels(true)
      client
        .rpc(RPC.MODELS_LIST, { app: appKey }, 25_000, { bridgeId: reqBridgeId })
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
  }, [activeBridgeIdRef, clientRef, connStateRef, deviceGenRef])

  const handleApplyModelPref = useCallback((next) => {
    const sid = activeSessionRef.current?.id
    if (sid) {
      setSessionModelPrefs((prev) => ({
        ...prev,
        [sid]: next,
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
  }, [])

  // Bridge-scoped live event router (invoked from useTransportBridge)
  const handleBridgeEvent = useCallback(
    (event, payload, _rawMsg, client) => {
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
      if (event === EVENTS.SESSION_UPDATED && payload?.authReady && (payload?.app === 'workbuddy' || payload?.app === 'zcode')) {
        const readyApp = payload.app
        const curClient = clientRef.current
        const reqBridgeId = activeBridgeIdRef.current
        if (curClient && reqBridgeId) {
          curClient
            .rpc(RPC.APPS_STATUS, {}, 12_000, { bridgeId: reqBridgeId })
            .then((res) => {
              if (Array.isArray(res?.apps) && res.apps.find((a) => a.app === readyApp)?.writable) {
                if (readyApp === 'workbuddy') applyWorkbuddyUnlocked(res.apps)
                else if (readyApp === 'zcode') applyZcodeUnlocked(res.apps)
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
          clearStream(updated.id)
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
            !isStreamActive(updated.id)
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

      if (event === EVENTS.STREAM_START) {
        startStream(sid)
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'running' } : s)))
      } else if (event === EVENTS.STREAM_DELTA) {
        appendStreamDelta(sid, payload.delta || '')
      } else if (event === EVENTS.STREAM_THINKING) {
        appendStreamThinking(sid, payload.delta || '')
      } else if (event === EVENTS.STREAM_TOOL_START && payload.tool) {
        streamToolStart(sid, payload.tool)
      } else if (event === EVENTS.STREAM_TOOL_END && payload.toolId) {
        streamToolEnd(sid, payload.toolId, payload.status || 'completed', payload.output || '')
      } else if (event === EVENTS.STREAM_ERROR) {
        failStream(sid, payload.message || biLang(getCurrentLang(), '执行出错', 'Execution error'))
        setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'idle' } : s)))
      } else if (event === EVENTS.STREAM_DONE) {
        const cur = finishStream(sid)
        // Bump per-session revision so any already-in-flight quiet SESSION_READ cannot clobber this turn!
        bumpSessionRev(sid)
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
          const cacheList = messagesRef.current.some((m) => m.id === committed.id)
            ? messagesRef.current
            : [...messagesRef.current, committed]
          messagesRef.current = cacheList
          setMessages((prev) => (prev.some((m) => m.id === committed.id) ? prev : [...prev, committed]))
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

        const doneGen = deviceGenRef.current
        setTimeout(() => {
          if (deviceGenRef.current === doneGen && activeSessionRef.current?.id === sid && !isStreamActive(sid)) {
            void syncActiveSessionQuietly(sid)
          }
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
        }, 1_200)
      }
    },
    [
      activeBridgeIdRef,
      applyWorkbuddyUnlocked,
      bumpSessionRev,
      cacheScopeRef,
      clientRef,
      deviceGenRef,
      syncActiveSessionQuietly,
    ],
  )

  if (sessionHandlersRef) {
    sessionHandlersRef.current = {
      handleBridgeEvent,
      resetTransientWorkspace,
    }
  }

  // Memoized derived values so ChatView, SidebarDrawer, and Composer React.memo boundaries hold
  const activeApp = activeSession?.app || effectiveDefaultApp
  const activeCatalog = modelsCatalog[activeApp] || null

  const activeModelPref = useMemo(
    () => resolveModelPrefFor(activeSession),
    [activeSession, effectiveDefaultApp, modelsCatalog, sessionModelPrefs, draftDshPref, resolveModelPrefFor],
  )

  const activeModelObj = useMemo(
    () =>
      (activeCatalog?.models || []).find(
        (m) =>
          m.id === activeModelPref.model &&
          (!activeModelPref.provider || !m.provider || m.provider === activeModelPref.provider),
      ) || (activeCatalog?.models || []).find((m) => m.id === activeModelPref.model) || null,
    [activeCatalog, activeModelPref],
  )

  const activeSessionId = activeSession?.id || ''

  const activeSessionApprovals = useMemo(
    () => approvals.filter((a) => !a.sessionId || a.sessionId === activeSessionId),
    [approvals, activeSessionId],
  )

  const otherSessionApprovals = useMemo(
    () => approvals.filter((a) => a.sessionId && a.sessionId !== activeSessionId),
    [approvals, activeSessionId],
  )

  const pendingApprovalSessionIds = useMemo(
    () => new Set(approvals.map((a) => a.sessionId).filter(Boolean)),
    [approvals],
  )

  return {
    appsStatus,
    modelsCatalog,
    loadingModels,
    workspaces,
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
    selectedDraftApp,
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
    zcodeSetup,
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
    handleSetupZcode,
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
  }
}
