import { useEffect, useMemo, useRef, useState } from 'react'
import { EVENTS } from '@allinone/shared'
import { MobileRelayClient } from '../lib/wsClient.js'
import { clearE2eeMediaCache } from '../lib/e2eeMedia.js'
import { clearSessionCache } from '../lib/sessionCache.js'
import { clearDraftsForScope } from '../lib/draftStore.js'
import {
  clearDeviceCredentials,
  getCacheScopeKey,
  getDeviceDisplayName,
  updateDeviceMeta,
  upsertDeviceE2eeKey,
} from '../lib/deviceStore.js'
import { clearAllStreamErrors } from '../state/streamingStore.js'
import { bi as biLang, getCurrentLang } from '../lib/i18n.js'

/**
 * Manages the MobileRelayClient lifecycle, P2P transport state, Electron embedded
 * desktop bridge sync, active bridge / E2EE lock derivation, remote revocation wipes,
 * hot JWT rotation, and room-wide E2EE grant / QR nudge signaling.
 */
export function useTransportBridge({
  activeDevice,
  activeDeviceRef,
  clientRef,
  desktopApi,
  lang,
  e2eeModalOpen,
  setDeviceState,
  onMenuActionRef,
  sessionHandlersRef,
  hasSessionContextRef,
  showToast,
}) {
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
  const [serverGithubEnabled, setServerGithubEnabled] = useState(false)
  const [pendingGrantPopup, setPendingGrantPopup] = useState(null)
  const [qrNudge, setQrNudge] = useState(null)
  const [desktopBridge, setDesktopBridge] = useState(null)
  const [clientInstance, setClientInstance] = useState(null)

  const connStateRef = useRef(connState)
  connStateRef.current = connState
  const p2pStateRef = useRef(p2pState)
  p2pStateRef.current = p2pState
  const activeDeviceTokenRef = useRef(activeDevice?.token || '')
  activeDeviceTokenRef.current = activeDevice?.token || ''
  const activeE2eeKeysRef = useRef(activeDevice?.e2eeKeys || {})
  activeE2eeKeysRef.current = activeDevice?.e2eeKeys || {}
  const e2eeModalOpenRef = useRef(Boolean(e2eeModalOpen))
  e2eeModalOpenRef.current = Boolean(e2eeModalOpen)
  const hadDesktopAccountRef = useRef(false)
  const revokedWipeGuardRef = useRef('')

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
        if (knownOfflineDevice || hasSessionContextRef?.current) {
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
  }, [activeDevice, onlineBridges, accountDevices, hasSessionContextRef])

  const bridgeOnline = Boolean(activeBridge)
  const activeBridgeId = activeBridge?.bridgeId || ''
  const activeBridgeIdRef = useRef(activeBridgeId)
  activeBridgeIdRef.current = activeBridgeId

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
  const cacheScopeRef = useRef(cacheScope)
  cacheScopeRef.current = cacheScope

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

  // Electron Desktop App integration: live local bridge status + menu shortcuts
  useEffect(() => {
    if (!desktopApi) return
    let unsubStatus = null
    let unsubMenu = null
    desktopApi
      .getBridgeStatus?.()
      .then((st) => {
        if (st) setDesktopBridge(st)
      })
      .catch(() => {})
    if (typeof desktopApi.onBridgeStatus === 'function') {
      unsubStatus = desktopApi.onBridgeStatus((st) => setDesktopBridge(st))
    }
    if (typeof desktopApi.onMenuAction === 'function') {
      unsubMenu = desktopApi.onMenuAction((action) => {
        onMenuActionRef?.current?.(action)
      })
    }
    return () => {
      try { unsubStatus?.() } catch {}
      try { unsubMenu?.() } catch {}
    }
  }, [desktopApi, onMenuActionRef])

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
      hadDesktopAccountRef.current = false
      desktopApi.stopBridge?.().catch(() => {})
    }
  }, [
    desktopApi,
    activeDevice?.id,
    activeDevice?.token,
    activeDevice?.baseUrl,
    activeDevice?.roomId,
    activeDevice?.username,
    setDeviceState,
  ])

  // Keep Desktop UI's local E2EE key ring synced with the embedded bridge key
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
  }, [
    desktopApi,
    activeDevice?.id,
    activeDevice?.token,
    activeDevice?.roomId,
    desktopBridge?.e2eeKeyId,
    desktopBridge?.state,
    setDeviceState,
  ])

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
  }, [activeDevice?.id, activeBridge?.bridgeId, activeBridge?.hostname, activeBridge?.platform, setDeviceState])

  // Auto-clear mobile scan nudge when QR modal opens or after 60s timeout
  useEffect(() => {
    if (e2eeModalOpen && qrNudge) {
      setQrNudge(null)
      return
    }
    if (!qrNudge) return
    const timer = setTimeout(() => setQrNudge(null), 60_000)
    return () => clearTimeout(timer)
  }, [e2eeModalOpen, qrNudge])

  // Mobile side C1: when locked on the E2EE unlock screen, gently nudge online desktop to surface a 1-click "Show QR" bar
  useEffect(() => {
    if (desktopApi || connState !== 'connected' || !bridgeOnline || !e2eeLocked) return
    const wantedKeyId = String(activeBridgeE2ee.keyId || '').trim().toLowerCase()
    clientRef.current?.sendQrNudge?.({ wantedKeyId, action: 'scanning' })
    return () => {
      clientRef.current?.sendQrNudge?.({ wantedKeyId, action: 'done' })
    }
  }, [desktopApi, connState, bridgeOnline, e2eeLocked, activeBridgeE2ee.keyId, clientRef])

  useEffect(() => {
    clientRef.current?.setE2eeKeys(activeDevice?.e2eeKeys || {})
  }, [activeDevice?.e2eeKeys, clientRef])

  const hasActiveToken = Boolean(activeDevice?.token)

  // Connect WebSocket whenever the active saved account changes
  useEffect(() => {
    const devSnap = activeDeviceRef.current
    const initialToken = activeDeviceTokenRef.current
    if (!activeDevice?.id || !activeDevice?.baseUrl || !initialToken) {
      setClientInstance(null)
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
    setClientInstance(client)

    const unsubStatus = client.onStatus(
      ({
        state,
        error,
        bridges: bList,
        devices: dList,
        onlineClientCount: occ,
        p2pState: nextP2p,
        p2pError: nextP2pErr,
        p2pEngine: nextP2pEngine,
        p2pTransport: nextP2pTransport,
        turnQuota: nextTurnQuota,
      }) => {
        if (clientRef.current !== client) return
        const prevConn = connStateRef.current
        const prevP2p = p2pStateRef.current
        const resolvedP2p = nextP2p || 'idle'

        // Clear stale stream error banners cleanly upon transport reconnect
        if (
          (state === 'connected' && prevConn !== 'connected') ||
          (resolvedP2p === 'connected' && prevP2p !== 'connected')
        ) {
          clearAllStreamErrors()
        }

        setConnState(state)
        setConnError(error || '')
        setP2pState(resolvedP2p)
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
      },
    )

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
        const reason = String(payload.reason || '').trim().toLowerCase()
        setPendingGrantPopup((prev) => {
          if (!prev || prev.reqId !== payload.reqId) return prev
          if (reason === 'claimed_by_other' || reason === 'already_claimed' || reason === 'delivered') {
            showToast(
              biLang(
                getCurrentLang(),
                '该授权请求已被其他设备处理',
                'This authorization request was already handled by another device',
              ),
            )
          }
          return null
        })
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

      // Strictly isolate live events to the currently selected computer bridge
      const evBridgeId = String(rawMsg?.bridgeId || '').trim()
      const curBridgeId = activeBridgeIdRef.current
      if (evBridgeId && (!curBridgeId || evBridgeId !== curBridgeId)) {
        return
      }

      sessionHandlersRef?.current?.handleBridgeEvent?.(event, payload, rawMsg, client)
    })

    client.connect()

    return () => {
      unsubStatus()
      unsubEvents()
      client.disconnect()
      if (clientRef.current === client) {
        clientRef.current = null
        setClientInstance(null)
      }
    }
  }, [activeDevice?.id, activeDevice?.baseUrl, hasActiveToken, activeDeviceRef, clientRef, sessionHandlersRef, setDeviceState, showToast])

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
    sessionHandlersRef?.current?.resetTransientWorkspace?.()
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
  }, [connState, activeDevice?.id, activeDevice?.roomId, sessionHandlersRef, setDeviceState])

  // Hot-swap rotated JWT without tearing down an active WebSocket; only reconnect if unauthorized
  useEffect(() => {
    const token = activeDevice?.token
    const client = clientRef.current
    if (!token || !client) return
    client.updateToken(token)
    if (connStateRef.current === 'unauthorized') {
      client.connect()
    }
  }, [activeDevice?.token, clientRef])

  return {
    connState,
    connStateRef,
    connError,
    p2pState,
    p2pError,
    p2pEngine,
    p2pTransport,
    turnQuota,
    setTurnQuota,
    bridges,
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
  }
}
