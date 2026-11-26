import React, { useEffect, useRef, useState } from 'react'
import {
  Globe,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  Maximize2,
  RefreshCw,
  ShieldAlert,
  Zap,
} from 'lucide-react'
import {
  getImageLabel,
  isExternalHttpImageUrl,
  isPrivateOrLoopbackUrl,
  resolveImageSrc,
} from '../lib/imageUrls.js'
import {
  getCachedE2eeImageUrl,
  loadE2eeImageUrl,
  loadPersistedE2eeImageUrl,
  needsE2eeMediaLoad,
} from '../lib/e2eeMedia.js'
import { useI18n } from '../lib/i18n.jsx'

/**
 * Sleek inline image preview card rendered inside chat messages.
 * Always keeps <img> eagerly mounted (never display:none with loading="lazy") so mobile
 * browsers & Android WebView load images reliably every single time.
 * Supports Zero-Knowledge E2EE image decryption over direct WebRTC P2P (`RPC.FILE_READ` + `aio-bulk`).
 */
function ChatImageCard({
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
  const [manualLoadAllowed, setManualLoadAllowed] = useState(false)
  const imgRef = useRef(null)
  const imageContextRef = useRef(imageContext)
  imageContextRef.current = imageContext

  useEffect(() => {
    setPreviewFailed(false)
    setManualLoadAllowed(false)
    setRetryNonce(0)
    setE2eeSrc('')
  }, [
    item?.localPreviewUrl,
    item?.url,
    item?.path,
    imageContext?.roomId,
    imageContext?.bridgeId,
    imageContext?.cwd,
    imageContext?.e2eeKeyId,
  ])

  const effectiveItem =
    previewFailed && item && typeof item === 'object'
      ? { ...item, localPreviewUrl: '' }
      : item

  const isOnline = imageContext?.connState === 'connected' && Boolean(imageContext?.bridgeOnline)
  const p2pState = imageContext?.p2pState || 'idle'
  const p2pTransport = imageContext?.p2pTransport || ''

  const needsE2ee = needsE2eeMediaLoad(effectiveItem)
  const cachedE2eeSrc = needsE2ee ? getCachedE2eeImageUrl(effectiveItem, imageContext) : ''
  const resolvedE2eeSrc = e2eeSrc || cachedE2eeSrc
  const waitingForTransport = Boolean(
    needsE2ee &&
      !resolvedE2eeSrc &&
      isOnline &&
      (p2pState === 'idle' || p2pState === 'connecting'),
  )
  const transportUnavailable = Boolean(
    needsE2ee &&
      !resolvedE2eeSrc &&
      (!isOnline || p2pState === 'failed'),
  )
  const deferForRelay = Boolean(
    needsE2ee &&
      !resolvedE2eeSrc &&
      !manualLoadAllowed &&
      isOnline &&
      p2pState === 'connected' &&
      imageContext?.relayDataSaver &&
      p2pTransport === 'relay',
  )
  const directSrc = needsE2ee
    ? ''
    : (typeof effectiveItem === 'object' && effectiveItem?.localPreviewUrl) || resolveImageSrc(effectiveItem)
  const isLocalPreview = Boolean(typeof effectiveItem === 'object' && effectiveItem?.localPreviewUrl)
  const isExternalHttp = Boolean(!needsE2ee && !isLocalPreview && isExternalHttpImageUrl(directSrc))
  const isBlockedExternal = Boolean(isExternalHttp && isPrivateOrLoopbackUrl(directSrc))
  const deferExternalHttp = Boolean(isExternalHttp && !isBlockedExternal && !manualLoadAllowed)
  const externalHostname = (() => {
    if (!isExternalHttp || !directSrc) return ''
    try {
      return new URL(directSrc).hostname || ''
    } catch {
      return ''
    }
  })()
  const baseSrc = needsE2ee
    ? resolvedE2eeSrc
    : isBlockedExternal || deferExternalHttp
      ? ''
      : directSrc
  const src = retryNonce > 0 && baseSrc && !baseSrc.startsWith('data:') && !baseSrc.startsWith('blob:')
    ? `${baseSrc}${baseSrc.includes('?') ? '&' : '?'}_r=${retryNonce}`
    : baseSrc

  const label = item?.name || getImageLabel(item?.path || item?.url || item?.raw || '')
  const rawHint = item?.path || item?.raw || ''

  // Hydrate previously viewed images from persistent IndexedDB first (0 network bytes, works offline & on Relay Saver)
  useEffect(() => {
    if (!needsE2ee || retryNonce > 0) return
    const latestCached = getCachedE2eeImageUrl(effectiveItem, imageContextRef.current)
    if (latestCached) {
      setE2eeSrc(latestCached)
      return
    }
    let cancelled = false
    loadPersistedE2eeImageUrl(effectiveItem, imageContextRef.current)
      .then((persistedUrl) => {
        if (!cancelled && persistedUrl) {
          setE2eeSrc(persistedUrl)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    needsE2ee,
    retryNonce,
    previewFailed,
    effectiveItem?.path,
    effectiveItem?.url,
    effectiveItem?.raw,
    imageContext?.roomId,
    imageContext?.bridgeId,
    imageContext?.cwd,
    imageContext?.e2eeKeyId,
  ])

  useEffect(() => {
    if (!needsE2ee) {
      setE2eeSrc('')
      return
    }
    const latestCached = getCachedE2eeImageUrl(effectiveItem, imageContextRef.current)
    if (latestCached && retryNonce === 0) {
      setE2eeSrc(latestCached)
      return
    }
    if (deferForRelay) {
      return
    }
    if (!isOnline || p2pState !== 'connected') {
      if (waitingForTransport) setStatus('loading')
      return
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    let cancelled = false
    const isForceRetry = retryNonce > 0
    setStatus('loading')
    loadE2eeImageUrl(effectiveItem, imageContextRef.current, {
      forceRefresh: isForceRetry,
      signal: controller?.signal || null,
    })
      .then((blobUrl) => {
        if (cancelled) return
        if (!blobUrl) {
          setStatus('error')
          return
        }
        setE2eeSrc(blobUrl)
        if (isForceRetry) setRetryNonce(0)
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return
        setE2eeSrc('')
        setStatus('error')
      })
    return () => {
      cancelled = true
      try { controller?.abort() } catch {}
    }
  }, [
    needsE2ee,
    deferForRelay,
    waitingForTransport,
    isOnline,
    p2pState,
    previewFailed,
    effectiveItem?.path,
    effectiveItem?.url,
    effectiveItem?.raw,
    imageContext?.roomId,
    imageContext?.bridgeId,
    imageContext?.cwd,
    imageContext?.e2eeKeyId,
    imageContext?.client,
    retryNonce,
  ])

  useEffect(() => {
    if (isBlockedExternal || deferExternalHttp) return
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
  }, [src, needsE2ee, isBlockedExternal, deferExternalHttp])

  if (!needsE2ee && !directSrc) return null

  const handleRetryTransport = () => {
    setManualLoadAllowed(true)
    if (isOnline && p2pState === 'failed' && imageContext?.client?.retryP2p) {
      setStatus('loading')
      void imageContext.client.retryP2p(imageContext.bridgeId || '').catch(() => {
        setStatus('error')
      })
      return
    }
    setStatus('loading')
    setRetryNonce((n) => n + 1)
  }

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border border-slate-200/80 bg-slate-100/80 dark:border-slate-700/80 dark:bg-[#1B1E27] ${
        compact ? 'w-[220px] max-w-full' : 'w-full max-w-[340px]'
      }`}
    >
      {isBlockedExternal ? (
        <div className="flex w-full flex-col items-center justify-center gap-2 px-4 py-5 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-rose-500/12 text-rose-600 dark:text-rose-400">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="max-w-full truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
            {externalHostname || label}
          </div>
          <div className="inline-flex items-center gap-1 rounded-full bg-rose-500/12 px-2.5 py-0.5 text-[10.5px] font-semibold text-rose-600 dark:text-rose-300">
            <span>{bi('已拦截不安全/内网图片地址', 'Blocked unsafe / private image URL')}</span>
          </div>
        </div>
      ) : deferExternalHttp ? (
        <button
          type="button"
          onClick={() => {
            setStatus('loading')
            setManualLoadAllowed(true)
          }}
          className="flex w-full flex-col items-center justify-center gap-2 px-4 py-5 text-center transition hover:bg-slate-200/50 active:scale-[0.99] dark:hover:bg-[#232734]"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-200/80 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <Globe className="h-5 w-5" />
          </div>
          <div className="max-w-full truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
            {label}
          </div>
          <div className="inline-flex max-w-full items-center gap-1 rounded-full bg-[#4D6BFE]/12 px-2.5 py-0.5 text-[10.5px] font-semibold text-[#3552E8] dark:text-[#96AEFF]">
            <span className="truncate">
              {externalHostname
                ? bi(`加载外部图片 · ${externalHostname}`, `Load external image · ${externalHostname}`)
                : bi('点击加载外部图片', 'Load external image')}
            </span>
          </div>
        </button>
      ) : deferForRelay ? (
        <button
          type="button"
          onClick={() => {
            setStatus('loading')
            setManualLoadAllowed(true)
          }}
          className="flex w-full flex-col items-center justify-center gap-2 px-4 py-5 text-center transition hover:bg-slate-200/50 active:scale-[0.99] dark:hover:bg-[#232734]"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-500/12 text-sky-600 dark:text-sky-400">
            <ImageIcon className="h-5 w-5" />
          </div>
          <div className="max-w-full truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
            {label}
          </div>
          <div className="inline-flex items-center gap-1 rounded-full bg-sky-500/12 px-2.5 py-0.5 text-[10.5px] font-semibold text-sky-600 dark:text-sky-400">
            <Zap className="h-2.5 w-2.5" />
            <span>{bi('中继省流 · 点击加载原图', 'Relay Saver · Tap to load')}</span>
          </div>
        </button>
      ) : transportUnavailable ? (
        isOnline && p2pState === 'failed' ? (
          <button
            type="button"
            onClick={handleRetryTransport}
            className="flex w-full flex-col items-center justify-center gap-2 px-4 py-5 text-center transition hover:bg-slate-200/50 active:scale-[0.99] dark:hover:bg-[#232734]"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-600 dark:text-amber-400">
              <ImageOff className="h-5 w-5" />
            </div>
            <div className="max-w-full truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
              {label}
            </div>
            <div className="inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-2.5 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
              <RefreshCw className="h-2.5 w-2.5" />
              <span>{bi('P2P 已暂停 · 点击重试加载', 'P2P paused · Tap to retry')}</span>
            </div>
          </button>
        ) : (
          <div className="flex w-full flex-col items-center justify-center gap-2 px-4 py-5 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-200/80 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <ImageOff className="h-5 w-5" />
            </div>
            <div className="max-w-full truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
              {label}
            </div>
            <div className="inline-flex items-center gap-1 rounded-full bg-slate-200/75 px-2.5 py-0.5 text-[10.5px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <span>
                {imageContext?.connState === 'connected' && !imageContext?.bridgeOnline
                  ? bi('电脑离线 · 暂无法加载', 'Computer offline · Paused')
                  : bi('连接已断开 · 暂无法加载', 'Disconnected · Paused')}
              </span>
            </div>
          </div>
        )
      ) : status === 'error' ? (
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
            onClick={handleRetryTransport}
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
                referrerPolicy="no-referrer"
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
    const needsE2ee = needsE2eeMediaLoad(item)
    const rawDirect = needsE2ee
      ? getCachedE2eeImageUrl(item, imageContext)
      : (typeof item === 'object' && item?.localPreviewUrl) || resolveImageSrc(item)
    const src =
      !needsE2ee && isExternalHttpImageUrl(rawDirect) && isPrivateOrLoopbackUrl(rawDirect)
        ? ''
        : rawDirect
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
          key={`${entry.rawPath || entry.item?.id || entry.item?.url || idx}-${idx}`}
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
