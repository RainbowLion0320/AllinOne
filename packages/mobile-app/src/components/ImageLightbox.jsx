import React, { useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  Loader2,
  Maximize2,
  RefreshCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { buildDownloadUrl, getImageLabel, resolveImageSrc } from '../lib/imageUrls.js'
import { useI18n } from '../lib/i18n.jsx'

/**
 * Sleek inline image preview card rendered inside chat messages.
 * Always keeps <img> eagerly mounted (never display:none with loading="lazy") so mobile
 * browsers & Android WebView load images reliably every single time.
 */
export function ChatImageCard({
  item,
  imageContext,
  onOpen,
  compact = false,
}) {
  const { bi } = useI18n()
  const [status, setStatus] = useState('loading') // 'loading' | 'loaded' | 'error'
  const [retryNonce, setRetryNonce] = useState(0)
  const imgRef = useRef(null)

  const baseSrc = resolveImageSrc(item, imageContext)
  const src = retryNonce > 0 && baseSrc && !baseSrc.startsWith('data:')
    ? `${baseSrc}${baseSrc.includes('?') ? '&' : '?'}_r=${retryNonce}`
    : baseSrc

  const label = item?.name || getImageLabel(item?.path || item?.url || item?.raw || '')
  const rawHint = item?.path || item?.raw || ''

  useEffect(() => {
    if (!src) {
      setStatus('error')
      return
    }
    const el = imgRef.current
    if (el && el.complete && el.naturalWidth > 0) {
      setStatus('loaded')
    } else {
      setStatus('loading')
    }
  }, [src])

  if (!baseSrc) return null

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border border-slate-200/80 bg-slate-100/80 dark:border-slate-700/80 dark:bg-[#1B1E27] ${
        compact ? 'w-[220px] max-w-full' : 'w-full max-w-[340px]'
      }`}
    >
      {status === 'error' ? (
        <div className="flex flex-col items-start gap-2 p-3 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
            <ImageOff className="h-4 w-4 shrink-0 text-amber-500" />
            <span className="truncate">{label}</span>
          </div>
          {rawHint && (
            <div className="w-full break-all font-mono text-[10.5px] text-slate-400">
              {rawHint}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setStatus('loading')
              setRetryNonce((n) => n + 1)
            }}
            className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-[11px] font-semibold text-[#4D6BFE] shadow-2xs active:scale-95 dark:bg-[#252936]"
          >
            <RefreshCw className="h-3 w-3" />
            <span>{bi('重试加载', 'Retry')}</span>
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => status === 'loaded' && onOpen?.({ src, label, rawPath: rawHint })}
          className="relative block w-full overflow-hidden text-left focus:outline-none"
        >
          <div className="relative flex max-h-[340px] min-h-[150px] w-full items-center justify-center bg-[#0E1117]/8 dark:bg-black/35">
            {status === 'loading' && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-slate-100/90 text-xs text-slate-400 dark:bg-[#1B1E27]/90">
                <Loader2 className="h-5 w-5 animate-spin text-[#4D6BFE]" />
                <span className="max-w-[85%] truncate">{bi(`正在加载 ${label}...`, `Loading ${label}...`)}</span>
              </div>
            )}
            <img
              ref={imgRef}
              src={src}
              alt={label}
              loading="eager"
              decoding="async"
              onLoad={() => setStatus('loaded')}
              onError={() => setStatus('error')}
              className={`max-h-[340px] w-full object-contain transition duration-200 ${
                status === 'loaded' ? 'opacity-100 group-hover:scale-[1.01]' : 'opacity-0'
              }`}
            />
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-slate-200/70 bg-white/95 px-3 py-1.5 text-[11px] text-slate-600 dark:border-slate-700/70 dark:bg-[#20232D]/95 dark:text-slate-300">
            <span className="truncate font-medium">{label}</span>
            <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-[#4D6BFE]">
              <Maximize2 className="h-3 w-3" />
              <span>{bi('查看大图', 'View full')}</span>
            </span>
          </div>
        </button>
      )}
    </div>
  )
}

/**
 * Renders a responsive gallery of images attached to or referenced by a chat message.
 */
export function ChatImageGallery({ images = [], imageContext, compact = false }) {
  if (!Array.isArray(images) || images.length === 0) return null

  const resolvedList = images.map((item) => {
    const src = resolveImageSrc(item, imageContext)
    const label = item?.name || getImageLabel(item?.path || item?.url || item?.raw || '')
    return {
      item,
      src,
      label,
      rawPath: item?.path || item?.raw || '',
    }
  })

  return (
    <div className={`mt-2.5 flex flex-wrap gap-2 ${compact ? 'justify-end' : ''}`}>
      {resolvedList.map((entry, idx) => (
        <ChatImageCard
          key={`${entry.src || idx}-${idx}`}
          item={entry.item}
          imageContext={imageContext}
          compact={compact || images.length > 1}
          onOpen={() =>
            imageContext?.onOpenImage?.({
              images: resolvedList.map(({ src, label, rawPath }) => ({ src, label, rawPath })),
              index: idx,
            })
          }
        />
      ))}
    </div>
  )
}

/**
 * Full-screen zoomable mobile image viewer (supports 1x / 2x / 3x zoom, pan, multi-image nav, & download).
 */
export function ImageLightbox({ state, onClose }) {
  const { bi } = useI18n()
  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    if (state) {
      setIndex(state.index || 0)
      setZoom(1)
    }
  }, [state])

  useEffect(() => {
    if (!state) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && state.images?.length > 1) {
        setIndex((i) => (i - 1 + state.images.length) % state.images.length)
        setZoom(1)
      } else if (e.key === 'ArrowRight' && state.images?.length > 1) {
        setIndex((i) => (i + 1) % state.images.length)
        setZoom(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, onClose])

  if (!state || !Array.isArray(state.images) || state.images.length === 0) return null

  const current = state.images[index] || state.images[0]
  const total = state.images.length
  const downloadHref = buildDownloadUrl(current.src)

  const cycleZoom = () => {
    setZoom((z) => (z === 1 ? 2 : z === 2 ? 3 : 1))
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-[#080A0F]/96 text-white backdrop-blur-md"
      onClick={onClose}
    >
      {/* Top Bar */}
      <div
        className="pt-safe flex items-center justify-between gap-2 border-b border-white/10 px-4 pb-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {current.label || bi('查看图片', 'Image Preview')}
            {total > 1 && <span className="ml-2 text-xs text-white/60">{index + 1}/{total}</span>}
          </div>
          {current.rawPath && (
            <div className="truncate font-mono text-[10.5px] text-white/50">{current.rawPath}</div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={cycleZoom}
            title={bi('缩放', 'Zoom')}
            className="inline-flex h-9 items-center gap-1 rounded-xl bg-white/10 px-2.5 text-xs font-medium hover:bg-white/20 active:scale-95"
          >
            {zoom > 1 ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
            <span>{zoom}x</span>
          </button>

          {downloadHref && (
            <a
              href={downloadHref}
              download={current.label || 'image.png'}
              target="_blank"
              rel="noreferrer"
              title={bi('保存图片', 'Save image')}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 active:scale-95"
            >
              <Download className="h-4 w-4" />
            </a>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label={bi('关闭预览', 'Close preview')}
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 active:scale-95"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Zoomable / Pannable Viewport */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-auto p-3"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <img
          src={current.src}
          alt={current.label || 'preview'}
          onClick={(e) => {
            e.stopPropagation()
            cycleZoom()
          }}
          style={{
            width: zoom === 1 ? 'auto' : `${zoom * 100}%`,
            maxWidth: zoom === 1 ? '100%' : 'none',
            maxHeight: zoom === 1 ? '100%' : 'none',
          }}
          className="cursor-zoom-in rounded-lg object-contain shadow-2xl transition-all duration-150 select-none"
        />

        {total > 1 && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setIndex((i) => (i - 1 + total) % total)
                setZoom(1)
              }}
              aria-label={bi('上一张', 'Previous image')}
              className="fixed top-1/2 left-3 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/20 active:scale-95"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setIndex((i) => (i + 1) % total)
                setZoom(1)
              }}
              aria-label={bi('下一张', 'Next image')}
              className="fixed top-1/2 right-3 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/20 active:scale-95"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      {/* Bottom hint */}
      <div className="pb-safe py-2 text-center text-[11px] text-white/45">
        {bi('点击图片切换 1x / 2x / 3x 放大 · 放大后可拖动查看细节', 'Click image to toggle 1x / 2x / 3x zoom · Drag to pan when zoomed')}
      </div>
    </div>
  )
}
