import { useCallback, useEffect, useRef, useState } from 'react'
import {
  checkNativeMobileUpdate,
  clearWebCachesAndServiceWorkers,
  isHotReloadableWebOrigin,
  performWebHotReload,
} from '../lib/clientHelpers.js'
import { bi as biLang, getCurrentLang } from '../lib/i18n.js'

/**
 * Unified update & OTA lifecycle hook across Electron Desktop, Capacitor Android OTA,
 * and remote-origin Web PWA (using interactive `registerType: 'prompt'` reload).
 *
 * Delays Capacitor `confirmBoot()` by 2.5s after mount so a broken OTA bundle that
 * crashes during initial React render automatically rolls back on next launch.
 */
export function useOtaUpdater({ desktopApi, activeDevice, showToast }) {
  const [updateState, setUpdateState] = useState(null)
  const [otaInfo, setOtaInfo] = useState(null)
  const updateStateRef = useRef(null)
  updateStateRef.current = updateState

  const isNativeMobile =
    typeof window !== 'undefined' && !desktopApi && Boolean(window.Capacitor?.isNativePlatform?.())
  const nativeOtaPlugin = isNativeMobile ? window.Capacitor?.Plugins?.AllinOneUpdater || null : null
  const isWebHotUpdatable =
    typeof window !== 'undefined' && !desktopApi && isHotReloadableWebOrigin(window.location)
  const canCheckMobileUpdate = !desktopApi && (isNativeMobile || isWebHotUpdatable)

  // Electron Desktop auto-updater subscription
  useEffect(() => {
    if (!desktopApi) return undefined
    let unsubUpdate = null
    desktopApi.getUpdateState?.().then((st) => {
      if (st) setUpdateState(st)
    }).catch(() => {})
    if (typeof desktopApi.onUpdateState === 'function') {
      unsubUpdate = desktopApi.onUpdateState((st) => setUpdateState(st))
    }
    return () => {
      try { unsubUpdate?.() } catch {}
    }
  }, [desktopApi])

  // Native Android OTA: delayed healthy-boot confirmation (2.5s) + progress + app info
  useEffect(() => {
    if (!nativeOtaPlugin) return undefined
    const currentVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
    let cancelled = false

    const refreshInfo = () => {
      if (typeof nativeOtaPlugin.getAppInfo !== 'function') return
      nativeOtaPlugin
        .getAppInfo()
        .then((info) => {
          if (!cancelled && info && typeof info === 'object') {
            setOtaInfo(info)
          }
        })
        .catch(() => {})
    }
    refreshInfo()

    const confirmTimer = setTimeout(() => {
      if (cancelled) return
      try {
        void nativeOtaPlugin.confirmBoot?.({ version: currentVersion })?.then?.(refreshInfo)?.catch?.(() => {})
      } catch {}
    }, 2_500)

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
      cancelled = true
      clearTimeout(confirmTimer)
      handlePromise?.then((h) => h?.remove?.())?.catch?.(() => {})
    }
  }, [nativeOtaPlugin])

  // Web PWA interactive SW update detection (no abrupt skipWaiting mid-session)
  useEffect(() => {
    if (!isWebHotUpdatable || typeof navigator === 'undefined' || !navigator.serviceWorker) {
      return undefined
    }
    let cancelled = false
    let cleanupFns = []

    const notifyWaiting = () => {
      if (cancelled) return
      const curVer = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
      setUpdateState((prev) => {
        if (prev?.status === 'downloading' || prev?.status === 'installing') return prev
        return {
          status: 'downloaded',
          hotUpdate: true,
          mode: 'web-reload',
          currentVersion: curVer,
          latestVersion: prev?.latestVersion || curVer,
        }
      })
    }

    navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (cancelled || !reg) return
        if (reg.waiting) notifyWaiting()
        const onUpdateFound = () => {
          const worker = reg.installing
          if (!worker) return
          const onState = () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              notifyWaiting()
            }
          }
          worker.addEventListener('statechange', onState)
          cleanupFns.push(() => worker.removeEventListener('statechange', onState))
        }
        reg.addEventListener('updatefound', onUpdateFound)
        cleanupFns.push(() => reg.removeEventListener('updatefound', onUpdateFound))
      })
      .catch(() => {})

    return () => {
      cancelled = true
      for (const fn of cleanupFns) {
        try { fn() } catch {}
      }
      cleanupFns = []
    }
  }, [isWebHotUpdatable])

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

  const handleResetOtaBundle = useCallback(async () => {
    if (!nativeOtaPlugin?.resetToBundled) return
    try {
      await clearWebCachesAndServiceWorkers()
      await nativeOtaPlugin.resetToBundled()
    } catch (err) {
      showToast?.(String(err?.message || err || biLang(getCurrentLang(), '恢复内置版本失败', 'Reset failed')))
    }
  }, [nativeOtaPlugin, showToast])

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
          if (info && typeof info === 'object') setOtaInfo(info)
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
      if (!silent && next.status === 'available' && next.hotUpdate && next.mode === 'capacitor-ota' && nativeOtaPlugin) {
        return handleDownloadMobileUpdate(next)
      }
      setUpdateState(next)
      return next
    },
    [canCheckMobileUpdate, nativeOtaPlugin, activeDevice?.baseUrl, activeDevice?.token, handleDownloadMobileUpdate],
  )

  // Periodic background check for mobile (5s after launch + every 4h)
  useEffect(() => {
    if (!canCheckMobileUpdate) return undefined
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

  return {
    updateState,
    setUpdateState,
    otaInfo,
    isNativeMobile,
    nativeOtaPlugin,
    canCheckMobileUpdate,
    handleCheckNativeMobileUpdate,
    handleDownloadMobileUpdate,
    handleCancelMobileUpdate,
    handleInstallMobileUpdate,
    handleResetOtaBundle: nativeOtaPlugin?.resetToBundled ? handleResetOtaBundle : null,
  }
}
