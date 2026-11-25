import React, { useEffect, useRef, useState } from 'react'
import {
  ImageOff,
  Loader2,
  Maximize2,
  RefreshCw,
} from 'lucide-react'
import { getImageLabel, resolveImageSrc } from '../lib/imageUrls.js'
import { loadE2eeImageUrl, needsE2eeMediaLoad } from '../lib/e2eeMedia.js'
import { useI18n } from '../lib/i18n.jsx'

/**
 * Sleek inline image preview card rendered inside chat messages.
 * Always keeps <img> eagerly mounted (never display:none with loading="lazy") so mobile
 * browsers & Android WebView load images reliably every single time.
 * Supports Zero-Knowledge E2EE image decryption over direct WebRTC P2P (`RPC.FILE_READ` + `aio-bulk`).
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
  const [e2eeSrc, setE2eeSrc] = useState('')
  const [previewFailed, setPreviewFailed] = useState(false)
  const imgRef = useRef(null)

  useEffect(() => {
    setPreviewFailed(false)
  }, [item?.localPreviewUrl, item?.url, item?.path])

  const effectiveItem =
    previewFailed && item && typeof item === 'object'
      ? { ...item, localPreviewUrl: '' }
      : item

  const needsE2ee = needsE2eeMediaLoad(effectiveItem, imageContext)
  const directSrc = needsE2ee
    ? ''
    : (typeof effectiveItem === 'object' && effectiveItem?.localPreviewUrl) || resolveImageSrc(effectiveItem, imageContext)
  const baseSrc = needsE2ee ? e2eeSrc : directSrc
  const src = retryNonce > 0 && baseSrc && !baseSrc.startsWith('data:') && !baseSrc.startsWith('blob:')
    ? `${baseSrc}${baseSrc.includes('?') ? '&' : '?'}_r=${retryNonce}`
    : baseSrc

  const e2eeKeysSig = imageContext?.e2eeKeys
    ? Object.keys(imageContext.e2eeKeys).sort().join(',')
    : ''

  const label = item?.name || getImageLabel(item?.path || item?.url || item?.raw || '')
  const rawHint = item?.path || item?.raw || ''

  useEffect(() => {
    if (!needsE2ee) {
      setE2eeSrc('')
      return
    }
    let cancelled = false
    setStatus('loading')
    loadE2eeImageUrl(effectiveItem, imageContext, { forceRefresh: retryNonce > 0 })
      .then((blobUrl) => {
        if (cancelled) return
        if (!blobUrl) {
          setStatus('error')
          return
        }
        setE2eeSrc(blobUrl)
      })
      .catch(() => {
        if (!cancelled) {
          setE2eeSrc('')
          setStatus('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    needsE2ee,
    previewFailed,
    effectiveItem?.path,
    effectiveItem?.url,
    effectiveItem?.raw,
    effectiveItem?.e2ee?.iv,
    effectiveItem?.e2ee?.kid,
    imageContext?.baseUrl,
    imageContext?.roomId,
    imageContext?.bridgeId,
    imageContext?.cwd,
    imageContext?.p2pState,
    imageContext?.e2eeKey,
    imageContext?.e2eeKeyId,
    e2eeKeysSig,
    retryNonce,
  ])

  useEffect(() => {
    if (!src) {
      if (!needsE2ee) {
        setStatus('error')
      }
      return
    }
    const el = imgRef.current
    if (el && el.complete && el.naturalWidth > 0) {
      setStatus('loaded')
    } else {
      setStatus('loading')
    }
  }, [src, needsE2ee])

  if (!needsE2ee && !directSrc) return null

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
            {src && (
              <img
                ref={imgRef}
                src={src}
                alt={label}
                loading="eager"
                decoding="async"
                onLoad={() => setStatus('loaded')}
                onError={() => {
                  if (!previewFailed && typeof item === 'object' && item?.localPreviewUrl) {
                    setPreviewFailed(true)
                    setStatus('loading')
                    return
                  }
                  setStatus('error')
                }}
                className={`max-h-[340px] w-full object-contain transition duration-200 ${
                  status === 'loaded' ? 'opacity-100 group-hover:scale-[1.01]' : 'opacity-0'
                }`}
              />
            )}
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
    const needsE2ee = needsE2eeMediaLoad(item, imageContext)
    const src = needsE2ee
      ? ''
      : (typeof item === 'object' && item?.localPreviewUrl) || resolveImageSrc(item, imageContext)
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
          key={`${entry.rawPath || entry.src || idx}-${idx}`}
          item={entry.item}
          imageContext={imageContext}
          compact={compact || images.length > 1}
          onOpen={(opened) =>
            imageContext?.onOpenImage?.({
              images: resolvedList.map((e, i) => ({
                item: e.item,
                src: i === idx && opened?.src ? opened.src : e.src,
                label: e.label,
                rawPath: e.rawPath,
              })),
              index: idx,
            })
          }
        />
      ))}
    </div>
  )
}
