import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, MoreHorizontal } from 'lucide-react'
import { VendorIcon } from './VendorIcon.jsx'
import { formatQuotaBadgeText, formatQuotaTooltip } from '../lib/sidebarVendors.js'
import { useI18n } from '../lib/i18n.jsx'

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

/**
 * Single reusable vendor tile with optional conic-gradient subscription quota ring
 * and optional overflow corner indicator (eliminates 3x duplicated ring JSX).
 */
function VendorTileButton({
  vendor,
  active,
  tooltip,
  badgeText,
  pct,
  tone,
  showOverflowBadge = false,
  ariaHasPopup = false,
  ariaExpanded,
  onClick,
}) {
  if (pct !== null && tone && badgeText) {
    return (
      <button
        type="button"
        title={tooltip}
        aria-label={tooltip}
        {...(ariaHasPopup ? { 'aria-haspopup': 'menu', 'aria-expanded': ariaExpanded } : {})}
        onClick={onClick}
        className={`group relative h-11 rounded-xl p-[2px] transition-all duration-150 hover:-translate-y-0.5 active:scale-95 ${
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
              style={{ backgroundColor: `${vendor.color}24` }}
            />
          )}
          <span className="relative z-10 flex flex-col items-center justify-center gap-0.5">
            <VendorIcon app={vendor.id} size={16} active={Boolean(vendor.hasRunning)} />
            <span className={`text-[10px] leading-none font-semibold tabular-nums ${tone.text}`}>
              {badgeText}
            </span>
          </span>
          {showOverflowBadge && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0.5 right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-slate-900/12 text-slate-600 dark:bg-white/15 dark:text-slate-200"
            >
              <MoreHorizontal className="h-2.5 w-2.5" />
            </span>
          )}
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      {...(ariaHasPopup ? { 'aria-haspopup': 'menu', 'aria-expanded': ariaExpanded } : {})}
      onClick={onClick}
      className={`relative flex h-11 flex-col items-center justify-center rounded-xl border transition-all duration-150 hover:-translate-y-0.5 active:scale-95 ${
        active
          ? 'border-transparent shadow-xs'
          : 'border-slate-200/70 bg-white text-slate-500 hover:bg-slate-100 dark:border-slate-700/70 dark:bg-[#242731] dark:text-slate-300 dark:hover:bg-[#2B2F3B]'
      }`}
      style={
        active
          ? {
              backgroundColor: `${vendor.color}1F`,
              borderColor: `${vendor.color}66`,
              color: vendor.color,
            }
          : undefined
      }
    >
      <VendorIcon
        app={vendor.id}
        size={vendor.id === 'all' ? 17 : 19}
        mono={vendor.id === 'all'}
        active={vendor.id !== 'all' && Boolean(vendor.hasRunning)}
      />
      {showOverflowBadge && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0.5 right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-slate-900/12 text-slate-600 dark:bg-white/15 dark:text-slate-200"
        >
          <MoreHorizontal className="h-2.5 w-2.5" />
        </span>
      )}
    </button>
  )
}

export const VendorQuotaRings = React.memo(function VendorQuotaRings({
  drawerOpen,
  showFilterBar,
  allTab,
  visibleVendors,
  overflowVendors,
  soleQuotaTab,
  filterApp,
  onSelectFilterApp,
}) {
  const { lang, bi } = useI18n()
  const [moreVendorsOpen, setMoreVendorsOpen] = useState(false)
  const moreVendorsRef = useRef(null)

  useEffect(() => {
    if (!drawerOpen) setMoreVendorsOpen(false)
  }, [drawerOpen])

  useEffect(() => {
    if (overflowVendors.length === 0 && moreVendorsOpen) {
      setMoreVendorsOpen(false)
    }
  }, [overflowVendors.length, moreVendorsOpen])

  useEffect(() => {
    if (!moreVendorsOpen) return undefined
    const handlePointerDown = (e) => {
      if (moreVendorsRef.current && !moreVendorsRef.current.contains(e.target)) {
        setMoreVendorsOpen(false)
      }
    }
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMoreVendorsOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown, { passive: true })
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [moreVendorsOpen])

  const activeOverflowVendor = useMemo(
    () => overflowVendors.find((v) => v.id === filterApp) || null,
    [overflowVendors, filterApp],
  )
  const hasRunningOverflow = useMemo(
    () => overflowVendors.some((v) => v.hasRunning),
    [overflowVendors],
  )

  if (showFilterBar) {
    const inlineTabs = [allTab, ...visibleVendors]
    const totalCols = inlineTabs.length + (overflowVendors.length > 0 ? 1 : 0)
    const overflowNames = overflowVendors.map((v) => v.label).join(lang === 'zh' ? '、' : ', ')
    const activeOverflowQuota = activeOverflowVendor?.quota || null
    const activeOverflowPct = activeOverflowQuota
      ? Math.max(0, Math.min(100, Math.round(activeOverflowQuota.remainingPercent ?? 100)))
      : null
    const activeOverflowTone = activeOverflowPct !== null ? getQuotaTone(activeOverflowPct) : null
    const activeOverflowBadge = activeOverflowQuota
      ? formatQuotaBadgeText(activeOverflowQuota, { compact: true, lang })
      : ''
    const moreTooltip = activeOverflowVendor
      ? `${formatQuotaTooltip(activeOverflowVendor.label, activeOverflowQuota, lang)} · ${bi('点击切换更多厂商', 'Click to switch more tools')}`
      : bi(`更多厂商（${overflowNames}）`, `More tools (${overflowNames})`)

    return (
      <div ref={moreVendorsRef} className="relative px-4 pb-2">
        <div
          className="grid gap-1.5"
          style={{ gridTemplateColumns: `repeat(${totalCols}, minmax(0, 1fr))` }}
        >
          {inlineTabs.map((tab) => {
            const active = filterApp === tab.id
            const quota = tab.id !== 'all' ? tab.quota || null : null
            const pct = quota ? Math.max(0, Math.min(100, Math.round(quota.remainingPercent ?? 100))) : null
            const tone = pct !== null ? getQuotaTone(pct) : null
            const badgeText = quota ? formatQuotaBadgeText(quota, { compact: true, lang }) : ''
            const tooltip = formatQuotaTooltip(tab.label, quota, lang)

            return (
              <VendorTileButton
                key={tab.id}
                vendor={tab}
                active={active}
                tooltip={tooltip}
                badgeText={badgeText}
                pct={pct}
                tone={tone}
                onClick={() => {
                  setMoreVendorsOpen(false)
                  onSelectFilterApp(active && tab.id !== 'all' ? 'all' : tab.id)
                }}
              />
            )
          })}

          {overflowVendors.length > 0 && (
            activeOverflowVendor ? (
              <VendorTileButton
                vendor={activeOverflowVendor}
                active={true}
                tooltip={moreTooltip}
                badgeText={activeOverflowBadge}
                pct={activeOverflowPct}
                tone={activeOverflowTone}
                showOverflowBadge={true}
                ariaHasPopup={true}
                ariaExpanded={moreVendorsOpen}
                onClick={() => setMoreVendorsOpen((v) => !v)}
              />
            ) : (
              <button
                type="button"
                title={moreTooltip}
                aria-label={moreTooltip}
                aria-haspopup="menu"
                aria-expanded={moreVendorsOpen}
                onClick={() => setMoreVendorsOpen((v) => !v)}
                className={`relative flex h-11 flex-col items-center justify-center rounded-xl border transition active:scale-95 ${
                  moreVendorsOpen
                    ? 'border-[#4D6BFE]/50 bg-[#4D6BFE]/12 text-[#4D6BFE] shadow-xs dark:border-[#4D6BFE]/60 dark:bg-[#4D6BFE]/20 dark:text-[#9AB0FF]'
                    : 'border-slate-200/70 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700/70 dark:bg-[#242731] dark:text-slate-300 dark:hover:bg-[#2B2F3B]'
                }`}
              >
                <MoreHorizontal className="h-4.5 w-4.5" />
                {hasRunningOverflow && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-dot"
                  />
                )}
              </button>
            )
          )}
        </div>

        {moreVendorsOpen && overflowVendors.length > 0 && (
          <div
            role="menu"
            aria-label={bi('更多厂商', 'More tools')}
            className="animate-pop-in absolute top-full right-4 z-30 mt-1 w-56 rounded-2xl border border-slate-200/90 bg-white/98 p-1.5 shadow-xl backdrop-blur-md dark:border-slate-700/80 dark:bg-[#232631]/98"
          >
            <div className="px-2.5 pt-1 pb-1 text-[10.5px] font-medium text-slate-400 dark:text-slate-500">
              {bi('更多厂商', 'More tools')}
            </div>
            <div className="space-y-0.5">
              {overflowVendors.map((tab) => {
                const active = filterApp === tab.id
                const pct = tab.quota
                  ? Math.max(0, Math.min(100, Math.round(tab.quota.remainingPercent ?? 100)))
                  : null
                const tone = pct !== null ? getQuotaTone(pct) : null
                const tooltip = formatQuotaTooltip(tab.label, tab.quota, lang)
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    title={tooltip}
                    onClick={() => {
                      onSelectFilterApp(active ? 'all' : tab.id)
                      setMoreVendorsOpen(false)
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs transition ${
                      active
                        ? 'font-semibold text-slate-900 dark:text-white'
                        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800/80'
                    }`}
                    style={active ? { backgroundColor: `${tab.color}1A` } : undefined}
                  >
                    <VendorIcon app={tab.id} size={17} active={Boolean(tab.hasRunning)} />
                    <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                    {tab.hasRunning && (
                      <span
                        title={bi('运行中', 'Running')}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 animate-pulse-dot"
                      />
                    )}
                    {pct !== null && tone && (
                      <span className={`shrink-0 text-[10.5px] font-semibold tabular-nums ${tone.text}`}>
                        {formatQuotaBadgeText(tab.quota, { compact: false, lang })}
                      </span>
                    )}
                    {tab.sessionCount > 0 && (
                      <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        {tab.sessionCount}
                      </span>
                    )}
                    {active && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: tab.color }} />}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  }

  if (soleQuotaTab) {
    const pct = Math.max(0, Math.min(100, Math.round(soleQuotaTab.quota.remainingPercent ?? 100)))
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
              {formatQuotaBadgeText(soleQuotaTab.quota, { compact: false, lang, showTotal: true })}
            </span>
          </div>
        </div>
      </div>
    )
  }

  return null
})
