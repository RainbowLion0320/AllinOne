import { formatCreditsExact } from './sidebarVendors.js'

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

export function formatQuotaResetCountdown(resetsAt, { lang = 'zh', now = Date.now(), compact = false } = {}) {
  const ts = Number(resetsAt)
  if (!Number.isFinite(ts) || ts <= 0) return ''
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
  if (quota.windowKind === 'credits') {
    return Boolean(
      quota.unlimited ||
        (typeof quota.creditsRemaining === 'number' && Number.isFinite(quota.creditsRemaining)),
    )
  }
  if (typeof quota.remainingPercent === 'number' && Number.isFinite(quota.remainingPercent)) {
    if (quota.resetsAt > 0 && now > quota.resetsAt + 60_000) {
      // Allow fallback if a non-expired shortWindow still exists
      const sw = quota.shortWindow
      if (sw && typeof sw.remainingPercent === 'number' && (!sw.resetsAt || now <= sw.resetsAt + 60_000)) {
        return true
      }
      return false
    }
    return true
  }
  return false
}

/**
 * Normalize any vendor's `info.quota` into structured display rows for HomeQuotaDashboard.
 * Always places short rolling windows (e.g. 5-hour quota) first when present, followed by
 * the 7-day weekly window, or renders a rich Credits breakdown for credit-based vendors.
 */
export function extractVendorQuotaDetails(quota, { lang = 'zh', now = Date.now() } = {}) {
  if (!isValidQuotaObject(quota, now)) return null

  const planLabel = formatPlanTierLabel(quota.planType)
  const bucketLabel = String(quota.bucketLabel || '').trim()

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
          .map((g) => ({
            kind: String(g.kind || ''),
            name: String(g.name),
            remaining: Number(g.remaining),
            remainingText: formatCreditsExact(g.remaining),
            total: Number.isFinite(Number(g.total)) ? Number(g.total) : 0,
            totalText: Number.isFinite(Number(g.total)) && Number(g.total) > 0 ? formatCreditsExact(g.total) : '',
          }))
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

  const windows = []
  const pushWindow = ({ id, kind, windowMinutes, remainingPercent, resetsAt }) => {
    if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent)) return
    if (resetsAt > 0 && now > resetsAt + 60_000) return
    const pct = Math.max(0, Math.min(100, Math.round(remainingPercent)))
    const mins = Number(windowMinutes) || (kind === 'weekly' ? 10080 : 300)
    let label
    if (kind === 'weekly' || mins >= 1440) {
      const days = Math.max(1, Math.round(mins / 1440))
      if (days === 7) {
        label = lang === 'en' ? '7-Day Weekly' : '7天周额度'
      } else {
        label = lang === 'en' ? `${days}-Day Window` : `${days}天周期额度`
      }
    } else {
      const hrs = Math.max(1, Math.round(mins / 60))
      label = lang === 'en' ? `${hrs}-Hour Window` : `${hrs}小时额度`
    }
    windows.push({
      id,
      kind: kind === 'weekly' || mins >= 1440 ? 'weekly' : 'short',
      windowMinutes: mins,
      label,
      remainingPercent: pct,
      usedPercent: 100 - pct,
      health: getQuotaHealthLevel(pct),
      resetsAt: toValidTimestamp(resetsAt),
      resetText: formatQuotaResetCountdown(resetsAt, { lang, now, compact: kind !== 'weekly' }),
    })
  }

  const sw = quota.shortWindow
  if (sw && typeof sw.remainingPercent === 'number') {
    pushWindow({
      id: 'short',
      kind: 'short',
      windowMinutes: sw.windowMinutes || 300,
      remainingPercent: sw.remainingPercent,
      resetsAt: sw.resetsAt || 0,
    })
  }

  const primaryIsWeekly = quota.windowKind === 'weekly' || Number(quota.windowMinutes) >= 1440
  pushWindow({
    id: primaryIsWeekly ? 'weekly' : 'short',
    kind: primaryIsWeekly ? 'weekly' : 'short',
    windowMinutes: quota.windowMinutes || (primaryIsWeekly ? 10080 : 300),
    remainingPercent: quota.remainingPercent,
    resetsAt: quota.resetsAt || 0,
  })

  if (windows.length === 0) return null

  return {
    kind: 'windows',
    planLabel,
    bucketLabel,
    windows,
    hasShortWindow: windows.some((w) => w.kind === 'short'),
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
