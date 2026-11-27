import React, { useEffect, useState } from 'react'
import {
  Check,
  Download,
  ExternalLink,
  Loader2,
  LogOut,
  RefreshCw,
  RotateCw,
} from 'lucide-react'
import { formatBytesCompact } from '../../lib/sessionCache.js'
import { IOS_APP_STORE_URL, RELEASES_URL, REPO_URL } from '../../lib/clientHelpers.js'
import { useI18n } from '../../lib/i18n.jsx'

function resolveLegalPageUrl(page, baseUrl = '') {
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(cleanBase)) {
    return `${cleanBase}/${page}`
  }
  const bakedRelay = String(import.meta.env?.VITE_RELAY_URL || '').trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(bakedRelay)) {
    return `${bakedRelay}/${page}`
  }
  const isNative = typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.())
  if (isNative) {
    return page === 'support.html' ? `${REPO_URL}/issues` : REPO_URL
  }
  return `./${page}`
}

export function AboutUpdatesSection({
  open,
  appVersion,
  otaInfo,
  updateState,
  onResetOtaBundle,
  onCheckUpdate,
  onDownloadUpdate,
  onCancelUpdate,
  onInstallUpdate,
  activeDevice,
  displayUser,
  onRemoveDevice,
  onClose,
}) {
  const { bi, t } = useI18n()
  const [confirmLogout, setConfirmLogout] = useState(false)

  useEffect(() => {
    if (!open) setConfirmLogout(false)
  }, [open])

  const isAppStoreUpdate = updateState?.mode === 'app-store'
  const privacyUrl = resolveLegalPageUrl('privacy.html', activeDevice?.baseUrl)
  const supportUrl = resolveLegalPageUrl('support.html', activeDevice?.baseUrl)

  const hasActionableUpdate =
    Boolean(onCheckUpdate) &&
    updateState &&
    (updateState.status === 'available' ||
      updateState.status === 'downloading' ||
      updateState.status === 'downloaded' ||
      updateState.status === 'installing' ||
      updateState.status === 'error')

  return (
    <>
      <section>
        <div className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
          {bi('关于', 'About')}
        </div>
        <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
          <div className="flex items-center justify-between gap-2.5 px-3.5 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <img
                src="./icon-192.png"
                alt="All in One"
                className="h-7 w-7 shrink-0 rounded-lg bg-[#0B0E14] ring-1 ring-white/10"
              />
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                <span>All in One</span>
                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {appVersion ? `v${appVersion}` : 'dev'}
                </span>
                {otaInfo?.isOtaActive && otaInfo?.nativeVersion && (
                  <span className="rounded-md bg-[#4D6BFE]/10 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-[#4D6BFE]">
                    {bi(`内置 v${otaInfo.nativeVersion}`, `APK v${otaInfo.nativeVersion}`)}
                  </span>
                )}
                {onCheckUpdate && updateState?.status === 'up-to-date' && (
                  <span className="inline-flex items-center gap-0.5 rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                    <Check className="h-2.5 w-2.5" />
                    <span>{bi('已最新', 'Latest')}</span>
                  </span>
                )}
              </div>
            </div>
            {onCheckUpdate ? (
              <button
                type="button"
                disabled={
                  updateState?.status === 'checking' ||
                  updateState?.status === 'downloading' ||
                  updateState?.status === 'installing'
                }
                onClick={() => onCheckUpdate()}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11.5px] font-semibold text-slate-700 transition hover:border-[#4D6BFE]/50 hover:text-[#4D6BFE] disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
              >
                <RefreshCw
                  className={`h-3 w-3 ${updateState?.status === 'checking' ? 'animate-spin text-[#4D6BFE]' : ''}`}
                />
                <span>{updateState?.status === 'checking' ? bi('检查中', 'Checking') : bi('检查更新', 'Check')}</span>
              </button>
            ) : (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300">
                {bi('自动热更新', 'Auto')}
              </span>
            )}
          </div>

          {hasActionableUpdate && (
            <div className="px-3.5 py-2.5 text-xs">
              {updateState.status === 'available' && (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-[#4D6BFE]/30 bg-[#F3F6FF] px-3 py-2 dark:border-[#4D6BFE]/35 dark:bg-[#1C2338]">
                  <div className="min-w-0">
                    <div className="font-bold text-[#2842C9] dark:text-white">
                      {!isAppStoreUpdate && updateState.nativeUpgradeRequired && !(updateState.downloadUrl && onDownloadUpdate)
                        ? bi(`需安装新包 v${updateState.latestVersion}`, `Installer update v${updateState.latestVersion}`)
                        : bi(`新版本 v${updateState.latestVersion}`, `Update v${updateState.latestVersion}`)}
                    </div>
                    {(updateState.assetSize > 0 || updateState.hotUpdate || isAppStoreUpdate) && (
                      <div className="text-[10.5px] text-slate-500 dark:text-slate-400">
                        {[
                          updateState.assetSize > 0 ? formatBytesCompact(updateState.assetSize) : '',
                          updateState.hotUpdate ? bi('热更新', 'Hot update') : '',
                          isAppStoreUpdate ? 'App Store' : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                  {updateState.downloadUrl && onDownloadUpdate ? (
                    <button
                      type="button"
                      onClick={() => onDownloadUpdate()}
                      className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-[#4D6BFE] px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-xs active:scale-95"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>{updateState.hotUpdate ? bi('立即更新', 'Update') : bi('下载', 'Download')}</span>
                    </button>
                  ) : (
                    <a
                      href={isAppStoreUpdate ? (updateState.releaseUrl || IOS_APP_STORE_URL) : (updateState.releaseUrl || RELEASES_URL)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-[#4D6BFE] px-3 py-1.5 text-[11.5px] font-semibold text-white"
                    >
                      <span>{isAppStoreUpdate ? bi('前往 App Store', 'App Store') : bi('下载安装包', 'Get Installer')}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}

              {updateState.status === 'downloading' && (
                <div className="space-y-1.5 rounded-xl border border-slate-200/80 bg-slate-50 px-3 py-2 dark:border-slate-700/80 dark:bg-[#171A23]">
                  <div className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {bi(
                        `${updateState.hotUpdate ? '热更下载中' : '下载中'} v${updateState.latestVersion} · ${updateState.percent}%`,
                        `Downloading v${updateState.latestVersion} · ${updateState.percent}%`,
                      )}
                    </span>
                    {onCancelUpdate && (
                      <button
                        type="button"
                        onClick={() => onCancelUpdate?.()}
                        className="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      >
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div
                      className="h-full rounded-full bg-[#4D6BFE] transition-all duration-200"
                      style={{ width: `${Math.max(4, Math.min(100, updateState.percent || 0))}%` }}
                    />
                  </div>
                </div>
              )}

              {updateState.status === 'downloaded' && (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-200/80 bg-emerald-50/80 px-3 py-2 dark:border-emerald-900/60 dark:bg-emerald-950/35">
                  <div className="min-w-0">
                    <div className="font-semibold text-emerald-700 dark:text-emerald-300">
                      {bi(`v${updateState.latestVersion} 已就绪`, `v${updateState.latestVersion} ready`)}
                    </div>
                    {updateState.hotUpdate && (
                      <div className="text-[10.5px] text-emerald-600/80 dark:text-emerald-400/80">
                        {bi('应用内热更新，无需重装', 'In-app hot update, no reinstall needed')}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onInstallUpdate?.()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-xs hover:bg-emerald-500 active:scale-95"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    <span>{bi('重启更新', 'Restart & Update')}</span>
                  </button>
                </div>
              )}

              {updateState.status === 'installing' && (
                <div className="flex items-center gap-2 text-[#4D6BFE]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>
                    {updateState.hotUpdate
                      ? bi('正在热更并重启...', 'Hot-updating & restarting...')
                      : bi('正在更新并重启...', 'Updating & restarting...')}
                  </span>
                </div>
              )}

              {updateState.status === 'error' && (
                <div className="flex items-center justify-between gap-2 rounded-xl bg-rose-50 px-3 py-2 text-[11px] text-rose-600 dark:bg-rose-950/45 dark:text-rose-300">
                  <span className="truncate">{updateState.error || bi('更新失败', 'Update failed')}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onCheckUpdate?.()}
                      className="font-semibold text-[#4D6BFE] hover:underline"
                    >
                      {t('common.retry')}
                    </button>
                    <a
                      href={updateState.releaseUrl || RELEASES_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-500 hover:underline dark:text-slate-300"
                    >
                      GitHub
                    </a>
                  </div>
                </div>
              )}
            </div>
          )}

          {otaInfo?.isOtaActive && onResetOtaBundle && (
            <div className="flex items-center justify-between gap-2 px-3.5 py-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span>{bi('当前正在运行热更新版本', 'Running OTA web bundle')}</span>
              <button
                type="button"
                onClick={() => void onResetOtaBundle()}
                className="shrink-0 font-semibold text-amber-600 hover:underline dark:text-amber-400"
              >
                {bi('恢复内置版本', 'Reset to bundled')}
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-around gap-y-1 px-3 py-2 text-[11.5px] font-medium text-slate-500 dark:text-slate-400">
            <a
              href={privacyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition hover:text-slate-800 dark:hover:text-slate-200"
            >
              <span>{bi('隐私政策', 'Privacy')}</span>
              <ExternalLink className="h-3 w-3 opacity-70" />
            </a>
            <span className="h-3 w-px bg-slate-200 dark:bg-slate-700" />
            <a
              href={supportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition hover:text-slate-800 dark:hover:text-slate-200"
            >
              <span>{bi('技术支持', 'Support')}</span>
              <ExternalLink className="h-3 w-3 opacity-70" />
            </a>
            <span className="h-3 w-px bg-slate-200 dark:bg-slate-700" />
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 transition hover:text-slate-800 dark:hover:text-slate-200"
            >
              <span>GitHub</span>
              <ExternalLink className="h-3 w-3 opacity-70" />
            </a>
          </div>
        </div>
      </section>

      {/* Standalone Sign Out */}
      {activeDevice?.id && onRemoveDevice && (
        <section>
          <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:border-slate-800 dark:bg-[#22252E]">
            {!confirmLogout ? (
              <button
                type="button"
                onClick={() => setConfirmLogout(true)}
                className="flex w-full items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-rose-500 transition hover:bg-rose-50/70 hover:text-rose-600 dark:hover:bg-rose-950/30"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>{bi('退出登录', 'Sign Out')}</span>
              </button>
            ) : (
              <div className="space-y-2 bg-rose-50/90 px-3.5 py-2.5 text-xs text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                <div className="flex items-center justify-between">
                  <span>{bi(`确认退出 ${displayUser}？`, `Sign out ${displayUser}?`)}</span>
                  <button
                    type="button"
                    onClick={() => setConfirmLogout(false)}
                    className="rounded-lg bg-white px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmLogout(false)
                      onClose()
                      onRemoveDevice(activeDevice.id, { revokeAll: false })
                    }}
                    className="rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-600 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
                  >
                    {bi('仅退出本设备', 'This Device')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmLogout(false)
                      onClose()
                      onRemoveDevice(activeDevice.id, { revokeAll: true })
                    }}
                    className="rounded-lg bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white"
                  >
                    {bi('退出全部设备', 'All Devices')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  )
}
