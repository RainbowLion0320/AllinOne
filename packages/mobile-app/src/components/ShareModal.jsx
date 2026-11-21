import React, { useState } from 'react'
import { Check, Copy, Download, Globe, Share2, ShieldCheck, Smartphone, Terminal, X } from 'lucide-react'
import { DEFAULT_PROD_SERVER, normalizeBaseUrl } from '../lib/wsClient.js'

const APK_FILENAME = 'All-in-One-v0.1.8.apk'

export function ShareModal({ open, onClose, serverUrl }) {
  const [osTab, setOsTab] = useState('win') // 'win' | 'unix'
  const [copiedKey, setCopiedKey] = useState('')

  if (!open) return null

  const base = normalizeBaseUrl(serverUrl || DEFAULT_PROD_SERVER)
  const winCmd = `irm ${base}/setup.ps1 | iex`
  const unixCmd = `curl -fsSL ${base}/setup.sh | bash`
  const webUrl = `${base}/`
  const apkUrl = `${base}/${APK_FILENAME}`

  const shareBundleText = [
    '分享给你一个超好用的工具 All in One（手机远程操控自己电脑上的 Codex / Claude / Antigravity / DeepSeek）',
    '',
    '【第 1 步：在你电脑上运行这 1 行命令】',
    `Windows (PowerShell): ${winCmd}`,
    `macOS / Linux: ${unixCmd}`,
    '运行后 3 秒会自动弹出二维码和 8 位配对码（并在桌面生成快捷方式，以后双击即可启动）。',
    '',
    '【第 2 步：手机连接】',
    '• 方式 A（最快）：直接用手机扫码即可秒连！',
    `• 方式 B（Android App）：下载安装 ${apkUrl} ，打开输入 8 位配对码即可（App 会自动热更新，无需重装）。`,
    `• 网页入口：${webUrl}`,
    '',
    '注：每位用户都有独立加密房间，你的电脑只连你自己的手机，彼此完全隔离互不可见。',
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

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-4">
      <div className="pb-safe max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl dark:bg-[#1C1F27]">
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#4D6BFE]/12 text-[#4D6BFE]">
              <Share2 className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-[15px] font-bold text-slate-900 dark:text-white">分享给朋友</h2>
              <p className="text-[11px] text-slate-400">朋友 1 行命令启动，扫码即连自己电脑</p>
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

        {/* Privacy guarantee pill */}
        <div className="mb-4 flex items-start gap-2 rounded-2xl border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-[11.5px] leading-relaxed text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/35 dark:text-emerald-300">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          <span>
            <strong>独立房间隔离：</strong>朋友首次运行会自动生成专属房间密钥，只能访问他们自己的电脑，完全看不到你的任何会话、截图和文件。
          </span>
        </div>

        {/* Step 1: PC 1-line command */}
        <div className="mb-3.5 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#14171E]">
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <Terminal className="h-3.5 w-3.5 text-[#4D6BFE]" />
              第 1 步 · 朋友电脑 1 行命令
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
            无需 Git / npm install，自动检测 Codex / Claude / Antigravity / DSH，并在桌面创建一键启动图标。
          </p>
        </div>

        {/* Step 2: Mobile links */}
        <div className="mb-4 space-y-2 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-[#14171E]">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
            <Smartphone className="h-3.5 w-3.5 text-[#4D6BFE]" />
            第 2 步 · 手机扫码或安装 App
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
                <span>免安装网页 / iOS PWA 入口</span>
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
          <span>{copiedKey === 'all' ? '已复制完整分享说明，直接粘贴发给朋友！' : '一键复制完整分享文案（微信直发）'}</span>
        </button>
      </div>
    </div>
  )
}
