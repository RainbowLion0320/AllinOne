import React, { useEffect, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
  QrCode,
  Server,
  ShieldCheck,
  Terminal,
} from 'lucide-react'
import {
  DEFAULT_PROD_SERVER,
  detectDefaultServerUrl,
  loginToRelay,
  normalizeBaseUrl,
  pairWithRelay,
  parsePairInput,
} from '../lib/wsClient.js'

function formatPairCodeDisplay(val) {
  // Keep pasted URLs or pt_ tokens untouched
  const trimmed = val.trim()
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('pt_')) return val
  const clean = val.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  if (clean.length > 4) return `${clean.slice(0, 4)}-${clean.slice(4)}`
  return clean
}

export function LoginScreen({ onSuccess, initialError = '' }) {
  const [mode, setMode] = useState('pair') // 'pair' | 'password'
  const [serverUrl, setServerUrl] = useState(() => detectDefaultServerUrl())
  const [showAdvancedServer, setShowAdvancedServer] = useState(false)
  const [showSetupGuide, setShowSetupGuide] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)

  const [pairInput, setPairInput] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialError)

  useEffect(() => {
    if (initialError) setError(initialError)
  }, [initialError])

  const effectiveServer = normalizeBaseUrl(serverUrl)
  const winSetupCmd = `irm ${effectiveServer}/setup.ps1 | iex`

  const handleCopyWinCmd = async () => {
    try {
      await navigator.clipboard.writeText(winSetupCmd)
    } catch {}
    setCopiedCmd(true)
    setTimeout(() => setCopiedCmd(false), 1800)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (mode === 'pair') {
      const parsed = parsePairInput(pairInput)
      if (!parsed.pairCode && !parsed.pairToken) {
        setError('请输入电脑端显示的 8 位配对码，或粘贴扫码链接')
        return
      }
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
        })
      } catch (err) {
        setError(String(err?.message || err))
      } finally {
        setLoading(false)
      }
      return
    }

    if (!password.trim()) {
      setError('请输入管理员访问密钥')
      return
    }
    setLoading(true)
    try {
      const result = await loginToRelay(serverUrl, password.trim())
      onSuccess({
        baseUrl: result.baseUrl,
        token: result.token,
        roomId: result.roomId || 'owner',
        bridges: result.bridges,
      })
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center overflow-y-auto bg-gradient-to-b from-[#F5F8FF] to-white px-5 py-8 dark:from-[#16171A] dark:to-[#111216]">
      <div className="w-full max-w-sm">
        {/* Brand mark */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3.5 h-18 w-18 overflow-hidden rounded-[22px] bg-[#03080E] shadow-xl shadow-blue-950/35 ring-1 ring-white/10">
            <img src="./icon-192.png" alt="All in One" className="h-full w-full object-cover" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            All in One
          </h1>
          <p className="mt-1 text-[12.5px] text-slate-500 dark:text-slate-400">
            随时随地用手机掌控本机 Codex / Claude / Antigravity / DeepSeek
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xl shadow-slate-200/40 dark:border-slate-800 dark:bg-[#1E2028] dark:shadow-none"
        >
          {/* Mode Switcher */}
          <div className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-100 p-1 dark:bg-[#14161C]">
            <button
              type="button"
              onClick={() => {
                setMode('pair')
                setError('')
              }}
              className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition ${
                mode === 'pair'
                  ? 'bg-white text-[#4D6BFE] shadow-xs dark:bg-[#262A36] dark:text-white'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
              }`}
            >
              <QrCode className="h-3.5 w-3.5" />
              <span>配对码连接</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('password')
                setError('')
              }}
              className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition ${
                mode === 'password'
                  ? 'bg-white text-[#4D6BFE] shadow-xs dark:bg-[#262A36] dark:text-white'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
              }`}
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span>管理员密码</span>
            </button>
          </div>

          {mode === 'pair' ? (
            <>
              <div>
                <label className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300">
                  <span className="inline-flex items-center gap-1.5">
                    <QrCode className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    电脑端 8 位配对码
                  </span>
                  <span className="text-[10.5px] text-slate-400">或粘贴配对链接</span>
                </label>
                <input
                  type="text"
                  value={pairInput}
                  onChange={(e) => setPairInput(formatPairCodeDisplay(e.target.value))}
                  placeholder="例如：AB34-CD56"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-center font-mono text-base font-bold tracking-[0.14em] text-slate-900 outline-none transition placeholder:font-sans placeholder:text-sm placeholder:font-normal placeholder:tracking-normal focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
                />
              </div>

              {/* Collapsible 1-line PC setup tip */}
              <div className="rounded-2xl border border-slate-200/70 bg-slate-50/80 dark:border-slate-700/70 dark:bg-[#16181F]">
                <button
                  type="button"
                  onClick={() => setShowSetupGuide((v) => !v)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-[11.5px] font-medium text-slate-600 dark:text-slate-300"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Terminal className="h-3.5 w-3.5 text-[#4D6BFE]" />
                    电脑端还没启动？1 行命令获取配对码
                  </span>
                  {showSetupGuide ? <ChevronUp className="h-3.5 w-3.5 text-slate-400" /> : <ChevronDown className="h-3.5 w-3.5 text-slate-400" />}
                </button>
                {showSetupGuide && (
                  <div className="border-t border-slate-200/60 px-3 pt-2 pb-2.5 text-[11px] leading-relaxed text-slate-500 dark:border-slate-700/60 dark:text-slate-400">
                    <p className="mb-1.5">在电脑 PowerShell 中粘贴运行，3 秒自动弹出二维码与 8 位配对码：</p>
                    <div className="flex items-center gap-1.5 rounded-xl bg-slate-900 px-2.5 py-2 font-mono text-[10.5px] text-slate-100">
                      <span className="flex-1 select-all break-all">{winSetupCmd}</span>
                      <button
                        type="button"
                        onClick={handleCopyWinCmd}
                        className="shrink-0 rounded-lg bg-white/10 p-1.5 text-white hover:bg-white/20"
                        title="复制命令"
                      >
                        {copiedCmd ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Collapsible Server URL for advanced / self-hosted users */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvancedServer((v) => !v)}
                  className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <Server className="h-3 w-3" />
                  <span>中转服务器：{effectiveServer.replace(/^https?:\/\//, '')}</span>
                  {showAdvancedServer ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
                {showAdvancedServer && (
                  <input
                    type="url"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    placeholder={DEFAULT_PROD_SERVER}
                    className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-900 outline-none focus:border-[#4D6BFE] dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
                  />
                )}
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <Server className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  自建服务器地址
                </label>
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://ai.yourdomain.com"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
                />
              </div>

              <div>
                <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  <KeyRound className="h-3.5 w-3.5 text-[#4D6BFE]" />
                  访问密钥 (CLIENT_ACCESS_TOKEN)
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入服务器配置的访问口令"
                  autoComplete="current-password"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#4D6BFE] focus:bg-white dark:border-slate-700 dark:bg-[#16171A] dark:text-white"
                />
              </div>
            </>
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
            <span>{loading ? '正在验证连接...' : mode === 'pair' ? '立即配对连接' : '连接我的电脑'}</span>
            {!loading && <ArrowRight className="h-4 w-4" />}
          </button>

          <div className="flex items-center justify-between pt-1 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              独立房间隔离 · 加密长连接
            </span>
            <button
              type="button"
              onClick={() => {
                setServerUrl(normalizeBaseUrl(DEFAULT_PROD_SERVER))
              }}
              className="text-[#4D6BFE] hover:underline"
            >
              恢复默认
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
