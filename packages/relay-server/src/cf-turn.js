import { VALID_TIERS as SHARED_TIERS } from '@allinone/shared'

const DEFAULT_CF_TURN_API_BASE = 'https://rtc.live.cloudflare.com'
const DEFAULT_CF_TURN_TTL_SEC = 3600
const MIN_CF_TURN_TTL_SEC = 300
const MAX_CF_TURN_TTL_SEC = 86400
const FETCH_TIMEOUT_MS = 6000
const RETRY_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000]
const MAX_SCOPED_CREDS = 500
const MAX_SCOPED_FETCH_PER_MIN = 30
const VALID_TIERS = new Set(SHARED_TIERS)

function parseBoolOption(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const lower = String(raw).trim().toLowerCase()
  if (lower === '1' || lower === 'true' || lower === 'yes') return true
  if (lower === '0' || lower === 'false' || lower === 'no') return false
  return fallback
}

export function parseCfTurnTiers(raw) {
  const input = raw === undefined || raw === null || String(raw).trim() === '' ? 'free' : String(raw)
  const out = new Set()
  for (const part of input.split(',')) {
    const t = part.trim().toLowerCase()
    if (VALID_TIERS.has(t)) out.add(t)
  }
  return out
}

function clampTtl(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CF_TURN_TTL_SEC
  return Math.max(MIN_CF_TURN_TTL_SEC, Math.min(MAX_CF_TURN_TTL_SEC, Math.floor(n)))
}

/**
 * Normalize Cloudflare `generate-ice-servers` payload into clean STUN & TURN ICE server lists.
 * Supports both single-object and array `iceServers` shapes returned by Cloudflare Realtime TURN API.
 */
export function normalizeCloudflareIceResponse(data) {
  const rawList = Array.isArray(data?.iceServers)
    ? data.iceServers
    : data?.iceServers && typeof data.iceServers === 'object'
      ? [data.iceServers]
      : []

  const stunServers = []
  const turnServers = []

  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue
    const urls = Array.isArray(entry.urls)
      ? entry.urls.map((u) => String(u || '').trim()).filter(Boolean)
      : entry.urls
        ? [String(entry.urls).trim()].filter(Boolean)
        : []
    if (urls.length === 0) continue

    const stunUrls = urls.filter((u) => /^stuns?:/i.test(u))
    const turnUrls = urls.filter((u) => /^turns?:/i.test(u))

    if (stunUrls.length > 0) {
      stunServers.push({ urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls })
    }
    if (turnUrls.length > 0 && entry.username && entry.credential) {
      turnServers.push({
        urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
        username: String(entry.username),
        credential: String(entry.credential),
      })
    }
  }

  return { stunServers, turnServers }
}

/**
 * Zero-dependency cached credential provider for Cloudflare Realtime TURN (1 TB/month free tier).
 *
 * - Keeps credentials warm in memory via a background timer (~40% of TTL with exponential retry backoff)
 *   so `getIceEntry()` is O(1) synchronous and adds 0ms latency to WebSocket connects and `/api/auth/me`.
 * - Gracefully returns `null` when unconfigured or temporarily unreachable so the relay server
 *   seamlessly falls back to self-hosted `coturn` or STUN without blocking connections.
 */
export function createCloudflareTurnProvider(options = {}, env = process.env) {
  const tokenId = String(options.cfTurnTokenId ?? env.CF_TURN_TOKEN_ID ?? '').trim()
  const apiToken = String(options.cfTurnApiToken ?? env.CF_TURN_API_TOKEN ?? '').trim()
  const rawApiBase = String(options.cfTurnApiBase ?? env.CF_TURN_API_BASE ?? '').trim()
  const apiBase = (rawApiBase || DEFAULT_CF_TURN_API_BASE).replace(/\/+$/, '')
  const rawTtl = options.cfTurnTtlSec ?? (String(env.CF_TURN_TTL_SEC ?? '').trim() || undefined)
  const ttlSec = clampTtl(rawTtl ?? DEFAULT_CF_TURN_TTL_SEC)
  const tiers = parseCfTurnTiers(options.cfTurnTiers ?? env.CF_TURN_TIERS ?? 'free')
  const fallbackSelfHosted = parseBoolOption(
    options.cfTurnFallbackSelfHosted ?? env.CF_TURN_FALLBACK_SELF_HOSTED,
    true,
  )
  const fetchFn = typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch
  const onRecovered = typeof options.onRecovered === 'function' ? options.onRecovered : null
  const log = options.log || console

  const enabled = Boolean(tokenId && apiToken && tiers.size > 0)

  let cached = null // { stunServers, turnServers, fetchedAt, expiresAt }
  let inflight = null
  /** @type {Map<string, { stunServers: any[], turnServers: any[], fetchedAt: number, expiresAt: number }>} */
  const scopedCache = new Map()
  /** @type {Map<string, Promise<any>>} */
  const scopedInflight = new Map()
  const scopedFetchTimestamps = []
  let refreshTimer = null
  let retryTimer = null
  let retryAttempt = 0
  let stopped = false
  let lastError = ''

  function canFetchScoped(now = Date.now()) {
    while (scopedFetchTimestamps.length > 0 && now - scopedFetchTimestamps[0] > 60_000) {
      scopedFetchTimestamps.shift()
    }
    if (scopedFetchTimestamps.length >= MAX_SCOPED_FETCH_PER_MIN) return false
    scopedFetchTimestamps.push(now)
    return true
  }

  async function fetchOneCredential() {
    const url = `${apiBase}/v1/turn/keys/${encodeURIComponent(tokenId)}/credentials/generate-ice-servers`
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null
    timer?.unref?.()
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: ttlSec }),
        ...(controller ? { signal: controller.signal } : {}),
      })
      if (!res.ok) {
        throw new Error(`Cloudflare TURN HTTP ${res.status}`)
      }
      const data = await res.json()
      const normalized = normalizeCloudflareIceResponse(data)
      if (normalized.turnServers.length === 0) {
        throw new Error('Cloudflare TURN returned empty turnServers')
      }
      const now = Date.now()
      return {
        stunServers: normalized.stunServers,
        turnServers: normalized.turnServers,
        fetchedAt: now,
        expiresAt: now + ttlSec * 1000,
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function refreshForScope(scopeKey) {
    const key = String(scopeKey || '').trim()
    if (!key || !enabled || stopped || retryTimer) return null
    if (scopedInflight.has(key)) return scopedInflight.get(key)
    if (!canFetchScoped()) return null
    const p = fetchOneCredential()
      .then((entry) => {
        if (scopedCache.size >= MAX_SCOPED_CREDS) {
          const oldest = scopedCache.keys().next().value
          if (oldest) scopedCache.delete(oldest)
        }
        scopedCache.set(key, entry)
        return entry
      })
      .catch(() => null)
      .finally(() => {
        scopedInflight.delete(key)
      })
    scopedInflight.set(key, p)
    return p
  }

  function clearRetryTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function scheduleRetry() {
    if (!enabled || stopped || retryTimer) return
    const delayMs = RETRY_BACKOFF_MS[Math.min(retryAttempt, RETRY_BACKOFF_MS.length - 1)]
    retryAttempt = Math.min(retryAttempt + 1, RETRY_BACKOFF_MS.length - 1)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void refresh()
    }, delayMs)
    retryTimer.unref?.()
  }

  async function refresh() {
    if (!enabled || stopped) return null
    if (inflight) return inflight

    inflight = (async () => {
      try {
        const entry = await fetchOneCredential()
        const now = entry.fetchedAt
        const wasUnavailable = !cached || now >= cached.expiresAt - 10_000
        const hadPriorFailure = Boolean(lastError || retryAttempt > 0)
        cached = entry
        lastError = ''
        retryAttempt = 0
        clearRetryTimer()
        if (wasUnavailable && hadPriorFailure && onRecovered) {
          try { onRecovered(cached) } catch {}
        }
        return cached
      } catch (err) {
        lastError = String(err?.message || err)
        log.warn?.(`[cf-turn] Failed to refresh Cloudflare TURN credentials: ${lastError}`)
        scheduleRetry()
        return null
      } finally {
        inflight = null
      }
    })()

    return inflight
  }

  function start() {
    if (!enabled || stopped) return
    stopTimer()
    const intervalMs = Math.max(30_000, Math.floor(ttlSec * 0.4 * 1000))
    refreshTimer = setInterval(() => {
      void refresh()
    }, intervalMs)
    refreshTimer.unref?.()
  }

  function stopTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }

  function stop() {
    stopped = true
    stopTimer()
    clearRetryTimer()
  }

  function appliesToTier(tier) {
    if (!enabled) return false
    const norm = String(tier || 'free').trim().toLowerCase()
    return tiers.has(norm)
  }

  /**
   * Synchronously return cached Cloudflare TURN servers if valid (>60s remaining).
   * When `scopeKey` (e.g. `roomId`) is provided, issues isolated per-user credentials
   * asynchronously while returning the warm entry immediately to keep connects at 0ms.
   */
  function getIceEntry(scopeKey = '') {
    if (!enabled) return null
    const now = Date.now()
    const cleanScope = String(scopeKey || '').trim()
    if (cleanScope) {
      const scoped = scopedCache.get(cleanScope)
      if (scoped && now < scoped.expiresAt - 10_000) {
        // Refresh LRU recency
        scopedCache.delete(cleanScope)
        scopedCache.set(cleanScope, scoped)
        if (now >= scoped.fetchedAt + Math.floor(ttlSec * 0.5 * 1000)) {
          void refreshForScope(cleanScope)
        }
        return scoped
      }
      if (scoped) scopedCache.delete(cleanScope)
      // Trigger isolated per-user credential fetch in background if global pool is healthy
      if (cached && now < cached.expiresAt - 10_000) {
        void refreshForScope(cleanScope)
      }
    }
    if (!cached || now >= cached.expiresAt - 60_000) {
      if (!retryTimer) void refresh()
      if (!cached || now >= cached.expiresAt - 10_000) return null
    } else if (now >= cached.fetchedAt + Math.floor(ttlSec * 0.4 * 1000)) {
      if (!retryTimer) void refresh()
    }
    return cached
  }

  /**
   * Pure read-only check of cached Cloudflare TURN readiness (zero outbound HTTP calls).
   * Safe to call in `/api/admin/overview` and quota snapshots for offline users.
   */
  function isReady(scopeKey = '') {
    if (!enabled) return false
    const now = Date.now()
    const cleanScope = String(scopeKey || '').trim()
    if (cleanScope) {
      const scoped = scopedCache.get(cleanScope)
      if (scoped && now < scoped.expiresAt - 10_000) return true
    }
    return Boolean(cached && now < cached.expiresAt - 10_000)
  }

  function getStats() {
    const now = Date.now()
    const ready = Boolean(enabled && cached && now < cached.expiresAt - 10_000)
    return {
      enabled,
      ready,
      tiers: [...tiers],
      ttlSec,
      fallbackSelfHosted,
      scopedCount: scopedCache.size,
      lastRefreshAt: cached?.fetchedAt || 0,
      expiresAt: cached?.expiresAt || 0,
      lastError,
    }
  }

  return {
    enabled,
    tiers,
    ttlSec,
    fallbackSelfHosted,
    appliesToTier,
    isReady,
    refresh,
    start,
    stop,
    getIceEntry,
    getStats,
  }
}
