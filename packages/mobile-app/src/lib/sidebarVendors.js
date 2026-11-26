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
  if (
    info?.quota &&
    typeof info.quota.remainingPercent === 'number' &&
    Number.isFinite(info.quota.remainingPercent)
  ) {
    return info.quota
  }
  return null
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
