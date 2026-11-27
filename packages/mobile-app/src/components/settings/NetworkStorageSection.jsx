import React, { useEffect, useState } from 'react'
import { Check, HardDrive, Trash2, Wifi, Zap } from 'lucide-react'
import { clearSessionCache, formatBytesCompact, getSessionCacheStats } from '../../lib/sessionCache.js'
import { clearE2eeMediaCache, getPersistedMediaCacheStats } from '../../lib/e2eeMedia.js'
import { useI18n } from '../../lib/i18n.jsx'
import { HelpButton, HelpCallout, ToggleSwitch } from './SettingsPrimitives.jsx'

export function NetworkStorageSection({
  open,
  activeDevice,
  cacheScope,
  turnQuota,
  dataSaver,
  onToggleDataSaver,
  openHelpKey,
  toggleHelp,
}) {
  const { bi } = useI18n()
  const [cacheStats, setCacheStats] = useState({ sessionCount: 0, messageCount: 0, imageCount: 0, totalBytes: 0 })
  const [cacheClearedHint, setCacheClearedHint] = useState(false)

  useEffect(() => {
    if (!open) return
    Promise.all([
      getSessionCacheStats(cacheScope).catch(() => ({ sessionCount: 0, messageCount: 0, totalBytes: 0 })),
      getPersistedMediaCacheStats({ roomId: activeDevice?.roomId || '' }).catch(() => ({ imageCount: 0, totalBytes: 0 })),
    ])
      .then(([sess, media]) => {
        setCacheStats({
          sessionCount: Number(sess.sessionCount || 0),
          messageCount: Number(sess.messageCount || 0),
          imageCount: Number(media.imageCount || 0),
          totalBytes: Number(sess.totalBytes || 0) + Number(media.totalBytes || 0),
        })
      })
      .catch(() => {})
  }, [open, cacheScope, activeDevice?.roomId])

  const handleClearCache = async () => {
    await Promise.all([
      clearSessionCache(cacheScope),
      clearE2eeMediaCache({ persistent: true, roomId: activeDevice?.roomId || '' }),
    ])
    setCacheStats({ sessionCount: 0, messageCount: 0, imageCount: 0, totalBytes: 0 })
    setCacheClearedHint(true)
    setTimeout(() => setCacheClearedHint(false), 1800)
  }

  return (
    <section>
      <div className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
        {bi('网络与存储', 'Network & Storage')}
      </div>
      <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
        {activeDevice && turnQuota && (
          <div className="px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
                <Wifi
                  className={`h-3.5 w-3.5 shrink-0 ${
                    turnQuota.provider === 'cloudflare'
                      ? 'text-sky-500'
                      : turnQuota.exceeded
                        ? 'text-rose-500'
                        : turnQuota.pct >= 85
                          ? 'text-amber-500'
                          : 'text-sky-500'
                  }`}
                />
                <span className="truncate">{bi('本月加密中继', 'Monthly Relay')}</span>
                {turnQuota.provider === 'cloudflare' && (
                  <span className="shrink-0 rounded-md bg-sky-500/12 px-1.5 py-0.5 text-[9.5px] font-semibold text-sky-600 dark:text-sky-400">
                    CF Free
                  </span>
                )}
                {turnQuota.exceeded && turnQuota.provider !== 'cloudflare' && (
                  <span className="shrink-0 rounded-md bg-rose-500/12 px-1.5 py-0.5 text-[9.5px] font-semibold text-rose-500 dark:text-rose-400">
                    {bi('已达上限', 'Limit')}
                  </span>
                )}
                <HelpButton
                  active={openHelpKey === 'relayQuota'}
                  onClick={() => toggleHelp('relayQuota')}
                  label={bi('查看本月加密中继说明', 'About monthly relay quota')}
                />
              </div>
              <span
                className={`shrink-0 font-mono text-[11px] font-semibold ${
                  turnQuota.provider === 'cloudflare'
                    ? 'text-sky-600 dark:text-sky-400'
                    : turnQuota.exceeded
                      ? 'text-rose-500 dark:text-rose-400'
                      : turnQuota.pct >= 85
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-slate-500 dark:text-slate-300'
                }`}
              >
                {turnQuota.provider === 'cloudflare'
                  ? bi('CF 1TB 公益池', 'CF 1TB Pool')
                  : turnQuota.unlimited
                    ? `${formatBytesCompact(turnQuota.usedBytes)} / ${bi('不限', 'Unlimited')}`
                    : `${formatBytesCompact(turnQuota.usedBytes)} / ${formatBytesCompact(turnQuota.quotaBytes)}`}
              </span>
            </div>
            {!turnQuota.unlimited && turnQuota.provider !== 'cloudflare' && (
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all ${
                    turnQuota.exceeded ? 'bg-rose-500' : turnQuota.pct >= 85 ? 'bg-amber-500' : 'bg-sky-500'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, Number(turnQuota.pct) || 0))}%` }}
                />
              </div>
            )}
            <HelpCallout show={openHelpKey === 'relayQuota'}>
              <div>
                {turnQuota.provider === 'cloudflare'
                  ? bi(
                      '当前免费档优先 P2P 直连；遇到复杂防火墙无法直连时，自动走 Cloudflare 免费公益加密中继池，不消耗服务器流量。',
                      'Direct P2P is always preferred; when symmetric NAT blocks direct connections, traffic falls back to Cloudflare free encrypted relay.',
                    )
                  : turnQuota.exceeded
                    ? bi(
                        '本月加密中继额度已用完，当前仅支持 P2P 直连（次月 1 日自动重置，或联系管理员调整档位）。',
                        'Monthly encrypted relay limit reached — direct P2P still works without limits. Resets on the 1st of next month.',
                      )
                    : bi(
                        'P2P 点对点直连流量永久无限且免费；仅在双对称 NAT 等极端网络回落加密中继时才会计入本月额度。',
                        'Direct P2P traffic is always unlimited and free. Only fallback encrypted relay traffic on double-symmetric NAT counts toward this quota.',
                      )}
              </div>
              {turnQuota.month && (
                <div className="mt-1 font-mono text-[10px] text-slate-400">
                  {bi(`统计周期：${turnQuota.month}`, `Billing cycle: ${turnQuota.month}`)}
                </div>
              )}
            </HelpCallout>
          </div>
        )}

        {activeDevice && onToggleDataSaver && (
          <div className="px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                <Zap className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span className="truncate">{bi('智能省流模式', 'Smart Data Saver')}</span>
                <HelpButton
                  active={openHelpKey === 'dataSaver'}
                  onClick={() => toggleHelp('dataSaver')}
                  label={bi('查看智能省流模式说明', 'About smart data saver')}
                />
              </div>
              <ToggleSwitch
                checked={Boolean(dataSaver)}
                onChange={onToggleDataSaver}
                label={bi('切换智能省流模式', 'Toggle smart data saver')}
              />
            </div>
            <HelpCallout show={openHelpKey === 'dataSaver'}>
              {bi(
                '开启后统一启用两项省流优化：发送大于 200 KB 的图片自动缩放至 2048px 并转 WebP 压缩（通常可省 80%-90% 流量，跳过动图 GIF）；连接回落至加密中继时远程图片需点击再加载（P2P 直连时始终自动加载高清原图）。关闭则发送原图并自动加载全部图片。',
                'Enables two bandwidth optimizations: resizes uploaded photos/screenshots >200 KB to max 2048px WebP (saves 80%-90% traffic, skips GIFs), and loads remote images on tap when on fallback relay (direct P2P always auto-loads). Turn off for raw originals and auto-loading everywhere.',
              )}
            </HelpCallout>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
            <HardDrive className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="shrink-0">{bi('本地缓存', 'Cache')}</span>
            <span className="truncate text-[11px] font-normal text-slate-400">
              {cacheClearedHint
                ? bi('已清理', 'Cleared')
                : cacheStats.imageCount > 0
                  ? `${cacheStats.sessionCount} ${bi('会话', 'chats')} · ${cacheStats.imageCount} ${bi('图片', 'imgs')} · ${formatBytesCompact(cacheStats.totalBytes)}`
                  : `${cacheStats.sessionCount} ${bi('会话', 'chats')} · ${formatBytesCompact(cacheStats.totalBytes)}`}
            </span>
          </div>
          <button
            type="button"
            disabled={cacheStats.sessionCount === 0 && cacheStats.imageCount === 0}
            onClick={handleClearCache}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-rose-900/60 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
          >
            {cacheClearedHint ? <Check className="h-3 w-3 text-emerald-500" /> : <Trash2 className="h-3 w-3" />}
            <span>{cacheClearedHint ? bi('已清理', 'Done') : bi('清理', 'Clear')}</span>
          </button>
        </div>
      </div>
    </section>
  )
}
