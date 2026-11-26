import React, { useEffect, useMemo, useRef, useState } from 'react'
import { APP_META } from '@allinone/shared'
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Folder,
  FolderOpen,
  Monitor,
  Plus,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  Settings,
  SquarePen,
  User,
  X,
} from 'lucide-react'
import { VendorBadge, VendorIcon } from './VendorIcon.jsx'
import { useI18n } from '../lib/i18n.jsx'
import { bi as biLang, translate } from '../lib/i18n.js'

function getFilterTabs(lang) {
  return [
    { id: 'all', label: translate(lang, 'common.all'), color: '#4D6BFE' },
    { id: 'dsh', label: 'DeepSeek', color: '#4D6BFE' },
    { id: 'codex', label: 'Codex', color: '#10A37F' },
    { id: 'claude', label: 'Claude', color: '#D97757' },
    { id: 'antigravity', label: 'Antigravity', color: '#7C5CFF' },
  ]
}

const UNGROUPED_KEY = '__ungrouped__'

function normalizeProjectKey(s) {
  const rawWs = String(s.workspace || '').trim()
  if (rawWs && rawWs !== 'Desktop' && rawWs !== 'SDK') return rawWs
  const cwd = String(s.cwd || '').trim().replace(/[\\/]+$/, '')
  if (cwd) {
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return rawWs || UNGROUPED_KEY
}

function groupByProject(sessions, lang) {
  const ungroupedLabel = biLang(lang, '未分组', 'Ungrouped')
  const map = new Map()
  for (const s of sessions) {
    const rawName = normalizeProjectKey(s)
    const isUngrouped = rawName === UNGROUPED_KEY
    const name = isUngrouped ? ungroupedLabel : rawName
    const key = rawName.toLowerCase()
    let group = map.get(key)
    if (!group) {
      group = {
        key,
        label: name,
        isUngrouped,
        cwd: s.cwd || '',
        latestAt: 0,
        hasRunning: false,
        items: [],
      }
      map.set(key, group)
    }
    if (!group.cwd && s.cwd) group.cwd = s.cwd
    const ts = s.updatedAt || s.createdAt || 0
    if (ts > group.latestAt) group.latestAt = ts
    if (s.status === 'running') group.hasRunning = true
    group.items.push(s)
  }

  const groups = [...map.values()]
  for (const g of groups) {
    g.items.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
  }
  groups.sort((a, b) => {
    // Keep Ungrouped at the bottom unless it's the only group
    if (a.isUngrouped && !b.isUngrouped) return 1
    if (b.isUngrouped && !a.isUngrouped) return -1
    return b.latestAt - a.latestAt
  })
  return groups
}

function groupByTime(sessions, lang) {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const startOf7Days = startOfToday - 7 * 86_400_000

  const groups = [
    { key: 'today', label: translate(lang, 'time.today'), items: [] },
    { key: 'yesterday', label: translate(lang, 'time.yesterday'), items: [] },
    { key: 'week', label: translate(lang, 'time.week'), items: [] },
    { key: 'older', label: translate(lang, 'time.older'), items: [] },
  ]

  for (const s of sessions) {
    const t = s.updatedAt || s.createdAt || 0
    if (t >= startOfToday) groups[0].items.push(s)
    else if (t >= startOfYesterday) groups[1].items.push(s)
    else if (t >= startOf7Days) groups[2].items.push(s)
    else groups[3].items.push(s)
  }

  return groups.filter((g) => g.items.length > 0)
}

function SessionRow({ session, isActive, hasPendingPrompt = false, showProjectSubtitle, onSelect }) {
  const { bi } = useI18n()
  const meta = APP_META[session.app] || APP_META.dsh
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex w-full flex-col rounded-xl px-2.5 py-2 text-left transition ${
        isActive
          ? 'bg-[#E9EEFF] text-[#2842C9] dark:bg-[#273154] dark:text-white'
          : 'hover:bg-slate-200/50 dark:hover:bg-slate-800/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <VendorBadge app={session.app} size="xs" />
        <span className="flex-1 truncate text-[13px] font-medium text-slate-800 dark:text-slate-100">
          {session.title}
        </span>
        {session.source === 'claude-desktop-cowork' && (
          <span
            title={bi('Claude Desktop (Cowork) 实时同步视图', 'Claude Desktop (Cowork) live mirror')}
            className="shrink-0 rounded border border-slate-200/80 bg-white/70 px-1 py-0.5 text-[9.5px] font-medium text-slate-500 dark:border-slate-700/80 dark:bg-slate-800/70 dark:text-slate-400"
          >
            Desktop
          </span>
        )}
        {hasPendingPrompt ? (
          <span
            title={bi('等待你的选择', 'Waiting for your input')}
            className="h-2 w-2 shrink-0 rounded-full bg-amber-500 animate-pulse"
          />
        ) : session.status === 'running' ? (
          <span
            title={bi('运行中', 'Running')}
            className="h-2 w-2 shrink-0 rounded-full bg-emerald-500 animate-pulse-dot"
          />
        ) : null}
      </div>
      {showProjectSubtitle && (
        <div className="mt-0.5 pl-8 text-[11px] text-slate-400 truncate">
          {session.workspace || meta.name}
        </div>
      )}
    </button>
  )
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

function getQuotaTone(remainingPercent) {
  if (remainingPercent >= 40) {
    return {
      text: 'text-emerald-600 dark:text-emerald-400',
      ring: '#10B981',
    }
  }
  if (remainingPercent >= 15) {
    return {
      text: 'text-amber-600 dark:text-amber-400',
      ring: '#F59E0B',
    }
  }
  return {
    text: 'text-rose-600 dark:text-rose-400',
    ring: '#F43F5E',
  }
}

function formatQuotaTooltip(label, quota, lang) {
  if (!quota || typeof quota.remainingPercent !== 'number') return label
  const planSuffix = quota.planType ? ` (${String(quota.planType).toUpperCase()})` : ''
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
  const resetStr = formatResetShort(quota.resetsAt, lang)
  if (resetStr) parts.push(resetStr)
  return parts.join(' · ')
}

export function SidebarDrawer({
  open,
  onClose,
  sessions,
  appsStatus = [],
  activeSessionId,
  pendingApprovalSessionIds = null,
  onSelectSession,
  onNewChat,
  filterApp: controlledFilterApp,
  onFilterAppChange,
  onRefresh,
  refreshing,
  connState,
  bridgeOnline,
  activeDeviceName,
  username = '',
  isAdmin = false,
  isDesktopApp = false,
  isMacDesktop = false,
  hasUpdate = false,
  e2eeLocked = false,
  canShowMyQr = false,
  onShowMyQr = null,
  onQuickScan,
  onOpenSettings,
  onOpenDeviceSwitcher,
}) {
  const { lang, bi, t } = useI18n()
  const [uncontrolledFilterApp, setUncontrolledFilterApp] = useState('all')
  const filterApp = controlledFilterApp ?? uncontrolledFilterApp
  const setFilterApp = (next) => {
    if (typeof onFilterAppChange === 'function') onFilterAppChange(next)
    else setUncontrolledFilterApp(next)
  }
  const [groupMode, setGroupMode] = useState(() => localStorage.getItem('allinone_group_mode') || 'project')
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const searchInputRef = useRef(null)
  // Map of projectKey -> boolean (explicitly expanded or collapsed by user)
  const [expandedMap, setExpandedMap] = useState({})

  useEffect(() => {
    try { localStorage.setItem('allinone_group_mode', groupMode) } catch {}
  }, [groupMode])

  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [searchOpen])

  const closeSearch = () => {
    setSearch('')
    setSearchOpen(false)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sessions.filter((s) => {
      if (filterApp !== 'all' && s.app !== filterApp) return false
      if (!q) return true
      return (
        (s.title || '').toLowerCase().includes(q) ||
        (s.workspace || '').toLowerCase().includes(q) ||
        (s.cwd || '').toLowerCase().includes(q) ||
        (s.preview || '').toLowerCase().includes(q)
      )
    })
  }, [sessions, filterApp, search])

  const { filterTabs, soleQuotaTab } = useMemo(() => {
    const allTabs = getFilterTabs(lang)
    const allTab = allTabs[0]
    const sessionApps = new Set()
    for (const s of sessions) {
      if (s?.app) sessionApps.add(s.app)
    }
    const vendorTabs = allTabs.slice(1).filter((tab) => {
      if (sessionApps.has(tab.id)) return true
      const info = appsStatus.find((a) => a?.app === tab.id)
      return Boolean(info?.available || info?.writable)
    })
    if (vendorTabs.length >= 2) {
      return { filterTabs: [allTab, ...vendorTabs], soleQuotaTab: null }
    }
    if (vendorTabs.length === 1) {
      const sole = vendorTabs[0]
      const info = appsStatus.find((a) => a?.app === sole.id)
      const hasQuota =
        info?.quota &&
        typeof info.quota.remainingPercent === 'number' &&
        Number.isFinite(info.quota.remainingPercent)
      return { filterTabs: [], soleQuotaTab: hasQuota ? { tab: sole, quota: info.quota } : null }
    }
    return { filterTabs: [], soleQuotaTab: null }
  }, [lang, sessions, appsStatus])
  const projectGroups = useMemo(() => groupByProject(filtered, lang), [filtered, lang])
  const timeGroups = useMemo(() => groupByTime(filtered, lang), [filtered, lang])

  const activeProjectKey = useMemo(() => {
    const active = sessions.find((s) => s.id === activeSessionId)
    return active ? normalizeProjectKey(active).toLowerCase() : ''
  }, [sessions, activeSessionId])

  const isProjectExpanded = (group, index) => {
    if (search.trim().length > 0) return true
    if (group.key in expandedMap) return expandedMap[group.key]
    if (group.key === activeProjectKey) return true
    // By default expand the top 3 most recently active projects, collapse the rest
    return index < 3
  }

  const toggleProject = (key, current) => {
    setExpandedMap((prev) => ({ ...prev, [key]: !current }))
  }

  const allExpanded = projectGroups.length > 0 && projectGroups.every((g, idx) => isProjectExpanded(g, idx))

  const toggleAllProjects = () => {
    const target = !allExpanded
    const next = {}
    for (const g of projectGroups) next[g.key] = target
    setExpandedMap(next)
  }

  return (
    <>
      {/* Mobile Backdrop (hidden on desktop docked layout) */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px] transition-opacity duration-200 lg:hidden ${
          open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      {/* Drawer Panel (slide-over on mobile, permanently docked sidebar on desktop lg:) */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[84%] max-w-[330px] flex-col bg-[#F8F9FC] shadow-2xl transition-[transform,visibility] duration-250 ease-out dark:bg-[#1B1D23] lg:static lg:inset-auto lg:z-auto lg:visible lg:pointer-events-auto lg:w-[292px] lg:max-w-none lg:shrink-0 lg:translate-x-0 lg:border-r lg:border-slate-200/80 lg:shadow-none lg:transition-none lg:dark:border-slate-800/80 ${
          open ? 'visible pointer-events-auto translate-x-0' : 'invisible pointer-events-none -translate-x-full'
        }`}
      >
        {/* Top header (includes macOS traffic-light clearance & drag bar when running in Electron) */}
        <div
          className={`app-drag flex items-center justify-between px-4 pb-2 ${
            isMacDesktop ? 'pt-9' : 'pt-safe'
          }`}
        >
          <div className="app-no-drag flex min-w-0 items-center gap-2.5">
            <img src="./icon-192.png" alt="All in One" className="h-7.5 w-7.5 rounded-xl bg-[#0B0E14] ring-1 ring-white/10" />
            <div className="min-w-0">
              <div className="text-[15px] font-bold leading-tight text-slate-900 dark:text-white">
                All in One
              </div>
            </div>
          </div>

          <div className="app-no-drag flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => {
                if (searchOpen) closeSearch()
                else setSearchOpen(true)
              }}
              title={searchOpen ? bi('收起搜索', 'Close search') : bi('搜索对话', 'Search chats')}
              aria-label={searchOpen ? bi('收起搜索', 'Close search') : bi('搜索对话', 'Search chats')}
              aria-expanded={searchOpen}
              className={`rounded-xl p-2 transition ${
                searchOpen || search.trim().length > 0
                  ? 'bg-[#4D6BFE]/12 text-[#4D6BFE] dark:bg-[#4D6BFE]/20 dark:text-[#9AB0FF]'
                  : 'text-slate-500 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <Search className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                onClose()
                onNewChat('', filterApp !== 'all' ? filterApp : '')
              }}
              title={t('common.newChat')}
              aria-label={t('common.newChat')}
              className="rounded-xl p-2 text-slate-500 transition hover:bg-slate-200/70 hover:text-[#4D6BFE] lg:hidden dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-[#9AB0FF]"
            >
              <SquarePen className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onRefresh}
              title={bi('刷新会话列表', 'Refresh conversations')}
              aria-label={bi('刷新会话列表', 'Refresh conversations')}
              className="rounded-xl p-2 text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={bi('关闭侧边栏', 'Close sidebar')}
              className="rounded-xl p-2 text-slate-500 hover:bg-slate-200/70 lg:hidden dark:text-slate-400 dark:hover:bg-slate-800"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Active Computer Switcher Card */}
        <div className="px-4 pb-2">
          <button
            type="button"
            onClick={() => {
              onClose()
              onOpenDeviceSwitcher?.()
            }}
            className="flex w-full items-center gap-2.5 rounded-2xl border border-slate-200/80 bg-white px-3 py-1.5 text-left shadow-2xs transition hover:border-[#4D6BFE]/50 active:scale-[0.99] dark:border-slate-700/80 dark:bg-[#232631] dark:hover:border-[#4D6BFE]/50"
          >
            <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Monitor className="h-3.5 w-3.5" />
              <span
                className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-[#232631] ${
                  connState === 'unauthorized'
                    ? 'bg-rose-500'
                    : connState === 'connected' && bridgeOnline
                      ? 'bg-emerald-500'
                      : connState === 'connecting'
                        ? 'bg-amber-400'
                        : 'bg-slate-400'
                }`}
              />
            </div>

            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-slate-800 dark:text-white">
              {activeDeviceName || bi('我的电脑', 'My Computer')}
            </span>

            {connState === 'unauthorized' ? (
              <span className="shrink-0 rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-500 dark:bg-rose-950/50 dark:text-rose-300">
                {t('common.expired')}
              </span>
            ) : connState === 'connecting' ? (
              <span className="shrink-0 text-[10.5px] text-amber-500">{t('common.connecting')}</span>
            ) : !(connState === 'connected' && bridgeOnline) ? (
              <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                {t('common.offline')}
              </span>
            ) : null}

            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </button>
        </div>

        {/* Collapsible Search Input (toggled from top bar search icon) */}
        {searchOpen && (
          <div className="px-4 pb-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    closeSearch()
                  }
                }}
                placeholder={bi('搜索对话...', 'Search chats...')}
                className="w-full rounded-xl border border-[#4D6BFE]/50 bg-white py-1.5 pr-8 pl-8.5 text-xs text-slate-800 outline-none focus:border-[#4D6BFE] dark:border-[#4D6BFE]/50 dark:bg-[#14161B] dark:text-slate-100"
              />
              <button
                type="button"
                onClick={closeSearch}
                aria-label={bi('清空并关闭搜索', 'Clear and close search')}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Dynamic Vendor Filter & Subscription Quota Bar (only shows detected or active tools) */}
        {filterTabs.length > 0 ? (
          <div className="px-4 pb-2">
            <div
              className="grid gap-1.5"
              style={{ gridTemplateColumns: `repeat(${filterTabs.length}, minmax(0, 1fr))` }}
            >
              {filterTabs.map((tab) => {
                const active = filterApp === tab.id
                const appInfo = tab.id !== 'all' ? appsStatus.find((a) => a?.app === tab.id) : null
                const quota =
                  appInfo?.quota &&
                  typeof appInfo.quota.remainingPercent === 'number' &&
                  Number.isFinite(appInfo.quota.remainingPercent)
                    ? appInfo.quota
                    : null
                const pct = quota ? Math.max(0, Math.min(100, Math.round(quota.remainingPercent))) : null
                const tone = pct !== null ? getQuotaTone(pct) : null
                const tooltip = formatQuotaTooltip(tab.label, quota, lang)

                // Tiles WITH subscription quota: the rounded-square border itself is the clockwise progress ring!
                if (pct !== null && tone) {
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      title={tooltip}
                      aria-label={tooltip}
                      onClick={() => setFilterApp(active && tab.id !== 'all' ? 'all' : tab.id)}
                      className={`group relative h-11 rounded-xl p-[2px] transition active:scale-95 ${
                        active ? 'shadow-xs' : ''
                      }`}
                      style={{
                        background: `conic-gradient(from 0deg, ${tone.ring} 0% ${pct}%, var(--quota-track) ${pct}% 100%)`,
                      }}
                    >
                      <span className="relative flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-[10px] bg-white transition group-hover:bg-slate-50 dark:bg-[#242731] dark:group-hover:bg-[#2B2F3B]">
                        {active && (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0"
                            style={{ backgroundColor: `${tab.color}24` }}
                          />
                        )}
                        <span className="relative z-10 flex flex-col items-center justify-center gap-0.5">
                          <VendorIcon app={tab.id} size={16} />
                          <span className={`text-[10px] leading-none font-semibold tabular-nums ${tone.text}`}>
                            {pct}%
                          </span>
                        </span>
                      </span>
                    </button>
                  )
                }

                return (
                  <button
                    key={tab.id}
                    type="button"
                    title={tooltip}
                    aria-label={tooltip}
                    onClick={() => setFilterApp(active && tab.id !== 'all' ? 'all' : tab.id)}
                    className={`relative flex h-11 flex-col items-center justify-center rounded-xl border transition active:scale-95 ${
                      active
                        ? 'border-transparent shadow-xs'
                        : 'border-slate-200/70 bg-white text-slate-500 hover:bg-slate-100 dark:border-slate-700/70 dark:bg-[#242731] dark:text-slate-300 dark:hover:bg-[#2B2F3B]'
                    }`}
                    style={
                      active
                        ? {
                            backgroundColor: `${tab.color}1F`,
                            borderColor: `${tab.color}66`,
                            color: tab.color,
                          }
                        : undefined
                    }
                  >
                    <VendorIcon
                      app={tab.id}
                      size={tab.id === 'all' ? 17 : 19}
                      mono={tab.id === 'all'}
                    />
                  </button>
                )
              })}
            </div>
          </div>
        ) : soleQuotaTab ? (() => {
          const pct = Math.max(0, Math.min(100, Math.round(soleQuotaTab.quota.remainingPercent)))
          const tone = getQuotaTone(pct)
          const tooltip = formatQuotaTooltip(soleQuotaTab.tab.label, soleQuotaTab.quota, lang)
          return (
            <div className="px-4 pb-2">
              <div
                title={tooltip}
                className="flex items-center justify-between gap-2 rounded-xl border border-slate-200/70 bg-white px-2.5 py-2 dark:border-slate-700/70 dark:bg-[#242731]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <VendorIcon app={soleQuotaTab.tab.id} size={16} />
                  <span className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
                    {soleQuotaTab.tab.label}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-700/80">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: tone.ring }}
                    />
                  </div>
                  <span className={`text-[11px] font-semibold tabular-nums ${tone.text}`}>
                    {pct}%
                  </span>
                </div>
              </div>
            </div>
          )
        })() : null}

        {/* Grouping Mode Switcher: By Project (default) vs By Time */}
        <div className="flex items-center justify-between px-4 pb-2 text-[11px]">
          <div className="inline-flex rounded-lg bg-slate-200/70 p-0.5 dark:bg-[#242731]">
            <button
              type="button"
              onClick={() => setGroupMode('project')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium transition ${
                groupMode === 'project'
                  ? 'bg-white text-slate-900 shadow-2xs dark:bg-[#323644] dark:text-white'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Folder className="h-3 w-3" />
              <span>{bi('按项目', 'Projects')}</span>
            </button>
            <button
              type="button"
              onClick={() => setGroupMode('time')}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium transition ${
                groupMode === 'time'
                  ? 'bg-white text-slate-900 shadow-2xs dark:bg-[#323644] dark:text-white'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Clock className="h-3 w-3" />
              <span>{bi('按时间', 'Recent')}</span>
            </button>
          </div>

          {groupMode === 'project' && projectGroups.length > 0 && search.trim().length === 0 && (
            <button
              type="button"
              onClick={toggleAllProjects}
              className="text-slate-400 hover:text-[#4D6BFE]"
            >
              {allExpanded ? bi('折叠', 'Collapse') : bi('展开', 'Expand')}
            </button>
          )}
        </div>

        {/* Grouped conversation list */}
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">
              {e2eeLocked
                ? bi('请先同步端到端密钥以查看对话', 'Sync E2EE key to view conversations')
                : bridgeOnline
                  ? bi('暂无匹配的对话', 'No matching conversations')
                  : bi('等待电脑端上线...', 'Waiting for computer to come online...')}
            </div>
          ) : groupMode === 'project' ? (
            <div className="space-y-1.5">
              {projectGroups.map((group, idx) => {
                const expanded = isProjectExpanded(group, idx)
                return (
                  <div
                    key={group.key}
                    className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white/70 dark:border-slate-800/80 dark:bg-[#20232B]/70"
                  >
                    <div className="flex items-center gap-1 pr-1.5">
                      <button
                        type="button"
                        onClick={() => toggleProject(group.key, expanded)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        )}
                        {expanded ? (
                          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE]" />
                        ) : (
                          <Folder className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        )}
                        <span className="flex-1 truncate text-[12.5px] font-semibold text-slate-700 dark:text-slate-200">
                          {group.label}
                        </span>
                        {group.hasRunning && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 animate-pulse-dot" />
                        )}
                        <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          {group.items.length}
                        </span>
                      </button>

                      {group.cwd && (
                        <button
                          type="button"
                          title={bi(`在 ${group.label} 新建对话`, `New chat in ${group.label}`)}
                          onClick={() => {
                            onClose()
                            onNewChat(group.cwd, filterApp !== 'all' ? filterApp : '')
                          }}
                          className="rounded-lg p-1 text-slate-400 hover:bg-slate-200/70 hover:text-[#4D6BFE] dark:hover:bg-slate-700/70"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    {expanded && (
                      <div className="space-y-0.5 border-t border-slate-100 px-1.5 py-1.5 dark:border-slate-800/80">
                        {group.items.map((s) => (
                          <SessionRow
                            key={s.id}
                            session={s}
                            isActive={s.id === activeSessionId}
                            hasPendingPrompt={Boolean(pendingApprovalSessionIds?.has?.(s.id))}
                            showProjectSubtitle={false}
                            onSelect={() => {
                              onSelectSession(s)
                              onClose()
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            timeGroups.map((group) => (
              <div key={group.key} className="mb-3">
                <div className="px-2 py-1.5 text-[11px] font-semibold tracking-wide text-slate-400">
                  {group.label}
                </div>
                <div className="space-y-1">
                  {group.items.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      isActive={s.id === activeSessionId}
                      hasPendingPrompt={Boolean(pendingApprovalSessionIds?.has?.(s.id))}
                      showProjectSubtitle={true}
                      onSelect={() => {
                        onSelectSession(s)
                        onClose()
                      }}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Minimal single-row footer: User profile, Quick Scan & Settings */}
        <div className="pb-safe border-t border-slate-200/80 px-3 pt-2 pb-2 dark:border-slate-800">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onClose()
                onOpenSettings?.()
              }}
              aria-label={bi('打开设置', 'Open Settings')}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left transition hover:bg-slate-200/60 active:scale-[0.99] dark:hover:bg-slate-800/70"
            >
              <div className="relative flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-xl bg-[#4D6BFE]/14 text-xs font-bold text-[#4D6BFE]">
                {username ? username.slice(0, 1).toUpperCase() : <User className="h-3.5 w-3.5" />}
                {hasUpdate && (
                  <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-[#F8F9FC] dark:ring-[#1B1D23]" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100">
                  {username ? `@${username}` : activeDeviceName || t('common.settings')}
                </span>
                {hasUpdate ? (
                  <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-emerald-600 dark:text-emerald-300">
                    {bi('有更新', 'Update')}
                  </span>
                ) : isAdmin ? (
                  <span className="shrink-0 rounded bg-[#4D6BFE]/12 px-1 py-0.5 text-[9.5px] font-semibold text-[#4D6BFE]">
                    {t('common.admin')}
                  </span>
                ) : null}
              </div>
            </button>

            {isDesktopApp && canShowMyQr && onShowMyQr ? (
              <button
                type="button"
                onClick={() => {
                  onClose()
                  onShowMyQr()
                }}
                title={bi('显示本机二维码，供手机扫码同步', 'Show QR code for phone sync')}
                aria-label={bi('连手机', 'Connect Phone')}
                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-xl bg-[#4D6BFE]/10 px-2.5 text-[11.5px] font-semibold text-[#3B59ED] transition hover:bg-[#4D6BFE]/18 active:scale-95 dark:bg-[#4D6BFE]/18 dark:text-[#9BB0FF] dark:hover:bg-[#4D6BFE]/28"
              >
                <QrCode className="h-3.5 w-3.5 shrink-0" />
                <span>{bi('连手机', 'Phone')}</span>
              </button>
            ) : onQuickScan ? (
              <button
                type="button"
                onClick={() => {
                  onClose()
                  onQuickScan()
                }}
                title={bi('扫一扫（同步密钥 / 授权新设备）', 'Scan QR (Sync Key / Authorize Device)')}
                aria-label={bi('扫一扫', 'Scan QR')}
                className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition active:scale-95 ${
                  e2eeLocked
                    ? 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400'
                    : 'text-slate-500 hover:bg-slate-200/70 hover:text-[#4D6BFE] dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-[#8CA3FF]'
                }`}
              >
                <ScanLine className="h-4.5 w-4.5" />
                {e2eeLocked && (
                  <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-[#F8F9FC] dark:ring-[#1B1D23]" />
                )}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => {
                onClose()
                onOpenSettings?.()
              }}
              title={bi('设置', 'Settings')}
              aria-label={bi('打开设置', 'Open Settings')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-200/70 hover:text-slate-700 active:scale-95 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
