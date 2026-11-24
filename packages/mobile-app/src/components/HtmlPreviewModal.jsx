import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Download, Share2, ShieldCheck, X } from 'lucide-react'
import { useI18n } from '../lib/i18n.jsx'
import {
  canNativeShareFiles,
  formatFileSize,
  shareDeliverableFile,
  triggerDeliverableDownload,
} from '../lib/e2eeFiles.js'

/**
 * Fullscreen sandboxed HTML preview modal for AI-generated interactive HTML reports/dashboards.
 * Strictly omits `allow-same-origin` so previewed HTML runs in an opaque null origin and can
 * never read All in One's localStorage, cookies, E2EE keys, or parent DOM.
 */
export function HtmlPreviewModal({ state, onClose }) {
  const { bi } = useI18n()
  const open = Boolean(state && typeof state.html === 'string')
  const showShare = open && Boolean(state.entry) && canNativeShareFiles()

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const filename = state.filename || 'preview.html'
  const sizeText = formatFileSize(state.size)

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={filename}
      className="fixed inset-0 z-[95] flex flex-col bg-slate-950/92 backdrop-blur-xs"
    >
      {/* Top toolbar */}
      <div className="safe-top flex shrink-0 items-center justify-between gap-2 border-b border-slate-200/80 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-[#16181F]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>{bi('安全沙盒', 'Sandbox')}</span>
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-white">
              {filename}
            </div>
            {sizeText && (
              <div className="text-[11px] text-slate-400 dark:text-slate-500">
                {sizeText} · {bi('已隔离本地密钥与主站权限', 'Isolated from keys & app storage')}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {showShare && (
            <button
              type="button"
              onClick={() => {
                void shareDeliverableFile(state.entry).catch(() => {})
              }}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-[#232630] dark:text-slate-200 dark:hover:bg-[#2B2F3C]"
              title={bi('分享或用其他应用打开', 'Share or open with...')}
            >
              <Share2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{bi('分享', 'Share')}</span>
            </button>
          )}
          {state.entry && (
            <button
              type="button"
              onClick={() => {
                void triggerDeliverableDownload(state.entry).catch(() => {})
              }}
              className="inline-flex items-center gap-1 rounded-xl bg-[#4D6BFE] px-3 py-1.5 text-xs font-semibold text-white shadow-2xs transition hover:bg-[#3B59F0] active:scale-95"
            >
              <Download className="h-3.5 w-3.5" />
              <span>{bi('下载', 'Download')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onClose?.()}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 active:scale-95 dark:text-slate-400 dark:hover:bg-[#252936] dark:hover:text-white"
            aria-label={bi('关闭预览', 'Close preview')}
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>

      {/* Sandboxed HTML viewport */}
      <div className="min-h-0 flex-1 bg-white">
        <iframe
          title={filename}
          srcDoc={state.html}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-white"
        />
      </div>
    </div>,
    document.body,
  )
}
