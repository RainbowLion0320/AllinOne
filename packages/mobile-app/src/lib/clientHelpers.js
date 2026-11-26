export const REPO_URL = 'https://github.com/RainbowLion0320/AllinOne'

const DEFAULT_RELEASES_URL = 'https://github.com/RainbowLion0320/AllinOne/releases/latest'
const DEFAULT_RELEASES_API_URL = 'https://api.github.com/repos/RainbowLion0320/AllinOne/releases/latest'
export const RELEASES_URL =
  String(import.meta.env?.VITE_RELEASES_URL || '').trim() || DEFAULT_RELEASES_URL

export function compareSemver(a, b) {
  const parse = (raw) => {
    const clean = String(raw || '').trim().replace(/^v/i, '')
    const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
    if (!m) return null
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre.localeCompare(pb.pre)
}

/**
 * Lightweight version checker for native mobile (Capacitor Android APK) builds.
 * Checks GitHub Releases API first (for APK direct URL & exact size) and falls back
 * to the authenticated relay `/api/health` version so mainland China users always get
 * timely update notifications even when `api.github.com` is slow or unreachable.
 */
export async function checkNativeMobileUpdate({
  currentVersion = '',
  baseUrl = '',
  token = '',
  timeoutMs = 7000,
} = {}) {
  const curVer = String(currentVersion || '').trim().replace(/^v/i, '')
  let bestVersion = ''
  let releaseUrl = resolveApkUrl(baseUrl) || RELEASES_URL
  let assetSize = 0
  let checkedAny = false

  const fetchWithTimeout = async (url, opts = {}) => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
    try {
      return await fetch(url, { ...opts, ...(ctrl ? { signal: ctrl.signal } : {}) })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // 1. Prefer authenticated relay /api/health (fast, direct, always reachable)
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (cleanBase && token) {
    try {
      const res = await fetchWithTimeout(`${cleanBase}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        const srvVer = String(data?.version || '').trim().replace(/^v/i, '')
        if (srvVer) {
          checkedAny = true
          bestVersion = srvVer
        }
      }
    } catch {}
  }

  // 2. Also query GitHub Releases latest (gives exact APK download URL & size when reachable)
  try {
    const res = await fetchWithTimeout(DEFAULT_RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (res.ok) {
      const data = await res.json()
      const ghVer = String(data?.tag_name || '').trim().replace(/^v/i, '')
      if (ghVer) {
        checkedAny = true
        if (!bestVersion || compareSemver(ghVer, bestVersion) >= 0) {
          bestVersion = ghVer
          const apkAsset = Array.isArray(data?.assets)
            ? data.assets.find((a) => /\.apk$/i.test(String(a?.name || '')) && /^https:\/\//i.test(String(a?.browser_download_url || '')))
            : null
          if (apkAsset) {
            releaseUrl = apkAsset.browser_download_url
            assetSize = Number(apkAsset.size || 0)
          } else if (/^https:\/\//i.test(String(data?.html_url || ''))) {
            releaseUrl = data.html_url
          }
        }
      }
    }
  } catch {}

  if (!checkedAny || !bestVersion) {
    return { status: 'error', currentVersion: curVer, error: 'Unable to check for updates' }
  }
  if (curVer && compareSemver(bestVersion, curVer) > 0) {
    return {
      status: 'available',
      currentVersion: curVer,
      latestVersion: bestVersion,
      releaseUrl,
      assetSize,
    }
  }
  return {
    status: 'up-to-date',
    currentVersion: curVer,
    latestVersion: bestVersion,
    releaseUrl,
  }
}

const CONFIGURED_APK_URL = String(import.meta.env?.VITE_APK_URL || '').trim()

const SAFE_SETUP_BASE_RE = /^https?:\/\/[A-Za-z0-9._:\-\[\]\/]+$/

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
