import React, { useEffect, useMemo, useState } from 'react'
import { APP_LIST, APP_META } from '@allinone/shared'
import {
  CalendarClock,
  Check,
  Clock,
  Coins,
  Folder,
  FolderPlus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Wallet,
  Zap,
} from 'lucide-react'
import { VendorBadge } from './VendorIcon.jsx'
import { buildHomeQuotaCards } from '../lib/quotaDashboard.js'
import { useI18n } from '../lib/i18n.jsx'

function healthColorClasses(health) {
  if (health === 'critical') {
    return {
      text: 'text-rose-600 dark:text-rose-400',
      bar: 'from-rose-500 to-pink-500',
      pill: 'bg-rose-500/12 text-rose-600 dark:bg-rose-400/15 dark:text-rose-300',
    }
  }
  if (health === 'warning') {
    return {
      text: 'text-amber-600 dark:text-amber-400',
      bar: 'from-amber-500 to-orange-400',
      pill: 'bg-amber-500/12 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
    }
  }
  return {
    text: 'text-emerald-600 dark:text-emerald-400',
    bar: 'from-emerald-500 to-teal-400',
    pill: 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300',
  }
}

function getOtherVendorHint(card, bi) {
  if (card.app === 'dsh') {
    if (card.mode === 'cordis-live') return bi('Cordis 引擎实时直连 · 按所配模型计费', 'Cordis live engine · Model API billing')
    if (card.mode === 'dsh-local-ipc') return bi('本机 IPC 读写就绪 · 按所配模型计费', 'Local IPC ready · Model API billing')
    return bi('只读浏览历史 · 打开 DSH 后自动解锁发送', 'Read-only · Open DSH to unlock sending')
  }
  if (card.app === 'claude') {
    if (!card.writable) return bi('Claude Desktop 历史同步（只读）', 'Claude Desktop history mirror (read-only)')
    return bi('发起一次对话后自动同步 5h / 周额度', '5h & weekly limits sync after first chat')
  }
  if (card.app === 'workbuddy') {
    if (!card.writable) return bi('微信扫码登录后实时同步积分余额', 'Sign in via QR to view live credits')
    return bi('正在同步 WorkBuddy 积分余额...', 'Syncing WorkBuddy credits...')
  }
  if (card.app === 'antigravity') {
    if (!card.writable) return bi('仅历史只读 · 安装 agy CLI 后同步额度', 'Read-only · Install agy CLI for live quota')
    return bi('正在后台同步 Gemini 5h / 周额度...', 'Syncing Gemini 5h & weekly quota...')
  }
  if (card.app === 'codex') {
    return bi('正在同步 Codex 5h / 周额度...', 'Syncing Codex 5h & weekly quota...')
  }
  return card.writable ? bi('读写就绪', 'Ready') : bi('只读模式', 'Read-only')
}

function WindowMeterRow({ win }) {
  const colors = healthColorClasses(win.health)
  const isShort = win.kind === 'short'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {isShort ? (
            <Zap className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE] dark:text-[#8DA2FF]" />
          ) : (
            <CalendarClock className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
          )}
          <span className="shrink-0 text-[12px] font-semibold text-slate-700 dark:text-slate-200">
            {win.label}
          </span>
          {win.resetText && (
            <span
              title={win.resetText}
              className="inline-flex min-w-0 items-center gap-0.5 rounded-md bg-slate-100/90 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 tabular-nums dark:bg-slate-800/90 dark:text-slate-400"
            >
              <Clock className="h-2.5 w-2.5 shrink-0 opacity-75" />
              <span className="truncate">{win.resetText}</span>
            </span>
          )}
        </div>
        <span className={`shrink-0 text-[13px] font-bold tabular-nums ${colors.text}`}>
          {win.remainingPercent}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800/90">
        <div
          className={`h-full rounded-full bg-gradient-to-r transition-all duration-500 ease-out ${colors.bar}`}
          style={{ width: `${Math.max(win.remainingPercent > 0 ? 4 : 0, Math.min(100, win.remainingPercent))}%` }}
        />
      </div>
    </div>
  )
}

function CreditsMeterBody({ details, bi }) {
  const colors = healthColorClasses(details.health)
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className={`text-[22px] leading-none font-extrabold tracking-tight tabular-nums ${colors.text}`}>
              {details.remainingText}
            </span>
            {details.unlimited ? (
              <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                {bi('不限积分', 'Unlimited')}
              </span>
            ) : (
              <span className="truncate text-[11.5px] font-medium text-slate-400 tabular-nums dark:text-slate-500">
                {details.totalText
                  ? `/ ${details.totalText} ${bi('积分', 'cr')}`
                  : bi('剩余积分', 'credits left')}
              </span>
            )}
          </div>
          {!details.unlimited && (
            <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${colors.pill}`}>
              {details.remainingPercent}%
            </span>
          )}
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800/90">
          <div
            className={`h-full rounded-full bg-gradient-to-r transition-all duration-500 ease-out ${
              details.health === 'healthy' ? 'from-[#06C798] to-emerald-400' : colors.bar
            }`}
            style={{
              width: `${Math.max(details.remainingPercent > 0 ? 4 : 0, Math.min(100, details.remainingPercent))}%`,
            }}
          />
        </div>
      </div>

      {details.groups.length > 0 && (
        <div className="space-y-2 border-t border-slate-100 pt-2.5 dark:border-slate-800/80">
          {details.groups.map((g, i) => {
            const gColors = healthColorClasses(g.health)
            return (
              <div key={`${g.kind || g.name}-${i}`} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-slate-600 dark:text-slate-300">
                    <Coins className="h-3 w-3 shrink-0 text-[#06C798]" />
                    <span className="truncate">{g.name}</span>
                  </span>
                  <span className="shrink-0 font-semibold text-slate-700 tabular-nums dark:text-slate-200">
                    {g.totalText ? `${g.remainingText} / ${g.totalText}` : g.remainingText}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800/90">
                  <div
                    className={`h-full rounded-full bg-gradient-to-r transition-all duration-500 ease-out ${
                      g.health === 'healthy' ? 'from-[#06C798] to-teal-400' : gColors.bar
                    }`}
                    style={{ width: `${Math.max(g.percent > 0 ? 4 : 0, Math.min(100, g.percent))}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {details.resetText && (
        <div className="flex items-center gap-1 text-[10.5px] font-medium text-slate-400 tabular-nums dark:text-slate-500">
          <Clock className="h-3 w-3 shrink-0 opacity-75" />
          <span>{details.resetText}</span>
        </div>
      )}
    </div>
  )
}

function BalanceMeterBody({ details, card, bi }) {
  const colors = healthColorClasses(details.health)
  const statusLabel = !details.isAvailable
    ? bi('余额不足', 'Depleted')
    : details.health === 'warning'
      ? bi('余额偏低', 'Low')
      : bi('余额可用', 'Available')
  const modeHint =
    card.mode === 'cordis-live'
      ? bi('Cordis 引擎实时直连', 'Cordis live engine')
      : card.mode === 'dsh-local-ipc'
        ? bi('本机 IPC 读写就绪', 'Local IPC ready')
        : bi('历史只读（打开 DSH 后解锁发送）', 'Read-only (open DSH to send)')

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className={`text-[24px] leading-none font-extrabold tracking-tight tabular-nums ${colors.text}`}>
            {details.totalText}
          </span>
          <span className="truncate text-[11px] font-medium text-slate-400 dark:text-slate-500">
            {bi('账户余额', 'Balance')}
          </span>
        </div>
        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold ${colors.pill}`}>
          {statusLabel}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2.5 dark:border-slate-800/80">
        <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100/90 px-2 py-1 text-[10.5px] font-semibold text-slate-700 tabular-nums dark:bg-slate-800/85 dark:text-slate-200">
          <Wallet className="h-3 w-3 shrink-0 text-[#4D6BFE]" />
          <span>{bi('充值余额', 'Top-up')}</span>
          <span>{details.toppedUpText}</span>
        </span>
        {details.granted > 0 && (
          <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2 py-1 text-[10.5px] font-semibold text-emerald-700 tabular-nums dark:bg-emerald-400/15 dark:text-emerald-300">
            <Coins className="h-3 w-3 shrink-0" />
            <span>{bi('赠送余额', 'Granted')}</span>
            <span>{details.grantedText}</span>
          </span>
        )}
        {details.extraBalances.map((eb) => (
          <span
            key={eb.currency}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-100/90 px-2 py-1 text-[10.5px] font-semibold text-slate-600 tabular-nums dark:bg-slate-800/85 dark:text-slate-300"
          >
            <span>{eb.currency}</span>
            <span>{eb.totalText}</span>
          </span>
        ))}
      </div>

      <div className="text-[10.5px] text-slate-400 dark:text-slate-500">{modeHint}</div>
    </div>
  )
}

function WindowsQuotaBody({ details, bi }) {
  const hasPools = Array.isArray(details?.pools) && details.pools.length > 1
  const hasExtras = Boolean(details?.extraCredits || details?.resetCredits)

  return (
    <div className="space-y-3">
      {hasPools ? (
        <div className="space-y-3">
          {details.pools.map((pool, poolIdx) => (
            <div
              key={pool.id}
              className={poolIdx > 0 ? 'space-y-2 border-t border-slate-100 pt-2.5 dark:border-slate-800/80' : 'space-y-2'}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      pool.id === '3p' ? 'bg-violet-500 dark:bg-violet-400' : 'bg-[#3186FF]'
                    }`}
                  />
                  <span className="truncate text-[11px] font-bold tracking-wide text-slate-600 dark:text-slate-300">
                    {pool.label}
                  </span>
                  {pool.badge && (
                    <span className="shrink-0 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[9.5px] leading-none font-semibold text-violet-600 dark:bg-violet-400/15 dark:text-violet-300">
                      {pool.badge}
                    </span>
                  )}
                </div>
              </div>
              <div className="space-y-2.5">
                {pool.windows.map((win) => (
                  <WindowMeterRow key={`${pool.id}-${win.id}`} win={win} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {(details?.windows || []).map((win) => (
            <WindowMeterRow key={win.id} win={win} />
          ))}
        </div>
      )}

      {hasExtras && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2.5 dark:border-slate-800/80">
          {details.extraCredits && (
            <span className="inline-flex items-center gap-1 rounded-lg bg-indigo-500/10 px-2 py-1 text-[10.5px] font-semibold text-indigo-700 tabular-nums dark:bg-indigo-400/15 dark:text-indigo-300">
              <Coins className="h-3 w-3 shrink-0" />
              <span>{bi('附加积分', 'Credits')}</span>
              <span>{details.extraCredits.balanceText}</span>
            </span>
          )}
          {details.resetCredits && (
            <span
              title={details.resetCredits.expiryText || bi('免费重置当前限额', 'Free rate-limit reset voucher')}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2 py-1 text-[10.5px] font-semibold text-emerald-700 tabular-nums dark:bg-emerald-400/15 dark:text-emerald-300"
            >
              <RotateCcw className="h-3 w-3 shrink-0" />
              <span>
                {bi(
                  `免费重置券 ×${details.resetCredits.availableCount}`,
                  `Free reset ×${details.resetCredits.availableCount}`,
                )}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function QuotaVendorCard({ card, selected, onSelect, bi, index, spanFullOnDesktop = false }) {
  const meta = APP_META[card.app] || APP_META.dsh
  const details = card.quotaDetails
  const tierTags = [details?.planLabel, details?.bucketLabel].filter(Boolean)

  return (
    <button
      type="button"
      onClick={() => onSelect?.(card.app)}
      style={{ animationDelay: `${Math.min(index, 5) * 45}ms` }}
      className={`animate-home-rise-1 group relative flex w-full flex-col rounded-2xl border p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.99] ${
        spanFullOnDesktop ? 'sm:col-span-2' : ''
      } ${
        selected
          ? 'border-[#4D6BFE]/65 bg-gradient-to-b from-[#F5F8FF] to-white shadow-sm shadow-[#4D6BFE]/10 ring-1 ring-[#4D6BFE]/25 dark:border-[#4D6BFE]/70 dark:from-[#1D243A] dark:to-[#191D28] dark:ring-[#4D6BFE]/30'
          : 'border-slate-200/85 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)] hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-[#1C1F28] dark:hover:border-slate-700'
      }`}
    >
      {/* Card Header */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <VendorBadge app={card.app} size="md" active={card.runningCount > 0} className="shrink-0 shadow-2xs" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[14px] font-bold text-slate-900 dark:text-white">
                {meta.shortName}
              </span>
              {tierTags.map((tag) => (
                <span
                  key={tag}
                  className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] leading-none font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-300"
                >
                  {tag}
                </span>
              ))}
            </div>
            {card.sessionCount > 0 && (
              <div className="mt-0.5 text-[10.5px] text-slate-400 dark:text-slate-500">
                {card.runningCount > 0
                  ? bi(`${card.runningCount} 个进行中 · 共 ${card.sessionCount} 个对话`, `${card.runningCount} running · ${card.sessionCount} chats`)
                  : bi(`${card.sessionCount} 个对话`, `${card.sessionCount} chats`)}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {selected ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-[#4D6BFE]/12 px-2 py-0.5 text-[10px] font-semibold text-[#3B59ED] dark:bg-[#4D6BFE]/22 dark:text-[#9BB0FF]">
              <Check className="h-2.5 w-2.5" />
              <span>{bi('当前', 'Active')}</span>
            </span>
          ) : (
            <span
              className={`h-2 w-2 rounded-full ${
                card.available ? (card.writable ? 'bg-emerald-500' : 'bg-amber-400') : 'bg-slate-300 dark:bg-slate-600'
              }`}
              title={card.writable ? bi('读写就绪', 'Read/Write') : bi('只读模式', 'Read-only')}
            />
          )}
        </div>
      </div>

      {/* Quota Body */}
      <div className="mt-auto">
        {details?.kind === 'balance' ? (
          <BalanceMeterBody details={details} card={card} bi={bi} />
        ) : details?.kind === 'credits' ? (
          <CreditsMeterBody details={details} bi={bi} />
        ) : (
          <WindowsQuotaBody details={details} bi={bi} />
        )}
      </div>
    </button>
  )
}

function OtherVendorCard({ card, selected, onSelect, bi }) {
  const meta = APP_META[card.app] || APP_META.dsh
  const hint = getOtherVendorHint(card, bi)
  return (
    <button
      type="button"
      onClick={() => onSelect?.(card.app)}
      className={`group flex w-full items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 text-left transition-all duration-150 active:scale-[0.99] ${
        selected
          ? 'border-[#4D6BFE]/65 bg-[#F5F8FF] ring-1 ring-[#4D6BFE]/20 dark:border-[#4D6BFE]/70 dark:bg-[#1D243A] dark:ring-[#4D6BFE]/25'
          : 'border-slate-200/80 bg-white/90 hover:border-slate-300 dark:border-slate-800 dark:bg-[#1C1F28]/90 dark:hover:border-slate-700'
      }`}
    >
      <VendorBadge app={card.app} size="sm" active={card.runningCount > 0} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100">
            {meta.shortName}
          </span>
          {card.sessionCount > 0 && (
            <span className="shrink-0 text-[10px] text-slate-400 tabular-nums dark:text-slate-500">
              · {card.sessionCount}
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-slate-400 dark:text-slate-500">{hint}</div>
      </div>
      {selected ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[#4D6BFE]/12 px-2 py-0.5 text-[10px] font-semibold text-[#3B59ED] dark:bg-[#4D6BFE]/22 dark:text-[#9BB0FF]">
          <Check className="h-2.5 w-2.5" />
          <span>{bi('当前', 'Active')}</span>
        </span>
      ) : (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            card.available ? (card.writable ? 'bg-emerald-500' : 'bg-amber-400') : 'bg-slate-300 dark:bg-slate-600'
          }`}
        />
      )}
    </button>
  )
}

export function HomeQuotaDashboard({
  appsStatus = [],
  sessions = [],
  activeApp = 'dsh',
  onSelectApp,
  workspaces = [],
  selectedWorkspace = '',
  onSelectWorkspace,
  onOpenNewChatModal,
  activeDeviceName = '',
  bridgeOnline = false,
  refreshingQuotas = false,
  onRefreshQuotas,
}) {
  const { lang, bi } = useI18n()
  const [nowTick, setNowTick] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const { quotaCards, otherCards, allCards } = useMemo(
    () =>
      buildHomeQuotaCards({
        appsStatus,
        sessions,
        appList: APP_LIST,
        lang,
        now: nowTick,
      }),
    [appsStatus, sessions, lang, nowTick],
  )

  const latestQuotaUpdatedAt = useMemo(() => {
    let latest = 0
    for (const c of quotaCards) {
      if (c.quotaDetails?.updatedAt > latest) latest = c.quotaDetails.updatedAt
    }
    return latest
  }, [quotaCards])

  const updatedLabel = useMemo(() => {
    if (!latestQuotaUpdatedAt) return ''
    const diffSec = Math.max(0, Math.floor((nowTick - latestQuotaUpdatedAt) / 1000))
    if (diffSec < 60) return bi('刚刚更新', 'Updated just now')
    const mins = Math.floor(diffSec / 60)
    if (mins < 60) return bi(`${mins} 分钟前更新`, `Updated ${mins}m ago`)
    const hrs = Math.floor(mins / 60)
    return bi(`${hrs} 小时前更新`, `Updated ${hrs}h ago`)
  }, [latestQuotaUpdatedAt, nowTick, bi])

  const isLoadingInitial = appsStatus.length === 0 && bridgeOnline

  return (
    <div className="mx-auto w-full max-w-2xl pt-3 pb-6 sm:pt-5 lg:max-w-3xl">
      {/* Compact Dashboard Header */}
      <div className="animate-home-rise mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-10 w-10 shrink-0 overflow-hidden rounded-[13px] bg-[#03080E] shadow-md shadow-blue-950/25 ring-1 ring-white/10">
            <img src="./icon-192.png" alt="All in One" className="h-full w-full object-cover" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[16px] font-bold tracking-tight text-slate-900 dark:text-white">
                {bi('额度总览', 'Quota Overview')}
              </h2>
              {activeDeviceName && (
                <span className="inline-flex max-w-[140px] items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      bridgeOnline ? 'bg-emerald-500' : 'bg-slate-400'
                    }`}
                  />
                  <span className="truncate">{activeDeviceName}</span>
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-slate-400 dark:text-slate-500">
              {updatedLabel
                ? updatedLabel
                : bi('点击卡片切换当前对话厂商，直接发送即可开聊', 'Tap a vendor card to select target & start chatting')}
            </p>
          </div>
        </div>

        {onRefreshQuotas && (
          <button
            type="button"
            disabled={refreshingQuotas || !bridgeOnline}
            onClick={() => onRefreshQuotas()}
            title={bi('刷新各厂商实时额度', 'Refresh live vendor quotas')}
            aria-label={bi('刷新额度', 'Refresh quotas')}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200/85 bg-white px-2.5 py-1.5 text-[11.5px] font-semibold text-slate-600 shadow-2xs transition hover:border-[#4D6BFE]/50 hover:text-[#4D6BFE] active:scale-95 disabled:opacity-45 dark:border-slate-700/80 dark:bg-[#1E212B] dark:text-slate-300 dark:hover:border-[#4D6BFE]/60 dark:hover:text-[#9BB0FF]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshingQuotas ? 'animate-spin text-[#4D6BFE]' : ''}`} />
            <span>{refreshingQuotas ? bi('刷新中', 'Syncing') : bi('刷新额度', 'Refresh')}</span>
          </button>
        )}
      </div>

      {/* Loading skeleton while initial APPS_STATUS arrives */}
      {isLoadingInitial ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-36 animate-pulse rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-800 dark:bg-[#1C1F28]/70"
            />
          ))}
        </div>
      ) : allCards.length === 0 ? (
        <div className="animate-home-rise-1 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 px-5 py-8 text-center dark:border-slate-800 dark:bg-[#1A1D26]/60">
          <Sparkles className="mx-auto mb-2 h-5 w-5 text-slate-400" />
          <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            {bridgeOnline
              ? bi('本机暂未检测到已安装的 AI 工具', 'No supported AI tools detected on this computer')
              : bi('电脑桥接离线，上线后自动展示各厂商实时额度', 'Computer bridge offline — live quotas will appear once connected')}
          </div>
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
            {bi(
              '支持 Codex · Antigravity · Claude Code · WorkBuddy · DeepSeek Harness',
              'Supports Codex · Antigravity · Claude Code · WorkBuddy · DeepSeek Harness',
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Primary Quota Cards Grid (Vendors with live 5h / weekly / credits data) */}
          {quotaCards.length > 0 && (
            <div
              className={`grid grid-cols-1 gap-3 ${
                quotaCards.length === 1 ? 'sm:grid-cols-1' : 'sm:grid-cols-2'
              }`}
            >
              {quotaCards.map((card, idx) => (
                <QuotaVendorCard
                  key={card.app}
                  card={card}
                  index={idx}
                  spanFullOnDesktop={quotaCards.length > 1 && quotaCards.length % 2 === 1 && idx === quotaCards.length - 1}
                  selected={activeApp === card.app}
                  onSelect={onSelectApp}
                  bi={bi}
                />
              ))}
            </div>
          )}

          {/* Detected Vendors Without Active Quota Metrics */}
          {otherCards.length > 0 && (
            <div className="animate-home-rise-2 space-y-2">
              {quotaCards.length > 0 && (
                <div className="px-0.5 text-[11px] font-semibold tracking-wide text-slate-400 dark:text-slate-500">
                  {bi('其他已就绪厂商', 'Other Ready Tools')}
                </div>
              )}
              <div
                className={`grid grid-cols-1 gap-2 ${
                  otherCards.length > 1 ? 'sm:grid-cols-2' : 'sm:grid-cols-1'
                }`}
              >
                {otherCards.map((card) => (
                  <OtherVendorCard
                    key={card.app}
                    card={card}
                    selected={activeApp === card.app}
                    onSelect={onSelectApp}
                    bi={bi}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Compact Target Project Selector */}
      <div className="animate-home-rise-2 mt-4 rounded-2xl border border-slate-200/75 bg-slate-50/70 px-3.5 py-3 dark:border-slate-800/80 dark:bg-[#191C24]/80">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            {selectedWorkspace ? bi('目标项目', 'Target Project') : bi('选择项目目录开始新对话', 'Select a project to start chatting')}
          </span>
          {selectedWorkspace && (
            <span
              title={selectedWorkspace}
              className="max-w-[58%] truncate font-mono text-[10px] text-slate-400 dark:text-slate-500"
            >
              {selectedWorkspace}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {workspaces.slice(0, 6).map((w) => {
            const isSel = selectedWorkspace && w.path.toLowerCase() === selectedWorkspace.toLowerCase()
            return (
              <button
                key={w.path}
                type="button"
                title={w.path}
                onClick={() => onSelectWorkspace?.(w.path)}
                className={`inline-flex max-w-[170px] items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[11.5px] font-medium transition active:scale-95 ${
                  isSel
                    ? 'border-[#4D6BFE]/65 bg-[#EEF2FF] text-[#2842C9] dark:border-[#4D6BFE]/70 dark:bg-[#222942] dark:text-[#A9BDFF]'
                    : 'border-slate-200/85 bg-white text-slate-700 hover:border-[#4D6BFE]/40 dark:border-slate-700/80 dark:bg-[#202430] dark:text-slate-200'
                }`}
              >
                <Folder className={`h-3 w-3 shrink-0 ${isSel ? 'text-[#4D6BFE]' : 'text-slate-400'}`} />
                <span className="truncate">{w.name || w.path}</span>
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => onOpenNewChatModal?.()}
            className="inline-flex items-center gap-1 rounded-xl border border-dashed border-slate-300 px-2.5 py-1 text-[11.5px] font-medium text-slate-500 transition hover:border-[#4D6BFE]/60 hover:text-[#4D6BFE] active:scale-95 dark:border-slate-700 dark:text-slate-400"
          >
            <FolderPlus className="h-3 w-3" />
            <span>{bi('选择目录', 'Choose Folder')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
