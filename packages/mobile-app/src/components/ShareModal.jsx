import React, { useState } from 'react'
import {
  Check,
  Copy,
  Download,
  Globe,
  Loader2,
  Share2,
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

const DEFAULT_RELEASES_URL = 'https://github.com/RainbowLion0320/AllinOne/releases/latest'
const RELEASES_URL = String(import.meta.env.VITE_RELEASES_URL || '').trim() || DEFAULT_RELEASES_URL
const CONFIGURED_APK_URL = String(import.meta.env.VITE_APK_URL || '').trim()

function resolveApkUrl(base) {
  if (!CONFIGURED_APK_URL) return ''
  if (/^https?:\/\//i.test(CONFIGURED_APK_URL)) return CONFIGURED_APK_URL
  return `${base}/${CONFIGURED_APK_URL.replace(/^\/+/, '')}`
}

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
  const apkUrl = resolveApkUrl(base)

  const shareBundleText = [
    '分享给你一个工具 All in One（跨设备远程操控本机 Codex / Claude Code / Antigravity / DeepSeek）',
    ...(generatedInvite
      ? [
          '',
          `【专属一次性邀请码（仅限 1 人注册）】：${generatedInvite.code}`,
          `注册直达链接：${webUrl}`,
        ]
      : []),
    '',
    '【第 1 步：下载客户端或打开网页注册】',
    `• 桌面端 & Android 安装包（GitHub Releases）：${RELEASES_URL}`,
    `• 手机网页入口（推荐添加到主屏幕）：${webUrl}`,
    ...(apkUrl && apkUrl !== RELEASES_URL ? [`• Android 直链：${apkUrl}`] : []),
    '',
    '【第 2 步：在你的电脑登录同一账号（或运行 1 行命令）】',
    `• macOS / Linux: ${unixCmd}`,
    `• Windows (PowerShell): ${winCmd}`,
    '登录成功后，手机端和桌面端即可自动发现并连接你的全部电脑。',
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
        <div className="mb-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Share2 className="h-4 w-4" />
            </div>
            <h2 className="text-[15.5px] font-bold text-slate-900 dark:text-white">分享</h2>
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
          <div className="mb-3 rounded-2xl border border-[#4D6BFE]/30 bg-[#F2F5FF] p-3 dark:border-[#4D6BFE]/40 dark:bg-[#1E253A]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-[#2842C9] dark:text-white">
                <Ticket className="h-3.5 w-3.5 text-[#4D6BFE]" />
                <span>邀请码</span>
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
                  管理 →
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
                    {copiedKey === 'inv' ? '已复制' : '复制'}
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
                <span>生成一次性邀请码</span>
              </button>
            )}
            {genError && <div className="mt-1.5 text-[11px] text-rose-500">{genError}</div>}
          </div>
        )}

        {/* Step 1: PC 1-line command */}
        <div className="mb-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#14171E]">
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <Terminal className="h-3.5 w-3.5 text-[#4D6BFE]" />
              电脑端绑定命令
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
        </div>

        {/* Step 2: Installers (GitHub Releases) & Web links */}
        <div className="mb-3.5 space-y-2 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#14171E]">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
            <Smartphone className="h-3.5 w-3.5 text-[#4D6BFE]" />
            安装包与入口
          </div>

          <div className="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 dark:bg-[#1E222D]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-100">
                <Download className="h-3.5 w-3.5 text-emerald-500" />
                <span>桌面端 / Android 安装包 (GitHub)</span>
              </div>
              <div className="truncate text-[10.5px] text-slate-400">{RELEASES_URL}</div>
            </div>
            <button
              type="button"
              onClick={() => copyText('releases', RELEASES_URL)}
              className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {copiedKey === 'releases' ? '已复制' : '复制'}
            </button>
          </div>

          {apkUrl && apkUrl !== RELEASES_URL && (
            <div className="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 dark:bg-[#1E222D]">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-100">
                  <Download className="h-3.5 w-3.5 text-emerald-500" />
                  <span>Android 安装包</span>
                </div>
                <div className="truncate text-[10.5px] text-slate-400">{apkUrl}</div>
              </div>
              <button
                type="button"
                onClick={() => copyText('apk', apkUrl)}
                className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {copiedKey === 'apk' ? '已复制' : '复制'}
              </button>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 dark:bg-[#1E222D]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-100">
                <Globe className="h-3.5 w-3.5 text-[#4D6BFE]" />
                <span>{generatedInvite ? '邀请注册链接' : '网页入口'}</span>
              </div>
              <div className="truncate text-[10.5px] text-slate-400">{webUrl}</div>
            </div>
            <button
              type="button"
              onClick={() => copyText('web', webUrl)}
              className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {copiedKey === 'web' ? '已复制' : '复制'}
            </button>
          </div>
        </div>

        {/* One-tap copy complete share guide */}
        <button
          type="button"
          onClick={() => copyText('all', shareBundleText)}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-2.5 text-sm font-semibold text-white shadow-md shadow-[#4D6BFE]/25 transition active:scale-[0.98]"
        >
          {copiedKey === 'all' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span>
            {copiedKey === 'all'
              ? '已复制'
              : '复制分享文案'}
          </span>
        </button>
      </div>
    </div>
  )
}
