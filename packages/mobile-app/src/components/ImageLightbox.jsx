import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  X,
} from 'lucide-react'
import { acquireBlobUrl, loadE2eeImageUrl, needsE2eeMediaLoad, releaseBlobUrl } from '../lib/e2eeMedia.js'
import { saveOrShareBlobNatively } from '../lib/e2eeFiles.js'
import { isExternalHttpImageUrl, isPrivateOrLoopbackUrl } from '../lib/imageUrls.js'
import { useI18n } from '../lib/i18n.jsx'
import { useImageActions } from '../state/ImageContext.jsx'

const MIN_SCALE = 0.25
const MAX_SCALE = 8
const DOUBLE_TAP_SCALE = 2.5
const ZOOM_BUTTON_STEP = 1.25
const EPS = 0.01

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val))
}

/**
 * Full-screen interactive image viewer with native photo-viewer feel:
 *  - Continuous cursor-anchored wheel & trackpad pinch zoom (0.25x – 8x)
 *  - Multi-touch pinch-to-zoom & simultaneous pan on mobile/tablets
 *  - Smooth 60fps pointer drag-to-pan (no clunky click-to-cycle zoom!)
 *  - Double-click / double-tap to smoothly toggle fit vs 2.5x at pointer
 *  - Rotate 90°, Fit-to-screen, 1:1 native pixel size, swipe/arrow multi-image nav
 *  - Zero-Knowledge E2EE media decryption & original image download
 */
export function ImageLightbox({ state, imageContext: propImageContext = null, onMediaCached = null, onClose }) {
  const { bi } = useI18n()
  const ctxImageActions = useImageActions()
  const imageContext = propImageContext || ctxImageActions
  const [index, setIndex] = useState(() => state?.index || 0)
  const [resolvedMap, setResolvedMap] = useState({})
  const [errorMap, setErrorMap] = useState({})
  const [failedSrcMap, setFailedSrcMap] = useState({})
  const [retryNonceMap, setRetryNonceMap] = useState({})
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })

  // Lightweight UI state mirrored from transformRef for toolbar display & cursor
  const [displayScalePct, setDisplayScalePct] = useState(100)
  const [isZoomed, setIsZoomed] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [rotation, setRotation] = useState(0)

  const stageRef = useRef(null)
  const canvasRef = useRef(null)
  const imgRef = useRef(null)

  // Live 60fps transform ref (source of truth for wheel, pinch, and drag handlers)
  const transformRef = useRef({ scale: 1, x: 0, y: 0, rotate: 0 })
  const pointersRef = useRef(new Map())
  const gestureRef = useRef({
    mode: 'idle', // 'idle' | 'pan' | 'pinch' | 'swipe'
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
    downOnBackdrop: false,
    pinchDist: 0,
    pinchMidX: 0,
    pinchMidY: 0,
    suppressBackdropClickUntil: 0,
    lastTapAt: 0,
    lastTapX: 0,
    lastTapY: 0,
  })

  const total = state?.images?.length || 0

  /**
   * Compute clamped translation so the zoomed image can reach every corner
   * without drifting off-screen, and stays centered when smaller than the stage.
   */
  const clampTranslation = useCallback((x, y, scale, rotateDeg) => {
    const stage = stageRef.current
    const img = imgRef.current
    if (!stage || !img) return { x: 0, y: 0 }

    const stageRect = stage.getBoundingClientRect()
    const baseW = img.offsetWidth || 0
    const baseH = img.offsetHeight || 0
    if (baseW <= 0 || baseH <= 0 || stageRect.width <= 0 || stageRect.height <= 0) {
      return { x: 0, y: 0 }
    }

    const quarterTurns = ((Math.round(rotateDeg / 90) % 4) + 4) % 4
    const visW = quarterTurns % 2 === 1 ? baseH : baseW
    const visH = quarterTurns % 2 === 1 ? baseW : baseH

    const scaledW = visW * scale
    const scaledH = visH * scale
    const maxX = scaledW > stageRect.width ? (scaledW - stageRect.width) / 2 + 24 : 0
    const maxY = scaledH > stageRect.height ? (scaledH - stageRect.height) / 2 + 24 : 0

    return {
      x: maxX > 0 ? clamp(x, -maxX, maxX) : 0,
      y: maxY > 0 ? clamp(y, -maxY, maxY) : 0,
    }
  }, [])

  const canPanNow = useCallback((scale = transformRef.current.scale, rotateDeg = transformRef.current.rotate) => {
    if (scale > 1 + EPS) return true
    const stage = stageRef.current
    const img = imgRef.current
    if (!stage || !img) return false
    const stageRect = stage.getBoundingClientRect()
    const baseW = img.offsetWidth || 0
    const baseH = img.offsetHeight || 0
    const quarterTurns = ((Math.round(rotateDeg / 90) % 4) + 4) % 4
    const visW = quarterTurns % 2 === 1 ? baseH : baseW
    const visH = quarterTurns % 2 === 1 ? baseW : baseH
    return visW * scale > stageRect.width + 2 || visH * scale > stageRect.height + 2
  }, [])

  const applyTransform = useCallback((next, { animate = false } = {}) => {
    const clampedScale = clamp(next.scale, MIN_SCALE, MAX_SCALE)
    const cleanRotate = Number.isFinite(next.rotate) ? next.rotate : transformRef.current.rotate
    const { x, y } = clampTranslation(next.x, next.y, clampedScale, cleanRotate)

    transformRef.current = { scale: clampedScale, x, y, rotate: cleanRotate }

    const el = canvasRef.current
    if (el) {
      el.style.transition = animate ? 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
      el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${clampedScale.toFixed(4)}) rotate(${cleanRotate}deg)`
    }

    const pct = Math.round(clampedScale * 100)
    setDisplayScalePct((prev) => (prev === pct ? prev : pct))
    const pannable = canPanNow(clampedScale, cleanRotate)
    setIsZoomed((prev) => (prev === pannable ? prev : pannable))
    const normalizedRot = ((cleanRotate % 360) + 360) % 360
    setRotation((prev) => (prev === normalizedRot ? prev : normalizedRot))
  }, [clampTranslation, canPanNow])

  /**
   * Zoom to `targetScale` while keeping screen point `(clientX, clientY)` fixed on the same image pixel.
   * Formula is exact for any rotation because isotropic scale commutes with rotation.
   */
  const zoomAtPoint = useCallback((targetScale, clientX, clientY, { animate = false } = {}) => {
    const stage = stageRef.current
    const cur = transformRef.current
    const nextScale = clamp(targetScale, MIN_SCALE, MAX_SCALE)
    if (!stage || Math.abs(nextScale - cur.scale) < 0.0005) {
      applyTransform({ ...cur, scale: nextScale }, { animate })
      return
    }
    const rect = stage.getBoundingClientRect()
    const dx = clientX - (rect.left + rect.width / 2)
    const dy = clientY - (rect.top + rect.height / 2)
    const ratio = nextScale / cur.scale
    const nextX = dx - ratio * (dx - cur.x)
    const nextY = dy - ratio * (dy - cur.y)
    applyTransform({ scale: nextScale, x: nextX, y: nextY, rotate: cur.rotate }, { animate })
  }, [applyTransform])

  const zoomAroundCenter = useCallback((targetScale, { animate = true } = {}) => {
    const stage = stageRef.current
    if (!stage) {
      applyTransform({ ...transformRef.current, scale: targetScale }, { animate })
      return
    }
    const rect = stage.getBoundingClientRect()
    zoomAtPoint(targetScale, rect.left + rect.width / 2, rect.top + rect.height / 2, { animate })
  }, [applyTransform, zoomAtPoint])

  const resetView = useCallback(({ animate = true, keepRotation = false } = {}) => {
    applyTransform(
      {
        scale: 1,
        x: 0,
        y: 0,
        rotate: keepRotation ? transformRef.current.rotate : 0,
      },
      { animate },
    )
  }, [applyTransform])

  const toggleActualPixels = useCallback(() => {
    const img = imgRef.current
    if (!img || !img.naturalWidth || !img.offsetWidth) return
    const ratio = clamp(img.naturalWidth / img.offsetWidth, 1, MAX_SCALE)
    const cur = transformRef.current
    if (Math.abs(cur.scale - ratio) < 0.08 && Math.abs(cur.x) < 10 && Math.abs(cur.y) < 10) {
      resetView({ animate: true, keepRotation: true })
    } else {
      applyTransform({ scale: ratio, x: 0, y: 0, rotate: cur.rotate }, { animate: true })
    }
  }, [applyTransform, resetView])

  const rotateBy = useCallback((deltaDeg) => {
    const cur = transformRef.current
    applyTransform({ scale: cur.scale, x: cur.x, y: cur.y, rotate: cur.rotate + deltaDeg }, { animate: true })
  }, [applyTransform])

  const stepImage = useCallback((delta) => {
    if (total <= 1) return
    setIndex((i) => (i + delta + total) % total)
    setNaturalSize({ width: 0, height: 0 })
    pointersRef.current.clear()
    gestureRef.current.mode = 'idle'
    setIsDragging(false)
    resetView({ animate: false, keepRotation: false })
  }, [total, resetView])

  // Reset state whenever lightbox opens or switches image bundle
  useEffect(() => {
    if (state) {
      setIndex(state.index || 0)
      setResolvedMap({})
      setErrorMap({})
      setFailedSrcMap({})
      setRetryNonceMap({})
      setNaturalSize({ width: 0, height: 0 })
      pointersRef.current.clear()
      gestureRef.current.mode = 'idle'
      setIsDragging(false)
      resetView({ animate: false, keepRotation: false })
    } else {
      setResolvedMap({})
      setErrorMap({})
      setFailedSrcMap({})
      setRetryNonceMap({})
    }
  }, [state, resetView])

  // Re-clamp pan position cleanly when window resizes
  useEffect(() => {
    if (!state) return
    const onResize = () => {
      applyTransform(transformRef.current, { animate: false })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [state, applyTransform])

  const current = state?.images?.[index] || state?.images?.[0] || null
  const isSrcFailed = Boolean(failedSrcMap[index])
  const currentInitialSrc = isSrcFailed ? '' : (current?.src || '')
  const currentItem = current?.item ?? null
  const effectiveCurrentItem = useMemo(
    () =>
      isSrcFailed && currentItem && typeof currentItem === 'object'
        ? { ...currentItem, localPreviewUrl: '' }
        : currentItem,
    [isSrcFailed, currentItem],
  )
  const currentNeedsE2ee = Boolean(
    current &&
      !currentInitialSrc &&
      effectiveCurrentItem &&
      imageContext &&
      needsE2eeMediaLoad(effectiveCurrentItem),
  )
  const currentRetryNonce = retryNonceMap[index] || 0
  const imageContextRef = useRef(imageContext)
  imageContextRef.current = imageContext
  const onMediaCachedRef = useRef(onMediaCached)
  onMediaCachedRef.current = onMediaCached

  useEffect(() => {
    if (!state || !currentNeedsE2ee || !effectiveCurrentItem || resolvedMap[index] || errorMap[index]) return
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    let cancelled = false
    loadE2eeImageUrl(effectiveCurrentItem, imageContextRef.current, {
      forceRefresh: currentRetryNonce > 0,
      signal: controller?.signal || null,
    })
      .then((blobUrl) => {
        if (cancelled) return
        if (blobUrl) {
          setResolvedMap((prev) => ({ ...prev, [index]: blobUrl }))
          onMediaCachedRef.current?.()
        } else {
          setErrorMap((prev) => ({ ...prev, [index]: bi('无法加载图片', 'Failed to load image') }))
        }
      })
      .catch((err) => {
        if (!cancelled && err?.name !== 'AbortError') {
          setErrorMap((prev) => ({
            ...prev,
            [index]: String(err?.message || err || bi('端到端解密图片失败', 'Failed to decrypt image')),
          }))
        }
      })
    return () => {
      cancelled = true
      try { controller?.abort() } catch {}
    }
  }, [
    state,
    currentNeedsE2ee,
    effectiveCurrentItem,
    imageContext?.client,
    imageContext?.roomId,
    imageContext?.bridgeId,
    imageContext?.cwd,
    imageContext?.e2eeKeyId,
    index,
    resolvedMap,
    errorMap,
    currentRetryNonce,
    bi,
  ])

  // Keyboard shortcuts: Arrows, +/-, 0 (fit), 1 (1:1), R (rotate); Escape & Android Back handled by unified back layer
  useEffect(() => {
    if (!state) return
    const onKey = (e) => {
      if (e.key === 'ArrowLeft' && total > 1) {
        e.preventDefault()
        stepImage(-1)
      } else if (e.key === 'ArrowRight' && total > 1) {
        e.preventDefault()
        stepImage(1)
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomAroundCenter(transformRef.current.scale * ZOOM_BUTTON_STEP, { animate: true })
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        zoomAroundCenter(transformRef.current.scale / ZOOM_BUTTON_STEP, { animate: true })
      } else if (e.key === '0') {
        e.preventDefault()
        resetView({ animate: true, keepRotation: false })
      } else if (e.key === '1') {
        e.preventDefault()
        toggleActualPixels()
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        rotateBy(90)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, total, stepImage, zoomAroundCenter, resetView, toggleActualPixels, rotateBy])

  const isOpen = Boolean(state && Array.isArray(state.images) && state.images.length > 0 && current)
  const pinnedBlobUrl = resolvedMap[index] || currentInitialSrc || ''
  useEffect(() => {
    if (!isOpen || !pinnedBlobUrl || !pinnedBlobUrl.startsWith('blob:')) return undefined
    acquireBlobUrl(pinnedBlobUrl)
    return () => releaseBlobUrl(pinnedBlobUrl)
  }, [isOpen, pinnedBlobUrl])

  // Non-passive wheel listener for smooth cursor-anchored mouse wheel & trackpad pinch zoom
  useEffect(() => {
    if (!isOpen) return
    const stage = stageRef.current
    if (!stage) return

    const onWheel = (e) => {
      if (!imgRef.current) return
      e.preventDefault()
      // Normalize delta across pixel / line / page modes
      let delta = e.deltaY
      if (e.deltaMode === 1) delta *= 16
      else if (e.deltaMode === 2) delta *= 400
      // Trackpad pinch sets ctrlKey=true with smaller deltaY values
      const sensitivity = e.ctrlKey ? 0.01 : 0.0022
      const factor = Math.exp(-clamp(delta, -240, 240) * sensitivity)
      const nextScale = transformRef.current.scale * factor
      zoomAtPoint(nextScale, e.clientX, e.clientY, { animate: false })
    }

    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [isOpen, zoomAtPoint])

  // Pointer handlers: multi-touch pinch + pan, mouse drag-to-pan, double-tap/double-click zoom
  const handlePointerDown = (e) => {
    // Ignore non-primary mouse buttons (e.g. right-click context menu)
    if (e.pointerType === 'mouse' && e.button !== 0) return

    const stage = stageRef.current
    const clickedBackdrop = e.target === stage
    const hasImg = Boolean(imgRef.current)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, target: e.target })
    const g = gestureRef.current

    if (pointersRef.current.size === 2) {
      if (!hasImg) return
      const [p1, p2] = [...pointersRef.current.values()]
      g.mode = 'pinch'
      g.moved = true
      g.downOnBackdrop = false
      g.pinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1
      g.pinchMidX = (p1.x + p2.x) / 2
      g.pinchMidY = (p1.y + p2.y) / 2
      g.lastTapAt = 0
      setIsDragging(true)
      try {
        stage?.setPointerCapture?.(e.pointerId)
      } catch {}
      return
    }

    if (pointersRef.current.size === 1) {
      g.startX = e.clientX
      g.startY = e.clientY
      g.lastX = e.clientX
      g.lastY = e.clientY
      g.moved = false
      g.downOnBackdrop = clickedBackdrop

      if (hasImg && canPanNow() && !clickedBackdrop) {
        g.mode = 'pan'
        setIsDragging(true)
        try {
          stage?.setPointerCapture?.(e.pointerId)
        } catch {}
      } else if (total > 1 && e.pointerType !== 'mouse') {
        g.mode = 'swipe'
        try {
          stage?.setPointerCapture?.(e.pointerId)
        } catch {}
      } else {
        g.mode = 'idle'
      }
    }
  }

  const handlePointerMove = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return
    const prevPtr = pointersRef.current.get(e.pointerId)
    pointersRef.current.set(e.pointerId, { ...prevPtr, x: e.clientX, y: e.clientY })
    const g = gestureRef.current

    if (pointersRef.current.size === 2) {
      if (g.mode !== 'pinch' || !imgRef.current) return
      const [p1, p2] = [...pointersRef.current.values()]
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1
      const midX = (p1.x + p2.x) / 2
      const midY = (p1.y + p2.y) / 2

      const panDx = midX - g.pinchMidX
      const panDy = midY - g.pinchMidY
      const cur = transformRef.current
      transformRef.current = { ...cur, x: cur.x + panDx, y: cur.y + panDy }

      const ratio = dist / (g.pinchDist || dist)
      zoomAtPoint(transformRef.current.scale * ratio, midX, midY, { animate: false })

      g.pinchDist = dist
      g.pinchMidX = midX
      g.pinchMidY = midY
      g.moved = true
      return
    }

    if (pointersRef.current.size === 1) {
      const dx = e.clientX - g.lastX
      const dy = e.clientY - g.lastY
      const totalDist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY)
      if (totalDist > 5) g.moved = true

      if (g.mode === 'pan' && imgRef.current) {
        const cur = transformRef.current
        applyTransform({ scale: cur.scale, x: cur.x + dx, y: cur.y + dy, rotate: cur.rotate }, { animate: false })
      }
      g.lastX = e.clientX
      g.lastY = e.clientY
    }
  }

  const handlePointerUpOrCancel = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return
    const downInfo = pointersRef.current.get(e.pointerId)
    pointersRef.current.delete(e.pointerId)

    const stage = stageRef.current
    try {
      stage?.releasePointerCapture?.(e.pointerId)
    } catch {}

    const g = gestureRef.current

    // If one finger lifts during a 2-finger pinch, transition smoothly to 1-finger pan without jump
    if (pointersRef.current.size === 1) {
      const [remaining] = [...pointersRef.current.values()]
      g.lastX = remaining.x
      g.lastY = remaining.y
      g.startX = remaining.x
      g.startY = remaining.y
      g.mode = imgRef.current && canPanNow() ? 'pan' : 'idle'
      setIsDragging(g.mode === 'pan')
      return
    }

    const wasMoved = g.moved
    const prevMode = g.mode
    g.mode = 'idle'
    setIsDragging(false)

    if (wasMoved) {
      g.suppressBackdropClickUntil = Date.now() + 250
      // Horizontal touch swipe at 1x switches previous/next image
      if (prevMode === 'swipe' && total > 1 && transformRef.current.scale <= 1 + EPS) {
        const swipeDx = e.clientX - g.startX
        const swipeDy = e.clientY - g.startY
        if (Math.abs(swipeDx) > 60 && Math.abs(swipeDx) > Math.abs(swipeDy) * 1.3) {
          stepImage(swipeDx < 0 ? 1 : -1)
        }
      }
      return
    }

    // Touch double-tap on image smoothly toggles Fit <-> 2.5x anchored at tapped point
    if (e.pointerType !== 'mouse' && imgRef.current && downInfo?.target === imgRef.current) {
      const now = Date.now()
      const dt = now - g.lastTapAt
      const dist = Math.hypot(e.clientX - g.lastTapX, e.clientY - g.lastTapY)
      if (dt > 0 && dt < 280 && dist < 32) {
        g.lastTapAt = 0
        if (transformRef.current.scale > 1 + EPS) {
          resetView({ animate: true, keepRotation: true })
        } else {
          zoomAtPoint(DOUBLE_TAP_SCALE, e.clientX, e.clientY, { animate: true })
        }
      } else {
        g.lastTapAt = now
        g.lastTapX = e.clientX
        g.lastTapY = e.clientY
      }
    }
  }

  const handleImageDoubleClick = (e) => {
    e.stopPropagation()
    if (transformRef.current.scale > 1 + EPS) {
      resetView({ animate: true, keepRotation: true })
    } else {
      zoomAtPoint(DOUBLE_TAP_SCALE, e.clientX, e.clientY, { animate: true })
    }
  }

  const handleStageClick = (e) => {
    const g = gestureRef.current
    if (Date.now() < g.suppressBackdropClickUntil) return
    if (g.downOnBackdrop && e.target === stageRef.current) {
      onClose()
    }
  }

  if (!state || !Array.isArray(state.images) || state.images.length === 0 || !current) return null

  const rawActiveSrc = resolvedMap[index] || currentInitialSrc || ''
  const isBlockedExternal = Boolean(
    rawActiveSrc &&
      isExternalHttpImageUrl(rawActiveSrc) &&
      isPrivateOrLoopbackUrl(rawActiveSrc),
  )
  const safeRawActiveSrc = isBlockedExternal ? '' : rawActiveSrc
  const activeSrc =
    currentRetryNonce > 0 && safeRawActiveSrc && !safeRawActiveSrc.startsWith('data:') && !safeRawActiveSrc.startsWith('blob:')
      ? `${safeRawActiveSrc}${safeRawActiveSrc.includes('?') ? '&' : '?'}_r=${currentRetryNonce}`
      : safeRawActiveSrc
  const currentError = isBlockedExternal
    ? bi('已拦截不安全/内网图片地址', 'Blocked unsafe / private image URL')
    : (errorMap[index] || '')
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
    setRetryNonceMap((prev) => ({ ...prev, [index]: (prev[index] || 0) + 1 }))
  }

  const canShowOneToOne =
    naturalSize.width > 0 &&
    imgRef.current &&
    imgRef.current.offsetWidth > 0 &&
    naturalSize.width / imgRef.current.offsetWidth > 1.15

  const isModified = displayScalePct !== 100 || rotation !== 0
  const handleNativeAndroidImageSave = async (e) => {
    if (!isBlobOrDataDownload || !downloadHref) return
    const isAndroidCap = Boolean(
      typeof window !== 'undefined' &&
      window.Capacitor?.isNativePlatform?.() &&
      String(window.Capacitor?.getPlatform?.() || '').toLowerCase() === 'android' &&
      typeof window.Capacitor?.Plugins?.AllinOneFiles?.saveAndShare === 'function',
    )
    const maybeSvg =
      /\.svg(?:$|[?#])/i.test(String(current.label || current.rawPath || '').trim()) ||
      /svg/i.test(String(current.item?.mimeType || '')) ||
      /^data:image\/svg\+xml/i.test(downloadHref)
    if (!isAndroidCap && !maybeSvg && !downloadHref.startsWith('blob:')) return
    e.preventDefault()
    try {
      const res = await fetch(downloadHref)
      const rawBlob = await res.blob()
      const isSvgBlob = maybeSvg || String(rawBlob.type || '').toLowerCase().includes('svg')
      const safeMime = isSvgBlob ? 'application/octet-stream' : (rawBlob.type || 'image/png')
      const safeBlob = isSvgBlob ? new Blob([rawBlob], { type: 'application/octet-stream' }) : rawBlob
      if (isAndroidCap) {
        await saveOrShareBlobNatively(safeBlob, {
          filename: current.label || 'image.png',
          mimeType: safeMime,
          mode: 'save',
        })
        return
      }
      const safeUrl = isSvgBlob ? URL.createObjectURL(safeBlob) : downloadHref
      const a = document.createElement('a')
      a.href = safeUrl
      a.download = current.label || 'image.png'
      a.rel = 'noopener noreferrer'
      a.style.display = 'none'
      document.body.appendChild(a)
      try {
        a.click()
      } finally {
        setTimeout(() => {
          try { a.remove() } catch {}
          if (isSvgBlob) {
            try { URL.revokeObjectURL(safeUrl) } catch {}
          }
        }, 1000)
      }
    } catch {}
  }

  return (
    <div
      className="animate-fullscreen-in fixed inset-0 z-[96] flex flex-col bg-[#080A0F]/96 text-white backdrop-blur-md select-none"
      style={{ overscrollBehavior: 'contain' }}
    >
      {/* Top Bar */}
      <div
        className="pt-safe z-20 flex items-center justify-between gap-2 border-b border-white/10 bg-[#080A0F]/75 px-4 pb-3 backdrop-blur-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {current.label || bi('查看图片', 'Image Preview')}
            </span>
            {total > 1 && (
              <span className="shrink-0 rounded-md bg-white/10 px-1.5 py-0.5 text-[11px] font-medium text-white/75">
                {index + 1} / {total}
              </span>
            )}
            {naturalSize.width > 0 && naturalSize.height > 0 && (
              <span className="hidden shrink-0 font-mono text-[11px] text-white/45 sm:inline">
                {naturalSize.width} × {naturalSize.height}
              </span>
            )}
          </div>
          {current.rawPath && (
            <div className="truncate font-mono text-[10.5px] text-white/45">{current.rawPath}</div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {downloadHref && (
            <a
              href={downloadHref}
              download={current.label || 'image.png'}
              onClick={handleNativeAndroidImageSave}
              {...(isBlobOrDataDownload ? {} : { target: '_blank', rel: 'noreferrer' })}
              title={bi('保存原图', 'Save image')}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 transition hover:bg-white/20 active:scale-95"
            >
              <Download className="h-4 w-4" />
            </a>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label={bi('关闭预览', 'Close preview')}
            title={bi('关闭 (Esc)', 'Close (Esc)')}
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 transition hover:bg-white/20 active:scale-95"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Interactive Free-Zoom & Drag-Pan Stage */}
      <div
        ref={stageRef}
        onClick={handleStageClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUpOrCancel}
        onPointerCancel={handlePointerUpOrCancel}
        style={{ touchAction: 'none' }}
        className={`relative flex flex-1 items-center justify-center overflow-hidden p-4 ${
          isDragging ? 'cursor-grabbing' : isZoomed ? 'cursor-grab' : 'cursor-default'
        }`}
      >
        {activeSrc ? (
          <div
            ref={canvasRef}
            className="flex max-h-full max-w-full items-center justify-center will-change-transform"
            style={{ transformOrigin: 'center center' }}
          >
            <img
              ref={imgRef}
              src={activeSrc}
              alt={current.label || 'preview'}
              referrerPolicy="no-referrer"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={handleImageDoubleClick}
              onLoad={(e) => {
                const img = e.currentTarget
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight })
                }
                applyTransform(transformRef.current, { animate: false })
              }}
              onError={() => {
                if (!failedSrcMap[index] && current.src && current.item && imageContext) {
                  const withoutPreview =
                    typeof current.item === 'object' ? { ...current.item, localPreviewUrl: '' } : current.item
                  if (needsE2eeMediaLoad(withoutPreview)) {
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
              className="max-h-[calc(100vh-148px)] max-w-[calc(100vw-32px)] rounded-lg object-contain shadow-2xl select-none"
            />
          </div>
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
          <div className="pointer-events-none m-auto flex flex-col items-center gap-2 text-xs text-white/70">
            <Loader2 className="h-6 w-6 animate-spin text-[#4D6BFE]" />
            <span>{bi('正在端到端解密图片...', 'Decrypting image end-to-end...')}</span>
          </div>
        )}

        {total > 1 && (
          <>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                stepImage(-1)
              }}
              aria-label={bi('上一张', 'Previous image')}
              className="fixed top-1/2 left-3 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-sm transition hover:bg-black/75 active:scale-95"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                stepImage(1)
              }}
              aria-label={bi('下一张', 'Next image')}
              className="fixed top-1/2 right-3 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-sm transition hover:bg-black/75 active:scale-95"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      {/* Bottom Floating Control Pill & Subtle Hint */}
      <div
        className="pb-safe z-20 flex flex-col items-center gap-1.5 px-4 pb-3 pt-1"
        onClick={(e) => e.stopPropagation()}
      >
        {activeSrc && (
          <div className="inline-flex items-center gap-1 rounded-2xl border border-white/12 bg-[#141720]/90 px-2 py-1.5 shadow-xl backdrop-blur-md">
            <button
              type="button"
              onClick={() => zoomAroundCenter(transformRef.current.scale / ZOOM_BUTTON_STEP, { animate: true })}
              disabled={displayScalePct <= Math.round(MIN_SCALE * 100)}
              title={bi('缩小 (-)', 'Zoom out (-)')}
              aria-label={bi('缩小', 'Zoom out')}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-white/85 transition hover:bg-white/12 disabled:opacity-35 active:scale-95"
            >
              <Minus className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => resetView({ animate: true, keepRotation: false })}
              title={bi('点击重置为适应屏幕 (0)', 'Reset to fit screen (0)')}
              className="min-w-[54px] rounded-xl px-2 py-1 text-center font-mono text-xs font-semibold tabular-nums text-white/90 transition hover:bg-white/12 active:scale-95"
            >
              {displayScalePct}%
            </button>

            <button
              type="button"
              onClick={() => zoomAroundCenter(transformRef.current.scale * ZOOM_BUTTON_STEP, { animate: true })}
              disabled={displayScalePct >= Math.round(MAX_SCALE * 100)}
              title={bi('放大 (+)', 'Zoom in (+)')}
              aria-label={bi('放大', 'Zoom in')}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-white/85 transition hover:bg-white/12 disabled:opacity-35 active:scale-95"
            >
              <Plus className="h-4 w-4" />
            </button>

            <div className="mx-1 h-4 w-px bg-white/15" />

            {canShowOneToOne && (
              <button
                type="button"
                onClick={toggleActualPixels}
                title={bi('原始像素 1:1 (1)', 'Actual size 1:1 (1)')}
                className="flex h-8 items-center justify-center rounded-xl px-2 font-mono text-[11px] font-semibold text-white/85 transition hover:bg-white/12 active:scale-95"
              >
                1:1
              </button>
            )}

            <button
              type="button"
              onClick={() => rotateBy(90)}
              title={bi('顺时针旋转 90° (R)', 'Rotate 90° (R)')}
              aria-label={bi('旋转', 'Rotate')}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-white/85 transition hover:bg-white/12 active:scale-95"
            >
              <RotateCw className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => resetView({ animate: true, keepRotation: false })}
              disabled={!isModified}
              title={bi('适应屏幕 (0)', 'Fit to screen (0)')}
              aria-label={bi('适应屏幕', 'Fit to screen')}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-white/85 transition hover:bg-white/12 disabled:opacity-35 active:scale-95"
            >
              {isModified ? <RotateCcw className="h-4 w-4" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}

        <div className="hidden text-[11px] text-white/40 sm:block">
          {bi('滚轮 / 触控板双指自由缩放 · 拖动平移 · 双击快速放大/还原 · Esc 关闭', 'Scroll or pinch to zoom freely · Drag to pan · Double-click to toggle · Esc to close')}
        </div>
        <div className="text-[11px] text-white/40 sm:hidden">
          {bi('双指自由缩放 · 单指拖动 · 双击还原', 'Pinch to zoom · Drag to pan · Double-tap to reset')}
        </div>
      </div>
    </div>
  )
}
