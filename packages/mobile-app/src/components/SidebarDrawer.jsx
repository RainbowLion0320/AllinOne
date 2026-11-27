import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronsUpDown,
  Clock,
  Folder,
  Monitor,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  Settings,
  User,
  X,
} from 'lucide-react'
import { VendorQuotaRings } from './VendorQuotaRings.jsx'
import {
  SidebarSessionList,
  groupByProject,
  groupByTime,
  normalizeProjectKey,
} from './SidebarSessionList.jsx'
import { computeSidebarVendorLayout } from '../lib/sidebarVendors.js'
import { useI18n } from '../lib/i18n.jsx'
import { translate } from '../lib/i18n.js'

function getFilterTabs(lang) {
  return [
    { id: 'all', label: translate(lang, 'common.all'), color: '#4D6BFE' },
    { id: 'dsh', label: 'DeepSeek', color: '#4D6BFE' },
    { id: 'codex', label: 'Codex', color: '#6366F1' },
    { id: 'claude', label: 'Claude', color: '#D97757' },
    { id: 'antigravity', label: 'Antigravity', color: '#3186FF' },
    { id: 'workbuddy', label: 'WorkBuddy', color: '#06C798' },
  ]
}

function useIsDesktopViewport() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
    return window.matchMedia('(min-width: 1024px)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = (ev) => setIsDesktop(ev.matches)
    setIsDesktop(mq.matches)
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener?.(onChange)
    return () => mq.removeListener?.(onChange)
  }, [])

  return isDesktop
}

export const SidebarDrawer = React.memo(function SidebarDrawer({
  open,
  onClose,
  sessions,
  appsStatus = [],
  activeSessionId,
  pendingApprovalSessionIds = null,
  onSelectSession,
  onGoHome,
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
  const isDesktopViewport = useIsDesktopViewport()
  const [keepMountedAfterClose, setKeepMountedAfterClose] = useState(false)
  const [uncontrolledFilterApp, setUncontrolledFilterApp] = useState('all')
  const filterApp = controlledFilterApp ?? uncontrolledFilterApp
  const setFilterApp = useCallback(
    (next) => {
      if (typeof onFilterAppChange === 'function') onFilterAppChange(next)
      else setUncontrolledFilterApp(next)
    },
    [onFilterAppChange],
  )
  const [groupMode, setGroupMode] = useState(() => localStorage.getItem('allinone_group_mode') || 'project')
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const searchInputRef = useRef(null)
  const [expandedMap, setExpandedMap] = useState({})

  // Unmount heavy hidden mobile drawer body after slide-out animation completes so mobile background ticks cost 0ms
  useEffect(() => {
    if (isDesktopViewport || open) {
      setKeepMountedAfterClose(open)
      return undefined
    }
    const timer = setTimeout(() => setKeepMountedAfterClose(false), 260)
    return () => clearTimeout(timer)
  }, [open, isDesktopViewport])

  const shouldRenderContent = isDesktopViewport || open || keepMountedAfterClose

  useEffect(() => {
    try { localStorage.setItem('allinone_group_mode', groupMode) } catch {}
  }, [groupMode])

  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [searchOpen])

  const closeSearch = useCallback(() => {
    setSearch('')
    setSearchOpen(false)
  }, [])

  const filtered = useMemo(() => {
    if (!shouldRenderContent) return []
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
  }, [shouldRenderContent, sessions, filterApp, search])

  const { showFilterBar, allTab, visibleVendors, overflowVendors, soleQuotaTab } = useMemo(() => {
    const allTabs = getFilterTabs(lang)
    if (!shouldRenderContent) {
      return {
        showFilterBar: false,
        allTab: allTabs[0],
        visibleVendors: [],
        overflowVendors: [],
        soleQuotaTab: null,
      }
    }
    const layout = computeSidebarVendorLayout({
      vendorTabs: allTabs.slice(1),
      sessions,
      appsStatus,
    })
    return {
      showFilterBar: layout.showBar,
      allTab: allTabs[0],
      visibleVendors: layout.visibleVendors,
      overflowVendors: layout.overflowVendors,
      soleQuotaTab: layout.soleQuotaTab,
    }
  }, [shouldRenderContent, lang, sessions, appsStatus])

  const projectGroups = useMemo(
    () => (shouldRenderContent ? groupByProject(filtered, lang) : []),
    [shouldRenderContent, filtered, lang],
  )
  const timeGroups = useMemo(
    () => (shouldRenderContent ? groupByTime(filtered, lang) : []),
    [shouldRenderContent, filtered, lang],
  )

  const activeProjectKey = useMemo(() => {
    if (!shouldRenderContent) return ''
    const active = sessions.find((s) => s.id === activeSessionId)
    return active ? normalizeProjectKey(active).toLowerCase() : ''
  }, [shouldRenderContent, sessions, activeSessionId])

  const isProjectExpanded = useCallback(
    (group, index) => {
      if (search.trim().length > 0) return true
      if (group.key in expandedMap) return expandedMap[group.key]
      if (group.key === activeProjectKey) return true
      return index < 3
    },
    [search, expandedMap, activeProjectKey],
  )

  const toggleProject = useCallback((key, current) => {
    setExpandedMap((prev) => ({ ...prev, [key]: !current }))
  }, [])

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
        aria-hidden={!shouldRenderContent}
        className={`fixed inset-y-0 left-0 z-50 flex w-[84%] max-w-[330px] flex-col bg-[#F8F9FC] shadow-2xl transition-[transform,visibility] duration-250 ease-out dark:bg-[#1B1D23] lg:static lg:inset-auto lg:z-auto lg:visible lg:pointer-events-auto lg:w-[292px] lg:max-w-none lg:shrink-0 lg:translate-x-0 lg:border-r lg:border-slate-200/80 lg:shadow-none lg:transition-none lg:dark:border-slate-800/80 ${
          open ? 'visible pointer-events-auto translate-x-0' : 'invisible pointer-events-none -translate-x-full'
        }`}
      >
        {shouldRenderContent && (
          <>
            {/* Top header (includes macOS traffic-light clearance & drag bar when running in Electron) */}
            <div
              className={`app-drag flex items-center justify-between px-4 pb-2 ${
                isMacDesktop ? 'pt-9' : 'pt-safe'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  onGoHome?.()
                  onClose()
                }}
                title={bi('回到主界面', 'Back to home')}
                className="app-no-drag flex min-w-0 items-center gap-2.5 rounded-xl py-0.5 pr-2 text-left transition hover:opacity-85 active:scale-[0.98]"
              >
                <img src="./icon-192.png" alt="All in One" className="h-7.5 w-7.5 rounded-xl bg-[#0B0E14] ring-1 ring-white/10" />
                <div className="min-w-0">
                  <div className="text-[15px] font-bold leading-tight text-slate-900 dark:text-white">
                    All in One
                  </div>
                </div>
              </button>

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

            {/* Collapsible Search Input */}
            {searchOpen && (
              <div className="animate-reveal-down px-4 pb-2">
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

            {/* Dynamic Vendor Filter & Subscription Quota Bar */}
            <VendorQuotaRings
              drawerOpen={open}
              showFilterBar={showFilterBar}
              allTab={allTab}
              visibleVendors={visibleVendors}
              overflowVendors={overflowVendors}
              soleQuotaTab={soleQuotaTab}
              filterApp={filterApp}
              onSelectFilterApp={setFilterApp}
            />

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
              <SidebarSessionList
                filteredCount={filtered.length}
                groupMode={groupMode}
                projectGroups={projectGroups}
                timeGroups={timeGroups}
                activeSessionId={activeSessionId}
                pendingApprovalSessionIds={pendingApprovalSessionIds}
                e2eeLocked={e2eeLocked}
                bridgeOnline={bridgeOnline}
                filterApp={filterApp}
                isProjectExpanded={isProjectExpanded}
                onToggleProject={toggleProject}
                onSelectSession={onSelectSession}
                onNewChat={onNewChat}
                onClose={onClose}
              />
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
                    className="scan-btn-sweep scan-btn-sweep-subtle inline-flex h-9 shrink-0 items-center gap-1 rounded-xl bg-[#4D6BFE]/12 px-2.5 text-[11.5px] font-semibold text-[#3B59ED] ring-1 ring-[#4D6BFE]/22 transition-all duration-150 hover:bg-[#4D6BFE]/20 active:scale-95 dark:bg-[#4D6BFE]/20 dark:text-[#9BB0FF] dark:ring-[#4D6BFE]/35 dark:hover:bg-[#4D6BFE]/28"
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
                    className={`scan-btn-sweep scan-btn-sweep-subtle relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 transition-all duration-150 hover:scale-105 active:scale-95 ${
                      e2eeLocked
                        ? 'bg-amber-500/15 text-amber-600 ring-amber-500/35 hover:bg-amber-500/25 dark:text-amber-400'
                        : 'bg-[#4D6BFE]/10 text-[#4D6BFE] ring-[#4D6BFE]/22 hover:bg-[#4D6BFE]/18 dark:bg-[#4D6BFE]/18 dark:text-[#8CA3FF] dark:ring-[#4D6BFE]/32 dark:hover:bg-[#4D6BFE]/26'
                    }`}
                  >
                    <ScanLine className="relative z-10 h-4.5 w-4.5" />
                    <span aria-hidden="true" className="scan-btn-beam z-20" />
                    {e2eeLocked && (
                      <span className="absolute top-1 right-1 z-30 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-[#F8F9FC] animate-pulse-dot dark:ring-[#1B1D23]" />
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
          </>
        )}
      </aside>
    </>
  )
})
