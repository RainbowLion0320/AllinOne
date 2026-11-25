import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Download, Share2, ShieldCheck, X } from 'lucide-react'
import { useI18n } from '../lib/i18n.jsx'
import {
  canNativeShareFiles,
  shareDeliverableFile,
  triggerDeliverableDownload,
} from '../lib/e2eeFiles.js'
import { formatBytesCompact } from '../lib/sessionCache.js'

/**
 * Fullscreen sandboxed HTML preview modal for AI-generated interactive HTML reports/dashboards.
 * Loads `./sandbox-preview.html` (which carries its own HTTP `Content-Security-Policy: sandbox allow-scripts allow-forms; ...`
 * without `allow-same-origin`) and delivers the decrypted HTML locally via `postMessage`.
 * This keeps the host app's strict `script-src 'self'` CSP untouched while allowing inline scripts/charts
 * inside an opaque null-origin sandbox with zero access to cookies, localStorage, or E2EE keys.
 */
export function HtmlPreviewModal({ state, onClose }) {
  const { bi } = useI18n()
  const iframeRef = useRef(null)
  const deliveredRef = useRef(false)
  const open = Boolean(state && typeof state.html === 'string')
  const showShare = open && Boolean(state.entry) && canNativeShareFiles()
  const isMacDesktop =
    typeof window !== 'undefined' &&
    Boolean(window.allinoneDesktop?.isDesktop) &&
    window.allinoneDesktop?.platform === 'darwin'

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  useEffect(() => {
    deliveredRef.current = false
    if (!open) return undefined
    const deliverHtml = () => {
      if (deliveredRef.current) return
      const win = iframeRef.current?.contentWindow
      if (!win) return
      deliveredRef.current = true
      try {
        win.postMessage({ type: 'allinone-sandbox-html', html: state.html }, '*')
      } catch {}
    }
    const onMessage = (e) => {
      if (e.source === iframeRef.current?.contentWindow && e.data?.type === 'allinone-sandbox-ready') {
        deliverHtml()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open, state?.html])

  if (!open || typeof document === 'undefined') return null

  const filename = state.filename || 'preview.html'
  const sizeText = Number(state.size) > 0 ? formatBytesCompact(state.size) : ''
  const handleIframeLoad = () => {
    if (deliveredRef.current) return
    const win = iframeRef.current?.contentWindow
    if (!win) return
    deliveredRef.current = true
    try {
      win.postMessage({ type: 'allinone-sandbox-html', html: state.html }, '*')
    } catch {}
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={filename}
      className="fixed inset-0 z-[95] flex flex-col bg-white dark:bg-[#16181F]"
    >
      {/* Top toolbar with proper notch / status-bar & macOS traffic-light safe area */}
      <div
        className={`${
          isMacDesktop ? 'pt-9' : 'pt-safe'
        } shrink-0 border-b border-slate-200/80 bg-white px-3 pb-2.5 dark:border-slate-800 dark:bg-[#16181F]`}
      >
        <div className="flex items-center justify-between gap-2 pt-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span className="hidden xs:inline sm:inline">{bi('安全沙盒', 'Sandbox')}</span>
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold text-slate-900 dark:text-white">
                {filename}
              </div>
              {sizeText && (
                <div className="truncate text-[11px] text-slate-400 dark:text-slate-500">
                  {sizeText} · {bi('已隔离密钥与主站权限', 'Isolated from keys & storage')}
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
                className="inline-flex h-8 items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-[#232630] dark:text-slate-200 dark:hover:bg-[#2B2F3C]"
                title={bi('分享或用其他应用打开', 'Share or open with...')}
                aria-label={bi('分享', 'Share')}
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
                className="inline-flex h-8 items-center gap-1 rounded-xl bg-[#4D6BFE] px-3 text-xs font-semibold text-white shadow-2xs transition hover:bg-[#3B59F0] active:scale-95"
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
      </div>

      {/* Sandboxed HTML viewport with bottom gesture-bar safe area */}
      <div className="min-h-0 flex-1 bg-white pb-[env(safe-area-inset-bottom,0px)]">
        <iframe
          key={`${filename}:${state.size || 0}`}
          ref={iframeRef}
          title={filename}
          src="./sandbox-preview.html"
          onLoad={handleIframeLoad}
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-white"
        />
      </div>
    </div>,
    document.body,
  )
}
