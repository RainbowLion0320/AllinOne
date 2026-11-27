import { compareSemver } from '@allinone/shared/semver'

export { compareSemver }

export const REPO_URL = 'https://github.com/RainbowLion0320/AllinOne'
export const IOS_APP_STORE_URL = 'https://apps.apple.com/app/id6840015939'

const DEFAULT_RELEASES_URL = 'https://github.com/RainbowLion0320/AllinOne/releases/latest'
const DEFAULT_RELEASES_API_URL = 'https://api.github.com/repos/RainbowLion0320/AllinOne/releases/latest'
export const RELEASES_URL =
  String(import.meta.env?.VITE_RELEASES_URL || '').trim() || DEFAULT_RELEASES_URL

const SAFE_SHA256_RE = /^[a-f0-9]{64}$/i
const MIN_NATIVE_MARKER_RE = /<!--\s*android-ota-min-native:\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\s*-->/i
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])
const GH_RELEASE_CACHE_KEY = 'allinone_gh_release_cache_v1'

function loadGithubReleaseCache(url) {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(GH_RELEASE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.url !== url || !parsed.data) return null
    return parsed
  } catch {
    return null
  }
}

function saveGithubReleaseCache(url, etag, data) {
  try {
    if (typeof localStorage === 'undefined' || !etag || !data) return
    localStorage.setItem(GH_RELEASE_CACHE_KEY, JSON.stringify({ url, etag, data, savedAt: Date.now() }))
  } catch {}
}

function parseSha256Digest(raw) {
  const s = String(raw || '').trim()
  const m = s.match(/^(?:sha256:)?([a-f0-9]{64})$/i)
  return m ? m[1].toLowerCase() : ''
}

function parseNativeManifestResult(res) {
  if (!res) return null
  if (typeof res === 'string') {
    try { return JSON.parse(res) } catch { return null }
  }
  if (typeof res !== 'object') return null
  if (typeof res.body === 'string') {
    try { return JSON.parse(res.body) } catch { return null }
  }
  if (typeof res.text === 'string') {
    try { return JSON.parse(res.text) } catch { return null }
  }
  if (res.data && typeof res.data === 'object') return res.data
  if (res.manifest && typeof res.manifest === 'object') return res.manifest
  if (res.sha256 || res.version || res.signature) return res
  return null
}

function parseMinNativeVersionFromBody(body) {
  const m = String(body || '').match(MIN_NATIVE_MARKER_RE)
  return m ? m[1].trim() : ''
}

/**
 * Returns true when the app is served directly from a remote HTTP(S) web server
 * (Mobile Browser PWA or remote-URL Capacitor WebView APK) rather than bundled
 * local assets (`https://localhost`, `capacitor://`, `app://`, `file://`).
 * In this mode, hot-updating simply refreshes the Service Worker / WebView cache
 * and reloads the current origin — never redirecting to an external download page.
 */
export function isHotReloadableWebOrigin(locationLike = typeof window !== 'undefined' ? window.location : null) {
  if (!locationLike) return false
  const proto = String(locationLike.protocol || '').toLowerCase()
  const host = String(locationLike.hostname || '').toLowerCase()
  if (proto !== 'https:' && proto !== 'http:') return false
  if (!host || LOCAL_HOSTS.has(host)) return false
  return true
}

export function resolveCurrentAppBaseUrl(locationLike = typeof window !== 'undefined' ? window.location : null) {
  if (!locationLike || !locationLike.origin || locationLike.origin === 'null') return ''
  const pathname = String(locationLike.pathname || '/')
  const dir = pathname.endsWith('/')
    ? pathname.replace(/\/+$/, '')
    : pathname.replace(/\/[^/]*$/, '').replace(/\/+$/, '')
  return `${locationLike.origin}${dir}`
}

export async function clearWebCachesAndServiceWorkers({
  navigatorLike = typeof navigator !== 'undefined' ? navigator : null,
  cachesLike = typeof caches !== 'undefined' ? caches : null,
} = {}) {
  try {
    if (typeof window !== 'undefined') {
      window.__allinoneHotReloading = true
    }
  } catch {}

  try {
    if (navigatorLike?.serviceWorker?.getRegistrations) {
      const regs = await navigatorLike.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister().catch(() => {})))
    }
  } catch {}

  try {
    if (cachesLike?.keys) {
      const keys = await cachesLike.keys()
      await Promise.all(keys.map((k) => cachesLike.delete(k).catch(() => {})))
    }
  } catch {}
}

export async function performWebHotReload({
  locationLike = typeof window !== 'undefined' ? window.location : null,
  navigatorLike = typeof navigator !== 'undefined' ? navigator : null,
  cachesLike = typeof caches !== 'undefined' ? caches : null,
} = {}) {
  await clearWebCachesAndServiceWorkers({ navigatorLike, cachesLike })
  if (!locationLike) return
  try {
    const u = new URL(locationLike.href)
    u.searchParams.set('_r', String(Date.now()))
    locationLike.replace(u.toString())
  } catch {
    locationLike.reload?.()
  }
}

/**
 * Checks for an in-place web hot-update when running from a remote web origin
 * (Mobile Browser PWA or remote-URL Capacitor WebView APK).
 */
export async function checkWebHotUpdate({
  currentVersion = '',
  baseUrl = '',
  token = '',
  timeoutMs = 7000,
  locationLike = typeof window !== 'undefined' ? window.location : null,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  navigatorLike = typeof navigator !== 'undefined' ? navigator : null,
} = {}) {
  const curVer = String(currentVersion || '').trim().replace(/^v/i, '')
  let swUpdateReady = false
  let checkedAny = false
  let serverVersion = ''

  if (navigatorLike?.serviceWorker?.getRegistrations) {
    try {
      const regs = await navigatorLike.serviceWorker.getRegistrations()
      if (regs.length > 0) checkedAny = true
      await Promise.all(
        regs.map(async (reg) => {
          try {
            await reg.update()
          } catch {}
          if (reg.waiting) swUpdateReady = true
        }),
      )
    } catch {}
  }

  const originBase = resolveCurrentAppBaseUrl(locationLike)
  const cleanDeviceBase = String(baseUrl || '').trim().replace(/\/+$/, '')
  const targetBase = originBase || cleanDeviceBase

  if (targetBase && fetchImpl) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
    try {
      let sendAuth = false
      if (token && cleanDeviceBase) {
        try {
          sendAuth = new URL(cleanDeviceBase).origin === new URL(targetBase).origin
        } catch {
          sendAuth = cleanDeviceBase === targetBase
        }
      }
      const res = await fetchImpl(`${targetBase}/api/health?_t=${Date.now()}`, {
        cache: 'no-store',
        ...(sendAuth ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      })
      if (res.ok) {
        checkedAny = true
        const data = await res.json().catch(() => null)
        const srvVer = String(data?.version || '').trim().replace(/^v/i, '')
        if (srvVer) serverVersion = srvVer
      }
    } catch {
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  if (!checkedAny && !serverVersion) {
    return { status: 'error', currentVersion: curVer, error: 'Unable to check for updates' }
  }

  const hasNewerServer = Boolean(serverVersion && curVer && compareSemver(serverVersion, curVer) > 0)
  if (hasNewerServer || swUpdateReady) {
    return {
      status: 'downloaded',
      hotUpdate: true,
      mode: 'web-reload',
      currentVersion: curVer,
      latestVersion: hasNewerServer ? serverVersion : curVer,
    }
  }

  return {
    status: 'up-to-date',
    hotUpdate: true,
    mode: 'web-reload',
    currentVersion: curVer,
    latestVersion: serverVersion || curVer,
  }
}

/**
 * Unified update checker for mobile & native Android builds:
 *  - Remote-URL Android WebView APK & Mobile Browser PWA: checks live origin `/api/health`
 *    and Service Worker state, returning an instant in-app hot-reload (`mode: 'web-reload'`).
 *  - Bundled-local Capacitor Android APK (`https://localhost`) with `AllinOneUpdater`:
 *    checks signed relay OTA mirror (fast in China, verified against APK signing cert) and
 *    GitHub Releases `All-in-One-WebBundle.zip` (verified by SHA-256), enabling in-app OTA
 *    download + hot restart (`mode: 'capacitor-ota'`) without jumping to a download page.
 *  - Only falls back to native APK installer guidance when `minNativeVersion > nativeVersion`
 *    or when running an older bundled APK without the native OTA plugin.
 */
export async function checkNativeMobileUpdate({
  currentVersion = '',
  nativeVersion = '',
  stagedVersion = '',
  hasNativeOta = false,
  platform = '',
  baseUrl = '',
  token = '',
  timeoutMs = 7000,
  locationLike = typeof window !== 'undefined' ? window.location : null,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  fetchManifestImpl = null,
  navigatorLike = typeof navigator !== 'undefined' ? navigator : null,
  releasesApiUrl = DEFAULT_RELEASES_API_URL,
} = {}) {
  const detectedPlatform = String(
    platform ||
      (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()
        ? window.Capacitor?.getPlatform?.() || ''
        : ''),
  )
    .trim()
    .toLowerCase()
  const isIosNative = detectedPlatform === 'ios'

  // 1. Remote HTTPS web origin (Mobile PWA or remote-hosted Android WebView APK): always hot-reload in-place!
  //    Never used on native iOS builds (App Store Guideline 2.5.2).
  if (!isIosNative && isHotReloadableWebOrigin(locationLike)) {
    return checkWebHotUpdate({
      currentVersion,
      baseUrl,
      token,
      timeoutMs,
      locationLike,
      fetchImpl,
      navigatorLike,
    })
  }

  // Strictly disable dynamic JS OTA bundles on iOS (App Store Guideline 2.5.2)
  const allowNativeOta = Boolean(hasNativeOta) && !isIosNative

  const curVer = String(currentVersion || '').trim().replace(/^v/i, '')
  const curNativeVer = String(nativeVersion || curVer).trim().replace(/^v/i, '')
  const curStagedVer = String(stagedVersion || '').trim().replace(/^v/i, '')
  let bestVersion = ''
  let releaseUrl = isIosNative ? IOS_APP_STORE_URL : (resolveApkUrl(baseUrl) || RELEASES_URL)
  let apkAssetSize = 0
  let checkedAny = false

  let relayOta = null
  let githubOta = null
  let githubMinNative = ''

  const fetchWithTimeout = async (url, opts = {}) => {
    if (!fetchImpl) throw new Error('fetch unavailable')
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
    try {
      return await fetchImpl(url, { ...opts, ...(ctrl ? { signal: ctrl.signal } : {}) })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '')

  const checkRelayHealth = async () => {
    if (!cleanBase || !token) return
    try {
      const res = await fetchWithTimeout(`${cleanBase}/api/health?_t=${Date.now()}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json().catch(() => null)
        const srvVer = String(data?.version || '').trim().replace(/^v/i, '')
        if (srvVer) {
          checkedAny = true
          if (!bestVersion || compareSemver(srvVer, bestVersion) > 0) {
            bestVersion = srvVer
          }
        }
      }
    } catch {}
  }

  const checkRelayOtaMirror = async () => {
    if (!allowNativeOta || !cleanBase || !/^https:\/\//i.test(cleanBase)) return
    try {
      const res = await fetchWithTimeout(`${cleanBase}/downloads/ota/All-in-One-WebBundle.json?_t=${Date.now()}`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = await res.json().catch(() => null)
      const ver = String(data?.version || '').trim().replace(/^v/i, '')
      const sha256 = parseSha256Digest(data?.sha256)
      const signature = String(data?.signature || '').trim()
      const sigAlg = String(data?.sigAlg || '').trim()
      const bundleFile = String(data?.bundleFile || 'All-in-One-WebBundle.zip').trim().replace(/^\/+/, '')
      const minNativeVersion = String(data?.minNativeVersion || '').trim().replace(/^v/i, '')
      const size = Number(data?.size || 0)
      // Non-GitHub mirror MUST carry a cryptographic signature (verified natively against the APK cert)
      if (!ver || !sha256 || !signature || !sigAlg || !/^[A-Za-z0-9._-]+\.zip$/i.test(bundleFile)) {
        return
      }
      checkedAny = true
      relayOta = {
        version: ver,
        downloadUrl: `${cleanBase}/downloads/ota/${bundleFile}`,
        expectedSha256: sha256,
        signature,
        sigAlg,
        minNativeVersion,
        size: Number.isFinite(size) && size > 0 ? size : 0,
      }
      if (!bestVersion || compareSemver(ver, bestVersion) > 0) {
        bestVersion = ver
      }
    } catch {}
  }

  const checkGithubRelease = async () => {
    try {
      const cached = loadGithubReleaseCache(releasesApiUrl)
      const headers = { Accept: 'application/vnd.github+json' }
      if (cached?.etag) {
        headers['If-None-Match'] = cached.etag
      }
      const res = await fetchWithTimeout(releasesApiUrl, {
        cache: 'no-store',
        headers,
      })
      let data = null
      if (res.status === 304 && cached?.data) {
        data = cached.data
      } else if (res.ok) {
        data = await res.json().catch(() => null)
        const nextEtag = res.headers?.get?.('etag') || ''
        if (nextEtag && data) {
          saveGithubReleaseCache(releasesApiUrl, nextEtag, data)
        }
      } else {
        return
      }
      const ghVer = String(data?.tag_name || '').trim().replace(/^v/i, '')
      if (!ghVer) return
      checkedAny = true
      if (!bestVersion || compareSemver(ghVer, bestVersion) >= 0) {
        bestVersion = ghVer
      }

      if (isIosNative) {
        // On iOS App Store builds, never link to external installers or download OTA bundles
        releaseUrl = IOS_APP_STORE_URL
        return
      }

      const assets = Array.isArray(data?.assets) ? data.assets : []
      const apkAsset = assets.find(
        (a) => /\.apk$/i.test(String(a?.name || '')) && /^https:\/\//i.test(String(a?.browser_download_url || '')),
      )
      if (apkAsset) {
        releaseUrl = apkAsset.browser_download_url
        apkAssetSize = Number(apkAsset.size || 0)
      } else if (/^https:\/\//i.test(String(data?.html_url || ''))) {
        releaseUrl = data.html_url
      }

      githubMinNative = parseMinNativeVersionFromBody(data?.body || '')
      const webBundleAsset = assets.find(
        (a) =>
          /^All-in-One-WebBundle.*\.zip$/i.test(String(a?.name || '')) &&
          /^https:\/\//i.test(String(a?.browser_download_url || '')),
      )
      const manifestAsset = assets.find(
        (a) =>
          /^All-in-One-WebBundle\.json$/i.test(String(a?.name || '')) &&
          /^https:\/\//i.test(String(a?.browser_download_url || '')),
      )
      const bundleSha = parseSha256Digest(webBundleAsset?.digest)
      let ghSignature = ''
      let ghSigAlg = ''
      let ghManifestSha = ''
      let ghManifestMinNative = ''
      if (allowNativeOta && manifestAsset) {
        try {
          const nativePlugin =
            typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()
              ? window.Capacitor?.Plugins?.AllinOneUpdater || null
              : null
          const manifestFetcher =
            typeof fetchManifestImpl === 'function'
              ? fetchManifestImpl
              : typeof nativePlugin?.fetchManifest === 'function'
                ? (url) => nativePlugin.fetchManifest({ url })
                : null

          let mData = null
          if (manifestFetcher) {
            // Native Java HTTP client follows GitHub 302 -> objects.githubusercontent.com without WebView CORS failures
            const rawNative = await manifestFetcher(manifestAsset.browser_download_url)
            mData = parseNativeManifestResult(rawNative)
          } else {
            const mRes = await fetchWithTimeout(manifestAsset.browser_download_url, { cache: 'no-store' })
            if (mRes.ok) {
              mData = await mRes.json().catch(() => null)
            }
          }

          const mSha = parseSha256Digest(mData?.sha256)
          if (mSha && (!bundleSha || mSha === bundleSha)) {
            ghManifestSha = mSha
            ghSignature = String(mData?.signature || '').trim()
            ghSigAlg = String(mData?.sigAlg || '').trim()
            ghManifestMinNative = String(mData?.minNativeVersion || '').trim().replace(/^v/i, '')
          }
        } catch {}
      }
      const effectiveSha = bundleSha || ghManifestSha
      // Require cryptographic signature for OTA bundles unconditionally (verified natively against APK cert)
      if (webBundleAsset && SAFE_SHA256_RE.test(effectiveSha) && ghSignature && ghSigAlg) {
        githubOta = {
          version: ghVer,
          downloadUrl: webBundleAsset.browser_download_url,
          expectedSha256: effectiveSha,
          signature: ghSignature,
          sigAlg: ghSigAlg,
          minNativeVersion: ghManifestMinNative || githubMinNative,
          size: Number(webBundleAsset.size || 0),
        }
      }
    } catch {}
  }

  await Promise.all([checkRelayHealth(), checkRelayOtaMirror(), checkGithubRelease()])

  if (!checkedAny || !bestVersion) {
    return { status: 'error', currentVersion: curVer, error: 'Unable to check for updates' }
  }

  // Pick the highest available OTA candidate (prefer signed relay mirror as primary when versions match, with GitHub fallback)
  let bestOta = null
  if (allowNativeOta) {
    if (relayOta && githubOta) {
      const cmp = compareSemver(relayOta.version, githubOta.version)
      if (cmp > 0) {
        bestOta = relayOta
      } else if (cmp < 0) {
        bestOta = githubOta
      } else if (relayOta.expectedSha256 === githubOta.expectedSha256) {
        bestOta = {
          ...relayOta,
          fallbackUrl: githubOta.downloadUrl,
          minNativeVersion: relayOta.minNativeVersion || githubOta.minNativeVersion || '',
          size: relayOta.size || githubOta.size || 0,
        }
      } else {
        // Digest mismatch between mirror and GitHub: trust official GitHub release
        bestOta = githubOta
      }
    } else {
      bestOta = relayOta || githubOta || null
    }
  }

  const effectiveLatest = bestOta && compareSemver(bestOta.version, bestVersion) >= 0 ? bestOta.version : bestVersion
  if (!curVer || compareSemver(effectiveLatest, curVer) <= 0) {
    return {
      status: 'up-to-date',
      hotUpdate: allowNativeOta,
      ...(isIosNative ? { mode: 'app-store' } : {}),
      currentVersion: curVer,
      latestVersion: effectiveLatest,
      releaseUrl,
    }
  }

  if (isIosNative) {
    return {
      status: 'available',
      hotUpdate: false,
      mode: 'app-store',
      nativeUpgradeRequired: true,
      currentVersion: curVer,
      latestVersion: effectiveLatest,
      releaseUrl: IOS_APP_STORE_URL,
      assetSize: 0,
    }
  }

  // Check whether the new release requires a native APK shell upgrade
  const requiredMinNative = bestOta?.minNativeVersion || githubMinNative || ''
  const needsNativeShellUpgrade = Boolean(
    requiredMinNative && curNativeVer && compareSemver(requiredMinNative, curNativeVer) > 0,
  )

  if (allowNativeOta && bestOta && !needsNativeShellUpgrade && compareSemver(bestOta.version, curVer) > 0) {
    if (curStagedVer && compareSemver(curStagedVer, bestOta.version) === 0) {
      return {
        status: 'downloaded',
        hotUpdate: true,
        mode: 'capacitor-ota',
        currentVersion: curVer,
        latestVersion: bestOta.version,
        assetSize: bestOta.size || 0,
        releaseUrl,
      }
    }
    return {
      status: 'available',
      hotUpdate: true,
      mode: 'capacitor-ota',
      currentVersion: curVer,
      latestVersion: bestOta.version,
      downloadUrl: bestOta.downloadUrl,
      fallbackUrl: bestOta.fallbackUrl || '',
      expectedSha256: bestOta.expectedSha256,
      signature: bestOta.signature || '',
      sigAlg: bestOta.sigAlg || '',
      minNativeVersion: bestOta.minNativeVersion || '',
      assetSize: bestOta.size || 0,
      releaseUrl,
    }
  }

  return {
    status: 'available',
    hotUpdate: false,
    nativeUpgradeRequired: true,
    currentVersion: curVer,
    latestVersion: effectiveLatest,
    releaseUrl,
    assetSize: apkAssetSize,
  }
}

const CONFIGURED_APK_URL = String(import.meta.env?.VITE_APK_URL || '').trim()

const SAFE_SETUP_BASE_RE = /^https?:\/\/[A-Za-z0-9._:[\]/-]+$/

export function formatSafeSetupCmd(baseUrl, os = 'unix') {
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!cleanBase || !SAFE_SETUP_BASE_RE.test(cleanBase)) return ''
  let parsed
  try {
    parsed = new URL(cleanBase)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  if (os === 'win' || os === 'windows' || os === 'ps1') {
    return `irm '${cleanBase}/setup.ps1' | iex`
  }
  return `curl -fsSL '${cleanBase}/setup.sh' | bash`
}

export function resolveApkUrl(base) {
  if (!CONFIGURED_APK_URL) return ''
  if (/^https?:\/\//i.test(CONFIGURED_APK_URL)) return CONFIGURED_APK_URL
  const cleanBase = String(base || '').replace(/\/+$/, '')
  return `${cleanBase}/${CONFIGURED_APK_URL.replace(/^\/+/, '')}`
}

export async function copyTextToClipboard(text) {
  const str = String(text ?? '')
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(str)
      return true
    }
  } catch {}
  try {
    if (typeof document === 'undefined') return false
    const ta = document.createElement('textarea')
    ta.value = str
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '-9999px'
    ta.style.fontSize = '16px' // prevents iOS Safari auto-zoom
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/i.test(navigator.userAgent || '')
    if (isIOS) {
      const range = document.createRange()
      range.selectNodeContents(ta)
      const sel = window.getSelection?.()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
      ta.setSelectionRange(0, str.length)
    } else {
      ta.focus({ preventScroll: true })
      ta.select()
      ta.setSelectionRange(0, str.length)
    }
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return Boolean(ok)
  } catch {
    return false
  }
}
