import { pollGithubOAuth, startGithubOAuth } from './wsClient.js'

const PENDING_OAUTH_STORAGE_KEY = 'allinone_github_oauth_pending_v1'
const PENDING_MAX_AGE_MS = 10 * 60 * 1000

export function isNativeOrDesktopClient() {
  if (typeof window === 'undefined') return false
  return Boolean(window.allinoneDesktop?.isDesktop || window.Capacitor?.isNativePlatform?.())
}

export function savePendingGithubOAuth(record) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return
    window.sessionStorage.setItem(
      PENDING_OAUTH_STORAGE_KEY,
      JSON.stringify({
        serverUrl: String(record?.serverUrl || ''),
        pollToken: String(record?.pollToken || ''),
        mode: record?.mode === 'bind' ? 'bind' : 'login',
        deviceId: String(record?.deviceId || ''),
        startedAt: Date.now(),
      }),
    )
  } catch {}
}

export function loadPendingGithubOAuth(expectedMode = '') {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null
    const raw = window.sessionStorage.getItem(PENDING_OAUTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.pollToken || !parsed?.serverUrl) {
      window.sessionStorage.removeItem(PENDING_OAUTH_STORAGE_KEY)
      return null
    }
    if (Date.now() - (Number(parsed.startedAt) || 0) > PENDING_MAX_AGE_MS) {
      window.sessionStorage.removeItem(PENDING_OAUTH_STORAGE_KEY)
      return null
    }
    if (expectedMode && parsed.mode !== expectedMode) return null
    return parsed
  } catch {
    return null
  }
}

export function clearPendingGithubOAuth() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.removeItem(PENDING_OAUTH_STORAGE_KEY)
    }
  } catch {}
}

export function stripOAuthQueryParamFromUrl() {
  try {
    if (typeof window === 'undefined' || !window.history?.replaceState) return false
    const u = new URL(window.location.href)
    if (!u.searchParams.has('oauth')) return false
    u.searchParams.delete('oauth')
    window.history.replaceState(null, '', u.toString())
    return true
  } catch {
    return false
  }
}

/**
 * Start a cross-platform GitHub OAuth flow:
 * - On Electron Desktop / Capacitor Android APK: opens external system browser and returns `{ authorizeUrl, pollToken }` for polling.
 * - On Web / Mobile Browser / iOS PWA: synchronously tries a popup window (so Safari/Chrome popup blockers allow it);
 *   if blocked (e.g. iOS standalone PWA), automatically falls back to a clean same-tab redirect with `sessionStorage` resume.
 */
export async function launchGithubOAuthFlow({
  serverUrl,
  mode = 'login',
  token = '',
  bootstrapToken = '',
  deviceId = '',
}) {
  const isNative = isNativeOrDesktopClient()
  let popup = null
  let useSameTab = false

  if (!isNative && typeof window !== 'undefined') {
    try {
      const w = 560
      const h = 720
      const left = Math.max(0, Math.round((window.screenX || 0) + ((window.outerWidth || 1000) - w) / 2))
      const top = Math.max(0, Math.round((window.screenY || 0) + ((window.outerHeight || 800) - h) / 2))
      popup = window.open(
        'about:blank',
        'allinone_github_oauth',
        `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`,
      )
    } catch {
      popup = null
    }
    if (!popup || popup.closed) {
      popup = null
      useSameTab = true
    }
  }

  let returnUrl = ''
  if (useSameTab && typeof window !== 'undefined') {
    try {
      const cur = new URL(window.location.href)
      if (cur.protocol === 'http:' || cur.protocol === 'https:') {
        cur.searchParams.delete('oauth')
        cur.hash = ''
        returnUrl = cur.toString()
      }
    } catch {}
  }

  let started
  try {
    started = await startGithubOAuth(serverUrl, {
      mode,
      token,
      bootstrapToken,
      returnUrl,
    })
  } catch (err) {
    if (popup && !popup.closed) {
      try { popup.close() } catch {}
    }
    throw err
  }

  if (useSameTab) {
    savePendingGithubOAuth({
      serverUrl: started.baseUrl,
      pollToken: started.pollToken,
      mode,
      deviceId,
    })
    window.location.assign(started.authorizeUrl)
    return { redirected: true, ...started, popup: null }
  }

  if (popup && !popup.closed) {
    try {
      popup.location.href = started.authorizeUrl
      popup.focus?.()
    } catch {
      window.open(started.authorizeUrl, '_blank', 'noopener,noreferrer')
    }
  } else if (typeof window !== 'undefined') {
    window.open(started.authorizeUrl, '_blank', 'noopener,noreferrer')
  }

  return { redirected: false, ...started, popup }
}

/**
 * Poll a GitHub OAuth handshake until completion, failure, expiry, or cancellation.
 * Triggers an immediate poll whenever the window regains focus or becomes visible
 * (e.g. switching back from system browser on Desktop or Android APK).
 */
export function startGithubOAuthPolling({
  serverUrl,
  pollToken,
  token = '',
  popup = null,
  intervalMs = 1500,
  onComplete,
  onError,
}) {
  let stopped = false
  let inFlight = false
  let timer = null

  const cleanup = () => {
    if (stopped) return
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', triggerNow)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVis)
    }
    if (popup && !popup.closed) {
      try { popup.close() } catch {}
    }
  }

  const scheduleNext = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, intervalMs)
  }

  const tick = async () => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const res = await pollGithubOAuth(serverUrl, { pollToken, token })
      if (stopped) return
      if (res.status === 'completed') {
        cleanup()
        onComplete?.(res)
        return
      }
      if (res.status === 'failed' || res.status === 'expired') {
        cleanup()
        onError?.(res.error || 'GitHub authorization failed')
        return
      }
      scheduleNext()
    } catch (err) {
      if (stopped) return
      // Keep polling across transient mobile background network blips
      scheduleNext()
      void err
    } finally {
      inFlight = false
    }
  }

  const triggerNow = () => {
    if (stopped) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    void tick()
  }

  const onVis = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      triggerNow()
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', triggerNow)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVis)
  }

  // Start first poll after 1s (user needs at least 1s to click Authorize)
  timer = setTimeout(() => {
    timer = null
    void tick()
  }, 1000)

  return cleanup
}
