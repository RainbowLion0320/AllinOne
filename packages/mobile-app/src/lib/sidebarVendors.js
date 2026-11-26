/**
 * Smart vendor filter-bar layout for SidebarDrawer:
 * - Includes vendors that have at least one conversation or are detected as available/writable.
 * - Sorts vendors dynamically by each vendor's most recently active conversation timestamp (descending),
 *   falling back to writable readiness and default vendor order when there is no conversation history yet.
 * - Keeps at most `maxVisible` (default 3) vendor buttons inline; any 4th+ vendors move into `overflowVendors`
 *   behind the "..." More switcher button.
 */

export const MAX_VISIBLE_SIDEBAR_VENDORS = 3

function toValidTimestamp(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function getValidQuota(info) {
  const q = info?.quota
  if (!q || typeof q !== 'object') return null
  if (q.windowKind === 'balance' && typeof q.balanceTotal === 'number' && Number.isFinite(q.balanceTotal)) {
    return q
  }
  if (typeof q.remainingPercent === 'number' && Number.isFinite(q.remainingPercent)) {
    return q
  }
  if (q.windowKind === 'credits' && (q.unlimited || (typeof q.creditsRemaining === 'number' && Number.isFinite(q.creditsRemaining)))) {
    return q
  }
  return null
}

export function formatMoneyExact(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '0.00'
  return n.toFixed(2)
}

export function formatMoneyCompact(value, symbol = '¥') {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return `${symbol}0`
  if (n >= 10_000) return `${symbol}${(n / 1_000).toFixed(0)}k`
  if (n >= 1_000) return `${symbol}${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (n >= 10) return `${symbol}${Math.round(n)}`
  return `${symbol}${n.toFixed(1).replace(/\.0$/, '')}`
}

export function formatCreditsExact(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '0'
  const rounded = Math.round(n * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function formatCreditsCompact(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (n >= 100) return String(Math.round(n))
  return formatCreditsExact(n)
}

export function formatQuotaBadgeText(quota, { compact = true, lang = 'zh', showTotal = false } = {}) {
  if (!quota || typeof quota !== 'object') return ''
  if (quota.windowKind === 'balance') {
    const sym = String(quota.currencySymbol || (quota.currency === 'USD' ? '$' : '¥'))
    const total = Number(quota.balanceTotal)
    if (Number.isFinite(total)) {
      return compact ? formatMoneyCompact(total, sym) : `${sym}${formatMoneyExact(total)}`
    }
  }
  if (quota.windowKind === 'credits') {
    if (quota.unlimited) {
      return compact ? '∞' : (lang === 'en' ? 'Unlimited' : '不限积分')
    }
    const rem = Number(quota.creditsRemaining)
    if (Number.isFinite(rem)) {
      if (compact) return formatCreditsCompact(rem)
      const remStr = formatCreditsExact(rem)
      const total = Number(quota.creditsTotal)
      const unit = lang === 'en' ? (showTotal ? 'credits' : 'cr') : '积分'
      if (showTotal && Number.isFinite(total) && total > 0) {
        return `${remStr} / ${formatCreditsExact(total)} ${unit}`
      }
      return `${remStr} ${unit}`
    }
  }
  if (typeof quota.remainingPercent === 'number' && Number.isFinite(quota.remainingPercent)) {
    const pct = Math.max(0, Math.min(100, Math.round(quota.remainingPercent)))
    return `${pct}%`
  }
  return ''
}

function formatResetShort(ts, lang) {
  if (!ts || !Number.isFinite(ts)) return ''
  try {
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ''
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return lang === 'en' ? `Resets ${mm}/${dd} ${hh}:${mi}` : `${mm}/${dd} ${hh}:${mi} 重置`
  } catch {
    return ''
  }
}

export function formatQuotaTooltip(label, quota, lang = 'zh') {
  if (!quota || typeof quota !== 'object') return label
  const planRaw = String(quota.planType || '').trim()
  const planSuffix = planRaw ? ` (${/^[a-z0-9_-]+$/i.test(planRaw) ? planRaw.toUpperCase() : planRaw})` : ''

  if (quota.windowKind === 'balance') {
    const sym = String(quota.currencySymbol || (quota.currency === 'USD' ? '$' : '¥'))
    const totalStr = `${sym}${formatMoneyExact(quota.balanceTotal)}`
    const parts = [label, lang === 'en' ? `Balance ${totalStr}` : `余额 ${totalStr}`]
    if (Number(quota.balanceToppedUp) > 0) {
      parts.push(
        lang === 'en'
          ? `Top-up ${sym}${formatMoneyExact(quota.balanceToppedUp)}`
          : `充值 ${sym}${formatMoneyExact(quota.balanceToppedUp)}`,
      )
    }
    if (Number(quota.balanceGranted) > 0) {
      parts.push(
        lang === 'en'
          ? `Granted ${sym}${formatMoneyExact(quota.balanceGranted)}`
          : `赠送 ${sym}${formatMoneyExact(quota.balanceGranted)}`,
      )
    }
    return parts.join(' · ')
  }

  if (quota.windowKind === 'credits') {
    const parts = [`${label}${planSuffix}`]
    if (quota.unlimited) {
      parts.push(lang === 'en' ? 'Credits: Unlimited' : '积分余额 不限')
    } else if (typeof quota.creditsRemaining === 'number' && Number.isFinite(quota.creditsRemaining)) {
      const remStr = formatCreditsExact(quota.creditsRemaining)
      const total = Number(quota.creditsTotal)
      const pctStr =
        typeof quota.remainingPercent === 'number' && Number.isFinite(quota.remainingPercent)
          ? ` (${Math.max(0, Math.min(100, Math.round(quota.remainingPercent)))}%)`
          : ''
      if (Number.isFinite(total) && total > 0) {
        parts.push(
          lang === 'en'
            ? `Credits left ${remStr} / ${formatCreditsExact(total)}${pctStr}`
            : `剩余积分 ${remStr} / ${formatCreditsExact(total)}${pctStr}`,
        )
      } else {
        parts.push(lang === 'en' ? `Credits left ${remStr}` : `剩余积分 ${remStr}`)
      }
    }
    if (Array.isArray(quota.creditGroups) && quota.creditGroups.length > 0) {
      const grpParts = quota.creditGroups
        .filter((g) => g?.name && Number.isFinite(Number(g.remaining)))
        .slice(0, 3)
        .map((g) => `${g.name} ${formatCreditsExact(g.remaining)}`)
      if (grpParts.length > 0) parts.push(grpParts.join(' · '))
    }
    const resetStr = formatResetShort(quota.resetsAt, lang)
    if (resetStr) parts.push(resetStr)
    return parts.join(' · ')
  }

  if (typeof quota.remainingPercent !== 'number' || !Number.isFinite(quota.remainingPercent)) return label
  const bucketPrefix = quota.bucketLabel ? `${quota.bucketLabel} ` : ''
  const windowLabel =
    quota.windowKind === 'weekly'
      ? lang === 'en' ? `${bucketPrefix}Weekly left` : `${bucketPrefix}周额度剩余`
      : lang === 'en' ? `${bucketPrefix}Quota left` : `${bucketPrefix}额度剩余`
  const parts = [`${label}${planSuffix}`, `${windowLabel} ${quota.remainingPercent}%`]
  if (quota.shortWindow && typeof quota.shortWindow.remainingPercent === 'number') {
    const hrs = Math.max(1, Math.round((quota.shortWindow.windowMinutes || 300) / 60))
    parts.push(
      lang === 'en'
        ? `${hrs}h left ${quota.shortWindow.remainingPercent}%`
        : `${hrs}h剩余 ${quota.shortWindow.remainingPercent}%`,
    )
  }
  if (Array.isArray(quota.pools) && quota.pools.length > 1) {
    for (const p of quota.pools.slice(1, 3)) {
      if (!p || !Array.isArray(p.windows) || p.windows.length === 0) continue
      const pName = lang === 'en' ? (p.label || p.id) : (p.labelZh || p.label || p.id)
      const wSummary = p.windows
        .filter((w) => typeof w?.remainingPercent === 'number')
        .map((w) => {
          const isWk = w.kind === 'weekly' || Number(w.windowMinutes) >= 1440
          return isWk ? `${lang === 'en' ? '7d' : '周'} ${w.remainingPercent}%` : `${Math.max(1, Math.round((w.windowMinutes || 300) / 60))}h ${w.remainingPercent}%`
        })
        .join(' / ')
      if (wSummary) parts.push(`${pName} ${wSummary}`)
    }
  }
  const resetStr = formatResetShort(quota.resetsAt, lang)
  if (resetStr) parts.push(resetStr)
  return parts.join(' · ')
}

export function computeSidebarVendorLayout({
  vendorTabs = [],
  sessions = [],
  appsStatus = [],
  maxVisible = MAX_VISIBLE_SIDEBAR_VENDORS,
} = {}) {
  const limit = Math.max(1, Number.isFinite(Number(maxVisible)) ? Math.floor(Number(maxVisible)) : MAX_VISIBLE_SIDEBAR_VENDORS)

  const activityByApp = new Map()
  for (const s of sessions || []) {
    const app = s?.app
    if (!app) continue
    let entry = activityByApp.get(app)
    if (!entry) {
      entry = { latestAt: 0, sessionCount: 0, hasRunning: false }
      activityByApp.set(app, entry)
    }
    entry.sessionCount += 1
    const ts = Math.max(toValidTimestamp(s?.updatedAt), toValidTimestamp(s?.createdAt))
    if (ts > entry.latestAt) entry.latestAt = ts
    if (s?.status === 'running') entry.hasRunning = true
  }

  const statusByApp = new Map()
  for (const info of appsStatus || []) {
    if (info?.app) statusByApp.set(info.app, info)
  }

  const eligible = []
  for (let idx = 0; idx < vendorTabs.length; idx += 1) {
    const tab = vendorTabs[idx]
    if (!tab?.id || tab.id === 'all') continue
    const activity = activityByApp.get(tab.id)
    const info = statusByApp.get(tab.id)
    const hasSessions = Boolean(activity && activity.sessionCount > 0)
    const isDetected = Boolean(info?.available || info?.writable)
    if (!hasSessions && !isDetected) continue

    eligible.push({
      ...tab,
      latestAt: activity?.latestAt || 0,
      sessionCount: activity?.sessionCount || 0,
      hasRunning: Boolean(activity?.hasRunning),
      writable: Boolean(info?.writable),
      quota: getValidQuota(info),
      defaultIndex: idx,
    })
  }

  eligible.sort((a, b) => {
    if (b.latestAt !== a.latestAt) return b.latestAt - a.latestAt
    if (a.writable !== b.writable) return a.writable ? -1 : 1
    return a.defaultIndex - b.defaultIndex
  })

  if (eligible.length === 0) {
    return {
      showBar: false,
      visibleVendors: [],
      overflowVendors: [],
      soleQuotaTab: null,
    }
  }

  if (eligible.length === 1) {
    const sole = eligible[0]
    return {
      showBar: false,
      visibleVendors: [],
      overflowVendors: [],
      soleQuotaTab: sole.quota ? { tab: sole, quota: sole.quota } : null,
    }
  }

  if (eligible.length <= limit) {
    return {
      showBar: true,
      visibleVendors: eligible,
      overflowVendors: [],
      soleQuotaTab: null,
    }
  }

  return {
    showBar: true,
    visibleVendors: eligible.slice(0, limit),
    overflowVendors: eligible.slice(limit),
    soleQuotaTab: null,
  }
}
