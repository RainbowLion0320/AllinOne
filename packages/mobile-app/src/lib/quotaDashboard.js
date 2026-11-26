import { formatCreditsExact, formatMoneyExact } from './sidebarVendors.js'

function toValidTimestamp(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function getQuotaHealthLevel(percent) {
  const pct = Number(percent)
  if (!Number.isFinite(pct)) return 'healthy'
  if (pct < 20) return 'critical'
  if (pct < 50) return 'warning'
  return 'healthy'
}

export function formatPlanTierLabel(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^[a-z0-9_-]+$/i.test(s)) {
    const lower = s.toLowerCase()
    if (lower === 'pro') return 'Pro'
    if (lower === 'plus') return 'Plus'
    if (lower === 'team') return 'Team'
    if (lower === 'ultra') return 'Ultra'
    if (lower === 'free') return 'Free'
    if (lower === 'max') return 'Max'
    if (lower === 'enterprise') return 'Enterprise'
    return s.toUpperCase()
  }
  return s
}

export function formatNumberWithCommas(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10
  try {
    return rounded.toLocaleString('en-US', {
      maximumFractionDigits: Number.isInteger(rounded) ? 0 : 1,
    })
  } catch {
    return String(rounded)
  }
}

export function formatQuotaResetCountdown(resetsAt, { lang = 'zh', now = Date.now(), compact = false } = {}) {
  const ts = Number(resetsAt)
  if (!Number.isFinite(ts) || ts <= 86_400_000) return ''
  const diffMs = ts - now
  if (diffMs <= 60_000) {
    return lang === 'en' ? 'Resets soon' : '即将重置'
  }
  const totalMins = Math.ceil(diffMs / 60_000)
  if (totalMins < 60) {
    return lang === 'en' ? `Resets in ${totalMins}m` : `${totalMins}分后重置`
  }
  const totalHours = Math.floor(totalMins / 60)
  const remMins = totalMins % 60
  if (totalHours < 24) {
    if (lang === 'en') {
      return remMins > 0 ? `Resets in ${totalHours}h ${remMins}m` : `Resets in ${totalHours}h`
    }
    return remMins > 0 ? `${totalHours}小时${remMins}分后重置` : `${totalHours}小时后重置`
  }
  const days = Math.floor(totalHours / 24)
  const remHours = totalHours % 24
  let absPart = ''
  if (!compact) {
    try {
      const d = new Date(ts)
      if (!Number.isNaN(d.getTime())) {
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const dd = String(d.getDate()).padStart(2, '0')
        const hh = String(d.getHours()).padStart(2, '0')
        const mi = String(d.getMinutes()).padStart(2, '0')
        absPart = ` · ${mm}/${dd} ${hh}:${mi}`
      }
    } catch {}
  }
  if (lang === 'en') {
    const rel = remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
    return `Resets in ${rel}${absPart}`
  }
  const rel = remHours > 0 ? `${days}天${remHours}小时` : `${days}天`
  return `${rel}后重置${absPart}`
}

export function isValidQuotaObject(quota, now = Date.now()) {
  if (!quota || typeof quota !== 'object') return false
  if (quota.windowKind === 'balance') {
    return typeof quota.balanceTotal === 'number' && Number.isFinite(quota.balanceTotal)
  }
  if (quota.windowKind === 'credits') {
    return Boolean(
      quota.unlimited ||
        (typeof quota.creditsRemaining === 'number' && Number.isFinite(quota.creditsRemaining)),
    )
  }
  if (typeof quota.remainingPercent === 'number' && Number.isFinite(quota.remainingPercent)) {
    if (quota.resetsAt > 86_400_000 && now > quota.resetsAt + 60_000) {
      const sw = quota.shortWindow
      if (sw && typeof sw.remainingPercent === 'number' && (!sw.resetsAt || now <= sw.resetsAt + 60_000)) {
        return true
      }
      if (Array.isArray(quota.pools) && quota.pools.length > 0) {
        return true
      }
      return false
    }
    return true
  }
  return false
}

function buildNormalizedWindow(w, { lang = 'zh', now = Date.now() } = {}) {
  if (!w || typeof w !== 'object') return null
  if (typeof w.remainingPercent !== 'number' || !Number.isFinite(w.remainingPercent)) return null
  const resetsAt = toValidTimestamp(w.resetsAt) > 86_400_000 ? toValidTimestamp(w.resetsAt) : 0
  if (resetsAt > 0 && now > resetsAt + 60_000) return null
  const pct = Math.max(0, Math.min(100, Math.round(w.remainingPercent)))
  const isWeekly = w.kind === 'weekly' || Number(w.windowMinutes) >= 1440
  const mins = Number(w.windowMinutes) || (isWeekly ? 10080 : 300)
  let label
  if (isWeekly) {
    const days = Math.max(1, Math.round(mins / 1440))
    label =
      days === 7
        ? lang === 'en' ? '7-Day Weekly' : '7天周额度'
        : lang === 'en' ? `${days}-Day Window` : `${days}天周期额度`
  } else {
    const hrs = Math.max(1, Math.round(mins / 60))
    label = lang === 'en' ? `${hrs}-Hour Window` : `${hrs}小时额度`
  }
  return {
    id: w.id || (isWeekly ? 'weekly' : 'short'),
    kind: isWeekly ? 'weekly' : 'short',
    windowMinutes: mins,
    label,
    remainingPercent: pct,
    usedPercent: 100 - pct,
    health: getQuotaHealthLevel(pct),
    resetsAt,
    resetText: formatQuotaResetCountdown(resetsAt, { lang, now, compact: !isWeekly }),
  }
}

/**
 * Normalize any vendor's `info.quota` into structured display rows for HomeQuotaDashboard.
 * Supports:
 *  - Multi-pool windows (e.g. Antigravity `Gemini 模型` + `Claude / GPT 模型`, each with 5h + 7d bars)
 *  - Dual / single rolling windows (Codex / Claude 5h + 7d) + Codex extra credits & free reset vouchers
 *  - Credits-based quotas (WorkBuddy total + structured sub-package groups)
 */
export function extractVendorQuotaDetails(quota, { lang = 'zh', now = Date.now() } = {}) {
  if (!isValidQuotaObject(quota, now)) return null

  const planLabel = formatPlanTierLabel(quota.planType)
  const bucketLabel = String(quota.bucketLabel || '').trim()

  if (quota.windowKind === 'balance') {
    const currency = String(quota.currency || 'CNY').trim().toUpperCase() || 'CNY'
    const symbol = String(quota.currencySymbol || (currency === 'USD' ? '$' : '¥'))
    const total = Math.max(0, Number(quota.balanceTotal) || 0)
    const toppedUp = Math.max(0, Number(quota.balanceToppedUp) || 0)
    const granted = Math.max(0, Number(quota.balanceGranted) || 0)
    const isAvailable = quota.isAvailable !== false && total > 0
    const lowThreshold = currency === 'USD' ? 2 : 10
    const health = !isAvailable ? 'critical' : total < lowThreshold ? 'warning' : 'healthy'
    const extraBalances = Array.isArray(quota.balances)
      ? quota.balances
          .filter((b) => b && b.currency && b.currency !== currency && Number(b.total) > 0)
          .map((b) => ({
            currency: String(b.currency),
            symbol: String(b.symbol || ''),
            totalText: `${String(b.symbol || '')}${formatMoneyExact(b.total)}`,
          }))
      : []

    return {
      kind: 'balance',
      isAvailable,
      currency,
      symbol,
      total,
      totalText: `${symbol}${formatMoneyExact(total)}`,
      toppedUp,
      toppedUpText: `${symbol}${formatMoneyExact(toppedUp)}`,
      granted,
      grantedText: `${symbol}${formatMoneyExact(granted)}`,
      extraBalances,
      health,
      planLabel: currency,
      bucketLabel: '',
      updatedAt: toValidTimestamp(quota.updatedAt),
    }
  }

  if (quota.windowKind === 'credits') {
    const unlimited = Boolean(quota.unlimited)
    const remaining = Number(quota.creditsRemaining)
    const total = Number(quota.creditsTotal)
    const used = Number(quota.creditsUsed)
    const remainingPercent = unlimited
      ? 100
      : typeof quota.remainingPercent === 'number' && Number.isFinite(quota.remainingPercent)
        ? Math.max(0, Math.min(100, Math.round(quota.remainingPercent)))
        : Number.isFinite(total) && total > 0 && Number.isFinite(remaining)
          ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
          : remaining > 0
            ? 100
            : 0

    const groups = Array.isArray(quota.creditGroups)
      ? quota.creditGroups
          .filter((g) => g && g.name && Number.isFinite(Number(g.remaining)))
          .slice(0, 4)
          .map((g) => {
            const gRem = Math.max(0, Number(g.remaining))
            const gTot = Number.isFinite(Number(g.total)) && Number(g.total) > 0 ? Number(g.total) : 0
            const gPct = gTot > 0 ? Math.max(0, Math.min(100, Math.round((gRem / gTot) * 100))) : gRem > 0 ? 100 : 0
            return {
              kind: String(g.kind || ''),
              name: String(g.name),
              remaining: gRem,
              remainingText: formatCreditsExact(gRem),
              total: gTot,
              totalText: gTot > 0 ? formatCreditsExact(gTot) : '',
              percent: gPct,
              health: getQuotaHealthLevel(gPct),
            }
          })
      : []

    return {
      kind: 'credits',
      unlimited,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      remainingText: unlimited ? '∞' : formatCreditsExact(remaining),
      total: Number.isFinite(total) && total > 0 ? total : 0,
      totalText: Number.isFinite(total) && total > 0 ? formatCreditsExact(total) : '',
      used: Number.isFinite(used) && used >= 0 ? used : 0,
      usedText: Number.isFinite(used) && used >= 0 ? formatCreditsExact(used) : '',
      remainingPercent,
      health: unlimited ? 'healthy' : getQuotaHealthLevel(remainingPercent),
      planLabel,
      bucketLabel,
      resetText: formatQuotaResetCountdown(quota.resetsAt, { lang, now }),
      groups,
      updatedAt: toValidTimestamp(quota.updatedAt),
    }
  }

  // Optional Codex extra credits & free reset vouchers
  let extraCredits = null
  if (quota.extraCredits && typeof quota.extraCredits === 'object') {
    if (quota.extraCredits.unlimited) {
      extraCredits = {
        unlimited: true,
        balanceText: lang === 'en' ? 'Unlimited' : '不限',
      }
    } else if (typeof quota.extraCredits.balance === 'number' && Number.isFinite(quota.extraCredits.balance) && quota.extraCredits.balance > 0) {
      extraCredits = {
        unlimited: false,
        balance: quota.extraCredits.balance,
        balanceText: formatNumberWithCommas(quota.extraCredits.balance),
      }
    }
  }

  let resetCredits = null
  if (quota.resetCredits && Number(quota.resetCredits.availableCount) > 0) {
    const expTs = toValidTimestamp(quota.resetCredits.nextExpiresAt)
    let expiryText = ''
    if (expTs > now) {
      try {
        const d = new Date(expTs)
        if (!Number.isNaN(d.getTime())) {
          const mm = String(d.getMonth() + 1).padStart(2, '0')
          const dd = String(d.getDate()).padStart(2, '0')
          expiryText = lang === 'en' ? `Valid until ${mm}/${dd}` : `有效期至 ${mm}/${dd}`
        }
      } catch {}
    }
    resetCredits = {
      availableCount: Number(quota.resetCredits.availableCount),
      expiryText,
    }
  }

  // Multi-pool mode (e.g. Antigravity Gemini + Claude/GPT, or Codex multi-limit pools)
  const pools = []
  if (Array.isArray(quota.pools) && quota.pools.length > 0) {
    for (const rawPool of quota.pools) {
      if (!rawPool || !Array.isArray(rawPool.windows)) continue
      const normWins = rawPool.windows
        .map((w) => buildNormalizedWindow(w, { lang, now }))
        .filter(Boolean)
      if (normWins.length === 0) continue
      // Always place short (5h) window before weekly window inside every pool
      normWins.sort((a, b) => (a.kind === 'short' ? 0 : 1) - (b.kind === 'short' ? 0 : 1))
      const poolId = String(rawPool.id || pools.length)
      const label = lang === 'en' ? String(rawPool.label || poolId) : String(rawPool.labelZh || rawPool.label || poolId)
      const badge =
        poolId === '3p'
          ? lang === 'en' ? 'Included' : '含赠送'
          : ''
      pools.push({
        id: poolId,
        label,
        badge,
        windows: normWins,
      })
    }
  }

  // Fallback single-pool extraction when `quota.pools` is absent
  const flatWindows = []
  if (pools.length === 0) {
    if (quota.shortWindow && typeof quota.shortWindow.remainingPercent === 'number') {
      const sw = buildNormalizedWindow(
        {
          id: 'short',
          kind: 'short',
          windowMinutes: quota.shortWindow.windowMinutes || 300,
          remainingPercent: quota.shortWindow.remainingPercent,
          resetsAt: quota.shortWindow.resetsAt || 0,
        },
        { lang, now },
      )
      if (sw) flatWindows.push(sw)
    }
    const primaryIsWeekly = quota.windowKind === 'weekly' || Number(quota.windowMinutes) >= 1440
    const primaryWin = buildNormalizedWindow(
      {
        id: primaryIsWeekly ? 'weekly' : 'short',
        kind: primaryIsWeekly ? 'weekly' : 'short',
        windowMinutes: quota.windowMinutes || (primaryIsWeekly ? 10080 : 300),
        remainingPercent: quota.remainingPercent,
        resetsAt: quota.resetsAt || 0,
      },
      { lang, now },
    )
    if (primaryWin) flatWindows.push(primaryWin)
  }

  const allWindows = pools.length > 0 ? pools.flatMap((p) => p.windows) : flatWindows
  if (allWindows.length === 0) return null

  return {
    kind: 'windows',
    planLabel,
    bucketLabel: pools.length > 1 ? '' : bucketLabel,
    pools,
    windows: pools.length > 0 ? pools[0].windows : flatWindows,
    hasMultiPool: pools.length > 1,
    hasShortWindow: allWindows.some((w) => w.kind === 'short'),
    extraCredits,
    resetCredits,
    updatedAt: toValidTimestamp(quota.updatedAt),
  }
}

/**
 * Build sorted vendor cards for the Home Quota Dashboard.
 * Detected vendors with live quota metrics appear first (ordered by recent chat activity),
 * followed by detected vendors without subscription quotas (e.g. DeepSeek Harness).
 */
export function buildHomeQuotaCards({
  appsStatus = [],
  sessions = [],
  appList = [],
  lang = 'zh',
  now = Date.now(),
} = {}) {
  const activityByApp = new Map()
  for (const s of sessions || []) {
    const app = s?.app
    if (!app) continue
    let entry = activityByApp.get(app)
    if (!entry) {
      entry = { latestAt: 0, sessionCount: 0, runningCount: 0 }
      activityByApp.set(app, entry)
    }
    entry.sessionCount += 1
    if (s?.status === 'running') entry.runningCount += 1
    const ts = Math.max(toValidTimestamp(s?.updatedAt), toValidTimestamp(s?.createdAt))
    if (ts > entry.latestAt) entry.latestAt = ts
  }

  const statusByApp = new Map()
  for (const info of appsStatus || []) {
    if (info?.app) statusByApp.set(info.app, info)
  }

  const cards = []
  for (let idx = 0; idx < appList.length; idx += 1) {
    const app = appList[idx]
    const info = statusByApp.get(app)
    const activity = activityByApp.get(app)
    const detected = Boolean(info?.available || info?.writable)
    if (!detected) continue

    const quotaDetails = extractVendorQuotaDetails(info?.quota, { lang, now })
    cards.push({
      app,
      info,
      available: Boolean(info?.available),
      writable: Boolean(info?.writable),
      mode: String(info?.mode || ''),
      setupState: String(info?.setupState || ''),
      quotaDetails,
      hasQuota: Boolean(quotaDetails),
      sessionCount: activity?.sessionCount || 0,
      runningCount: Math.max(Number(info?.activeCount) || 0, activity?.runningCount || 0),
      latestAt: activity?.latestAt || 0,
      defaultIndex: idx,
    })
  }

  const sortGroup = (a, b) => {
    if (b.latestAt !== a.latestAt) return b.latestAt - a.latestAt
    if (a.writable !== b.writable) return a.writable ? -1 : 1
    return a.defaultIndex - b.defaultIndex
  }

  const quotaCards = cards.filter((c) => c.hasQuota).sort(sortGroup)
  const otherCards = cards.filter((c) => !c.hasQuota).sort(sortGroup)

  return {
    quotaCards,
    otherCards,
    allCards: [...quotaCards, ...otherCards],
  }
}
