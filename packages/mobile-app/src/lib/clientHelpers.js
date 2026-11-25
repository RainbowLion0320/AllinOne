export const REPO_URL = 'https://github.com/RainbowLion0320/AllinOne'

const DEFAULT_RELEASES_URL = 'https://github.com/RainbowLion0320/AllinOne/releases/latest'
export const RELEASES_URL =
  String(import.meta.env?.VITE_RELEASES_URL || '').trim() || DEFAULT_RELEASES_URL

const CONFIGURED_APK_URL = String(import.meta.env?.VITE_APK_URL || '').trim()

export function resolveApkUrl(base) {
  if (!CONFIGURED_APK_URL) return ''
  if (/^https?:\/\//i.test(CONFIGURED_APK_URL)) return CONFIGURED_APK_URL
  const cleanBase = String(base || '').replace(/\/+$/, '')
  return `${cleanBase}/${CONFIGURED_APK_URL.replace(/^\/+/, '')}`
}

export async function copyTextToClipboard(text) {
  const str = String(text ?? '')
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(str)
      return true
    }
  } catch {}
  try {
    if (typeof document === 'undefined') return false
    const ta = document.createElement('textarea')
    ta.value = str
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '-9999px'
    ta.style.fontSize = '16px' // prevents iOS Safari auto-zoom
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/i.test(navigator.userAgent || '')
    if (isIOS) {
      const range = document.createRange()
      range.selectNodeContents(ta)
      const sel = window.getSelection?.()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
      ta.setSelectionRange(0, str.length)
    } else {
      ta.focus({ preventScroll: true })
      ta.select()
      ta.setSelectionRange(0, str.length)
    }
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return Boolean(ok)
  } catch {
    return false
  }
}
