import React, { useEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Globe,
  HardDrive,
  Laptop,
  Loader2,
  LogOut,
  Mail,
  Monitor,
  Moon,
  Power,
  RefreshCw,
  RotateCw,
  Settings,
  Share2,
  Sun,
  Ticket,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { clearSessionCache, formatBytesCompact, getSessionCacheStats } from '../lib/sessionCache.js'
import { useI18n } from '../lib/i18n.jsx'
import { bi as biLang } from '../lib/i18n.js'

const REPO_URL = 'https://github.com/RainbowLion0320/AllinOne'
const RELEASES_URL =
  String(import.meta.env.VITE_RELEASES_URL || '').trim() ||
  'https://github.com/RainbowLion0320/AllinOne/releases/latest'

function formatPlatformTitle(desktopApi, lang) {
  if (!desktopApi) return 'Web / PWA'
  if (desktopApi.platform === 'darwin') return biLang(lang, 'macOS 桌面端', 'macOS Desktop')
  if (desktopApi.platform === 'win32') return biLang(lang, 'Windows 桌面端', 'Windows Desktop')
  return biLang(lang, 'Linux 桌面端', 'Linux Desktop')
}

function ToggleSwitch({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-[#4D6BFE]' : 'bg-slate-300 dark:bg-slate-700'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow-xs transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

export function SettingsModal({
  open,
  onClose,
  activeDevice = null,
  activeDeviceName = '',
  isAccountMode = false,
  isAdmin = false,
  emailEnabled = false,
  connState = 'disconnected',
  bridgeOnline = false,
  darkMode = false,
  onToggleDark,
  cacheScope = '',
  desktopApi = null,
  desktopBridge = null,
  onToggleDesktopBridge = null,
  onToggleDesktopAutoLaunch = null,
  onOpenDesktopLog = null,
  updateState = null,
  onCheckUpdate = null,
  onDownloadUpdate = null,
  onCancelUpdate = null,
  onInstallUpdate = null,
  onOpenDeviceSwitcher = null,
  onOpenShare = null,
  onOpenInviteManager = null,
  onSendBindEmailCode = null,
  onBindAccountEmail = null,
  onRemoveDevice = null,
}) {
  const { lang, setLang, bi, t } = useI18n()
  const [cacheStats, setCacheStats] = useState({ sessionCount: 0, messageCount: 0, totalBytes: 0 })
  const [cacheClearedHint, setCacheClearedHint] = useState(false)

  const [showEmailForm, setShowEmailForm] = useState(false)
  const [emailDraft, setEmailDraft] = useState('')
  const [emailCodeDraft, setEmailCodeDraft] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailBinding, setEmailBinding] = useState(false)
  const [emailCooldown, setEmailCooldown] = useState(0)
  const [emailInfo, setEmailInfo] = useState('')
  const [emailError, setEmailError] = useState('')

  const [confirmLogout, setConfirmLogout] = useState(false)

  useEffect(() => {
    if (!open) return
    setShowEmailForm(false)
    setConfirmLogout(false)
    setEmailInfo('')
    setEmailError('')
    getSessionCacheStats(cacheScope).then(setCacheStats).catch(() => {})
  }, [open, cacheScope])

  useEffect(() => {
    if (emailCooldown <= 0) return undefined
    const timer = setTimeout(() => {
      setEmailCooldown((prev) => (prev > 1 ? prev - 1 : 0))
    }, 1000)
    return () => clearTimeout(timer)
  }, [emailCooldown])

  if (!open) return null

  const appVersion =
    desktopApi?.version ||
    (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) ||
    '0.3.6'

  const displayUser = activeDevice?.username
    ? `@${activeDevice.username}`
    : activeDeviceName || bi('本地设备', 'Local Device')
  const serverDisplay = String(activeDevice?.baseUrl || '').replace(/^https?:\/\//i, '')
  const boundEmail = activeDevice?.email || ''

  const handleClearCache = async () => {
    await clearSessionCache(cacheScope)
    setCacheStats({ sessionCount: 0, messageCount: 0, totalBytes: 0 })
    setCacheClearedHint(true)
    setTimeout(() => setCacheClearedHint(false), 1800)
  }

  const handleSendBindCode = async () => {
    if (!onSendBindEmailCode || emailSending || emailCooldown > 0) return
    const clean = emailDraft.trim()
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
      setEmailError(bi('请输入有效的邮箱地址', 'Please enter a valid email address'))
      return
    }
    setEmailSending(true)
    setEmailError('')
    setEmailInfo('')
    try {
      const res = await onSendBindEmailCode(clean)
      setEmailCooldown(res?.cooldownSec || 60)
      setEmailInfo(res?.message || bi('验证码已发送，请查收邮件', 'Verification code sent. Please check your inbox.'))
    } catch (err) {
      if (err?.retryAfterSec) setEmailCooldown(err.retryAfterSec)
      setEmailError(String(err?.message || err))
    } finally {
      setEmailSending(false)
    }
  }

  const handleCommitBindEmail = async (e) => {
    e.preventDefault()
    if (!onBindAccountEmail || emailBinding) return
    const clean = emailDraft.trim()
    const code = emailCodeDraft.trim()
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
      setEmailError(bi('请输入有效的邮箱地址', 'Please enter a valid email address'))
      return
    }
    if (!/^\d{6}$/.test(code)) {
      setEmailError(bi('请输入 6 位邮箱验证码', 'Please enter the 6-digit verification code'))
      return
    }
    setEmailBinding(true)
    setEmailError('')
    try {
      await onBindAccountEmail(clean, code)
      setShowEmailForm(false)
      setEmailDraft('')
      setEmailCodeDraft('')
    } catch (err) {
      setEmailError(String(err?.message || err))
    } finally {
      setEmailBinding(false)
    }
  }

  const bridgeStatusText = (() => {
    if (!desktopBridge) return bi('未初始化', 'Not initialized')
    if (desktopBridge.state === 'connected') return `${bi('已连接', 'Connected')} · ${desktopBridge.label || bi('本机', 'This PC')}`
    if (desktopBridge.state === 'starting' || desktopBridge.state === 'binding') return bi('连接中...', 'Connecting...')
    if (desktopBridge.state === 'paused') return bi('已暂停', 'Paused')
    if (desktopBridge.state === 'error') return bi(`异常：${desktopBridge.error || '请查看日志'}`, `Error: ${desktopBridge.error || 'Check log'}`)
    return bi('未登录账号', 'Not signed in')
  })()

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="pb-safe flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-3xl bg-[#F8F9FC] shadow-2xl sm:rounded-3xl dark:bg-[#1B1D23]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200/80 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Settings className="h-4 w-4" />
            </div>
            <h2 className="text-[15.5px] font-bold text-slate-900 dark:text-white">{t('common.settings')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={bi('关闭设置', 'Close settings')}
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {/* Section 1: User Account */}
          <section>
            <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
              {bi('账号与用户信息', 'Account & Profile')}
            </div>
            <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:border-slate-800 dark:bg-[#22252E]">
              {/* Profile summary */}
              <div className="flex items-center gap-3 px-4 py-3.5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#4D6BFE]/15 text-sm font-bold text-[#4D6BFE]">
                  {activeDevice?.username
                    ? activeDevice.username.slice(0, 1).toUpperCase()
                    : <User className="h-4.5 w-4.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-bold text-slate-900 dark:text-white">
                      {displayUser}
                    </span>
                    {isAdmin && (
                      <span className="shrink-0 rounded-md bg-[#4D6BFE]/14 px-1.5 py-0.5 text-[10px] font-semibold text-[#4D6BFE]">
                        {t('common.admin')}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        connState === 'connected' && bridgeOnline
                          ? 'bg-emerald-500'
                          : connState === 'connecting'
                            ? 'bg-amber-400'
                            : 'bg-slate-400'
                      }`}
                    />
                    <span className="truncate">{serverDisplay || bi('默认服务器', 'Default server')}</span>
                  </div>
                </div>
                {onOpenDeviceSwitcher && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      onOpenDeviceSwitcher()
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11.5px] font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <Monitor className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('电脑与账号', 'Computers')}</span>
                  </button>
                )}
              </div>

              {/* Email row (account mode) */}
              {isAccountMode && (
                <div className="border-t border-slate-100 px-4 py-2.5 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                      <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <span className="truncate">
                        {boundEmail || bi('未绑定邮箱（可选，用于找回密码）', 'No email linked (optional, for password reset)')}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowEmailForm((v) => !v)
                        setEmailError('')
                        setEmailInfo('')
                      }}
                      className="shrink-0 rounded-lg px-2 py-1 text-[11.5px] font-medium text-[#4D6BFE] hover:bg-[#4D6BFE]/10"
                    >
                      {showEmailForm ? bi('收起', 'Hide') : boundEmail ? bi('换绑', 'Change') : bi('绑定邮箱', 'Link Email')}
                    </button>
                  </div>

                  {showEmailForm && (
                    <div className="mt-2.5 rounded-xl border border-slate-200/80 bg-slate-50/90 p-3 dark:border-slate-700/80 dark:bg-[#171921]">
                      {emailEnabled ? (
                        <form onSubmit={handleCommitBindEmail} className="space-y-2">
                          <input
                            type="email"
                            value={emailDraft}
                            onChange={(e) => setEmailDraft(e.target.value)}
                            placeholder={boundEmail ? bi(`新邮箱（当前：${boundEmail}）`, `New email (current: ${boundEmail})`) : bi('输入要绑定的邮箱地址', 'Enter email address')}
                            autoComplete="email"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1E212B] dark:text-white"
                          />
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={6}
                              value={emailCodeDraft}
                              onChange={(e) => setEmailCodeDraft(e.target.value.replace(/\D/g, '').slice(0, 6))}
                              placeholder={bi('6 位验证码', '6-digit code')}
                              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs tracking-widest text-slate-900 outline-none placeholder:font-sans placeholder:tracking-normal focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1E212B] dark:text-white"
                            />
                            <button
                              type="button"
                              disabled={emailSending || emailCooldown > 0}
                              onClick={handleSendBindCode}
                              className="shrink-0 rounded-xl border border-[#4D6BFE]/40 bg-[#F2F5FF] px-2.5 py-2 text-[11px] font-semibold text-[#2842C9] disabled:opacity-55 dark:bg-[#1E253A] dark:text-[#A9BDFF]"
                            >
                              {emailSending ? bi('发送中', 'Sending') : emailCooldown > 0 ? `${emailCooldown}s` : bi('获取验证码', 'Send Code')}
                            </button>
                          </div>
                          {emailInfo && (
                            <div className="rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                              {emailInfo}
                            </div>
                          )}
                          {emailError && (
                            <div className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
                              {emailError}
                            </div>
                          )}
                          <div className="flex justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setShowEmailForm(false)}
                              className="rounded-lg px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-slate-800"
                            >
                              {t('common.cancel')}
                            </button>
                            <button
                              type="submit"
                              disabled={emailBinding}
                              className="inline-flex items-center gap-1 rounded-lg bg-[#4D6BFE] px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
                            >
                              {emailBinding && <Loader2 className="h-3 w-3 animate-spin" />}
                              <span>{bi('确认绑定', 'Confirm')}</span>
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                          {bi(
                            '当前服务器尚未配置邮件服务（SMTP / Resend）。管理员在中转服务器 `.env` 配置发信参数并重启后即可自助绑定邮箱和找回密码。',
                            'Email service (SMTP / Resend) is not configured on this server yet. Configure SMTP/Resend in the relay server `.env` to enable email linking and password reset.',
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Sign out */}
              {activeDevice?.id && onRemoveDevice && (
                <div className="border-t border-slate-100 px-4 py-2.5 dark:border-slate-800">
                  {!confirmLogout ? (
                    <button
                      type="button"
                      onClick={() => setConfirmLogout(true)}
                      className="flex w-full items-center justify-between text-xs font-medium text-rose-500 hover:text-rose-600"
                    >
                      <span className="inline-flex items-center gap-2">
                        <LogOut className="h-3.5 w-3.5" />
                        <span>{bi('退出当前登录', 'Sign Out')}</span>
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 opacity-60" />
                    </button>
                  ) : (
                    <div className="space-y-2 rounded-xl bg-rose-50/90 px-3 py-2.5 text-xs text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
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
                          {bi('仅退出本设备', 'This Device Only')}
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
                          {bi('退出并吊销全部设备', 'Sign Out All Devices')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Section 2: Appearance & Language */}
          <section>
            <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
              {bi('外观与语言', 'Appearance & Language')}
            </div>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                  {darkMode ? (
                    <Moon className="h-4 w-4 text-[#4D6BFE]" />
                  ) : (
                    <Sun className="h-4 w-4 text-amber-500" />
                  )}
                  <span>{bi('主题模式', 'Theme')}</span>
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
                    <Sun className="h-3.5 w-3.5" />
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
                    <Moon className="h-3.5 w-3.5" />
                    <span>{bi('深色', 'Dark')}</span>
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                  <Globe className="h-4 w-4 text-[#4D6BFE]" />
                  <span>{bi('界面语言', 'Language')}</span>
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

          {/* Section 3: Desktop App Controls (Electron only) */}
          {desktopApi && (
            <section>
              <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
                {bi('本机桌面端', 'Desktop App')}
              </div>
              <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-100">
                      <Laptop className="h-4 w-4 shrink-0 text-[#4D6BFE]" />
                      <span>{bi('本机后台桥接', 'Local Background Bridge')}</span>
                    </div>
                    <div className="mt-0.5 truncate pl-6 text-[11px] text-slate-400">
                      {bridgeStatusText}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={Boolean(desktopBridge?.enabled)}
                    onChange={() => onToggleDesktopBridge?.()}
                    label={bi('切换本机后台桥接', 'Toggle local background bridge')}
                  />
                </div>

                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-100">
                    <Power className="h-4 w-4 shrink-0 text-slate-400" />
                    <span>{bi('开机自动启动', 'Launch at Login')}</span>
                  </div>
                  <ToggleSwitch
                    checked={Boolean(desktopBridge?.autoLaunch)}
                    onChange={() => onToggleDesktopAutoLaunch?.()}
                    label={bi('切换开机自动启动', 'Toggle launch at login')}
                  />
                </div>

                {onOpenDesktopLog && (
                  <button
                    type="button"
                    onClick={() => onOpenDesktopLog()}
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
                  >
                    <span className="inline-flex items-center gap-2">
                      <FileText className="h-4 w-4 text-slate-400" />
                      <span>{bi('查看本机桥接日志', 'View Local Bridge Logs')}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Section 4: Share & Invites */}
          <section>
            <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
              {bi('分享与管理', 'Sharing & Admin')}
            </div>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
              {onOpenShare && (
                <button
                  type="button"
                  onClick={() => {
                    onClose()
                    onOpenShare()
                  }}
                  className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
                >
                  <span className="inline-flex items-center gap-2">
                    <Share2 className="h-4 w-4 text-[#4D6BFE]" />
                    <span>{bi('分享 All in One / 安装包下载', 'Share All in One / Downloads')}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </button>
              )}
              {isAdmin && onOpenInviteManager && (
                <button
                  type="button"
                  onClick={() => {
                    onClose()
                    onOpenInviteManager()
                  }}
                  className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
                >
                  <span className="inline-flex items-center gap-2">
                    <Ticket className="h-4 w-4 text-[#4D6BFE]" />
                    <span>{bi('邀请码管理', 'Invite Codes')}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </button>
              )}
            </div>
          </section>

          {/* Section 5: Local Storage & Cache */}
          <section>
            <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
              {bi('本地存储', 'Local Storage')}
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 dark:border-slate-800 dark:bg-[#22252E]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-100">
                  <HardDrive className="h-4 w-4 shrink-0 text-slate-400" />
                  <span>{bi('会话历史缓存', 'Session History Cache')}</span>
                </div>
                <div className="mt-0.5 pl-6 text-[11px] text-slate-400">
                  {cacheClearedHint
                    ? bi('已清空本设备本地缓存', 'Local cache cleared')
                    : bi(
                        `已缓存 ${cacheStats.sessionCount} 个会话 · ${formatBytesCompact(cacheStats.totalBytes)}`,
                        `${cacheStats.sessionCount} cached chat${cacheStats.sessionCount === 1 ? '' : 's'} · ${formatBytesCompact(cacheStats.totalBytes)}`,
                      )}
                </div>
              </div>
              <button
                type="button"
                disabled={cacheStats.sessionCount === 0}
                onClick={handleClearCache}
                className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11.5px] font-medium text-slate-600 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-rose-900/60 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
              >
                {cacheClearedHint ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Trash2 className="h-3.5 w-3.5" />}
                <span>{cacheClearedHint ? bi('已清理', 'Cleared') : bi('清理', 'Clear')}</span>
              </button>
            </div>
          </section>

          {/* Section 6: About & Built-in Updater */}
          <section>
            <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
              {bi('关于与更新', 'About & Updates')}
            </div>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <img
                    src="./icon-192.png"
                    alt="All in One"
                    className="h-8 w-8 rounded-xl bg-[#03080E] ring-1 ring-white/10"
                  />
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                      <span>All in One</span>
                      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        v{appVersion}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {formatPlatformTitle(desktopApi, lang)} · MIT Open Source
                    </div>
                  </div>
                </div>
                {desktopApi && onCheckUpdate ? (
                  <button
                    type="button"
                    disabled={
                      updateState?.status === 'checking' ||
                      updateState?.status === 'downloading' ||
                      updateState?.status === 'installing'
                    }
                    onClick={() => onCheckUpdate()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-[11.5px] font-semibold text-slate-700 transition hover:border-[#4D6BFE]/50 hover:text-[#4D6BFE] disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${updateState?.status === 'checking' ? 'animate-spin text-[#4D6BFE]' : ''}`}
                    />
                    <span>{updateState?.status === 'checking' ? bi('检查中...', 'Checking...') : bi('检查更新', 'Check Updates')}</span>
                  </button>
                ) : (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300">
                    {bi('自动热更新', 'Auto-updating')}
                  </span>
                )}
              </div>

              {/* Desktop in-app updater status & 1-click download/install panel */}
              {desktopApi && updateState && updateState.status !== 'idle' && (
                <div className="px-4 py-3 text-xs">
                  {updateState.status === 'checking' && (
                    <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#4D6BFE]" />
                      <span>{bi('正在从 GitHub Releases 检查最新版本...', 'Checking GitHub Releases for updates...')}</span>
                    </div>
                  )}

                  {updateState.status === 'up-to-date' && (
                    <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-300">
                      <Check className="h-3.5 w-3.5" />
                      <span>{bi(`当前已是最新版本 (v${updateState.latestVersion || appVersion})`, `You are up to date (v${updateState.latestVersion || appVersion})`)}</span>
                    </div>
                  )}

                  {updateState.status === 'available' && (
                    <div className="space-y-2.5 rounded-xl border border-[#4D6BFE]/30 bg-[#F3F6FF] p-3 dark:border-[#4D6BFE]/35 dark:bg-[#1C2338]">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="font-bold text-[#2842C9] dark:text-white">
                            {bi(`发现新版本 v${updateState.latestVersion}`, `Update available: v${updateState.latestVersion}`)}
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                            {updateState.assetName
                              ? `${updateState.assetName}${updateState.assetSize ? ` · ${formatBytesCompact(updateState.assetSize)}` : ''}`
                              : bi('可前往 GitHub Releases 下载更新', 'Download available on GitHub Releases')}
                          </div>
                        </div>
                        {updateState.downloadUrl && onDownloadUpdate ? (
                          <button
                            type="button"
                            onClick={() => onDownloadUpdate()}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[#4D6BFE] px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-xs active:scale-95"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>{bi('下载更新', 'Download')}</span>
                          </button>
                        ) : (
                          <a
                            href={updateState.releaseUrl || RELEASES_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-[#4D6BFE] px-3 py-1.5 text-[11.5px] font-semibold text-white"
                          >
                            <span>{bi('去下载', 'Download')}</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      <div className="text-[10.5px] text-slate-500 dark:text-slate-400">
                        {bi('支持原位覆盖升级，无需手动卸载，账号与本机桥接配置完整保留。', 'Upgrades in place without uninstalling. Your account and local bridge settings stay intact.')}
                      </div>
                    </div>
                  )}

                  {updateState.status === 'downloading' && (
                    <div className="space-y-2 rounded-xl border border-slate-200/80 bg-slate-50 p-3 dark:border-slate-700/80 dark:bg-[#171A23]">
                      <div className="flex items-center justify-between gap-2 text-[11.5px]">
                        <span className="font-semibold text-slate-800 dark:text-slate-100">
                          {bi(`正在下载 v${updateState.latestVersion} · ${updateState.percent}%`, `Downloading v${updateState.latestVersion} · ${updateState.percent}%`)}
                        </span>
                        <span className="font-mono text-[10.5px] text-slate-400">
                          {formatBytesCompact(updateState.downloadedBytes)}
                          {updateState.totalBytes > 0 ? ` / ${formatBytesCompact(updateState.totalBytes)}` : ''}
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                        <div
                          className="h-full rounded-full bg-[#4D6BFE] transition-all duration-200"
                          style={{ width: `${Math.max(4, Math.min(100, updateState.percent || 0))}%` }}
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => onCancelUpdate?.()}
                          className="rounded-lg px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800"
                        >
                          {bi('取消下载', 'Cancel Download')}
                        </button>
                      </div>
                    </div>
                  )}

                  {updateState.status === 'downloaded' && (
                    <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-200/80 bg-emerald-50/80 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/35">
                      <div className="min-w-0">
                        <div className="font-bold text-emerald-700 dark:text-emerald-300">
                          {bi(
                            `v${updateState.latestVersion} 已就绪${updateState.expectedSha256 ? '（SHA-256 校验通过）' : ''}`,
                            `v${updateState.latestVersion} ready${updateState.expectedSha256 ? ' (SHA-256 verified)' : ''}`,
                          )}
                        </div>
                        <div className="mt-0.5 text-[10.5px] text-emerald-600/80 dark:text-emerald-400/80">
                          {bi('点击后将自动原位覆盖安装并重新打开应用', 'Installs in place and automatically relaunches the app')}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onInstallUpdate?.()}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-xs hover:bg-emerald-500 active:scale-95"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        <span>{bi('重启并更新', 'Restart & Update')}</span>
                      </button>
                    </div>
                  )}

                  {updateState.status === 'installing' && (
                    <div className="flex items-center gap-2 text-[#4D6BFE]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>{bi('正在启动原位更新程序并自动重启...', 'Launching updater and restarting...')}</span>
                    </div>
                  )}

                  {updateState.status === 'error' && (
                    <div className="space-y-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11.5px] text-rose-600 dark:bg-rose-950/45 dark:text-rose-300">
                      <div>{updateState.error || bi('检查或下载更新失败', 'Failed to check or download update')}</div>
                      <div className="flex items-center gap-3 pt-0.5">
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
                          className="inline-flex items-center gap-0.5 text-slate-500 hover:underline dark:text-slate-300"
                        >
                          <span>{bi('手动去 GitHub 下载', 'Download on GitHub')}</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
              >
                <span>{bi('GitHub Releases 全部版本', 'GitHub Releases')}</span>
                <ExternalLink className="h-3.5 w-3.5 text-slate-400" />
              </a>

              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
              >
                <span>{bi('GitHub 开源仓库', 'GitHub Repository')}</span>
                <ExternalLink className="h-3.5 w-3.5 text-slate-400" />
              </a>
            </div>
            {desktopApi && (
              <div className="mt-2 px-1 text-center text-[10.5px] text-slate-400">
                {bi(
                  `快捷键：新建对话 ${desktopApi.platform === 'darwin' ? '⌘N' : 'Ctrl+N'} · 切换电脑 ${desktopApi.platform === 'darwin' ? '⌘K' : 'Ctrl+K'} · 设置 ${desktopApi.platform === 'darwin' ? '⌘,' : 'Ctrl+,'}`,
                  `Shortcuts: New Chat ${desktopApi.platform === 'darwin' ? '⌘N' : 'Ctrl+N'} · Switch PC ${desktopApi.platform === 'darwin' ? '⌘K' : 'Ctrl+K'} · Settings ${desktopApi.platform === 'darwin' ? '⌘,' : 'Ctrl+,'}`,
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
