import React, { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Lock,
  Mail,
  Moon,
  ScanLine,
  Server,
  ShieldCheck,
  Sparkles,
  Sun,
  Terminal,
  Ticket,
  User,
  UserPlus,
} from 'lucide-react'
import {
  detectDefaultServerUrl,
  fetchBootstrapStatus,
  loginAccount,
  normalizeBaseUrl,
  registerAccount,
  resetAccountPassword,
  sendEmailVerificationCode,
} from '../lib/wsClient.js'
import { QrScannerModal } from './QrScannerModal.jsx'
import { useI18n } from '../lib/i18n.jsx'

const LOGIN_INPUT_CLS =
  'w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-[#4D6BFE] focus:bg-white focus:ring-2 focus:ring-[#4D6BFE]/15 dark:border-slate-700/90 dark:bg-[#14161D] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-[#4D6BFE] dark:focus:bg-[#191C26] dark:focus:ring-[#4D6BFE]/25'

export function LoginScreen({
  onSuccess,
  initialError = '',
  isAddingDevice = false,
  initialServerUrl = '',
  initialInviteCode = '',
  autoOpenScanner = false,
  darkMode = false,
  onToggleDark = null,
  onCancel = null,
}) {
  const { lang, setLang, bi, t } = useI18n()
  // 'login' | 'register' | 'reset'
  const [mode, setMode] = useState(() =>
    initialInviteCode || autoOpenScanner ? 'register' : 'login',
  )
  const [serverUrl, setServerUrl] = useState(() => initialServerUrl || detectDefaultServerUrl())
  const [showAdvancedServer, setShowAdvancedServer] = useState(() => {
    const init = String(initialServerUrl || detectDefaultServerUrl() || '')
    return !init || /your-relay\.example\.com/i.test(init)
  })
  const [showSetupGuide, setShowSetupGuide] = useState(false)
  const [osTab, setOsTab] = useState('unix') // 'win' | 'unix'
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(Boolean(autoOpenScanner))
  const [hasUsers, setHasUsers] = useState(true)
  const [emailEnabled, setEmailEnabled] = useState(false)

  // Account fields
  const [username, setUsername] = useState('')
  const [accountPassword, setAccountPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [inviteCode, setInviteCode] = useState(initialInviteCode || '')
  const [email, setEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [login2fa, setLogin2fa] = useState({ required: false, maskedEmail: '' })
  const [codeSending, setCodeSending] = useState(false)
  const [codeCooldown, setCodeCooldown] = useState(0)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialError)
  const [infoMsg, setInfoMsg] = useState('')

  useEffect(() => {
    if (initialError) setError(initialError)
  }, [initialError])

  useEffect(() => {
    if (initialServerUrl) setServerUrl(initialServerUrl)
  }, [initialServerUrl])

  useEffect(() => {
    if (initialInviteCode) {
      setInviteCode(initialInviteCode)
      setMode('register')
    }
  }, [initialInviteCode])

  const effectiveServer = normalizeBaseUrl(serverUrl)

  useEffect(() => {
    let cancelled = false
    fetchBootstrapStatus(effectiveServer).then((st) => {
      if (!cancelled) {
        setHasUsers(st.hasUsers)
        setEmailEnabled(Boolean(st.emailEnabled))
      }
    })
    return () => {
      cancelled = true
    }
  }, [effectiveServer])

  useEffect(() => {
    if (codeCooldown <= 0) return undefined
    const timer = setTimeout(() => {
      setCodeCooldown((prev) => (prev > 1 ? prev - 1 : 0))
    }, 1000)
    return () => clearTimeout(timer)
  }, [codeCooldown])

  const handleSendEmailCode = async (purpose) => {
    setError('')
    setInfoMsg('')
    const cleanEmail = email.trim()
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
      setError(bi('请先输入有效的邮箱地址', 'Please enter a valid email address'))
      return
    }
    if (purpose === 'register' && !inviteCode.trim()) {
      setError(bi('请先填写邀请码，再获取邮箱验证码', 'Enter your invite code before requesting a verification code'))
      return
    }
    setCodeSending(true)
    try {
      const res = await sendEmailVerificationCode(serverUrl, {
        purpose,
        email: cleanEmail,
        inviteCode: purpose === 'register' ? inviteCode.trim() : '',
      })
      setCodeCooldown(res.cooldownSec || 60)
      setInfoMsg(res.message || bi('验证码已发送，请查收邮件', 'Verification code sent. Please check your inbox.'))
    } catch (err) {
      if (err?.retryAfterSec) setCodeCooldown(err.retryAfterSec)
      setError(String(err?.message || err))
    } finally {
      setCodeSending(false)
    }
  }

  const winSetupCmd = `irm ${effectiveServer}/setup.ps1 | iex`
  const unixSetupCmd = `curl -fsSL ${effectiveServer}/setup.sh | bash`
  const activeSetupCmd = osTab === 'win' ? winSetupCmd : unixSetupCmd

  const handleCopySetupCmd = async () => {
    try {
      await navigator.clipboard.writeText(activeSetupCmd)
    } catch {}
    setCopiedCmd(true)
    setTimeout(() => setCopiedCmd(false), 1800)
  }

  const handleQrDetected = useCallback((rawText) => {
    setScannerOpen(false)
    const trimmed = String(rawText || '').trim()
    try {
      if (/^https?:\/\//i.test(trimmed)) {
        const u = new URL(trimmed)
        const inv = u.searchParams.get('invite')
        if (inv) {
          const basePath = u.pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '')
          setServerUrl(`${u.origin}${basePath}`)
          setInviteCode(inv.trim())
          setMode('register')
          setError('')
          return
        }
      }
    } catch {}
    if (/^INV-[A-Z0-9-]+$/i.test(trimmed)) {
      setInviteCode(trimmed.toUpperCase())
      setMode('register')
      setError('')
      return
    }
    setError(
      bi(
        '识别到的二维码不是有效的注册邀请码，请扫描管理员分享的邀请注册二维码',
        'Invalid QR code. Please scan an invite registration QR code.',
      ),
    )
  }, [bi])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setInfoMsg('')

    if (mode === 'login') {
      if (!username.trim() || !accountPassword) {
        setError(emailEnabled ? bi('请输入用户名/邮箱和密码', 'Please enter username/email and password') : bi('请输入用户名和密码', 'Please enter username and password'))
        return
      }
      setLoading(true)
      try {
        const result = await loginAccount(serverUrl, {
          username: username.trim(),
          password: accountPassword,
          ...(login2fa.required ? { emailCode: emailCode.trim() } : {}),
        })
        if (result.requires2fa) {
          setLogin2fa({ required: true, maskedEmail: result.maskedEmail || '' })
          if (result.cooldownSec > 0) setCodeCooldown(result.cooldownSec)
          if (result.error) setError(result.error)
          else if (result.message) setInfoMsg(result.message)
          return
        }
        setLogin2fa({ required: false, maskedEmail: '' })
        setEmailCode('')
        onSuccess({
          baseUrl: result.baseUrl,
          token: result.token,
          roomId: result.roomId,
          username: result.username,
          email: result.email,
          loginEmail2fa: Boolean(result.loginEmail2fa),
          role: result.role,
          label: result.label,
          devices: result.devices,
          bridges: result.bridges,
          authMode: 'account',
        })
      } catch (err) {
        setError(String(err?.message || err))
      } finally {
        setLoading(false)
      }
      return
    }

    if (mode === 'register') {
      if (!inviteCode.trim()) {
        setError(bi('请输入管理员提供的一次性邀请码', 'Please enter your single-use invite code'))
        return
      }
      if (!username.trim()) {
        setError(bi('请输入用户名（3~32 位字母/数字/下划线）', 'Please enter a username (3-32 letters, numbers, or underscores)'))
        return
      }
      if (accountPassword.length < 8) {
        setError(bi('密码长度至少需要 8 位', 'Password must be at least 8 characters'))
        return
      }
      if (accountPassword !== confirmPassword) {
        setError(bi('两次输入的密码不一致', 'Passwords do not match'))
        return
      }
      const cleanEmail = emailEnabled ? email.trim() : ''
      if (cleanEmail) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
          setError(bi('请输入有效的邮箱地址，或留空直接注册', 'Enter a valid email address, or leave blank to skip'))
          return
        }
        if (!/^\d{6}$/.test(emailCode.trim())) {
          setError(bi('请输入邮箱收到的 6 位验证码，或清空邮箱直接注册', 'Enter the 6-digit email code, or clear email to skip'))
          return
        }
      }
      setLoading(true)
      try {
        const result = await registerAccount(serverUrl, {
          username: username.trim(),
          password: accountPassword,
          inviteCode: inviteCode.trim(),
          ...(cleanEmail ? { email: cleanEmail, emailCode: emailCode.trim() } : {}),
        })
        onSuccess({
          baseUrl: result.baseUrl,
          token: result.token,
          roomId: result.roomId,
          username: result.username,
          email: result.email,
          role: result.role,
          label: result.label,
          devices: result.devices,
          bridges: result.bridges,
          authMode: 'account',
        })
      } catch (err) {
        setError(String(err?.message || err))
      } finally {
        setLoading(false)
      }
      return
    }

    if (mode === 'reset') {
      const cleanEmail = email.trim()
      if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
        setError(bi('请输入账号绑定的邮箱地址', 'Please enter your linked email address'))
        return
      }
      if (!/^\d{6}$/.test(emailCode.trim())) {
        setError(bi('请输入 6 位邮箱验证码', 'Please enter the 6-digit email code'))
        return
      }
      if (accountPassword.length < 8) {
        setError(bi('新密码长度至少需要 8 位', 'New password must be at least 8 characters'))
        return
      }
      if (accountPassword !== confirmPassword) {
        setError(bi('两次输入的新密码不一致', 'New passwords do not match'))
        return
      }
      setLoading(true)
      try {
        const res = await resetAccountPassword(serverUrl, {
          email: cleanEmail,
          code: emailCode.trim(),
          newPassword: accountPassword,
        })
        setMode('login')
        setUsername(res.username || cleanEmail)
        setAccountPassword('')
        setConfirmPassword('')
        setEmailCode('')
        setInfoMsg(bi('密码已重置，请使用新密码登录', 'Password reset successful. Sign in with your new password.'))
      } catch (err) {
        setError(String(err?.message || err))
      } finally {
        setLoading(false)
      }
      return
    }
  }

  const isAccountTab = mode === 'login' || mode === 'register'
  const isDesktopApp = typeof window !== 'undefined' && Boolean(window.allinoneDesktop)

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-y-auto bg-gradient-to-b from-[#F5F8FF] to-white px-5 py-8 dark:from-[#16171A] dark:to-[#111216]">
      {isDesktopApp && <div className="app-drag fixed inset-x-0 top-0 z-10 h-9" />}
      {/* Floating theme + bilingual switcher on login screen */}
      <div className="app-no-drag pt-safe fixed top-3 right-4 z-20 flex items-center gap-2">
        {onToggleDark && (
          <button
            type="button"
            onClick={onToggleDark}
            aria-label={darkMode ? bi('切换浅色主题', 'Switch to light mode') : bi('切换深色主题', 'Switch to dark mode')}
            title={darkMode ? bi('切换浅色主题', 'Switch to light mode') : bi('切换深色主题', 'Switch to dark mode')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200/80 bg-white/90 text-slate-600 shadow-xs backdrop-blur-md transition hover:border-[#4D6BFE]/50 hover:text-[#4D6BFE] active:scale-95 dark:border-slate-700/80 dark:bg-[#1E2028]/90 dark:text-slate-300 dark:hover:text-[#7E96FF]"
          >
            {darkMode ? <Sun className="h-3.5 w-3.5 text-amber-400" /> : <Moon className="h-3.5 w-3.5 text-slate-600" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
          aria-label={bi('切换语言', 'Switch language')}
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/90 px-3 py-1.5 text-[11.5px] font-semibold text-slate-600 shadow-xs backdrop-blur-md transition hover:border-[#4D6BFE]/50 hover:text-[#4D6BFE] active:scale-95 dark:border-slate-700/80 dark:bg-[#1E2028]/90 dark:text-slate-300"
        >
          <Globe className="h-3.5 w-3.5 text-[#4D6BFE]" />
          <span>{lang === 'en' ? '中文' : 'EN'}</span>
        </button>
      </div>
      <div className="w-full max-w-sm">
        {isAddingDevice && onCancel && (
          <div className="pt-safe mb-3 flex items-center">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>{t('common.back')}</span>
            </button>
          </div>
        )}

        {/* Brand mark */}
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 h-16 w-16 overflow-hidden rounded-[20px] bg-[#03080E] shadow-xl shadow-blue-950/35 ring-1 ring-white/10">
            <img src="./icon-192.png" alt="All in One" className="h-full w-full object-cover" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
            {isAddingDevice ? bi('添加账号', 'Add Account') : 'All in One'}
          </h1>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-3.5 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xl shadow-slate-200/40 dark:border-slate-800 dark:bg-[#1E2028] dark:shadow-none"
        >
          {/* Primary Account Tabs */}
          {isAccountTab && (
            <div className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-100 p-1 dark:bg-[#14161C]">
              <button
                type="button"
                onClick={() => {
                  setMode('login')
                  setError('')
                  setInfoMsg('')
                }}
                className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition ${
                  mode === 'login'
                    ? 'bg-white text-[#4D6BFE] shadow-xs dark:bg-[#262A36] dark:text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                }`}
              >
                <User className="h-3.5 w-3.5" />
                <span>{bi('登录', 'Sign In')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register')
                  setError('')
                  setInfoMsg('')
                }}
                className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition ${
                  mode === 'register'
                    ? 'bg-white text-[#4D6BFE] shadow-xs dark:bg-[#262A36] dark:text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                }`}
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span>{bi('注册', 'Sign Up')}</span>
              </button>
            </div>
          )}

          {/* Account Login Form */}
          {mode === 'login' && (
            <>
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <User className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  <span>{emailEnabled ? bi('用户名 / 邮箱', 'Username / Email') : bi('用户名', 'Username')}</span>
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={emailEnabled ? bi('输入用户名或已绑定邮箱', 'Enter username or linked email') : bi('输入你的用户名', 'Enter your username')}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={LOGIN_INPUT_CLS}
                />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <Lock className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('密码', 'Password')}</span>
                  </label>
                  {emailEnabled && (
                    <button
                      type="button"
                      onClick={() => {
                        setMode('reset')
                        setError('')
                        setInfoMsg('')
                        setEmailCode('')
                        if (username.includes('@') && !email) setEmail(username.trim())
                      }}
                      className="text-[11.5px] font-medium text-[#4D6BFE] hover:underline"
                    >
                      {bi('忘记密码？', 'Forgot password?')}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={accountPassword}
                    onChange={(e) => {
                      setAccountPassword(e.target.value)
                      if (login2fa.required) {
                        setLogin2fa({ required: false, maskedEmail: '' })
                        setEmailCode('')
                      }
                    }}
                    placeholder={bi('输入账号密码', 'Enter password')}
                    autoComplete="current-password"
                    className={`${LOGIN_INPUT_CLS} pr-10`}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? bi('隐藏密码', 'Hide password') : bi('显示密码', 'Show password')}
                    className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-200"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {login2fa.required && (
                <div>
                  <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <ShieldCheck className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>
                      {login2fa.maskedEmail
                        ? bi(`邮箱验证码（${login2fa.maskedEmail}）`, `Email Code (${login2fa.maskedEmail})`)
                        : bi('邮箱二次验证码', 'Email 2FA Code')}
                    </span>
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      autoFocus
                      value={emailCode}
                      onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder={bi('6 位登录验证码', '6-digit login code')}
                      autoComplete="one-time-code"
                      className={`${LOGIN_INPUT_CLS} min-w-0 flex-1 border-[#4D6BFE] bg-white font-mono tracking-widest placeholder:font-sans placeholder:tracking-normal dark:border-[#4D6BFE]`}
                    />
                    <button
                      type="button"
                      disabled={loading || codeCooldown > 0}
                      onClick={async () => {
                        setError('')
                        setInfoMsg('')
                        setLoading(true)
                        try {
                          const res = await loginAccount(serverUrl, {
                            username: username.trim(),
                            password: accountPassword,
                          })
                          if (res.cooldownSec > 0) setCodeCooldown(res.cooldownSec)
                          if (res.message) setInfoMsg(res.message)
                        } catch (err) {
                          setError(String(err?.message || err))
                        } finally {
                          setLoading(false)
                        }
                      }}
                      className="shrink-0 rounded-2xl border border-[#4D6BFE]/40 bg-[#F2F5FF] px-3 py-2.5 text-xs font-semibold text-[#2842C9] disabled:opacity-55 dark:bg-[#1E253A] dark:text-[#A9BDFF]"
                    >
                      {codeCooldown > 0 ? `${codeCooldown}s` : bi('重发', 'Resend')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Account Invite-Gated Register Form */}
          {mode === 'register' && (
            <>
              {!hasUsers && (
                <div className="flex items-start gap-2 rounded-2xl border border-[#4D6BFE]/30 bg-[#F2F5FF] px-3 py-2 text-[11.5px] leading-relaxed text-[#2842C9] dark:border-[#4D6BFE]/40 dark:bg-[#1E253A] dark:text-[#A9BDFF]">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {lang === 'en' ? (
                      <>
                        First-time setup: enter your server&apos;s <strong>Bootstrap Token (ADMIN_BOOTSTRAP_TOKEN)</strong> or CLI-generated admin invite code below to create the first admin account.
                      </>
                    ) : (
                      <>
                        首次初始化：填入服务器配置的 <strong>ADMIN_BOOTSTRAP_TOKEN</strong> 或 CLI 生成的管理员邀请码，即可注册首个管理员账号。
                      </>
                    )}
                  </span>
                </div>
              )}

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <Ticket className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('邀请码', 'Invite Code')}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setError('')
                      setScannerOpen(true)
                    }}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#4D6BFE] hover:underline"
                  >
                    <ScanLine className="h-3 w-3" />
                    <span>{bi('扫码填入', 'Scan QR')}</span>
                  </button>
                </div>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="INV-XXXX-XXXX"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className={`${LOGIN_INPUT_CLS} font-mono font-semibold tracking-wider placeholder:font-sans placeholder:font-normal placeholder:tracking-normal`}
                />
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <User className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  <span>{bi('用户名', 'Username')}</span>
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={bi('3~32 位字母、数字或下划线', '3-32 letters, numbers, or _')}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={LOGIN_INPUT_CLS}
                />
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <Lock className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('密码', 'Password')}</span>
                  </label>
                  <input
                    type="password"
                    value={accountPassword}
                    onChange={(e) => setAccountPassword(e.target.value)}
                    placeholder={bi('至少 8 位', 'At least 8 chars')}
                    autoComplete="new-password"
                    className={`${LOGIN_INPUT_CLS} px-3`}
                  />
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <span>{bi('确认密码', 'Confirm Password')}</span>
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={bi('再次输入', 'Re-enter password')}
                    autoComplete="new-password"
                    className={`${LOGIN_INPUT_CLS} px-3`}
                  />
                </div>
              </div>

              {emailEnabled && (
                <div className="space-y-2">
                  <div>
                    <label className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
                      <span className="inline-flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5 text-[#4D6BFE]" />
                        <span>{bi('绑定邮箱', 'Email')}</span>
                      </span>
                      <span className="text-[11px] font-normal text-slate-400">{bi('选填', 'Optional')}</span>
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={bi('输入邮箱地址', 'Email address')}
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className={LOGIN_INPUT_CLS}
                    />
                  </div>

                  {email.trim().length > 0 && (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={emailCode}
                        onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder={bi('6 位邮箱验证码', '6-digit email code')}
                        autoComplete="one-time-code"
                        className={`${LOGIN_INPUT_CLS} min-w-0 flex-1 font-mono tracking-widest placeholder:font-sans placeholder:tracking-normal`}
                      />
                      <button
                        type="button"
                        disabled={codeSending || codeCooldown > 0}
                        onClick={() => handleSendEmailCode('register')}
                        className="shrink-0 rounded-2xl border border-[#4D6BFE]/40 bg-[#F2F5FF] px-3 py-2.5 text-xs font-semibold text-[#2842C9] transition hover:bg-[#E7EEFF] disabled:opacity-55 dark:border-[#4D6BFE]/40 dark:bg-[#1E253A] dark:text-[#A9BDFF]"
                      >
                        {codeSending
                          ? bi('发送中...', 'Sending...')
                          : codeCooldown > 0
                            ? `${codeCooldown}s`
                            : bi('获取验证码', 'Send Code')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Forgot Password / Email OTP Reset Form */}
          {mode === 'reset' && (
            <>
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                  <ShieldCheck className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  <span>{bi('通过邮箱重置密码', 'Reset Password via Email')}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setMode('login')
                    setError('')
                    setInfoMsg('')
                  }}
                  className="text-xs font-medium text-[#4D6BFE] hover:underline"
                >
                  {bi('返回登录', 'Back to Sign In')}
                </button>
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <Mail className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  <span>{bi('已绑定邮箱', 'Linked Email')}</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={bi('输入账号绑定的邮箱地址', 'Enter your linked email address')}
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={LOGIN_INPUT_CLS}
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={emailCode}
                  onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder={bi('6 位邮箱验证码', '6-digit email code')}
                  autoComplete="one-time-code"
                  className={`${LOGIN_INPUT_CLS} min-w-0 flex-1 font-mono tracking-widest placeholder:font-sans placeholder:tracking-normal`}
                />
                <button
                  type="button"
                  disabled={codeSending || codeCooldown > 0}
                  onClick={() => handleSendEmailCode('reset')}
                  className="shrink-0 rounded-2xl border border-[#4D6BFE]/40 bg-[#F2F5FF] px-3 py-2.5 text-xs font-semibold text-[#2842C9] transition hover:bg-[#E7EEFF] disabled:opacity-55 dark:border-[#4D6BFE]/40 dark:bg-[#1E253A] dark:text-[#A9BDFF]"
                >
                  {codeSending
                    ? bi('发送中...', 'Sending...')
                    : codeCooldown > 0
                      ? `${codeCooldown}s`
                      : bi('获取验证码', 'Send Code')}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <Lock className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('新密码', 'New Password')}</span>
                  </label>
                  <input
                    type="password"
                    value={accountPassword}
                    onChange={(e) => setAccountPassword(e.target.value)}
                    placeholder={bi('至少 8 位', 'At least 8 chars')}
                    autoComplete="new-password"
                    className={`${LOGIN_INPUT_CLS} px-3`}
                  />
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <span>{bi('确认新密码', 'Confirm Password')}</span>
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={bi('再次输入', 'Re-enter password')}
                    autoComplete="new-password"
                    className={`${LOGIN_INPUT_CLS} px-3`}
                  />
                </div>
              </div>
            </>
          )}

          {/* Collapsible 1-line PC setup tip (hidden inside Desktop App since bridge is built in) */}
          {!isDesktopApp && (
          <div className="rounded-2xl border border-slate-200/70 bg-slate-50/80 dark:border-slate-700/70 dark:bg-[#16181F]">
            <button
              type="button"
              onClick={() => setShowSetupGuide((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-[11.5px] font-medium text-slate-600 dark:text-slate-300"
            >
              <span className="inline-flex items-center gap-1.5">
                <Terminal className="h-3.5 w-3.5 text-[#4D6BFE]" />
                <span>{bi('电脑端绑定命令', 'PC Bridge Setup Command')}</span>
              </span>
              {showSetupGuide ? <ChevronUp className="h-3.5 w-3.5 text-slate-400" /> : <ChevronDown className="h-3.5 w-3.5 text-slate-400" />}
            </button>
            {showSetupGuide && (
              <div className="border-t border-slate-200/60 px-3 pt-2 pb-2.5 text-[11px] leading-relaxed text-slate-500 dark:border-slate-700/60 dark:text-slate-400">
                <div className="mb-1.5 flex items-center justify-end">
                  <div className="inline-flex shrink-0 rounded-lg bg-slate-200/80 p-0.5 text-[10px] dark:bg-slate-800">
                    <button
                      type="button"
                      onClick={() => setOsTab('win')}
                      className={`rounded-md px-1.5 py-0.5 font-medium ${
                        osTab === 'win'
                          ? 'bg-white text-slate-900 shadow-2xs dark:bg-slate-700 dark:text-white'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      Win
                    </button>
                    <button
                      type="button"
                      onClick={() => setOsTab('unix')}
                      className={`rounded-md px-1.5 py-0.5 font-medium ${
                        osTab === 'unix'
                          ? 'bg-white text-slate-900 shadow-2xs dark:bg-slate-700 dark:text-white'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      Mac/Linux
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 rounded-xl bg-slate-900 px-2.5 py-2 font-mono text-[10.5px] text-slate-100">
                  <span className="flex-1 select-all break-all">{activeSetupCmd}</span>
                  <button
                    type="button"
                    onClick={handleCopySetupCmd}
                    className="shrink-0 rounded-lg bg-white/10 p-1.5 text-white hover:bg-white/20"
                    title={bi('复制命令', 'Copy command')}
                  >
                    {copiedCmd ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            )}
          </div>
          )}

          {/* Server URL switcher */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvancedServer((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              <Server className="h-3 w-3" />
              <span>{bi('服务器：', 'Server: ')}{effectiveServer.replace(/^https?:\/\//, '')}</span>
              {showAdvancedServer ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {showAdvancedServer && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder={detectDefaultServerUrl()}
                  className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700/90 dark:bg-[#14161D] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-[#4D6BFE] dark:focus:bg-[#191C26]"
                />
                <button
                  type="button"
                  onClick={() => setServerUrl(detectDefaultServerUrl())}
                  className="shrink-0 rounded-xl px-2 py-2 text-[11px] font-medium text-[#4D6BFE] hover:bg-[#4D6BFE]/10"
                >
                  {t('common.default')}
                </button>
              </div>
            )}
          </div>

          {infoMsg && (
            <div className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
              {infoMsg}
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-3 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 transition active:scale-[0.98] disabled:opacity-60"
          >
            <span>
              {loading
                ? bi('验证中...', 'Verifying...')
                : mode === 'login'
                  ? bi('登录', 'Sign In')
                  : mode === 'register'
                    ? bi('注册', 'Sign Up')
                    : bi('重置密码', 'Reset Password')}
            </span>
            {!loading && <ArrowRight className="h-4 w-4" />}
          </button>
        </form>
      </div>

      <QrScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleQrDetected}
      />
    </div>
  )
}
