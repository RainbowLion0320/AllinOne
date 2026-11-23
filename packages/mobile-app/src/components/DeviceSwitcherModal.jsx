import React, { useCallback, useEffect, useState } from 'react'
import {
  Check,
  Copy,
  KeyRound,
  Laptop,
  Loader2,
  LogOut,
  Mail,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  ScanLine,
  Terminal,
  Ticket,
  Trash2,
  User,
  X,
} from 'lucide-react'
import {
  formatPlatformLabel,
  getDeviceDisplayName,
} from '../lib/deviceStore.js'
import { probeDeviceStatus } from '../lib/wsClient.js'
import { useI18n } from '../lib/i18n.jsx'
import { translate } from '../lib/i18n.js'

function StatusPill({ status, onlineCount = 0 }) {
  const { bi, t } = useI18n()
  if (status === 'probing' || status === 'connecting') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-600 dark:bg-amber-950/50 dark:text-amber-300">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        <span>{status === 'connecting' ? t('common.connecting') : bi('检测中', 'Checking')}</span>
      </span>
    )
  }
  if (status === 'online') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <span>{onlineCount > 1 ? bi(`${onlineCount} 在线`, `${onlineCount} online`) : t('common.online')}</span>
      </span>
    )
  }
  if (status === 'expired') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10.5px] font-medium text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
        <span>{t('common.expired')}</span>
      </span>
    )
  }
  if (status === 'unreachable') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
        <span>{t('common.error')}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      <span>{t('common.offline')}</span>
    </span>
  )
}

function formatRelativeSeen(ts, lang) {
  if (!ts) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return translate(lang, 'time.justNow')
  if (diffSec < 3600) return translate(lang, 'time.minsAgo', { n: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return translate(lang, 'time.hoursAgo', { n: Math.floor(diffSec / 3600) })
  return translate(lang, 'time.daysAgo', { n: Math.floor(diffSec / 86400) })
}

export function DeviceSwitcherModal({
  open,
  onClose,
  devices = [],
  activeDeviceId = null,
  activeBridgeId = '',
  activeConnState = 'disconnected',
  activeBridges = [],
  accountDevices = [],
  isAdmin = false,
  emailEnabled = false,
  desktopBridge = null,
  onToggleDesktopBridge = null,
  onToggleDesktopAutoLaunch = null,
  onSelectDevice,
  onAddDevice,
  onRenameDevice,
  onRemoveDevice,
  onSyncDeviceMeta,
  onRenameAccountDevice,
  onRemoveAccountDevice,
  onRefreshAccountDevices,
  onSendBindEmailCode = null,
  onBindAccountEmail = null,
  onOpenInviteManager,
}) {
  const { lang, bi, t } = useI18n()
  const [probes, setProbes] = useState({})
  const [probingAll, setProbingAll] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [confirmLogoutAccount, setConfirmLogoutAccount] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState('')
  const [showEmailPanel, setShowEmailPanel] = useState(false)
  const [emailDraft, setEmailDraft] = useState('')
  const [emailCodeDraft, setEmailCodeDraft] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailBinding, setEmailBinding] = useState(false)
  const [emailCooldown, setEmailCooldown] = useState(0)
  const [emailError, setEmailError] = useState('')
  const [emailInfo, setEmailInfo] = useState('')

  const activeEntry = devices.find((d) => d.id === activeDeviceId) || null
  const isAccountMode = Boolean(
    activeEntry && (activeEntry.authMode === 'account' || String(activeEntry.roomId || '').startsWith('usr_')),
  )
  const otherEntries = isAccountMode ? devices.filter((d) => d.id !== activeDeviceId) : devices

  const runProbeAll = useCallback(async (list) => {
    const targets = (list || []).filter((d) => d.id !== activeDeviceId)
    setProbingAll(true)
    if (isAccountMode) {
      await onRefreshAccountDevices?.().catch(() => {})
    }
    if (targets.length === 0) {
      setProbingAll(false)
      return
    }
    setProbes((prev) => {
      const next = { ...prev }
      for (const d of targets) {
        next[d.id] = { ...(next[d.id] || {}), status: 'probing' }
      }
      return next
    })
    try {
      await Promise.all(
        targets.map(async (d) => {
          const result = await probeDeviceStatus(d, 5000)
          setProbes((prev) => ({ ...prev, [d.id]: result }))
          const firstOnline = result.bridges.find((b) => b.online) || result.bridges[0] || null
          if (firstOnline || result.label || result.username || result.email) {
            onSyncDeviceMeta?.(d.id, {
              ...(result.label ? { label: result.label } : {}),
              ...(result.username ? { username: result.username } : {}),
              ...(result.email !== undefined ? { email: result.email } : {}),
              ...(result.role ? { role: result.role } : {}),
              ...(firstOnline?.hostname ? { lastHostname: firstOnline.hostname } : {}),
              ...(firstOnline?.platform ? { lastPlatform: firstOnline.platform } : {}),
            })
          }
        }),
      )
    } finally {
      setProbingAll(false)
    }
  }, [activeDeviceId, isAccountMode, onRefreshAccountDevices, onSyncDeviceMeta])

  useEffect(() => {
    if (!open) {
      setEditingId(null)
      setConfirmDeleteId(null)
      setConfirmLogoutAccount(false)
      setShowEmailPanel(false)
      setEmailDraft('')
      setEmailCodeDraft('')
      setEmailError('')
      setEmailInfo('')
      return
    }
    void runProbeAll(devices)
  }, [open, devices.length, runProbeAll])

  useEffect(() => {
    if (emailCooldown <= 0) return undefined
    const t = setTimeout(() => setEmailCooldown((v) => (v > 1 ? v - 1 : 0)), 1000)
    return () => clearTimeout(t)
  }, [emailCooldown])

  if (!open) return null

  const handleSendBindCode = async () => {
    setEmailError('')
    setEmailInfo('')
    const clean = emailDraft.trim()
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
      setEmailError(bi('请输入有效的邮箱地址', 'Please enter a valid email address'))
      return
    }
    if (!onSendBindEmailCode) return
    setEmailSending(true)
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
    setEmailError('')
    setEmailInfo('')
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
    if (!onBindAccountEmail) return
    setEmailBinding(true)
    try {
      await onBindAccountEmail(clean, code)
      setShowEmailPanel(false)
      setEmailDraft('')
      setEmailCodeDraft('')
      setEmailInfo('')
    } catch (err) {
      setEmailError(String(err?.message || err))
    } finally {
      setEmailBinding(false)
    }
  }

  const copyBindCmd = async (kind, cmd) => {
    try { await navigator.clipboard.writeText(cmd) } catch {}
    setCopiedCmd(kind)
    setTimeout(() => setCopiedCmd(''), 1800)
  }

  const startRename = (id, currentName) => {
    setConfirmDeleteId(null)
    setEditingId(id)
    setEditDraft(currentName || '')
  }

  const commitRename = async (id, isAcctPc = false) => {
    const clean = editDraft.trim()
    setEditingId(null)
    setEditDraft('')
    if (!clean) return
    if (isAcctPc) {
      await onRenameAccountDevice?.(id, clean)
    } else {
      onRenameDevice?.(id, clean)
    }
  }

  const onlineAcctCount = accountDevices.filter((pc) => pc.online).length
  const acctServerBase = activeEntry?.baseUrl || ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="pb-safe flex max-h-[88vh] w-full max-w-md flex-col rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl dark:bg-[#1C1F27]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pt-4.5 pb-3.5 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8.5 w-8.5 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Laptop className="h-4 w-4" />
            </div>
            <h2 className="text-[15.5px] font-bold text-slate-900 dark:text-white">
              {bi('我的电脑', 'My Computers')}
              <span className="ml-1.5 text-xs font-medium text-slate-400">
                ({isAccountMode ? accountDevices.length : devices.length})
              </span>
            </h2>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => runProbeAll(devices)}
              aria-label={bi('刷新设备在线状态', 'Refresh online status')}
              title={bi('刷新在线状态', 'Refresh status')}
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <RefreshCw className={`h-4 w-4 ${probingAll ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={bi('关闭电脑列表', 'Close computers list')}
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
          {/* Local Desktop Built-in Bridge Strip (only shown inside Electron Desktop App) */}
          {desktopBridge && (
            <div className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200/80 bg-slate-50/80 px-3 py-2.5 dark:border-slate-800 dark:bg-[#151820]">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    desktopBridge.state === 'connected'
                      ? 'bg-emerald-500'
                      : desktopBridge.state === 'starting' || desktopBridge.state === 'binding'
                        ? 'bg-amber-400 animate-pulse'
                        : desktopBridge.state === 'error'
                          ? 'bg-rose-500'
                          : 'bg-slate-400'
                  }`}
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                    {bi('本机桥接', 'Local Bridge')} ·{' '}
                    {desktopBridge.state === 'connected'
                      ? t('common.online')
                      : desktopBridge.state === 'starting' || desktopBridge.state === 'binding'
                        ? bi('启动中', 'Starting')
                        : desktopBridge.state === 'paused'
                          ? bi('已暂停', 'Paused')
                          : desktopBridge.state === 'error'
                            ? t('common.error')
                            : bi('未启动', 'Stopped')}
                  </div>
                  {desktopBridge.error && (
                    <div className="truncate text-[10.5px] text-rose-500">{desktopBridge.error}</div>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {onToggleDesktopAutoLaunch && (
                  <button
                    type="button"
                    onClick={onToggleDesktopAutoLaunch}
                    className={`rounded-lg px-2 py-1 text-[11px] font-medium transition ${
                      desktopBridge.autoLaunch
                        ? 'bg-[#4D6BFE]/12 text-[#4D6BFE] dark:bg-[#4D6BFE]/25 dark:text-[#96AEFF]'
                        : 'bg-white text-slate-500 border border-slate-200 dark:border-slate-700 dark:bg-[#232631] dark:text-slate-400'
                    }`}
                  >
                    {desktopBridge.autoLaunch ? bi('自启开', 'Auto-start On') : bi('自启关', 'Auto-start Off')}
                  </button>
                )}
                {onToggleDesktopBridge && (
                  <button
                    type="button"
                    onClick={onToggleDesktopBridge}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition active:scale-95 ${
                      desktopBridge.enabled
                        ? 'bg-white text-slate-700 border border-slate-200 hover:text-rose-500 dark:border-slate-700 dark:bg-[#232631] dark:text-slate-200'
                        : 'bg-[#4D6BFE] text-white'
                    }`}
                  >
                    {desktopBridge.enabled ? bi('暂停', 'Pause') : bi('开启', 'Start')}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Active Account Header Card */}
          {isAccountMode && activeEntry && (
            <div className="rounded-2xl border border-[#4D6BFE]/25 bg-gradient-to-br from-[#F4F7FF] to-white p-3 dark:border-[#4D6BFE]/35 dark:from-[#1E2438] dark:to-[#181B24]">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#4D6BFE] text-white">
                    <User className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-bold text-slate-900 dark:text-white">
                        @{activeEntry.username || activeEntry.label?.replace(/^@/, '') || activeEntry.roomId}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-slate-400">
                      {activeEntry.email ? (
                        <span className="truncate">{activeEntry.email}</span>
                      ) : emailEnabled ? (
                        <span>{bi('未绑定邮箱', 'No email linked')}</span>
                      ) : null}
                      {accountDevices.length > 1 && (
                        <span className="shrink-0">
                          {bi(`${onlineAcctCount}/${accountDevices.length} 在线`, `${onlineAcctCount}/${accountDevices.length} online`)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {(emailEnabled || isAdmin) && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmLogoutAccount(false)
                        setEmailError('')
                        setEmailInfo('')
                        setShowEmailPanel((v) => !v)
                      }}
                      title={activeEntry.email ? bi('更换绑定邮箱', 'Change email') : bi('绑定邮箱', 'Link email')}
                      className={`inline-flex items-center gap-1 rounded-xl px-2 py-1.5 text-[11px] font-medium transition ${
                        showEmailPanel
                          ? 'bg-[#4D6BFE]/15 text-[#4D6BFE] dark:bg-[#4D6BFE]/25 dark:text-[#A9BDFF]'
                          : 'text-slate-500 hover:bg-white/80 hover:text-[#4D6BFE] dark:text-slate-300 dark:hover:bg-slate-800/80'
                      }`}
                    >
                      <Mail className="h-3.5 w-3.5" />
                      <span>{activeEntry.email ? bi('换绑', 'Email') : bi('绑邮箱', 'Email')}</span>
                    </button>
                  )}
                  {isAdmin && onOpenInviteManager && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose()
                        onOpenInviteManager()
                      }}
                      className="inline-flex items-center gap-1 rounded-xl bg-[#4D6BFE] px-2.5 py-1.5 text-[11px] font-semibold text-white active:scale-95"
                    >
                      <Ticket className="h-3 w-3" />
                      <span>{bi('邀请码', 'Invites')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setShowEmailPanel(false)
                      setConfirmLogoutAccount((v) => !v)
                    }}
                    title={bi('退出或管理当前账号', 'Sign out account')}
                    className="rounded-xl p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {showEmailPanel && (
                <div className="mt-2.5 rounded-xl border border-slate-200/80 bg-white/95 p-3 dark:border-slate-700/80 dark:bg-[#151821]">
                  {emailEnabled ? (
                    <form onSubmit={handleCommitBindEmail} className="space-y-2">
                      <div className="flex items-center justify-between text-[11.5px]">
                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                          {activeEntry.email ? bi('更换绑定邮箱', 'Change Email') : bi('绑定邮箱', 'Link Email')}
                        </span>
                        <span className="text-[10.5px] text-slate-400">{bi('用于邮箱登录与找回密码', 'For login & password reset')}</span>
                      </div>
                      <input
                        type="email"
                        value={emailDraft}
                        onChange={(e) => setEmailDraft(e.target.value)}
                        placeholder={activeEntry.email ? bi(`新邮箱（当前：${activeEntry.email}）`, `New email (current: ${activeEntry.email})`) : bi('输入要绑定的邮箱地址', 'Enter email address')}
                        autoComplete="email"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#1C1F28] dark:text-white"
                      />
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          value={emailCodeDraft}
                          onChange={(e) => setEmailCodeDraft(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          placeholder={bi('6 位验证码', '6-digit code')}
                          autoComplete="one-time-code"
                          className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs tracking-widest text-slate-900 outline-none placeholder:font-sans placeholder:tracking-normal focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#1C1F28] dark:text-white"
                        />
                        <button
                          type="button"
                          disabled={emailSending || emailCooldown > 0}
                          onClick={handleSendBindCode}
                          className="shrink-0 rounded-xl border border-[#4D6BFE]/40 bg-[#F2F5FF] px-2.5 py-2 text-[11px] font-semibold text-[#2842C9] disabled:opacity-55 dark:border-[#4D6BFE]/40 dark:bg-[#1E253A] dark:text-[#A9BDFF]"
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
                      <div className="flex justify-end gap-1.5 pt-0.5">
                        <button
                          type="button"
                          onClick={() => setShowEmailPanel(false)}
                          className="rounded-lg px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          type="submit"
                          disabled={emailBinding}
                          className="rounded-lg bg-[#4D6BFE] px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
                        >
                          {emailBinding ? bi('绑定中...', 'Linking...') : bi('确认绑定', 'Confirm')}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="space-y-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                      <div className="font-semibold text-slate-700 dark:text-slate-200">{bi('服务器尚未启用邮件服务', 'Email Service Not Configured')}</div>
                      <p>
                        {lang === 'en' ? (
                          <>
                            Configure <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] dark:bg-slate-800">SMTP_HOST</code>,{' '}
                            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] dark:bg-slate-800">SMTP_USER</code>, and{' '}
                            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] dark:bg-slate-800">SMTP_PASS</code> in the relay server{' '}
                            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] dark:bg-slate-800">.env</code> and restart to enable email linking and password reset.
                          </>
                        ) : (
                          <>
                            在服务器 <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] dark:bg-slate-800">.env</code>{' '}
                            配置免费的 QQ / 163 / Gmail SMTP（<code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] dark:bg-slate-800">SMTP_HOST</code>、
                            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] dark:bg-slate-800">SMTP_USER</code>、
                            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] dark:bg-slate-800">SMTP_PASS</code>）并重启中转服务后，即可开启邮箱绑定与自助找回密码。
                          </>
                        )}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {confirmLogoutAccount && (
                <div className="mt-2.5 space-y-2 rounded-xl bg-rose-50/90 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                  <div className="flex items-center justify-between gap-2">
                    <span>{bi(`退出账号 @${activeEntry.username}？`, `Sign out @${activeEntry.username}?`)}</span>
                    <button
                      type="button"
                      onClick={() => setConfirmLogoutAccount(false)}
                      className="rounded-lg bg-white px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmLogoutAccount(false)
                        onRemoveDevice?.(activeEntry.id, { revokeAll: false })
                      }}
                      className="rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-600 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
                    >
                      {bi('仅退出本设备', 'This Device Only')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmLogoutAccount(false)
                        onRemoveDevice?.(activeEntry.id, { revokeAll: true })
                      }}
                      className="rounded-lg bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white"
                    >
                      {bi('退出并吊销全部设备', 'Sign Out All Devices')}
                    </button>
                  </div>
                </div>
              )}

              {activeConnState === 'unauthorized' && (
                <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-rose-50 px-3 py-1.5 text-[11px] text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
                  <span>{bi('当前账号登录已失效，请重新登录', 'Session expired. Please sign in again.')}</span>
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      onAddDevice?.(activeEntry.baseUrl, { openScanner: false })
                    }}
                    className="rounded-lg bg-rose-500 px-2.5 py-1 font-semibold text-white"
                  >
                    {bi('重新登录', 'Sign In Again')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Account-bound Computers List */}
          {isAccountMode && (
            <div className="space-y-2">
              {accountDevices.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-4 text-center dark:border-slate-700/80 dark:bg-[#151820]">
                  <Terminal className="mx-auto mb-2 h-6 w-6 text-[#4D6BFE]" />
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    {bi('尚未绑定电脑', 'No Computers Linked')}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">
                    {lang === 'en' ? (
                      <>
                        Run the command below on your computer and sign in as <strong>@{activeEntry?.username}</strong>
                      </>
                    ) : (
                      <>
                        在电脑终端运行下方命令并登录 <strong>@{activeEntry?.username}</strong>
                      </>
                    )}
                  </p>
                  <div className="mt-2.5 space-y-1.5 text-left">
                    {[
                      { key: 'unix', label: 'Mac/Linux', cmd: `curl -fsSL ${acctServerBase}/setup.sh | bash` },
                      { key: 'win', label: 'Windows', cmd: `irm ${acctServerBase}/setup.ps1 | iex` },
                    ].map((row) => (
                      <div key={row.key} className="flex items-center gap-1.5 rounded-xl bg-slate-900 px-2.5 py-2 font-mono text-[10px] text-slate-100">
                        <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-sans text-[9.5px] text-slate-300">{row.label}</span>
                        <span className="flex-1 truncate">{row.cmd}</span>
                        <button
                          type="button"
                          onClick={() => copyBindCmd(row.key, row.cmd)}
                          className="shrink-0 rounded-lg bg-white/10 p-1 text-white hover:bg-white/20"
                        >
                          {copiedCmd === row.key ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                accountDevices.map((pc) => {
                  const isSelected = pc.bridgeId === activeBridgeId
                  const editKey = `pc:${pc.deviceId}`
                  const isEditing = editingId === editKey
                  const isConfirmingUnbind = confirmDeleteId === editKey
                  const platformLabel = formatPlatformLabel(pc.platform)
                  return (
                    <div
                      key={pc.deviceId}
                      className={`rounded-2xl border p-3 transition ${
                        isSelected
                          ? 'border-[#4D6BFE]/60 bg-[#F4F7FF] shadow-xs dark:border-[#4D6BFE]/50 dark:bg-[#20273B]'
                          : 'border-slate-200/80 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-[#171920] dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <button
                          type="button"
                          disabled={isEditing}
                          onClick={() => {
                            if (isEditing) return
                            onSelectDevice?.(activeEntry.id, pc.bridgeId)
                            onClose()
                          }}
                          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                        >
                          <div
                            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                              isSelected
                                ? 'bg-[#4D6BFE] text-white'
                                : pc.online
                                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300'
                                  : 'bg-slate-100 text-slate-400 dark:bg-slate-800'
                            }`}
                          >
                            <Monitor className="h-4.5 w-4.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-white">
                                {pc.label || pc.hostname || pc.bridgeId}
                              </span>
                              <StatusPill status={pc.online ? 'online' : 'offline'} />
                            </div>
                            {(platformLabel || (!pc.online && pc.lastSeenAt > 0)) && (
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400">
                                {platformLabel && <span>{platformLabel}</span>}
                                {!pc.online && pc.lastSeenAt > 0 && (
                                  <>
                                    {platformLabel && <span>·</span>}
                                    <span>{formatRelativeSeen(pc.lastSeenAt, lang)}</span>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </button>

                        {!isEditing && !isConfirmingUnbind && (
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => startRename(editKey, pc.label || pc.hostname)}
                              title={bi('重命名电脑', 'Rename computer')}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-700/70 dark:hover:text-slate-200"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(null)
                                setConfirmDeleteId(editKey)
                              }}
                              title={bi('解绑此电脑', 'Unlink computer')}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>

                      {isEditing && (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault()
                            void commitRename(pc.deviceId, true)
                          }}
                          className="mt-2.5 flex items-center gap-1.5"
                        >
                          <input
                            type="text"
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            autoFocus
                            maxLength={40}
                            placeholder={bi('输入备注名', 'Enter nickname')}
                            className="min-w-0 flex-1 rounded-xl border border-[#4D6BFE] bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none dark:bg-[#14161D] dark:text-white"
                          />
                          <button
                            type="submit"
                            className="inline-flex h-7.5 items-center gap-1 rounded-xl bg-[#4D6BFE] px-2.5 text-xs font-semibold text-white"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>{t('common.save')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => { setEditingId(null); setEditDraft('') }}
                            className="rounded-xl p-1.5 text-slate-400"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </form>
                      )}

                      {isConfirmingUnbind && (
                        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-rose-50/90 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                          <span>{bi('解绑此电脑？', 'Unlink this computer?')}</span>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-lg bg-white px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                            >
                              {t('common.cancel')}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmDeleteId(null)
                                void onRemoveAccountDevice?.(pc.deviceId, pc.bridgeId)
                              }}
                              className="rounded-lg bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white"
                            >
                              {bi('确认解绑', 'Unlink')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}

          {/* Other saved accounts or legacy rooms */}
          {otherEntries.length > 0 && (
            <div className="space-y-2">
              {isAccountMode && (
                <div className="px-1 pt-1 text-[11px] font-semibold text-slate-400">
                  {bi('其他连接', 'Other Connections')}
                </div>
              )}
              {otherEntries.map((device) => {
                const isActive = device.id === activeDeviceId
                const probe = probes[device.id]
                const bridges = isActive ? activeBridges : probe?.bridges || []
                const onlineBridges = bridges.filter((b) => b.online)
                const primaryBridge =
                  (isActive
                    ? onlineBridges.find((b) => b.bridgeId === activeBridgeId)
                    : onlineBridges.find((b) => b.bridgeId === device.selectedBridgeId)) ||
                  onlineBridges[0] ||
                  null

                let status = 'offline'
                if (isActive) {
                  if (activeConnState === 'unauthorized') status = 'expired'
                  else if (activeConnState === 'connecting') status = 'connecting'
                  else if (activeConnState === 'connected') status = onlineBridges.length > 0 ? 'online' : 'offline'
                  else status = 'unreachable'
                } else if (probe) {
                  status = probe.status
                } else {
                  status = 'probing'
                }

                const displayName = getDeviceDisplayName(device, primaryBridge, 1, lang)
                const platformLabel = formatPlatformLabel(primaryBridge?.platform || device.lastPlatform)
                const isEditing = editingId === device.id
                const isConfirmingDelete = confirmDeleteId === device.id
                const isAcct = device.authMode === 'account' || String(device.roomId || '').startsWith('usr_')

                return (
                  <div
                    key={device.id}
                    className={`rounded-2xl border p-3 transition ${
                      isActive
                        ? 'border-[#4D6BFE]/60 bg-[#F4F7FF] shadow-xs dark:border-[#4D6BFE]/50 dark:bg-[#20273B]'
                        : 'border-slate-200/80 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-[#171920] dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <button
                        type="button"
                        disabled={isEditing}
                        onClick={() => {
                          if (isEditing) return
                          onSelectDevice?.(device.id, primaryBridge?.bridgeId || device.selectedBridgeId || '')
                          onClose()
                        }}
                        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                      >
                        <div
                          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                            isActive
                              ? 'bg-[#4D6BFE] text-white'
                              : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300'
                          }`}
                        >
                          {isAcct ? <User className="h-4.5 w-4.5" /> : <Monitor className="h-4.5 w-4.5" />}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-white">
                              {isAcct && device.username ? `@${device.username}` : displayName}
                            </span>
                            <StatusPill status={status} onlineCount={onlineBridges.length} />
                          </div>

                          {(platformLabel || !isAcct) && (
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400">
                              {platformLabel && <span>{platformLabel}</span>}
                              {!isAcct && (
                                <>
                                  {platformLabel && <span>·</span>}
                                  <span>{device.roomId === 'owner' ? bi('密钥', 'Token') : bi('旧版配对', 'Legacy Pair')}</span>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </button>

                      {!isEditing && !isConfirmingDelete && (
                        <div className="flex shrink-0 items-center gap-0.5">
                          {!isAcct && (
                            <button
                              type="button"
                              onClick={() => startRename(device.id, device.customName || displayName)}
                              title={bi('重命名电脑', 'Rename computer')}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-700/70 dark:hover:text-slate-200"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(null)
                              setConfirmDeleteId(device.id)
                            }}
                            title={t('common.remove')}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>

                    {isEditing && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          void commitRename(device.id, false)
                        }}
                        className="mt-2.5 flex items-center gap-1.5"
                      >
                        <input
                          type="text"
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          autoFocus
                          maxLength={40}
                          placeholder={bi('输入备注名', 'Enter nickname')}
                          className="min-w-0 flex-1 rounded-xl border border-[#4D6BFE] bg-white px-2.5 py-1.5 text-xs text-slate-900 outline-none dark:bg-[#14161D] dark:text-white"
                        />
                        <button
                          type="submit"
                          className="inline-flex h-7.5 items-center gap-1 rounded-xl bg-[#4D6BFE] px-2.5 text-xs font-semibold text-white"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>{t('common.save')}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => { setEditingId(null); setEditDraft('') }}
                          className="rounded-xl p-1.5 text-slate-400"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    )}

                    {isConfirmingDelete && (
                      <div className="mt-2.5 space-y-2 rounded-xl bg-rose-50/90 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                        <div className="flex items-center justify-between gap-2">
                          <span>{bi('移除此设备并清空本地缓存？', 'Remove device and clear local cache?')}</span>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteId(null)
                              onRemoveDevice?.(device.id, { revokeAll: false })
                            }}
                            className="rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-600 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
                          >
                            {bi('仅移除本机', 'This Device Only')}
                          </button>
                          {status !== 'expired' && (
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmDeleteId(null)
                                onRemoveDevice?.(device.id, { revokeAll: true })
                              }}
                              className="rounded-lg bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white"
                            >
                              {bi('移除并吊销全部设备', 'Remove & Revoke All')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {status === 'expired' && !isConfirmingDelete && (
                      <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-rose-50/70 px-3 py-1.5 text-[11px] text-rose-600 dark:bg-rose-950/35 dark:text-rose-300">
                        <span>{bi('登录已过期，重新登录即可恢复', 'Session expired. Sign in again to reconnect.')}</span>
                        <button
                          type="button"
                          onClick={() => {
                            onClose()
                            onAddDevice?.(device.baseUrl)
                          }}
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-1 font-semibold text-white"
                        >
                          <KeyRound className="h-3 w-3" />
                          <span>{bi('重新登录', 'Sign In')}</span>
                        </button>
                      </div>
                    )}

                    {/* Same-room multi-bridge selector for legacy owner rooms */}
                    {!isAcct && (onlineBridges.length > 1 || (isActive && !activeBridgeId && onlineBridges.length === 1)) && !isConfirmingDelete && (
                      <div className="mt-2 border-t border-slate-200/70 pt-2 dark:border-slate-700/70">
                        <div className="flex flex-wrap gap-1.5">
                          {onlineBridges.map((b) => {
                            const isSelectedBridge = isActive && b.bridgeId === activeBridgeId
                            return (
                              <button
                                key={b.bridgeId}
                                type="button"
                                onClick={() => {
                                  onSelectDevice?.(device.id, b.bridgeId)
                                  onClose()
                                }}
                                className={`inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-[11.5px] font-medium transition ${
                                  isSelectedBridge
                                    ? 'border-[#4D6BFE] bg-[#4D6BFE] text-white'
                                    : 'border-slate-200 bg-white text-slate-700 hover:border-[#4D6BFE]/50 dark:border-slate-700 dark:bg-[#232734] dark:text-slate-200'
                                }`}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${isSelectedBridge ? 'bg-white' : 'bg-emerald-500'}`} />
                                <span className="max-w-[140px] truncate">{b.hostname || b.bridgeId}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer CTA */}
        <div className="border-t border-slate-100 px-4 pt-3 pb-3.5 dark:border-slate-800">
          <div className="grid grid-cols-5 gap-2">
            <button
              type="button"
              onClick={() => {
                onClose()
                onAddDevice?.('', { openScanner: false })
              }}
              className="col-span-3 flex items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-2.5 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 transition active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" />
              <span>{isAccountMode ? bi('添加账号', 'Add Account') : bi('登录账号', 'Sign In')}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                onClose()
                onAddDevice?.('', { openScanner: true })
              }}
              className="col-span-2 flex items-center justify-center gap-1.5 rounded-2xl border border-slate-200 bg-slate-50 py-2.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 active:scale-[0.98] dark:border-slate-700 dark:bg-[#232631] dark:text-slate-200 dark:hover:bg-[#2B2F3D]"
            >
              <ScanLine className="h-4 w-4" />
              <span>{bi('扫码', 'Scan QR')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
