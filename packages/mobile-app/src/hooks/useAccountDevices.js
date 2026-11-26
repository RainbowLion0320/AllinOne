import { useCallback, useEffect, useRef } from 'react'
import { clearE2eeMediaCache } from '../lib/e2eeMedia.js'
import {
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
} from '../lib/wsClient.js'
import {
  getDeviceDisplayName,
  removeDevice,
  selectDevice,
  updateDeviceMeta,
} from '../lib/deviceStore.js'
import { clearSessionCache } from '../lib/sessionCache.js'
import { clearDraftsForScope } from '../lib/draftStore.js'
import { bi as biLang, getCurrentLang } from '../lib/i18n.js'

/**
 * Account, device list, client sessions, email binding & 2FA orchestration.
 *
 * Breaks the `liveOnlineClientCount` <-> `fetchAuthSessions` feedback loop and
 * ensures Settings closing never triggers redundant status probes.
 */
export function useAccountDevices({
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
  setTurnQuota,
  setDeviceSwitcherOpen,
  setDrawerOpen,
  resetTransientWorkspace,
  showToast,
}) {
  const lastFetchedOnlineCountRef = useRef(-1)
  const prevSettingsOpenForProbeRef = useRef(false)
  const prevSettingsOpenForSessRef = useRef(false)

  const handleSelectDevice = useCallback(
    (deviceId, bridgeId = '') => {
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
    },
    [
      activeDevice?.id,
      activeDevice?.selectedBridgeId,
      activeBridgeIdRef,
      clientRef,
      devices,
      accountDevices,
      onlineBridges,
      resetTransientWorkspace,
      setBridges,
      setDeviceState,
      showToast,
    ],
  )

  const handleSyncDeviceMeta = useCallback(
    (deviceId, patch) => {
      setDeviceState((prev) => updateDeviceMeta(prev, deviceId, patch))
    },
    [setDeviceState],
  )

  const handleRenameAccountDevice = useCallback(
    async (pcDeviceId, newLabel) => {
      const dev = activeDeviceRef.current
      if (!dev?.baseUrl || !dev?.token) return
      try {
        const nextList = await renameAccountDevice(dev.baseUrl, dev.token, {
          deviceId: pcDeviceId,
          label: newLabel,
        })
        setAccountDevices(nextList)
        showToast(biLang(getCurrentLang(), `已重命名为 ${newLabel}`, `Renamed to ${newLabel}`))
      } catch (err) {
        showToast(String(err?.message || err))
      }
    },
    [activeDeviceRef, setAccountDevices, showToast],
  )

  const handleRemoveAccountDevice = useCallback(
    async (pcDeviceId, pcBridgeId = '') => {
      const dev = activeDeviceRef.current
      if (!dev?.baseUrl || !dev?.token) return
      const devId = dev.id
      try {
        const nextList = await removeAccountDevice(dev.baseUrl, dev.token, {
          deviceId: pcDeviceId,
        })
        setAccountDevices(nextList)
        if (pcBridgeId && activeBridgeIdRef.current === pcBridgeId) {
          resetTransientWorkspace()
          setDeviceState((prev) => updateDeviceMeta(prev, devId, { selectedBridgeId: '' }))
        }
        showToast(biLang(getCurrentLang(), '已解绑并断开该电脑', 'Computer unlinked and disconnected'))
      } catch (err) {
        showToast(String(err?.message || err))
      }
    },
    [activeDeviceRef, activeBridgeIdRef, resetTransientWorkspace, setAccountDevices, setDeviceState, showToast],
  )

  const handleRefreshClientSessions = useCallback(async () => {
    const dev = activeDeviceRef.current
    if (!dev?.baseUrl || !dev?.token) return
    const gen = deviceGenRef.current
    try {
      const res = await fetchAuthSessions(
        dev.baseUrl,
        dev.token,
        clientRef.current?.clientId || '',
      )
      if (deviceGenRef.current !== gen) return
      setClientSessions(res)
      lastFetchedOnlineCountRef.current = res.onlineCount
      setLiveOnlineClientCount((prev) => (prev === res.onlineCount ? prev : res.onlineCount))
    } catch {}
  }, [activeDeviceRef, deviceGenRef, clientRef, setClientSessions, setLiveOnlineClientCount])

  // Fetch client sessions on initial connect, when Settings transitions false->true,
  // or when liveOnlineClientCount genuinely changes externally while Settings is open.
  useEffect(() => {
    const justOpened = settingsOpen && !prevSettingsOpenForSessRef.current
    prevSettingsOpenForSessRef.current = settingsOpen
    if (!activeDevice?.baseUrl || !activeDevice?.token || connState !== 'connected') {
      lastFetchedOnlineCountRef.current = -1
      return
    }
    const countChangedExternally =
      settingsOpen &&
      liveOnlineClientCount !== lastFetchedOnlineCountRef.current
    if (justOpened || countChangedExternally || lastFetchedOnlineCountRef.current === -1) {
      lastFetchedOnlineCountRef.current = liveOnlineClientCount
      void handleRefreshClientSessions()
    }
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
      const dev = activeDeviceRef.current
      if (!dev?.baseUrl || !dev?.token) return
      try {
        const res = await revokeAuthSession(dev.baseUrl, dev.token, {
          sid,
          clientId,
          currentClientId: clientRef.current?.clientId || '',
        })
        setClientSessions(res)
        lastFetchedOnlineCountRef.current = res.onlineCount
        setLiveOnlineClientCount(res.onlineCount)
        showToast(biLang(getCurrentLang(), '已将该设备踢下线', 'Signed out device'))
      } catch (err) {
        showToast(String(err?.message || err))
      }
    },
    [activeDeviceRef, clientRef, setClientSessions, setLiveOnlineClientCount, showToast],
  )

  const handleRevokeOtherClientSessions = useCallback(async () => {
    const dev = activeDeviceRef.current
    if (!dev?.id || !dev?.baseUrl || !dev?.token) return
    const devId = dev.id
    try {
      const res = await revokeOtherAuthSessions(
        dev.baseUrl,
        dev.token,
        clientRef.current?.clientId || '',
      )
      if (res.token) {
        clientRef.current?.updateToken(res.token)
        setDeviceState((prev) => updateDeviceMeta(prev, devId, { token: res.token }))
      }
      setClientSessions(res)
      lastFetchedOnlineCountRef.current = res.onlineCount
      setLiveOnlineClientCount(res.onlineCount)
      showToast(biLang(getCurrentLang(), '已下线其他全部登录设备，仅保留本机', 'Signed out all other devices'))
    } catch (err) {
      showToast(String(err?.message || err))
    }
  }, [activeDeviceRef, clientRef, setClientSessions, setDeviceState, setLiveOnlineClientCount, showToast])

  const handleRefreshAccountDevices = useCallback(async () => {
    const dev = activeDeviceRef.current
    const targetDeviceId = dev?.id
    const baseUrl = dev?.baseUrl
    const token = dev?.token
    const roomId = dev?.roomId || ''
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
  }, [activeDeviceRef, deviceGenRef, setAccountDevices, setServerEmailEnabled, setTurnQuota, setDeviceState])

  // Account status probe on device mount/switch/token refresh, and when Settings OPENS (never on close)
  const lastProbedKeyRef = useRef('')
  useEffect(() => {
    const devId = activeDevice?.id
    const baseUrl = activeDevice?.baseUrl
    const token = activeDevice?.token
    const roomId = activeDevice?.roomId || ''
    const justOpened = settingsOpen && !prevSettingsOpenForProbeRef.current
    prevSettingsOpenForProbeRef.current = settingsOpen

    if (!devId || !baseUrl || !token) {
      lastProbedKeyRef.current = ''
      setServerEmailEnabled(false)
      return undefined
    }

    const identityKey = `${devId}|${baseUrl}|${token}|${roomId}`
    if (lastProbedKeyRef.current === identityKey && !justOpened) {
      return undefined
    }
    lastProbedKeyRef.current = identityKey

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
  }, [
    activeDevice?.id,
    activeDevice?.baseUrl,
    activeDevice?.token,
    activeDevice?.roomId,
    settingsOpen,
    setAccountDevices,
    setServerEmailEnabled,
    setTurnQuota,
    setDeviceState,
  ])

  const handleSendBindEmailCode = useCallback(
    async (targetEmail) => {
      const dev = activeDeviceRef.current
      if (!dev?.baseUrl || !dev?.token) {
        throw new Error(biLang(getCurrentLang(), '未登录账号', 'Not signed in'))
      }
      return sendEmailVerificationCode(dev.baseUrl, {
        purpose: 'bind',
        email: targetEmail,
        token: dev.token,
      })
    },
    [activeDeviceRef],
  )

  const handleBindAccountEmail = useCallback(
    async (targetEmail, code, currentPassword = '') => {
      const dev = activeDeviceRef.current
      if (!dev?.id || !dev?.baseUrl || !dev?.token) {
        throw new Error(biLang(getCurrentLang(), '未登录账号', 'Not signed in'))
      }
      const devId = dev.id
      const user = await bindAccountEmail(dev.baseUrl, dev.token, {
        email: targetEmail,
        code,
        currentPassword,
      })
      const boundEmail = user?.email || targetEmail
      setDeviceState((prev) => updateDeviceMeta(prev, devId, { email: boundEmail }))
      showToast(biLang(getCurrentLang(), `已绑定邮箱 ${boundEmail}`, `Linked email ${boundEmail}`))
      return user
    },
    [activeDeviceRef, setDeviceState, showToast],
  )

  const handleToggleLoginEmail2fa = useCallback(
    async (enabled, currentPassword = '') => {
      const dev = activeDeviceRef.current
      if (!dev?.id || !dev?.baseUrl || !dev?.token) return
      const devId = dev.id
      try {
        const user = await setAccountLogin2fa(dev.baseUrl, dev.token, enabled, currentPassword)
        setDeviceState((prev) =>
          updateDeviceMeta(prev, devId, { loginEmail2fa: Boolean(user?.loginEmail2fa) }),
        )
        const curLang = getCurrentLang()
        showToast(
          user?.loginEmail2fa
            ? biLang(curLang, '已开启登录邮箱二次验证', 'Email login 2FA enabled')
            : biLang(curLang, '已关闭登录邮箱二次验证', 'Email login 2FA disabled'),
        )
      } catch (err) {
        if (!enabled) throw err
        showToast(String(err?.message || err))
      }
    },
    [activeDeviceRef, setDeviceState, showToast],
  )

  const handleRemoveDevice = useCallback(
    async (deviceId, { revokeAll = false } = {}) => {
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
      const removingActive = activeDeviceRef.current?.id === deviceId
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
    },
    [
      activeDeviceRef,
      devices,
      resetTransientWorkspace,
      setBridges,
      setDeviceState,
      setDeviceSwitcherOpen,
      setDrawerOpen,
      showToast,
    ],
  )

  return {
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
    handleRemoveDevice,
  }
}
