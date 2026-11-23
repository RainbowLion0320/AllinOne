import React, { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Globe,
  KeyRound,
  Lock,
  Mail,
  QrCode,
  ScanLine,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Ticket,
  User,
  UserPlus,
} from 'lucide-react'
import {
  DEFAULT_PROD_SERVER,
  detectDefaultServerUrl,
  fetchBootstrapStatus,
  loginAccount,
  loginToRelay,
  normalizeBaseUrl,
  pairWithRelay,
  parsePairInput,
  registerAccount,
  resetAccountPassword,
  sendEmailVerificationCode,
} from '../lib/wsClient.js'
import { QrScannerModal } from './QrScannerModal.jsx'
import { useI18n } from '../lib/i18n.jsx'

function formatPairCodeDisplay(val) {
  const trimmed = val.trim()
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('pt_')) return val
  const clean = val.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  if (clean.length > 4) return `${clean.slice(0, 4)}-${clean.slice(4)}`
  return clean
}

export function LoginScreen({
  onSuccess,
  initialError = '',
  isAddingDevice = false,
  initialServerUrl = '',
  initialInviteCode = '',
  autoOpenScanner = false,
  onCancel = null,
}) {
  const { lang, setLang, bi, t } = useI18n()
  // 'login' | 'register' | 'reset' | 'pair' | 'password'
  const [mode, setMode] = useState(() =>
    autoOpenScanner ? 'pair' : initialInviteCode ? 'register' : 'login',
  )
  const [serverUrl, setServerUrl] = useState(() => initialServerUrl || detectDefaultServerUrl())
  const [showAdvancedServer, setShowAdvancedServer] = useState(() => {
    const init = String(initialServerUrl || detectDefaultServerUrl() || '')
    return !init || /your-relay\.example\.com/i.test(init)
  })
  const [showLegacyOptions, setShowLegacyOptions] = useState(() => Boolean(autoOpenScanner))
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
  const [inviteCode, setInviteCode] = useState(initialInviteCode || '')
  const [email, setEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [codeSending, setCodeSending] = useState(false)
  const [codeCooldown, setCodeCooldown] = useState(0)

  // Legacy fields
  const [pairInput, setPairInput] = useState('')
  const [legacyPassword, setLegacyPassword] = useState('')
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

  const executePair = useCallback(async (rawInput, fromScanner = false) => {
    const parsed = parsePairInput(rawInput)
    if (!parsed.pairCode && !parsed.pairToken) {
      setError(
        fromScanner
          ? bi('识别到的二维码不是 All in One 配对码，请扫描电脑端弹出的配对二维码', 'Invalid QR code. Please scan the pairing QR displayed on your PC.')
          : bi('请输入电脑端显示的 8 位配对码，或点击「扫一扫」', 'Enter the 8-character pairing code from your PC, or tap Scan QR.'),
      )
      return
    }
    if (parsed.serverUrl) {
      setServerUrl(parsed.serverUrl)
    }
    setError('')
    setLoading(true)
    try {
      const targetServer = parsed.serverUrl || serverUrl
      const result = await pairWithRelay(targetServer, {
        pairCode: parsed.pairCode,
        pairToken: parsed.pairToken,
      })
      onSuccess({
        baseUrl: result.baseUrl,
        token: result.token,
        roomId: result.roomId,
        label: result.label,
        bridges: result.bridges,
        authMode: 'pair',
      })
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setLoading(false)
    }
  }, [onSuccess, serverUrl])

  const handleQrDetected = useCallback((rawText) => {
    setScannerOpen(false)
    // Also support scanning an invite link QR (`?invite=INV-...`)!
    try {
      if (/^https?:\/\//i.test(rawText.trim())) {
        const u = new URL(rawText.trim())
        const inv = u.searchParams.get('invite')
        if (inv) {
          const basePath = u.pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '')
          setServerUrl(`${u.origin}${basePath}`)
          setInviteCode(inv.trim())
          setMode('register')
          setShowLegacyOptions(false)
          setError('')
          return
        }
      }
    } catch {}
    setMode('pair')
    setShowLegacyOptions(true)
    setPairInput(formatPairCodeDisplay(rawText))
    void executePair(rawText, true)
  }, [executePair])

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

    if (mode === 'pair') {
      await executePair(pairInput, false)
      return
    }

    if (!legacyPassword.trim()) {
      setError(bi('请输入管理员访问密钥', 'Please enter the admin access token'))
      return
    }
    setLoading(true)
    try {
      const result = await loginToRelay(serverUrl, legacyPassword.trim())
      onSuccess({
        baseUrl: result.baseUrl,
        token: result.token,
        roomId: result.roomId || 'owner',
        role: 'admin',
        bridges: result.bridges,
        authMode: 'password',
      })
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setLoading(false)
    }
  }

  const isAccountTab = mode === 'login' || mode === 'register'
  const isDesktopApp = typeof window !== 'undefined' && Boolean(window.allinoneDesktop)

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center overflow-y-auto bg-gradient-to-b from-[#F5F8FF] to-white px-5 py-8 dark:from-[#16171A] dark:to-[#111216]">
      {isDesktopApp && <div className="app-drag fixed inset-x-0 top-0 z-10 h-9" />}
      {/* Floating bilingual switcher on login screen */}
      <div className="app-no-drag pt-safe fixed top-3 right-4 z-20">
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
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                <input
                  type="password"
                  value={accountPassword}
                  onChange={(e) => setAccountPassword(e.target.value)}
                  placeholder={bi('输入账号密码', 'Enter password')}
                  autoComplete="current-password"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
                />
              </div>
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
                        First-time setup: enter your server&apos;s <strong>Admin Token (CLIENT_ACCESS_TOKEN)</strong> as the invite code below to create the first admin account.
                      </>
                    ) : (
                      <>
                        首次初始化：直接把服务器的 <strong>管理员密钥 (CLIENT_ACCESS_TOKEN)</strong> 填入下方邀请码框，即可注册首个管理员账号。
                      </>
                    )}
                  </span>
                </div>
              )}

              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <Ticket className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  <span>{bi('邀请码', 'Invite Code')}</span>
                </label>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="INV-XXXX-XXXX"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 font-mono text-sm font-semibold tracking-wider text-slate-900 outline-none transition placeholder:font-sans placeholder:font-normal placeholder:tracking-normal focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                      placeholder={bi('用于邮箱登录与找回密码（可留空）', 'For email login & password reset (optional)')}
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                        className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 font-mono text-sm tracking-widest text-slate-900 outline-none transition placeholder:font-sans placeholder:tracking-normal focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                  className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 font-mono text-sm tracking-widest text-slate-900 outline-none transition placeholder:font-sans placeholder:tracking-normal focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
                  />
                </div>
              </div>
            </>
          )}

          {/* Legacy Pair Mode */}
          {mode === 'pair' && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{bi('旧版配对码 / 扫码连接', 'Legacy Pair Code / QR')}</span>
                <button
                  type="button"
                  onClick={() => {
                    setMode('login')
                    setShowLegacyOptions(false)
                    setError('')
                  }}
                  className="text-xs font-medium text-[#4D6BFE] hover:underline"
                >
                  {bi('返回账号登录', 'Account Sign In')}
                </button>
              </div>

              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setError('')
                  setScannerOpen(true)
                }}
                className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[#4D6BFE]/35 bg-[#F2F5FF] px-3.5 py-3 text-left transition hover:border-[#4D6BFE] hover:bg-[#E9EEFF] active:scale-[0.99] disabled:opacity-60 dark:border-[#4D6BFE]/40 dark:bg-[#1E253A]"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#4D6BFE] text-white">
                    <ScanLine className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-[#2842C9] dark:text-white">{bi('扫一扫二维码', 'Scan QR Code')}</div>
                    <div className="truncate text-[11px] text-slate-500 dark:text-slate-300">{bi('支持旧版配对码或邀请注册二维码', 'Supports legacy pairing or invite sign-up QR')}</div>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-[#4D6BFE]" />
              </button>

              <input
                type="text"
                value={pairInput}
                onChange={(e) => setPairInput(formatPairCodeDisplay(e.target.value))}
                placeholder={bi('输入 8 位配对码，例如：AB34-CD56', 'Enter 8-char code, e.g. AB34-CD56')}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-center font-mono text-base font-bold tracking-[0.14em] text-slate-900 outline-none placeholder:font-sans placeholder:text-sm placeholder:font-normal placeholder:tracking-normal focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
              />
            </>
          )}

          {/* Legacy Owner Password Mode */}
          {mode === 'password' && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{bi('旧版管理员密钥登录', 'Legacy Admin Token Login')}</span>
                <button
                  type="button"
                  onClick={() => {
                    setMode('login')
                    setShowLegacyOptions(false)
                    setError('')
                  }}
                  className="text-xs font-medium text-[#4D6BFE] hover:underline"
                >
                  {bi('返回账号登录', 'Account Sign In')}
                </button>
              </div>
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <KeyRound className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  <span>{bi('管理员密钥 (CLIENT_ACCESS_TOKEN)', 'Admin Token (CLIENT_ACCESS_TOKEN)')}</span>
                </label>
                <input
                  type="password"
                  value={legacyPassword}
                  onChange={(e) => setLegacyPassword(e.target.value)}
                  placeholder={bi('输入服务器配置的访问口令', 'Enter server access token')}
                  autoComplete="current-password"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
                />
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
                  className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
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
                    : mode === 'reset'
                      ? bi('重置密码', 'Reset Password')
                      : mode === 'pair'
                        ? bi('配对', 'Pair')
                        : bi('登录', 'Sign In')}
            </span>
            {!loading && <ArrowRight className="h-4 w-4" />}
          </button>

          {/* Secondary / legacy login options */}
          {isAccountTab && (
            <div className="border-t border-slate-100 pt-2.5 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setShowLegacyOptions((v) => !v)}
                className="flex w-full items-center justify-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <span>{bi('扫码 / 密钥登录', 'QR / Admin Token')}</span>
                {showLegacyOptions ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              {showLegacyOptions && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('pair')
                      setError('')
                    }}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 py-2 text-[11.5px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-[#16181F] dark:text-slate-300"
                  >
                    <QrCode className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('扫码 / 配对码', 'QR / Pair Code')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('password')
                      setError('')
                    }}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 py-2 text-[11.5px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-[#16181F] dark:text-slate-300"
                  >
                    <KeyRound className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    <span>{bi('管理员密钥', 'Admin Token')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
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
