import { createHash, randomBytes } from 'node:crypto'

const HANDSHAKE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_PENDING_HANDSHAKES = 1000
const GITHUB_FETCH_TIMEOUT_MS = 10_000

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Zero-dependency GitHub OAuth 2.0 manager designed for multi-platform clients:
 *  - Web / Mobile Browser / iOS PWA (popup OR same-tab redirect with sessionStorage)
 *  - Electron Desktop App (system browser via shell.openExternal + poll)
 *  - Android Capacitor APK (system browser + poll — works over OTA without native changes)
 *
 * Security invariants:
 *  - `state` (256-bit) is strictly single-use and bound to server-side handshake metadata.
 *  - `pollToken` (256-bit) is returned ONLY to the initiating client over HTTPS JSON, stored
 *    server-side exclusively as its SHA-256 hash, never appears in URLs, and is single-use.
 *  - Completed `bind` handshakes verify caller `userId` matches the initiating account.
 *  - Callback HTML contains ZERO inline scripts (strict CSP compliant).
 */
export function createGithubOAuthManager({
  clientId = '',
  clientSecret = '',
  redirectUri = '',
  oauthBaseUrl = 'https://github.com',
  apiBaseUrl = 'https://api.github.com',
  publicRelayUrl = '',
  ttlMs = HANDSHAKE_TTL_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const cleanClientId = String(clientId || '').trim()
  const cleanClientSecret = String(clientSecret || '').trim()
  const cleanRedirectUri = String(redirectUri || '').trim()
  const cleanOauthBase = String(oauthBaseUrl || 'https://github.com').trim().replace(/\/+$/, '')
  const cleanApiBase = String(apiBaseUrl || 'https://api.github.com').trim().replace(/\/+$/, '')
  const cleanPublicRelayUrl = String(publicRelayUrl || '').trim().replace(/\/+$/, '')
  const effectiveTtlMs = Math.max(30_000, Number(ttlMs) || HANDSHAKE_TTL_MS)

  /** @type {Map<string, any>} state -> entry */
  const byState = new Map()
  /** @type {Map<string, any>} pollHash -> entry */
  const byPollHash = new Map()

  function isConfigured() {
    return Boolean(cleanClientId && cleanClientSecret)
  }

  function resolveCallbackUri(fallbackOrigin = '') {
    if (cleanRedirectUri) return cleanRedirectUri
    if (cleanPublicRelayUrl) return `${cleanPublicRelayUrl}/api/auth/github/callback`
    const cleanOrigin = String(fallbackOrigin || '').trim().replace(/\/+$/, '')
    return cleanOrigin ? `${cleanOrigin}/api/auth/github/callback` : ''
  }

  function pruneExpired(now = Date.now()) {
    for (const [state, entry] of byState.entries()) {
      if (now > entry.expiresAt) {
        byState.delete(state)
        byPollHash.delete(entry.pollHash)
      }
    }
    for (const [pollHash, entry] of byPollHash.entries()) {
      if (now > entry.expiresAt) {
        byPollHash.delete(pollHash)
        byState.delete(entry.state)
      }
    }
    while (byPollHash.size >= MAX_PENDING_HANDSHAKES) {
      const oldestKey = byPollHash.keys().next().value
      if (!oldestKey) break
      const victim = byPollHash.get(oldestKey)
      byPollHash.delete(oldestKey)
      if (victim?.state) byState.delete(victim.state)
    }
  }

  function createHandshake({
    mode = 'login',
    bindUserId = '',
    deviceName = '',
    clientKind = '',
    clientUid = '',
    bootstrapToken = '',
    ip = '',
    fallbackOrigin = '',
    returnUrl = '',
  } = {}) {
    if (!isConfigured()) {
      return { ok: false, statusCode: 503, error: '服务器尚未配置 GitHub 登录（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）' }
    }
    const callbackUri = resolveCallbackUri(fallbackOrigin)
    if (!callbackUri) {
      return { ok: false, statusCode: 500, error: '无法确定 GitHub OAuth 回调地址，请在服务端配置 PUBLIC_RELAY_URL 或 GITHUB_REDIRECT_URI' }
    }
    const now = Date.now()
    pruneExpired(now)

    const cleanMode = mode === 'bind' ? 'bind' : 'login'
    const state = randomBytes(32).toString('base64url')
    const pollToken = `ghp_${randomBytes(32).toString('base64url')}`
    const pollHash = sha256Hex(pollToken)

    const entry = {
      state,
      pollHash,
      mode: cleanMode,
      bindUserId: cleanMode === 'bind' ? String(bindUserId || '').trim() : '',
      deviceName: String(deviceName || '').trim().slice(0, 64),
      clientKind: String(clientKind || '').trim().slice(0, 16),
      clientUid: String(clientUid || '').trim().slice(0, 64),
      bootstrapToken: String(bootstrapToken || '').trim().slice(0, 256),
      ip: String(ip || '').trim().slice(0, 64),
      callbackUri,
      returnUrl: String(returnUrl || '').trim(),
      status: 'pending', // 'pending' | 'exchanging' | 'completed' | 'failed'
      result: null,
      error: '',
      errorCode: '',
      createdAt: now,
      expiresAt: now + effectiveTtlMs,
    }
    byState.set(state, entry)
    byPollHash.set(pollHash, entry)

    const authUrl = new URL(`${cleanOauthBase}/login/oauth/authorize`)
    authUrl.searchParams.set('client_id', cleanClientId)
    authUrl.searchParams.set('redirect_uri', callbackUri)
    authUrl.searchParams.set('scope', 'read:user user:email')
    authUrl.searchParams.set('state', state)

    return {
      ok: true,
      authorizeUrl: authUrl.toString(),
      pollToken,
      expiresInSec: Math.floor(effectiveTtlMs / 1000),
    }
  }

  /**
   * Atomically claim `state` on callback so duplicate callback replays are rejected.
   */
  function claimState(state) {
    const clean = String(state || '').trim()
    if (!clean) return null
    pruneExpired()
    const entry = byState.get(clean)
    if (!entry) return null
    byState.delete(clean)
    if (Date.now() > entry.expiresAt || entry.status !== 'pending') {
      return null
    }
    entry.status = 'exchanging'
    return entry
  }

  function completeHandshake(entry, result) {
    if (!entry) return
    entry.status = 'completed'
    entry.result = result
    entry.error = ''
    entry.errorCode = ''
    // Keep completed result claimable for up to 3 minutes (capped by original expiry)
    entry.expiresAt = Math.min(entry.expiresAt, Date.now() + 3 * 60 * 1000)
  }

  function failHandshake(entry, errorMessage, errorCode = '') {
    if (!entry) return
    entry.status = 'failed'
    entry.result = null
    entry.error = String(errorMessage || 'GitHub 授权失败')
    entry.errorCode = String(errorCode || '')
    entry.expiresAt = Math.min(entry.expiresAt, Date.now() + 3 * 60 * 1000)
  }

  function pollHandshake(pollToken, { bindUserId = '' } = {}) {
    const clean = String(pollToken || '').trim()
    if (!clean || !clean.startsWith('ghp_')) {
      return { ok: false, statusCode: 400, status: 'invalid', error: '授权会话无效或已过期，请重新发起 GitHub 登录' }
    }
    const now = Date.now()
    pruneExpired(now)
    const hash = sha256Hex(clean)
    const entry = byPollHash.get(hash)
    if (!entry || now > entry.expiresAt) {
      byPollHash.delete(hash)
      return { ok: false, statusCode: 410, status: 'expired', error: 'GitHub 授权已超时，请重新发起' }
    }
    if (entry.mode === 'bind') {
      if (!bindUserId || entry.bindUserId !== bindUserId) {
        return { ok: false, statusCode: 403, status: 'forbidden', error: '绑定会话与当前账号不匹配' }
      }
    }
    if (entry.status === 'pending' || entry.status === 'exchanging') {
      return { ok: true, status: 'pending' }
    }
    // Single-use consumption on terminal state
    byPollHash.delete(hash)
    byState.delete(entry.state)
    if (entry.status === 'failed') {
      return {
        ok: false,
        statusCode: 200,
        status: 'failed',
        ...(entry.errorCode ? { code: entry.errorCode } : {}),
        error: entry.error || 'GitHub 授权失败',
      }
    }
    return {
      ok: true,
      status: 'completed',
      mode: entry.mode,
      ...(entry.result || {}),
    }
  }

  async function exchangeCodeForToken(code, callbackUri) {
    const cleanCode = String(code || '').trim()
    if (!cleanCode) {
      throw new Error('缺少 GitHub 授权码 (code)')
    }
    const res = await fetchImpl(`${cleanOauthBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'AllinOne-Relay',
      },
      body: JSON.stringify({
        client_id: cleanClientId,
        client_secret: cleanClientSecret,
        code: cleanCode,
        ...(callbackUri ? { redirect_uri: callbackUri } : {}),
      }),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error || !data.access_token) {
      const desc = data.error_description || data.error || `HTTP ${res.status}`
      throw new Error(`换取 GitHub 访问令牌失败：${desc}`)
    }
    return String(data.access_token)
  }

  async function fetchGithubProfile(accessToken) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'AllinOne-Relay',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    const userRes = await fetchImpl(`${cleanApiBase}/user`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    })
    const userData = await userRes.json().catch(() => ({}))
    if (!userRes.ok || !userData?.id || !userData?.login) {
      throw new Error(`读取 GitHub 用户信息失败 (HTTP ${userRes.status})`)
    }
    const githubId = String(userData.id).trim()
    const githubLogin = String(userData.login).trim().slice(0, 39)
    if (!/^\d{1,24}$/.test(githubId)) {
      throw new Error('GitHub 返回的用户标识格式无效')
    }

    let email = ''
    let emailVerified = false
    try {
      const emailsRes = await fetchImpl(`${cleanApiBase}/user/emails`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      })
      if (emailsRes.ok) {
        const list = await emailsRes.json().catch(() => [])
        if (Array.isArray(list)) {
          const verifiedList = list.filter(
            (e) =>
              e &&
              e.verified === true &&
              typeof e.email === 'string' &&
              e.email.includes('@') &&
              !/users\.noreply\.github\.com$/i.test(e.email.trim()),
          )
          const preferred = verifiedList.find((e) => e.primary === true) || verifiedList[0] || null
          if (preferred) {
            email = preferred.email.trim()
            emailVerified = true
          }
        }
      }
    } catch {
      // Email fetch is best-effort; login still succeeds cleanly without it
    }

    return { githubId, githubLogin, email, emailVerified }
  }

  function renderCallbackHtml({ ok, mode = 'login', username = '', githubLogin = '', error = '' } = {}) {
    const title = ok
      ? mode === 'bind'
        ? 'GitHub 绑定成功 · All in One'
        : 'GitHub 登录成功 · All in One'
      : 'GitHub 授权失败 · All in One'
    const heading = ok
      ? mode === 'bind'
        ? 'GitHub 绑定成功'
        : 'GitHub 登录成功'
      : 'GitHub 授权未完成'
    const subline = ok
      ? mode === 'bind'
        ? `已成功绑定 GitHub 账号 @${escapeHtml(githubLogin)}，请返回 All in One 客户端，此页面可安全关闭。`
        : `欢迎 @${escapeHtml(username || githubLogin)}！All in One 客户端将自动完成登录，此页面可安全关闭。`
      : escapeHtml(error || '授权已取消或已过期，请返回 All in One 重试。')
    const badgeColor = ok ? '#10B981' : '#F43F5E'
    const badgeSymbol = ok ? '✓' : '✕'

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #0f1117;
      color: #f8fafc;
    }
    @media (prefers-color-scheme: light) {
      body { background: #f5f8ff; color: #0f172a; }
      .card { background: #ffffff; border-color: #e2e8f0; box-shadow: 0 12px 32px rgba(15,23,42,0.08); }
      .desc { color: #475569; }
      .foot { color: #94a3b8; }
    }
    .card {
      width: 100%;
      max-width: 400px;
      border-radius: 24px;
      border: 1px solid #262a36;
      background: #1b1e27;
      padding: 32px 24px;
      text-align: center;
    }
    .badge {
      width: 56px;
      height: 56px;
      margin: 0 auto 16px;
      border-radius: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 26px;
      font-weight: 700;
      color: #fff;
      background: ${badgeColor};
    }
    h1 { margin: 0 0 10px; font-size: 19px; font-weight: 700; }
    .desc { margin: 0; font-size: 13.5px; line-height: 1.6; color: #cbd5e1; word-break: break-word; }
    .foot { margin-top: 20px; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <main class="card">
    <div class="badge" aria-hidden="true">${badgeSymbol}</div>
    <h1>${escapeHtml(heading)}</h1>
    <p class="desc">${subline}</p>
    <p class="foot">All in One · End-to-End Encrypted Remote Control</p>
  </main>
</body>
</html>`
  }

  return {
    isConfigured,
    resolveCallbackUri,
    createHandshake,
    claimState,
    completeHandshake,
    failHandshake,
    pollHandshake,
    exchangeCodeForToken,
    fetchGithubProfile,
    renderCallbackHtml,
  }
}
