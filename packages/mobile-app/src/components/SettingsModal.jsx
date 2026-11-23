import React, { useEffect, useState } from 'react'
import {
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
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

const REPO_URL = 'https://github.com/RainbowLion0320/AllinOne'
const RELEASES_URL =
  String(import.meta.env.VITE_RELEASES_URL || '').trim() ||
  'https://github.com/RainbowLion0320/AllinOne/releases/latest'

function formatPlatformTitle(desktopApi) {
  if (!desktopApi) return 'Web / PWA'
  if (desktopApi.platform === 'darwin') return 'macOS 桌面端'
  if (desktopApi.platform === 'win32') return 'Windows 桌面端'
  return 'Linux 桌面端'
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
    '0.3.5'

  const displayUser = activeDevice?.username
    ? `@${activeDevice.username}`
    : activeDeviceName || '本地设备'
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
      setEmailError('请输入有效的邮箱地址')
      return
    }
    setEmailSending(true)
    setEmailError('')
    setEmailInfo('')
    try {
      const res = await onSendBindEmailCode(clean)
      setEmailCooldown(res?.cooldownSec || 60)
      setEmailInfo(res?.message || '验证码已发送，请查收邮件')
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
      setEmailError('请输入有效的邮箱地址')
      return
    }
    if (!/^\d{6}$/.test(code)) {
      setEmailError('请输入 6 位邮箱验证码')
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
    if (!desktopBridge) return '未初始化'
    if (desktopBridge.state === 'connected') return `已连接 · ${desktopBridge.label || '本机'}`
    if (desktopBridge.state === 'starting' || desktopBridge.state === 'binding') return '连接中...'
    if (desktopBridge.state === 'paused') return '已暂停'
    if (desktopBridge.state === 'error') return `异常：${desktopBridge.error || '请查看日志'}`
    return '未登录账号'
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
            <h2 className="text-[15.5px] font-bold text-slate-900 dark:text-white">设置</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
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
              账号与用户信息
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
                        管理员
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
                    <span className="truncate">{serverDisplay || '默认服务器'}</span>
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
                    <span>电脑与账号</span>
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
                        {boundEmail || '未绑定邮箱（可选，用于找回密码）'}
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
                      {showEmailForm ? '收起' : boundEmail ? '换绑' : '绑定邮箱'}
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
                            placeholder={boundEmail ? `新邮箱（当前：${boundEmail}）` : '输入要绑定的邮箱地址'}
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
                              placeholder="6 位验证码"
                              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs tracking-widest text-slate-900 outline-none placeholder:font-sans placeholder:tracking-normal focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1E212B] dark:text-white"
                            />
                            <button
                              type="button"
                              disabled={emailSending || emailCooldown > 0}
                              onClick={handleSendBindCode}
                              className="shrink-0 rounded-xl border border-[#4D6BFE]/40 bg-[#F2F5FF] px-2.5 py-2 text-[11px] font-semibold text-[#2842C9] disabled:opacity-55 dark:bg-[#1E253A] dark:text-[#A9BDFF]"
                            >
                              {emailSending ? '发送中' : emailCooldown > 0 ? `${emailCooldown}s` : '获取验证码'}
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
                              取消
                            </button>
                            <button
                              type="submit"
                              disabled={emailBinding}
                              className="inline-flex items-center gap-1 rounded-lg bg-[#4D6BFE] px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
                            >
                              {emailBinding && <Loader2 className="h-3 w-3 animate-spin" />}
                              <span>确认绑定</span>
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                          当前服务器尚未配置邮件服务（SMTP / Resend）。管理员在中转服务器 `.env` 配置发信参数并重启后即可自助绑定邮箱和找回密码。
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
                        <span>退出当前登录</span>
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 opacity-60" />
                    </button>
                  ) : (
                    <div className="space-y-2 rounded-xl bg-rose-50/90 px-3 py-2.5 text-xs text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                      <div className="flex items-center justify-between">
                        <span>确认退出 {displayUser}？</span>
                        <button
                          type="button"
                          onClick={() => setConfirmLogout(false)}
                          className="rounded-lg bg-white px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                        >
                          取消
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
                          仅退出本设备
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
                          退出并吊销全部设备
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Section 2: Appearance */}
          <section>
            <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
              外观
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-slate-200/80 bg-white px-4 py-3 dark:border-slate-800 dark:bg-[#22252E]">
              <div className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                {darkMode ? (
                  <Moon className="h-4 w-4 text-[#4D6BFE]" />
                ) : (
                  <Sun className="h-4 w-4 text-amber-500" />
                )}
                <span>主题模式</span>
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
                  <span>浅色</span>
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
                  <span>深色</span>
                </button>
              </div>
            </div>
          </section>

          {/* Section 3: Desktop App Controls (Electron only) */}
          {desktopApi && (
            <section>
              <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
                本机桌面端
              </div>
              <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#22252E]">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-100">
                      <Laptop className="h-4 w-4 shrink-0 text-[#4D6BFE]" />
                      <span>本机后台桥接</span>
                    </div>
                    <div className="mt-0.5 truncate pl-6 text-[11px] text-slate-400">
                      {bridgeStatusText}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={Boolean(desktopBridge?.enabled)}
                    onChange={() => onToggleDesktopBridge?.()}
                    label="切换本机后台桥接"
                  />
                </div>

                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-100">
                    <Power className="h-4 w-4 shrink-0 text-slate-400" />
                    <span>开机自动启动</span>
                  </div>
                  <ToggleSwitch
                    checked={Boolean(desktopBridge?.autoLaunch)}
                    onChange={() => onToggleDesktopAutoLaunch?.()}
                    label="切换开机自动启动"
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
                      <span>查看本机桥接日志</span>
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
              分享与管理
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
                    <span>分享 All in One / 安装包下载</span>
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
                    <span>邀请码管理</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </button>
              )}
            </div>
          </section>

          {/* Section 5: Local Storage & Cache */}
          <section>
            <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
              本地存储
            </div>
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-3 dark:border-slate-800 dark:bg-[#22252E]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-800 dark:text-slate-100">
                  <HardDrive className="h-4 w-4 shrink-0 text-slate-400" />
                  <span>会话历史缓存</span>
                </div>
                <div className="mt-0.5 pl-6 text-[11px] text-slate-400">
                  {cacheClearedHint
                    ? '已清空本设备本地缓存'
                    : `已缓存 ${cacheStats.sessionCount} 个会话 · ${formatBytesCompact(cacheStats.totalBytes)}`}
                </div>
              </div>
              <button
                type="button"
                disabled={cacheStats.sessionCount === 0}
                onClick={handleClearCache}
                className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-slate-200 px-2.5 py-1.5 text-[11.5px] font-medium text-slate-600 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-rose-900/60 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
              >
                {cacheClearedHint ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Trash2 className="h-3.5 w-3.5" />}
                <span>{cacheClearedHint ? '已清理' : '清理'}</span>
              </button>
            </div>
          </section>

          {/* Section 6: About & Built-in Updater */}
          <section>
            <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
              关于与更新
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
                      {formatPlatformTitle(desktopApi)} · MIT Open Source
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
                    <span>{updateState?.status === 'checking' ? '检查中...' : '检查更新'}</span>
                  </button>
                ) : (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300">
                    自动热更新
                  </span>
                )}
              </div>

              {/* Desktop in-app updater status & 1-click download/install panel */}
              {desktopApi && updateState && updateState.status !== 'idle' && (
                <div className="px-4 py-3 text-xs">
                  {updateState.status === 'checking' && (
                    <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[#4D6BFE]" />
                      <span>正在从 GitHub Releases 检查最新版本...</span>
                    </div>
                  )}

                  {updateState.status === 'up-to-date' && (
                    <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-300">
                      <Check className="h-3.5 w-3.5" />
                      <span>当前已是最新版本 (v{updateState.latestVersion || appVersion})</span>
                    </div>
                  )}

                  {updateState.status === 'available' && (
                    <div className="space-y-2.5 rounded-xl border border-[#4D6BFE]/30 bg-[#F3F6FF] p-3 dark:border-[#4D6BFE]/35 dark:bg-[#1C2338]">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="font-bold text-[#2842C9] dark:text-white">
                            发现新版本 v{updateState.latestVersion}
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                            {updateState.assetName
                              ? `${updateState.assetName}${updateState.assetSize ? ` · ${formatBytesCompact(updateState.assetSize)}` : ''}`
                              : '可前往 GitHub Releases 下载更新'}
                          </div>
                        </div>
                        {updateState.downloadUrl && onDownloadUpdate ? (
                          <button
                            type="button"
                            onClick={() => onDownloadUpdate()}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[#4D6BFE] px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-xs active:scale-95"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>下载更新</span>
                          </button>
                        ) : (
                          <a
                            href={updateState.releaseUrl || RELEASES_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-[#4D6BFE] px-3 py-1.5 text-[11.5px] font-semibold text-white"
                          >
                            <span>去下载</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      <div className="text-[10.5px] text-slate-500 dark:text-slate-400">
                        支持原位覆盖升级，无需手动卸载，账号与本机桥接配置完整保留。
                      </div>
                    </div>
                  )}

                  {updateState.status === 'downloading' && (
                    <div className="space-y-2 rounded-xl border border-slate-200/80 bg-slate-50 p-3 dark:border-slate-700/80 dark:bg-[#171A23]">
                      <div className="flex items-center justify-between gap-2 text-[11.5px]">
                        <span className="font-semibold text-slate-800 dark:text-slate-100">
                          正在下载 v{updateState.latestVersion} · {updateState.percent}%
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
                          取消下载
                        </button>
                      </div>
                    </div>
                  )}

                  {updateState.status === 'downloaded' && (
                    <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-200/80 bg-emerald-50/80 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/35">
                      <div className="min-w-0">
                        <div className="font-bold text-emerald-700 dark:text-emerald-300">
                          v{updateState.latestVersion} 已就绪
                          {updateState.expectedSha256 ? '（SHA-256 校验通过）' : ''}
                        </div>
                        <div className="mt-0.5 text-[10.5px] text-emerald-600/80 dark:text-emerald-400/80">
                          点击后将自动原位覆盖安装并重新打开应用
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onInstallUpdate?.()}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-xs hover:bg-emerald-500 active:scale-95"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        <span>重启并更新</span>
                      </button>
                    </div>
                  )}

                  {updateState.status === 'installing' && (
                    <div className="flex items-center gap-2 text-[#4D6BFE]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>正在启动原位更新程序并自动重启...</span>
                    </div>
                  )}

                  {updateState.status === 'error' && (
                    <div className="space-y-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11.5px] text-rose-600 dark:bg-rose-950/45 dark:text-rose-300">
                      <div>{updateState.error || '检查或下载更新失败'}</div>
                      <div className="flex items-center gap-3 pt-0.5">
                        <button
                          type="button"
                          onClick={() => onCheckUpdate?.()}
                          className="font-semibold text-[#4D6BFE] hover:underline"
                        >
                          重试
                        </button>
                        <a
                          href={updateState.releaseUrl || RELEASES_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-slate-500 hover:underline dark:text-slate-300"
                        >
                          <span>手动去 GitHub 下载</span>
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
                <span>GitHub Releases 全部版本</span>
                <ExternalLink className="h-3.5 w-3.5 text-slate-400" />
              </a>

              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
              >
                <span>GitHub 开源仓库</span>
                <ExternalLink className="h-3.5 w-3.5 text-slate-400" />
              </a>
            </div>
            {desktopApi && (
              <div className="mt-2 px-1 text-center text-[10.5px] text-slate-400">
                快捷键：新建对话 {desktopApi.platform === 'darwin' ? '⌘N' : 'Ctrl+N'} · 切换电脑{' '}
                {desktopApi.platform === 'darwin' ? '⌘K' : 'Ctrl+K'} · 设置{' '}
                {desktopApi.platform === 'darwin' ? '⌘,' : 'Ctrl+,'}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
