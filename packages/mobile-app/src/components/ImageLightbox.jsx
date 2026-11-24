import React, { useEffect, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  Loader2,
  RefreshCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { isRelayUploadTarget } from '../lib/imageUrls.js'
import { loadE2eeImageUrl, needsE2eeMediaLoad } from '../lib/e2eeMedia.js'
import { useI18n } from '../lib/i18n.jsx'

/**
 * Full-screen zoomable mobile image viewer (supports 1x / 2x / 3x zoom, pan, multi-image nav, E2EE decryption & download).
 */
export function ImageLightbox({ state, imageContext = null, onClose }) {
  const { bi } = useI18n()
  const [index, setIndex] = useState(() => state?.index || 0)
  const [zoom, setZoom] = useState(1)
  const [resolvedMap, setResolvedMap] = useState({})
  const [errorMap, setErrorMap] = useState({})
  const [failedSrcMap, setFailedSrcMap] = useState({})
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    if (state) {
      setIndex(state.index || 0)
      setZoom(1)
      setResolvedMap({})
      setErrorMap({})
      setFailedSrcMap({})
      setRetryNonce(0)
    } else {
      setResolvedMap({})
      setErrorMap({})
      setFailedSrcMap({})
      setRetryNonce(0)
    }
  }, [state])

  const current = state?.images?.[index] || state?.images?.[0] || null
  const currentInitialSrc = failedSrcMap[index] ? '' : (current?.src || '')
  const effectiveCurrentItem =
    failedSrcMap[index] && current?.item && typeof current.item === 'object'
      ? { ...current.item, localPreviewUrl: '' }
      : current?.item
  const currentNeedsE2ee = Boolean(
    current &&
      !currentInitialSrc &&
      effectiveCurrentItem &&
      imageContext &&
      needsE2eeMediaLoad(effectiveCurrentItem, imageContext),
  )
  const e2eeKeysSig = imageContext?.e2eeKeys
    ? Object.keys(imageContext.e2eeKeys).sort().join(',')
    : ''

  useEffect(() => {
    if (!state || !currentNeedsE2ee || !effectiveCurrentItem || resolvedMap[index] || errorMap[index]) return
    const targetUrl = typeof effectiveCurrentItem === 'string'
      ? effectiveCurrentItem.trim()
      : String(effectiveCurrentItem?.url || effectiveCurrentItem?.path || '').trim()
    if (
      isRelayUploadTarget(targetUrl) &&
      typeof effectiveCurrentItem === 'object' &&
      effectiveCurrentItem?.e2ee?.iv &&
      imageContext?.baseUrl &&
      !imageContext?.mediaToken
    ) {
      return
    }
    let cancelled = false
    loadE2eeImageUrl(effectiveCurrentItem, imageContext, { forceRefresh: retryNonce > 0 })
      .then((blobUrl) => {
        if (cancelled) return
        if (blobUrl) {
          setResolvedMap((prev) => ({ ...prev, [index]: blobUrl }))
        } else {
          setErrorMap((prev) => ({ ...prev, [index]: bi('无法加载图片', 'Failed to load image') }))
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMap((prev) => ({
            ...prev,
            [index]: String(err?.message || err || bi('端到端解密图片失败', 'Failed to decrypt image')),
          }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    state,
    currentNeedsE2ee,
    effectiveCurrentItem,
    imageContext,
    imageContext?.mediaToken,
    e2eeKeysSig,
    index,
    resolvedMap,
    errorMap,
    retryNonce,
    bi,
  ])

  useEffect(() => {
    if (!state) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose()
      } else if (e.key === 'ArrowLeft' && state.images?.length > 1) {
        setIndex((i) => (i - 1 + state.images.length) % state.images.length)
        setZoom(1)
      } else if (e.key === 'ArrowRight' && state.images?.length > 1) {
        setIndex((i) => (i + 1) % state.images.length)
        setZoom(1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state, onClose])

  if (!state || !Array.isArray(state.images) || state.images.length === 0 || !current) return null

  const total = state.images.length
  const rawActiveSrc = resolvedMap[index] || currentInitialSrc || ''
  const activeSrc =
    retryNonce > 0 && rawActiveSrc && !rawActiveSrc.startsWith('data:') && !rawActiveSrc.startsWith('blob:')
      ? `${rawActiveSrc}${rawActiveSrc.includes('?') ? '&' : '?'}_r=${retryNonce}`
      : rawActiveSrc
  const currentError = errorMap[index] || ''
  const downloadHref = activeSrc || ''
  const isBlobOrDataDownload = downloadHref.startsWith('blob:') || downloadHref.startsWith('data:')

  const handleRetry = (e) => {
    e?.stopPropagation?.()
    setErrorMap((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
    setResolvedMap((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
    if (current?.src && !String(current.src).startsWith('blob:')) {
      setFailedSrcMap((prev) => {
        const next = { ...prev }
        delete next[index]
        return next
      })
    }
    setRetryNonce((n) => n + 1)
  }

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
              {...(isBlobOrDataDownload ? {} : { target: '_blank', rel: 'noreferrer' })}
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

      {/* Zoomable / Pannable Viewport (m-auto centers at 1x without top/left clipping at >1x) */}
      <div
        className="relative flex flex-1 overflow-auto p-3"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        {activeSrc ? (
          <img
            src={activeSrc}
            alt={current.label || 'preview'}
            onClick={(e) => {
              e.stopPropagation()
              cycleZoom()
            }}
            onError={() => {
              if (!failedSrcMap[index] && current.src && current.item && imageContext) {
                const withoutPreview = typeof current.item === 'object' ? { ...current.item, localPreviewUrl: '' } : current.item
                if (needsE2eeMediaLoad(withoutPreview, imageContext)) {
                  setFailedSrcMap((prev) => ({ ...prev, [index]: true }))
                  return
                }
              }
              setResolvedMap((prev) => {
                const next = { ...prev }
                delete next[index]
                return next
              })
              setFailedSrcMap((prev) => ({ ...prev, [index]: true }))
              setErrorMap((prev) => ({
                ...prev,
                [index]: bi('图片加载失败', 'Failed to load image'),
              }))
            }}
            style={{
              width: zoom === 1 ? 'auto' : `${zoom * 100}%`,
              maxWidth: zoom === 1 ? '100%' : 'none',
              maxHeight: zoom === 1 ? '100%' : 'none',
            }}
            className="m-auto shrink-0 cursor-zoom-in rounded-lg object-contain shadow-2xl transition-all duration-150 select-none"
          />
        ) : currentError || !currentNeedsE2ee ? (
          <div
            className="m-auto flex max-w-xs flex-col items-center gap-3 rounded-2xl bg-white/8 px-5 py-4 text-center text-xs text-white/85"
            onClick={(e) => e.stopPropagation()}
          >
            <ImageOff className="h-7 w-7 text-amber-400" />
            <div className="break-words">{currentError || bi('图片加载失败', 'Failed to load image')}</div>
            <button
              type="button"
              onClick={handleRetry}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#4D6BFE] px-3.5 py-1.5 text-xs font-semibold text-white active:scale-95"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{bi('重试加载', 'Retry')}</span>
            </button>
          </div>
        ) : (
          <div className="m-auto flex flex-col items-center gap-2 text-xs text-white/70">
            <Loader2 className="h-6 w-6 animate-spin text-[#4D6BFE]" />
            <span>{bi('正在端到端解密图片...', 'Decrypting image end-to-end...')}</span>
          </div>
        )}

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
