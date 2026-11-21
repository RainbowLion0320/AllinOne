import React, { useState } from 'react'
import {
  Check,
  Copy,
  Download,
  Globe,
  Loader2,
  Share2,
  ShieldCheck,
  Smartphone,
  Terminal,
  Ticket,
  X,
} from 'lucide-react'
import {
  DEFAULT_PROD_SERVER,
  adminCreateInvites,
  normalizeBaseUrl,
} from '../lib/wsClient.js'

const APK_FILENAME = 'All-in-One-v0.1.8.apk'

export function ShareModal({
  open,
  onClose,
  serverUrl,
  token = '',
  isAdmin = false,
  onOpenInviteManager = null,
}) {
  const [osTab, setOsTab] = useState('unix') // 'win' | 'unix'
  const [copiedKey, setCopiedKey] = useState('')
  const [generatedInvite, setGeneratedInvite] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState('')

  if (!open) return null

  const base = normalizeBaseUrl(serverUrl || DEFAULT_PROD_SERVER)
  const winCmd = `irm ${base}/setup.ps1 | iex`
  const unixCmd = `curl -fsSL ${base}/setup.sh | bash`
  const webUrl = generatedInvite
    ? `${base}/?invite=${encodeURIComponent(generatedInvite.code)}`
    : `${base}/`
  const apkUrl = `${base}/${APK_FILENAME}`

  const shareBundleText = [
    '分享给你一个超好用的工具 All in One（手机远程操控自己电脑上的 Codex / Claude / Antigravity / DeepSeek）',
    ...(generatedInvite
      ? [
          '',
          `【专属一次性邀请码（仅限 1 人注册）】：${generatedInvite.code}`,
          `注册直达链接：${webUrl}`,
        ]
      : []),
    '',
    '【第 1 步：手机注册并登录账号】',
    `• 网页入口：${webUrl}`,
    `• Android App：下载安装 ${apkUrl}（自动热更新，无需重装）`,
    '',
    '【第 2 步：在你的电脑运行 1 行命令并登录同一账号】',
    `• macOS / Linux: ${unixCmd}`,
    `• Windows (PowerShell): ${winCmd}`,
    '登录成功后，手机端自动发现并连接你的电脑（多台电脑只需各登一次账号即可自由切换）。',
    '',
    '注：每个账号数据与电脑完全独立隔离，互不可见。',
  ].join('\n')

  const copyText = async (key, text) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch {}
      document.body.removeChild(ta)
    }
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((cur) => (cur === key ? '' : cur)), 1800)
  }

  const handleGenerateOneInvite = async () => {
    if (!token || generating) return
    setGenerating(true)
    setGenError('')
    try {
      const created = await adminCreateInvites(base, token, { count: 1, note: '分享给朋友' })
      if (created[0]) {
        setGeneratedInvite(created[0])
      }
    } catch (err) {
      setGenError(String(err?.message || err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="pb-safe max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl dark:bg-[#1C1F27]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Share2 className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-[15px] font-bold text-slate-900 dark:text-white">分享给朋友</h2>
              <p className="text-[11px] text-slate-400">发送一次性邀请码，注册登录即可直连电脑</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭分享窗口"
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Admin one-tap single-use invite generator */}
        {isAdmin && token && (
          <div className="mb-3.5 rounded-2xl border border-[#4D6BFE]/30 bg-[#F2F5FF] p-3 dark:border-[#4D6BFE]/40 dark:bg-[#1E253A]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-[#2842C9] dark:text-white">
                <Ticket className="h-3.5 w-3.5 text-[#4D6BFE]" />
                <span>一次性注册邀请码</span>
              </div>
              {onOpenInviteManager && (
                <button
                  type="button"
                  onClick={() => {
                    onClose()
                    onOpenInviteManager()
                  }}
                  className="text-[11px] font-semibold text-[#4D6BFE] hover:underline"
                >
                  管理全部邀请码 →
                </button>
              )}
            </div>

            {generatedInvite ? (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 dark:bg-[#141722]">
                <span className="font-mono text-sm font-bold tracking-wider text-slate-900 dark:text-white">
                  {generatedInvite.code}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => copyText('inv', generatedInvite.code)}
                    className="rounded-lg bg-[#4D6BFE]/12 px-2 py-1 text-[11px] font-semibold text-[#4D6BFE]"
                  >
                    {copiedKey === 'inv' ? '已复制' : '复制码'}
                  </button>
                  <button
                    type="button"
                    disabled={generating}
                    onClick={handleGenerateOneInvite}
                    className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    换一个
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={generating}
                onClick={handleGenerateOneInvite}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#4D6BFE] py-2 text-xs font-semibold text-white active:scale-[0.98] disabled:opacity-60"
              >
                {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ticket className="h-3.5 w-3.5" />}
                <span>生成 1 个一次性邀请码（自动附带到下方文案）</span>
              </button>
            )}
            {genError && <div className="mt-1.5 text-[11px] text-rose-500">{genError}</div>}
          </div>
        )}

        {/* Privacy guarantee pill */}
        <div className="mb-3.5 flex items-start gap-2 rounded-2xl border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-[11.5px] leading-relaxed text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/35 dark:text-emerald-300">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          <span>
            <strong>账号空间严格隔离：</strong>每位用户注册后拥有独立空间与单机专属密钥，只能控制自己账号下绑定的电脑，完全互不可见。
          </span>
        </div>

        {/* Step 1: PC 1-line command */}
        <div className="mb-3.5 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#14171E]">
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <Terminal className="h-3.5 w-3.5 text-[#4D6BFE]" />
              电脑端 1 行安装绑定命令
            </span>
            <div className="inline-flex rounded-lg bg-slate-200/80 p-0.5 text-[10.5px] dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setOsTab('win')}
                className={`rounded-md px-2 py-0.5 font-medium ${
                  osTab === 'win'
                    ? 'bg-white text-slate-900 shadow-2xs dark:bg-slate-700 dark:text-white'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                Windows
              </button>
              <button
                type="button"
                onClick={() => setOsTab('unix')}
                className={`rounded-md px-2 py-0.5 font-medium ${
                  osTab === 'unix'
                    ? 'bg-white text-slate-900 shadow-2xs dark:bg-slate-700 dark:text-white'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                Mac / Linux
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5 font-mono text-[11px] text-slate-100">
            <span className="flex-1 select-all break-all">{osTab === 'win' ? winCmd : unixCmd}</span>
            <button
              type="button"
              onClick={() => copyText('cmd', osTab === 'win' ? winCmd : unixCmd)}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#4D6BFE] px-2.5 py-1.5 font-sans text-[11px] font-semibold text-white active:scale-95"
            >
              {copiedKey === 'cmd' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copiedKey === 'cmd' ? '已复制' : '复制'}</span>
            </button>
          </div>
          <p className="mt-1.5 text-[10.5px] text-slate-400">
            运行后输入账号密码登录一次即可绑定（绝不保存明文密码），手机端自动出现该电脑。
          </p>
        </div>

        {/* Step 2: Mobile links */}
        <div className="mb-4 space-y-2 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#14171E]">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
            <Smartphone className="h-3.5 w-3.5 text-[#4D6BFE]" />
            手机端注册与下载入口
          </div>

          <div className="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 dark:bg-[#1E222D]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-100">
                <Download className="h-3.5 w-3.5 text-emerald-500" />
                <span>Android 通用安装包 (自动热更新)</span>
              </div>
              <div className="truncate text-[10.5px] text-slate-400">{apkUrl}</div>
            </div>
            <button
              type="button"
              onClick={() => copyText('apk', apkUrl)}
              className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {copiedKey === 'apk' ? '已复制' : '复制链接'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 dark:bg-[#1E222D]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-100">
                <Globe className="h-3.5 w-3.5 text-[#4D6BFE]" />
                <span>{generatedInvite ? '免填邀请码注册直达链接' : '免安装网页 / iOS PWA 入口'}</span>
              </div>
              <div className="truncate text-[10.5px] text-slate-400">{webUrl}</div>
            </div>
            <button
              type="button"
              onClick={() => copyText('web', webUrl)}
              className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {copiedKey === 'web' ? '已复制' : '复制链接'}
            </button>
          </div>
        </div>

        {/* One-tap copy complete WeChat share guide */}
        <button
          type="button"
          onClick={() => copyText('all', shareBundleText)}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-3 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 transition active:scale-[0.98]"
        >
          {copiedKey === 'all' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span>
            {copiedKey === 'all'
              ? '已复制完整邀请文案，直接粘贴发给朋友！'
              : generatedInvite
                ? '一键复制含邀请码的分享文案'
                : '一键复制完整分享文案（微信直发）'}
          </span>
        </button>
      </div>
    </div>
  )
}
