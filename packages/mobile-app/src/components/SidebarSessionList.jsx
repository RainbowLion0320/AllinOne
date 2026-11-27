import React from 'react'
import { APP_META } from '@allinone/shared'
import { ChevronRight, Folder, FolderOpen, Plus } from 'lucide-react'
import { VendorBadge } from './VendorIcon.jsx'
import { useI18n } from '../lib/i18n.jsx'
import { bi as biLang, translate } from '../lib/i18n.js'

const UNGROUPED_KEY = '__ungrouped__'

export function normalizeProjectKey(s) {
  const rawWs = String(s.workspace || '').trim()
  if (rawWs && rawWs !== 'Desktop' && rawWs !== 'SDK') return rawWs
  const cwd = String(s.cwd || '').trim().replace(/[\\/]+$/, '')
  if (cwd) {
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return rawWs || UNGROUPED_KEY
}

export function groupByProject(sessions, lang) {
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
    if (a.isUngrouped && !b.isUngrouped) return 1
    if (b.isUngrouped && !a.isUngrouped) return -1
    return b.latestAt - a.latestAt
  })
  return groups
}

export function groupByTime(sessions, lang) {
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

const SessionRow = React.memo(function SessionRow({
  session,
  isActive,
  hasPendingPrompt = false,
  showProjectSubtitle,
  onSelectSession,
  onCloseDrawer,
}) {
  const { bi } = useI18n()
  const meta = APP_META[session.app] || APP_META.dsh
  return (
    <button
      type="button"
      onClick={() => {
        onSelectSession(session)
        onCloseDrawer()
      }}
      className={`group flex w-full flex-col rounded-xl px-2.5 py-2 text-left transition-all duration-150 active:scale-[0.985] ${
        isActive
          ? 'bg-[#E9EEFF] text-[#2842C9] dark:bg-[#273154] dark:text-white'
          : 'hover:bg-slate-200/50 dark:hover:bg-slate-800/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <VendorBadge app={session.app} size="xs" active={session.status === 'running' || hasPendingPrompt} />
        <span className="flex-1 truncate text-[13px] font-medium text-slate-800 dark:text-slate-100">
          {session.title}
        </span>
        {(session.source === 'claude-desktop-cowork' ||
          (session.source === 'workbuddy-desktop' && session.writable === false) ||
          (session.source === 'zcode-desktop' && session.writable === false)) && (
          <span
            title={
              session.source === 'workbuddy-desktop'
                ? bi('WorkBuddy 桌面端实时同步视图', 'WorkBuddy Desktop live mirror')
                : session.source === 'zcode-desktop'
                  ? bi('ZCode 桌面端实时同步视图', 'ZCode Desktop live mirror')
                  : bi('Claude Desktop (Cowork) 实时同步视图', 'Claude Desktop (Cowork) live mirror')
            }
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
})

export const SidebarSessionList = React.memo(function SidebarSessionList({
  filteredCount,
  groupMode,
  projectGroups,
  timeGroups,
  activeSessionId,
  pendingApprovalSessionIds,
  e2eeLocked,
  bridgeOnline,
  filterApp,
  isProjectExpanded,
  onToggleProject,
  onSelectSession,
  onNewChat,
  onClose,
}) {
  const { bi } = useI18n()

  if (filteredCount === 0) {
    return (
      <div className="py-12 text-center text-xs text-slate-400">
        {e2eeLocked
          ? bi('请先同步端到端密钥以查看对话', 'Sync E2EE key to view conversations')
          : bridgeOnline
            ? bi('暂无匹配的对话', 'No matching conversations')
            : bi('等待电脑端上线...', 'Waiting for computer to come online...')}
      </div>
    )
  }

  if (groupMode === 'project') {
    return (
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
                  onClick={() => onToggleProject(group.key, expanded)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-slate-100/60 dark:hover:bg-slate-800/40"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 ${
                      expanded ? 'rotate-90' : ''
                    }`}
                  />
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
                <div className="animate-reveal-down space-y-0.5 border-t border-slate-100 px-1.5 py-1.5 dark:border-slate-800/80">
                  {group.items.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      isActive={s.id === activeSessionId}
                      hasPendingPrompt={Boolean(pendingApprovalSessionIds?.has?.(s.id))}
                      showProjectSubtitle={false}
                      onSelectSession={onSelectSession}
                      onCloseDrawer={onClose}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return timeGroups.map((group) => (
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
            onSelectSession={onSelectSession}
            onCloseDrawer={onClose}
          />
        ))}
      </div>
    </div>
  ))
})
