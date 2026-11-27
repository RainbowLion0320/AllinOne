import React from 'react'
import {
  Activity,
  ChevronRight,
  ExternalLink,
  FileText,
  Globe,
  Laptop,
  Moon,
  Power,
  Sun,
} from 'lucide-react'
import { useI18n } from '../../lib/i18n.jsx'
import { ToggleSwitch } from './SettingsPrimitives.jsx'

export function AppearanceDesktopSection({
  darkMode,
  onToggleDark,
  desktopApi,
  desktopBridge,
  onToggleDesktopBridge,
  onToggleDesktopAutoLaunch,
  onOpenDesktopLog,
  isAdmin,
  activeDevice,
  onClose,
}) {
  const { lang, setLang, bi } = useI18n()

  const bridgeBadge = (() => {
    if (!desktopBridge) return null
    if (desktopBridge.state === 'connected') {
      return { text: bi('已连接', 'Online'), cls: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' }
    }
    if (desktopBridge.state === 'starting' || desktopBridge.state === 'binding') {
      return { text: bi('连接中', 'Connecting'), cls: 'bg-amber-500/12 text-amber-600 dark:text-amber-400' }
    }
    if (desktopBridge.state === 'paused') {
      return { text: bi('已暂停', 'Paused'), cls: 'bg-slate-200/80 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }
    }
    if (desktopBridge.state === 'error') {
      return { text: bi('异常', 'Error'), cls: 'bg-rose-500/12 text-rose-600 dark:text-rose-400' }
    }
    return null
  })()

  const hasAdminTools = Boolean(isAdmin && activeDevice?.baseUrl)

  return (
    <>
      {/* Appearance & Language */}
      <section>
        <div className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
          {bi('外观与语言', 'Appearance & Language')}
        </div>
        <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
          <div className="flex items-center justify-between px-3.5 py-2.5">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
              {darkMode ? <Moon className="h-3.5 w-3.5 text-[#4D6BFE]" /> : <Sun className="h-3.5 w-3.5 text-amber-500" />}
              <span>{bi('主题', 'Theme')}</span>
            </div>
            <div className="inline-flex rounded-xl bg-slate-100 p-0.5 text-xs dark:bg-[#161820]">
              <button
                type="button"
                onClick={() => darkMode && onToggleDark?.()}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-medium transition ${
                  !darkMode
                    ? 'bg-white text-slate-900 shadow-2xs dark:bg-[#2C303D] dark:text-white'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                <Sun className="h-3 w-3" />
                <span>{bi('浅色', 'Light')}</span>
              </button>
              <button
                type="button"
                onClick={() => !darkMode && onToggleDark?.()}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-medium transition ${
                  darkMode
                    ? 'bg-white text-slate-900 shadow-2xs dark:bg-[#2C303D] dark:text-white'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                <Moon className="h-3 w-3" />
                <span>{bi('深色', 'Dark')}</span>
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between px-3.5 py-2.5">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
              <Globe className="h-3.5 w-3.5 text-[#4D6BFE]" />
              <span>{bi('语言', 'Language')}</span>
            </div>
            <div className="inline-flex rounded-xl bg-slate-100 p-0.5 text-xs dark:bg-[#161820]">
              <button
                type="button"
                onClick={() => setLang('zh')}
                className={`rounded-lg px-2.5 py-1 font-medium transition ${
                  lang === 'zh'
                    ? 'bg-white text-slate-900 shadow-2xs dark:bg-[#2C303D] dark:text-white'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                中文
              </button>
              <button
                type="button"
                onClick={() => setLang('en')}
                className={`rounded-lg px-2.5 py-1 font-medium transition ${
                  lang === 'en'
                    ? 'bg-white text-slate-900 shadow-2xs dark:bg-[#2C303D] dark:text-white'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                English
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Desktop Controls (Electron only) */}
      {desktopApi && (
        <section>
          <div className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
            {bi('桌面端', 'Desktop')}
          </div>
          <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-100">
                <Laptop className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE]" />
                <span className="truncate">{bi('本机后台桥接', 'Local Bridge')}</span>
                {bridgeBadge && (
                  <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${bridgeBadge.cls}`}>
                    {bridgeBadge.text}
                  </span>
                )}
              </div>
              <ToggleSwitch
                checked={Boolean(desktopBridge?.enabled)}
                onChange={() => onToggleDesktopBridge?.()}
                label={bi('切换本机后台桥接', 'Toggle local bridge')}
              />
            </div>

            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-100">
                <Power className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span>{bi('开机自启', 'Launch at Login')}</span>
              </div>
              <ToggleSwitch
                checked={Boolean(desktopBridge?.autoLaunch)}
                onChange={() => onToggleDesktopAutoLaunch?.()}
                label={bi('切换开机自启', 'Toggle launch at login')}
              />
            </div>

            {onOpenDesktopLog && (
              <button
                type="button"
                onClick={() => onOpenDesktopLog()}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
              >
                <span className="inline-flex items-center gap-2">
                  <FileText className="h-3.5 w-3.5 text-slate-400" />
                  <span>{bi('桥接日志', 'Bridge Logs')}</span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
              </button>
            )}
          </div>
        </section>
      )}

      {/* Admin Tools */}
      {hasAdminTools && (
        <section>
          <div className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
            {bi('管理', 'Admin')}
          </div>
          <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
            {activeDevice?.baseUrl && (
              <a
                href={`${String(activeDevice.baseUrl).replace(/\/+$/, '')}/admin`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setTimeout(() => onClose?.(), 0)}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
              >
                <span className="inline-flex items-center gap-2">
                  <Activity className="h-3.5 w-3.5 text-emerald-500" />
                  <span>{bi('服务器监控看板', 'Server Monitor')}</span>
                </span>
                <ExternalLink className="h-3.5 w-3.5 text-slate-400" />
              </a>
            )}
          </div>
        </section>
      )}
    </>
  )
}
