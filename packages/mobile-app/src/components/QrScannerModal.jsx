import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  Flashlight,
  FlashlightOff,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  ScanLine,
  X,
} from 'lucide-react'
import { useI18n } from '../lib/i18n.jsx'
import { bi as biLang, getCurrentLang } from '../lib/i18n.js'

let jsQrPromise = null
function loadJsQr() {
  if (!jsQrPromise) {
    jsQrPromise = import('jsqr').then((m) => m.default || m)
  }
  return jsQrPromise
}

function createNativeQrDetector() {
  if (typeof window === 'undefined' || typeof window.BarcodeDetector !== 'function') {
    return null
  }
  try {
    return new window.BarcodeDetector({ formats: ['qr_code'] })
  } catch {
    return null
  }
}

function drawAndDecodeJsQr(jsQR, source, srcX, srcY, srcW, srcH, maxDim, canvas, ctx) {
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH))
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))
  canvas.width = w
  canvas.height = h
  ctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, w, h)
  const imgData = ctx.getImageData(0, 0, w, h)
  const code = jsQR(imgData.data, w, h, { inversionAttempts: 'attemptBoth' })
  return code?.data ? String(code.data).trim() : ''
}

async function decodeQrFromImageFile(file) {
  const objUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(biLang(getCurrentLang(), '无法读取该图片', 'Unable to read image')))
      el.src = objUrl
    })

    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (!w || !h) throw new Error(biLang(getCurrentLang(), '图片尺寸无效', 'Invalid image dimensions'))

    // 1. Try native hardware BarcodeDetector first if supported
    const detector = createNativeQrDetector()
    if (detector) {
      try {
        const hits = await detector.detect(img)
        const val = hits?.find((x) => x?.rawValue)?.rawValue
        if (val) return String(val).trim()
      } catch {}
    }

    // 2. Multi-scale + center-crop jsQR attempts (handles high-res phone photos of PC monitors!)
    const jsQR = await loadJsQr()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error(biLang(getCurrentLang(), '浏览器不支持画布解码', 'Canvas decoding is not supported'))

    const attempts = [
      { x: 0, y: 0, w, h, maxDim: 1200 },
      { x: 0, y: 0, w, h, maxDim: 800 },
      { x: Math.round(w * 0.15), y: Math.round(h * 0.15), w: Math.round(w * 0.7), h: Math.round(h * 0.7), maxDim: 1000 },
      { x: 0, y: 0, w, h, maxDim: 1800 },
      { x: Math.round(w * 0.25), y: Math.round(h * 0.25), w: Math.round(w * 0.5), h: Math.round(h * 0.5), maxDim: 900 },
    ]
    for (const a of attempts) {
      const found = drawAndDecodeJsQr(jsQR, img, a.x, a.y, a.w, a.h, a.maxDim, canvas, ctx)
      if (found) return found
    }

    return ''
  } finally {
    URL.revokeObjectURL(objUrl)
  }
}

export function QrScannerModal({ open, onClose, onDetected }) {
  const { bi } = useI18n()
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const busyRef = useRef(false)
  const detectedRef = useRef(false)
  const captureInputRef = useRef(null)
  const albumInputRef = useRef(null)

  const [camState, setCamState] = useState('starting') // 'starting' | 'active' | 'error'
  const [camError, setCamError] = useState('')
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [decodingImage, setDecodingImage] = useState(false)
  const [imageError, setImageError] = useState('')
  const [retrySeq, setRetrySeq] = useState(0)

  const stopCamera = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try { track.stop() } catch {}
      }
      streamRef.current = null
    }
    if (videoRef.current) {
      try { videoRef.current.srcObject = null } catch {}
    }
    setTorchSupported(false)
    setTorchOn(false)
  }, [])

  const emitDetected = useCallback((rawValue) => {
    const clean = String(rawValue || '').trim()
    if (!clean || detectedRef.current) return
    detectedRef.current = true
    try { navigator.vibrate?.(60) } catch {}
    stopCamera()
    onDetected?.(clean)
  }, [onDetected, stopCamera])

  useEffect(() => {
    if (!open) {
      stopCamera()
      detectedRef.current = false
      setImageError('')
      setDecodingImage(false)
      return
    }

    let cancelled = false
    detectedRef.current = false
    setCamState('starting')
    setCamError('')
    setImageError('')

    const start = async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setCamState('error')
        setCamError(bi(
          '当前环境不支持实时调用摄像头，请使用下方「拍照识别」或「相册选图」。',
          'Live camera is unavailable here. Use "Take Photo" or "Choose Photo" below.',
        ))
        return
      }

      let stream = null
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        } catch (err2) {
          if (cancelled) return
          const name = String(err2?.name || '')
          setCamState('error')
          if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
            setCamError(bi(
              '未获得实时摄像头权限（请检查应用摄像头权限，或直接点下方「拍照识别 / 相册选图」）。',
              'Camera permission denied. Allow camera access or use "Take Photo / Choose Photo" below.',
            ))
          } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
            setCamError(bi(
              '未检测到可用摄像头，请使用下方「相册选图」。',
              'No camera detected. Use "Choose Photo" below.',
            ))
          } else {
            setCamError(bi(
              `无法启动实时相机（${err2?.message || name || '未知错误'}），请改用下方「拍照识别」或「相册选图」。`,
              `Could not start live camera (${err2?.message || name || 'Unknown error'}). Use "Take Photo" or "Choose Photo" below.`,
            ))
          }
          return
        }
      }

      if (cancelled) {
        for (const t of stream.getTracks()) {
          try { t.stop() } catch {}
        }
        return
      }

      streamRef.current = stream
      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      try {
        await video.play()
      } catch {}

      if (cancelled) return
      setCamState('active')

      // Detect torch capability if supported on this phone camera
      const track = stream.getVideoTracks()[0]
      try {
        const caps = track?.getCapabilities?.()
        if (caps?.torch) setTorchSupported(true)
      } catch {}

      const detector = createNativeQrDetector()
      const jsQR = await loadJsQr().catch(() => null)
      if (cancelled) return
      if (!canvasRef.current) {
        canvasRef.current = document.createElement('canvas')
      }
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d', { willReadFrequently: true })

      timerRef.current = setInterval(async () => {
        if (cancelled || detectedRef.current || busyRef.current) return
        const v = videoRef.current
        if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return
        busyRef.current = true
        try {
          if (detector) {
            try {
              const hits = await detector.detect(v)
              const val = hits?.find((x) => x?.rawValue)?.rawValue
              if (val) {
                emitDetected(val)
                return
              }
            } catch {}
          }
          if (ctx && jsQR) {
            const val = drawAndDecodeJsQr(jsQR, v, 0, 0, v.videoWidth, v.videoHeight, 720, canvas, ctx)
            if (val) {
              emitDetected(val)
            }
          }
        } finally {
          busyRef.current = false
        }
      }, 150)
    }

    void start()

    return () => {
      cancelled = true
      stopCamera()
    }
  }, [open, retrySeq, emitDetected, stopCamera])

  const handleToggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks?.()[0]
    if (!track) return
    const next = !torchOn
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] })
      setTorchOn(next)
    } catch {}
  }

  const handleImagePicked = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setDecodingImage(true)
    setImageError('')
    try {
      const found = await decodeQrFromImageFile(file)
      if (found) {
        emitDetected(found)
      } else {
        setImageError(bi(
          '未在图片中识别到二维码，请对准电脑二维码清晰拍摄或放大截屏后重试。',
          'No QR code detected in the image. Take a clearer photo or zoomed screenshot and try again.',
        ))
      }
    } catch (err) {
      setImageError(String(err?.message || err || bi('识别图片二维码失败', 'Failed to decode QR code')))
    } finally {
      setDecodingImage(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-[#06080E] text-white">
      {/* Top Bar */}
      <div className="pt-safe relative z-20 flex items-center justify-between px-4 pb-3">
        <button
          type="button"
          onClick={() => {
            stopCamera()
            onClose?.()
          }}
          aria-label={bi('关闭扫码', 'Close scanner')}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/12 text-white backdrop-blur-md active:scale-95"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="text-center">
          <div className="text-sm font-semibold">{bi('扫一扫', 'Scan QR')}</div>
        </div>

        <div className="flex h-10 w-10 items-center justify-end">
          {torchSupported && camState === 'active' && (
            <button
              type="button"
              onClick={handleToggleTorch}
              aria-label={torchOn ? bi('关闭闪光灯', 'Turn off flashlight') : bi('开启闪光灯', 'Turn on flashlight')}
              className={`flex h-10 w-10 items-center justify-center rounded-full backdrop-blur-md active:scale-95 ${
                torchOn ? 'bg-amber-400 text-slate-900' : 'bg-white/12 text-white'
              }`}
            >
              {torchOn ? <FlashlightOff className="h-4.5 w-4.5" /> : <Flashlight className="h-4.5 w-4.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Camera / Viewfinder Body */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={`h-full w-full object-cover transition-opacity duration-300 ${
            camState === 'active' ? 'opacity-100' : 'opacity-0'
          }`}
        />

        {/* Viewfinder Overlay when active */}
        {camState === 'active' && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="relative h-64 w-64 rounded-3xl shadow-[0_0_0_9999px_rgba(6,8,14,0.58)]">
              {/* Four glowing corner brackets */}
              <span className="absolute top-0 left-0 h-8 w-8 rounded-tl-3xl border-t-4 border-l-4 border-[#4D6BFE]" />
              <span className="absolute top-0 right-0 h-8 w-8 rounded-tr-3xl border-t-4 border-r-4 border-[#4D6BFE]" />
              <span className="absolute bottom-0 left-0 h-8 w-8 rounded-bl-3xl border-b-4 border-l-4 border-[#4D6BFE]" />
              <span className="absolute right-0 bottom-0 h-8 w-8 rounded-br-3xl border-r-4 border-b-4 border-[#4D6BFE]" />
              {/* Subtle center pulse line */}
              <div className="absolute inset-x-4 top-1/2 h-0.5 -translate-y-1/2 animate-pulse rounded-full bg-gradient-to-r from-transparent via-[#4D6BFE] to-transparent shadow-[0_0_12px_#4D6BFE]" />
            </div>
            <p className="mt-6 rounded-full bg-black/45 px-4 py-1.5 text-xs text-white/85 backdrop-blur-sm">
              {bi('对准二维码自动识别', 'Align QR code inside frame')}
            </p>
          </div>
        )}

        {/* Loading state */}
        {camState === 'starting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-[#4D6BFE]" />
            <div className="text-sm font-medium text-white/90">{bi('正在启动摄像头...', 'Starting camera...')}</div>
          </div>
        )}

        {/* Camera unavailable / fallback state */}
        {camState === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-[#8CA3FF]">
              <ScanLine className="h-8 w-8" />
            </div>
            <div className="text-base font-semibold text-white">{bi('使用拍照或相册识别二维码', 'Scan via Camera Photo or Gallery')}</div>
            <p className="mt-2 max-w-xs text-xs leading-relaxed text-white/65">{camError}</p>
            <button
              type="button"
              onClick={() => setRetrySeq((n) => n + 1)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-white/12 px-3.5 py-2 text-xs font-medium text-white hover:bg-white/20 active:scale-95"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{bi('重试开启实时扫码', 'Retry Live Camera')}</span>
            </button>
          </div>
        )}

        {/* Decoding image overlay */}
        {decodingImage && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2.5 bg-black/75 backdrop-blur-sm">
            <Loader2 className="h-7 w-7 animate-spin text-[#4D6BFE]" />
            <span className="text-sm font-medium text-white">{bi('正在识别图片中的二维码...', 'Decoding QR code...')}</span>
          </div>
        )}
      </div>

      {/* Hidden inputs for system camera capture & gallery image pick */}
      <input
        ref={captureInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleImagePicked}
      />
      <input
        ref={albumInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImagePicked}
      />

      {/* Bottom Controls */}
      <div className="pb-safe relative z-20 bg-gradient-to-t from-black/95 via-black/80 to-transparent px-5 pt-4 pb-5">
        {imageError && (
          <div className="mb-3 rounded-xl bg-rose-500/20 px-3 py-2 text-center text-xs text-rose-200 ring-1 ring-rose-400/30">
            {imageError}
          </div>
        )}

        <div className="mx-auto grid max-w-sm grid-cols-2 gap-3">
          <button
            type="button"
            disabled={decodingImage}
            onClick={() => captureInputRef.current?.click()}
            className="flex items-center justify-center gap-2 rounded-2xl bg-[#4D6BFE] py-3 text-xs font-semibold text-white shadow-lg shadow-[#4D6BFE]/25 transition active:scale-[0.98] disabled:opacity-50"
          >
            <Camera className="h-4 w-4" />
            <span>{bi('拍照识别二维码', 'Take Photo')}</span>
          </button>

          <button
            type="button"
            disabled={decodingImage}
            onClick={() => albumInputRef.current?.click()}
            className="flex items-center justify-center gap-2 rounded-2xl bg-white/14 py-3 text-xs font-semibold text-white backdrop-blur-md transition hover:bg-white/20 active:scale-[0.98] disabled:opacity-50"
          >
            <ImageIcon className="h-4 w-4" />
            <span>{bi('从相册选图', 'Choose Photo')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
