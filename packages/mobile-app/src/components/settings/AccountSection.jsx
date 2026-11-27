import React, { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ExternalLink,
  Globe,
  Laptop,
  Loader2,
  LogOut,
  Mail,
  RefreshCw,
  Smartphone,
  Trash2,
  User,
} from 'lucide-react'
import { useI18n } from '../../lib/i18n.jsx'
import { launchGithubOAuthFlow, startGithubOAuthPolling } from '../../lib/githubOAuthClient.js'
import {
  HelpButton,
  HelpCallout,
  ToggleSwitch,
  formatClientDeviceLabel,
  formatRelativeSeen,
} from './SettingsPrimitives.jsx'

function GithubMark({ className = 'h-3.5 w-3.5' }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 4.64 3.01 8.57 7.18 9.96.53.1.72-.23.72-.5 0-.25-.01-1.08-.01-1.96-2.92.63-3.54-1.24-3.54-1.24-.48-1.21-1.17-1.53-1.17-1.53-.96-.65.07-.64.07-.64 1.06.07 1.62 1.09 1.62 1.09.94 1.61 2.47 1.15 3.07.88.1-.68.37-1.15.67-1.41-2.33-.26-4.78-1.17-4.78-5.19 0-1.15.41-2.09 1.08-2.82-.11-.26-.47-1.33.1-2.78 0 0 .88-.28 2.89 1.08a10.02 10.02 0 0 1 5.26 0c2.01-1.36 2.89-1.08 2.89-1.08.57 1.45.21 2.52.1 2.78.68.73 1.08 1.67 1.08 2.82 0 4.03-2.46 4.92-4.8 5.18.38.32.71.97.71 1.95 0 1.41-.01 2.55-.01 2.9 0 .28.19.61.73.5A10.5 10.5 0 0 0 22.5 12C22.5 6.2 17.8 1.5 12 1.5Z" />
    </svg>
  )
}

export function AccountSection({
  open,
  activeDevice,
  displayUser,
  serverDisplay,
  isAdmin,
  emailEnabled,
  githubEnabled = false,
  connState,
  bridgeOnline,
  turnQuota,
  clientSessions,
  onlineClientCount,
  openHelpKey,
  toggleHelp,
  onRefreshClientSessions,
  onRevokeClientSession,
  onRevokeOtherClientSessions,
  onSendBindEmailCode,
  onBindAccountEmail,
  onToggleLogin2fa,
  onGithubLinked,
  onUnlinkGithub,
  onDeleteAccount,
  onClose,
}) {
  const { lang, bi, t } = useI18n()

  const [showSessions, setShowSessions] = useState(false)
  const [refreshingSessions, setRefreshingSessions] = useState(false)
  const [confirmKickOthers, setConfirmKickOthers] = useState(false)
  const [kickingKey, setKickingKey] = useState('')
  const [kickingOthers, setKickingOthers] = useState(false)

  const [showEmailForm, setShowEmailForm] = useState(false)
  const [emailDraft, setEmailDraft] = useState('')
  const [emailCodeDraft, setEmailCodeDraft] = useState('')
  const [emailPasswordDraft, setEmailPasswordDraft] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailBinding, setEmailBinding] = useState(false)
  const [emailCooldown, setEmailCooldown] = useState(0)
  const [emailInfo, setEmailInfo] = useState('')
  const [emailError, setEmailError] = useState('')

  const [showDisable2faForm, setShowDisable2faForm] = useState(false)
  const [disable2faPassword, setDisable2faPassword] = useState('')
  const [disable2faBusy, setDisable2faBusy] = useState(false)
  const [disable2faError, setDisable2faError] = useState('')

  const [githubBind, setGithubBind] = useState({ starting: false, pending: false, authorizeUrl: '', error: '' })
  const [confirmUnlinkGithub, setConfirmUnlinkGithub] = useState(false)
  const [unlinkingGithub, setUnlinkingGithub] = useState(false)

  const [showDeleteForm, setShowDeleteForm] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteConfirmUser, setDeleteConfirmUser] = useState('')
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const githubPollStopRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      try { githubPollStopRef.current?.() } catch {}
      githubPollStopRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!open) {
      try { githubPollStopRef.current?.() } catch {}
      githubPollStopRef.current = null
      setShowSessions(false)
      setConfirmKickOthers(false)
      setKickingKey('')
      setShowEmailForm(false)
      setEmailDraft('')
      setEmailCodeDraft('')
      setEmailPasswordDraft('')
      setEmailInfo('')
      setEmailError('')
      setShowDisable2faForm(false)
      setDisable2faPassword('')
      setDisable2faBusy(false)
      setDisable2faError('')
      setGithubBind({ starting: false, pending: false, authorizeUrl: '', error: '' })
      setConfirmUnlinkGithub(false)
      setUnlinkingGithub(false)
      setShowDeleteForm(false)
      setDeletePassword('')
      setDeleteConfirmUser('')
      setDeletingAccount(false)
      setDeleteError('')
    }
  }, [open])

  useEffect(() => {
    if (emailCooldown <= 0) return undefined
    const timer = setTimeout(() => {
      setEmailCooldown((prev) => (prev > 1 ? prev - 1 : 0))
    }, 1000)
    return () => clearTimeout(timer)
  }, [emailCooldown])

  const boundEmail = activeDevice?.email || ''
  const githubLinked = Boolean(activeDevice?.githubLinked || activeDevice?.githubLogin)
  const githubLogin = String(activeDevice?.githubLogin || '').trim()
  const hasPassword = activeDevice?.hasPassword !== false

  const cancelGithubBind = () => {
    try { githubPollStopRef.current?.() } catch {}
    githubPollStopRef.current = null
    setGithubBind({ starting: false, pending: false, authorizeUrl: '', error: '' })
  }

  const handleStartGithubBind = async () => {
    if (!activeDevice?.baseUrl || !activeDevice?.token || githubBind.starting) return
    cancelGithubBind()
    setConfirmUnlinkGithub(false)
    setGithubBind({ starting: true, pending: false, authorizeUrl: '', error: '' })
    try {
      const flow = await launchGithubOAuthFlow({
        serverUrl: activeDevice.baseUrl,
        mode: 'bind',
        token: activeDevice.token,
        deviceId: activeDevice.id || '',
      })
      if (!mountedRef.current || flow.redirected) return
      setGithubBind({ starting: false, pending: true, authorizeUrl: flow.authorizeUrl, error: '' })
      githubPollStopRef.current = startGithubOAuthPolling({
        serverUrl: flow.baseUrl,
        pollToken: flow.pollToken,
        token: activeDevice.token,
        popup: flow.popup,
        onComplete: (res) => {
          githubPollStopRef.current = null
          if (!mountedRef.current) return
          setGithubBind({ starting: false, pending: false, authorizeUrl: '', error: '' })
          if (res?.user) onGithubLinked?.(res.user)
        },
        onError: (msg) => {
          githubPollStopRef.current = null
          if (!mountedRef.current) return
          setGithubBind({ starting: false, pending: false, authorizeUrl: '', error: msg })
        },
      })
    } catch (err) {
      if (!mountedRef.current) return
      setGithubBind({ starting: false, pending: false, authorizeUrl: '', error: String(err?.message || err) })
    }
  }

  const handleConfirmUnlinkGithub = async () => {
    if (!onUnlinkGithub || unlinkingGithub) return
    setUnlinkingGithub(true)
    setGithubBind((prev) => ({ ...prev, error: '' }))
    try {
      await onUnlinkGithub()
      if (mountedRef.current) setConfirmUnlinkGithub(false)
    } catch (err) {
      if (mountedRef.current) {
        setGithubBind((prev) => ({ ...prev, error: String(err?.message || err) }))
      }
    } finally {
      if (mountedRef.current) setUnlinkingGithub(false)
    }
  }
  const sessionList = Array.isArray(clientSessions?.sessions) ? clientSessions.sessions : []
  const effectiveOnlineClients = Math.max(
    Number(onlineClientCount) || 0,
    Number(clientSessions?.onlineCount) || 0,
  )
  const hasOtherSessions = sessionList.some((s) => !s.isCurrent) || effectiveOnlineClients > 1

  const handleRefreshSessions = async () => {
    if (!onRefreshClientSessions || refreshingSessions) return
    setRefreshingSessions(true)
    try {
      await onRefreshClientSessions()
    } finally {
      setRefreshingSessions(false)
    }
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
      setEmailInfo(res?.message || bi('验证码已发送，请查收邮件', 'Verification code sent.'))
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
    const pwd = emailPasswordDraft
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
      setEmailError(bi('请输入有效的邮箱地址', 'Please enter a valid email address'))
      return
    }
    if (!/^\d{6}$/.test(code)) {
      setEmailError(bi('请输入 6 位邮箱验证码', 'Please enter the 6-digit code'))
      return
    }
    if (!pwd) {
      setEmailError(bi('请输入当前账号密码以确认身份', 'Please enter your current password'))
      return
    }
    setEmailBinding(true)
    setEmailError('')
    try {
      await onBindAccountEmail(clean, code, pwd)
      setShowEmailForm(false)
      setEmailDraft('')
      setEmailCodeDraft('')
      setEmailPasswordDraft('')
    } catch (err) {
      setEmailError(String(err?.message || err))
    } finally {
      setEmailBinding(false)
    }
  }

  const handleConfirmDisable2fa = async (e) => {
    e.preventDefault()
    if (!onToggleLogin2fa || disable2faBusy) return
    const pwd = disable2faPassword
    if (!pwd) {
      setDisable2faError(bi('请输入当前账号密码', 'Please enter your current password'))
      return
    }
    setDisable2faBusy(true)
    setDisable2faError('')
    try {
      await onToggleLogin2fa(false, pwd)
      setShowDisable2faForm(false)
      setDisable2faPassword('')
      setDisable2faError('')
    } catch (err) {
      setDisable2faError(String(err?.message || err))
    } finally {
      setDisable2faBusy(false)
    }
  }

  const handleConfirmDeleteAccount = async (e) => {
    e.preventDefault()
    if (!onDeleteAccount || deletingAccount) return
    if (hasPassword) {
      if (!deletePassword) {
        setDeleteError(bi('请输入当前账号密码以确认注销', 'Please enter your current password to confirm'))
        return
      }
    } else {
      const expected = String(activeDevice?.username || '').trim().toLowerCase()
      if (!deleteConfirmUser.trim() || deleteConfirmUser.trim().toLowerCase() !== expected) {
        setDeleteError(bi(`请输入用户名 ${activeDevice?.username || ''} 以确认`, `Type ${activeDevice?.username || ''} to confirm`))
        return
      }
    }
    setDeletingAccount(true)
    setDeleteError('')
    try {
      await onDeleteAccount({
        currentPassword: hasPassword ? deletePassword : '',
        confirmUsername: hasPassword ? '' : deleteConfirmUser.trim(),
      })
      if (mountedRef.current) {
        setShowDeleteForm(false)
        setDeletePassword('')
        setDeleteConfirmUser('')
      }
      onClose?.()
    } catch (err) {
      if (mountedRef.current) {
        setDeleteError(String(err?.message || err))
      }
    } finally {
      if (mountedRef.current) setDeletingAccount(false)
    }
  }

  const effTier = String(turnQuota?.tier || activeDevice?.tier || (isAdmin ? 'admin' : 'free')).toLowerCase()

  return (
    <section>
      <div className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-slate-400">
        {bi('账号与安全', 'Account & Security')}
      </div>
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white dark:border-slate-800 dark:bg-[#22252E]">
        {/* Profile Header */}
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#4D6BFE]/15 text-sm font-bold text-[#4D6BFE]">
            {activeDevice?.username ? activeDevice.username.slice(0, 1).toUpperCase() : <User className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-bold text-slate-900 dark:text-white">{displayUser}</span>
              {effTier === 'admin' ? (
                <span className="shrink-0 rounded-md bg-[#4D6BFE]/14 px-1.5 py-0.5 text-[10px] font-semibold text-[#4D6BFE]">
                  {t('common.admin')}
                </span>
              ) : effTier === 'ultra' ? (
                <span className="shrink-0 rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400">
                  Ultra
                </span>
              ) : effTier === 'pro' ? (
                <span className="shrink-0 rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                  Pro
                </span>
              ) : (
                <span className="shrink-0 rounded-md bg-slate-200/80 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  Free
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
        </div>

        {/* Signed-in Devices */}
        {activeDevice && (sessionList.length > 0 || effectiveOnlineClients > 0) && (
          <div className="border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              aria-expanded={showSessions}
              onClick={() => {
                const next = !showSessions
                setShowSessions(next)
                setConfirmKickOthers(false)
                if (next) void handleRefreshSessions()
              }}
              className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left transition hover:bg-slate-50/80 dark:hover:bg-slate-800/50"
            >
              <div className="flex min-w-0 items-center gap-2 text-xs text-slate-700 dark:text-slate-200">
                <Smartphone className="h-3.5 w-3.5 shrink-0 text-[#4D6BFE]" />
                <span className="truncate">{bi('已登录终端', 'Signed-in Devices')}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span
                  className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                    effectiveOnlineClients > 1
                      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      : 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {bi(`${effectiveOnlineClients} 在线`, `${effectiveOnlineClients} online`)}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition-transform ${showSessions ? 'rotate-180' : ''}`} />
              </div>
            </button>

            {showSessions && (
              <div className="space-y-2 border-t border-slate-100/80 bg-slate-50/70 px-3 py-2.5 dark:border-slate-800/80 dark:bg-[#171921]">
                <div className="flex items-center justify-between gap-2 px-0.5">
                  <span className="text-[10.5px] text-slate-400">
                    {bi(`共 ${sessionList.length || effectiveOnlineClients} 台设备记录`, `${sessionList.length || effectiveOnlineClients} devices`)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {onRefreshClientSessions && (
                      <button
                        type="button"
                        onClick={() => void handleRefreshSessions()}
                        aria-label={bi('刷新终端列表', 'Refresh devices')}
                        className="rounded-lg p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                      >
                        <RefreshCw className={`h-3 w-3 ${refreshingSessions ? 'animate-spin text-[#4D6BFE]' : ''}`} />
                      </button>
                    )}
                    {hasOtherSessions && onRevokeOtherClientSessions && (
                      <button
                        type="button"
                        disabled={kickingOthers}
                        onClick={() => setConfirmKickOthers((v) => !v)}
                        className="rounded-lg px-2 py-0.5 text-[11px] font-medium text-rose-500 hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-950/40"
                      >
                        {bi('下线其他', 'Sign Out Others')}
                      </button>
                    )}
                  </div>
                </div>

                {confirmKickOthers && (
                  <div className="flex items-center justify-between gap-2 rounded-xl bg-rose-50/90 px-2.5 py-2 text-[11.5px] text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                    <span>{bi('下线除本机外的所有终端？', 'Sign out all other devices?')}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setConfirmKickOthers(false)}
                        className="rounded-lg bg-white px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        type="button"
                        disabled={kickingOthers}
                        onClick={async () => {
                          setKickingOthers(true)
                          try {
                            await onRevokeOtherClientSessions?.()
                            setConfirmKickOthers(false)
                          } finally {
                            setKickingOthers(false)
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-0.5 text-[11px] font-semibold text-white disabled:opacity-60"
                      >
                        {kickingOthers && <Loader2 className="h-3 w-3 animate-spin" />}
                        <span>{bi('确认', 'Confirm')}</span>
                      </button>
                    </div>
                  </div>
                )}

                {sessionList.length > 0 && (
                  <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-[#1E212B]">
                    {sessionList.map((s, idx) => {
                      const rowKey = s.sid || s.clientId || `sess-${idx}`
                      const isKicking = kickingKey === rowKey
                      const IconComp = s.clientKind === 'desktop' ? Laptop : s.clientKind === 'mobile' ? Smartphone : Globe
                      return (
                        <div key={rowKey} className="flex items-center justify-between gap-2 px-2.5 py-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <div
                              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                                s.isCurrent
                                  ? 'bg-[#4D6BFE]/14 text-[#4D6BFE]'
                                  : s.online
                                    ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                                    : 'bg-slate-100 text-slate-400 dark:bg-slate-800'
                              }`}
                            >
                              <IconComp className="h-3.5 w-3.5" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[11.5px] font-semibold text-slate-800 dark:text-slate-100">
                                  {formatClientDeviceLabel(s.deviceName, s.clientKind, lang)}
                                </span>
                                {s.isCurrent && (
                                  <span className="shrink-0 rounded bg-[#4D6BFE]/14 px-1.5 py-0.5 text-[9.5px] font-semibold text-[#4D6BFE]">
                                    {bi('本机', 'This device')}
                                  </span>
                                )}
                                {s.connectionCount > 1 && (
                                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9.5px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                                    {bi(`${s.connectionCount} 窗口`, `${s.connectionCount} tabs`)}
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">
                                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.online ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                                <span>
                                  {s.online
                                    ? t('common.online')
                                    : s.lastSeenAt
                                      ? `${t('common.offline')} · ${formatRelativeSeen(s.lastSeenAt, lang)}`
                                      : t('common.offline')}
                                </span>
                                {s.ip && (
                                  <>
                                    <span>·</span>
                                    <span className="truncate font-mono">{s.ip}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          {!s.isCurrent && onRevokeClientSession && (
                            <button
                              type="button"
                              disabled={isKicking}
                              onClick={async () => {
                                setKickingKey(rowKey)
                                try {
                                  await onRevokeClientSession({ sid: s.sid || '', clientId: s.clientId || '' })
                                } finally {
                                  setKickingKey('')
                                }
                              }}
                              title={bi('踢出此设备', 'Sign out this device')}
                              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[10.5px] font-medium text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-400 dark:hover:border-rose-900/60 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
                            >
                              {isKicking ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
                              <span>{bi('踢下线', 'Kick')}</span>
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Email & Login 2FA */}
        {activeDevice && (
          <div className="border-t border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="truncate" title={boundEmail || undefined}>
                  {boundEmail || bi('未绑定邮箱', 'No email linked')}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setShowEmailForm((v) => {
                      if (v) setEmailPasswordDraft('')
                      return !v
                    })
                    setEmailError('')
                    setEmailInfo('')
                  }}
                  className="shrink-0 rounded-lg px-1.5 py-0.5 text-[11.5px] font-medium text-[#4D6BFE] hover:bg-[#4D6BFE]/10"
                >
                  {showEmailForm ? bi('收起', 'Hide') : boundEmail ? bi('换绑', 'Change') : bi('绑定', 'Link')}
                </button>
                {emailEnabled && boundEmail && onToggleLogin2fa && (
                  <>
                    <span aria-hidden="true" className="h-3.5 w-px bg-slate-200 dark:bg-slate-700/80" />
                    <div className="flex items-center gap-1">
                      <span className="text-[11px] text-slate-500 dark:text-slate-400">
                        {bi('二次验证', '2FA')}
                      </span>
                      <HelpButton
                        active={openHelpKey === '2fa'}
                        onClick={() => toggleHelp('2fa')}
                        label={bi('查看邮箱二次验证说明', 'About email login 2FA')}
                      />
                      <ToggleSwitch
                        checked={Boolean(activeDevice?.loginEmail2fa)}
                        disabled={disable2faBusy}
                        onChange={() => {
                          if (!activeDevice?.loginEmail2fa) {
                            setShowDisable2faForm(false)
                            setDisable2faPassword('')
                            setDisable2faError('')
                            void onToggleLogin2fa(true)
                          } else {
                            setShowDisable2faForm((v) => !v)
                            setDisable2faPassword('')
                            setDisable2faError('')
                          }
                        }}
                        label={bi('切换登录邮箱二次验证', 'Toggle email login 2FA')}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {showEmailForm && (
              <div className="mt-2 rounded-xl border border-slate-200/80 bg-slate-50/90 p-2.5 dark:border-slate-700/80 dark:bg-[#171921]">
                {emailEnabled ? (
                  <form onSubmit={handleCommitBindEmail} className="space-y-2">
                    <input
                      type="email"
                      value={emailDraft}
                      onChange={(e) => setEmailDraft(e.target.value)}
                      placeholder={boundEmail ? bi(`新邮箱（当前：${boundEmail}）`, `New email (${boundEmail})`) : bi('输入邮箱地址', 'Email address')}
                      autoComplete="email"
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1E212B] dark:text-white"
                    />
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={emailCodeDraft}
                        onChange={(e) => setEmailCodeDraft(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder={bi('6 位验证码', '6-digit code')}
                        className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-mono text-xs tracking-widest text-slate-900 outline-none placeholder:font-sans placeholder:tracking-normal focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1E212B] dark:text-white"
                      />
                      <button
                        type="button"
                        disabled={emailSending || emailCooldown > 0}
                        onClick={handleSendBindCode}
                        className="shrink-0 rounded-xl border border-[#4D6BFE]/40 bg-[#F2F5FF] px-2.5 py-1.5 text-[11px] font-semibold text-[#2842C9] disabled:opacity-55 dark:bg-[#1E253A] dark:text-[#A9BDFF]"
                      >
                        {emailSending ? bi('发送中', 'Sending') : emailCooldown > 0 ? `${emailCooldown}s` : bi('获取验证码', 'Send Code')}
                      </button>
                    </div>
                    <input
                      type="password"
                      value={emailPasswordDraft}
                      onChange={(e) => setEmailPasswordDraft(e.target.value)}
                      placeholder={bi('当前账号密码', 'Current password')}
                      autoComplete="current-password"
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1E212B] dark:text-white"
                    />
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
                        onClick={() => {
                          setShowEmailForm(false)
                          setEmailPasswordDraft('')
                          setEmailError('')
                        }}
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
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {bi('服务器尚未配置邮件服务（SMTP / Resend）。', 'Email service (SMTP / Resend) not configured on server.')}
                  </div>
                )}
              </div>
            )}

            {showDisable2faForm && activeDevice?.loginEmail2fa && (
              <form
                onSubmit={handleConfirmDisable2fa}
                className="mt-2 space-y-2 rounded-xl border border-rose-200/80 bg-rose-50/70 p-2.5 dark:border-rose-900/50 dark:bg-rose-950/30"
              >
                <div className="text-[11px] font-medium text-rose-700 dark:text-rose-200">
                  {bi('输入当前密码以关闭二次验证', 'Enter current password to disable 2FA')}
                </div>
                <input
                  type="password"
                  value={disable2faPassword}
                  onChange={(e) => setDisable2faPassword(e.target.value)}
                  placeholder={bi('当前账号密码', 'Current password')}
                  autoComplete="current-password"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#1E212B] dark:text-white"
                />
                {disable2faError && (
                  <div className="rounded-lg bg-rose-100/80 px-2.5 py-1.5 text-[11px] text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                    {disable2faError}
                  </div>
                )}
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    disabled={disable2faBusy}
                    onClick={() => {
                      setShowDisable2faForm(false)
                      setDisable2faPassword('')
                      setDisable2faError('')
                    }}
                    className="rounded-lg px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-slate-800"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={disable2faBusy}
                    className="inline-flex items-center gap-1 rounded-lg bg-rose-500 px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
                  >
                    {disable2faBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                    <span>{bi('确认关闭', 'Confirm')}</span>
                  </button>
                </div>
              </form>
            )}

            {emailEnabled && boundEmail && onToggleLogin2fa && (
              <HelpCallout show={openHelpKey === '2fa'}>
                {bi(
                  '开启后，使用密码登录账号时需要额外输入发送到绑定邮箱的 6 位一次性验证码，防止密码泄露后被他人登录。',
                  'When enabled, signing in with your password also requires a 6-digit one-time code sent to your linked email.',
                )}
              </HelpCallout>
            )}
          </div>
        )}

        {/* GitHub OAuth Link / Unlink */}
        {activeDevice && (githubEnabled || githubLinked) && (
          <div className="border-t border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <GithubMark className="h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-slate-300" />
                <span className="truncate">
                  {githubLinked
                    ? githubLogin
                      ? `GitHub · @${githubLogin}`
                      : bi('已绑定 GitHub', 'GitHub linked')
                    : bi('未绑定 GitHub', 'GitHub not linked')}
                </span>
              </div>
              {githubLinked ? (
                hasPassword && onUnlinkGithub ? (
                  <button
                    type="button"
                    disabled={unlinkingGithub}
                    onClick={() => {
                      setConfirmUnlinkGithub((v) => !v)
                      setGithubBind((prev) => ({ ...prev, error: '' }))
                    }}
                    className="shrink-0 rounded-lg px-2 py-0.5 text-[11.5px] font-medium text-rose-500 hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-950/40"
                  >
                    {confirmUnlinkGithub ? bi('收起', 'Hide') : bi('解绑', 'Unlink')}
                  </button>
                ) : (
                  <span
                    title={bi('由 GitHub 注册，需先设置密码后才可解绑', 'Created via GitHub — set a password before unlinking')}
                    className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                  >
                    {bi('已绑定', 'Linked')}
                  </span>
                )
              ) : (
                <button
                  type="button"
                  disabled={githubBind.starting || githubBind.pending}
                  onClick={() => void handleStartGithubBind()}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-[11.5px] font-medium text-[#4D6BFE] hover:bg-[#4D6BFE]/10 disabled:opacity-50"
                >
                  {githubBind.starting && <Loader2 className="h-3 w-3 animate-spin" />}
                  <span>{githubBind.starting ? bi('连接中', 'Opening') : bi('绑定', 'Link')}</span>
                </button>
              )}
            </div>

            {githubBind.pending && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-[#4D6BFE]/30 bg-[#F2F5FF] px-2.5 py-2 text-[11px] dark:border-[#4D6BFE]/40 dark:bg-[#1B2236]">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-[#2842C9] dark:text-[#A9BDFF]">
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  <span className="truncate">{bi('等待浏览器完成 GitHub 授权…', 'Waiting for GitHub auth…')}</span>
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <a
                    href={githubBind.authorizeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-medium text-[#4D6BFE] hover:underline dark:text-[#8DA2FF]"
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span>{bi('重开', 'Open')}</span>
                  </a>
                  <button
                    type="button"
                    onClick={cancelGithubBind}
                    className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}

            {confirmUnlinkGithub && githubLinked && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-rose-50/90 px-2.5 py-2 text-[11.5px] text-rose-700 dark:bg-rose-950/45 dark:text-rose-200">
                <span>{bi('确认解绑当前 GitHub 账号？', 'Unlink this GitHub account?')}</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    disabled={unlinkingGithub}
                    onClick={() => setConfirmUnlinkGithub(false)}
                    className="rounded-lg bg-white px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-200"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={unlinkingGithub}
                    onClick={() => void handleConfirmUnlinkGithub()}
                    className="inline-flex items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-0.5 text-[11px] font-semibold text-white disabled:opacity-60"
                  >
                    {unlinkingGithub && <Loader2 className="h-3 w-3 animate-spin" />}
                    <span>{bi('确认', 'Confirm')}</span>
                  </button>
                </div>
              </div>
            )}

            {githubBind.error && (
              <div className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
                {githubBind.error}
              </div>
            )}
          </div>
        )}

        {/* Permanent Account Deletion (App Store Guideline 5.1.1(v)) */}
        {activeDevice?.username && onDeleteAccount && (
          <div className="border-t border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <Trash2 className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                <span className="truncate">{bi('注销账号', 'Delete Account')}</span>
              </div>
              <button
                type="button"
                disabled={deletingAccount}
                onClick={() => {
                  setShowDeleteForm((v) => {
                    if (v) {
                      setDeletePassword('')
                      setDeleteConfirmUser('')
                    }
                    return !v
                  })
                  setDeleteError('')
                }}
                className="shrink-0 rounded-lg px-2 py-0.5 text-[11.5px] font-medium text-rose-500 hover:bg-rose-50 disabled:opacity-50 dark:hover:bg-rose-950/40"
              >
                {showDeleteForm ? bi('收起', 'Hide') : bi('永久删除', 'Delete')}
              </button>
            </div>

            {showDeleteForm && (
              <form
                onSubmit={handleConfirmDeleteAccount}
                className="mt-2 space-y-2 rounded-xl border border-rose-200/80 bg-rose-50/75 p-2.5 dark:border-rose-900/55 dark:bg-rose-950/35"
              >
                <p className="text-[11px] leading-relaxed text-rose-700 dark:text-rose-200">
                  {bi(
                    '此操作将永久删除你的中继账号、已绑定电脑凭证和所有设备会话，且不可恢复（本地电脑上的项目文件与对话不会受到影响）。',
                    'This permanently deletes your relay account, linked computer credentials, and all active sessions. This cannot be undone (files on your computers are unaffected).',
                  )}
                </p>
                {hasPassword ? (
                  <input
                    type="password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    placeholder={bi('输入当前账号密码以确认注销', 'Enter current password to confirm')}
                    autoComplete="current-password"
                    className="w-full rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs text-slate-900 outline-none focus:border-rose-500 dark:border-rose-900/70 dark:bg-[#1E212B] dark:text-white"
                  />
                ) : (
                  <input
                    type="text"
                    value={deleteConfirmUser}
                    onChange={(e) => setDeleteConfirmUser(e.target.value)}
                    placeholder={bi(`输入用户名 ${activeDevice.username} 确认`, `Type ${activeDevice.username} to confirm`)}
                    autoComplete="off"
                    className="w-full rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs text-slate-900 outline-none focus:border-rose-500 dark:border-rose-900/70 dark:bg-[#1E212B] dark:text-white"
                  />
                )}
                {deleteError && (
                  <div className="rounded-lg bg-rose-100/80 px-2.5 py-1.5 text-[11px] text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                    {deleteError}
                  </div>
                )}
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    disabled={deletingAccount}
                    onClick={() => {
                      setShowDeleteForm(false)
                      setDeletePassword('')
                      setDeleteConfirmUser('')
                      setDeleteError('')
                    }}
                    className="rounded-lg px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-slate-800"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={deletingAccount}
                    className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-rose-500 disabled:opacity-60"
                  >
                    {deletingAccount && <Loader2 className="h-3 w-3 animate-spin" />}
                    <span>{bi('确认永久注销', 'Delete Forever')}</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
